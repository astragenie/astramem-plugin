import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryProvider } from '../../src/contracts/provider.ts';

// ---------------------------------------------------------------------------
// Temp dir + mock datadir
// ---------------------------------------------------------------------------
let tempDir: string;

vi.mock('../../src/lib/datadir.ts', () => ({
  unifiedConfigDir: () => tempDir,
  legacyConfigDir: () => join(tempDir, 'legacy-xdg'),
  legacyAstramemPath: () => join(tempDir, 'legacy-old'),
}));

// ---------------------------------------------------------------------------
// Mock provider implementations
// ---------------------------------------------------------------------------
const makeMockProvider = (): MemoryProvider => ({
  ingest: vi.fn().mockResolvedValue(undefined),
  ingestTranscript: vi.fn().mockResolvedValue(undefined),
  recall: vi.fn().mockResolvedValue({ hits: [] }),
  remember: vi.fn().mockResolvedValue(undefined),
  health: vi.fn().mockResolvedValue({ ok: true }),
});

// Mock the Track A provider files so they don't need to exist yet.
vi.mock('../../src/providers/local.ts', () => {
  const inst = makeMockProvider();
  return { LocalProvider: class { ingest = inst.ingest; ingestTranscript = inst.ingestTranscript; recall = inst.recall; remember = inst.remember; health = inst.health; } };
});
vi.mock('../../src/providers/saas.ts', () => {
  const inst = makeMockProvider();
  return { SaasProvider: class { ingest = inst.ingest; ingestTranscript = inst.ingestTranscript; recall = inst.recall; remember = inst.remember; health = inst.health; } };
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'astramem-selector-test-'));
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getSelector() {
  return import('../../src/lib/selector.ts');
}

function writeConfig(provider: 'local' | 'saas' | 'auto') {
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    join(tempDir, 'config.json'),
    JSON.stringify({ provider, local: {}, saas: {}, logging: { level: 'silent' } }),
  );
}

/** Write config with explicit saas.url so the privacy-safe guard passes. */
function writeConfigWithSaas(provider: 'local' | 'saas' | 'auto', saasUrl = 'https://saas.example.com') {
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    join(tempDir, 'config.json'),
    JSON.stringify({ provider, local: {}, saas: { url: saasUrl }, logging: { level: 'silent' } }),
  );
}

// ---------------------------------------------------------------------------
// Precedence matrix tests
// ---------------------------------------------------------------------------
describe('resolveProvider — precedence matrix', () => {
  it('flag overrides env + config + auto', async () => {
    writeConfig('saas');
    vi.stubEnv('ASTRAMEM_PROVIDER', 'saas');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: true, latency_ms: 1 }));

    const result = await resolveProvider({ flag: 'local' });
    expect(result.source).toBe('flag');
    expect(result.providerName).toBe('local');
  });

  it('process.env.ASTRAMEM_PROVIDER overrides config and auto when no flag', async () => {
    writeConfig('saas');
    vi.stubEnv('ASTRAMEM_PROVIDER', 'local');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: false, latency_ms: 100 }));

    const result = await resolveProvider({});
    expect(result.source).toBe('env');
    expect(result.providerName).toBe('local');
  });

  it('opts.env overrides process.env.ASTRAMEM_PROVIDER', async () => {
    vi.stubEnv('ASTRAMEM_PROVIDER', 'saas');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: false, latency_ms: 100 }));

    const result = await resolveProvider({ env: 'local' });
    expect(result.source).toBe('env');
    expect(result.providerName).toBe('local');
  });

  it('config overrides auto when provider is explicit (local)', async () => {
    writeConfig('local');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: false, latency_ms: 5000 })); // local down
    // Config says local — selector respects that without probing

    const result = await resolveProvider({});
    expect(result.source).toBe('config');
    expect(result.providerName).toBe('local');
  });

  it('config overrides auto when provider is explicit (saas)', async () => {
    writeConfig('saas');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: true, latency_ms: 1 })); // local up, but config says saas

    const result = await resolveProvider({});
    expect(result.source).toBe('config');
    expect(result.providerName).toBe('saas');
  });

  it('auto: probes local and picks it when up', async () => {
    writeConfig('auto');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: true, latency_ms: 8 }));

    const result = await resolveProvider({});
    expect(result.source).toBe('auto');
    expect(result.providerName).toBe('local');
    expect(result.latency_probe_ms).toBe(8);
  });

  it('fallback to saas when auto probe fails (saas configured via config)', async () => {
    // saas.url must be configured — privacy-safe guard rejects silent fallback otherwise.
    writeConfigWithSaas('auto');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: false, latency_ms: 200 }));

    const result = await resolveProvider({});
    expect(result.source).toBe('fallback');
    expect(result.providerName).toBe('saas');
  });

  it('auto when no config exists and local is up', async () => {
    mkdirSync(tempDir, { recursive: true });
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: true, latency_ms: 3 }));

    const result = await resolveProvider({});
    expect(result.source).toBe('auto');
    expect(result.providerName).toBe('local');
  });

  it('fallback when no config exists and local is down (saas configured via env)', async () => {
    // No config file — but SaaS is configured via env so fallback is allowed.
    mkdirSync(tempDir, { recursive: true });
    vi.stubEnv('MEMORY_API_URL_SAAS', 'https://saas.example.com');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: false, latency_ms: 5001 }));

    const result = await resolveProvider({});
    expect(result.source).toBe('fallback');
    expect(result.providerName).toBe('saas');
  });

  it('ignores invalid provider values in env', async () => {
    vi.stubEnv('ASTRAMEM_PROVIDER', 'not-a-provider');
    writeConfig('saas');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: false, latency_ms: 1 }));

    // Invalid env value is ignored, falls through to config
    const result = await resolveProvider({});
    expect(result.source).toBe('config');
    expect(result.providerName).toBe('saas');
  });
});

