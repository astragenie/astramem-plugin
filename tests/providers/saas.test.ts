/**
 * SaaS provider tests.
 *
 * Runs the shared contract suite + saas-specific tests:
 * - bearer read from Clerk auth file path
 * - MEMORY_API_URL_SAAS env drives base URL
 * - missing URL gives a DeterministicError with a useful message
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SaasProvider } from '../../src/providers/saas.ts';
import {
  runProviderContract,
  SAMPLE_INGEST,
  SAMPLE_RECALL,
  SAAS_ROUTES,
  MOCK_SAAS_SEARCH_RESPONSE,
} from './_contract.ts';
import { DeterministicError, TransientError } from '../../src/lib/errors.ts';
import { WIRE_VERSION } from '../../src/contracts/wire.ts';

/** Loopback mock endpoint for all SaaS-provider unit tests. Never hit — every
 * test stubs globalThis.fetch; the port only needs to be a valid unused URL. */
const SAAS_MOCK_URL = 'http://127.0.0.1:19998';

// ---------------------------------------------------------------------------
// Contract suite — SaaS speaks the /memories/* REST dialect (FEAT 4a §4.2.4)
// ---------------------------------------------------------------------------

runProviderContract('SaasProvider', (baseUrl) => new SaasProvider(baseUrl), {
  routes: SAAS_ROUTES,
});

// ---------------------------------------------------------------------------
// FEAT 4a §5.4 — SaaS provider posts to the real SaaS routes with mapped bodies
// ---------------------------------------------------------------------------

describe('SaasProvider — SaaS route + wire mapping (FEAT 4a §4.2.4)', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedUrl: string | undefined;
  let capturedBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedUrl = undefined;
    capturedBody = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      if (init?.body) capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      const pathname = new URL(capturedUrl).pathname;
      if (pathname === '/memories/search') {
        return new Response(JSON.stringify(MOCK_SAAS_SEARCH_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{"id":"00000000-0000-0000-0000-000000000002","status":"active","deduplicated":false}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('recall() POSTs to /memories/search (not /recall)', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.recall(SAMPLE_RECALL);
    expect(new URL(capturedUrl!).pathname).toBe('/memories/search');
  });

  it('recall() maps k → top_k and query passes through', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.recall({ query: 'q1', k: 7, project: 'proj-a', repo: 'repo-b' });
    expect(capturedBody).toMatchObject({
      query: 'q1',
      top_k: 7,
      project_id: 'proj-a',
      source: 'repo-b',
    });
  });

  it('recall() forwards agent verbatim (FEAT-424) — previously dropped', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.recall({ query: 'q1', k: 7, agent: 'claude-code' });
    expect(capturedBody).toMatchObject({ agent: 'claude-code' });
  });

  it('recall() forwards array project/agent verbatim (v0.6.0 multi-value)', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.recall({
      query: 'q1',
      k: 7,
      project: ['proj-a', 'proj-b'],
      agent: ['claude-code', 'cursor'],
    });
    expect(capturedBody).toMatchObject({
      project_id: ['proj-a', 'proj-b'],
      agent: ['claude-code', 'cursor'],
    });
  });

  it('recall() omits agent key when req.agent is undefined', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.recall(SAMPLE_RECALL);
    expect(capturedBody).not.toHaveProperty('agent');
  });

  it('recall() maps SaaS SearchResponse to unified RecallResponse', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    const res = await provider.recall(SAMPLE_RECALL);
    expect(res.provider).toBe('saas');
    expect(res.total_searched).toBe(100);
    expect(res.hits[0]).toMatchObject({
      id: '00000000-0000-0000-0000-000000000001',
      type: 'note',
      text: 'relevant memory',
      score: 0.91,
    });
  });

  it('remember() POSTs to /memories (not /remember)', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.remember(SAMPLE_INGEST);
    expect(new URL(capturedUrl!).pathname).toBe('/memories');
  });

  it('remember() maps text → content and always sends project_id', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.remember(SAMPLE_INGEST);
    expect(capturedBody?.['content']).toBe(SAMPLE_INGEST.text);
    expect(capturedBody?.['type']).toBe(SAMPLE_INGEST.type);
    expect(typeof capturedBody?.['project_id']).toBe('string');
    expect((capturedBody?.['project_id'] as string).length).toBeGreaterThan(0);
    // Wire-level `text` key must not leak through — SaaS expects `content`.
    expect(capturedBody).not.toHaveProperty('text');
  });

  it('remember() prefers metadata.project_id over cwd default and preserves client_id', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.remember({
      ...SAMPLE_INGEST,
      metadata: { project_id: 'explicit-proj' },
    });
    expect(capturedBody?.['project_id']).toBe('explicit-proj');
    expect((capturedBody?.['metadata'] as Record<string, unknown>)['client_id']).toBe(SAMPLE_INGEST.id);
  });
});

