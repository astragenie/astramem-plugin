/**
 * Tests for src/cli/health.ts — astramem health subcommand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHealth } from '../../src/cli/health.ts';
import { createMockProvider } from './mock-provider.ts';

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { stdout.push(String(c)); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { stderr.push(String(c)); return true; });
  return {
    stdout,
    stderr,
    restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); },
    json: (): Record<string, unknown> => JSON.parse(stdout.join('')),
  };
}

describe('runHealth', () => {
  let cap: ReturnType<typeof captureOutput>;

  beforeEach(() => { cap = captureOutput(); });
  afterEach(() => { cap.restore(); });

  it('returns 0 and prints valid health JSON when provider is ok', async () => {
    const provider = createMockProvider();
    const code = await runHealth([], {
      _provider: provider,
      _providerName: 'local',
    });
    expect(code).toBe(0);
    const out = cap.json();
    expect(out.ok).toBe(true);
    expect(out.provider).toBe('local');
    expect(out.version).toBe('0.1.0-mock');
    expect(out.url).toBe('http://mock.provider');
    expect(typeof out.latencyMs).toBe('number');
  });

  it('returns 3 and prints ok=false when provider reports unhealthy', async () => {
    const provider = createMockProvider({
      healthResult: { ok: false, version: '0.1.0', url: 'http://x', latencyMs: 99 },
    });
    const code = await runHealth([], { _provider: provider, _providerName: 'saas' });
    expect(code).toBe(3);
    const out = cap.json();
    expect(out.ok).toBe(false);
    expect(out.provider).toBe('saas');
  });

  it('returns 3 and prints error when provider.health throws', async () => {
    const provider = createMockProvider({
      healthResult: () => Promise.reject(new Error('connection refused')),
    });
    const code = await runHealth([], { _provider: provider, _providerName: 'local' });
    expect(code).toBe(3);
    const out = cap.json();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/connection refused/);
  });

  it('returns 3 when health probe times out', async () => {
    vi.useFakeTimers();
    try {
      const provider = createMockProvider({
        healthResult: () => new Promise<never>(() => { /* hangs */ }),
      });
      const raceP = runHealth([], { _provider: provider, _providerName: 'local' });
      // Flush microtasks until runHealth has registered its timeout timer,
      // then advance past the 5s deadline. Sync advanceTimersByTime — bun's
      // vitest-compat `vi` shim has no advanceTimersByTimeAsync (the async
      // variant this used before threw "is not a function" under `bun test`).
      while (vi.getTimerCount() === 0) {
        await Promise.resolve();
      }
      vi.advanceTimersByTime(5100);
      const code = await raceP;
      expect(code).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('output has all required fields', async () => {
    const provider = createMockProvider();
    await runHealth([], { _provider: provider, _providerName: 'local' });
    const out = cap.json();
    expect(out).toHaveProperty('ok');
    expect(out).toHaveProperty('provider');
    expect(out).toHaveProperty('version');
    expect(out).toHaveProperty('url');
    expect(out).toHaveProperty('latencyMs');
  });

  it('prints help text for --help flag', async () => {
    const provider = createMockProvider();
    const code = await runHealth(['--help'], { _provider: provider });
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toMatch(/Usage.*astramem health/i);
  });
});
