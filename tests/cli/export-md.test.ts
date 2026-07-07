/**
 * Tests for src/cli/export-md.ts — astramem export-md subcommand (issue #34).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runExportMd } from '../../src/cli/export-md.ts';
import { createMockProvider } from './mock-provider.ts';
import type { RecallResponse } from '../../src/contracts/wire.ts';

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { stdout.push(String(c)); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { stderr.push(String(c)); return true; });
  return {
    stdout,
    stderr,
    restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); },
  };
}

const MIXED_HITS: RecallResponse = {
  hits: [
    { id: 'dec-1', type: 'decision', text: 'Use Bun for the CLI runtime.', score: 0.95 },
    { id: 'dec-2', type: 'decision', text: 'Route all default-project resolution through resolveProject().', score: 0.80 },
    { id: 'les-1', type: 'lesson', text: 'service start before service install yields an opaque schtasks error.', score: 0.90 },
    { id: 'fact-1', type: 'fact', text: 'The daemon listens on 127.0.0.1:4173.', score: 0.99 },
  ],
  total_searched: 4,
  provider: 'mock',
};

describe('runExportMd', () => {
  let cap: ReturnType<typeof captureOutput>;
  let tmpDir: string;

  beforeEach(() => {
    cap = captureOutput();
    tmpDir = mkdtempSync(join(tmpdir(), 'astramem-export-md-'));
  });
  afterEach(() => {
    cap.restore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders expected markdown for mocked recall hits, restricted to default types', async () => {
    const provider = createMockProvider({ recallResult: MIXED_HITS });
    const outPath = join(tmpDir, 'MEMORY.md');
    const code = await runExportMd(['--project', 'proj-x', '--out', outPath], { _provider: provider });
    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);

    const content = readFileSync(outPath, 'utf-8');
    expect(content).toMatch(/^# MEMORY\.md/);
    expect(content).toMatch(/## decision/);
    expect(content).toMatch(/## lesson/);
    expect(content).toMatch(/dec-1/);
    expect(content).toMatch(/dec-2/);
    expect(content).toMatch(/les-1/);

    // Default types = decision,lesson — the 'fact' hit must not appear.
    expect(content).not.toMatch(/## fact/);
    expect(content).not.toMatch(/fact-1/);
    expect(content).not.toMatch(/daemon listens on/);

    // Header notes present.
    expect(content).toMatch(/do not hand-edit/);
    expect(content).toMatch(/`\/remember`/);
    expect(content).toMatch(/re-scrubbed for secrets/);
    expect(content).toMatch(/Project: `proj-x`/);
    expect(content).toMatch(/Types: `decision`, `lesson`/);
  });

  it('honors --types to select a different set of memory types', async () => {
    const provider = createMockProvider({ recallResult: MIXED_HITS });
    const outPath = join(tmpDir, 'MEMORY.md');
    const code = await runExportMd(
      ['--project', 'proj-x', '--out', outPath, '--types', 'fact'],
      { _provider: provider },
    );
    expect(code).toBe(0);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).toMatch(/## fact/);
    expect(content).toMatch(/fact-1/);
    expect(content).not.toMatch(/## decision/);
  });

  it('write-if-different: does not rewrite the file when content is unchanged', async () => {
    const provider1 = createMockProvider({ recallResult: MIXED_HITS });
    const outPath = join(tmpDir, 'MEMORY.md');
    const code1 = await runExportMd(['--project', 'proj-x', '--out', outPath], { _provider: provider1 });
    expect(code1).toBe(0);
    const mtimeAfterFirst = statSync(outPath).mtimeMs;

    // Second run with identical inputs — file content is byte-identical, so
    // the file must not be touched (no git churn).
    const provider2 = createMockProvider({ recallResult: MIXED_HITS });
    const code2 = await runExportMd(['--project', 'proj-x', '--out', outPath], { _provider: provider2 });
    expect(code2).toBe(0);
    const mtimeAfterSecond = statSync(outPath).mtimeMs;

    expect(mtimeAfterSecond).toBe(mtimeAfterFirst);
    expect(cap.stdout.join('')).toMatch(/unchanged/);
  });

  it('re-scrubs a high-entropy secret in atom text before writing (defense-in-depth for a git sink)', async () => {
    const secretHits: RecallResponse = {
      hits: [
        {
          id: 'dec-secret',
          type: 'decision',
          // Simulates a secret that slipped past ingest-time scrubbing (e.g. a
          // scrubber-version gap) — export-time re-scrub must still catch it.
          text: 'Rotated key: sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
          score: 0.9,
        },
      ],
      total_searched: 1,
      provider: 'mock',
    };
    const provider = createMockProvider({ recallResult: secretHits });
    const outPath = join(tmpDir, 'MEMORY.md');
    const code = await runExportMd(['--project', 'proj-x', '--out', outPath], { _provider: provider });
    expect(code).toBe(0);

    const content = readFileSync(outPath, 'utf-8');
    expect(content).not.toMatch(/sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ/);
    expect(content).toMatch(/\[REDACTED:anthropic-key\]/);
  });

  it('defaults --project via resolveProject({ cwd }) when --project is not passed', async () => {
    const provider = createMockProvider({ recallResult: MIXED_HITS });
    const cwd = join(tmpDir, 'my-resolved-project');
    mkdirSync(cwd, { recursive: true });
    const outPath = join(tmpDir, 'out', 'MEMORY.md');

    const code = await runExportMd(['--cwd', cwd, '--out', outPath], { _provider: provider });
    expect(code).toBe(0);

    const recallArg = provider._stubs.recall.mock.calls[0]![0];
    expect(recallArg.project).toBe('my-resolved-project');

    const content = readFileSync(outPath, 'utf-8');
    expect(content).toMatch(/Project: `my-resolved-project`/);
  });

  it('creates the output directory if it does not exist', async () => {
    const provider = createMockProvider({ recallResult: MIXED_HITS });
    const outPath = join(tmpDir, 'nested', 'dir', 'MEMORY.md');
    const code = await runExportMd(['--project', 'proj-x', '--out', outPath], { _provider: provider });
    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
  });

  it('renders a placeholder for a requested type with no recalled hits', async () => {
    const provider = createMockProvider({ recallResult: { hits: [], total_searched: 0, provider: 'mock' } });
    const outPath = join(tmpDir, 'MEMORY.md');
    const code = await runExportMd(['--project', 'proj-x', '--out', outPath], { _provider: provider });
    expect(code).toBe(0);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).toMatch(/## decision/);
    expect(content).toMatch(/_\(no memories recalled\)_/);
  });

  it('returns 3 when provider.recall throws', async () => {
    const provider = createMockProvider({ recallResult: () => Promise.reject(new Error('backend down')) });
    const outPath = join(tmpDir, 'MEMORY.md');
    const code = await runExportMd(['--project', 'proj-x', '--out', outPath], { _provider: provider });
    expect(code).toBe(3);
    expect(cap.stderr.join('')).toMatch(/backend error/i);
    expect(existsSync(outPath)).toBe(false);
  });
});
