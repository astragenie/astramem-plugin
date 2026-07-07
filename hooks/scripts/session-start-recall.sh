#!/usr/bin/env bash
# session-start-recall.sh — issue #31: read-side counterpart to the capture hooks.
# Injects project-scoped memories as SessionStart additionalContext so every
# session opens with what the store already knows about this project.
#
# Contract (mirrors the three capture shims):
#   - fire-and-forget: ALWAYS exits 0 — a memory recall must never block a session
#   - silent no-op on: disabled via env, empty project, provider unreachable
#     (CLI exit 3), timeout, malformed response, or zero hits
#   - on success: prints ONE compact JSON object with
#     hookSpecificOutput.additionalContext (SessionStart schema)
#
# Env knobs:
#   MEMORY_SESSIONSTART_RECALL_DISABLE=1  skip entirely
#   MEMORY_SESSIONSTART_RECALL_K          top-k hits (default 8)
#   MEMORY_SESSIONSTART_RECALL_QUERY      recall query override
#   MEMORY_SESSIONSTART_MAX_ATOM_CHARS    per-atom truncation (default 300)
#   ASTRAMEM_HOOK_DEBUG=1                 debug info on stderr
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
  PROJECT_ID="$(basename "$CWD")"
else
  PROJECT_ID="$(basename "$PWD")"
fi
[ -z "$PROJECT_ID" ] && exit 0

K="${MEMORY_SESSIONSTART_RECALL_K:-8}"
QUERY="${MEMORY_SESSIONSTART_RECALL_QUERY:-project context decisions lessons constraints state}"
MAX_CHARS="${MEMORY_SESSIONSTART_MAX_ATOM_CHARS:-300}"

if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
  printf '[astramem-hook-debug] session-start-recall: project=%s k=%s\n' "$PROJECT_ID" "$K" >&2
fi

RESP="$(bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" recall --query "$QUERY" --project "$PROJECT_ID" --k "$K" 2>/dev/null)"
RC=$?
if [ $RC -ne 0 ] || [ -z "$RESP" ]; then
  if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
    printf '[astramem-hook-debug] session-start-recall: recall failed rc=%s\n' "$RC" >&2
  fi
  exit 0
fi

# Transform hits → additionalContext. `empty` when no usable hits (prints
# nothing, exit 0). Any jq failure is swallowed — never emit partial JSON.
printf '%s' "$RESP" | jq -c \
  --arg project "$PROJECT_ID" \
  --argjson max "$MAX_CHARS" '
  [.hits[]?
    | select((.text | type) == "string" and (.text | length) > 0)
    | "- [\(.type // "note")] \(.text | gsub("\\s+"; " ") | .[0:$max])"
  ] as $lines
  | if ($lines | length) == 0 then empty else
      { hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: (
            "astramem recall (project: \($project), top \($lines | length)) — background memory from the local daemon; snapshots of when they were written, verify before acting on them:\n"
            + ($lines | join("\n"))
          )
      } }
    end
' 2>/dev/null
exit 0
