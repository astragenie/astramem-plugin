/**
 * FEAT-543 — LIVE auth integration test for SaasProvider.
 *
 * Why this exists: the golden-fixture / mocked-fetch tests validate contract
 * SHAPES but never exercise real HTTP auth. The API-key auth bug (sending an
 * `sk-` key as `Bearer` → 401) only surfaces against a real cloud host that
 * actually routes `ApiKey` vs `Bearer` through different code paths. One live
 * call beats a wall of green mocked tests (memory: synthetic-fixtures-lie).
 *
 * Gated: runs ONLY when both LIVE_CLOUD_URL and LIVE_CLOUD_APIKEY are set,
 * otherwise skipped — so normal CI (no cloud) stays green. To run:
 *
 *   # bring up a real cloud host + seed a tenant/key, e.g. the memory repo's
 *   #   scripts/web-clipper/run-live-caption-e2e.sh seed pattern, then:
 *   LIVE_CLOUD_URL=http://127.0.0.1:55080 \
 *   LIVE_CLOUD_APIKEY=sk-... \
 *     npx vitest run tests/providers/saas-live-auth.test.ts
 *
 * Verified green 2026-07-15 against a real `dotnet run` host on :55080 with a
 * seeded sk- key (recall → 200; provider maps the canonical retrieval-result@1
 * envelope down to RecallResponse).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SaasProvider } from '../../src/providers/saas.ts';

const LIVE_URL = process.env['LIVE_CLOUD_URL'];
const LIVE_APIKEY = process.env['LIVE_CLOUD_APIKEY'];
const LIVE = Boolean(LIVE_URL && LIVE_APIKEY);

describe.skipIf(!LIVE)('SaasProvider — live API-key auth (FEAT-543)', () => {
  // Save/restore credential env so the case under test is the ONLY credential
  // in scope — a leaked MEMORY_BEARER (canonical) would otherwise shadow the
  // ASTRAMEMORY_API_KEY alias and defeat the point of the test.
  const saved: Record<string, string | undefined> = {};
  const CRED_ENV = ['XDG_CONFIG_HOME', 'APPDATA', 'MEMORY_BEARER', 'ASTRAMEMORY_API_KEY'];

  beforeEach(() => {
    for (const k of CRED_ENV) saved[k] = process.env[k];
    process.env['XDG_CONFIG_HOME'] = '/tmp/no-such-auth-dir-feat543-live-' + Date.now();
    delete process.env['APPDATA'];
    delete process.env['MEMORY_BEARER'];
  });

  afterEach(() => {
    for (const k of CRED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('recall() authenticates with only ASTRAMEMORY_API_KEY (sk-) set → 200, not 401', async () => {
    delete process.env['MEMORY_BEARER'];
    process.env['ASTRAMEMORY_API_KEY'] = LIVE_APIKEY;
    const provider = new SaasProvider(LIVE_URL);
    // A 401 would throw DeterministicError; reaching a parsed RecallResponse
    // proves the ApiKey scheme was selected and accepted by the live cloud.
    const res = await provider.recall({ query: 'feat-543 live auth probe', k: 3 });
    expect(res.provider).toBe('saas');
    expect(Array.isArray(res.hits)).toBe(true);
    expect(typeof res.total_searched).toBe('number');
  });

  it('sending the same key as MEMORY_BEARER=sk-… also authenticates — scheme keys on shape', async () => {
    delete process.env['ASTRAMEMORY_API_KEY'];
    process.env['MEMORY_BEARER'] = LIVE_APIKEY;
    const provider = new SaasProvider(LIVE_URL);
    const res = await provider.recall({ query: 'feat-543 live auth probe 2', k: 3 });
    expect(res.provider).toBe('saas');
  });
});
