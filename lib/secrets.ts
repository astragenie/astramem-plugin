/**
 * lib/secrets.ts — Bearer token reader from the unified config dir's secrets.env.
 *
 * TODO(Track-B): Replace this stub with the real implementation that reads from
 * `~/.config/astramem/secrets.env` (POSIX) or `%APPDATA%/Astramem/secrets.env` (Windows)
 * using `src/lib/datadir.ts#unifiedConfigDir()`.
 *
 * Current stub reads from MEMORY_BEARER env var as an interim fallback.
 * Track B's secrets reader will replace this on integration.
 */

/**
 * Read the local provider Bearer token.
 *
 * Resolution order (stub):
 *   1. MEMORY_BEARER env var (fallback for Track A until Track B lands)
 *
 * Track B will add:
 *   1. `<unifiedConfigDir()>/secrets.env` → MEMORY_BEARER= line
 *   2. MEMORY_BEARER env var fallback
 */
export async function readLocalBearer(): Promise<string | undefined> {
  // TODO(Track-B): parse <unifiedConfigDir()>/secrets.env for MEMORY_BEARER=<token>
  return process.env['MEMORY_BEARER'];
}
