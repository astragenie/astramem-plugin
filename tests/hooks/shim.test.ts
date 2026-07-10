/**
 * Hook shim integration tests — FEAT 4a Slice 4.
 *
 * For each of the three rewritten hook scripts:
 *   1. Pipe a fixture hook-stdin.json payload as stdin via child_process.spawn.
 *   2. Set CLAUDE_PLUGIN_ROOT to repo root; MEMORY_API_URL_LOCAL to non-routable
 *      address so CLI provider call fails fast (but exit code must still be 0).
 *   3. Assert exit code 0 (fire-and-forget contract).
 *   4. Assert no raw bearer/AWS key leaks to stdout or stderr.
 *
 * Skipped on Win32 when bash is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, delimiter } from 'node:path';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Platform guard — skip if bash not available on Win32
// ---------------------------------------------------------------------------

function bashAvailable(): boolean {
  const r = spawnSync('bash', ['--version'], { encoding: 'utf-8', timeout: 3000 });
  return r.status === 0;
}

const skipOnWin32 = process.platform === 'win32' && !bashAvailable();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures');
const HOOKS_DIR = join(REPO_ROOT, 'hooks', 'scripts');

// Use a non-routable local address so the provider call fails fast (< 1s).
// The CLI is fire-and-forget so exit code must still be 0.
const DEAD_API_URL = 'http://127.0.0.1:1';

// Patterns that must NOT appear in hook output
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9_\-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{20,}/,
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface ShimResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runShim(
  scriptName: string,
  stdinPayload: string,
  extraEnv: Record<string, string> = {},
): ShimResult {
  const scriptPath = join(HOOKS_DIR, scriptName);
  const result = spawnSync('bash', [scriptPath], {
    input: stdinPayload,
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      MEMORY_API_URL_LOCAL: DEAD_API_URL,
      MEMORY_SUBAGENT_MAX_TURNS: '5',
      MEMORY_PRECOMPACT_MAX_TURNS: '5',
      MEMORY_SESSIONEND_MAX_TURNS: '5',
      ...extraEnv,
    },
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Async variant of runShim, backed by spawn() rather than spawnSync().
 *
 * Required whenever the hook needs to reach a fake daemon running in this
 * SAME test process (startFakeDaemon() below): spawnSync blocks the Node
 * event loop for the whole child lifetime, so an in-process http.Server can
 * never actually accept the connection — the child just times out waiting
 * for a response nobody sends. spawn() doesn't block, so the event loop
 * stays free to service the fake daemon's requests while the child runs.
 */
function runShimAsync(
  scriptName: string,
  stdinPayload: string,
  extraEnv: Record<string, string> = {},
): Promise<ShimResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(HOOKS_DIR, scriptName);
    const child = spawn('bash', [scriptPath], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: REPO_ROOT,
        MEMORY_API_URL_LOCAL: DEAD_API_URL,
        MEMORY_SUBAGENT_MAX_TURNS: '5',
        MEMORY_PRECOMPACT_MAX_TURNS: '5',
        MEMORY_SESSIONEND_MAX_TURNS: '5',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
    child.stdin.end(stdinPayload);
  });
}

function assertNoSecretLeak(result: ShimResult): void {
  const combined = result.stdout + result.stderr;
  for (const pattern of SECRET_PATTERNS) {
    expect(combined).not.toMatch(pattern);
  }
}

function loadFixtureStdin(fixturePath: string): string {
  return readFileSync(join(fixturePath, 'hook-stdin.json'), 'utf-8');
}

