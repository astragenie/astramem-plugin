#!/usr/bin/env bash
# subagent-stop-capture.sh — FEAT 4a Slice 4 / v0.5.5 hook resilience
# Thin shim: extract fields from hook stdin via jq, exec bin/astramem ingest-transcript.
# SubagentStop prefers .agent_transcript_path; falls back to .transcript_path.
# Fire-and-forget: exits 0 even if jq/bun fails or transcript missing.
#
# v0.5.5 additions (issue #12):
#   - Path normalization: convert backslashes to forward slashes before passing
#     to the CLI (the CLI does its own path.resolve() but belt-and-suspenders here)
#   - ASTRAMEM_HOOK_DEBUG=1: print resolved path + parent-dir listing to stderr
#     (redirected to /dev/null in normal operation; unset to expose)
#
# issue #33: project scope is no longer derived here via `basename $CWD` — that
# duplicated (and could drift from) the CLI's own default resolution. We pass
# --cwd through and let `astramem ingest-transcript` resolve the default project
# via resolveProject() (src/lib/project.ts), which is the single source of truth
# for every call site (remember/recall/ingest-transcript + all hook shims).
set +e
set -u

PAYLOAD="$(cat)"
if [ -z "$PAYLOAD" ]; then
  exit 0
fi

SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // "unknown"')"
TRANSCRIPT_PATH="$(printf '%s' "$PAYLOAD" | jq -r '(.agent_transcript_path // .transcript_path) // empty')"
CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty')"
AGENT_TYPE="$(printf '%s' "$PAYLOAD" | jq -r '.agent_type // empty')"

# Normalize path separators: Claude Code on Windows may emit backslash-escaped
# paths in JSON that jq preserves as-is. Convert \\ → / before handing to bun,
# since Node's path.resolve() handles forward-slash paths on Windows correctly.
if [ -n "$TRANSCRIPT_PATH" ]; then
  TRANSCRIPT_PATH="${TRANSCRIPT_PATH//\\//}"
fi
if [ -n "$CWD" ]; then
  CWD="${CWD//\\//}"
fi

# Debug logging: export ASTRAMEM_HOOK_DEBUG=1 to surface path resolution info.
if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
  printf '[astramem-hook-debug] subagent-stop-capture: session=%s transcript_path=%s cwd=%s\n' \
    "$SESSION_ID" "$TRANSCRIPT_PATH" "$CWD" >&2
  if [ -n "$TRANSCRIPT_PATH" ]; then
    PARENT_DIR="$(dirname "$TRANSCRIPT_PATH")"
    if [ -d "$PARENT_DIR" ]; then
      printf '[astramem-hook-debug] parent-dir contents: %s\n' "$(ls "$PARENT_DIR" 2>/dev/null | tr '\n' ' ')" >&2
    else
      printf '[astramem-hook-debug] parent-dir not found: %s\n' "$PARENT_DIR" >&2
    fi
  fi
fi

# issue #394: at-close capture. The subagent transcript (.agent_transcript_path)
# is frequently deleted by subagent/worktree cleanup before the deferred
# ingest-transcript read runs, starving ingest ("transcript file not found").
# Prefer the daemon's `astramem-local capture claude` CLI, which reads the .jsonl
# NOW (guaranteed live) and atomic-writes it to the daemon's durable ingest-spool
# (idempotency-keyed, survives daemon-down). Falls back to the legacy deferred
# ingest-transcript path when the capture subcommand isn't installed yet
# (astramem-local ships it in the FEAT-449 daemon release).
# Bound the capture call so a hung daemon CLI can never block session close
# (fire-and-forget contract). timeout exit 124 -> non-zero -> clean fallthrough.
CAPTURE_TIMEOUT=""
command -v timeout >/dev/null 2>&1 && CAPTURE_TIMEOUT="timeout 5"
if [ -n "$TRANSCRIPT_PATH" ] && command -v astramem-local >/dev/null 2>&1; then
  if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
    if $CAPTURE_TIMEOUT astramem-local capture claude "$TRANSCRIPT_PATH" --event subagent_stop >&2; then
      exit 0
    fi
  elif $CAPTURE_TIMEOUT astramem-local capture claude "$TRANSCRIPT_PATH" --event subagent_stop >/dev/null 2>&1; then
    exit 0
  fi
fi

# Fallback: legacy deferred path read (pre-FEAT-449 daemon / capture unavailable).
ARGS=(
  ingest-transcript
  --event subagent_stop
  --session-id "$SESSION_ID"
)
[ -n "$TRANSCRIPT_PATH" ] && ARGS+=(--transcript-path "$TRANSCRIPT_PATH")
[ -n "$CWD" ] && ARGS+=(--cwd "$CWD")
[ -n "$AGENT_TYPE" ] && ARGS+=(--agent-type "$AGENT_TYPE")
ARGS+=(--max-turns "${MEMORY_SUBAGENT_MAX_TURNS:-20}")
ARGS+=(--max-chars "${MEMORY_SUBAGENT_MAX_CHARS:-12000}")

if [ "${ASTRAMEM_HOOK_DEBUG:-}" = "1" ]; then
  exec bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" "${ARGS[@]}"
else
  exec bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" "${ARGS[@]}" >/dev/null 2>&1
fi
