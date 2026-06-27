/**
 * Local provider tests.
 *
 * Runs the shared contract suite + local-specific tests:
 * - bearer is read from MEMORY_BEARER env var (Track B stub)
 * - missing bearer still makes requests (unauthenticated) without crashing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalProvider } from '../../src/providers/local.ts';
import { runProviderContract, SAMPLE_INGEST, SAMPLE_RECALL } from './_contract.ts';
import { DeterministicError, TransientError } from '../../src/lib/errors.ts';

// ---------------------------------------------------------------------------
// Contract suite — all shared contract checks run for LocalProvider
// ---------------------------------------------------------------------------

runProviderContract('LocalProvider', (baseUrl) => new LocalProvider(baseUrl));

// ---------------------------------------------------------------------------
// Local-specific tests
// ---------------------------------------------------------------------------

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
