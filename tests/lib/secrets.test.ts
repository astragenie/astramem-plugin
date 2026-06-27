import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../../src/lib/datadir.ts', () => ({
  unifiedConfigDir: () => tempDir,
  legacyConfigDir: () => join(tempDir, 'legacy-xdg'),
  legacyAstramemPath: () => join(tempDir, 'legacy-astramem'),
}));

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'astramem-secrets-test-'));
  vi.unstubAllEnvs();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('readLocalBearer', () => {
  it('reads MEMORY_BEARER from secrets.env file', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'secrets.env'), 'MEMORY_BEARER=tok_from_file\n');
    const { readLocalBearer } = await import('../../src/lib/secrets.ts');
    expect(readLocalBearer()).toBe('tok_from_file');
  });

  it('ignores comment lines in secrets.env', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'secrets.env'),
      '# this is a comment\nMEMORY_BEARER=real_token\n# another comment\n',
    );
    const { readLocalBearer } = await import('../../src/lib/secrets.ts');
    expect(readLocalBearer()).toBe('real_token');
  });

  it('handles quoted values in secrets.env', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'secrets.env'), 'MEMORY_BEARER="quoted_token"\n');
    const { readLocalBearer } = await import('../../src/lib/secrets.ts');
    expect(readLocalBearer()).toBe('quoted_token');
  });

  it('falls back to MEMORY_BEARER env var when secrets.env is absent', async () => {
    vi.stubEnv('MEMORY_BEARER', 'env_token');
    const { readLocalBearer } = await import('../../src/lib/secrets.ts');
    expect(readLocalBearer()).toBe('env_token');
  });

  it('file takes precedence over env var when both present', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'secrets.env'), 'MEMORY_BEARER=file_wins\n');
    vi.stubEnv('MEMORY_BEARER', 'env_loses');
    const { readLocalBearer } = await import('../../src/lib/secrets.ts');
    expect(readLocalBearer()).toBe('file_wins');
  });

  it('returns null when neither file nor env var is present', async () => {
    vi.stubEnv('MEMORY_BEARER', '');
    const { readLocalBearer } = await import('../../src/lib/secrets.ts');
    expect(readLocalBearer()).toBeNull();
  });

  it('returns null when secrets.env has no MEMORY_BEARER line and env is absent', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'secrets.env'), 'OTHER_VAR=xyz\nFOO=bar\n');
    vi.stubEnv('MEMORY_BEARER', '');
    const { readLocalBearer } = await import('../../src/lib/secrets.ts');
    expect(readLocalBearer()).toBeNull();
  });

  it('handles CRLF line endings in secrets.env', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'secrets.env'), 'MEMORY_BEARER=crlf_token\r\n');
    const { readLocalBearer } = await import('../../src/lib/secrets.ts');
    expect(readLocalBearer()).toBe('crlf_token');
  });
});
