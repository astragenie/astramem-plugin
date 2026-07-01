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
import { resolveEnv } from './env.ts';
import { ENV } from './env-specs.ts';
import { resolveLocalUrl } from './local-url.ts';

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

/**
 * Internal probe function — module-private; replaced only via _setHealthProbeFn in test env.
 * Not exported directly to prevent production callers from mutating this.
 */
let _healthProbeFn: (url: string) => Promise<{ ok: boolean; latency_ms: number }> =
  defaultHealthProbe;

/**
 * Reset health cache.
 * TEST-ONLY — no-op outside NODE_ENV=test. Do not call in production code.
 */
export function _resetHealthCache(): void {
  if (process.env['NODE_ENV'] !== 'test') return;
  _healthCache.clear();
}

/**
 * Override the health probe function (e.g. to return a fixed result in tests).
 * TEST-ONLY — no-op outside NODE_ENV=test. Do not call in production code.
 */
export function _setHealthProbeFn(
  fn: (url: string) => Promise<{ ok: boolean; latency_ms: number }>,
): void {
  if (process.env['NODE_ENV'] !== 'test') return;
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

  // 2. Env var — from caller or process.env (via canonical env spec).
  const envVal = opts.env ?? resolveEnv(ENV.provider).value;
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
  // Env-first URL resolution (Finding 4 fix): env → config → default.
  const localUrl = resolveLocalUrl();

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

  // Privacy-safe fallback policy: only fall back to SaaS when SaaS is explicitly
  // configured. Silent fallback to SaaS when the user has NOT configured it violates
  // the data-local product posture — local data could be sent to a SaaS endpoint
  // the user never opted into.
  const saasConfigured = isSaasConfigured();

  if (!saasConfigured) {
    throw new Error(
      `Local daemon unreachable at ${localUrl} and SaaS not configured. ` +
        `data-local posture: refusing to fall back to SaaS. ` +
        `To configure SaaS explicitly, set MEMORY_API_URL_SAAS or run astramem config set saas.url <url>.`,
    );
  }

  // Fallback to saas (user has explicitly configured SaaS).
  const provider = await loadProvider('saas');
  return { provider, providerName: 'saas', source: 'fallback' };
}

/**
 * Returns true when SaaS is explicitly configured via env or config.
 * Used to enforce the data-local posture: refuse silent SaaS fallback when the
 * user has not opted into SaaS.
 */
function isSaasConfigured(): boolean {
  // Check env first (canonical + alias).
  const envResult = resolveEnv(ENV['apiUrlSaas']!);
  if (envResult.source === 'canonical' || envResult.source === 'alias') {
    return true;
  }

  // Check config.
  try {
    const cfg = loadConfig();
    if (cfg.saas.url) return true;
  } catch {
    // Config unreadable — treat as not configured.
  }

  return false;
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
