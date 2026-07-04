/**
 * SLICE-SMOKE-2 (AC-1/AC-2/AC-3) — envelope ASSEMBLY unit tests.
 *
 * Target: runIngestTranscript() (src/cli/ingest-transcript.ts) — the function that
 * turns a captured JSONL transcript into the canonical v1.0 TranscriptIngestPayload
 * envelope. This is the real "capture-hook assembly" unit: hooks/scripts/*.sh shell
 * out to `astramem ingest-transcript`, which parses argv and calls this exact
 * function (see tests/hooks/fixture-replay.test.ts for the argv-replay path).
 *
 * Deliberately NOT re-testing:
 *   - TranscriptIngestPayloadSchema itself (tests/contracts/transcript-wire.test.ts
 *     already covers wire_version regex + field validation exhaustively).
 *   - scrub.ts pattern coverage (tests/lib/scrub.test.ts, scrub-patterns.test.ts,
 *     scrub-properties.test.ts already cover STRING_PATTERNS exhaustively).
 * This file only asserts that the assembly function WIRES scrub + schema correctly
 * into the envelope it produces — hermetic, zero network, mock provider only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runIngestTranscript } from '../../src/cli/ingest-transcript.ts';
import { createMockProvider } from './mock-provider.ts';
import { TranscriptIngestPayloadSchema, WIRE_VERSION } from '../../src/contracts/wire.ts';
import type { TranscriptIngestPayload } from '../../src/contracts/wire.ts';

// ---------------------------------------------------------------------------
// Isolation helpers (mirrors tests/cli/ingest-transcript.test.ts convention)
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalAppData: string | undefined;
let originalHome: string | undefined;

function isolateTmpDir(): void {
  tmpDir = mkdtempSync(join(tmpdir(), 'astramem-envelope-'));
  originalAppData = process.env['APPDATA'];
  originalHome = process.env['HOME'];
  process.env['APPDATA'] = tmpDir;
  if (process.platform !== 'win32') {
    process.env['HOME'] = tmpDir;
  }
}

function cleanupTmpDir(): void {
  if (originalAppData !== undefined) {
    process.env['APPDATA'] = originalAppData;
  } else {
    delete process.env['APPDATA'];
  }
  if (process.platform !== 'win32') {
    if (originalHome !== undefined) {
      process.env['HOME'] = originalHome;
    } else {
      delete process.env['HOME'];
    }
  }
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeTranscript(lines: object[]): string {
  const filePath = join(tmpDir, `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return filePath;
}

async function assemble(
  transcriptPath: string,
  extraArgs: string[] = [],
): Promise<TranscriptIngestPayload> {
  const provider = createMockProvider();
  const code = await runIngestTranscript(
    [
      '--event', 'pre_compact',
      '--transcript-path', transcriptPath,
      '--session-id', 'sess-envelope-assembly',
      '--project-id', 'proj-envelope-assembly',
      ...extraArgs,
    ],
    { _provider: provider },
  );
  expect(code).toBe(0);
  expect(provider._stubs.ingestTranscript).toHaveBeenCalledOnce();
  return provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
}

describe('envelope assembly (runIngestTranscript) — SLICE-SMOKE-2', () => {
  beforeEach(isolateTmpDir);
  afterEach(cleanupTmpDir);

  // -------------------------------------------------------------------------
  // AC-1: fixed captured-turns fixture -> assembled payload matches wire shape,
  // wire_version matches ^v(?:0|[1-9][0-9]*)\.[0-9]+$
  // -------------------------------------------------------------------------

  describe('AC-1: assembled payload matches wire shape', () => {
    it('produces a schema-valid TranscriptIngestPayload from a fixed transcript', async () => {
      const path = writeTranscript([
        { role: 'user', text: 'What vector store should we use for v1?' },
        { role: 'assistant', text: 'sqlite-vec — single-file, no separate service to run.' },
      ]);
      const envelope = await assemble(path);

      const parsed = TranscriptIngestPayloadSchema.safeParse(envelope);
      expect(parsed.success, parsed.success ? '' : JSON.stringify((parsed as { error: unknown }).error)).toBe(true);
    });

    it('wire_version equals WIRE_VERSION and matches the canonical regex', async () => {
      const path = writeTranscript([{ role: 'user', text: 'hello' }]);
      const envelope = await assemble(path);

      expect(envelope.wire_version).toBe(WIRE_VERSION);
      // Mirrors the pattern in src/contracts/wire.ts TranscriptIngestPayloadSchema —
      // ASCII digits only, no leading zeros (see wire.ts M-R7 comment).
      expect(envelope.wire_version).toMatch(/^v(?:0|[1-9][0-9]*)\.[0-9]+$/);
    });
  });

  // -------------------------------------------------------------------------
  // AC-2: secret-shaped content -> client_scrub_* fields reflect redactions AND
  // redacted strings absent from the final payload.
  //
  // Uses patterns that scrub.ts's STRING_PATTERNS actually catches (AWS-style
  // access key id, generic `password=` keyword/value). A fake email address is
  // included too, but scrub.ts has no email pattern (verified: no `email` match
  // anywhere in src/) — plain email addresses are NOT treated as secrets by
  // scrub.ts's threat model today. That is asserted explicitly below as
  // documented current behavior, not silently assumed.
  // -------------------------------------------------------------------------

  describe('AC-2: secret-shaped content is scrubbed out of the final payload', () => {
    const FAKE_AWS_KEY = 'AKIAABCDEFGHIJKLMNOP'; // AKIA + 16 chars — matches aws-key pattern
    const FAKE_PASSWORD_KV = 'password: SuperSecretValue123';
    const FAKE_EMAIL = 'jane.doe@example.com';

    it('redacts a fake AWS-style key and a generic secret-kv value; counts hits by label', async () => {
      const path = writeTranscript([
        { role: 'user', text: `Here is my key ${FAKE_AWS_KEY} and also ${FAKE_PASSWORD_KV} — please use it.` },
        { role: 'assistant', text: `Got it, redacting per policy.` },
      ]);
      const envelope = await assemble(path);

      const allText = envelope.turns.map((t) => t.text).join('\n');
      expect(allText).not.toContain(FAKE_AWS_KEY);
      expect(allText).not.toContain('SuperSecretValue123');

      expect(envelope.client_scrub_applied).toBe(true);
      expect(envelope.client_scrub_hits).toBeGreaterThanOrEqual(2);
      expect(envelope.client_scrub_hits_by_label?.['aws-key']).toBe(1);
      expect(envelope.client_scrub_hits_by_label?.['secret-kv']).toBe(1);
    });

    it('documented current behavior: a plain email address is NOT redacted (no email pattern in scrub.ts)', async () => {
      const path = writeTranscript([
        { role: 'user', text: `Reach out to ${FAKE_EMAIL} if this breaks.` },
      ]);
      const envelope = await assemble(path);

      expect(envelope.turns[0]!.text).toContain(FAKE_EMAIL);
      expect(envelope.client_scrub_hits).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC-3: multi-turn fixture -> turns[] preserves role/order/content.
  // -------------------------------------------------------------------------

  describe('AC-3: multi-turn role/order/content preservation', () => {
    it('preserves role, order, and content across 5 interleaved turns', async () => {
      const script = [
        { role: 'user', text: 'turn-0-user' },
        { role: 'assistant', text: 'turn-1-assistant' },
        { role: 'user', text: 'turn-2-user' },
        { role: 'assistant', text: 'turn-3-assistant' },
        { role: 'user', text: 'turn-4-user' },
      ];
      const path = writeTranscript(script);
      const envelope = await assemble(path, ['--max-turns', '20']);

      expect(envelope.turns).toHaveLength(5);
      envelope.turns.forEach((turn, i) => {
        expect(turn.role).toBe(script[i]!.role);
        expect(turn.text).toBe(script[i]!.text);
      });
    });
  });
});
