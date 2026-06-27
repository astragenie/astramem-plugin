// astramem connect — connect to the local AstraMemory daemon.
// Reads bearer from secrets.env, POSTs /register (tolerates 404 → falls back to /health).
// Caches result in local.json. Returns 0 on success, 3 on failure.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unifiedConfigDir } from '../lib/datadir.ts';
import { readLocalBearer } from '../lib/secrets.ts';
import { loadConfig } from '../lib/config.ts';

export interface ConnectResult {
  ok: boolean;
  bearer_valid: boolean;
  daemon_version: string | undefined;
  registered_at: string;
  error?: string;
}

/**
 * Run the `astramem connect` subcommand.
 *
 * Reads bearer from Track B's readLocalBearer().
 * POSTs /register to local daemon (default: http://127.0.0.1:7777).
 * Tolerates 404 (older daemon without /register) — falls back to /health.
 * Caches result in unifiedConfigDir()/local.json.
 * Prints human-readable status.
 * Returns 0 on success, 3 on failure.
 */
export async function runConnect(): Promise<number> {
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
