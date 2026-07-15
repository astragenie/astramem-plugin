/**
 * Shared parameterised contract suite for MemoryProvider implementations.
 *
 * Usage:
 *   import { runProviderContract } from './_contract.ts';
 *   runProviderContract('local', () => new LocalProvider('http://127.0.0.1:9999'));
 *
 * Each call installs a `describe` block. Consumers supply a makeProvider factory
 * that returns a fresh provider instance pointed at a mock server URL.
 * The caller is responsible for configuring and tearing down the mock fetch.
 */

import { describe, it, expect } from 'vitest';
import type { MemoryProvider } from '../../src/contracts/provider.ts';
import { RecallResponseSchema } from '../../src/contracts/wire.ts';
import { DeterministicError, TransientError } from '../../src/lib/errors.ts';

/** Minimal valid IngestPayload for contract tests. */
export const SAMPLE_INGEST = {
  id: 'contract-test-id',
  type: 'transcript',
  text: 'Hello from the contract test.',
} as const;

/** Minimal valid RecallRequest for contract tests. */
export const SAMPLE_RECALL = {
  query: 'contract test query',
  k: 3,
} as const;

/** Minimal valid astramem-retrieval-result@1 envelope served by the local
 * daemon mock (FEAT-532 — the daemon's POST /recall RESPONSE is target-state
 * canonical; live shape lands with slice L1). */
export const MOCK_RECALL_RESPONSE = {
  schema: 'astramem-retrieval-result@1',
  query: { text: 'contract test query', mode: 'hybrid' },
  hits: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'fact',
      text: 'relevant memory',
      score: 0.91,
      explanation: {
        final: 0.91,
        signals: { bm25: { raw: 0.91, weight: 1, final: 0.91 } },
      },
    },
  ],
  total: 100,
} as const;

/** astramem-retrieval-result@1 envelope served by the SaaS mock for
 * POST /memories/search — matches cloud's real response shape (SearchQuery.cs
 * SearchResponse, CONTRACT-FREEZE §1, already shipped). */
export const MOCK_SAAS_SEARCH_RESPONSE = {
  schema: 'astramem-retrieval-result@1',
  query: { text: 'contract test query', mode: 'hybrid' },
  hits: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      type: 'fact',
      text: 'relevant memory',
      score: 0.91,
      scope: 'private',
      explanation: {
        final: 0.91,
        signals: {
          vector: { raw: 0.88, weight: 0.5, final: 0.44 },
          keyword: { raw: 0.94, weight: 0.5, final: 0.47 },
        },
      },
      importance: 0.5,
      confidence: 0.5,
      created_at: '2026-07-04T00:00:00Z',
      metadata: null,
    },
  ],
  total: 100,
} as const;

/** Per-backend route/shape map so one contract suite can exercise providers
 * that speak different wire dialects (local daemon vs SaaS REST). */
export interface ProviderRoutes {
  recallPath: string;
  rememberPath: string;
  recallBody: string;
}

export const LOCAL_ROUTES: ProviderRoutes = {
  recallPath: '/recall',
  rememberPath: '/remember',
  recallBody: JSON.stringify(MOCK_RECALL_RESPONSE),
};

export const SAAS_ROUTES: ProviderRoutes = {
  recallPath: '/memories/search',
  rememberPath: '/memories',
  recallBody: JSON.stringify(MOCK_SAAS_SEARCH_RESPONSE),
};

/** Minimal valid HealthResponse body served by mock. */
export const MOCK_HEALTH_RESPONSE = {
  ok: true,
  version: '0.1.0',
} as const;

/**
 * Run the provider contract suite for a given named provider.
 *
 * @param name         Human-readable name used in describe labels.
 * @param makeProvider Factory that returns a MemoryProvider backed by a mock at baseUrl.
 *                     Called once per describe block — NOT per test. Tests share the provider.
 * @param opts.skipBearerTest  Set true if the provider doesn't support bearer introspection.
 */
