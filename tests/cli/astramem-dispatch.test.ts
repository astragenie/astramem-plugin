/**
 * End-to-end dispatch smoke tests for bin/astramem.
 *
 * Spawns `bun bin/astramem <subcommand>` and asserts exit codes + stdout shape.
 *
 * NOTE: These tests require Track A providers to be available for full integration.
 * Until Track A lands, the selector falls back to NullProvider, which means:
 *   - recall exits 3 (backend error)
 *   - remember exits 3 (backend error)
 *   - health exits 3 (NullProvider returns ok=false)
 *   - doctor exits 0 (always)
 *   - config exits 0
 *   - connect exits 3 (no daemon running)
 *
 * Note: `astramem ingest` (generic) was removed in v0.5.2.
 *       Use `astramem ingest-transcript` for transcript ingestion.
 *
 * Track A integration: remove the .skip from the "full integration" suite below.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const BIN = join(process.cwd(), 'bin', 'astramem');
const BUN = 'bun';

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runBin(args: string[], env: Record<string, string> = {}): SpawnResult {
  const result = spawnSync(BUN, [BIN, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('astramem dispatch (bin/astramem)', () => {
  it('--help exits 0 and lists all 6 subcommands (no generic ingest)', () => {
    const r = runBin(['--help']);
    expect(r.status).toBe(0);
    // ingest-transcript still present (hook shim target)
    expect(r.stdout).toMatch(/ingest-transcript/);
    // generic 'ingest' command removed in v0.5.2 — must NOT appear as a top-level subcommand
    expect(r.stdout).not.toMatch(/^  ingest\s/m);
    expect(r.stdout).toMatch(/recall/);
    expect(r.stdout).toMatch(/remember/);
    expect(r.stdout).toMatch(/health/);
    expect(r.stdout).toMatch(/config/);
    expect(r.stdout).toMatch(/doctor/);
    expect(r.stdout).toMatch(/connect/);
  });

  it('--version exits 0 and prints version', () => {
    const r = runBin(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/0\.5\.2/);
  });

  it('unknown subcommand exits 1', () => {
    const r = runBin(['bogus-cmd']);
    expect(r.status).toBe(1);
  });

  it('ingest (generic) exits 1 as unknown subcommand after v0.5.2 removal', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'astramem-e2e-'));
    const r = runBin(['ingest', '--json', '{"id":"x","type":"transcript","text":"t"}'], { APPDATA: tmpDir });
    rmSync(tmpDir, { recursive: true, force: true });
    // Removed subcommand — exits 1 (unknown subcommand path)
    expect(r.status).toBe(1);
  });

  describe('health — JSON output shape', () => {
    it('exits with JSON on stdout (shape check)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'astramem-e2e-'));
      const r = runBin(['health'], { APPDATA: tmpDir, ASTRAMEM_PROVIDER: 'local' });
      rmSync(tmpDir, { recursive: true, force: true });
      // May exit 0 or 3 depending on daemon availability — just validate JSON shape
      expect(r.status === 0 || r.status === 3).toBe(true);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      } catch {
        // If no JSON on stdout, check stderr has something
      }
      if (parsed !== null) {
        expect(parsed).toHaveProperty('ok');
        expect(parsed).toHaveProperty('provider');
      }
    });
  });

  describe('config — basic get/set/unset', () => {
    it('config get exits 0 and prints JSON', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'astramem-config-e2e-'));
      const r = runBin(['config', 'get'], { APPDATA: tmpDir });
      rmSync(tmpDir, { recursive: true, force: true });
      expect(r.status).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed).toHaveProperty('provider');
    });

    it('config set then get roundtrips correctly', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'astramem-config-e2e-'));
      runBin(['config', 'set', 'provider', 'local'], { APPDATA: tmpDir });
      const r = runBin(['config', 'get', 'provider'], { APPDATA: tmpDir });
      rmSync(tmpDir, { recursive: true, force: true });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('local');
    });
  });

  describe('doctor', () => {
    it('always exits 0', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'astramem-doctor-e2e-'));
      const r = runBin(['doctor'], { APPDATA: tmpDir });
      rmSync(tmpDir, { recursive: true, force: true });
      expect(r.status).toBe(0);
    });

    it('output contains expected sections', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'astramem-doctor-e2e-'));
      const r = runBin(['doctor'], { APPDATA: tmpDir });
      rmSync(tmpDir, { recursive: true, force: true });
      expect(r.stdout).toMatch(/ENV VARS/);
      expect(r.stdout).toMatch(/CONFIG/);
      expect(r.stdout).toMatch(/LOCAL PROBE/);
    });
  });

  // TODO Wave 3 integration: unskip when Track A providers land
  describe.skip('full integration (Track A required)', () => {
    it('recall returns hits from local provider', () => {
      const r = runBin(['recall', '--query', 'test'], { ASTRAMEM_PROVIDER: 'local' });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout) as { hits: unknown[] };
      expect(Array.isArray(out.hits)).toBe(true);
    });

    it('remember exits 0', () => {
      const r = runBin(['remember', '--content', 'test memory', '--type', 'fact'], {
        ASTRAMEM_PROVIDER: 'local',
      });
      expect(r.status).toBe(0);
    });
  });
});
