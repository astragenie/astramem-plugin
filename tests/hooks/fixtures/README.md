# Hook payload fixture corpus

**Origin:** hybrid — `hook-stdin.json` files are derived from real `.claude/logs/payloads/*subagent_stop.json` blobs (the exact JSON Claude Code writes to hook stdin), adapted to use stable fake IDs and paths. `transcript.jsonl` files are synthesized in the simple `{role, content, timestamp}` per-line format that `_ingest-transcript.sh` and `src/cli/ingest-transcript.ts` expect. Real Claude Code transcript files use an internal `{type, message:{role,...}, uuid, ...}` envelope format that the bash jq filter (`select(.role == "user")`) would silently skip — so the transcript format for these fixtures is intentionally the simple, canonical shape both the bash and TS paths were designed to consume. Pre-compact and session-end hook-stdin payloads are synthesized from the real SubagentStop shape (same field set per Claude Code hook docs); no pre-compact or session-end events were captured in `.claude/logs/payloads/` during this session.

## Field map

| Hook stdin field | CLI flag | Envelope field |
|---|---|---|
| `.transcript_path` | `--transcript-path` | _(read from disk; not in envelope)_ |
| `.session_id` | `--session-id` | `session_id` |
| `.cwd` | `--cwd` | `cwd` |
| `basename(.cwd)` | `--project-id` | `project_id` |
| `.agent_type` | `--agent-type` | `agent_type` (omitted if empty/absent) |
| _(hook script arg)_ | `--event` | `event` |
| _(computed at runtime)_ | — | `captured_at` |
| _(from plugin.json)_ | — | `client_version` |

## Sentinel placeholders

Two non-deterministic fields are replaced with literal strings before deep-equal comparison in `fixture-replay.test.ts`:

- `captured_at` → `"__SENTINEL_CAPTURED_AT__"`
- `client_version` → `"__SENTINEL_CLIENT_VERSION__"`

The test harness overwrites these two fields in the actual captured envelope before comparing against the golden JSON. All other fields are byte-identical.

## How to add a new fixture (3-step recipe)

1. **Create directory** under the appropriate event type:
   ```
   tests/hooks/fixtures/<event_type>/<NN>-<slug>/
   ```

2. **Write three files:**
   - `hook-stdin.json` — the JSON that Claude Code writes to the hook script's stdin. Required fields: `session_id`, `transcript_path` (set to `"__FIXTURE_TRANSCRIPT_PATH__"` — the test harness rewrites this to the absolute path of the fixture's `transcript.jsonl`), `cwd`, `hook_event_name`. Optional: `agent_type`, `permission_mode`, etc.
   - `transcript.jsonl` — one JSON object per line. Lines with `role: "system"` are included to exercise the role filter (they will be dropped). Only `role: "user"` and `role: "assistant"` lines appear in the golden turns. Use `content` or `text` for the message body; include `timestamp` (ISO-8601) to exercise `ts` passthrough.
   - `golden-envelope.json` — the `TranscriptIngestPayload` the CLI must produce. Set `captured_at` to `"__SENTINEL_CAPTURED_AT__"` and `client_version` to `"__SENTINEL_CLIENT_VERSION__"`.

3. **Add a test case** in `tests/hooks/fixture-replay.test.ts` following the existing pattern: read stdin, replace `transcript_path`, extract fields, run `runIngestTranscript`, compare with sentinel-substituted golden.

## Fixture index

| Path | Event | Notes |
|---|---|---|
| `pre_compact/01-basic` | pre_compact | 2 user+assistant turns, 1 system (filter exercise) |
| `pre_compact/02-multi-turn` | pre_compact | 15 turns in file; test uses `--max-turns 5`; golden has last 5 |
| `pre_compact/03-bearer-in-text` | pre_compact | 1 bearer token; golden shows `[REDACTED:bearer]`; `client_scrub_hits: 1` |
| `session_end/01-basic` | session_end | 4 user+assistant turns, 1 system |
| `subagent_stop/01-basic` | subagent_stop | empty `agent_type`; field omitted from envelope |
| `subagent_stop/02-with-agent-type` | subagent_stop | `agent_type: "crew:aiplugin-dev"` present in envelope |
