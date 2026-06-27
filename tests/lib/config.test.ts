import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
let legacyXdgDir: string;
let legacyOldDir: string;

vi.mock('../../src/lib/datadir.ts', () => ({
  unifiedConfigDir: () => tempDir,
  legacyConfigDir: () => legacyXdgDir,
  legacyAstramemPath: () => legacyOldDir,
}));

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'astramem-config-test-'));
  tempDir = join(base, 'unified');
  legacyXdgDir = join(base, 'legacy-xdg');
  legacyOldDir = join(base, 'legacy-old');
  vi.resetModules();
});

afterEach(() => {
  const base = tempDir.replace(/[\/]unified$/, '');
  rmSync(base, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns schema defaults when no config file exists', async () => {
    const { loadConfig } = await import('../../src/lib/config.ts');
    const cfg = loadConfig();
    expect(cfg.provider).toBe('auto');
    expect(cfg.logging.level).toBe('info');
    expect(cfg.local).toEqual({});
    expect(cfg.saas).toEqual({});
  });

  it('rejects invalid config with ZodError', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ provider: 'invalid-provider' }),
    );
    const { loadConfig } = await import('../../src/lib/config.ts');
    expect(() => loadConfig()).toThrow();
  });

  it('loads valid config from disk', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ provider: 'local', local: { url: 'http://127.0.0.1:7777' } }),
    );
    const { loadConfig } = await import('../../src/lib/config.ts');
    const cfg = loadConfig();
    expect(cfg.provider).toBe('local');
    expect(cfg.local.url).toBe('http://127.0.0.1:7777');
  });
});

describe('saveConfig', () => {
  it('writes validated config to disk', async () => {
    const { loadConfig, saveConfig } = await import('../../src/lib/config.ts');
    const cfg = loadConfig();
    cfg.provider = 'saas';
    saveConfig(cfg);
    vi.resetModules();
    const { loadConfig: reload } = await import('../../src/lib/config.ts');
    expect(reload().provider).toBe('saas');
  });
});

describe('getValue / setValue / unsetValue', () => {
  it('getValue returns undefined for missing path', async () => {
    const { getValue } = await import('../../src/lib/config.ts');
    expect(getValue('local.url')).toBeUndefined();
  });

  it('setValue + getValue roundtrip for local.url', async () => {
    const { setValue, getValue } = await import('../../src/lib/config.ts');
    setValue('local.url', 'http://localhost:9999');
    expect(getValue('local.url')).toBe('http://localhost:9999');
  });

  it('setValue + getValue roundtrip for logging.level', async () => {
    const { setValue, getValue } = await import('../../src/lib/config.ts');
    setValue('logging.level', 'debug');
    expect(getValue('logging.level')).toBe('debug');
  });

  it('unsetValue removes the field', async () => {
    const { setValue, getValue, unsetValue } = await import('../../src/lib/config.ts');
    setValue('local.url', 'http://localhost:1234');
    unsetValue('local.url');
    expect(getValue('local.url')).toBeUndefined();
  });

  it('setValue persists across module reloads', async () => {
    const { setValue } = await import('../../src/lib/config.ts');
    setValue('local.url', 'http://persist-check:7777');
    vi.resetModules();
    const { getValue } = await import('../../src/lib/config.ts');
    expect(getValue('local.url')).toBe('http://persist-check:7777');
  });
});

describe('migration', () => {
  it('copies from legacyConfigDir if unified config is absent', async () => {
    mkdirSync(legacyXdgDir, { recursive: true });
    writeFileSync(
      join(legacyXdgDir, 'config.json'),
      JSON.stringify({ provider: 'saas', local: {}, saas: {}, logging: { level: 'warn' } }),
    );
    const { loadConfig } = await import('../../src/lib/config.ts');
    const cfg = loadConfig();
    expect(cfg.provider).toBe('saas');
    expect(cfg.logging.level).toBe('warn');
  });

  it('copies from legacyAstramemPath if legacyConfigDir is also absent', async () => {
    mkdirSync(legacyOldDir, { recursive: true });
    writeFileSync(
      join(legacyOldDir, 'config.json'),
      JSON.stringify({ provider: 'local', local: { url: 'http://127.0.0.1:7777' }, saas: {}, logging: { level: 'info' } }),
    );
    const { loadConfig } = await import('../../src/lib/config.ts');
    const cfg = loadConfig();
    expect(cfg.provider).toBe('local');
    expect(cfg.local.url).toBe('http://127.0.0.1:7777');
  });

  it('does not migrate when unified config already exists', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ provider: 'auto', local: {}, saas: {}, logging: { level: 'error' } }),
    );
    // Also place a legacy file with different content
    mkdirSync(legacyXdgDir, { recursive: true });
    writeFileSync(
      join(legacyXdgDir, 'config.json'),
      JSON.stringify({ provider: 'saas', local: {}, saas: {}, logging: { level: 'silent' } }),
    );
    const { loadConfig } = await import('../../src/lib/config.ts');
    // Should load from unified, ignoring legacy
    const cfg = loadConfig();
    expect(cfg.provider).toBe('auto');
    expect(cfg.logging.level).toBe('error');
  });
});
