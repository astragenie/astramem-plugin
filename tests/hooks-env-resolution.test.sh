#!/usr/bin/env bash
# hooks-env-resolution.test.sh — minimal inline test harness for FEAT-280 Part B ACs.
#
# No external test framework required. Run with:
#   bash tests/hooks-env-resolution.test.sh
# Exit code 0 = all pass; non-zero = at least one failure.

set +e
set -u

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOAD_ENV="$PLUGIN_ROOT/hooks/scripts/_load-env.sh"

# ---- helpers ----------------------------------------------------------------

ok() {
  printf 'PASS  %s\n' "$1"
  PASS=$((PASS + 1))
}

fail() {
  printf 'FAIL  %s\n' "  expected: $2  got: $3" >&2
  printf 'FAIL  %s\n' "$1" >&2
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

# Evaluate _load-env.sh in a subprocess and echo the resolved vars.
resolve_vars() {
  # Args: key=value pairs to pre-export (space-separated)
  # Stdin: none
  # Stdout: ASTRAMEMORY_API_URL=<val> ASTRAMEMORY_API_KEY=<val>
  local extra_env="${1:-}"
  (
    # Unset any inherited ASTRAMEMORY_* so tests are isolated
    unset ASTRAMEMORY_API_URL ASTRAMEMORY_API_KEY ASTRAMEMORY_ENV \
          ASTRAMEMORY_HOOK_SCRIPT_NAME CORTEX_API_URL CORTEX_API_KEY 2>/dev/null || true
    eval "${extra_env:-true}"
    # shellcheck disable=SC1090
    . "$LOAD_ENV"
    printf 'ASTRAMEMORY_API_URL=%s\n' "${ASTRAMEMORY_API_URL:-}"
    printf 'ASTRAMEMORY_API_KEY=%s\n' "${ASTRAMEMORY_API_KEY:-}"
  )
}

# ---- fixture helpers --------------------------------------------------------

TMPDIR_FIXTURES="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_FIXTURES"' EXIT

make_profiles() {
  local dir="$TMPDIR_FIXTURES/home-$1"
  mkdir -p "$dir/.astramemory"
  printf '%s\n' "$2" > "$dir/.astramemory/profiles.json"
  echo "$dir"
}

make_tokens() {
  local home_dir="$1" env_name="$2"
  printf '%s\n' "$3" > "$home_dir/.astramemory/tokens.${env_name}.json"
}

# ---- AC8: profile + token files present, no legacy env vars -----------------

home8="$(make_profiles "ac8" '{"prod":{"apiUrl":"https://api.astramemory.example.com"}}')"
make_tokens "$home8" "prod" '{"memory":{"apiKey":"sk-profile-key-ac8","label":"test","repoPath":"/work/mega/memory"}}'

out8="$(resolve_vars "HOME='$home8'; ASTRAMEMORY_ENV=prod; cwd='/work/mega/memory'")"
url8="$(printf '%s' "$out8" | grep '^ASTRAMEMORY_API_URL=' | cut -d= -f2-)"
key8="$(printf '%s' "$out8" | grep '^ASTRAMEMORY_API_KEY=' | cut -d= -f2-)"

assert_eq "AC8: profile URL resolved" "https://api.astramemory.example.com" "$url8"
assert_eq "AC8: profile apiKey resolved" "sk-profile-key-ac8" "$key8"

# ---- AC9: no profile files, legacy env vars set -> legacy wins --------------

home9="$(mktemp -d -p "$TMPDIR_FIXTURES")"
# No ~/.astramemory/ directory at all
out9="$(resolve_vars "HOME='$home9'; ASTRAMEMORY_API_URL='https://legacy.example.com'; ASTRAMEMORY_API_KEY='sk-legacy-key-ac9'")"
url9="$(printf '%s' "$out9" | grep '^ASTRAMEMORY_API_URL=' | cut -d= -f2-)"
key9="$(printf '%s' "$out9" | grep '^ASTRAMEMORY_API_KEY=' | cut -d= -f2-)"

assert_eq "AC9: legacy env URL honored" "https://legacy.example.com" "$url9"
assert_eq "AC9: legacy env key honored" "sk-legacy-key-ac9" "$key9"

# ---- AC10: ASTRAMEMORY_ENV=staging, no staging key, no legacy -> exit 0 silently (defaults used) --

home10="$(make_profiles "ac10" '{"prod":{"apiUrl":"https://api.astramemory.example.com"}}')"
# No tokens.staging.json

out10="$(resolve_vars "HOME='$home10'; ASTRAMEMORY_ENV=staging")"
# Should not crash. URL falls to localhost default; key to dev-bootstrap-local default.
url10="$(printf '%s' "$out10" | grep '^ASTRAMEMORY_API_URL=' | cut -d= -f2-)"
key10="$(printf '%s' "$out10" | grep '^ASTRAMEMORY_API_KEY=' | cut -d= -f2-)"

# Both should be the hard-coded defaults (no staging entry, no legacy env)
assert_eq "AC10: staging miss URL falls to default" "http://localhost:5201" "$url10"
assert_eq "AC10: staging miss key falls to default" "dev-bootstrap-local" "$key10"

# Verify _load-env.sh exits 0 when staging is missing (no crash)
(unset ASTRAMEMORY_API_URL ASTRAMEMORY_API_KEY ASTRAMEMORY_ENV 2>/dev/null || true
 HOME="$home10" ASTRAMEMORY_ENV=staging . "$LOAD_ENV") 2>/dev/null
exit_code=$?
assert_eq "AC10: exits 0 silently" "0" "$exit_code"

# ---- AC11: jq missing -> exits 0 silently (falls to defaults) ---------------

home11="$(make_profiles "ac11" '{"prod":{"apiUrl":"https://api.astramemory.example.com"}}')"
make_tokens "$home11" "prod" '{"memory":{"apiKey":"sk-profile-key-ac11"}}'

# Simulate jq missing by overriding PATH to a dir that has no jq.
# Capture bash absolute path BEFORE narrowing PATH (otherwise `bash` itself is unfindable).
no_jq_dir="$(mktemp -d -p "$TMPDIR_FIXTURES")"
bash_exec="$(command -v bash)"
out11="$(
  unset ASTRAMEMORY_API_URL ASTRAMEMORY_API_KEY ASTRAMEMORY_ENV 2>/dev/null || true
  HOME="$home11" PATH="$no_jq_dir" ASTRAMEMORY_ENV=prod \
    "$bash_exec" -c '. '"$LOAD_ENV"'; printf "ASTRAMEMORY_API_URL=%s\n" "${ASTRAMEMORY_API_URL:-}"; printf "ASTRAMEMORY_API_KEY=%s\n" "${ASTRAMEMORY_API_KEY:-}"'
)"
url11="$(printf '%s' "$out11" | grep '^ASTRAMEMORY_API_URL=' | cut -d= -f2-)"
key11="$(printf '%s' "$out11" | grep '^ASTRAMEMORY_API_KEY=' | cut -d= -f2-)"