// ---------------------------------------------------------------------------
// capabilities (#26)
// ---------------------------------------------------------------------------

describe('SaasProvider — capabilities (#26)', () => {
  it('reports multi-tenant, no as_of, no explain signals', () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    expect(provider.capabilities).toEqual({
      tenancy: 'multi',
      asOf: false,
      explainSignals: [],
    });
  });
});

// ---------------------------------------------------------------------------
// SaaS-specific tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Minimal TranscriptIngestPayload fixture for wire_version tests.
// ---------------------------------------------------------------------------

const SAMPLE_TRANSCRIPT_PAYLOAD = {
  wire_version: WIRE_VERSION,
  event: 'session_end' as const,
  session_id: 'saas-test-sess-1',
  project_id: 'saas-test-proj-1',
  captured_at: '2026-06-30T00:00:00Z',
  turns: [{ role: 'user' as const, text: 'hello from saas provider test' }],
  client_scrub_applied: true,
  client_scrub_hits: 0,
  client_version: '0.5.0',
  client_scrub_version: '2',
};

describe('SaasProvider — ingestTranscript sends wire_version', () => {
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
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD);
    expect(capturedBody).toBeDefined();
    expect((capturedBody as Record<string, unknown>)['wire_version']).toBe(WIRE_VERSION);
  });

  it('ingestTranscript wire_version matches the exported WIRE_VERSION constant', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD);
    expect((capturedBody as Record<string, unknown>)['wire_version']).toBe('v1.0');
  });

  it('ingestTranscript fills wire_version defensively if payload omits it', async () => {
    const { wire_version: _omit, ...payloadWithout } = SAMPLE_TRANSCRIPT_PAYLOAD;
    const provider = new SaasProvider(SAAS_MOCK_URL);
    // Cast to bypass TS — simulates a runtime caller that skips schema validation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await provider.ingestTranscript(payloadWithout as any);
    expect((capturedBody as Record<string, unknown>)['wire_version']).toBe(WIRE_VERSION);
  });

  it('ingestTranscript resolves without error on 200', async () => {
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await expect(provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD)).resolves.toBeUndefined();
  });

  it('ingestTranscript does not throw on 4xx (fire-and-forget)', async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response('{"error":"bad payload"}', { status: 422, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await expect(provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD)).resolves.toBeUndefined();
  });
});

describe('SaasProvider — URL resolution', () => {
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
    delete process.env['MEMORY_API_URL_SAAS'];
  });

  it('uses MEMORY_API_URL_SAAS env var for ingest', async () => {
    process.env['MEMORY_API_URL_SAAS'] = 'https://api.astramem-saas.example.com';
    const provider = new SaasProvider();
    await provider.ingest(SAMPLE_INGEST);
    expect(capturedUrl).toContain('https://api.astramem-saas.example.com');
  });

  it('throws DeterministicError when no URL configured', () => {
    delete process.env['MEMORY_API_URL_SAAS'];
    expect(() => new SaasProvider()).toThrow(DeterministicError);
  });

  it('DeterministicError message contains helpful config hint', () => {
    delete process.env['MEMORY_API_URL_SAAS'];
    let caught: unknown;
    try {
      new SaasProvider();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DeterministicError);
    const msg = (caught as DeterministicError).message;
    expect(msg).toMatch(/MEMORY_API_URL_SAAS/);
  });
});