// issue #394: build a throwaway bin dir with fake `astramem-local` + `bun` on PATH.
// - astramem-local writes a "capture" marker and exits with `captureExit` on `capture claude`.
// - bun writes a "bun" marker (proves the legacy ingest path ran) and exits 0.
// Lets us assert capture-success skips legacy (no double-ingest) and capture-failure
// falls through to legacy exactly once.
interface FakeBin {
  binDir: string;
  capturedMarker: string;
  legacyMarker: string;
  pathEnv: string;
  cleanup: () => void;
}
function makeFakeBin(captureExit: number): FakeBin {
  const root = mkdtempSync(join(tmpdir(), 'astramem-hook-fake-'));
  const binDir = join(root, 'bin');
  const markerDir = join(root, 'markers');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(markerDir, { recursive: true });
  const capturedMarker = join(markerDir, 'capture');
  const legacyMarker = join(markerDir, 'bun');
  writeFileSync(
    join(binDir, 'astramem-local'),
    `#!/usr/bin/env bash\nif [ "$1" = "capture" ]; then printf '%s\\n' "$*" > "${capturedMarker.replace(/\\/g, '/')}"; exit ${captureExit}; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, 'bun'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${legacyMarker.replace(/\\/g, '/')}"\nexit 0\n`,
    { mode: 0o755 },
  );
  return {
    binDir,
    capturedMarker,
    legacyMarker,
    pathEnv: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function subagentPayload(): string {
  const fixturePath = join(FIXTURE_ROOT, 'subagent_stop', '01-basic');
  const transcriptPath = join(fixturePath, 'transcript.jsonl').replace(/\\/g, '/');
  return loadFixtureStdin(fixturePath).replace(/__FIXTURE_TRANSCRIPT_PATH__/g, transcriptPath);
}

// ---------------------------------------------------------------------------
// Fake daemon — for session-start-recall.sh's agent-profile block tests.
// Routes: GET /health, POST /recall, GET /agents/:agent/profile.
// Local to this file (not tests/e2e/_helpers.ts — that helper has no /recall
// or /agents routes and is owned by a different slice of work).
// ---------------------------------------------------------------------------

interface FakeDaemonOpts {
  /** hits array returned verbatim as { hits } from POST /recall. */
  recallHits?: unknown[];
  /** agent -> profile JSON. Missing key → 404. */
  profiles?: Record<string, unknown>;
}

interface FakeDaemonHandle {
  url: string;
  requestLog: Array<{ method: string; url: string }>;
  close(): Promise<void>;
}

function startFakeDaemon(opts: FakeDaemonOpts): Promise<FakeDaemonHandle> {
  return new Promise((resolve, reject) => {
    const requestLog: Array<{ method: string; url: string }> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      requestLog.push({ method, url });

      if (method === 'GET' && url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: '0.0.0-fake' }));
        return;
      }
      if (method === 'POST' && url === '/recall') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hits: opts.recallHits ?? [] }));
        return;
      }
      const profileMatch = /^\/agents\/([^/]+)\/profile$/.exec(url);
      if (method === 'GET' && profileMatch) {
        const agent = decodeURIComponent(profileMatch[1]!);
        const profile = opts.profiles?.[agent];
        if (!profile) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found', agent }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(profile));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requestLog,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

const SAMPLE_AGENT_PROFILE = {
  agent: 'crew:builder',
  counts: { lesson: 2 },
  total: 2,
  first_seen: 100,
  last_active: 200,
  top_lessons: [
    { id: 'l1', text: 'Always run tests before shipping.', importance: 0.9, usefulness: 0.8, created_at: 100 },
    { id: 'l2', text: 'Prefer composition over inheritance.', importance: 0.7, usefulness: 0.6, created_at: 150 },
  ],
  recent_decisions: [],
  corrections: [
    {
      id: 'c1',
      type: 'fact',
      text: 'Assumed port 8080 was the default.',
      action: 'superseded',
      reason: null,
      superseded_by: 'l3',
      superseding_text: 'Default port is 7777.',
      corrected_at: 190,
    },
  ],
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(skipOnWin32)('hook shim exit-code + secret-leak gate (FEAT 4a Slice 4)', () => {

  // -------------------------------------------------------------------------
  // subagent-stop-capture.sh
  // -------------------------------------------------------------------------

  it('subagent-stop-capture.sh: exits 0 when provider unreachable', () => {
    const fixturePath = join(FIXTURE_ROOT, 'subagent_stop', '01-basic');
    // Rewrite transcript_path to actual fixture transcript
    const stdinRaw = loadFixtureStdin(fixturePath);
    const transcriptPath = join(fixturePath, 'transcript.jsonl').replace(/\\/g, '/');
    const payload = stdinRaw
      .replace(/__FIXTURE_TRANSCRIPT_PATH__/g, transcriptPath);

    const r = runShim('subagent-stop-capture.sh', payload);
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  it('subagent-stop-capture.sh: exits 0 on empty stdin', () => {
    const r = runShim('subagent-stop-capture.sh', '');
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  // issue #394: at-close capture prefers `astramem-local capture claude`.
  it('subagent-stop-capture.sh: capture success skips legacy ingest (no double-ingest)', () => {
    const fake = makeFakeBin(0);
    try {
      const r = runShim('subagent-stop-capture.sh', subagentPayload(), { PATH: fake.pathEnv });
      expect(r.exitCode).toBe(0);
      expect(existsSync(fake.capturedMarker)).toBe(true); // capture ran
      expect(existsSync(fake.legacyMarker)).toBe(false); // legacy skipped
      assertNoSecretLeak(r);
    } finally {
      fake.cleanup();
    }
  });

  it('subagent-stop-capture.sh: capture failure falls through to legacy exactly once', () => {
    const fake = makeFakeBin(1);
    try {
      const r = runShim('subagent-stop-capture.sh', subagentPayload(), { PATH: fake.pathEnv });
      expect(r.exitCode).toBe(0);
      expect(existsSync(fake.capturedMarker)).toBe(true); // capture attempted
      expect(existsSync(fake.legacyMarker)).toBe(true); // fell through to legacy
      assertNoSecretLeak(r);
    } finally {
      fake.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // pre-compact-capture.sh
  // -------------------------------------------------------------------------

  it('pre-compact-capture.sh: exits 0 when provider unreachable', () => {
    const fixturePath = join(FIXTURE_ROOT, 'pre_compact', '01-basic');
    const stdinRaw = loadFixtureStdin(fixturePath);
    const transcriptPath = join(fixturePath, 'transcript.jsonl').replace(/\\/g, '/');
    const payload = stdinRaw
      .replace(/__FIXTURE_TRANSCRIPT_PATH__/g, transcriptPath);

    const r = runShim('pre-compact-capture.sh', payload);
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  it('pre-compact-capture.sh: exits 0 on empty stdin', () => {
    const r = runShim('pre-compact-capture.sh', '');
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  // -------------------------------------------------------------------------
  // session-end-summary.sh
  // -------------------------------------------------------------------------

  it('session-end-summary.sh: exits 0 when provider unreachable', () => {
    const fixturePath = join(FIXTURE_ROOT, 'session_end', '01-basic');
    const stdinRaw = loadFixtureStdin(fixturePath);
    const transcriptPath = join(fixturePath, 'transcript.jsonl').replace(/\\/g, '/');
    const payload = stdinRaw
      .replace(/__FIXTURE_TRANSCRIPT_PATH__/g, transcriptPath);

    const r = runShim('session-end-summary.sh', payload);
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  it('session-end-summary.sh: exits 0 on empty stdin', () => {
    const r = runShim('session-end-summary.sh', '');
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  // -------------------------------------------------------------------------
  // session-start-recall.sh (issue #31 — read-side hook)
  // -------------------------------------------------------------------------
  // Contract differs from the capture shims: on success it PRINTS a
  // hookSpecificOutput JSON object; on ANY failure it must print NOTHING
  // (partial/garbled stdout would be injected into the session as context).

  it('session-start-recall.sh: exits 0 with EMPTY stdout when provider unreachable', () => {
    const r = runShim('session-start-recall.sh', '{"session_id":"t","cwd":"C:/tmp/some-project"}');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    assertNoSecretLeak(r);
  });

  it('session-start-recall.sh: exits 0 on empty stdin (falls back to $PWD project)', () => {
    const r = runShim('session-start-recall.sh', '');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    assertNoSecretLeak(r);
  });

  it('session-start-recall.sh: MEMORY_SESSIONSTART_RECALL_DISABLE=1 is a silent no-op', () => {
    const r = runShim('session-start-recall.sh', '{"cwd":"C:/tmp/some-project"}', {
      MEMORY_SESSIONSTART_RECALL_DISABLE: '1',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    assertNoSecretLeak(r);
  });

  // -------------------------------------------------------------------------
  // session-start-recall.sh — agent-profile block ("what you learned
  // previously"). Agent identity is read from payload.agent_type, the same
  // field the transcript-capture hooks already use — see file header.
  // -------------------------------------------------------------------------

  it('session-start-recall.sh: renders the agent-profile block within budget when a profile exists', async () => {
    const daemon = await startFakeDaemon({
      recallHits: [],
      profiles: { 'crew:builder': SAMPLE_AGENT_PROFILE },
    });
    try {
      const r = await runShimAsync(
        'session-start-recall.sh',
        JSON.stringify({ cwd: 'C:/tmp/some-project', agent_type: 'crew:builder' }),
        { MEMORY_API_URL_LOCAL: daemon.url },
      );
      expect(r.exitCode).toBe(0);
      assertNoSecretLeak(r);

      const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain('## What you (agent crew:builder) learned previously');
      expect(ctx).toContain('Always run tests before shipping.');
      expect(ctx).toContain('previously wrong about: Assumed port 8080 was the default.');
      // Default MEMORY_PROFILE_MAX_CHARS budget (600) — well within it here.
      expect(ctx.length).toBeLessThanOrEqual(600 + 50); // + slack for the (empty) recall preamble join

      const profileReq = daemon.requestLog.find((r2) => r2.url.startsWith('/agents/'));
      expect(profileReq?.url).toBe('/agents/crew%3Abuilder/profile');
    } finally {
      await daemon.close();
    }
  });

  it('session-start-recall.sh: MEMORY_PROFILE_MAX_CHARS clips the agent-profile block to budget', async () => {
    const daemon = await startFakeDaemon({
      recallHits: [],
      profiles: { 'crew:builder': SAMPLE_AGENT_PROFILE },
    });
    try {
      const r = await runShimAsync(
        'session-start-recall.sh',
        JSON.stringify({ cwd: 'C:/tmp/some-project', agent_type: 'crew:builder' }),
        { MEMORY_API_URL_LOCAL: daemon.url, MEMORY_PROFILE_MAX_CHARS: '40' },
      );
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
      expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(40);
    } finally {
      await daemon.close();
    }
  });

  it('session-start-recall.sh: 404 (agent has zero memories) skips the profile block but keeps a successful recall block', async () => {
    const daemon = await startFakeDaemon({
      recallHits: [{ id: 'h1', type: 'decision', text: 'Ship on Fridays only with a rollback plan.', score: 0.9 }],
      profiles: {}, // no profile for any agent → 404
    });
    try {
      const r = await runShimAsync(
        'session-start-recall.sh',
        JSON.stringify({ cwd: 'C:/tmp/some-project', agent_type: 'crew:unknown-agent' }),
        { MEMORY_API_URL_LOCAL: daemon.url },
      );
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain('Ship on Fridays only with a rollback plan.');
      expect(ctx).not.toContain('What you (agent');
      assertNoSecretLeak(r);
    } finally {
      await daemon.close();
    }
  });

  it('session-start-recall.sh: MEMORY_PROFILE_MAX_CHARS=0 disables the block without even calling the daemon', async () => {
    const daemon = await startFakeDaemon({
      recallHits: [],
      profiles: { 'crew:builder': SAMPLE_AGENT_PROFILE },
    });
    try {
      const r = await runShimAsync(
        'session-start-recall.sh',
        JSON.stringify({ cwd: 'C:/tmp/some-project', agent_type: 'crew:builder' }),
        { MEMORY_API_URL_LOCAL: daemon.url, MEMORY_PROFILE_MAX_CHARS: '0' },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(''); // no hits configured either → fully silent
      expect(daemon.requestLog.some((req) => req.url.startsWith('/agents/'))).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  it('session-start-recall.sh: skips the profile block silently when the payload has no agent_type', async () => {
    const daemon = await startFakeDaemon({
      recallHits: [],
      profiles: { 'crew:builder': SAMPLE_AGENT_PROFILE },
    });
    try {
      // No agent_type in the payload — matches every real SessionStart payload
      // Claude Code actually sends for a main-thread session (see file header).
      const r = await runShimAsync(
        'session-start-recall.sh',
        JSON.stringify({ cwd: 'C:/tmp/some-project' }),
        { MEMORY_API_URL_LOCAL: daemon.url },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(''); // no recall hits either → fully silent
      expect(daemon.requestLog.some((req) => req.url.startsWith('/agents/'))).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  it('session-start-recall.sh: stays fully silent when the daemon is down, even with agent_type set', () => {
    const r = runShim(
      'session-start-recall.sh',
      '{"cwd":"C:/tmp/some-project","agent_type":"crew:builder"}',
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    assertNoSecretLeak(r);
  });
});
