import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Override unifiedConfigDir to point at a temp directory.
let tempDir: string;

vi.mock('../../src/lib/datadir.ts', () => ({
  unifiedConfigDir: () => tempDir,
  legacyConfigDir: () => join(tempDir, 'legacy-xdg'),
  legacyAstramemPath: () => join(tempDir, 'legacy-astramem'),
}));

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'astramem-log-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('appendIngestLog', () => {
  it('creates the log file and appends a JSON line', async () => {
    const { appendIngestLog } = await import('../../src/lib/log.ts');
    appendIngestLog({ event: 'test', value: 42 });

    const logFile = join(tempDir, 'ingest.log');
    expect(existsSync(logFile)).toBe(true);

    const content = readFileSync(logFile, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed).toMatchObject({ event: 'test', value: 42 });
  });

  it('appends multiple lines sequentially', async () => {
    const { appendIngestLog } = await import('../../src/lib/log.ts');
    appendIngestLog({ n: 1 });
    appendIngestLog({ n: 2 });
    appendIngestLog({ n: 3 });

    const logFile = join(tempDir, 'ingest.log');
    const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ n: 1 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ n: 2 });
    expect(JSON.parse(lines[2]!)).toMatchObject({ n: 3 });
  });

  it('scrubs bearer tokens before writing', async () => {
    const { appendIngestLog } = await import('../../src/lib/log.ts');
    const token = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
    appendIngestLog({ auth: `Bearer ${token}`, event: 'ingest' });

    const logFile = join(tempDir, 'ingest.log');
    const content = readFileSync(logFile, 'utf-8');
    expect(content).not.toContain(token);
    expect(content).toContain('[REDACTED');
  });

  it('rotates at 10MB threshold: existing log becomes .1 and new log starts', async () => {
    const { appendIngestLog } = await import('../../src/lib/log.ts');
    const logFile = join(tempDir, 'ingest.log');
    const rotatedFile = join(tempDir, 'ingest.log.1');

    // Write a 10MB + 1 byte file manually to simulate a large log.
    const bigContent = 'x'.repeat(10 * 1024 * 1024 + 1);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(logFile, bigContent);

    // The next append should trigger rotation.
    appendIngestLog({ event: 'trigger-rotation' });

    // The old content should be in .1.
    expect(existsSync(rotatedFile)).toBe(true);
    const rotatedContent = readFileSync(rotatedFile, 'utf-8');
    expect(rotatedContent).toBe(bigContent);

    // The new log should be small (just the new entry).
    const newContent = readFileSync(logFile, 'utf-8');
    const parsed = JSON.parse(newContent.trim());
    expect(parsed).toMatchObject({ event: 'trigger-rotation' });
    expect(statSync(logFile).size).toBeLessThan(1024);
  });

  it('overwrites previous .1 on repeated rotation', async () => {
    const { appendIngestLog } = await import('../../src/lib/log.ts');
    const logFile = join(tempDir, 'ingest.log');
    const rotatedFile = join(tempDir, 'ingest.log.1');

    // First rotation: write big file → rotate → .1 has "first"
    writeFileSync(logFile, 'first' + 'x'.repeat(10 * 1024 * 1024));
    appendIngestLog({ pass: 1 });
    expect(readFileSync(rotatedFile, 'utf-8').startsWith('first')).toBe(true);

    // Second rotation: make new log big again → rotate → .1 should now have "second" content
    writeFileSync(logFile, 'second' + 'x'.repeat(10 * 1024 * 1024));
    appendIngestLog({ pass: 2 });
    expect(readFileSync(rotatedFile, 'utf-8').startsWith('second')).toBe(true);
  });

  it('is fail-silent when directory cannot be created', async () => {
    // Point tempDir at an invalid path (file, not dir) — mkdirSync will fail.
    const { appendIngestLog } = await import('../../src/lib/log.ts');
    // Temporarily set tempDir to a file path
    const filePath = join(tempDir, 'i-am-a-file');
    writeFileSync(filePath, 'x');
    const originalDir = tempDir;
    tempDir = filePath; // datadir mock returns this file, mkdirSync will fail
    expect(() => appendIngestLog({ x: 1 })).not.toThrow();
    tempDir = originalDir; // restore
  });
});
