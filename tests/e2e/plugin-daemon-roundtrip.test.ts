/**
 * plugin-daemon-roundtrip.test.ts — SLICE-SMOKE-2 integration roundtrip.
 *
 * Drives the plugin's REAL capture -> envelope -> ingest -> distill -> recall
 * path against a genuinely spawned astramemory-local daemon (dist/cli/index.js).
 * No hand-rolled fetch for the ingest/recall calls themselves — this test calls
 * runIngestTranscript() and runRecall() (the same functions the shipped hooks and
 * `astramem` CLI invoke), with a real LocalProvider pointed at the spawned daemon.
 *
 * ── Gating (AC-7) ────────────────────────────────────────────────────────────
 * Requires env var ASTRAMEM_LOCAL_DIST_PATH: the astramemory-local repo ROOT
 * (the directory containing dist/cli/index.js after `bun run build`). When
 * unset, or dist/cli/index.js is missing at that path, the whole suite is
 * skipped with an explicit, actionable message baked into the test name — never
 * a bare ECONNREFUSED.
 *
 *   # Windows example
 *   $env:ASTRAMEM_LOCAL_DIST_PATH = 'C:\work\mega\astramemory-local'
 *   bun run test:smoke
 *
 * ── Pinning guidance ─────────────────────────────────────────────────────────
 * Point ASTRAMEM_LOCAL_DIST_PATH at a FIXED astramemory-local build/commit —
 * e.g. a clean checkout at a known tag, or a repo you have just run
 * `bun install && bun run build` in. Do NOT point it at a worktree mid-edit
 * (its dist/ may not match its own package.json, or may not exist at all);
 * this test's own AC-4 identity check will fail loudly if dist/package.json's
 * version disagrees with what /version reports, but it cannot detect a dist/
 * that is stale relative to *uncommitted* source edits in the same tree.
 *
 * ── Isolation (F1 fix, mandatory per architect review) ──────────────────────
 * The spawned daemon's APPDATA/HOME/XDG_CONFIG_HOME are redirected to a fresh
 * temp dir containing a config.yaml with security.encryption.enabled: false, and
 * ASTRA_MEMORY_DATADIR points at a separate temp data dir. Without this, a
 * file-datadir daemon with default encryption enabled would call
 * getOrCreateKey() -> the REAL Windows Credential Manager / OS keychain. The
 * PARENT (this test) process's own APPDATA/HOME are also redirected for the
 * duration of the test, because runIngestTranscript/runRecall execute the
 * plugin's provider code IN this process, and LocalProvider reads the bearer
 * via readLocalBearer() which otherwise falls back to the real
 * %APPDATA%\Astramem\secrets.env — this test never reads or writes that file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runIngestTranscript } from '../../src/cli/ingest-transcript.ts';
import { runRecall } from '../../src/cli/recall.ts';
import { createLocalProvider } from '../../src/providers/local.ts';

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

const DIST_ROOT = process.env['ASTRAMEM_LOCAL_DIST_PATH'];
const DAEMON_ENTRY = DIST_ROOT ? join(DIST_ROOT, 'dist', 'cli', 'index.js') : undefined;
const DAEMON_ENTRY_EXISTS = !!DAEMON_ENTRY && existsSync(DAEMON_ENTRY);

const SKIP_REASON = !DIST_ROOT
  ? 'SKIPPED (actionable): ASTRAMEM_LOCAL_DIST_PATH is not set. Set it to an astramemory-local ' +
    'repo root containing a built dist/ (e.g. ASTRAMEM_LOCAL_DIST_PATH=C:\\work\\mega\\astramemory-local) ' +
    'to run this roundtrip test.'
  : !DAEMON_ENTRY_EXISTS
    ? `SKIPPED (actionable): ASTRAMEM_LOCAL_DIST_PATH=${DIST_ROOT} has no dist/cli/index.js. ` +
      'Run "bun install && bun run build" in that repo first.'
    : null;

if (SKIP_REASON) {
  // Surfaced even under CI log truncation — not just relying on the test name.
  console.warn(`[plugin-daemon-roundtrip] ${SKIP_REASON}`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = 19100; // SLICE-SMOKE-2 claims 19100+ (distinct from SMOKE-1's 19000 range)
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = 'smoke2-roundtrip-tok';

const FIXTURE_TRANSCRIPT = [
  { role: 'user', text: 'We need to pick a vector store for v1. LanceDB vs sqlite-vec.' },
  {
    role: 'assistant',
    text:
      'sqlite-vec keeps everything in one SQLite file. LanceDB is a separate columnar store. ' +
      'For v1 with under 1M memories, sqlite-vec wins on simplicity and Windows install pain.',
  },
  { role: 'user', text: "OK let's go with sqlite-vec. Document it as the v1 default." },
  {
    role: 'assistant',
    text: 'Done. Decision: use sqlite-vec for v1, LanceDB-ready via VectorStore interface for later.',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Daemon config dir naming mirrors astramemory-local's config/datadir.ts defaultConfigDir(). */
