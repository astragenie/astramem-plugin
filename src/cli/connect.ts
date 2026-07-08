// astramem connect — connect to the local AstraMemory daemon.
// Reads bearer from secrets.env, probes GET /health. Caches result in local.json.
// Returns 0 on success, 3 on failure.
//
// The daemon has never had a /register route (astramemory-local's src/server/app.ts
// registers health/version/ingest/search/memory/... but no register endpoint), so
// this no longer attempts one — it goes straight to the health probe.
//
// Bearer validity is reported honestly as a tri-state (see BearerStatus). A 200
// from /health does NOT prove the bearer: the daemon serves /health publicly
// whenever it is bound to loopback (the default), so it never checks the token.
// We therefore report 'unverified' on a public 200 rather than claiming a
// validity we never observed. True verification needs an authenticated probe
// route on the daemon — tracked in astramem-local#129.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unifiedConfigDir } from '../lib/datadir.ts';
import { readLocalBearer } from '../lib/secrets.ts';
import { loadConfig } from '../lib/config.ts';

/**
 * Bearer verification outcome against the daemon.
 * - `absent`     — no bearer configured in secrets.env.
 * - `rejected`   — daemon returned 401/403 (only possible on a non-loopback
 *                  bind, where /health enforces auth). The token is bad.
 * - `unverified` — a bearer is present but the probe could not confirm it,
 *                  because /health answered 200 without requiring auth
 *                  (public-on-loopback) or the probe errored. Validity is
 *                  confirmed on the first authenticated request.
 */
export type BearerStatus = 'absent' | 'rejected' | 'unverified';

export interface ConnectResult {
  /** Daemon reachable — /health answered 200. */
  ok: boolean;
  /** Whether a bearer was found in secrets.env. */
  bearer_present: boolean;
  /** Honest bearer verification outcome — see BearerStatus. */
  bearer_status: BearerStatus;
  daemon_version: string | undefined;
  registered_at: string;
  error?: string;
}

/**
 * Run the `astramem connect` subcommand.
 *
 * Reads bearer from Track B's readLocalBearer().
 * Probes GET /health on the local daemon (default: http://127.0.0.1:7777).
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
    const probe = await probeHealth(daemonUrl, bearer);
    result = { ...probe, registered_at: now };
  } catch (e) {
    result = {
      ok: false,
      bearer_present: !!bearer,
      // Probe errored (timeout / connection refused) — we never reached the
      // daemon, so the bearer is unverified, not rejected.
      bearer_status: bearer ? 'unverified' : 'absent',
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
    process.stdout.write(`  bearer: ${describeBearer(result.bearer_status)}\n`);
    process.stdout.write(`  registered_at: ${result.registered_at}\n`);
    return 0;
  } else {
    process.stdout.write(`  status: FAILED\n`);
    if (result.bearer_status === 'rejected') {
      process.stdout.write(`  bearer: rejected by daemon (HTTP 401/403) — check secrets.env\n`);
    }
    if (result.error) process.stdout.write(`  error: ${result.error}\n`);
    return 3;
  }
}

/** Human-readable one-liner for a bearer status on the success path. */
function describeBearer(status: BearerStatus): string {
  switch (status) {
    case 'absent':
      return 'not configured (capture/recall will fail if the daemon requires auth)';
    case 'unverified':
      return 'present (unverified — /health is public on loopback; validity confirmed on first authed request)';
    case 'rejected':
      // Not reachable on the ok path, but keep the switch exhaustive.
      return 'rejected by daemon (HTTP 401/403) — check secrets.env';
  }
}

/**
 * Probe the daemon's GET /health endpoint.
 *
 * A 200 here means the daemon is reachable, but does NOT prove the bearer —
 * the daemon answers /health publicly on a loopback bind (the default), so it
 * may never have checked the token. We only ever downgrade to 'rejected' on an
 * explicit 401/403, which the daemon returns only on a non-loopback bind. See
 * astramem-local#129 for the authed probe route that would make this 'verified'.
 */
async function probeHealth(
  daemonUrl: string,
  bearer: string | undefined,
): Promise<Omit<ConnectResult, 'registered_at'>> {
  const headers: Record<string, string> = {};
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  const bearerPresent = !!bearer;

  const healthResp = await Promise.race([
    fetch(`${daemonUrl}/health`, { headers }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('health probe timed out after 5s')), 5000)),
  ]);

  if (!healthResp.ok) {
    const rejected = healthResp.status === 401 || healthResp.status === 403;
    return {
      ok: false,
      bearer_present: bearerPresent,
      bearer_status: rejected ? 'rejected' : bearerPresent ? 'unverified' : 'absent',
      daemon_version: undefined,
      error: `/health returned HTTP ${healthResp.status}`,
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
    bearer_present: bearerPresent,
    // 200 is reachability, not proof of the bearer — see the fn doc comment.
    bearer_status: bearerPresent ? 'unverified' : 'absent',
    daemon_version: typeof body['version'] === 'string' ? body['version'] : undefined,
  };
}
