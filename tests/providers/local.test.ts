/**
 * Local provider tests.
 *
 * Runs the shared contract suite + local-specific tests:
 * - bearer is read from MEMORY_BEARER env var (Track B stub)
 * - missing bearer still makes requests (unauthenticated) without crashing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock datadir so readLocalBearer cannot fall into a real secrets.env on the
// host machine — keeps the "no bearer" test deterministic.
const _tmpConfigDir: string = mkdtempSync(join(tmpdir(), 'astramem-local-provider-test-'));
vi.mock('../../src/lib/datadir.ts', () => ({
  unifiedConfigDir: () => _tmpConfigDir,
  legacyConfigDir: () => join(_tmpConfigDir, 'legacy-xdg'),
  legacyAstramemPath: () => join(_tmpConfigDir, 'legacy-astramem'),
}));

import { LocalProvider } from '../../src/providers/local.ts';
import { runProviderContract, SAMPLE_INGEST, SAMPLE_RECALL } from './_contract.ts';
import { DeterministicError, TransientError } from '../../src/lib/errors.ts';
import { WIRE_VERSION } from '../../src/contracts/wire.ts';

// ---------------------------------------------------------------------------
// Contract suite — all shared contract checks run for LocalProvider
// ---------------------------------------------------------------------------

runProviderContract('LocalProvider', (baseUrl) => new LocalProvider(baseUrl));

// ---------------------------------------------------------------------------
// Local-specific tests
// ---------------------------------------------------------------------------

describe('LocalProvider — bearer from MEMORY_BEARER env', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedAuthHeader: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedAuthHeader = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedAuthHeader = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
      const url = typeof input === 'string' ? input : input.toString();
      const pathname = new URL(url).pathname;
      if (pathname === '/recall') {
        return new Response(
          JSON.stringify({ hits: [], total_searched: 0, provider: 'local' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env['MEMORY_BEARER'];
  });

  it('attaches Bearer header when MEMORY_BEARER is set', async () => {
    process.env['MEMORY_BEARER'] = 'test-local-bearer-token-abc123';
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.recall(SAMPLE_RECALL);
    expect(capturedAuthHeader).toBe('Bearer test-local-bearer-token-abc123');
  });

  it('makes request without Authorization header when MEMORY_BEARER is absent', async () => {
    delete process.env['MEMORY_BEARER'];
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.recall(SAMPLE_RECALL);
    // No Authorization header — not undefined check since absent key is also undefined.
    expect(capturedAuthHeader).toBeUndefined();
  });

  it('missing bearer does not throw — request proceeds unauthenticated', async () => {
    delete process.env['MEMORY_BEARER'];
    const provider = new LocalProvider('http://127.0.0.1:19999');
    // Should not throw — just makes an unauthenticated request.
    await expect(provider.recall(SAMPLE_RECALL)).resolves.toBeDefined();
  });
});

describe('LocalProvider — default URL resolution', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedUrl: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedUrl = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env['MEMORY_API_URL_LOCAL'];
  });

  it('defaults to http://127.0.0.1:7777 when no URL given and env absent', async () => {
    delete process.env['MEMORY_API_URL_LOCAL'];
    const provider = new LocalProvider();
    await provider.ingest(SAMPLE_INGEST);
    expect(capturedUrl).toContain('http://127.0.0.1:7777');
  });

  it('uses MEMORY_API_URL_LOCAL env var when set', async () => {
    process.env['MEMORY_API_URL_LOCAL'] = 'http://127.0.0.1:8888';
    const provider = new LocalProvider();
    await provider.ingest(SAMPLE_INGEST);
    expect(capturedUrl).toContain('http://127.0.0.1:8888');
  });
});

describe('LocalProvider — error classes and kind fields', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('recall 4xx carries kind=deterministic and status code', async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const provider = new LocalProvider('http://127.0.0.1:19999');
    const err = await provider.recall(SAMPLE_RECALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeterministicError);
    expect((err as DeterministicError).kind).toBe('deterministic');
    expect((err as DeterministicError).status).toBe(404);
  });

  it('recall 5xx carries kind=transient and status code', async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response('{"error":"gateway error"}', { status: 502, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const provider = new LocalProvider('http://127.0.0.1:19999');
    const err = await provider.recall(SAMPLE_RECALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).kind).toBe('transient');
    expect((err as TransientError).status).toBe(502);
  });

  it('health network error carries kind=transient', async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const provider = new LocalProvider('http://127.0.0.1:19999');
    const err = await provider.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).kind).toBe('transient');
  });
});

// ---------------------------------------------------------------------------
// Minimal TranscriptIngestPayload fixture for wire_version tests.
// Must satisfy TranscriptIngestPayloadSchema (all required fields present).
// ---------------------------------------------------------------------------

const SAMPLE_TRANSCRIPT_PAYLOAD = {
  wire_version: WIRE_VERSION,
  event: 'session_end' as const,
  session_id: 'local-test-sess-1',
  project_id: 'local-test-proj-1',
  captured_at: '2026-06-30T00:00:00Z',
  turns: [{ role: 'user' as const, text: 'hello from local provider test' }],
  client_scrub_applied: true,
  client_scrub_hits: 0,
  client_version: '0.5.0',
  client_scrub_version: '2',
};

describe('LocalProvider — ingestTranscript sends wire_version', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedBody: unknown;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedBody = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.body) {
        try {
          capturedBody = JSON.parse(init.body as string);
        } catch {
          capturedBody = init.body;
        }
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    capturedBody = undefined;
  });

  it('ingestTranscript POSTs body that includes wire_version: "v1.0"', async () => {
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD);
    expect(capturedBody).toBeDefined();
    expect((capturedBody as Record<string, unknown>)['wire_version']).toBe(WIRE_VERSION);
  });

  it('ingestTranscript wire_version matches the exported WIRE_VERSION constant', async () => {
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD);
    expect((capturedBody as Record<string, unknown>)['wire_version']).toBe('v1.0');
  });
});

// ---------------------------------------------------------------------------
// P-B3: defense-in-depth scrub inside ingestTranscript().
// ---------------------------------------------------------------------------

describe('LocalProvider — provider-layer scrub (P-B3)', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedBody = undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.body) {
        try { capturedBody = JSON.parse(init.body as string) as Record<string, unknown>; }
        catch { /* ignore */ }
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    capturedBody = undefined;
  });

  it('(a) raw bearer in turn text is redacted by provider when payload has not been scrubbed', async () => {
    // Simulate a programmatic caller that sets client_scrub_applied=false + raw secret in text.
    const rawBearer = 'Bearer ' + 'a'.repeat(32) + 'b'.repeat(32);
    const payload = {
      ...SAMPLE_TRANSCRIPT_PAYLOAD,
      client_scrub_applied: false,
      client_scrub_hits: 0,
      client_scrub_hits_by_label: {},
      turns: [{ role: 'user' as const, text: rawBearer }],
    };
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingestTranscript(payload);

    expect(capturedBody).toBeDefined();
    const postedBody = capturedBody as { turns?: { text: string }[]; client_scrub_hits?: number };
    expect(postedBody.turns?.[0]?.text).not.toContain('a'.repeat(32) + 'b'.repeat(32));
    expect(postedBody.turns?.[0]?.text).toBe('[REDACTED:bearer]');
    expect(postedBody.client_scrub_hits).toBeGreaterThan(0);
  });

  it('(b) already-scrubbed payload passes through unchanged — scrubWithLabels is idempotent', async () => {
    // Text already contains the redaction marker — second pass is a no-op.
    const payload = {
      ...SAMPLE_TRANSCRIPT_PAYLOAD,
      turns: [{ role: 'user' as const, text: '[REDACTED:bearer]' }],
      client_scrub_applied: true,
      client_scrub_hits: 1,
      client_scrub_hits_by_label: { bearer: 1 },
    };
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingestTranscript(payload);

    expect(capturedBody).toBeDefined();
    const postedBody = capturedBody as { turns?: { text: string }[] };
    expect(postedBody.turns?.[0]?.text).toBe('[REDACTED:bearer]');
  });
});

describe('LocalProvider — bearer not logged on error paths', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedMessages: string[] = [];
  let origConsoleError: typeof console.error;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedMessages = [];
    origConsoleError = console.error;
    // Intercept console.error to verify bearer is not leaked.
    console.error = (...args: unknown[]) => {
      capturedMessages.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.error = origConsoleError;
    delete process.env['MEMORY_BEARER'];
  });

  it('does not log bearer token in error message on 401', async () => {
    const sensitiveBearer = 'super-secret-local-bearer-xyz987';
    process.env['MEMORY_BEARER'] = sensitiveBearer;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response('{"error":"unauthorized"}', { status: 401, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const provider = new LocalProvider('http://127.0.0.1:19999');
    const err = await provider.recall(SAMPLE_RECALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeterministicError);
    // The error message must NOT contain the bearer.
    const errMsg = (err as Error).message;
    expect(errMsg).not.toContain(sensitiveBearer);
    // Console output must NOT contain the bearer.
    const allOutput = capturedMessages.join('\n');
    expect(allOutput).not.toContain(sensitiveBearer);
  });
});
