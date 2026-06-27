/**
 * Tests for src/cli/ingest.ts — astramem ingest subcommand.
 *
 * Strategy: inject mock providers via opts._provider so the selector is bypassed.
 * appendIngestLog writes to unifiedConfigDir() — we redirect via APPDATA env override.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runIngest } from '../../src/cli/ingest.ts';
import { createMockProvider, createFailingProvider } from './mock-provider.ts';

// Capture stdout / stderr for assertions
function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return {
    stdout,
    stderr,
    restore: () => { stdoutSpy.mockRestore(); stderrSpy.mockRestore(); },
  };
}

const VALID_PAYLOAD = JSON.stringify({
  id: 'session-abc',
  type: 'transcript',
  text: 'Hello world memory',
});

describe('runIngest', () => {
  let cap: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    cap = captureOutput();
  });

  afterEach(() => {
    cap.restore();
  });

  it('returns 0 and calls provider.ingest with valid payload', async () => {
    const provider = createMockProvider();
    const code = await runIngest(['--json', VALID_PAYLOAD], { _provider: provider });
    expect(code).toBe(0);
    expect(provider._stubs.ingest).toHaveBeenCalledOnce();
    const callArg = provider._stubs.ingest.mock.calls[0]![0];
    expect(callArg).toMatchObject({ id: 'session-abc', type: 'transcript', text: 'Hello world memory' });
  });

  it('returns 0 even when no --json argument given (fire-and-forget)', async () => {
    const provider = createMockProvider();
    const code = await runIngest([], { _provider: provider });
    expect(code).toBe(0);
    expect(provider._stubs.ingest).not.toHaveBeenCalled();
    expect(cap.stderr.join('')).toMatch(/--json.*required/);
  });

  it('returns 0 when --json is invalid JSON', async () => {
    const provider = createMockProvider();
    const code = await runIngest(['--json', '{not valid json}'], { _provider: provider });
    expect(code).toBe(0);
    expect(provider._stubs.ingest).not.toHaveBeenCalled();
    expect(cap.stderr.join('')).toMatch(/invalid JSON/i);
  });

  it('returns 0 when payload fails Zod schema validation', async () => {
    const provider = createMockProvider();
    // Missing required 'type' and 'text' fields
    const code = await runIngest(['--json', '{"id":"x"}'], { _provider: provider });
    expect(code).toBe(0);
    expect(provider._stubs.ingest).not.toHaveBeenCalled();
    expect(cap.stderr.join('')).toMatch(/schema validation failed/i);
  });

  it('returns 0 even when provider.ingest throws (fire-and-forget)', async () => {
    const provider = createFailingProvider('network error');
    const code = await runIngest(['--json', VALID_PAYLOAD], { _provider: provider });
    expect(code).toBe(0);
    // ingest was called — it just failed silently
    expect(provider._stubs.ingest).toHaveBeenCalledOnce();
  });

  it('returns 0 when provider.ingest hangs past 2s timeout', async () => {
    vi.useFakeTimers();
    const provider = createMockProvider({
      ingestResult: () => new Promise<void>(() => { /* never resolves */ }),
    });
    const raceP = runIngest(['--json', VALID_PAYLOAD], { _provider: provider });
    // Advance timers by 2.1s to trigger the race timeout
    await vi.advanceTimersByTimeAsync(2100);
    const code = await raceP;
    expect(code).toBe(0);
    vi.useRealTimers();
  });

  it('passes optional metadata fields through', async () => {
    const payloadWithOptionals = JSON.stringify({
      id: 'sess-1',
      type: 'note',
      text: 'Important note',
      source: 'my-repo',
      importance: 0.8,
      confidence: 0.9,
      metadata: { tags: ['work'] },
    });
    const provider = createMockProvider();
    const code = await runIngest(['--json', payloadWithOptionals], { _provider: provider });
    expect(code).toBe(0);
    const arg = provider._stubs.ingest.mock.calls[0]![0];
    expect(arg).toMatchObject({ source: 'my-repo', importance: 0.8 });
  });
});
