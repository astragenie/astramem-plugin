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

  it('parses --metadata as JSON (project default still folds in — issue #33)', async () => {
    const provider = createMockProvider();
    await runRemember(
      ['--content', 'note', '--metadata', '{"priority":"high"}', '--cwd', '/home/user/projects/my-app'],
      { _provider: provider },
    );
    const arg = provider._stubs.remember.mock.calls[0]![0];
    expect(arg.metadata).toEqual({ priority: 'high', project: 'my-app' });
  });

  it('explicit --metadata project key wins over the resolveProject default (issue #33)', async () => {
    const provider = createMockProvider();
    await runRemember(
      ['--content', 'note', '--metadata', '{"project":"explicit-meta"}', '--cwd', '/home/user/projects/my-app'],
      { _provider: provider },
    );
    const arg = provider._stubs.remember.mock.calls[0]![0];
    expect((arg.metadata as Record<string, unknown>).project).toBe('explicit-meta');
  });

  it('defaults metadata.project via resolveProject() when --project is not given (issue #33)', async () => {
    const provider = createMockProvider();
    await runRemember(
      ['--content', 'note', '--cwd', '/home/user/projects/another-app'],
      { _provider: provider },
    );
    const arg = provider._stubs.remember.mock.calls[0]![0];
    expect((arg.metadata as Record<string, unknown>).project).toBe('another-app');
  });

  it('folds --project / --agent into metadata (FEAT-423)', async () => {
    const provider = createMockProvider();
    await runRemember(
      ['--content', 'reviewer flagged a null deref', '--type', 'lesson',
        '--project', 'runner-plugin', '--agent', 'crew:reviewer'],
      { _provider: provider },
    );
    const arg = provider._stubs.remember.mock.calls[0]![0];
    expect(arg.metadata).toMatchObject({ project: 'runner-plugin', agent: 'crew:reviewer' });
  });

  it('explicit --metadata keys win over --project / --agent convenience flags', async () => {
    const provider = createMockProvider();
    await runRemember(
      ['--content', 'x', '--metadata', '{"project":"explicit"}', '--project', 'flag-value'],
      { _provider: provider },
    );
    const arg = provider._stubs.remember.mock.calls[0]![0];
    expect((arg.metadata as Record<string, unknown>).project).toBe('explicit');
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