assert_eq "AC11: jq missing URL falls to default" "http://localhost:5201" "$url11"
assert_eq "AC11: jq missing key falls to default" "dev-bootstrap-local" "$key11"

# ---- AC13: ASTRAMEMORY_HOOK_DEBUG=1 emits one stderr line with expected fields, no key -----

home13="$(make_profiles "ac13" '{"prod":{"apiUrl":"https://api.astramemory.example.com"}}')"
make_tokens "$home13" "prod" '{"memory":{"apiKey":"sk-secret-key-must-not-appear"}}'

debug_out="$(
  unset ASTRAMEMORY_API_URL ASTRAMEMORY_API_KEY ASTRAMEMORY_ENV 2>/dev/null || true
  HOME="$home13" ASTRAMEMORY_ENV=prod ASTRAMEMORY_HOOK_DEBUG=1 \
  ASTRAMEMORY_HOOK_SCRIPT_NAME=pre-compact-capture \
    bash -c 'cwd=/work/mega/memory; . '"$LOAD_ENV"'' 2>&1
)"

# Should contain [astramemory-hook] prefix
if printf '%s' "$debug_out" | grep -q '\[astramemory-hook\]'; then
  ok "AC13: debug line emitted"
else
  fail "AC13: debug line emitted" "[astramemory-hook] present" "absent"
fi

# Must NOT contain the actual key value
if printf '%s' "$debug_out" | grep -q 'sk-secret-key-must-not-appear'; then
  fail "AC13: key must not appear in debug output" "key absent" "key present"
else
  ok "AC13: key not logged in debug output"
fi

# Should contain script name
if printf '%s' "$debug_out" | grep -q 'script=pre-compact-capture'; then
  ok "AC13: script name in debug line"
else
  fail "AC13: script name in debug line" "script=pre-compact-capture" "absent"
fi

# Should contain env=prod
if printf '%s' "$debug_out" | grep -q 'env=prod'; then
  ok "AC13: env in debug line"
else
  fail "AC13: env in debug line" "env=prod" "absent"
fi

# ---- Summary ----------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