function daemonConfigSubdir(configRoot: string): string {
  if (process.platform === 'win32') return join(configRoot, 'Astramem');
  if (process.platform === 'darwin') return join(configRoot, 'Library', 'Application Support', 'astra-memory');
  return join(configRoot, '.config', 'astra-memory');
}

async function waitForHealth(maxMs = 15_000): Promise<void> {
  const start = Date.now();
  let lastState = '(no attempt yet)';
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok: boolean; status?: string };
        if (body.ok) return;
        lastState = `health responded 200 but ok=false (status=${body.status ?? 'unknown'})`;
      } else {
        lastState = `health responded with HTTP ${res.status}`;
      }
    } catch (e) {
      lastState = `fetch failed: ${(e as Error).message}`;
    }
    await sleep(250);
  }
  throw new Error(
    `waitForHealth: condition="daemon /health returns 200 {ok:true}" elapsed=${Date.now() - start}ms ` +
      `last state: ${lastState}`,
  );
}

/** Sum of all job-state counts from /health's queue block (evidence the ingest was enqueued). */
async function totalQueueDepth(): Promise<number> {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) return -1;
  const body = (await res.json()) as { queue?: Record<string, number> };
  if (!body.queue) return -1;
  return Object.values(body.queue).reduce((a, b) => a + b, 0);
}

async function waitForQueueActivity(maxMs = 8_000): Promise<void> {
  const start = Date.now();
  let lastDepth = -1;
  while (Date.now() - start < maxMs) {
    lastDepth = await totalQueueDepth();
    if (lastDepth > 0) return;
    await sleep(200);
  }
  throw new Error(
    `waitForQueueActivity: condition="/health queue depth > 0 (ingest enqueued a distill job)" ` +
      `elapsed=${Date.now() - start}ms last state: depth=${lastDepth}`,
  );
}

/** Capture stdout while fn() runs (runRecall prints its JSON response to stdout). */
async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, stdout: chunks.join('') };
  } finally {
    process.stdout.write = orig;
  }
}

interface RecallHitLike {
  id: string;
  type: string;
  text: string;
  score: number;
}

