// astramem connect — connect to the local AstraMemory daemon.
// Reads bearer from secrets.env, probes GET /health for reachability, then
// GET /whoami to verify the bearer. Caches result in local.json.
// Returns 0 on success, 3 on failure (unreachable OR bearer rejected).
//
// The daemon has never had a /register route (astramemory-local's src/server/app.ts
// registers health/version/whoami/ingest/search/memory/... but no register
// endpoint), so this no longer attempts one — it probes /health directly.
//
// Bearer validity is reported as a tri-/quad-state (see BearerStatus). A 200
// from /health does NOT prove the bearer: the daemon serves /health publicly
// whenever it is bound to loopback (the default), so it never checks the token.
// To actually verify, connect then probes GET /whoami — an authenticated route
// that requires Bearer on every bind, loopback included (astramem-local#129):
//   200      → 'verified'
//   401/403  → 'rejected'
//   404/etc  → 'unverified' (older daemon without /whoami — graceful fallback)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unifiedConfigDir } from '../lib/datadir.ts';
import { readLocalBearer } from '../lib/secrets.ts';
import { loadConfig } from '../lib/config.ts';

/**
 * Bearer verification outcome against the daemon.
 * - `absent`     — no bearer configured in secrets.env.
 * - `verified`   — daemon's authenticated /whoami route accepted the bearer.
 * - `rejected`   — daemon returned 401/403 (/whoami, or /health on a
 *                  non-loopback bind). The token is bad.
 * - `unverified` — a bearer is present but the probe could not confirm it:
 *                  /health answered 200 publicly (loopback) AND /whoami was
 *                  unavailable (older daemon, 404) or errored. Validity is
 *                  then only confirmed on the first authenticated request.
 */
export type BearerStatus = 'absent' | 'verified' | 'rejected' | 'unverified';

export interface ConnectResult {
  /** Daemon reachable — /health answered 200. */
  ok: boolean;
  /** Whether a bearer was found in secrets.env. */
  bearer_present: boolean;
  /** Bearer verification outcome — see BearerStatus. */
  bearer_status: BearerStatus;
  daemon_version: string | undefined;
  registered_at: string;
  error?: string;
}

/**
 * Run the `astramem connect` subcommand.
 *
 * Reads bearer from Track B's readLocalBearer().
 * Probes GET /health (reachability) then GET /whoami (bearer verification) on
 * the local daemon (default: http://127.0.0.1:7777).
 * Caches result in unifiedConfigDir()/local.json.
 * Prints human-readable status.
 * Returns 0 on success, 3 on failure (unreachable OR bearer rejected).
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
    // Reachable + a bearer configured → verify it against the authenticated
    // /whoami route (astramem-local#129). This upgrades the preliminary
    // 'unverified' to a real 'verified' / 'rejected'.
    if (result.ok && bearer) {
      const verified = await verifyBearer(daemonUrl, bearer);
      result.bearer_status = verified.status;
      if (verified.version) result.daemon_version = verified.version;
    }
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

  // A reachable daemon with a rejected bearer is still a failed connect — the
  // point of connect is to establish an authenticated session.
  const succeeded = result.ok && result.bearer_status !== 'rejected';

  if (succeeded) {
    process.stdout.write(`  status: CONNECTED\n`);
    if (result.daemon_version) process.stdout.write(`  daemon version: ${result.daemon_version}\n`);
    process.stdout.write(`  bearer: ${describeBearer(result.bearer_status)}\n`);
    process.stdout.write(`  registered_at: ${result.registered_at}\n`);
    return 0;
  }

  process.stdout.write(`  status: FAILED\n`);
  if (result.bearer_status === 'rejected') {
    process.stdout.write(`  bearer: rejected by daemon (HTTP 401/403) — check secrets.env\n`);
  }
  if (result.error) process.stdout.write(`  error: ${result.error}\n`);
  return 3;
}

/** Human-readable one-liner for a bearer status on the success path. */
function describeBearer(status: BearerStatus): string {
  switch (status) {
    case 'absent':
      return 'not configured (capture/recall will fail if the daemon requires auth)';
    case 'verified':
      return 'present and verified by daemon /whoami';
    case 'unverified':
      return 'present (unverified — daemon has no /whoami route; validity confirmed on first authed request)';
    case 'rejected':
      // Not reachable on the success path, but keep the switch exhaustive.
      return 'rejected by daemon (HTTP 401/403) — check secrets.env';
  }
}

/**
 * Probe the daemon's GET /health endpoint for reachability + version.
 *
 * A 200 here means the daemon is reachable, but does NOT prove the bearer —
 * the daemon answers /health publicly on a loopback bind (the default), so it
 * may never have checked the token. Returns a preliminary bearer_status that
 * runConnect() then upgrades via verifyBearer()/whoami. We only downgrade to
 * 'rejected' here on an explicit 401/403, which /health returns only on a
 * non-loopback bind.
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
    // Preliminary — upgraded by verifyBearer() when a bearer is present.
    bearer_status: bearerPresent ? 'unverified' : 'absent',
    daemon_version: typeof body['version'] === 'string' ? body['version'] : undefined,
  };
}

/**
 * Verify a bearer against the daemon's authenticated GET /whoami route
 * (astramem-local#129). /whoami requires Bearer on every bind (loopback
 * included), so its response status is an authoritative bearer verdict:
 *   200      → verified (returns the daemon's reported version too)
 *   401/403  → rejected
 *   404/5xx  → unverified (older daemon without /whoami, or transient) —
 *              we do NOT claim 'verified' for anything but an explicit 200
 * A network error/timeout also yields 'unverified' — /health already proved
 * the daemon reachable, so a failed /whoami shouldn't sink the whole connect.
 */
async function verifyBearer(
  daemonUrl: string,
  bearer: string,
): Promise<{ status: Exclude<BearerStatus, 'absent'>; version?: string }> {
  try {
    const resp = await Promise.race([
      fetch(`${daemonUrl}/whoami`, { headers: { Authorization: `Bearer ${bearer}` } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('whoami probe timed out after 5s')), 5000)),
    ]);

    if (resp.status === 401 || resp.status === 403) return { status: 'rejected' };
    if (!resp.ok) return { status: 'unverified' };

    let body: Record<string, unknown> = {};
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch {
      // Ignore parse errors
    }
    return {
      status: 'verified',
      version: typeof body['version'] === 'string' ? body['version'] : undefined,
    };
  } catch {
    // Timeout / connection error — reachability already confirmed by /health.
    return { status: 'unverified' };
  }
}
