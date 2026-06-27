/**
 * config.ts — read/write ~/.config/astramem/config.json (or %APPDATA%\Astramem\config.json).
 *
 * Features:
 *  - Zod-validated against AstramemConfigSchema from src/contracts/config.ts
 *  - One-time migration from legacy paths if the unified path is absent:
 *      1. legacyConfigDir()/config.json  (v0.4.1 XDG variant)
 *      2. legacyAstramemPath()/config.json (oldest ~/.astramemory variant)
 *  - Dot-path get/set/unset: `local.url`, `saas.bearer`, `logging.level`, etc.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { unifiedConfigDir, legacyConfigDir, legacyAstramemPath } from './datadir.ts';
import { AstramemConfigSchema, type AstramemConfig } from '../contracts/config.ts';

const CONFIG_FILENAME = 'config.json';

function configPath(): string {
  return join(unifiedConfigDir(), CONFIG_FILENAME);
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * If no unified config exists, look for a legacy config and copy it once.
 * The legacy file is left untouched (copy, not move).
 */
function migrateIfNeeded(): void {
  const target = configPath();
  if (existsSync(target)) return;

  const candidates = [
    join(legacyConfigDir(), CONFIG_FILENAME),
    join(legacyAstramemPath(), CONFIG_FILENAME),
  ];

  for (const src of candidates) {
    if (existsSync(src)) {
      mkdirSync(unifiedConfigDir(), { recursive: true });
      copyFileSync(src, target);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Load and validate the config from disk.
 * If the file is absent, returns the schema default.
 * If the file is present but invalid, throws a ZodError.
 */
export function loadConfig(): AstramemConfig {
  migrateIfNeeded();

  const file = configPath();
  if (!existsSync(file)) {
    return AstramemConfigSchema.parse({});
  }

  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  return AstramemConfigSchema.parse(raw);
}

/**
 * Persist the config to disk after Zod validation.
 * Creates the directory if it doesn't exist.
 */
export function saveConfig(cfg: AstramemConfig): void {
  // Validate before saving.
  const validated = AstramemConfigSchema.parse(cfg);
  mkdirSync(unifiedConfigDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(validated, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Dot-path accessors
// ---------------------------------------------------------------------------

/**
 * Get a value from the config by dot-path (e.g. `local.url`, `saas.bearer`).
 * Returns undefined if the path doesn't exist.
 */
export function getValue(dotPath: string): unknown {
  const cfg = loadConfig();
  return getNestedValue(cfg as Record<string, unknown>, dotPath.split('.'));
}

/**
 * Set a value in the config by dot-path, then persist.
 * Creates intermediate objects as needed.
 */
export function setValue(dotPath: string, value: unknown): void {
  const cfg = loadConfig() as Record<string, unknown>;
  setNestedValue(cfg, dotPath.split('.'), value);
  // Re-validate after mutation.
  saveConfig(AstramemConfigSchema.parse(cfg));
}

/**
 * Unset (delete) a value at the given dot-path, then persist.
 */
export function unsetValue(dotPath: string): void {
  const cfg = loadConfig() as Record<string, unknown>;
  deleteNestedValue(cfg, dotPath.split('.'));
  saveConfig(AstramemConfigSchema.parse(cfg));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, keys: string[]): unknown {
  let cursor: unknown = obj;
  for (const key of keys) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function setNestedValue(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  const last = keys[keys.length - 1]!;
  let cursor: Record<string, unknown> = obj;
  for (const key of keys.slice(0, -1)) {
    if (typeof cursor[key] !== 'object' || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[last] = value;
}

function deleteNestedValue(obj: Record<string, unknown>, keys: string[]): void {
  const last = keys[keys.length - 1]!;
  let cursor: Record<string, unknown> = obj;
  for (const key of keys.slice(0, -1)) {
    if (typeof cursor[key] !== 'object' || cursor[key] === null) return;
    cursor = cursor[key] as Record<string, unknown>;
  }
  delete cursor[last];
}
