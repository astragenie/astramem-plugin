/**
 * env-specs.test.ts — integration tests for src/lib/env-specs.ts
 *
 * Validates the canonical/alias/predicate wiring for each ENV entry,
 * focusing on the URL-disambiguation predicates and the session-end alias path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ENV } from '../../src/lib/env-specs.ts';
import { resolveEnv, _resetEnvState } from '../../src/lib/env.ts';

// Silence deprecation warnings throughout this file — we're testing resolution
// correctness, not warning output.
beforeEach(() => {
  vi.unstubAllEnvs();
  _resetEnvState();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetEnvState();
});

// ---------------------------------------------------------------------------
// apiUrlLocal
// ---------------------------------------------------------------------------

describe('ENV.apiUrlLocal', () => {
  it('resolves from canonical MEMORY_API_URL_LOCAL', () => {
    vi.stubEnv('MEMORY_API_URL_LOCAL', 'http://127.0.0.1:8888');
    const result = resolveEnv(ENV.apiUrlLocal);
    expect(result.source).toBe('canonical');
    expect(result.value).toBe('http://127.0.0.1:8888');
  });

  it('resolves from ASTRAMEMORY_API_URL when value matches localhost pattern', () => {
    vi.stubEnv('ASTRAMEMORY_API_URL', 'http://127.0.0.1:7777');
    const result = resolveEnv(ENV.apiUrlLocal);
    expect(result.source).toBe('alias');
    expect(result.aliasUsed).toBe('ASTRAMEMORY_API_URL');
    expect(result.value).toBe('http://127.0.0.1:7777');
  });

  it('resolves from localhost hostname via ASTRAMEMORY_API_URL', () => {
    vi.stubEnv('ASTRAMEMORY_API_URL', 'http://localhost:7777');
    const result = resolveEnv(ENV.apiUrlLocal);
    expect(result.source).toBe('alias');
    expect(result.value).toBe('http://localhost:7777');
  });

  it('rejects non-local ASTRAMEMORY_API_URL, falls to default', () => {
    vi.stubEnv('ASTRAMEMORY_API_URL', 'https://api.astramem.com');
    const result = resolveEnv(ENV.apiUrlLocal);
    expect(result.source).toBe('default');
    expect(result.value).toBe('http://127.0.0.1:7777');
  });

  it('returns default when nothing is set', () => {
    const result = resolveEnv(ENV.apiUrlLocal);
    expect(result.source).toBe('default');
    expect(result.value).toBe('http://127.0.0.1:7777');
  });
});

// ---------------------------------------------------------------------------
// apiUrlSaas
// ---------------------------------------------------------------------------

describe('ENV.apiUrlSaas', () => {
  it('resolves from canonical MEMORY_API_URL_SAAS', () => {
    vi.stubEnv('MEMORY_API_URL_SAAS', 'https://api.astramem.com');
    const result = resolveEnv(ENV.apiUrlSaas);
    expect(result.source).toBe('canonical');
    expect(result.value).toBe('https://api.astramem.com');
  });

  it('resolves from MEMORY_API_URL alias when value is non-local', () => {
    vi.stubEnv('MEMORY_API_URL', 'https://api.astramem.com');
    const result = resolveEnv(ENV.apiUrlSaas);
    expect(result.source).toBe('alias');
    expect(result.aliasUsed).toBe('MEMORY_API_URL');
    expect(result.value).toBe('https://api.astramem.com');
  });

  it('rejects MEMORY_API_URL with local value, falls to absent', () => {
    vi.stubEnv('MEMORY_API_URL', 'http://127.0.0.1:7777');
    const result = resolveEnv(ENV.apiUrlSaas);
    // predicate rejects local → next alias ASTRAMEMORY_API_URL also absent → absent
    expect(result.source).toBe('absent');
    expect(result.value).toBeUndefined();
  });

  it('resolves from ASTRAMEMORY_API_URL when non-local (second alias)', () => {
    vi.stubEnv('ASTRAMEMORY_API_URL', 'https://api.astramem.com');
    const result = resolveEnv(ENV.apiUrlSaas);
    expect(result.source).toBe('alias');
    expect(result.aliasUsed).toBe('ASTRAMEMORY_API_URL');
    expect(result.value).toBe('https://api.astramem.com');
  });

  it('returns absent when nothing is set', () => {
    const result = resolveEnv(ENV.apiUrlSaas);
    expect(result.source).toBe('absent');
    expect(result.value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sessionEndMaxTurns / sessionEndMaxChars
// ---------------------------------------------------------------------------

describe('ENV.sessionEndMaxTurns', () => {
  it('resolves canonical MEMORY_SESSIONEND_MAX_TURNS', () => {
    vi.stubEnv('MEMORY_SESSIONEND_MAX_TURNS', '30');
    const result = resolveEnv(ENV.sessionEndMaxTurns);
    expect(result.source).toBe('canonical');
    expect(result.value).toBe('30');
  });

  it('resolves alias MEMORY_SESSION_MAX_TURNS with deprecation warning', () => {
    vi.stubEnv('MEMORY_SESSION_MAX_TURNS', '40');
    const result = resolveEnv(ENV.sessionEndMaxTurns);
    expect(result.source).toBe('alias');
    expect(result.aliasUsed).toBe('MEMORY_SESSION_MAX_TURNS');
    expect(result.value).toBe('40');
    // Warning was emitted (spy is active from beforeEach).
    const calls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const warned = calls.some((c: unknown[]) => String(c[0]).includes('MEMORY_SESSION_MAX_TURNS'));
    expect(warned).toBe(true);
  });

  it('returns default 20 when nothing is set', () => {
    const result = resolveEnv(ENV.sessionEndMaxTurns);
    expect(result.source).toBe('default');
    expect(result.value).toBe('20');
  });
});

describe('ENV.sessionEndMaxChars', () => {
  it('returns default 12000 when nothing is set', () => {
    const result = resolveEnv(ENV.sessionEndMaxChars);
    expect(result.source).toBe('default');
    expect(result.value).toBe('12000');
  });

  it('resolves alias MEMORY_SESSION_MAX_CHARS', () => {
    vi.stubEnv('MEMORY_SESSION_MAX_CHARS', '8000');
    const result = resolveEnv(ENV.sessionEndMaxChars);
    expect(result.source).toBe('alias');
    expect(result.value).toBe('8000');
  });
});

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

describe('ENV.provider', () => {
  it('resolves canonical ASTRAMEM_PROVIDER', () => {
    vi.stubEnv('ASTRAMEM_PROVIDER', 'local');
    const result = resolveEnv(ENV.provider);
    expect(result.source).toBe('canonical');
    expect(result.value).toBe('local');
  });

  it('returns absent when not set', () => {
    const result = resolveEnv(ENV.provider);
    expect(result.source).toBe('absent');
    expect(result.value).toBeUndefined();
  });
});
