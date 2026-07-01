/**
 * local-url.ts — canonical resolver for the local daemon URL.
 *
 * Resolution order (env-first to honour operator overrides):
 *   1. MEMORY_API_URL_LOCAL env var (canonical) or its ASTRAMEMORY_API_URL alias when
 *      the value matches a localhost-ish pattern (via resolveEnv + aliasPredicate).
 *   2. config.local.url from disk (loadConfig).
 *   3. Hard-coded default: http://127.0.0.1:7777.
 *
 * Also reports the winning source for observability (used by `astramem doctor --json`).
 */
import { resolveEnv } from './env.ts';
import { ENV } from './env-specs.ts';
import { loadConfig } from './config.ts';

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:7777';

export type LocalUrlSource = 'env' | 'config' | 'default';

export interface LocalUrlResolution {
  url: string;
  source: LocalUrlSource;
}

/**
 * Resolve the local daemon URL following env → config → default precedence.
 *
 * Returns the URL string directly (convenience wrapper over resolveLocalUrl()).
 */
export function resolveLocalUrl(): string {
  return resolveLocalUrlWithSource().url;
}

/**
 * Resolve the local daemon URL and report which source won.
 * Used by `astramem doctor --json` to emit `local_url_source`.
 */
export function resolveLocalUrlWithSource(): LocalUrlResolution {
  // 1. Env-first: MEMORY_API_URL_LOCAL (or alias ASTRAMEMORY_API_URL for localhost values).
  const envResult = resolveEnv(ENV['apiUrlLocal']!);
  if (envResult.source === 'canonical' || envResult.source === 'alias') {
    return { url: envResult.value!, source: 'env' };
  }

  // 2. Config file.
  try {
    const cfg = loadConfig();
    if (cfg.local.url) {
      return { url: cfg.local.url, source: 'config' };
    }
  } catch {
    // Config unreadable — fall through to default.
  }

  // 3. Hard-coded default.
  return { url: DEFAULT_LOCAL_URL, source: 'default' };
}
