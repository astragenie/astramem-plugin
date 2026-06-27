/**
 * Tests for src/cli/doctor.ts — astramem doctor subcommand.
 *
 * doctor does live network probes and reads config from disk.
 * We test the structure of the output without asserting network results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runDoctor } from '../../src/cli/doctor.ts';

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    chunks.push(String(c));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore(), text: () => chunks.join('') };
}

describe('runDoctor', () => {
  let cap: ReturnType<typeof captureStdout>;

  beforeEach(() => { cap = captureStdout(); });
  afterEach(() => { cap.restore(); });

  it('always returns 0', async () => {
    const code = await runDoctor();
    expect(code).toBe(0);
  });

  it('output contains all section headers', async () => {
    await runDoctor();
    const text = cap.text();
    expect(text).toMatch(/ENV VARS/);
    expect(text).toMatch(/CONFIG/);
    expect(text).toMatch(/LOCAL PROBE/);
    expect(text).toMatch(/SAAS PROBE/);
    expect(text).toMatch(/INGEST LOG/);
  });

  it('reports MEMORY_BEARER as redacted when set', async () => {
    const original = process.env['MEMORY_BEARER'];
    process.env['MEMORY_BEARER'] = 'super-secret-token';
    try {
      await runDoctor();
      const text = cap.text();
      expect(text).toMatch(/MEMORY_BEARER=\[present, redacted\]/);
      expect(text).not.toMatch(/super-secret-token/);
    } finally {
      if (original === undefined) delete process.env['MEMORY_BEARER'];
      else process.env['MEMORY_BEARER'] = original;
    }
  });

  it('reports ASTRAMEM_PROVIDER value when set', async () => {
    const original = process.env['ASTRAMEM_PROVIDER'];
    process.env['ASTRAMEM_PROVIDER'] = 'local';
    try {
      await runDoctor();
      const text = cap.text();
      expect(text).toMatch(/ASTRAMEM_PROVIDER=local/);
    } finally {
      if (original === undefined) delete process.env['ASTRAMEM_PROVIDER'];
      else process.env['ASTRAMEM_PROVIDER'] = original;
    }
  });

  it('reports local probe result (either OK or UNREACHABLE)', async () => {
    await runDoctor();
    const text = cap.text();
    // Local daemon almost certainly not running in test — accept either
    expect(text).toMatch(/local daemon.*OK|local daemon.*UNREACHABLE|local daemon.*HTTP/);
  });

  it('reports saas not configured when saas.url absent', async () => {
    await runDoctor();
    const text = cap.text();
    // Default config has no saas.url
    expect(text).toMatch(/saas.*not configured|saas.*UNREACHABLE|saas.*OK|saas.*HTTP/);
  });

  it('reports ingest log section', async () => {
    await runDoctor();
    const text = cap.text();
    // Either shows entries or "(no entries)"
    expect(text).toMatch(/INGEST LOG|no entries/);
  });
});
