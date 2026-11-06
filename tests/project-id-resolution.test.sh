#!/usr/bin/env bash
# project-id-resolution.test.sh — issue #68: derive_project_id() must resolve
# the MAIN repo identity, not the agent-worktree directory name, for every
# layout Claude Code can hand a hook as `cwd`.
#
# No external test framework required. Run with:
#   bash tests/project-id-resolution.test.sh
# Exit code 0 = all pass; non-zero = at least one failure.

set +e
set -u

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ID_LIB="$PLUGIN_ROOT/hooks/scripts/lib/project-id.sh"

# ---- helpers ----------------------------------------------------------------

ok() {
  printf 'PASS  %s\n' "$1"
  PASS=$((PASS + 1))
}

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  printf '      expected: %s  got: %s\n' "$2" "$3" >&2
  FAIL=$((FAIL + 1))
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    ok "$label"
  else
    fail "$label" "$expected" "$actual"
  fi
}

# Evaluate derive_project_id() in a subprocess so each call is isolated from
# the others (local vars, trap, PWD override for the empty-cwd case).
resolve() {
  local cwd="$1" pwd_override="${2:-}"
  (
    # shellcheck disable=SC1090
    . "$PROJECT_ID_LIB"
    if [ -n "$pwd_override" ]; then
      cd "$pwd_override" || exit 1
    fi
    derive_project_id "$cwd"
  )
}

# ---- fixtures ----------------------------------------------------------------
# A real git repo with both worktree layouts Claude Code uses:
#   nested:  <repo>/.claude/worktrees/agent-<id>/
#   sibling: <repo>-worktrees/<name>/
# Isolated under its own GIT_CEILING_DIRECTORIES so the non-git-dir case
# below can't accidentally walk up into an ambient repo on the test machine
# (e.g. a dotfiles repo rooted at $HOME).

FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT
export GIT_CEILING_DIRECTORIES="$FIXTURE_ROOT"

MAIN_REPO="$FIXTURE_ROOT/astramem-fixture-repo"
mkdir -p "$MAIN_REPO"
git -C "$MAIN_REPO" init -q -b main
git -C "$MAIN_REPO" config user.email 'test@example.com'
git -C "$MAIN_REPO" config user.name 'test'
git -C "$MAIN_REPO" commit -q --allow-empty -m init

mkdir -p "$MAIN_REPO/.claude/worktrees"
NESTED_WT="$MAIN_REPO/.claude/worktrees/agent-deadbeef"
git -C "$MAIN_REPO" worktree add -q "$NESTED_WT" -b agent-deadbeef-branch

SIBLING_WT="$FIXTURE_ROOT/astramem-fixture-repo-worktrees/wt-x"
mkdir -p "$(dirname "$SIBLING_WT")"
git -C "$MAIN_REPO" worktree add -q "$SIBLING_WT" -b wt-x-branch

NON_GIT_DIR="$FIXTURE_ROOT/plain-dir/sub"
mkdir -p "$NON_GIT_DIR"

# ---- main checkout -----------------------------------------------------------

out="$(resolve "$MAIN_REPO")"
assert_eq "main checkout resolves to repo name" "astramem-fixture-repo" "$out"

# ---- nested worktree layout (<repo>/.claude/worktrees/agent-<id>) -------------

out="$(resolve "$NESTED_WT")"
assert_eq "nested worktree resolves to MAIN repo name, not worktree dir" "astramem-fixture-repo" "$out"

# ---- sibling worktree layout (<repo>-worktrees/<name>) ------------------------

out="$(resolve "$SIBLING_WT")"
assert_eq "sibling worktree resolves to MAIN repo name, not worktree dir" "astramem-fixture-repo" "$out"

# ---- deleted nested worktree: git can't stat the path -> string fallback -----

DELETED_WT="$MAIN_REPO/.claude/worktrees/agent-removed"
git -C "$MAIN_REPO" worktree add -q "$DELETED_WT" -b agent-removed-branch
rm -rf "$DELETED_WT"

out="$(resolve "$DELETED_WT")"
assert_eq "deleted nested worktree falls back to string-strip (still repo name)" "astramem-fixture-repo" "$out"

# ---- deleted sibling worktree: same string-fallback path ----------------------

DELETED_SIBLING="$FIXTURE_ROOT/astramem-fixture-repo-worktrees/wt-removed"
git -C "$MAIN_REPO" worktree add -q "$DELETED_SIBLING" -b wt-removed-branch
rm -rf "$DELETED_SIBLING"

out="$(resolve "$DELETED_SIBLING")"
assert_eq "deleted sibling worktree falls back to string-strip (still repo name)" "astramem-fixture-repo" "$out"

# ---- non-git directory: plain basename ---------------------------------------

out="$(resolve "$NON_GIT_DIR")"
assert_eq "non-git dir falls back to plain basename" "sub" "$out"

# ---- empty cwd input: falls back to \$PWD exactly as the pre-fix hooks did ---

out="$(resolve "" "$NON_GIT_DIR")"
assert_eq "empty cwd falls back to basename(\$PWD)" "sub" "$out"

# ---- Windows-style backslash path (nested worktree, drive-letter form) -------

WIN_STYLE_NESTED="$(printf '%s' "$NESTED_WT" | tr '/' '\\')"
out="$(resolve "$WIN_STYLE_NESTED")"
assert_eq "Windows backslash path resolves to MAIN repo name" "astramem-fixture-repo" "$out"

# ---- ambient-ancestor-repo regression (post-#68 review) ----------------------
# A plain non-git directory nested under an UNRELATED ancestor repo — e.g. a
# dotfiles repo rooted at $HOME, which is exactly where Windows's default
# %TEMP% always lives. This fixture lives OUTSIDE $FIXTURE_ROOT on purpose,
# so the GIT_CEILING_DIRECTORIES export above (which only stops an upward
# walk once it would reach $FIXTURE_ROOT) gives it no protection — this
# exercises derive_project_id()'s OWN internal ceiling guard in isolation,
# not the test harness's. Before that guard existed, git's default upward
# .git search would find AMBIENT_ROOT/.git and misattribute the session to
# "ambient-fixture-repo" instead of falling through to plain basename.

AMBIENT_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT" "$AMBIENT_ROOT"' EXIT

mkdir -p "$AMBIENT_ROOT/ambient-fixture-repo"
AMBIENT_REPO="$AMBIENT_ROOT/ambient-fixture-repo"
git -C "$AMBIENT_REPO" init -q -b main
git -C "$AMBIENT_REPO" config user.email 'test@example.com'
git -C "$AMBIENT_REPO" config user.name 'test'
git -C "$AMBIENT_REPO" commit -q --allow-empty -m init

AMBIENT_NON_GIT_DIR="$AMBIENT_REPO/scratch/tmp-session-dir"
mkdir -p "$AMBIENT_NON_GIT_DIR"

out="$(resolve "$AMBIENT_NON_GIT_DIR")"
assert_eq "non-git dir under an unrelated ambient repo still falls back to basename" "tmp-session-dir" "$out"

# ---- Summary ------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
