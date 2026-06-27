// astramem health — probe the selected provider's /health endpoint.
// Prints JSON: {ok, provider, version, url, latencyMs}.
// Exit 0 if ok, exit 3 if no provider reachable.
import type { Provider } from '../contracts/selector.ts';
import type { MemoryProvider } from '../contracts/provider.ts';
import { resolveProvider } from '../lib/selector.ts';

/** Injected opts for tests. */
export interface HealthOpts {
  provider?: Provider;
  _provider?: MemoryProvider;
  /** Provider name to embed in output (used with _provider injection) */
  _providerName?: Provider;
}

export interface HealthOutput {
  ok: boolean;
  provider: string;
  version: string | undefined;
  url: string | undefined;
  latencyMs: number | undefined;
  error?: string;
}

/**
 * Run the `astramem health` subcommand.
 *
 * Probes the selected provider's /health endpoint.
 * Prints HealthOutput JSON to stdout.
 * Returns 0 if ok, 3 if no provider reachable.
 */
export async function runHealth(args: string[], opts: HealthOpts = {}): Promise<number> {
  // Parse --help
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: astramem health [--provider local|saas|auto]\n');
    return 0;
  }

  let provider: MemoryProvider;
  let providerName: string;

  try {
    if (opts._provider) {
      provider = opts._provider;
      providerName = opts._providerName ?? 'injected';
    } else {
      const sel = await resolveProvider({ flag: opts.provider });
      provider = sel.provider;
      providerName = sel.providerName;
    }
  } catch (e) {
    const out: HealthOutput = {
      ok: false,
      provider: 'unknown',
      version: undefined,
      url: undefined,
      latencyMs: undefined,
      error: (e as Error).message,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 3;
  }

  try {
    const healthResp = await Promise.race([
      provider.health(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('health probe timed out after 5s')), 5000),
      ),
    ]);
    const out: HealthOutput = {
      ok: healthResp.ok,
      provider: providerName,
      version: healthResp.version,
      url: healthResp.url,
      latencyMs: healthResp.latencyMs,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return healthResp.ok ? 0 : 3;
  } catch (e) {
    const out: HealthOutput = {
      ok: false,
      provider: providerName,
      version: undefined,
      url: undefined,
      latencyMs: undefined,
      error: (e as Error).message,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 3;
  }
}
