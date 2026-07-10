// astramem agent-profile — fetch the local daemon's per-agent "what has this
// agent learned" profile (GET /agents/:agent/profile).
//
// Local-daemon-only: unlike recall/remember, this does not go through the
// MemoryProvider local/saas selector — there is no SaaS equivalent of this
// endpoint yet, and the profile is meaningless outside "this machine's local
// daemon" scope. Talks to the daemon directly via resolveLocalUrl() +
// readLocalBearer(), the same lib helpers LocalProvider itself is built on.
//
// Exit 0 + prints AgentProfileSchema JSON on 200.
// Exit 3 with empty stdout on 404 (agent has zero memories), timeout, network
// error, or a malformed response — callers (the SessionStart hook) treat exit
// 3 as "skip the block", not as a fatal error.
import { AgentProfileSchema } from '../contracts/wire.ts';
import { resolveLocalUrl } from '../lib/local-url.ts';
import { readLocalBearer } from '../lib/secrets.ts';
import { unrefTimer } from '../lib/abort.ts';

const TIMEOUT_MS = 3000;

/** Injected opts for tests. */
export interface AgentProfileOpts {
  /** Override the resolved base URL (tests point this at a fake server). */
  _baseUrl?: string;
  /** Override global fetch (tests inject a stub/spy). */
  _fetchImpl?: typeof fetch;
}

/**
 * Run the `astramem agent-profile` subcommand.
 *
 * Parses --agent <name> (required).
 * Returns 0 on success, 3 on 404 / timeout / network / parse error.
 */
export async function runAgentProfile(args: string[], opts: AgentProfileOpts = {}): Promise<number> {
  let agent: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') {
      agent = args[i + 1];
      i++;
    }
  }

  if (!agent) {
    process.stderr.write('astramem agent-profile: --agent <name> is required\n');
    return 3;
  }

  const baseUrl = (opts._baseUrl ?? resolveLocalUrl()).replace(/\/$/, '');
  const bearer = readLocalBearer();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

  const doFetch = opts._fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  unrefTimer(timer);

  try {
    const res = await doFetch(`${baseUrl}/agents/${encodeURIComponent(agent)}/profile`, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
    });

    if (!res.ok) {
      // 404 (no profile for this agent) and any other non-2xx both resolve
      // to "no profile" for the caller — the hook doesn't distinguish them.
      return 3;
    }

    const json: unknown = await res.json();
    const parsed = AgentProfileSchema.safeParse(json);
    if (!parsed.success) {
      process.stderr.write(`astramem agent-profile: malformed response — ${parsed.error.message}\n`);
      return 3;
    }

    process.stdout.write(JSON.stringify(parsed.data) + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(`astramem agent-profile: ${(e as Error).message ?? String(e)}\n`);
    return 3;
  } finally {
    clearTimeout(timer);
  }
}
