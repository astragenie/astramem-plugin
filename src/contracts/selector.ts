// Provider selector types for the astramem CLI provider-selector.
import type { MemoryProvider } from './provider.ts';

/** Which backend to use. 'demo' is the zero-daemon, zero-network trial
 *  provider activated by `astramem connect --demo` — never selected by
 *  auto-probe, only via explicit flag/env/config. */
export type Provider = 'local' | 'saas' | 'demo';

/**
 * How the provider was resolved.
 * - 'flag'     — explicit --provider flag on the CLI
 * - 'env'      — ASTRAMEM_PROVIDER env var
 * - 'config'   — ~/.config/astramem/config.json
 * - 'auto'     — probed local /health; chose winner automatically
 * - 'fallback' — auto-probe timed out / failed; used saas as fallback
 */
export type SelectorSource = 'flag' | 'env' | 'config' | 'auto' | 'fallback';

/** Result returned by the selector after resolution. */
export interface SelectorResult {
  provider: MemoryProvider;
  /** Which provider was chosen. */
  providerName: Provider;
  /** How the provider was resolved. */
  source: SelectorSource;
  /** Latency of the /health probe used in 'auto' resolution (ms). */
  latency_probe_ms?: number;
}

/** Options passed to the selector. */
export interface SelectorOpts {
  /** Explicit provider override (from --provider flag). */
  flag?: Provider;
}
