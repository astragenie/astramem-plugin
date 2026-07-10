/**
 * Tests for src/lib/project.ts — resolveProject() (issue #33).
 *
 * Precedence matrix: flag > ASTRAMEM_PROJECT env > config.project > basename(cwd).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { resolveProject } from '../../src/lib/project.ts';
import { loadConfig, saveConfig } from '../../src/lib/config.ts';

let tmpDir: string;
let originalAppData: string | undefined;
let originalHome: string | undefined;
let originalEnvProject: string | undefined;
let originalHookDebug: string | undefined;

function isolateEnv(): void {
  tmpDir = mkdtempSync(join(tmpdir(), 'astramem-project-test-'));
  originalAppData = process.env['APPDATA'];
  originalHome = process.env['HOME'];
  originalEnvProject = process.env['ASTRAMEM_PROJECT'];
  originalHookDebug = process.env['ASTRAMEM_HOOK_DEBUG'];
  process.env['APPDATA'] = tmpDir;
  if (process.platform !== 'win32') {
    process.env['HOME'] = tmpDir;
  }
  delete process.env['ASTRAMEM_PROJECT'];
  delete process.env['ASTRAMEM_HOOK_DEBUG'];
}

function restoreEnv(): void {
  if (originalAppData !== undefined) process.env['APPDATA'] = originalAppData;
  else delete process.env['APPDATA'];
  if (process.platform !== 'win32') {
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
  }
  if (originalEnvProject !== undefined) process.env['ASTRAMEM_PROJECT'] = originalEnvProject;
  else delete process.env['ASTRAMEM_PROJECT'];
  if (originalHookDebug !== undefined) process.env['ASTRAMEM_HOOK_DEBUG'] = originalHookDebug;
  else delete process.env['ASTRAMEM_HOOK_DEBUG'];
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

describe('resolveProject', () => {
  beforeEach(isolateEnv);
  afterEach(restoreEnv);

  // -------------------------------------------------------------------------
  // Precedence matrix
  // -------------------------------------------------------------------------

  it('tier 4: falls back to basename(cwd) when nothing else is set', () => {
    expect(resolveProject({ cwd: '/home/user/projects/my-app' })).toBe('my-app');
  });

  it('tier 4: falls back to "default" when basename(cwd) is empty', () => {
    expect(resolveProject({ cwd: '/' })).toBe('default');
  });

  it('tier 4: defaults cwd to process.cwd() when not supplied', () => {
    const expected = basename(process.cwd()) || 'default';
    expect(resolveProject({})).toBe(expected);
  });

  it('tier 3: config.project wins over basename(cwd)', () => {
    saveConfig({ ...loadConfig(), project: 'config-project' });
    expect(resolveProject({ cwd: '/home/user/projects/my-app' })).toBe('config-project');
  });

  it('tier 2: ASTRAMEM_PROJECT env wins over config.project', () => {
    saveConfig({ ...loadConfig(), project: 'config-project' });
    process.env['ASTRAMEM_PROJECT'] = 'env-project';
    expect(resolveProject({ cwd: '/home/user/projects/my-app' })).toBe('env-project');
  });

  it('tier 1: explicit flag wins over env, config, and basename', () => {
    saveConfig({ ...loadConfig(), project: 'config-project' });
    process.env['ASTRAMEM_PROJECT'] = 'env-project';
    expect(
      resolveProject({ flag: 'flag-project', cwd: '/home/user/projects/my-app' }),
    ).toBe('flag-project');
  });

  it('an empty-string flag is treated as absent — falls through to env', () => {
    process.env['ASTRAMEM_PROJECT'] = 'env-project';
    expect(resolveProject({ flag: '', cwd: '/home/user/projects/my-app' })).toBe('env-project');
  });

  it('a whitespace-only ASTRAMEM_PROJECT is treated as absent — falls through to config', () => {
    saveConfig({ ...loadConfig(), project: 'config-project' });
    process.env['ASTRAMEM_PROJECT'] = '   ';
    expect(resolveProject({ cwd: '/home/user/projects/my-app' })).toBe('config-project');
  });

  it('a corrupt/invalid config file never throws — falls through to basename', () => {
    // loadConfig() throws a ZodError when the file is present but invalid;
    // resolveProject must swallow that and keep resolving, never crash a hook.
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ provider: 'not-a-real-provider' }));
    expect(() => resolveProject({ cwd: '/home/user/projects/my-app' })).not.toThrow();
    expect(resolveProject({ cwd: '/home/user/projects/my-app' })).toBe('my-app');
  });

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  it('logs the winning precedence tier to stderr when ASTRAMEM_HOOK_DEBUG=1', () => {
    process.env['ASTRAMEM_HOOK_DEBUG'] = '1';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    resolveProject({ flag: 'flag-project', cwd: '/home/user/projects/my-app' });
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('tier=flag'))).toBe(true);
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('flag-project'))).toBe(true);
    stderrSpy.mockRestore();
  });

  it('does not log to stderr when ASTRAMEM_HOOK_DEBUG is unset', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    resolveProject({ cwd: '/home/user/projects/my-app' });
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });
});
