/**
 * Tests for src/providers/demo.ts — the zero-daemon, zero-network demo provider
 * backing `astramem connect --demo` (Wave 2 Track A).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../../src/lib/datadir.ts', () => ({
  unifiedConfigDir: () => tempDir,
  legacyConfigDir: () => join(tempDir, 'legacy-xdg'),
  legacyAstramemPath: () => join(tempDir, 'legacy-old'),
}));

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'astramem-demo-provider-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function getDemo() {
  return import('../../src/providers/demo.ts');
}

describe('DemoProvider', () => {
  it('health() reports ok and auto-seeds the store if missing', async () => {
    const { DemoProvider, isDemoStoreActive } = await getDemo();
    expect(isDemoStoreActive()).toBe(false);
    const provider = new DemoProvider();
    const health = await provider.health();
    expect(health.ok).toBe(true);
    expect(health.version).toMatch(/demo/i);
    expect(isDemoStoreActive()).toBe(true);
  });

  it('resetDemoStore() writes deterministic canned memories to disk', async () => {
    const { resetDemoStore, buildSeedMemories } = await getDemo();
    const seeded = resetDemoStore('astramem-plugin');
    expect(seeded.length).toBeGreaterThanOrEqual(5);
    expect(seeded).toEqual(buildSeedMemories('astramem-plugin'));
    const raw = readFileSync(join(tempDir, 'demo-store.json'), 'utf-8');
    expect(JSON.parse(raw)).toHaveLength(seeded.length);
  });

  it('clearDemoStore() removes the store file', async () => {
    const { resetDemoStore, clearDemoStore, isDemoStoreActive } = await getDemo();
    resetDemoStore();
    expect(isDemoStoreActive()).toBe(true);
    clearDemoStore();
    expect(isDemoStoreActive()).toBe(false);
    expect(existsSync(join(tempDir, 'demo-store.json'))).toBe(false);
  });

  it('clearDemoStore() is a safe no-op when no store exists', async () => {
    const { clearDemoStore, isDemoStoreActive } = await getDemo();
    expect(isDemoStoreActive()).toBe(false);
    expect(() => clearDemoStore()).not.toThrow();
  });

  it('recall() returns seeded memories, scored and sorted, respecting k', async () => {
    const { DemoProvider, resetDemoStore, DEMO_SAMPLE_QUESTION } = await getDemo();
    resetDemoStore('astramem-plugin');
    const provider = new DemoProvider();
    const res = await provider.recall({ query: DEMO_SAMPLE_QUESTION, k: 3 });
    expect(res.provider).toBe('demo');
    expect(res.hits.length).toBeLessThanOrEqual(3);
    expect(res.hits.length).toBeGreaterThan(0);
    for (const hit of res.hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < res.hits.length; i++) {
      expect(res.hits[i - 1]!.score).toBeGreaterThanOrEqual(res.hits[i]!.score);
    }
    // Sanity check that scoring isn't just returning arbitrary order.
    expect(res.hits[0]!.text.toLowerCase()).toContain('demo');
  });

  it('recall() is deterministic — identical query returns identical ranking twice', async () => {
    const { DemoProvider, resetDemoStore, DEMO_SAMPLE_QUESTION } = await getDemo();
    resetDemoStore();
    const provider = new DemoProvider();
    const r1 = await provider.recall({ query: DEMO_SAMPLE_QUESTION, k: 5 });
    const r2 = await provider.recall({ query: DEMO_SAMPLE_QUESTION, k: 5 });
    expect(r1.hits.map((h) => h.id)).toEqual(r2.hits.map((h) => h.id));
    expect(r1.hits.map((h) => h.score)).toEqual(r2.hits.map((h) => h.score));
  });

  it('recall() on an empty/unseeded store returns zero hits, not an error', async () => {
    const { DemoProvider } = await getDemo();
    const provider = new DemoProvider();
    const res = await provider.recall({ query: 'anything', k: 5 });
    expect(res.hits).toEqual([]);
    expect(res.total_searched).toBe(0);
  });

  it('remember() persists a new memory that a later recall() can find', async () => {
    const { DemoProvider, resetDemoStore } = await getDemo();
    resetDemoStore();
    const provider = new DemoProvider();
    await provider.remember({
      id: 'custom-1',
      type: 'note',
      text: 'The build pipeline uses Bun exclusively, never npm.',
    });
    const res = await provider.recall({ query: 'Bun exclusively', k: 5 });
    expect(res.hits.some((h) => h.id === 'custom-1')).toBe(true);
    expect(res.total_searched).toBeGreaterThanOrEqual(6); // 5 seeds + 1 remembered
  });

  it('remember() then recall() work across separate provider instances (simulates separate CLI processes)', async () => {
    const { DemoProvider, resetDemoStore } = await getDemo();
    resetDemoStore();
    const writer = new DemoProvider();
    await writer.remember({
      id: 'cross-proc-1',
      type: 'fact',
      text: 'Cross-process demo memory survives because the store is file-backed.',
    });
    const reader = new DemoProvider();
    const res = await reader.recall({ query: 'file-backed', k: 5 });
    expect(res.hits.some((h) => h.id === 'cross-proc-1')).toBe(true);
  });

  it('ingest() and ingestTranscript() resolve without throwing (fire-and-forget contract)', async () => {
    const { DemoProvider } = await getDemo();
    const provider = new DemoProvider();
    await expect(
      provider.ingest({ id: 'x', type: 'transcript', text: 'hello' }),
    ).resolves.toBeUndefined();
    await expect(
      provider.ingestTranscript({
        wire_version: 'v1.0',
        event: 'pre_compact',
        session_id: 'sess-demo',
        project_id: 'proj-demo',
        captured_at: '2026-01-01T00:00:00Z',
        turns: [{ role: 'user', text: 'hi' }],
        client_scrub_applied: true,
        client_scrub_hits: 0,
        client_version: '0.7.0',
        client_scrub_version: '2',
      } as never),
    ).resolves.toBeUndefined();
  });

  it('scoreMatch() is deterministic and bounded to [0,1]', async () => {
    const { scoreMatch } = await getDemo();
    const s1 = scoreMatch('demo mode data network', 'Demo mode stores memories and nothing is sent over the network.');
    const s2 = scoreMatch('demo mode data network', 'Demo mode stores memories and nothing is sent over the network.');
    expect(s1).toBe(s2);
    expect(s1).toBeGreaterThan(0);
    expect(s1).toBeLessThanOrEqual(1);
    expect(scoreMatch('zzz nomatch', 'completely unrelated text')).toBe(0);
  });
});
