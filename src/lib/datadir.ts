/**
 * datadir.ts — unified config dir resolution for astramem-plugin.
 *
 * Unified config dir (v0.4.0+):
 *   win32   → %APPDATA%\Astramem
 *   other   → ~/.config/astramem
 *
 * Legacy paths (for one-time migration):
 *   legacyConfigDir()    → ~/.config/astra-memory  (v0.4.1 XDG variant)
 *   legacyAstramemPath() → ~/.astramemory           (oldest variant)
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Returns the canonical config directory for astramem v0.4.0+.
 *   win32 → %APPDATA%\Astramem
 *   other → ~/.config/astramem
 */
export function unifiedConfigDir(): string {
  if (process.platform === 'win32') {
    const appdata = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
    return join(appdata, 'Astramem');
  }
  return join(homedir(), '.config', 'astramem');
}

/**
 * Legacy XDG config dir used by the v0.4.1 variant of astramem.
 * Only consulted during one-time migration — never written to.
 *   → ~/.config/astra-memory
 */
export function legacyConfigDir(): string {
  return join(homedir(), '.config', 'astra-memory');
}

/**
 * Oldest legacy path (~/.astramemory).
 * Only consulted during one-time migration — never written to.
 */
export function legacyAstramemPath(): string {
  return join(homedir(), '.astramemory');
}
