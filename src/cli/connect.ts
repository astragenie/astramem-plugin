// astramem connect — connect to the local AstraMemory daemon.
// Reads bearer from secrets.env, POSTs /register (tolerates 404 → falls back to /health).
// Caches result in local.json. Returns 0 on success, 3 on failure.
//
// `connect --demo` is a separate, zero-network path (Wave 2 Track A,
// demo-readiness programme): it never calls fetch(), pairs the CLI to the
// in-process DemoProvider instead of a real daemon/SaaS backend, and prints
// a clear "DEMO MODE — data is ephemeral" indicator so it's never mistaken
// for a real connection. Plain `connect` (no --demo) always exits demo mode
// first — clearing config.provider and wiping the demo store — before
// running its normal registration flow, so re-pairing with a real backend
// never leaves stray demo data behind.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unifiedConfigDir } from '../lib/datadir.ts';
import { readLocalBearer } from '../lib/secrets.ts';
import { loadConfig, setValue } from '../lib/config.ts';
import { DemoProvider, resetDemoStore, clearDemoStore, DEMO_SAMPLE_QUESTION } from '../providers/demo.ts';

export interface ConnectResult {
  ok: boolean;
  bearer_valid: boolean;
  daemon_version: string | undefined;
  registered_at: string;
  error?: string;
  /** Present and true only for a `connect --demo` result — distinguishes a
   *  demo pairing from a real one in the local.json cache. */
  demo?: boolean;
}

/**
 * Run the `astramem connect` subcommand.
 *
 * `--demo` activates the zero-daemon, zero-network demo provider (see
 * runConnectDemo()) instead of the normal registration flow below.
 *
 * Reads bearer from Track B's readLocalBearer().
 * POSTs /register to local daemon (default: http://127.0.0.1:7777).
 * Tolerates 404 (older daemon without /register) — falls back to /health.
 * Caches result in unifiedConfigDir()/local.json.
 * Prints human-readable status.
 * Returns 0 on success, 3 on failure.
 */
export async function runConnect(args: string[] = []): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Usage: astramem connect [--demo]\n\n' +
        '  (no flags)  Register with the local AstraMemory daemon at config.local.url.\n' +
        '  --demo      Zero-daemon, zero-network demo mode — seeds canned example\n' +
        '              memories in-process. Data is ephemeral; run plain `connect`\n' +
        '              to leave demo mode and pair with a real daemon or SaaS account.\n',
    );
    return 0;
  }

  if (args.includes('--demo')) {
    return runConnectDemo();
  }

  // Leaving demo mode (if we were in it) always happens before a real
  // connect attempt, so re-pairing never leaves stray demo data behind.
  exitDemoModeIfActive();

  const config = loadConfig();
  const daemonUrl = config.local.url ?? 'http://127.0.0.1:7777';
  const bearer = readLocalBearer() ?? undefined;

  process.stdout.write(`Connecting to local daemon @ ${daemonUrl}\n`);
  if (!bearer) {
    process.stdout.write('  bearer: (not found in secrets.env)\n');
  } else {
    process.stdout.write('  bearer: [present]\n');
  }

  const now = new Date().toISOString();
  let result: ConnectResult;

  try {
    // Attempt POST /register
    const registerResp = await attemptRegister(daemonUrl, bearer);
    result = { ...registerResp, registered_at: now };
  } catch (e) {
    result = {
      ok: false,
      bearer_valid: false,
      daemon_version: undefined,
      registered_at: now,
      error: (e as Error).message,
    };
  }

  // Cache to local.json
  try {
    const dir = unifiedConfigDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'local.json'), JSON.stringify(result, null, 2) + '\n', 'utf-8');
  } catch {
    // Cache failure is non-fatal
  }

  // Print status
  if (result.ok) {
    process.stdout.write(`  status: CONNECTED\n`);
    if (result.daemon_version) process.stdout.write(`  daemon version: ${result.daemon_version}\n`);
    process.stdout.write(`  registered_at: ${result.registered_at}\n`);
    return 0;
  } else {
    process.stdout.write(`  status: FAILED\n`);
    if (result.error) process.stdout.write(`  error: ${result.error}\n`);
    return 3;
  }
}

/**
 * `astramem connect --demo` — zero-daemon, zero-network trial pairing.
 *
 * Never calls fetch(). Sets config.provider = 'demo', reseeds the demo
 * store with fresh canned memories (dropping anything from a prior demo
 * session), then prints a clear "DEMO MODE — data is ephemeral" indicator
 * plus a short sample-recall preview so the recall loop visibly works
 * before the user types a single command — mirroring astramem-local's own
 * `demo` command. Always exits 0: there is no daemon to be unreachable.
 */
