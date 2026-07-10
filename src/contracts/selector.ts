// Provider selector types for the astramem CLI provider-selector.
import type { MemoryProvider } from './provider.ts';

/** Which backend to use. */
export type Provider = 'local' | 'saas';

/**
 * How the provider was resolved.
 * - 'flag'     — explicit --provider flag on the CLI
 * - 'env'      — ASTRAMEM_PROVIDER env var
 * - 'config'   — ~/.config/astramem/config.json
 * - 'auto'     — probed local /health; chose winner automatically
 * - 'fallback' — auto-probe timed out / failed; used saas as fallback
 */
export type SelectorSource = 'flag' | 'env' | 'config' | 'auto' | 'fallback';

/**
 * A MemoryProvider instance stamped with the backend it was resolved from.
 * Lets a caller holding only the provider handle (e.g. after destructuring
 * `const { provider } = await resolveProvider()` and passing `provider`
 * elsewhere) read which backend it talks to without threading
 * `SelectorResult.providerName` through separately.
 */
export interface ProviderHandle extends MemoryProvider {
  /** Readonly — set once at resolution time, mirrors SelectorResult.providerName. */
  readonly backend: Provider;
}

/** Result returned by the selector after resolution. */
export interface SelectorResult {
  provider: ProviderHandle;
  /**
   * Which provider was chosen. THE supported backend-identity field: prefer
   * this over introspecting the provider instance when you have a
   * SelectorResult in hand. (`provider.backend` — see ProviderHandle — covers
   * the case where only the provider handle itself is available.)
   */
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
