/**
 * secrets.ts — read the local bearer token for astramem.
 *
 * Resolution order:
 *   1. Parse MEMORY_BEARER= line from unifiedConfigDir()/secrets.env
 *   2. process.env.MEMORY_BEARER
 *   3. null (caller treats as "no credential")
 *
 * The secrets.env file format: one KEY=value per line, # comments allowed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unifiedConfigDir } from './datadir.ts';
import { resolveEnv } from './env.ts';
import { ENV } from './env-specs.ts';

const SECRETS_FILENAME = 'secrets.env';

/**
 * Read the local bearer token.
 *
 * Returns the raw token string, or null if no token is configured.
 * Does NOT validate the token — callers must handle auth errors.
 */
export function readLocalBearer(): string | null {
  // 1. Try secrets.env file.
  try {
    const filePath = join(unifiedConfigDir(), SECRETS_FILENAME);
    const content = readFileSync(filePath, 'utf-8');
    const token = parseEnvValue(content, 'MEMORY_BEARER');
    if (token) return token;
  } catch {
    // File missing or unreadable — fall through.
  }

  // 2. Try process env (canonical MEMORY_BEARER, alias ASTRAMEMORY_API_KEY).
  const envToken = resolveEnv(ENV.bearerLocal).value;
  if (envToken && envToken.trim()) return envToken.trim();

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a KEY=VALUE line from a .env-style file content.
 * Lines starting with # are ignored. Values may be quoted.
 */
function parseEnvValue(content: string, key: string): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const k = line.slice(0, eqIdx).trim();
    if (k !== key) continue;
    let val = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    return val || null;
  }
  return null;
}
