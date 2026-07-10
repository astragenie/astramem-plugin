/**
 * project.ts — shared default project-scope resolution (issue #33).
 *
 * Before this module, CLI-with-no-flag and the hook shims derived a default
 * "project" scope independently (hooks: `basename $CWD` in bash; CLI: nothing
 * at all). resolveProject() is the single source of truth every call site
 * should route through so a given cwd/env/config combination always resolves
 * to the same project.
 *
 * Precedence (highest wins):
 *   1. flag      — explicit --project value the caller already parsed
 *   2. env       — ASTRAMEM_PROJECT
 *   3. config    — `project` field in the unified config file
 *                  (`astramem config set project <name>`)
 *   4. basename  — basename(cwd), falling back to 'default' if empty
 *
 * Client-local only — this does NOT touch the wire schema. Callers still
 * decide how the resolved value is transmitted (metadata.project for
 * remember, provenance.project for recall, project_id for ingest-transcript).
 *
 * Deliberately does NOT read `.claude/loop.json`: that's a different notion
 * of "project" scoped to the loop harness and can drift from the astramem
 * project concept. Deferred to a future slice (see issue #33 discussion).
 */
import { basename } from 'node:path';
import { loadConfig } from './config.ts';

export interface ResolveProjectOpts {
  /** Explicit --project flag value, if the caller already parsed one. */
  flag?: string;
  /** Working directory used for the basename() fallback. Defaults to process.cwd(). */
  cwd?: string;
}

export type ProjectResolutionTier = 'flag' | 'env' | 'config' | 'basename';

function debugLog(tier: ProjectResolutionTier, value: string): void {
  if (process.env['ASTRAMEM_HOOK_DEBUG'] === '1') {
    process.stderr.write(`[astramem-hook-debug] resolveProject: tier=${tier} value=${value}\n`);
  }
}

/**
 * Resolve the default project scope: flag > ASTRAMEM_PROJECT env >
 * config.project > basename(cwd). Always returns a non-empty string.
 */
export function resolveProject(opts: ResolveProjectOpts = {}): string {
  const { flag, cwd = process.cwd() } = opts;

  if (flag !== undefined && flag.trim() !== '') {
    debugLog('flag', flag);
    return flag;
  }

  const envProject = process.env['ASTRAMEM_PROJECT'];
  if (envProject !== undefined && envProject.trim() !== '') {
    debugLog('env', envProject);
    return envProject;
  }

  let configProject: string | undefined;
  try {
    configProject = loadConfig().project;
  } catch {
    // Corrupt/invalid config must never break a hook or CLI invocation —
    // fall through to the basename tier instead of throwing.
    configProject = undefined;
  }
  if (configProject !== undefined && configProject.trim() !== '') {
    debugLog('config', configProject);
    return configProject;
  }

  const fallback = basename(cwd) || 'default';
  debugLog('basename', fallback);
  return fallback;
}
