/**
 * selector.ts — provider resolution with precedence + auto-probe.
 *
 * Resolution order:
 *   1. opts.flag      — explicit --provider CLI flag
 *   2. opts.env       — env var value passed in (caller reads it), or
 *                       process.env.ASTRAMEM_PROVIDER
 *   3. config.provider (if not 'auto')
 *   4. 'auto':        probe local /health once per URL (5s in-process cache).
 *                     If local responds → return local with source='auto'.
 *                     Otherwise → return saas with source='fallback'.
 *
 * Provider implementations are loaded via lazy dynamic import so this file
 * can be written before Track A's src/providers/*.ts files exist.
 */
import type { SelectorResult } from '../contracts/selector.ts';
import type { Provider } from '../contracts/selector.ts';
import type { MemoryProvider } from '../contracts/provider.ts';
import { loadConfig } from './config.ts';

/** Options for resolveProvider. */
export interface ResolvableOpts {
  /** Explicit --provider flag value (takes highest priority). */
  flag?: Provider;
  /** Env-var value to consider (caller passes process.env.ASTRAMEM_PROVIDER or similar). */
  env?: string;
}

// ---------------------------------------------------------------------------
// 5-second in-process health-probe cache keyed by URL.
// ---------------------------------------------------------------------------
interface CacheEntry {
  ok: boolean;
  latency_ms: number;
  expires_at: number; // Date.now() + 5000
}

const _healthCache = new Map<string, CacheEntry>();

/** Exposed for test injection — override to skip real HTTP probes. */
export let _healthProbeFn: (url: string) => Promise<{ ok: boolean; latency_ms: number }> =
  defaultHealthProbe;

/** Reset for tests. */
export function _resetHealthCache(): void {
  _healthCache.clear();
}

export function _setHealthProbeFn(
  fn: (url: string) => Promise<{ ok: boolean; latency_ms: number }>,
): void {
  _healthProbeFn = fn;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Resolve which provider to use, following the precedence chain.
 * Returns a SelectorResult with the resolved MemoryProvider instance.
 */
export async function resolveProvider(opts: ResolvableOpts = {}): Promise<SelectorResult> {
  // 1. Explicit flag.
  if (opts.flag) {
    const provider = await loadProvider(opts.flag);
    return { provider, providerName: opts.flag, source: 'flag' };
  }

  // 2. Env var — from caller or process.env.
  const envVal = opts.env ?? process.env['ASTRAMEM_PROVIDER'];
  if (envVal && isValidProvider(envVal)) {
    const name = envVal as Provider;
    const provider = await loadProvider(name);
    return { provider, providerName: name, source: 'env' };
  }

  // 3. Config file.
  let configProvider: string = 'auto';
  try {
    const cfg = loadConfig();
    configProvider = cfg.provider;
  } catch {
    // Config unreadable — treat as auto.
  }

  if (configProvider !== 'auto' && isValidProvider(configProvider)) {
    const name = configProvider as Provider;
    const provider = await loadProvider(name);
    return { provider, providerName: name, source: 'config' };
  }

  // 4. Auto-probe.
  return resolveAuto();
}

// ---------------------------------------------------------------------------
// Auto resolution
// ---------------------------------------------------------------------------

async function resolveAuto(): Promise<SelectorResult> {
  // Default local URL — try config, fall back to default.
  let localUrl = 'http://127.0.0.1:7777';
  try {
    const cfg = loadConfig();
    if (cfg.local.url) localUrl = cfg.local.url;
  } catch {
    // ignore
  }

  const probe = await cachedHealthProbe(localUrl);

  if (probe.ok) {
    const provider = await loadProvider('local');
    return {
      provider,
      providerName: 'local',
      source: 'auto',
      latency_probe_ms: probe.latency_ms,
    };
  }

  // Fallback to saas.
  const provider = await loadProvider('saas');
  return { provider, providerName: 'saas', source: 'fallback' };
}

async function cachedHealthProbe(url: string): Promise<{ ok: boolean; latency_ms: number }> {
  const now = Date.now();
  const cached = _healthCache.get(url);
  if (cached && now < cached.expires_at) {
    return { ok: cached.ok, latency_ms: cached.latency_ms };
  }

  const result = await _healthProbeFn(url);
  _healthCache.set(url, { ok: result.ok, latency_ms: result.latency_ms, expires_at: now + 5000 });
  return result;
}

// ---------------------------------------------------------------------------
// Provider loader (lazy dynamic import — Track A files may not exist yet)
// ---------------------------------------------------------------------------

async function loadProvider(name: Provider): Promise<MemoryProvider> {
  if (name === 'local') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = await import('../providers/local.ts');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return new (mod.LocalProvider as new () => MemoryProvider)();
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = await import('../providers/saas.ts');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return new (mod.SaasProvider as new () => MemoryProvider)();
}

// ---------------------------------------------------------------------------
// Default health probe (real HTTP)
// ---------------------------------------------------------------------------

async function defaultHealthProbe(url: string): Promise<{ ok: boolean; latency_ms: number }> {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${url}/health`, { signal: controller.signal });
      return { ok: res.ok, latency_ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, latency_ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

function isValidProvider(val: string): val is Provider {
  return val === 'local' || val === 'saas';
}