export function runProviderContract(
  name: string,
  makeProvider: (baseUrl: string) => MemoryProvider,
  opts: {
    /** Override the mock response for /ingest/transcript (default: 200 OK {}). */
    ingestResponse?: { status: number; body: string };
    /** Override the mock response for the recall route (default: routes.recallBody). */
    recallResponse?: { status: number; body: string };
    /** Override the mock response for /health (default: MOCK_HEALTH_RESPONSE). */
    healthResponse?: { status: number; body: string };
    /** Backend wire dialect the provider under test speaks (default: LOCAL_ROUTES). */
    routes?: ProviderRoutes;
  } = {},
): void {
  const routes = opts.routes ?? LOCAL_ROUTES;
  describe(`ProviderContract: ${name}`, () => {

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];
    type FetchMockFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

    /** Build a mock fetch function that routes based on URL pathname. */
    function buildMockFetch(baseUrl: string, overrides: {
      ingest?: { status: number; body: string };
      recall?: { status: number; body: string };
      health?: { status: number; body: string };
    } = {}): FetchMockFn {
      return async (...[input]: FetchArgs): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const pathname = new URL(url).pathname;

        if (pathname === '/ingest/transcript') {
          const { status = 200, body = '{}' } = overrides.ingest ?? {};
          return new Response(body, {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (pathname === routes.recallPath) {
          const { status = 200, body = routes.recallBody } = overrides.recall ?? {};
          return new Response(body, {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (pathname === routes.rememberPath) {
          return new Response('{}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (pathname === '/health') {
          const { status = 200, body = JSON.stringify(MOCK_HEALTH_RESPONSE) } = overrides.health ?? {};
          return new Response(body, {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      };
    }

    const MOCK_BASE = 'http://127.0.0.1:19999';

    // ------------------------------------------------------------------
    // ingest — fire-and-forget
    // ------------------------------------------------------------------

    it('ingest: resolves without error within 3s on 200', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = buildMockFetch(MOCK_BASE) as typeof fetch;
      const provider = makeProvider(MOCK_BASE);
      try {
        const start = Date.now();
        await provider.ingest(SAMPLE_INGEST);
        expect(Date.now() - start).toBeLessThan(3000);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('ingest: does not throw on 4xx (fire-and-forget absorbs DeterministicError)', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = buildMockFetch(MOCK_BASE, {
        ingest: { status: 422, body: '{"error":"bad payload"}' },
      }) as typeof fetch;
      const provider = makeProvider(MOCK_BASE);
      try {
        // Must not throw — ingest is fire-and-forget.
        await expect(provider.ingest(SAMPLE_INGEST)).resolves.toBeUndefined();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('ingest: does not throw on 5xx (fire-and-forget absorbs TransientError after 1 retry)', async () => {
      const origFetch = globalThis.fetch;
      let callCount = 0;
      globalThis.fetch = (async (...[input]: FetchArgs) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (new URL(url).pathname === '/ingest/transcript') {
          callCount++;
          return new Response('{"error":"server error"}', {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      const provider = makeProvider(MOCK_BASE);
      try {
        await expect(provider.ingest(SAMPLE_INGEST)).resolves.toBeUndefined();
        // Must have retried once (total 2 attempts).
        expect(callCount).toBe(2);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    // ------------------------------------------------------------------
    // recall
    // ------------------------------------------------------------------

    it('recall: returns Zod-valid RecallResponse on 200', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = buildMockFetch(MOCK_BASE) as typeof fetch;
      const provider = makeProvider(MOCK_BASE);
      try {
        const result = await provider.recall(SAMPLE_RECALL);
        // Must parse cleanly with the shared schema.
        expect(() => RecallResponseSchema.parse(result)).not.toThrow();
        expect(Array.isArray(result.hits)).toBe(true);
        expect(result.hits.length).toBeGreaterThan(0);
        expect(result.hits[0]?.score).toBeGreaterThanOrEqual(0);
        expect(result.hits[0]?.score).toBeLessThanOrEqual(1);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('recall: throws DeterministicError on 4xx', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = buildMockFetch(MOCK_BASE, {
        recall: { status: 403, body: '{"error":"forbidden"}' },
      }) as typeof fetch;
      const provider = makeProvider(MOCK_BASE);
      try {
        await expect(provider.recall(SAMPLE_RECALL)).rejects.toBeInstanceOf(DeterministicError);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('recall: throws TransientError on 5xx', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = buildMockFetch(MOCK_BASE, {
        recall: { status: 500, body: '{"error":"internal"}' },
      }) as typeof fetch;
      const provider = makeProvider(MOCK_BASE);
      try {
        await expect(provider.recall(SAMPLE_RECALL)).rejects.toBeInstanceOf(TransientError);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    // ------------------------------------------------------------------
    // health
    // ------------------------------------------------------------------

    it('health: returns {ok:true, version, latencyMs} on 200', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = buildMockFetch(MOCK_BASE) as typeof fetch;
      const provider = makeProvider(MOCK_BASE);
      try {
        const result = await provider.health();
        expect(result.ok).toBe(true);
        expect(typeof result.version).toBe('string');
        expect(typeof result.latencyMs).toBe('number');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        expect(result.url).toBe(MOCK_BASE);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('health: throws DeterministicError on 4xx', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = buildMockFetch(MOCK_BASE, {
        health: { status: 401, body: '{"error":"unauthorized"}' },
      }) as typeof fetch;
      const provider = makeProvider(MOCK_BASE);
      try {
        await expect(provider.health()).rejects.toBeInstanceOf(DeterministicError);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('health: throws TransientError on 5xx', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = buildMockFetch(MOCK_BASE, {
        health: { status: 502, body: '{"error":"bad gateway"}' },
      }) as typeof fetch;
      const provider = makeProvider(MOCK_BASE);
      try {
        await expect(provider.health()).rejects.toBeInstanceOf(TransientError);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('health: throws TransientError on network error (fetch throws)', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch;
      const provider = makeProvider(MOCK_BASE);
      try {
        await expect(provider.health()).rejects.toBeInstanceOf(TransientError);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
}
