/**
 * Local provider tests.
 *
 * Runs the shared contract suite + local-specific tests:
 * - bearer is read from MEMORY_BEARER env var (Track B stub)
 * - missing bearer still makes requests (unauthenticated) without crashing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock datadir so readLocalBearer cannot fall into a real secrets.env on the
// host machine — keeps the "no bearer" test deterministic.
const _tmpConfigDir: string = mkdtempSync(join(tmpdir(), 'astramem-local-provider-test-'));
vi.mock('../../src/lib/datadir.ts', () => ({
  unifiedConfigDir: () => _tmpConfigDir,
  legacyConfigDir: () => join(_tmpConfigDir, 'legacy-xdg'),
  legacyAstramemPath: () => join(_tmpConfigDir, 'legacy-astramem'),
}));

import { LocalProvider } from '../../src/providers/local.ts';
import { runProviderContract, SAMPLE_INGEST, SAMPLE_RECALL } from './_contract.ts';
import { DeterministicError, TransientError } from '../../src/lib/errors.ts';
import { WIRE_VERSION } from '../../src/contracts/wire.ts';

// Captured once at module load, before any test mutates globalThis.setTimeout
// (e.g. via vi.useFakeTimers()/vi.useRealTimers() or manual spy wrapping) —
// used by tests below that need a real timer tick independent of any other
// test's timer mocking state.
const REAL_SET_TIMEOUT = globalThis.setTimeout;

// ---------------------------------------------------------------------------
// Contract suite — all shared contract checks run for LocalProvider
// ---------------------------------------------------------------------------

runProviderContract('LocalProvider', (baseUrl) => new LocalProvider(baseUrl));

// ---------------------------------------------------------------------------
// Local-specific tests
// ---------------------------------------------------------------------------

describe('LocalProvider — capabilities (#26)', () => {
  it('reports single-tenant, no as_of, no explain signals', () => {
    const provider = new LocalProvider('http://127.0.0.1:19999');
    expect(provider.capabilities).toEqual({
      tenancy: 'single',
      asOf: false,
      explainSignals: [],
    });
  });
});

describe('LocalProvider — bearer from MEMORY_BEARER env', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedAuthHeader: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedAuthHeader = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedAuthHeader = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
      const url = typeof input === 'string' ? input : input.toString();
      const pathname = new URL(url).pathname;
      if (pathname === '/recall') {
        return new Response(
          JSON.stringify({ hits: [], total_searched: 0, provider: 'local' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env['MEMORY_BEARER'];
  });

  it('attaches Bearer header when MEMORY_BEARER is set', async () => {
    process.env['MEMORY_BEARER'] = 'test-local-bearer-token-abc123';
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.recall(SAMPLE_RECALL);
    expect(capturedAuthHeader).toBe('Bearer test-local-bearer-token-abc123');
  });

  it('makes request without Authorization header when MEMORY_BEARER is absent', async () => {
    delete process.env['MEMORY_BEARER'];
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.recall(SAMPLE_RECALL);
    // No Authorization header — not undefined check since absent key is also undefined.
    expect(capturedAuthHeader).toBeUndefined();
  });

  it('missing bearer does not throw — request proceeds unauthenticated', async () => {
    delete process.env['MEMORY_BEARER'];
    const provider = new LocalProvider('http://127.0.0.1:19999');
    // Should not throw — just makes an unauthenticated request.
    await expect(provider.recall(SAMPLE_RECALL)).resolves.toBeDefined();
  });
});

describe('LocalProvider — recall body shape (FEAT-423)', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedBody = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (new URL(url).pathname === '/recall' && init?.body) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({ hits: [], total_searched: 0, provider: 'local' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = origFetch; });

  it('nests repo/project/agent under a `filters` object — not flat (issue #56 no-op fix)', async () => {
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.recall({ query: 'q', k: 5, repo: 'r1', project: 'runner-plugin', agent: 'crew:reviewer' });
    expect(capturedBody).toEqual({
      query: 'q',
      k: 5,
      filters: { repo: 'r1', project: 'runner-plugin', agent: 'crew:reviewer' },
    });
    // Guard against regression: scoping must NOT appear at the top level.
    expect(capturedBody).not.toHaveProperty('project');
    expect(capturedBody).not.toHaveProperty('agent');
  });

  it('omits `filters` entirely for an unscoped recall (byte-identical to legacy body)', async () => {
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.recall({ query: 'q', k: 5 });
    expect(capturedBody).toEqual({ query: 'q', k: 5 });
    expect(capturedBody).not.toHaveProperty('filters');
  });

  it('forwards array project/agent (OR filter) verbatim inside filters', async () => {
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.recall({ query: 'q', k: 5, project: ['a', 'b'], agent: ['x', 'y'] });
    expect(capturedBody).toMatchObject({ filters: { project: ['a', 'b'], agent: ['x', 'y'] } });
  });
});

describe('LocalProvider — default URL resolution', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedUrl: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedUrl = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env['MEMORY_API_URL_LOCAL'];
  });

  it('defaults to http://127.0.0.1:7777 when no URL given and env absent', async () => {
    delete process.env['MEMORY_API_URL_LOCAL'];
    const provider = new LocalProvider();
    await provider.ingest(SAMPLE_INGEST);
    expect(capturedUrl).toContain('http://127.0.0.1:7777');
  });

  it('uses MEMORY_API_URL_LOCAL env var when set', async () => {
    process.env['MEMORY_API_URL_LOCAL'] = 'http://127.0.0.1:8888';
    const provider = new LocalProvider();
    await provider.ingest(SAMPLE_INGEST);
    expect(capturedUrl).toContain('http://127.0.0.1:8888');
  });
});

describe('LocalProvider — error classes and kind fields', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('recall 4xx carries kind=deterministic and status code', async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const provider = new LocalProvider('http://127.0.0.1:19999');
    const err = await provider.recall(SAMPLE_RECALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeterministicError);
    expect((err as DeterministicError).kind).toBe('deterministic');
    expect((err as DeterministicError).status).toBe(404);
  });

  it('recall 5xx carries kind=transient and status code', async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response('{"error":"gateway error"}', { status: 502, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const provider = new LocalProvider('http://127.0.0.1:19999');
    const err = await provider.recall(SAMPLE_RECALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).kind).toBe('transient');
    expect((err as TransientError).status).toBe(502);
  });

  it('health network error carries kind=transient', async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const provider = new LocalProvider('http://127.0.0.1:19999');
    const err = await provider.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).kind).toBe('transient');
  });
});

// ---------------------------------------------------------------------------
// Minimal TranscriptIngestPayload fixture for wire_version tests.
// Must satisfy TranscriptIngestPayloadSchema (all required fields present).
// ---------------------------------------------------------------------------

const SAMPLE_TRANSCRIPT_PAYLOAD = {
  wire_version: WIRE_VERSION,
  event: 'session_end' as const,
  session_id: 'local-test-sess-1',
  project_id: 'local-test-proj-1',
  captured_at: '2026-06-30T00:00:00Z',
  turns: [{ role: 'user' as const, text: 'hello from local provider test' }],
  client_scrub_applied: true,
  client_scrub_hits: 0,
  client_version: '0.5.0',
  client_scrub_version: '2',
};

describe('LocalProvider — ingestTranscript sends wire_version', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedBody: unknown;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedBody = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.body) {
        try {
          capturedBody = JSON.parse(init.body as string);
        } catch {
          capturedBody = init.body;
        }
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    capturedBody = undefined;
  });

  it('ingestTranscript POSTs body that includes wire_version: "v1.0"', async () => {
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD);
    expect(capturedBody).toBeDefined();
    expect((capturedBody as Record<string, unknown>)['wire_version']).toBe(WIRE_VERSION);
  });

  it('ingestTranscript wire_version matches the exported WIRE_VERSION constant', async () => {
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD);
    expect((capturedBody as Record<string, unknown>)['wire_version']).toBe('v1.0');
  });
});

// ---------------------------------------------------------------------------
// P-B3: defense-in-depth scrub inside ingestTranscript().
// ---------------------------------------------------------------------------

describe('LocalProvider — provider-layer scrub (P-B3)', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedBody = undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.body) {
        try { capturedBody = JSON.parse(init.body as string) as Record<string, unknown>; }
        catch { /* ignore */ }
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    capturedBody = undefined;
  });

  it('(a) raw bearer in turn text is redacted by provider when payload has not been scrubbed', async () => {
    // Simulate a programmatic caller that sets client_scrub_applied=false + raw secret in text.
    const rawBearer = 'Bearer ' + 'a'.repeat(32) + 'b'.repeat(32);
    const payload = {
      ...SAMPLE_TRANSCRIPT_PAYLOAD,
      client_scrub_applied: false,
      client_scrub_hits: 0,
      client_scrub_hits_by_label: {},
      turns: [{ role: 'user' as const, text: rawBearer }],
    };
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingestTranscript(payload);

    expect(capturedBody).toBeDefined();
    const postedBody = capturedBody as { turns?: { text: string }[]; client_scrub_hits?: number };
    expect(postedBody.turns?.[0]?.text).not.toContain('a'.repeat(32) + 'b'.repeat(32));
    expect(postedBody.turns?.[0]?.text).toBe('[REDACTED:bearer]');
    expect(postedBody.client_scrub_hits).toBeGreaterThan(0);
  });

  it('(b) already-scrubbed payload passes through unchanged — scrubWithLabels is idempotent', async () => {
    // Text already contains the redaction marker — second pass is a no-op.
    const payload = {
      ...SAMPLE_TRANSCRIPT_PAYLOAD,
      turns: [{ role: 'user' as const, text: '[REDACTED:bearer]' }],
      client_scrub_applied: true,
      client_scrub_hits: 1,
      client_scrub_hits_by_label: { bearer: 1 },
    };
    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingestTranscript(payload);

    expect(capturedBody).toBeDefined();
    const postedBody = capturedBody as { turns?: { text: string }[] };
    expect(postedBody.turns?.[0]?.text).toBe('[REDACTED:bearer]');
  });
});

