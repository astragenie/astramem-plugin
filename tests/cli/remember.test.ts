/**
 * Tests for src/cli/remember.ts — astramem remember subcommand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runRemember } from '../../src/cli/remember.ts';
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
  };
}

describe('runRemember', () => {
  let cap: ReturnType<typeof captureOutput>;

  beforeEach(() => { cap = captureOutput(); });
  afterEach(() => { cap.restore(); });

  it('returns 0 and prints "ok" on success', async () => {
    const provider = createMockProvider();
    const code = await runRemember(['--content', 'Decision: use Bun'], { _provider: provider });
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toMatch(/^ok/);
  });

  it('calls provider.remember with correct payload shape', async () => {
    const provider = createMockProvider();
    await runRemember(['--content', 'test content', '--type', 'decision'], { _provider: provider });
    expect(provider._stubs.remember).toHaveBeenCalledOnce();
    const arg = provider._stubs.remember.mock.calls[0]![0];
    expect(arg).toMatchObject({ type: 'decision', text: 'test content' });
    expect(arg.id).toMatch(/^remember-/);
  });

  it('defaults type to "fact" when --type not given', async () => {
    const provider = createMockProvider();
    await runRemember(['--content', 'some fact'], { _provider: provider });
    const arg = provider._stubs.remember.mock.calls[0]![0];
    expect(arg.type).toBe('fact');
  });

  it('parses --metadata as JSON', async () => {
    const provider = createMockProvider();
    await runRemember(
      ['--content', 'note', '--metadata', '{"priority":"high"}'],
      { _provider: provider },
    );
    const arg = provider._stubs.remember.mock.calls[0]![0];
    expect(arg.metadata).toEqual({ priority: 'high' });
  });

  it('returns 3 when --metadata is invalid JSON', async () => {
    const provider = createMockProvider();
    const code = await runRemember(['--content', 'note', '--metadata', '{bad}'], { _provider: provider });
    expect(code).toBe(3);
    expect(cap.stderr.join('')).toMatch(/metadata.*JSON/i);
  });

  it('returns 3 when --content is missing', async () => {
    const provider = createMockProvider();
    const code = await runRemember([], { _provider: provider });
    expect(code).toBe(3);
    expect(cap.stderr.join('')).toMatch(/--content.*required/i);
  });

  it('returns 3 when provider.remember throws', async () => {
    const provider = createFailingProvider('saas down');
    const code = await runRemember(['--content', 'test'], { _provider: provider });
    expect(code).toBe(3);
    expect(cap.stderr.join('')).toMatch(/backend error/i);
  });
});
