/**
 * Tests for src/cli/recall.ts — astramem recall subcommand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runRecall } from '../../src/cli/recall.ts';
import { createMockProvider, createFailingProvider } from './mock-provider.ts';

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { stdout.push(String(c)); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { stderr.push(String(c)); return true; });
  return {
    stdout,
    stderr,
    restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); },
    json: () => JSON.parse(stdout.join('')),
  };
}

describe('runRecall', () => {
  let cap: ReturnType<typeof captureOutput>;

  beforeEach(() => { cap = captureOutput(); });
  afterEach(() => { cap.restore(); });

  it('returns 0 and prints RecallResponse JSON on success', async () => {
    const provider = createMockProvider();
    const code = await runRecall(['--query', 'test query'], { _provider: provider });
    expect(code).toBe(0);
    const out = cap.json();
    expect(out).toHaveProperty('hits');
    expect(Array.isArray(out.hits)).toBe(true);
    expect(out.hits[0]).toMatchObject({ id: 'hit-1', type: 'fact', score: 0.9 });
  });

  it('passes --query --k --repo --project to provider.recall', async () => {
    const provider = createMockProvider();
    await runRecall(['--query', 'my q', '--k', '10', '--repo', 'my-repo', '--project', 'proj-x'], { _provider: provider });
    expect(provider._stubs.recall).toHaveBeenCalledWith({
      query: 'my q',
      k: 10,
      repo: 'my-repo',
      project: 'proj-x',
    });
  });

  it('defaults k=5 when --k not provided', async () => {
    const provider = createMockProvider();
    await runRecall(['--query', 'q'], { _provider: provider });
    expect(provider._stubs.recall.mock.calls[0]![0]).toMatchObject({ k: 5 });
  });

  it('returns 3 when --query is missing', async () => {
    const provider = createMockProvider();
    const code = await runRecall([], { _provider: provider });
    expect(code).toBe(3);
    expect(cap.stderr.join('')).toMatch(/--query.*required/i);
  });

  it('returns 3 when provider.recall throws', async () => {
    const provider = createFailingProvider('backend down');
    const code = await runRecall(['--query', 'x'], { _provider: provider });
    expect(code).toBe(3);
    expect(cap.stderr.join('')).toMatch(/backend error/i);
  });

  it('returns 3 when recall times out', async () => {
    vi.useFakeTimers();
    const provider = createMockProvider({
      recallResult: () => new Promise<never>(() => { /* hangs */ }),
    });
    const raceP = runRecall(['--query', 'q'], { _provider: provider });
    await vi.advanceTimersByTimeAsync(5100);
    const code = await raceP;
    expect(code).toBe(3);
    vi.useRealTimers();
  });

  it('returns valid JSON shape even with empty hits', async () => {
    const provider = createMockProvider({
      recallResult: { hits: [], total_searched: 0, provider: 'mock' },
    });
    const code = await runRecall(['--query', 'nothing'], { _provider: provider });
    expect(code).toBe(0);
    expect(cap.json()).toMatchObject({ hits: [], total_searched: 0 });
  });
});