/** Poll runRecall (the plugin's own recall CLI path) until a hit matches expectedFragment. */
async function pollRecall(
  provider: ReturnType<typeof createLocalProvider>,
  query: string,
  expectedFragment: string,
  maxMs: number,
): Promise<RecallHitLike> {
  const start = Date.now();
  let lastState = '(no attempt yet)';
  while (Date.now() - start < maxMs) {
    const { code, stdout } = await captureStdout(() =>
      runRecall(['--query', query, '--k', '10'], { _provider: provider }),
    );
    if (code === 0) {
      try {
        const parsed = JSON.parse(stdout) as { hits: RecallHitLike[] };
        lastState = `${parsed.hits.length} hit(s): ${JSON.stringify(
          parsed.hits.map((h) => ({ type: h.type, text: h.text.slice(0, 60) })),
        )}`;
        const match = parsed.hits.find((h) => h.text.toLowerCase().includes(expectedFragment.toLowerCase()));
        if (match) return match;
      } catch (e) {
        lastState = `stdout was not valid JSON: ${(e as Error).message} (stdout: ${stdout.slice(0, 200)})`;
      }
    } else {
      lastState = `runRecall exit code ${code}`;
    }
    await sleep(500);
  }
  throw new Error(
    `pollRecall: condition="a recall hit for query="${query}" contains "${expectedFragment}"" ` +
      `elapsed=${Date.now() - start}ms last state: ${lastState}`,
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let daemon: ChildProcess | null = null;
let daemonExitCode: number | null = null;
let tmpConfigRoot: string;
let tmpDataDir: string;
let tmpFixtureDir: string;
let savedAppData: string | undefined;
let savedHome: string | undefined;
let savedXdgConfigHome: string | undefined;

beforeAll(async () => {
  if (SKIP_REASON) return;

  tmpConfigRoot = mkdtempSync(join(tmpdir(), 'astramem-smoke2-cfg-'));
  tmpDataDir = mkdtempSync(join(tmpdir(), 'astramem-smoke2-data-'));
  tmpFixtureDir = mkdtempSync(join(tmpdir(), 'astramem-smoke2-fixture-'));

  const daemonConfigDir = daemonConfigSubdir(tmpConfigRoot);
  mkdirSync(daemonConfigDir, { recursive: true });
  // F1 fix: encryption disabled avoids getOrCreateKey() touching the real
  // Windows Credential Manager / OS keychain for a file-based datadir.
  writeFileSync(join(daemonConfigDir, 'config.yaml'), 'security:\n  encryption:\n    enabled: false\n');

  const daemonEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    APPDATA: tmpConfigRoot,
    HOME: tmpConfigRoot,
    XDG_CONFIG_HOME: join(tmpConfigRoot, '.config'),
    ASTRA_MEMORY_DATADIR: tmpDataDir,
    ASTRA_MEMORY_TOKEN: TOKEN,
    ASTRA_MEMORY_MOCK_PROVIDERS: '1',
  };

  daemon = spawn(process.execPath, [DAEMON_ENTRY as string, 'serve', '--port', String(PORT)], {
    env: daemonEnv,
    stdio: 'pipe',
    cwd: DIST_ROOT,
  });
  daemon.on('exit', (code) => {
    daemonExitCode = code;
  });
  daemon.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[daemon] ${chunk.toString()}`);
  });

  // Isolate THIS process's env too — runIngestTranscript/runRecall execute the
  // plugin's provider code in-process, and readLocalBearer() would otherwise
  // fall back to the real %APPDATA%\Astramem\secrets.env.
  savedAppData = process.env['APPDATA'];
  savedHome = process.env['HOME'];
  savedXdgConfigHome = process.env['XDG_CONFIG_HOME'];
  process.env['APPDATA'] = tmpConfigRoot;
  process.env['HOME'] = tmpConfigRoot;
  process.env['XDG_CONFIG_HOME'] = join(tmpConfigRoot, '.config');
  process.env['MEMORY_BEARER'] = TOKEN;

  await waitForHealth();
  if (daemonExitCode !== null) {
    throw new Error(`daemon exited early (code ${daemonExitCode}) before reporting healthy`);
  }
}, 30_000);

afterAll(async () => {
  if (daemon && !daemon.killed) {
    daemon.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (daemon && !daemon.killed) daemon.kill('SIGKILL');
        resolve();
      }, 3000);
      daemon!.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  if (savedAppData !== undefined) process.env['APPDATA'] = savedAppData;
  else delete process.env['APPDATA'];
  if (savedHome !== undefined) process.env['HOME'] = savedHome;
  else delete process.env['HOME'];
  if (savedXdgConfigHome !== undefined) process.env['XDG_CONFIG_HOME'] = savedXdgConfigHome;
  else delete process.env['XDG_CONFIG_HOME'];
  delete process.env['MEMORY_BEARER'];

  for (const dir of [tmpConfigRoot, tmpDataDir, tmpFixtureDir]) {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!!SKIP_REASON)('plugin <-> astramemory-local daemon roundtrip (SLICE-SMOKE-2)', () => {
  it(
    SKIP_REASON ?? 'capture -> envelope -> ingest -> distill -> recall through the plugin\'s real code path',
    async () => {
      if (SKIP_REASON) return;

      // AC-4: fail-fast identity check — spawned daemon must match the pinned build.
      const versionRes = await fetch(`${BASE_URL}/version`);
      expect(versionRes.ok).toBe(true);
      const versionBody = (await versionRes.json()) as { version: string };
      const expectedPkg = JSON.parse(readFileSync(join(DIST_ROOT as string, 'package.json'), 'utf-8')) as {
        version: string;
      };
      console.log(
        `[plugin-daemon-roundtrip] daemon /version -> ${versionBody.version} (package.json: ${expectedPkg.version})`,
      );
      expect(
        versionBody.version,
        'daemon-served version must match package.json at ASTRAMEM_LOCAL_DIST_PATH — rebuild (bun run build)?',
      ).toBe(expectedPkg.version);

      // AC-5: capture -> envelope -> ingest via the plugin's real code path
      // (runIngestTranscript + the real LocalProvider — not a hand-rolled fetch).
      const fixturePath = join(tmpFixtureDir, 'transcript.jsonl');
      writeFileSync(fixturePath, FIXTURE_TRANSCRIPT.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');

      const provider = createLocalProvider({ url: BASE_URL });
      const ingestCode = await runIngestTranscript(
        [
          '--event', 'session_end',
          '--transcript-path', fixturePath,
          '--session-id', 'smoke2-session',
          '--project-id', 'smoke2-project',
        ],
        { _provider: provider },
      );
      expect(ingestCode).toBe(0);

      // Evidence the ingest was accepted and enqueued (distinct from the final
      // recall-based proof that distillation completed).
      await waitForQueueActivity();

      // AC-6: recall roundtrip through the plugin's own recall path (runRecall).
      // Query 'sqlite' not 'sqlite-vec' — FTS5 treats the hyphen as a negation.
      const hit = await pollRecall(provider, 'sqlite', 'sqlite-vec', 30_000);
      expect(hit.text.toLowerCase()).toContain('sqlite-vec');
    },
    60_000,
  );
});
