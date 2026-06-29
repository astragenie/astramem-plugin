/**
 * env.test.ts — unit tests for src/lib/env.ts
 *
 * Tests resolveEnv() resolution logic, deprecation warning emission,
 * opt-out flag, hit-count tracking, and _resetEnvState().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We import after each reset via dynamic import or directly — but since module
// state is process-level and vitest reuses the module, we call _resetEnvState()
// in beforeEach instead of resetModules (which would be slower).
import {
  resolveEnv,
  getDeprecationHits,
  _resetEnvState,
  type EnvSpec,
} from '../../src/lib/env.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.unstubAllEnvs();
  _resetEnvState();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetEnvState();
});

// ---------------------------------------------------------------------------
// Resolution logic
// ---------------------------------------------------------------------------

describe('resolveEnv — canonical', () => {
  it('returns canonical value when canonical is set', () => {
    vi.stubEnv('MEMORY_SESSIONEND_MAX_TURNS', '30');
    const spec: EnvSpec = {
      canonical: 'MEMORY_SESSIONEND_MAX_TURNS',
      aliases: ['MEMORY_SESSION_MAX_TURNS'],
      default: '20',
    };
    const result = resolveEnv(spec);
    expect(result.source).toBe('canonical');
    expect(result.value).toBe('30');
    expect(result.aliasUsed).toBeUndefined();
  });

  it('returns absent when nothing is set and no default', () => {
    const spec: EnvSpec = { canonical: 'MEMORY_TOTALLY_ABSENT_XYZ', aliases: [] };
    const result = resolveEnv(spec);
    expect(result.source).toBe('absent');
    expect(result.value).toBeUndefined();
  });

  it('returns default when nothing is set and default provided', () => {
    const spec: EnvSpec = {
      canonical: 'MEMORY_TOTALLY_ABSENT_XYZ',
      aliases: [],
      default: '42',
    };
    const result = resolveEnv(spec);
    expect(result.source).toBe('default');
    expect(result.value).toBe('42');
  });
});

describe('resolveEnv — alias', () => {
  it('returns alias when canonical absent and alias set', () => {
    vi.stubEnv('MEMORY_SESSION_MAX_TURNS', '40');
    const spec: EnvSpec = {
      canonical: 'MEMORY_SESSIONEND_MAX_TURNS',
      aliases: ['MEMORY_SESSION_MAX_TURNS'],
      default: '20',
    };
    const result = resolveEnv(spec);
    expect(result.source).toBe('alias');
    expect(result.value).toBe('40');
    expect(result.aliasUsed).toBe('MEMORY_SESSION_MAX_TURNS');
  });

  it('canonical wins when both canonical and alias are set', () => {
    vi.stubEnv('MEMORY_SESSIONEND_MAX_TURNS', '30');
    vi.stubEnv('MEMORY_SESSION_MAX_TURNS', '40');
    const spec: EnvSpec = {
      canonical: 'MEMORY_SESSIONEND_MAX_TURNS',
      aliases: ['MEMORY_SESSION_MAX_TURNS'],
    };
    let output = '';
    output = captureStderr(() => resolveEnv(spec));
    const result = resolveEnv(spec);
    expect(result.source).toBe('canonical');
    expect(result.value).toBe('30');
    // No deprecation warning — canonical was used.
    expect(output).toBe('');
    expect(getDeprecationHits()['MEMORY_SESSION_MAX_TURNS']).toBeUndefined();
  });

  it('checks aliases in order — returns first matching alias', () => {
    vi.stubEnv('ALIAS_A', '');
    vi.stubEnv('ALIAS_B', 'value_b');
    const spec: EnvSpec = {
      canonical: 'CANONICAL_ABSENT_ZZZ',
      aliases: ['ALIAS_A', 'ALIAS_B'],
    };
    const result = resolveEnv(spec);
    expect(result.source).toBe('alias');
    expect(result.aliasUsed).toBe('ALIAS_B');
    expect(result.value).toBe('value_b');
  });

  it('skips alias when aliasPredicate rejects, falls to default', () => {
    vi.stubEnv('ASTRAMEMORY_API_URL', 'https://api.example.com');
    const LOCAL_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?(?:\/|$)/;
    const spec: EnvSpec = {
      canonical: 'MEMORY_API_URL_LOCAL',
      aliases: ['ASTRAMEMORY_API_URL'],
      aliasPredicate: (v) => LOCAL_PATTERN.test(v),
      default: 'http://127.0.0.1:7777',
    };
    const result = resolveEnv(spec);
    expect(result.source).toBe('default');
    expect(result.value).toBe('http://127.0.0.1:7777');
  });

  it('uses alias when aliasPredicate accepts', () => {
    vi.stubEnv('ASTRAMEMORY_API_URL', 'http://127.0.0.1:9999');
    const LOCAL_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?(?:\/|$)/;
    const spec: EnvSpec = {
      canonical: 'MEMORY_API_URL_LOCAL',
      aliases: ['ASTRAMEMORY_API_URL'],
      aliasPredicate: (v) => LOCAL_PATTERN.test(v),
      default: 'http://127.0.0.1:7777',
    };
    const result = resolveEnv(spec);
    expect(result.source).toBe('alias');
    expect(result.value).toBe('http://127.0.0.1:9999');
    expect(result.aliasUsed).toBe('ASTRAMEMORY_API_URL');
  });
});

// ---------------------------------------------------------------------------
// Deprecation warnings
// ---------------------------------------------------------------------------

describe('resolveEnv — deprecation warning', () => {
  it('emits a stderr warning when alias is used', () => {
    vi.stubEnv('MEMORY_SESSION_MAX_TURNS', '40');
    const spec: EnvSpec = {
      canonical: 'MEMORY_SESSIONEND_MAX_TURNS',
      aliases: ['MEMORY_SESSION_MAX_TURNS'],
    };
    const output = captureStderr(() => resolveEnv(spec));
    expect(output).toContain('[astramem] DEPRECATED env var "MEMORY_SESSION_MAX_TURNS"');
    expect(output).toContain('use "MEMORY_SESSIONEND_MAX_TURNS"');
    expect(output).toContain('MEMORY_DEPRECATION_OPT_OUT=1');
  });

  it('emits warning only once per alias per process (one-shot)', () => {
    vi.stubEnv('MEMORY_SESSION_MAX_TURNS', '40');
    const spec: EnvSpec = {
      canonical: 'MEMORY_SESSIONEND_MAX_TURNS',
      aliases: ['MEMORY_SESSION_MAX_TURNS'],
    };
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    resolveEnv(spec);
    resolveEnv(spec);
    resolveEnv(spec);
    const warningCalls = spy.mock.calls.filter((c) =>
      String(c[0]).includes('DEPRECATED'),
    );
    expect(warningCalls).toHaveLength(1);
    spy.mockRestore();
  });

  it('suppresses warning when MEMORY_DEPRECATION_OPT_OUT=1', () => {
    vi.stubEnv('MEMORY_SESSION_MAX_TURNS', '40');
    vi.stubEnv('MEMORY_DEPRECATION_OPT_OUT', '1');
    const spec: EnvSpec = {
      canonical: 'MEMORY_SESSIONEND_MAX_TURNS',
      aliases: ['MEMORY_SESSION_MAX_TURNS'],
    };
    const output = captureStderr(() => resolveEnv(spec));
    expect(output).toBe('');
    // Resolution still works — just silent.
    const result = resolveEnv(spec);
    expect(result.source).toBe('alias');
    expect(result.value).toBe('40');
  });
});

// ---------------------------------------------------------------------------
// Hit-count tracking
// ---------------------------------------------------------------------------

describe('getDeprecationHits', () => {
  it('returns 0 hits initially after reset', () => {
    expect(getDeprecationHits()).toEqual({});
  });

  it('increments hit count for each alias resolution', () => {
    vi.stubEnv('MEMORY_SESSION_MAX_TURNS', '40');
    const spec: EnvSpec = {
      canonical: 'MEMORY_SESSIONEND_MAX_TURNS',
      aliases: ['MEMORY_SESSION_MAX_TURNS'],
    };
    // Silence warnings so stderr isn't cluttered.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    resolveEnv(spec);
    resolveEnv(spec);
    resolveEnv(spec);
    vi.restoreAllMocks();
    expect(getDeprecationHits()['MEMORY_SESSION_MAX_TURNS']).toBe(3);
  });

  it('does NOT increment hit count when canonical is used', () => {
    vi.stubEnv('MEMORY_SESSIONEND_MAX_TURNS', '30');
    vi.stubEnv('MEMORY_SESSION_MAX_TURNS', '40');
    const spec: EnvSpec = {
      canonical: 'MEMORY_SESSIONEND_MAX_TURNS',
      aliases: ['MEMORY_SESSION_MAX_TURNS'],
    };
    resolveEnv(spec);
    expect(getDeprecationHits()['MEMORY_SESSION_MAX_TURNS']).toBeUndefined();
  });

  it('tracks multiple aliases independently', () => {
    vi.stubEnv('ALIAS_X', 'xval');
    vi.stubEnv('ALIAS_Y', 'yval');
    const specX: EnvSpec = { canonical: 'CANON_X_ABSENT', aliases: ['ALIAS_X'] };
    const specY: EnvSpec = { canonical: 'CANON_Y_ABSENT', aliases: ['ALIAS_Y'] };
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    resolveEnv(specX);
    resolveEnv(specX);
    resolveEnv(specY);
    vi.restoreAllMocks();
    const hits = getDeprecationHits();
    expect(hits['ALIAS_X']).toBe(2);
    expect(hits['ALIAS_Y']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// _resetEnvState
// ---------------------------------------------------------------------------

describe('_resetEnvState', () => {
  it('clears hit counts and warning-suppression after reset', () => {
    vi.stubEnv('MEMORY_SESSION_MAX_TURNS', '40');
    const spec: EnvSpec = {
      canonical: 'MEMORY_SESSIONEND_MAX_TURNS',
      aliases: ['MEMORY_SESSION_MAX_TURNS'],
    };
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    resolveEnv(spec);
    vi.restoreAllMocks();
    expect(getDeprecationHits()['MEMORY_SESSION_MAX_TURNS']).toBe(1);

    _resetEnvState();

    expect(getDeprecationHits()).toEqual({});

    // After reset, warning should fire again.
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    resolveEnv(spec);
    const warned = spy.mock.calls.some((c) => String(c[0]).includes('DEPRECATED'));
    expect(warned).toBe(true);
    spy.mockRestore();
  });
});
