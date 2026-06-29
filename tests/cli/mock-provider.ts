// Shared mock provider factory for Track C CLI tests.
// Returns a MemoryProvider whose methods are vi.fn() stubs with canned defaults.
// Also exposes ingestTranscript stub for ingest-transcript subcommand tests.
import { vi } from 'vitest';
import type { MemoryProvider } from '../../src/contracts/provider.ts';
import type { RecallResponse, HealthResponse } from '../../src/contracts/wire.ts';
import type { TranscriptProvider } from '../../src/cli/ingest-transcript.ts';

export interface MockProviderStubs {
  ingest: ReturnType<typeof vi.fn>;
  ingestTranscript: ReturnType<typeof vi.fn>;
  recall: ReturnType<typeof vi.fn>;
  remember: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
}

export interface MockProvider extends MemoryProvider, TranscriptProvider {
  _stubs: MockProviderStubs;
}

const DEFAULT_RECALL_RESPONSE: RecallResponse = {
  hits: [
    { id: 'hit-1', type: 'fact', text: 'Mock memory hit', score: 0.9 },
    { id: 'hit-2', type: 'decision', text: 'Another memory', score: 0.7 },
  ],
  total_searched: 100,
  provider: 'mock',
};

const DEFAULT_HEALTH_RESPONSE: HealthResponse = {
  ok: true,
  version: '0.1.0-mock',
  url: 'http://mock.provider',
  latencyMs: 5,
};

/**
 * Create a mock MemoryProvider with canned responses.
 * Override individual methods using the returned _stubs.
 */
export function createMockProvider(overrides: Partial<{
  ingestResult: Promise<void> | (() => Promise<void>);
  ingestTranscriptResult: Promise<void> | (() => Promise<void>);
  recallResult: RecallResponse | (() => Promise<RecallResponse>);
  rememberResult: Promise<void> | (() => Promise<void>);
  healthResult: HealthResponse | (() => Promise<HealthResponse>);
}> = {}): MockProvider {
  const stubs: MockProviderStubs = {
    ingest: vi.fn().mockResolvedValue(undefined),
    ingestTranscript: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue(DEFAULT_RECALL_RESPONSE),
    remember: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue(DEFAULT_HEALTH_RESPONSE),
  };

  if (overrides.ingestResult !== undefined) {
    stubs.ingest = vi.fn().mockImplementation(() =>
      typeof overrides.ingestResult === 'function'
        ? overrides.ingestResult()
        : overrides.ingestResult,
    );
  }
  if (overrides.ingestTranscriptResult !== undefined) {
    stubs.ingestTranscript = vi.fn().mockImplementation(() =>
      typeof overrides.ingestTranscriptResult === 'function'
        ? overrides.ingestTranscriptResult()
        : overrides.ingestTranscriptResult,
    );
  }
  if (overrides.recallResult !== undefined) {
    stubs.recall = vi.fn().mockImplementation(() =>
      typeof overrides.recallResult === 'function'
        ? overrides.recallResult()
        : Promise.resolve(overrides.recallResult),
    );
  }
  if (overrides.rememberResult !== undefined) {
    stubs.remember = vi.fn().mockImplementation(() =>
      typeof overrides.rememberResult === 'function'
        ? overrides.rememberResult()
        : overrides.rememberResult,
    );
  }
  if (overrides.healthResult !== undefined) {
    stubs.health = vi.fn().mockImplementation(() =>
      typeof overrides.healthResult === 'function'
        ? overrides.healthResult()
        : Promise.resolve(overrides.healthResult),
    );
  }

  const provider: MockProvider = {
    ingest: stubs.ingest as MemoryProvider['ingest'],
    ingestTranscript: stubs.ingestTranscript as TranscriptProvider['ingestTranscript'],
    recall: stubs.recall as MemoryProvider['recall'],
    remember: stubs.remember as MemoryProvider['remember'],
    health: stubs.health as MemoryProvider['health'],
    _stubs: stubs,
  };

  return provider;
}

/** Create a provider that always throws */
export function createFailingProvider(message = 'mock backend error'): MockProvider {
  return createMockProvider({
    ingestResult: () => Promise.reject(new Error(message)),
    ingestTranscriptResult: () => Promise.reject(new Error(message)),
    recallResult: () => Promise.reject(new Error(message)),
    rememberResult: () => Promise.reject(new Error(message)),
    healthResult: () => Promise.resolve({ ok: false, version: undefined, url: undefined, latencyMs: undefined }),
  });
}
