import { describe, it, expect, afterEach } from 'vitest';
import {
  probeWireCompat,
  checkWireCompat,
  WireIncompatibilityError,
  PLUGIN_WIRE_DOMAINS_SUPPORTED,
} from '../../src/lib/wire-probe.ts';

const BASE_URL = 'http://127.0.0.1:19998';

let origFetch: typeof globalThis.fetch;

function mockFetchJson(status: number, body: unknown): void {
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

function mockFetchReject(err: Error): void {
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw err;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('PLUGIN_WIRE_DOMAINS_SUPPORTED', () => {
  it('declares atom@1, retrieval@1, capture@1 (not sync — plugin has no sync bridge)', () => {
    expect(PLUGIN_WIRE_DOMAINS_SUPPORTED).toEqual(['atom@1', 'retrieval@1', 'capture@1']);
  });
});

describe('probeWireCompat — status classification', () => {
  it('compatible: backend advertises all plugin domains at matching generation', async () => {
    mockFetchJson(200, {
      name: 'astramem-cloud',
      version: '1.2.3',
      wire_versions_supported: ['atom@1', 'retrieval@1', 'sync@1', 'capture@1'],
      schema_version: '1',
    });
    const result = await probeWireCompat('saas', BASE_URL);
    expect(result.status).toBe('compatible');
    expect(result.providerName).toBe('saas');
    expect(result.baseUrl).toBe(BASE_URL);
  });

  it('compatible: extra unrelated domains in the list do not matter', async () => {
    mockFetchJson(200, {
      wire_versions_supported: ['atom@1', 'retrieval@1', 'capture@1', 'somethingElse@7'],
    });
    const result = await probeWireCompat('local', BASE_URL);
    expect(result.status).toBe('compatible');
  });

  it('incompatible: a plugin domain is missing entirely from an otherwise domain-scheme list', async () => {
    mockFetchJson(200, {
      wire_versions_supported: ['atom@1', 'sync@1'], // retrieval + capture missing
      schema_version: '1',
    });
    const result = await probeWireCompat('saas', BASE_URL);
    expect(result.status).toBe('incompatible');
    expect(result.missingDomains).toEqual(expect.arrayContaining(['retrieval@1', 'capture@1']));
  });

  it('incompatible: a plugin domain is present at a different generation', async () => {
    mockFetchJson(200, {
      wire_versions_supported: ['atom@1', 'retrieval@2', 'capture@1', 'sync@1'],
    });
    const result = await probeWireCompat('saas', BASE_URL);
    expect(result.status).toBe('incompatible');
    expect(result.missingDomains).toContain('retrieval@1');
  });

  it('normalizes known prefixes (astramem-, astramem/) before comparing', async () => {
    mockFetchJson(200, {
      wire_versions_supported: ['astramem-atom@1', 'astramem/retrieval@1', 'astramem-capture@1', 'astramem-sync@1'],
    });
    const result = await probeWireCompat('local', BASE_URL);
    expect(result.status).toBe('compatible');
  });

  it('legacy: wire_versions_supported field entirely absent', async () => {
    mockFetchJson(200, { version: '0.9.0', gitSha: 'abc123', builtAt: 'unknown', service: 'memory-api' });
    const result = await probeWireCompat('saas', BASE_URL);
    expect(result.status).toBe('legacy');
  });

  it('legacy: wire_versions_supported present but flat/pre-domain scheme (e.g. ["v0.0","v1.0"])', async () => {
    mockFetchJson(200, { wire_versions_supported: ['v0.0', 'v1.0'] });
    const result = await probeWireCompat('local', BASE_URL);
    expect(result.status).toBe('legacy');
    expect(result.error).toMatch(/domain@gen/);
  });

  it('legacy: response body is not JSON-object shaped at all', async () => {
    mockFetchJson(200, ['not', 'an', 'object']);
    const result = await probeWireCompat('local', BASE_URL);
    expect(result.status).toBe('legacy');
  });

  it('unreachable: non-2xx response', async () => {
    mockFetchJson(404, { error: 'not found' });
    const result = await probeWireCompat('local', BASE_URL);
    expect(result.status).toBe('unreachable');
    expect(result.error).toMatch(/404/);
  });

  it('unreachable: network error (fetch throws)', async () => {
    mockFetchReject(new TypeError('Failed to fetch'));
    const result = await probeWireCompat('local', BASE_URL);
    expect(result.status).toBe('unreachable');
    expect(result.error).toMatch(/failed/i);
  });

  it('unreachable: timeout', async () => {
    origFetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as typeof fetch;
    const result = await probeWireCompat('local', BASE_URL, 10);
    expect(result.status).toBe('unreachable');
    expect(result.error).toMatch(/timed out/);
  });
});

describe('checkWireCompat — throws only on genuine incompatibility', () => {
  it('does not throw and returns the result on compatible', async () => {
    mockFetchJson(200, { wire_versions_supported: ['atom@1', 'retrieval@1', 'capture@1', 'sync@1'] });
    await expect(checkWireCompat('local', BASE_URL)).resolves.toMatchObject({ status: 'compatible' });
  });

  it('does not throw on legacy (missing fields tolerated)', async () => {
    mockFetchJson(200, { version: '0.1.0' });
    await expect(checkWireCompat('local', BASE_URL)).resolves.toMatchObject({ status: 'legacy' });
  });

  it('does not throw on unreachable', async () => {
    mockFetchReject(new TypeError('Failed to fetch'));
    await expect(checkWireCompat('local', BASE_URL)).resolves.toMatchObject({ status: 'unreachable' });
  });

  it('throws WireIncompatibilityError naming expected vs. got on incompatible', async () => {
    mockFetchJson(200, {
      wire_versions_supported: ['atom@1', 'sync@1'],
      schema_version: '1',
    });
    let caught: unknown;
    try {
      await checkWireCompat('saas', BASE_URL);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WireIncompatibilityError);
    const message = (caught as Error).message;
    expect(message).toMatch(/Wire version mismatch/);
    expect(message).toMatch(/saas/);
    expect(message).toMatch(BASE_URL);
    // Names expected (plugin) vs. got (backend).
    expect(message).toMatch(/atom@1, retrieval@1, capture@1/);
    expect(message).toMatch(/atom@1, sync@1/);
  });

  it('WireIncompatibilityError has kind "deterministic" (not retryable)', async () => {
    mockFetchJson(200, { wire_versions_supported: ['sync@1'] }); // domain scheme, but zero plugin-domain overlap
    try {
      await checkWireCompat('saas', BASE_URL);
      throw new Error('expected checkWireCompat to throw');
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe('deterministic');
    }
  });
});