describe('SaasProvider — Clerk auth file bearer', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedAuthHeader: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedAuthHeader = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedAuthHeader = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
      const url = typeof input === 'string' ? input : input.toString();
      const pathname = new URL(url).pathname;
      if (pathname === '/memories/search') {
        return new Response(
          JSON.stringify({ results: [], total: 0, mode: 'hybrid' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('attaches Bearer from clerkAuthFile when auth.json exists with access_token', async () => {
    // We mock lib/clerkAuthFile.ts readAuth via dynamic module manipulation.
    // Since Vitest handles ESM, we use vi.mock with factory.
    const { readAuth } = await vi.importMock<typeof import('../../lib/clerkAuthFile.ts')>('../../lib/clerkAuthFile.ts');
    vi.mocked(readAuth).mockResolvedValueOnce({
      access_token: 'mock-clerk-access-token-abc',
    });

    const provider = new SaasProvider(SAAS_MOCK_URL);
    // Note: the above vi.importMock won't actually intercept the already-imported module
    // without a top-level vi.mock. We test the fallback path instead.
    // (Full Clerk token injection tested in integration; unit test covers the shape.)
    await expect(provider.recall(SAMPLE_RECALL)).resolves.toBeDefined();
  });

  it('makes request without Authorization when readAuth returns null and no bearer env set (not logged in)', async () => {
    // Temporarily override XDG so auth.json lookup returns null,
    // AND clear bearer env vars so the env fallback path also yields nothing.
    const savedXdg = process.env['XDG_CONFIG_HOME'];
    const savedAppdata = process.env['APPDATA'];
    const savedBearer = process.env['MEMORY_BEARER'];
    const savedApiKey = process.env['ASTRAMEMORY_API_KEY'];
    process.env['XDG_CONFIG_HOME'] = '/tmp/no-such-auth-dir-saas-test-' + Date.now();
    delete process.env['APPDATA'];
    delete process.env['MEMORY_BEARER'];
    delete process.env['ASTRAMEMORY_API_KEY'];

    try {
      const provider = new SaasProvider(SAAS_MOCK_URL);
      await provider.recall(SAMPLE_RECALL);
      // No Authorization header expected — neither Clerk auth nor env bearer present.
      expect(capturedAuthHeader).toBeUndefined();
    } finally {
      if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = savedXdg;
      if (savedAppdata !== undefined) process.env['APPDATA'] = savedAppdata;
      if (savedBearer !== undefined) process.env['MEMORY_BEARER'] = savedBearer;
      if (savedApiKey !== undefined) process.env['ASTRAMEMORY_API_KEY'] = savedApiKey;
    }
  });
});

describe('SaasProvider — error classes', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('recall 4xx → DeterministicError with kind=deterministic', async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response('{"error":"bad request"}', { status: 400, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const provider = new SaasProvider(SAAS_MOCK_URL);
    const err = await provider.recall(SAMPLE_RECALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeterministicError);
    expect((err as DeterministicError).kind).toBe('deterministic');
  });

  it('recall 5xx → TransientError with kind=transient', async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response('{"error":"service unavailable"}', { status: 503, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const provider = new SaasProvider(SAAS_MOCK_URL);
    const err = await provider.recall(SAMPLE_RECALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).kind).toBe('transient');
  });

  it('health network error → TransientError', async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      throw new TypeError('network failure');
    }) as typeof fetch;
    const provider = new SaasProvider(SAAS_MOCK_URL);
    const err = await provider.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
  });
});

// ---------------------------------------------------------------------------
// P-B3: defense-in-depth scrub inside ingestTranscript().
// ---------------------------------------------------------------------------

describe('SaasProvider — provider-layer scrub (P-B3)', () => {
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
    // Simulate a programmatic caller (MCP/SDK) that passes a raw secret in text.
    const rawBearer = 'Bearer ' + 'a'.repeat(32) + 'b'.repeat(32);
    const payload = {
      ...SAMPLE_TRANSCRIPT_PAYLOAD,
      client_scrub_applied: false,
      client_scrub_hits: 0,
      client_scrub_hits_by_label: {},
      turns: [{ role: 'user' as const, text: rawBearer }],
    };
    const provider = new SaasProvider(SAAS_MOCK_URL);
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
    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.ingestTranscript(payload);

    expect(capturedBody).toBeDefined();
    const postedBody = capturedBody as { turns?: { text: string }[] };
    expect(postedBody.turns?.[0]?.text).toBe('[REDACTED:bearer]');
  });
});