describe('LocalProvider — bearer not logged on error paths', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedMessages: string[] = [];
  let origConsoleError: typeof console.error;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedMessages = [];
    origConsoleError = console.error;
    // Intercept console.error to verify bearer is not leaked.
    console.error = (...args: unknown[]) => {
      capturedMessages.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.error = origConsoleError;
    delete process.env['MEMORY_BEARER'];
  });

  it('does not log bearer token in error message on 401', async () => {
    const sensitiveBearer = 'super-secret-local-bearer-xyz987';
    process.env['MEMORY_BEARER'] = sensitiveBearer;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response('{"error":"unauthorized"}', { status: 401, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const provider = new LocalProvider('http://127.0.0.1:19999');
    const err = await provider.recall(SAMPLE_RECALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeterministicError);
    // The error message must NOT contain the bearer.
    const errMsg = (err as Error).message;
    expect(errMsg).not.toContain(sensitiveBearer);
    // Console output must NOT contain the bearer.
    const allOutput = capturedMessages.join('\n');
    expect(allOutput).not.toContain(sensitiveBearer);
  });
});

// ---------------------------------------------------------------------------
// issue #29 — internal deadline timers not unref()'d + no external AbortSignal.
// A reachable-but-slow backend meant a caller's own shorter wallclock cap
// (e.g. Promise.race) fired, but the abandoned fetch + its ref'd internal
// timer kept the event loop alive up to the remaining internal window —
// hanging one-shot CLI processes that set process.exitCode instead of
// calling process.exit().
// ---------------------------------------------------------------------------
describe('LocalProvider — internal timer unref + external AbortSignal (issue #29)', () => {
  let origFetch: typeof globalThis.fetch;
  let origSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    origSetTimeout = globalThis.setTimeout;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    globalThis.setTimeout = origSetTimeout;
    vi.useRealTimers();
  });

  it('AC-1: unref()s the internal deadline timer so it cannot keep the event loop alive on its own', async () => {
    const unrefSpy = vi.fn();
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = origSetTimeout(fn, ms, ...args);
      const originalUnref = (timer as unknown as { unref?: () => unknown }).unref?.bind(timer);
      (timer as unknown as { unref: () => unknown }).unref = () => {
        unrefSpy();
        return originalUnref?.();
      };
      return timer;
    }) as typeof setTimeout;

    globalThis.fetch = (async (): Promise<Response> =>
      new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;

    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.health();

    expect(unrefSpy).toHaveBeenCalled();
  });

  it('AC-2: an external AbortSignal shorter than the 5s internal timeout aborts the request early, not at 5s', async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        // Simulate a reachable-but-slow backend: never resolves on its own —
        // only settles when the (combined) signal aborts. Mirrors real fetch()
        // semantics: check the already-aborted case synchronously (covers the
        // race where ctrl.abort() below fires before this mock even runs),
        // then fall back to listening for a future abort event.
        if (capturedSignal?.aborted) {
          reject(new DOMException('This operation was aborted', 'AbortError'));
          return;
        }
        capturedSignal?.addEventListener('abort', () => {
          const err = new DOMException('This operation was aborted', 'AbortError');
          reject(err);
        });
      });
    }) as typeof fetch;

    const provider = new LocalProvider('http://127.0.0.1:19999');
    const ctrl = new AbortController();
    const pending = provider.recall(SAMPLE_RECALL, ctrl.signal);
    // Caller's own short cap fires — well before the provider's internal 5s deadline.
    ctrl.abort();

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).kind).toBe('transient');
    expect((err as Error).message).toMatch(/caller/i);
  });

  it(
    'AC-3: with no external signal, the internal timeout still throws TransientError on an unreachable/slow daemon (finally still clears the timer)',
    async () => {
      // Deliberately uses real timers rather than vi.useFakeTimers() — this
      // vitest/environment combination has been observed to leave
      // globalThis.setTimeout broken for later tests after
      // useFakeTimers()/useRealTimers() cycles here, which is a test-harness
      // hazard unrelated to the behavior under test. A real ~3s wait is slow
      // but reliable and keeps global timer state untouched for other tests.
      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        });
      }) as typeof fetch;

      const provider = new LocalProvider('http://127.0.0.1:19999');
      // health()'s internal fetchWithTimeout deadline is 3000ms.
      const err = await provider.health().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TransientError);
      expect((err as TransientError).kind).toBe('transient');
      expect((err as Error).message).toMatch(/timed out/i);
    },
    10_000,
  );

  it('AC-4: an already-aborted external signal rejects immediately — not after any part of the internal window', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('This operation was aborted', 'AbortError'));
          return;
        }
        // Otherwise never resolves — proves we didn't fall through to a real wait.
      });
    }) as typeof fetch;

    const provider = new LocalProvider('http://127.0.0.1:19999');
    const alreadyAborted = AbortSignal.timeout(0);
    // Give AbortSignal.timeout(0) a tick to actually fire. Uses the real
    // setTimeout captured at module load — independent of any other test's
    // timer mocking (fake timers / spy wrapping) in this describe block.
    await new Promise((resolve) => REAL_SET_TIMEOUT(resolve, 10));

    const start = Date.now();
    const err = await provider.recall(SAMPLE_RECALL, alreadyAborted).catch((e: unknown) => e);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(500);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).kind).toBe('transient');
    expect((err as Error).message).toMatch(/caller/i);
  });
});