// ---------------------------------------------------------------------------
// Cache tests
// ---------------------------------------------------------------------------
describe('resolveProvider — health probe cache', () => {
  it('probes only once for the same URL within 5 seconds', async () => {
    writeConfig('auto');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();

    let callCount = 0;
    _setHealthProbeFn(async () => {
      callCount++;
      return { ok: true, latency_ms: 2 };
    });

    await resolveProvider({});
    await resolveProvider({});
    await resolveProvider({});
    expect(callCount).toBe(1);
  });

  it('re-probes after cache is cleared', async () => {
    writeConfig('auto');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();

    let callCount = 0;
    _setHealthProbeFn(async () => {
      callCount++;
      return { ok: true, latency_ms: 2 };
    });

    await resolveProvider({});
    _resetHealthCache(); // simulate expiry
    await resolveProvider({});
    expect(callCount).toBe(2);
  });

  it('second call returns cached result without calling probe fn', async () => {
    writeConfig('auto');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();

    const probeFn = vi.fn().mockResolvedValue({ ok: true, latency_ms: 5 });
    _setHealthProbeFn(probeFn);

    const r1 = await resolveProvider({});
    const r2 = await resolveProvider({});
    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(r1.source).toBe(r2.source);
    expect(r1.providerName).toBe(r2.providerName);
  });
});

// ---------------------------------------------------------------------------
// Privacy-safe auto-probe policy tests
// ---------------------------------------------------------------------------
describe('resolveProvider — data-local privacy-safe policy', () => {
  it('saas configured + local up → picks local (source=auto)', async () => {
    writeConfigWithSaas('auto');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: true, latency_ms: 4 }));

    const result = await resolveProvider({});
    expect(result.source).toBe('auto');
    expect(result.providerName).toBe('local');
  });

  it('saas configured + local down → falls back to saas (source=fallback)', async () => {
    writeConfigWithSaas('auto');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: false, latency_ms: 150 }));

    const result = await resolveProvider({});
    expect(result.source).toBe('fallback');
    expect(result.providerName).toBe('saas');
  });

  it('saas NOT configured + local up → picks local (source=auto)', async () => {
    writeConfig('auto'); // no saas.url
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: true, latency_ms: 6 }));

    const result = await resolveProvider({});
    expect(result.source).toBe('auto');
    expect(result.providerName).toBe('local');
  });

  it('saas NOT configured + local down → throws data-local refusal error', async () => {
    writeConfig('auto'); // no saas.url
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: false, latency_ms: 5000 }));

    await expect(resolveProvider({})).rejects.toThrow(/data-local/);
  });

  it('data-local refusal error message includes "data-local" phrase (grepping support)', async () => {
    writeConfig('auto'); // no saas.url
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: false, latency_ms: 5000 }));

    let errorMessage = '';
    try {
      await resolveProvider({});
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    expect(errorMessage).toMatch(/data-local/);
    expect(errorMessage).toMatch(/refusing to fall back to SaaS/);
    expect(errorMessage).toMatch(/MEMORY_API_URL_SAAS/);
  });
});

