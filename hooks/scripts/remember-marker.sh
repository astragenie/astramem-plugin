#!/usr/bin/env bash
# remember-marker.sh — issue #40: inline "🧠 memory saved" marker.
#
# PostToolUse shim for the daemon's `remember` MCP tool (and the plain
# "remember" tool-name variant, belt-and-suspenders). Reads the saved
# count/type off the tool response, formats a one-line marker via the shared
# core (src/lib/save-marker.ts), and echoes it back as a hook systemMessage
# so the save is visible inline instead of silent.
#
# Scope: deterministic remember-tool calls only. PreCompact/SubagentStop
# transcript-capture markers are OUT OF SCOPE — see CLAUDE.md's "Inline save
# marker" section for why (ingestTranscript() is fire-and-forget with async
# daemon distillation, no synchronous per-type count to format here).
#
# Fire-and-forget: never blocks the tool call, always exits 0.
#
# Env knobs:
#   MEMORY_SAVE_MARKER=0    disable the marker (default: on)
#   ASTRAMEM_HOOK_DEBUG=1   debug info on stderr
set +e
set -u

if [ "${MEMORY_SAVE_MARKER:-}" = "0" ]; then
  exit 0
fi

PAYLOAD="$(cat)"
if [ -z "$PAYLOAD" ]; then
  exit 0
fi

TOOL_NAME="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)"
case "$TOOL_NAME" in
  remember|mcp__astramem__remember) ;;
  *) exit 0 ;;
esac

# `tool_response` is the documented PostToolUse field; fall back to
# `tool_result` in case a Claude Code build surfaces it under that name.
RESP="$(printf '%s' "$PAYLOAD" | jq -c '.tool_response // .tool_result // {}' 2>/dev/null)"
[ -z "$RESP" ] && RESP='{}'

# A failed remember saved nothing — bail out silently rather than emit a
# marker for zero atoms.
IS_ERROR="$(printf '%s' "$RESP" | jq -r '(.isError // .is_error // (.ok == false)) // false' 2>/dev/null)"
if [ "$IS_ERROR" = "true" ]; then
  exit 0
fi

INPUT="$(printf '%s' "$PAYLOAD" | jq -c '.tool_input // {}' 2>/dev/null)"
[ -z "$INPUT" ] && INPUT='{}'

# Prefer a structured by_type breakdown if the tool response already carries
# one (mirrors `astramem remember`'s own CLI stdout — see
# src/lib/save-marker.ts). Otherwise fall back to the deterministic
# invariant a single remember call always saves exactly one atom of the
# requested type (default "fact", matching the CLI default).
BY_TYPE_JSON="$(printf '%s' "$PAYLOAD" | jq -c --argjson resp "$RESP" --argjson input "$INPUT" '
  if ($resp.by_type? and ($resp.by_type | type) == "object") then
    $resp.by_type
  else
    ($resp.type // $input.type // $input.arguments.type // "fact") as $type
    | { ($type): (if ($resp.saved | type) == "number" then $resp.saved else 1 end) }
  end
' 2>/dev/null)"
if [ -z "$BY_TYPE_JSON" ]; then
  exit 0
fi

if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
  printf '[astramem-hook-debug] remember-marker: tool=%s by_type=%s\n' "$TOOL_NAME" "$BY_TYPE_JSON" >&2
fi

MARKER="$(BY_TYPE_JSON="$BY_TYPE_JSON" bun -e '
const mod = await import(`${process.env.CLAUDE_PLUGIN_ROOT}/src/lib/save-marker.ts`);
const byType = JSON.parse(process.env.BY_TYPE_JSON || "{}");
const marker = mod.formatSaveMarker(byType);
if (marker) process.stdout.write(marker);
' 2>/dev/null)"

if [ -z "$MARKER" ]; then
  exit 0
fi

jq -cn --arg msg "$MARKER" '{systemMessage: $msg}'
exit 0