// ---------------------------------------------------------------------------
// Review finding #2 (issue #29 APPROVED_WITH_NOTES) — the ingest()/
// ingestTranscript() retry-once-on-TransientError path fired the retry
// unconditionally, even when the caller's own signal had already aborted.
// A caller that gave up should not cause a second network attempt.
// ---------------------------------------------------------------------------
describe('LocalProvider — retry skips when caller signal is already aborted (review finding #2)', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('ingest(): does not retry when signal is already aborted before the first attempt', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchCallCount++;
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('This operation was aborted', 'AbortError'));
          return;
        }
        // Otherwise never resolves — not reached once the signal is already
        // aborted at call time, which is the case in this test.
      });
    }) as typeof fetch;

    const provider = new LocalProvider('http://127.0.0.1:19999');
    const ctrl = new AbortController();
    ctrl.abort();

    await provider.ingest(SAMPLE_INGEST, ctrl.signal);

    // Exactly one fetch attempt — the caller-abort short-circuit must skip
    // the retry (fire-and-forget: resolves without throwing either way).
    expect(fetchCallCount).toBe(1);
  });

  it('ingest(): retries exactly once as before when signal is undefined and a 5xx occurs (no regression)', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCallCount++;
      return new Response('{"error":"server error"}', {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingest(SAMPLE_INGEST);

    expect(fetchCallCount).toBe(2);
  });

  it('ingestTranscript(): does not retry when signal is already aborted before the first attempt', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchCallCount++;
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('This operation was aborted', 'AbortError'));
          return;
        }
      });
    }) as typeof fetch;

    const provider = new LocalProvider('http://127.0.0.1:19999');
    const ctrl = new AbortController();
    ctrl.abort();

    await provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD, ctrl.signal);

    expect(fetchCallCount).toBe(1);
  });

  it('ingestTranscript(): retries exactly once as before when signal is undefined and a 5xx occurs (no regression)', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCallCount++;
      return new Response('{"error":"server error"}', {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD);

    expect(fetchCallCount).toBe(2);
  });

  it('ingest(): does not retry when signal aborts between the first attempt failing and the retry decision', async () => {
    let fetchCallCount = 0;
    const ctrl = new AbortController();
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCallCount++;
      // Caller gives up right as the first (non-aborted) attempt's response
      // comes back as a transient failure — before the retry would fire.
      ctrl.abort();
      return new Response('{"error":"server error"}', {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const provider = new LocalProvider('http://127.0.0.1:19999');
    await provider.ingest(SAMPLE_INGEST, ctrl.signal);

    expect(fetchCallCount).toBe(1);
  });
});
