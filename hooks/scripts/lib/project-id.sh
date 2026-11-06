#!/usr/bin/env bash
# hooks/scripts/lib/project-id.sh — shared project-id derivation (issue #68).
#
# Problem: every hook previously derived PROJECT_ID as basename(cwd). Claude
# Code runs isolated agents in a worktree — either the nested layout
# (`<repo>/.claude/worktrees/agent-<id>/`) or the sibling layout
# (`<repo>-worktrees/<name>/`) — so for any session whose cwd is one of
# those paths, basename(cwd) resolved to the WORKTREE directory name
# (e.g. `agent-a0112287d8dd8d401`), not the repo, and that string was sent
# verbatim as --project-id, polluting the daemon's project index.
#
# derive_project_id resolves the MAIN repo identity instead, in this order:
#
#   1. git -C "$cwd" rev-parse --git-common-dir — works correctly from
#      inside a linked worktree too: --git-common-dir always points at the
#      MAIN repo's .git (worktrees only have their own .git *file*, which
#      points back at it), so the basename of that directory's parent is
#      the real repo name for BOTH the main checkout and any worktree.
#   2. String-strip fallback, used when git is unavailable or the cwd no
#      longer exists on disk (e.g. a deleted worktree — `git -C` can't even
#      stat it): drop a trailing /.claude/worktrees/<x> or
#      /<name>-worktrees/<x> segment pair, then basename. Same rule the
#      daemon side uses (DEC-017 in astramem-local) for defense-in-depth.
#   3. Plain basename otherwise (non-git directory, or a path that doesn't
#      match either worktree layout).
#
# An empty cwd argument falls back to $PWD exactly as the pre-fix hooks did
# — no git-awareness is applied to that path, to keep that branch
# byte-for-byte identical to existing behaviour.
#
# Usage:
#   PROJECT_ID="$(derive_project_id "$CWD")"
derive_project_id() {
  local cwd="$1"

  if [ -z "$cwd" ]; then
    basename "$PWD"
    return 0
  fi

  # (1) Normalise backslashes to forward slashes (Windows-style paths).
  cwd="${cwd//\\//}"

  # (2) Git-aware resolution.
  if command -v git >/dev/null 2>&1; then
    local common_dir=""

    # Preferred: ask git itself for an already-absolute path (--path-format
    # landed in git 2.31, 2021 — ubiquitous by now). This sidesteps any need
    # to hand-resolve ".." segments ourselves, which matters once cwd is
    # anything deeper than the repo root: git-common-dir is then relative
    # with multiple "../" hops (e.g. "../../../.git"), and naive string
    # concatenation + suffix-stripping would mis-basename to "..".
    common_dir="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"

    if [ -z "$common_dir" ]; then
      # Fallback for a git old enough not to know --path-format: resolve the
      # (possibly relative, possibly multi-"../") value ourselves by
      # actually `cd`-ing through it, rather than string-splicing — that
      # canonicalises any ".." hops away before basename ever sees the path.
      local raw
      raw="$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null)"
      if [ -n "$raw" ]; then
        raw="${raw//\\//}"
        case "$raw" in
          /*|[A-Za-z]:/*)
            # Already absolute (covers both "/work/mega/repo/.git" and
            # "C:/Users/.../repo/.git"; MSYS "/c/..." forms start with "/"
            # and are already covered by this branch too).
            common_dir="$raw"
            ;;
          *)
            local raw_dir raw_base resolved_dir
            raw_dir="$(dirname "$raw")"
            raw_base="$(basename "$raw")"
            resolved_dir="$(cd "$cwd" 2>/dev/null && cd "$raw_dir" 2>/dev/null && pwd)"
            [ -n "$resolved_dir" ] && common_dir="$resolved_dir/$raw_base"
            ;;
        esac
      fi
    fi

    if [ -n "$common_dir" ]; then
      common_dir="${common_dir//\\//}"
      # Strip a trailing /.git (or /.git/): --git-common-dir names the
      # .git directory itself, for both the main checkout and a worktree
      # (worktrees resolve to the MAIN repo's real .git here, not their
      # own gitdir file) — its parent is the repo root we want.
      case "$common_dir" in
        */.git/) common_dir="${common_dir%/.git/}" ;;
        */.git) common_dir="${common_dir%/.git}" ;;
      esac
      if [ -n "$common_dir" ]; then
        basename "$common_dir"
        return 0
      fi
    fi
  fi

  # (3) String-strip fallback — git missing, or git failed (e.g. the
  # worktree directory itself has already been deleted so `git -C "$cwd"`
  # can't stat a cwd to run in). Strip a trailing worktree segment pair
  # for either layout and basename what's left.
  case "$cwd" in
    */.claude/worktrees/*)
      basename "${cwd%/.claude/worktrees/*}"
      return 0
      ;;
    *-worktrees/*)
      basename "${cwd%-worktrees/*}"
      return 0
      ;;
  esac

  # (4) Plain basename.
  basename "$cwd"
}