async function runConnectDemo(): Promise<number> {
  process.stdout.write('astramem connect --demo — activating zero-daemon demo mode\n');
  process.stdout.write('  DEMO MODE — data is ephemeral: nothing leaves this machine, no daemon is started.\n');

  setValue('provider', 'demo');
  const seeded = resetDemoStore();
  process.stdout.write(`  seeded ${seeded.length} example memories\n`);

  const provider = new DemoProvider();
  const health = await provider.health();
  const now = new Date().toISOString();

  const result: ConnectResult = {
    ok: health.ok,
    bearer_valid: true,
    daemon_version: health.version,
    registered_at: now,
    demo: true,
  };

  try {
    const dir = unifiedConfigDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'local.json'), JSON.stringify(result, null, 2) + '\n', 'utf-8');
  } catch {
    // Cache failure is non-fatal.
  }

  process.stdout.write(`  status: CONNECTED (DEMO MODE — data is ephemeral)\n`);
  process.stdout.write(`  provider: demo (${health.version ?? 'unknown'})\n`);

  const preview = await provider.recall({ query: DEMO_SAMPLE_QUESTION, k: 3 });
  if (preview.hits.length > 0) {
    process.stdout.write(`\n  sample recall: "${DEMO_SAMPLE_QUESTION}"\n`);
    for (const hit of preview.hits) {
      process.stdout.write(`    [${hit.score.toFixed(2)}] ${hit.text}\n`);
    }
  }

  process.stdout.write(`\n  registered_at: ${result.registered_at}\n`);
  process.stdout.write(
    '\nRun `astramem connect` (without --demo) any time to pair with a real daemon or SaaS account.\n',
  );
  return 0;
}

/**
 * If a prior `connect --demo` left config.provider set to 'demo', reset it
 * to 'auto' and wipe the demo store before a real connect proceeds — so a
 * real re-pairing never inherits demo-mode routing or leftover demo data.
 * Config-unreadable is treated as "nothing to exit" — falls through
 * silently so a real connect attempt still runs.
 */
function exitDemoModeIfActive(): void {
  try {
    const cfg = loadConfig();
    if (cfg.provider === 'demo') {
      setValue('provider', 'auto');
      clearDemoStore();
    }
  } catch {
    // Config unreadable — nothing to exit.
  }
}

/**
 * Attempt to register with the daemon.
 * Tries POST /register first; if 404 (old daemon), falls back to GET /health.
 */
async function attemptRegister(
  daemonUrl: string,
  bearer: string | undefined,
): Promise<Omit<ConnectResult, 'registered_at'>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

  const timeout = 5000;

  // Try POST /register
  const registerResp = await Promise.race([
    fetch(`${daemonUrl}/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ client: 'astramem-cli', version: '0.4.0-rc.1' }),
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('connect timed out after 5s')), timeout)),
  ]);

  if (registerResp.status === 404) {
    // Old daemon — fall back to /health
    return attemptHealthFallback(daemonUrl, bearer);
  }

  if (!registerResp.ok) {
    return {
      ok: false,
      bearer_valid: registerResp.status !== 401 && registerResp.status !== 403,
      daemon_version: undefined,
      error: `/register returned HTTP ${registerResp.status}`,
    };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await registerResp.json()) as Record<string, unknown>;
  } catch {
    // Ignore parse errors
  }

  return {
    ok: true,
    bearer_valid: true,
    daemon_version: typeof body['version'] === 'string' ? body['version'] : undefined,
  };
}

async function attemptHealthFallback(
  daemonUrl: string,
  bearer: string | undefined,
): Promise<Omit<ConnectResult, 'registered_at'>> {
  const headers: Record<string, string> = {};
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

  const healthResp = await Promise.race([
    fetch(`${daemonUrl}/health`, { headers }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('health probe timed out')), 3000)),
  ]);

  if (!healthResp.ok) {
    return {
      ok: false,
      bearer_valid: false,
      daemon_version: undefined,
      error: `/health returned HTTP ${healthResp.status} (register_pending: daemon lacks /register)`,
    };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await healthResp.json()) as Record<string, unknown>;
  } catch {
    // Ignore parse errors
  }

  return {
    ok: true,
    bearer_valid: !!bearer,
    daemon_version: typeof body['version'] === 'string' ? body['version'] : undefined,
  };
}
