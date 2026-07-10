#!/usr/bin/env bash
# session-end-export-md.sh — issue #34: opt-in freshness hook for the
# repo-visible MEMORY.md digest (`astramem export-md`).
#
# Off by default — writing to a user's repo unsolicited is not something a
# hook should do without explicit opt-in. Set MEMORY_EXPORT_MD_ENABLE=1 to
# turn this on for a given machine/session. When disabled this is a fast
# no-op (exits 0 before even reading stdin's payload contents).
#
# Fire-and-forget: never blocks SessionEnd, always exits 0.
#
# Env knobs:
#   MEMORY_EXPORT_MD_ENABLE=1   turn the hook on (default: off)
#   MEMORY_EXPORT_MD_OUT        --out override (default: .claude/astramem/MEMORY.md)
#   MEMORY_EXPORT_MD_K          --k override (default: 10)
#   MEMORY_EXPORT_MD_TYPES      --types override (default: decision,lesson)
#   ASTRAMEM_HOOK_DEBUG=1       debug info on stderr
set +e
set -u

if [ "${MEMORY_EXPORT_MD_ENABLE:-}" != "1" ]; then
  exit 0
fi

PAYLOAD="$(cat)"
CWD=""
if [ -n "$PAYLOAD" ]; then
  CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
fi

# Normalize path separators (same belt-and-suspenders as the other shims).
if [ -n "$CWD" ]; then
  CWD="${CWD//\\//}"
fi

ARGS=(export-md)
[ -n "$CWD" ] && ARGS+=(--cwd "$CWD")
[ -n "${MEMORY_EXPORT_MD_OUT:-}" ] && ARGS+=(--out "$MEMORY_EXPORT_MD_OUT")
[ -n "${MEMORY_EXPORT_MD_K:-}" ] && ARGS+=(--k "$MEMORY_EXPORT_MD_K")
[ -n "${MEMORY_EXPORT_MD_TYPES:-}" ] && ARGS+=(--types "$MEMORY_EXPORT_MD_TYPES")

if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
  printf '[astramem-hook-debug] session-end-export-md: cwd=%s\n' "$CWD" >&2
  bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" "${ARGS[@]}"
else
  bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" "${ARGS[@]}" >/dev/null 2>&1
fi
exit 0
