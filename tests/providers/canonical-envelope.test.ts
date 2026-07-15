/**
 * FEAT-532 — canonical astramem-retrieval-result@1 adoption.
 *
 * Contract-level tests: the provider recall() pipeline (build canonical
 * request → parse canonical response → map to unified RecallResponse) must
 * accept the SAME golden fixtures the contracts package ships and validates
 * its own generated Zod schema against — not just our own hand-rolled mocks.
 *
 * SaaS: cloud already speaks this envelope live (SearchQuery.cs), so these
 * fixtures double as a regression guard against real cloud response shapes
 * (6-signal fusion, the full 15-field optional hit, embedding_error).
 *
 * Local: the daemon's POST /recall RESPONSE side is target-state only until
 * FEAT-532 slice L1 lands (see src/providers/local.ts header) — this test
 * proves the parser is ready for that shape today; full live daemon smoke is
 * deferred to the L1 integration.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SaasProvider } from '../../src/providers/saas.ts';
import { LocalProvider } from '../../src/providers/local.ts';
import { RetrievalResultV1Schema } from '@astragenie/astramem-contracts/zod';

import cloudFullOptionalHit from '@astragenie/astramem-contracts/fixtures/valid/retrieval-result-v1-cloud-full-optional-hit.json';
import cloudSixSignals from '@astragenie/astramem-contracts/fixtures/valid/retrieval-result-v1-cloud-six-signals.json';
import localSignals from '@astragenie/astramem-contracts/fixtures/valid/retrieval-result-v1-single-hit-local-signals.json';
import emptyHits from '@astragenie/astramem-contracts/fixtures/valid/retrieval-result-v1-empty-hits.json';

const MOCK_URL = 'http://127.0.0.1:19997';

describe('astramem-retrieval-result@1 — package golden fixtures parse via RetrievalResultV1Schema', () => {
  it.each([
    ['cloud full-optional-hit (15-field, embedding_error set)', cloudFullOptionalHit],
    ['cloud six-signal fusion', cloudSixSignals],
    ['local four-signal (bm25/cosine/importance/freshness)', localSignals],
    ['empty hits', emptyHits],
  ])('%s', (_label, fixture) => {
    expect(() => RetrievalResultV1Schema.parse(fixture)).not.toThrow();
  });
});

describe('SaasProvider.recall() — maps real cloud-shaped fixtures end-to-end', () => {
  let origFetch: typeof globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('maps the six-signal fixture to a unified RecallHit', async () => {
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(cloudSixSignals), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const provider = new SaasProvider(MOCK_URL);
    const res = await provider.recall({ query: 'why did we adopt PostgreSQL', k: 5 });
    expect(res.provider).toBe('saas');
    expect(res.hits[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'decision',
      score: 0.91,
    });
  });

  it('maps the full-optional-hit fixture (source/importance/confidence all present) without dropping fields', async () => {
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(cloudFullOptionalHit), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const provider = new SaasProvider(MOCK_URL);
    const res = await provider.recall({ query: 'why did we adopt PostgreSQL', k: 5 });
    expect(res.hits[0]).toMatchObject({
      source: 'hook_close',
      importance: 0.63,
      confidence: 0.8,
    });
  });
});

describe('LocalProvider.recall() — parser accepts the target-state local-signal fixture (FEAT-532 L1 not landed yet)', () => {
  let origFetch: typeof globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('maps the local four-signal fixture to a unified RecallHit', async () => {
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(localSignals), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const provider = new LocalProvider(MOCK_URL);
    const res = await provider.recall({ query: 'sqlite-vec windows binary', k: 5 });
    expect(res.provider).toBe('local');
    expect(res.hits[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000002',
      type: 'fact',
      score: 0.82,
    });
  });
});
