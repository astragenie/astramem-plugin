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
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
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
 * Resolve the *main* repository's directory name for a given cwd.
 *
 * The plain `basename(cwd)` fallback breaks under git worktrees: Claude Code
 * runs isolated subagents in worktrees named `agent-<guid>`, so `basename(cwd)`
 * leaks that guid as the project scope (one phantom project per worktree run —
 * see astragenie/memory#705).
 *
 * `git rev-parse --git-common-dir` points at the *shared* `.git` directory,
 * which lives in the main worktree regardless of which linked worktree `cwd` is
 * in. Its parent is the main repo root, whose basename is the stable project
 * name. In the main worktree this returns the same value `basename(cwd)` would.
 * (A bare repo is handled separately below — git points at the bare dir itself,
 * which is not `.git`-suffixed, so its own name is the project name.)
 *
 * Returns undefined when cwd is not inside a git repo (or git is unavailable),
 * so the caller falls back to the plain basename tier.
 */
function resolveGitMainRepoName(cwd: string): string | undefined {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    }).trim();
    if (commonDir === '') return undefined;
    // commonDir may be relative (".git" in the main worktree) or absolute
    // (linked worktrees point at the main repo's .git). Resolve against cwd.
    const absCommon = resolve(cwd, commonDir);
    // For a normal repo the common dir is the `.git` directory, so the repo
    // root — and the project name — is its parent. For a *bare* repo (e.g.
    // `foo.git` with linked worktrees hung off it) git points here at the bare
    // dir itself, which is NOT `.git`-suffixed; taking dirname() there would
    // strip one level too far and silently misattribute scope to the bare
    // repo's parent. In that case the bare dir's own name is the project name.
    const repoRoot = basename(absCommon) === '.git' ? dirname(absCommon) : absCommon;
    const name = basename(repoRoot);
    return name === '' ? undefined : name;
  } catch {
    // Not a git repo, git missing, or timeout — never break a hook/CLI call.
    return undefined;
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

  // Worktree-aware: prefer the main repo's name so an `agent-<guid>` worktree
  // resolves back to the real project instead of leaking the worktree dir name.
  const gitName = resolveGitMainRepoName(cwd);
  const fallback = gitName ?? (basename(cwd) || 'default');
  debugLog('basename', fallback);
  return fallback;
}
