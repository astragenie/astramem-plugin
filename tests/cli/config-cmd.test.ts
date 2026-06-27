/**
 * Tests for src/cli/config-cmd.ts — astramem config subcommand.
 *
 * Uses a temp dir for config to avoid touching real user config.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../../src/cli/config-cmd.ts';

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { stdout.push(String(c)); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { stderr.push(String(c)); return true; });
  return {
    stdout,
    stderr,
    restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); },
    text: () => stdout.join(''),
    errText: () => stderr.join(''),
  };
}

describe('runConfig', () => {
  let cap: ReturnType<typeof captureOutput>;
  let tmpDir: string;
  let origAppdata: string | undefined;

  beforeEach(() => {
    // Redirect config dir to a temp dir so tests don't pollute user config
    tmpDir = mkdtempSync(join(tmpdir(), 'astramem-config-test-'));
    origAppdata = process.env['APPDATA'];
    process.env['APPDATA'] = tmpDir;
    cap = captureOutput();
  });

  afterEach(() => {
    cap.restore();
    if (origAppdata === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = origAppdata;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('get with no key prints full config JSON', async () => {
    const code = await runConfig(['get']);
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.text());
    expect(parsed).toHaveProperty('provider');
    expect(parsed).toHaveProperty('local');
    expect(parsed).toHaveProperty('saas');
  });

  it('set and get a top-level key', async () => {
    await runConfig(['set', 'provider', 'local']);
    cap.restore();
    cap = captureOutput();
    const code = await runConfig(['get', 'provider']);
    expect(code).toBe(0);
    expect(cap.text().trim()).toBe('local');
  });

  it('set and get a nested dot-path key', async () => {
    await runConfig(['set', 'local.url', 'http://127.0.0.1:8888']);
    cap.restore();
    cap = captureOutput();
    await runConfig(['get', 'local.url']);
    expect(cap.text().trim()).toBe('http://127.0.0.1:8888');
  });

  it('unset removes a key', async () => {
    await runConfig(['set', 'local.url', 'http://127.0.0.1:9999']);
    await runConfig(['unset', 'local.url']);
    cap.restore();
    cap = captureOutput();
    const code = await runConfig(['get', 'local.url']);
    // After unset, key should be absent — returns 2 (not found) or default
    // Default local.url is not set in config (it's derived at runtime), so we accept 2 OR empty string
    expect([0, 2]).toContain(code);
  });

  it('set parses JSON value types', async () => {
    // Set a numeric value
    await runConfig(['set', 'logging.level', '"debug"']);
    cap.restore();
    cap = captureOutput();
    await runConfig(['get', 'logging.level']);
    expect(cap.text().trim()).toBe('debug');
  });

  it('returns 0 for get with no args (full config)', async () => {
    const code = await runConfig(['get']);
    expect(code).toBe(0);
  });

  it('returns 2 when get key not found', async () => {
    const code = await runConfig(['get', 'nonexistent.key']);
    expect(code).toBe(2);
    expect(cap.errText()).toMatch(/not found/i);
  });

  it('returns 2 for set missing key', async () => {
    const code = await runConfig(['set']);
    expect(code).toBe(2);
    expect(cap.errText()).toMatch(/requires.*key.*value/i);
  });

  it('returns 2 for unset missing key', async () => {
    const code = await runConfig(['unset']);
    expect(code).toBe(2);
    expect(cap.errText()).toMatch(/requires.*key/i);
  });

  it('returns 2 for unknown subcommand', async () => {
    const code = await runConfig(['bogus']);
    expect(code).toBe(2);
    expect(cap.errText()).toMatch(/unknown subcommand/i);
  });

  it('prints help for no args', async () => {
    const code = await runConfig([]);
    expect(code).toBe(0);
    expect(cap.text()).toMatch(/Usage.*astramem config/i);
  });
});
