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
#   - the recall block and the agent-profile block (below) are independent:
#     either one failing/being empty never blocks the other — only total
#     silence (both empty) means no stdout at all.
#
# Env knobs:
#   MEMORY_SESSIONSTART_RECALL_DISABLE=1  skip entirely
#   MEMORY_SESSIONSTART_RECALL_K          top-k hits (default 8)
#   MEMORY_SESSIONSTART_RECALL_QUERY      recall query override
#   MEMORY_SESSIONSTART_MAX_ATOM_CHARS    per-atom truncation (default 300)
#   MEMORY_PROFILE_MAX_CHARS              agent-profile block char budget, 0=off (default 600)
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
AGENT_TYPE=""
if [ -n "$PAYLOAD" ]; then
  CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
  # Same extraction as pre-compact-capture.sh / session-end-summary.sh /
  # subagent-stop-capture.sh — reusing the one source of agent identity this
  # plugin has. In practice Claude Code never stamps agent_type on a plain
  # SessionStart payload (only on the post-hoc capture events), so this is
  # almost always empty here and the profile block below is skipped — that's
  # the documented "if none is set, skip silently" behavior, not a bug.
  AGENT_TYPE="$(printf '%s' "$PAYLOAD" | jq -r '.agent_type // empty' 2>/dev/null)"
fi

# Normalize path separators (same belt-and-suspenders as session-end-summary.sh).
if [ -n "$CWD" ]; then
  CWD="${CWD//\\//}"
fi

K="${MEMORY_SESSIONSTART_RECALL_K:-8}"
QUERY="${MEMORY_SESSIONSTART_RECALL_QUERY:-project context decisions lessons constraints state}"
MAX_CHARS="${MEMORY_SESSIONSTART_MAX_ATOM_CHARS:-300}"
PROFILE_MAX_CHARS="${MEMORY_PROFILE_MAX_CHARS:-600}"

if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
  printf '[astramem-hook-debug] session-start-recall: cwd=%s k=%s agent=%s\n' "$CWD" "$K" "$AGENT_TYPE" >&2
fi

# ---------------------------------------------------------------------------
# Part 1: project-scoped recall block (unchanged behavior from issue #31)
# ---------------------------------------------------------------------------
ARGS=(recall --query "$QUERY" --k "$K")
[ -n "$CWD" ] && ARGS+=(--cwd "$CWD")
RECALL_RESP="$(bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" "${ARGS[@]}" 2>/dev/null)"
RECALL_RC=$?

RECALL_TEXT=""
if [ $RECALL_RC -ne 0 ] || [ -z "$RECALL_RESP" ]; then
  if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
    printf '[astramem-hook-debug] session-start-recall: recall failed rc=%s\n' "$RECALL_RC" >&2
  fi
else
  # Transform hits → block text. `empty` when no usable hits. Any jq failure
  # is swallowed (2>/dev/null) — never let a malformed response leak through.
  # Note: the message no longer echoes the resolved project name — that value
  # lives solely inside the CLI's resolveProject() (issue #33) now, and
  # re-deriving it here for display would reintroduce the same drift risk we
  # just removed (e.g. an ASTRAMEM_PROJECT/config.project override wouldn't be
  # reflected in a bash-computed label).
  RECALL_TEXT="$(printf '%s' "$RECALL_RESP" | jq -r \
    --argjson max "$MAX_CHARS" '
    [.hits[]?
      | select((.text | type) == "string" and (.text | length) > 0)
      | "- [\(.type // "note")] \(.text | gsub("\\s+"; " ") | .[0:$max])"
    ] as $lines
    | if ($lines | length) == 0 then empty else
        "astramem recall (top \($lines | length)) — background memory from the local daemon; snapshots of when they were written, verify before acting on them:\n"
        + ($lines | join("\n"))
      end
  ' 2>/dev/null)"
  # jq's raw-output mode (-r) writes the string through stdio in text mode;
  # on Windows that translates the embedded \n bytes to \r\n. Strip any \r
  # so additionalContext always carries plain \n (matches the old -c/compact
  # path, which never round-tripped through raw mode and never had this).
  RECALL_TEXT="${RECALL_TEXT//$'\r'/}"
fi

# ---------------------------------------------------------------------------
# Part 2: agent-profile block — "what you (agent X) learned previously"
# ---------------------------------------------------------------------------
PROFILE_TEXT=""
if [ -n "$AGENT_TYPE" ] && [ "$PROFILE_MAX_CHARS" != "0" ]; then
  PROFILE_RESP="$(bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" agent-profile --agent "$AGENT_TYPE" 2>/dev/null)"
  PROFILE_RC=$?
  if [ $PROFILE_RC -ne 0 ] || [ -z "$PROFILE_RESP" ]; then
    if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
      printf '[astramem-hook-debug] session-start-recall: agent-profile failed/absent rc=%s agent=%s\n' "$PROFILE_RC" "$AGENT_TYPE" >&2
    fi
  else
    # Top 3-5 lessons + any corrections, then a single hard char-budget clip
    # over the whole rendered block (not per-line) — MEMORY_PROFILE_MAX_CHARS.
    PROFILE_TEXT="$(printf '%s' "$PROFILE_RESP" | jq -r \
      --argjson max "$PROFILE_MAX_CHARS" \
      --arg agent "$AGENT_TYPE" '
      ((.top_lessons // [])[0:5] | map("- " + (.text | gsub("\\s+"; " ")))) as $lessons
      | ((.corrections // [])[0:5] | map(
          "- previously wrong about: " + (.text | gsub("\\s+"; " "))
          + (if .superseding_text then " (corrected: " + (.superseding_text | gsub("\\s+"; " ")) + ")" else "" end)
        )) as $corrections
      | if ($lessons | length) == 0 and ($corrections | length) == 0 then empty else
          ("## What you (agent " + $agent + ") learned previously\n"
            + ($lessons | join("\n"))
            + (if ($corrections | length) > 0 then
                (if ($lessons | length) > 0 then "\n" else "" end) + ($corrections | join("\n"))
              else "" end)
          ) as $full
          | if $max <= 0 then empty else ($full | .[0:$max]) end
        end
    ' 2>/dev/null)"
    # See RECALL_TEXT above — strip \r introduced by jq raw-mode on Windows.
    PROFILE_TEXT="${PROFILE_TEXT//$'\r'/}"
  fi
fi

# ---------------------------------------------------------------------------
# Combine + emit — a single well-formed JSON object, or nothing at all.
# ---------------------------------------------------------------------------
COMBINED=""
if [ -n "$RECALL_TEXT" ]; then
  COMBINED="$RECALL_TEXT"
fi
if [ -n "$PROFILE_TEXT" ]; then
  if [ -n "$COMBINED" ]; then
    COMBINED="${COMBINED}"$'\n\n'"${PROFILE_TEXT}"
  else
    COMBINED="$PROFILE_TEXT"
  fi
fi

if [ -z "$COMBINED" ]; then
  exit 0
fi

# jq -n --arg safely encodes COMBINED (arbitrary text, newlines included) into
# the JSON string — no manual escaping. Swallow any jq failure (never emit
# partial/garbled JSON) and stay fail-silent per the hook contract.
jq -n -c --arg ctx "$COMBINED" '{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $ctx } }' 2>/dev/null
exit 0
