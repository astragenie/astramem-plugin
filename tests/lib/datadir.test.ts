import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  unifiedConfigDir,
  legacyConfigDir,
  legacyAstramemPath,
} from '../../src/lib/datadir.ts';

/**
 * datadir tests — verify per-OS path correctness.
 *
 * Platform branching is exercised via the helper functions that accept
 * explicit platform + env overrides, avoiding the fragility of mocking
 * process.platform across ESM module caches.
 */

/** Re-implements the resolution logic so we can test it cross-platform. */
function resolveUnified(platform: NodeJS.Platform, appdata?: string): string {
  if (platform === 'win32') {
    const base = appdata || join(homedir(), 'AppData', 'Roaming');
    return join(base, 'Astramem');
  }
  return join(homedir(), '.config', 'astramem');
}

describe('datadir', () => {
  describe('resolveUnified (logic unit)', () => {
    it('win32 with APPDATA set', () => {
      const result = resolveUnified('win32', 'C:\Users\test\AppData\Roaming');
      expect(result).toBe(join('C:\Users\test\AppData\Roaming', 'Astramem'));
    });

    it('win32 without APPDATA falls back to homedir AppData/Roaming', () => {
      const result = resolveUnified('win32', '');
      expect(result).toMatch(/Astramem$/);
      expect(result).toContain('AppData');
    });

    it('linux returns ~/.config/astramem', () => {
      const result = resolveUnified('linux');
      expect(result).toBe(join(homedir(), '.config', 'astramem'));
    });

    it('darwin returns ~/.config/astramem', () => {
      const result = resolveUnified('darwin');
      expect(result).toBe(join(homedir(), '.config', 'astramem'));
    });
  });

  describe('actual exports (current platform)', () => {
    it('unifiedConfigDir() returns a non-empty string ending in Astramem or astramem', () => {
      const dir = unifiedConfigDir();
      expect(dir).toBeTruthy();
      // Windows → 'Astramem', POSIX → 'astramem'
      expect(dir).toMatch(/[Aa]stramem$/);
    });

    it('legacyConfigDir returns ~/.config/astra-memory', () => {
      expect(legacyConfigDir()).toBe(join(homedir(), '.config', 'astra-memory'));
    });

    it('legacyAstramemPath returns ~/.astramemory', () => {
      expect(legacyAstramemPath()).toBe(join(homedir(), '.astramemory'));
    });
  });
});
