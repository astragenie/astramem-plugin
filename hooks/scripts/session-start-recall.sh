#!/usr/bin/env bash
# session-start-recall.sh — issue #31: read-side counterpart to the capture hooks.
# Injects project-scoped memories as SessionStart additionalContext so every
# session opens with what the store already knows about this project.
#
# Contract (mirrors the three capture shims):
#   - fire-and-forget: ALWAYS exits 0 — a memory recall must never block a session
#   - silent no-op on: disabled via env, provider unreachable (CLI exit 3),
#     timeout, malformed response, or zero hits
#   - on success: prints ONE compact JSON object with
#     hookSpecificOutput.additionalContext (SessionStart schema)
#
# Env knobs:
#   MEMORY_SESSIONSTART_RECALL_DISABLE=1  skip entirely
#   MEMORY_SESSIONSTART_RECALL_K          top-k hits (default 8)
#   MEMORY_SESSIONSTART_RECALL_QUERY      recall query override
#   MEMORY_SESSIONSTART_MAX_ATOM_CHARS    per-atom truncation (default 300)
#   ASTRAMEM_HOOK_DEBUG=1                 debug info on stderr
#
# issue #33: project scope is no longer derived here via `basename $CWD` — that
# duplicated (and could drift from) the CLI's own default resolution. We pass
# --cwd through and let `astramem recall` resolve the default project via
# resolveProject() (src/lib/project.ts), the single source of truth shared with
# remember/ingest-transcript and the capture hook shims.
set +e
set -u

if [ "${MEMORY_SESSIONSTART_RECALL_DISABLE:-}" = "1" ]; then
  exit 0
fi

PAYLOAD="$(cat)"
CWD=""
if [ -n "$PAYLOAD" ]; then
  CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
fi

# Normalize path separators (same belt-and-suspenders as session-end-summary.sh).
if [ -n "$CWD" ]; then
  CWD="${CWD//\\//}"
fi

K="${MEMORY_SESSIONSTART_RECALL_K:-8}"
QUERY="${MEMORY_SESSIONSTART_RECALL_QUERY:-project context decisions lessons constraints state}"
MAX_CHARS="${MEMORY_SESSIONSTART_MAX_ATOM_CHARS:-300}"

if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
  printf '[astramem-hook-debug] session-start-recall: cwd=%s k=%s\n' "$CWD" "$K" >&2
fi

ARGS=(recall --query "$QUERY" --k "$K")
[ -n "$CWD" ] && ARGS+=(--cwd "$CWD")
RESP="$(bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" "${ARGS[@]}" 2>/dev/null)"
RC=$?
if [ $RC -ne 0 ] || [ -z "$RESP" ]; then
  if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
    printf '[astramem-hook-debug] session-start-recall: recall failed rc=%s\n' "$RC" >&2
  fi
  exit 0
fi

# Transform hits → additionalContext. `empty` when no usable hits (prints
# nothing, exit 0). Any jq failure is swallowed — never emit partial JSON.
# Note: the message no longer echoes the resolved project name — that value
# lives solely inside the CLI's resolveProject() (issue #33) now, and
# re-deriving it here for display would reintroduce the same drift risk we
# just removed (e.g. an ASTRAMEM_PROJECT/config.project override wouldn't be
# reflected in a bash-computed label).
printf '%s' "$RESP" | jq -c \
  --argjson max "$MAX_CHARS" '
  [.hits[]?
    | select((.text | type) == "string" and (.text | length) > 0)
    | "- [\(.type // "note")] \(.text | gsub("\\s+"; " ") | .[0:$max])"
  ] as $lines
  | if ($lines | length) == 0 then empty else
      { hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: (
            "astramem recall (top \($lines | length)) — background memory from the local daemon; snapshots of when they were written, verify before acting on them:\n"
            + ($lines | join("\n"))
          )
      } }
    end
' 2>/dev/null
exit 0