// ---------------------------------------------------------------------------
// Startup wire-version compatibility probe (FEAT 4a backlog M1) — wiring
// tests. The probe module's own classification logic (compatible/legacy/
// unreachable/incompatible) is covered by tests/lib/wire-probe.test.ts; these
// tests only cover that resolveProvider() actually invokes the probe and
// reacts correctly to each outcome.
// ---------------------------------------------------------------------------
describe('resolveProvider — startup wire-compat probe wiring', () => {
  it('resolves normally under the default (NODE_ENV=test) always-compatible stub', async () => {
    writeConfig('local');
    const { resolveProvider, _setHealthProbeFn, _resetHealthCache } = await getSelector();
    _resetHealthCache();
    _setHealthProbeFn(async () => ({ ok: true, latency_ms: 1 }));

    // No _setWireCompatFn call — exercises the module's own default.
    const result = await resolveProvider({});
    expect(result.providerName).toBe('local');
  });

  it('propagates WireIncompatibilityError when the probe reports incompatible (flag path)', async () => {
    const { resolveProvider, _setWireCompatFn, _resetWireCompatFn } = await getSelector();
    const { WireIncompatibilityError } = await import('../../src/lib/wire-probe.ts');
    _setWireCompatFn(async (name, baseUrl) => ({
      status: 'incompatible',
      providerName: name,
      baseUrl,
      missingDomains: ['retrieval@1'],
    }));

    await expect(resolveProvider({ flag: 'local' })).rejects.toBeInstanceOf(WireIncompatibilityError);
    _resetWireCompatFn();
  });

  it('propagates WireIncompatibilityError from the config-resolved branch', async () => {
    writeConfig('saas');
    vi.stubEnv('MEMORY_API_URL_SAAS', 'https://saas.example.com');
    const { resolveProvider, _setWireCompatFn, _resetWireCompatFn } = await getSelector();
    _setWireCompatFn(async (name, baseUrl) => ({ status: 'incompatible', providerName: name, baseUrl }));

    await expect(resolveProvider({})).rejects.toThrow(/Wire version mismatch|incompatible/i);
    _resetWireCompatFn();
  });

  it('does NOT block resolution when the probe reports legacy — only warns', async () => {
    writeConfig('local');
    const { resolveProvider, _setWireCompatFn, _resetWireCompatFn } = await getSelector();
    _setWireCompatFn(async (name, baseUrl) => ({ status: 'legacy', providerName: name, baseUrl, error: 'no wire_versions_supported' }));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await resolveProvider({ flag: 'local' });
      expect(result.providerName).toBe('local');
      expect(stderrSpy).toHaveBeenCalled();
      const warned = stderrSpy.mock.calls.some((c) => String(c[0]).includes('WARNING'));
      expect(warned).toBe(true);
    } finally {
      stderrSpy.mockRestore();
      _resetWireCompatFn();
    }
  });

  it('does NOT block resolution when the probe reports unreachable — only warns', async () => {
    vi.stubEnv('MEMORY_API_URL_SAAS', 'https://saas.example.com');
    const { resolveProvider, _setWireCompatFn, _resetWireCompatFn } = await getSelector();
    _setWireCompatFn(async (name, baseUrl) => ({ status: 'unreachable', providerName: name, baseUrl, error: 'network error' }));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await resolveProvider({ flag: 'saas' });
      expect(result.providerName).toBe('saas');
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      _resetWireCompatFn();
    }
  });

  it('does not warn when the probe reports compatible', async () => {
    const { resolveProvider, _setWireCompatFn, _resetWireCompatFn } = await getSelector();
    _setWireCompatFn(async (name, baseUrl) => ({ status: 'compatible', providerName: name, baseUrl }));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await resolveProvider({ flag: 'local' });
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      _resetWireCompatFn();
    }
  });
});