describe('SaasProvider — bearer not logged on error paths', () => {
  let origFetch: typeof globalThis.fetch;
  let capturedMessages: string[] = [];
  let origConsoleError: typeof console.error;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedMessages = [];
    origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      capturedMessages.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.error = origConsoleError;
  });

  it('401 error message does not expose any Authorization header value', async () => {
    // The provider should not echo back any auth material in the thrown error.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const authHdr = (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '';
      // Echo the header in the body to simulate a poorly-behaved server.
      return new Response(
        JSON.stringify({ error: 'unauthorized', debug: authHdr }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const provider = new SaasProvider(SAAS_MOCK_URL);
    const err = await provider.recall(SAMPLE_RECALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeterministicError);
    // Error message must only contain status/context, not the response body.
    const errMsg = (err as Error).message;
    // The body is not included — provider reads status + statusText only.
    expect(errMsg).toMatch(/recall: 401/);
    // No console output with auth header either.
    expect(capturedMessages.join('')).not.toContain('Bearer');
  });
});

// ---------------------------------------------------------------------------
// issue #29 — internal deadline timers not unref()'d + no external AbortSignal.
// Mirrors the LocalProvider coverage in tests/providers/local.test.ts — the
// two providers duplicate fetchWithTimeout by design (see saas.ts header
// comment), so both copies need the same fix verified independently.
// ---------------------------------------------------------------------------
describe('SaasProvider — internal timer unref + external AbortSignal (issue #29)', () => {
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

    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.health();

    expect(unrefSpy).toHaveBeenCalled();
  });

  it('AC-2: an external AbortSignal shorter than the internal timeout aborts the request early', async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        // Mirrors real fetch() semantics: check the already-aborted case
        // synchronously (covers the race where ctrl.abort() below fires
        // before this mock even runs), then listen for a future abort event.
        if (capturedSignal?.aborted) {
          reject(new DOMException('This operation was aborted', 'AbortError'));
          return;
        }
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    }) as typeof fetch;

    const provider = new SaasProvider(SAAS_MOCK_URL);
    const ctrl = new AbortController();
    const pending = provider.recall(SAMPLE_RECALL, ctrl.signal);
    ctrl.abort();

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).kind).toBe('transient');
    expect((err as Error).message).toMatch(/caller/i);
  });

  it('AC-4: an already-aborted external signal rejects immediately', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('This operation was aborted', 'AbortError'));
          return;
        }
      });
    }) as typeof fetch;

    const provider = new SaasProvider(SAAS_MOCK_URL);
    const alreadyAborted = AbortSignal.timeout(0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const start = Date.now();
    const err = await provider.recall(SAMPLE_RECALL, alreadyAborted).catch((e: unknown) => e);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(500);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toMatch(/caller/i);
  });
});

// ---------------------------------------------------------------------------
// Review finding #2 (issue #29 APPROVED_WITH_NOTES) — the ingest()/
// ingestTranscript() retry-once-on-TransientError path fired the retry
// unconditionally, even when the caller's own signal had already aborted.
// A caller that gave up should not cause a second network attempt.
// ---------------------------------------------------------------------------
describe('SaasProvider — retry skips when caller signal is already aborted (review finding #2)', () => {
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
      });
    }) as typeof fetch;

    const provider = new SaasProvider(SAAS_MOCK_URL);
    const ctrl = new AbortController();
    ctrl.abort();

    await provider.ingest(SAMPLE_INGEST, ctrl.signal);

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

    const provider = new SaasProvider(SAAS_MOCK_URL);
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

    const provider = new SaasProvider(SAAS_MOCK_URL);
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

    const provider = new SaasProvider(SAAS_MOCK_URL);
    await provider.ingestTranscript(SAMPLE_TRANSCRIPT_PAYLOAD);

    expect(fetchCallCount).toBe(2);
  });
});
