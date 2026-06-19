# AstraMemory transcript ingest — production hardening

Date: 2026-06-19
Status: Draft (awaiting user review)
Scope: `astramemory-plugin` repo + `memory` (AstraMemory service) repo

## Problem

The plugin already ships `PreCompact` and `SessionEnd` hooks that POST the last
N transcript turns to AstraMemory as a single `type=summary` memory. Two gaps
prevent calling it production-ready:

1. **Summary memories are opaque.** The graph holds large blobs that recall
   pulls back verbatim. No durable atoms (decisions, facts, lessons, events)
   are extracted, so the memory graph cannot do its job: surface the right
   prior decision when a future session asks about it.
2. **Auth and reliability drift.** Hooks send `Authorization: ApiKey ...` while
   `.env.local` documents Bearer-only and a `memory-refresh` CLI ships. `.mcp.json`
   still uses ApiKey. No client-side retry. No PII scrub. `SubagentStop` is not
   wired despite carrying high-signal structured work from crew/runner agents.

Goal: turn raw chat history flowing through the plugin into a useful memory
graph — typed memories with edges to prior knowledge — without blocking
compaction or session shutdown.

## Architecture

```
┌─────────────────────┐                                  ┌─────────────────────────────────────┐
│  Claude Code        │                                  │  AstraMemory service                │
│  (Windows / WSL)    │                                  │  (Azure dev → prod gateway)         │
│                     │                                  │                                     │
│  ┌──────────────┐   │   POST /ingest/transcript        │  ┌──────────────────────────────┐   │
│  │ PreCompact   │──┐│   { event, turns[], project,     │  │ TranscriptIngestController   │   │
│  │ SessionEnd   │  ├┼──>│  session, cwd, agent? }    ──>│  │ (NEW)                        │   │
│  │ SubagentStop │──┘│   Authorization: Bearer <jwt>    │  └──────────────┬───────────────┘   │
│  └──────────────┘   │                                  │                 │                   │
│                     │                                  │   1. client-scrub already done      │
│  client-side scrub  │                                  │   2. server-scrub (regex pass)      │
│  (regex secrets)    │                                  │   3. store raw → memories(summary)  │
│                     │                                  │   4. invoke extractor (sync v1)     │
│  memory-refresh     │                                  │                 │                   │
│  (Clerk Bearer)     │                                  │                 v                   │
│                     │                                  │  ┌──────────────────────────────┐   │
│  retry: 2 tries     │                                  │  │ TranscriptExtractor          │   │
│  (configurable)     │                                  │  │ emits: decision/fact/        │   │
│                     │                                  │  │        lesson/event          │   │
│                     │                                  │  └──────────────┬───────────────┘   │
│                     │                                  │                 v                   │
│                     │                                  │  ┌──────────────────────────────┐   │
│                     │                                  │  │ MemoryGraphLinker            │   │
│                     │                                  │  │  - resolve FEAT/PR/SPEC ids  │   │
│                     │                                  │  │  - embed + cosine top-K      │   │
│                     │                                  │  │  - write supersedes /        │   │
│                     │                                  │  │    relates_to / mentions     │   │
│                     │                                  │  └──────────────────────────────┘   │
└─────────────────────┘                                  └─────────────────────────────────────┘
```

Three layers split clean:

1. **Plugin** — capture, scrub, auth, single POST with retry. No LLM client-side.
2. **Service** — ingest controller stores raw + runs extractor.
3. **Extractor + graph linker** — LLM extraction + edge writes.

## Endpoint contract

**`POST /ingest/transcript`** on `AstraMemory.Api`.

Request body:

```json
{
  "event": "pre_compact | session_end | subagent_stop",
  "project_id": "astramemory-plugin",
  "session_id": "abc-123",
  "agent_type": "crew:inspector",
  "cwd": "/c/work/mega/astramemory-plugin",
  "captured_at": "2026-06-19T14:22:10Z",
  "turns": [
    { "role": "user",      "text": "...", "ts": "2026-06-19T14:20:01Z" },
    { "role": "assistant", "text": "...", "ts": "2026-06-19T14:20:18Z" }
  ],
  "client_scrub_applied": true,
  "client_scrub_hits": 2,
  "client_version": "0.3.0"
}
```

`agent_type` only present for `event=subagent_stop`.

Response:

- **Phase 1 (synchronous extraction)**: `200 OK` — extraction already
  committed before response. `extraction_job_id` references the completed
  job for audit. Body contains the extracted-item count.
- **Phase 4 (async queue)**: `202 Accepted` — extraction pending; client
  polls `/extractions/jobs/{id}` for status. Body shape unchanged.

```json
{
  "summary_memory_id": "uuid",
  "extraction_job_id": "uuid",
  "extracted_count": 3,
  "scrub_hits": { "client": 2, "server": 0 },
  "queued_extraction_types": ["decision", "fact", "lesson", "event"]
}
```

Headers:

- `Authorization: Bearer <clerk-jwt>` — required. ApiKey rejected on this route.
- `Idempotency-Key` — optional. Server stores key + session + event for 24 h;
  replay returns prior response untouched.

Limits:

| Limit | Value | Behavior on breach |
|-------|-------|--------------------|
| `turns[]` length | 200 | Truncate (keep newest) |
| per-turn `text` | 8 KiB after server scrub | Truncate with `…[truncated]` marker |
| request body | 256 KiB | 413 `payload_too_large` |
| rate (per-user, per-event) | 10 / min | 429 with `Retry-After` |
| rate (per-user, daily)    | 1000 / day | 429 |

Errors:

| Status | Code | Meaning |
|--------|------|---------|
| 401 | `unauthenticated` | Missing or expired Bearer |
| 413 | `payload_too_large` | Body cap exceeded |
| 422 | `invalid_event` | Unknown `event` value |
| 429 | `rate_limited` | Per-user cap hit |
| 503 | `extraction_unavailable` | LLM provider down. Raw summary still stored; client treats as success unless retrying. |

## TranscriptExtractor

New `ITranscriptExtractor` in `AstraMemory.Application`. Sibling of existing
`IEngineeringExtractionService` but emits 4 types we picked instead of
`adr/backlog/code_summary/open_question`.

System prompt:

```
You extract durable engineering memory from a developer's chat transcript with an AI assistant.
Identify and emit JSON array of items, each one of these types:

- "decision": a deliberate choice with rationale. "We chose X over Y because Z."
                Includes ADR-style architecture choices, library picks, scope cuts.
- "fact":     a stable repo/system truth worth remembering. Endpoints, paths,
                config values, who-owns-what, versions. NOT ephemeral state.
- "lesson":   a learning from failure or surprise. "X breaks on Windows because Y."
                "Don't pass ApiKey + Bearer simultaneously."
- "event":    a time-bound milestone. Releases, renames, deletions, merges,
                production incidents.

For each item return:
{
  "type": "decision|fact|lesson|event",
  "title": "≤100 chars",
  "content": "1–3 paragraphs, self-contained — readable months later",
  "importance": 0.0–1.0,
  "entity_refs": ["FEAT-172", "PR-#14", "SPEC-002", "src/foo.cs", "/health"],
  "supersedes_hint": "free-text describing what prior memory this overrides, or null"
}

Rules:
- Skip ephemeral chatter, tool output, error stack traces unless they map to a lesson.
- Skip secrets, API keys, personal data — these have already been scrubbed but double-check.
- Prefer 0 high-quality items over 10 weak items. Empty array is fine.
- Each item must stand alone. No "as discussed above".
```

LLM: reuse `ILlmCompletionProvider`. Single shot per chunk. Long transcripts
split into ~6 KiB windows with 500-char overlap. Server limits chunks to 8 per
request to bound cost.

Auto-accept policy:

- `decision`, `fact`, `event` with `importance ≥ 0.7` and at least one resolved
  `entity_ref` → write directly into `memories`.
- Everything else → write into `pending_extractions` (existing
  `EngineeringExtractionEntity` flow), surfaced via existing `/extractions` API
  for human accept/reject.

## MemoryGraphLinker

Runs after extractor commits new memories. Three passes:

1. **Entity-ref pass** (deterministic, cheap).
   For each `entity_refs[]` value:
   - `FEAT-NNN` / `SPEC-NNN` / `PR-#NNN` → exact-match search on existing
     memory `title` + `content`. Write `mentions` edge.
   - File path (contains `/` or `\`) → match on memories tagged with same path.

2. **Similarity pass** (no LLM, embeddings only).
   Compute embedding of new memory `content` via existing `IEmbeddingProvider`.
   Cosine top-5 against existing memories scoped to same `project_id`.
   Write `relates_to` edge if cosine ≥ 0.82.

3. **Supersedes pass** (only when `supersedes_hint` non-null).
   Embed hint, search project for top-1 cosine ≥ 0.78. Write `supersedes` edge
   + mark prior memory `superseded_at = now()`. Conservative threshold —
   false positives erase memory.

Storage: use `IMemoryGraphService` if present. Else add new table
`memory_edges(src_id uuid, dst_id uuid, kind text, confidence real, created_at timestamptz)`
with a single index on `(src_id, kind)` and a unique constraint on
`(src_id, dst_id, kind)`.

## Plugin-side changes

### New helper: `hooks/scripts/_ingest-transcript.sh`

Sourced by all three hook scripts. Responsibilities:

1. Read JSON payload from stdin (Claude Code hook contract).
2. Source `_load-env.sh` (existing).
3. Resolve Bearer via `${CLAUDE_PLUGIN_ROOT}/bin/memory-refresh`. Empty/error
   → `exit 0` quietly (first-run user hasn't done `memory-login` yet).
4. Tail last N turns from `transcript_path` via `jq`, emit array of
   `{role, text, ts}` objects (NOT the flattened string today's scripts emit).
5. **Client scrub** via `sed` regex pass:
   - JWT tokens: `eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+`
   - AWS keys: `AKIA[0-9A-Z]{16}`
   - Anthropic/OpenAI keys: `sk-(?:ant-)?[A-Za-z0-9_-]{20,}`
   - Generic: `(?i)(api[_-]?key|secret|password|token)\s*[:=]\s*['\"]?[A-Za-z0-9_\-./+=]{16,}`

   Replace each with `[redacted:<kind>]`. Count hits, include in payload as
   `client_scrub_applied: true`, `client_scrub_hits: N`.
6. Build full payload JSON via `jq -n` matching the contract above.
7. POST with retry: `MEMORY_INGEST_RETRIES` total attempts (default 2,
   configurable). Sleep `MEMORY_INGEST_RETRY_SLEEP` seconds (default 1) between.
   - 2xx (200, 202) → success.
   - 4xx → final, no retry (payload bad, not transient).
   - 5xx or network error → retry until budget exhausted.
8. Always `exit 0`. Never block compaction / session-end on memory plumbing.

### Refactored hook scripts

- `pre-compact-capture.sh` → calls `_ingest-transcript.sh` with `event=pre_compact`, MAX_TURNS=20.
- `session-end-summary.sh` → calls helper with `event=session_end`, MAX_TURNS=40.
- `subagent-stop-capture.sh` (NEW) → calls helper with `event=subagent_stop`, MAX_TURNS=12, reads `agent_type` from payload if present. If Claude Code's `SubagentStop` payload omits the agent type (verify against the live hook contract before coding), the field is sent as `null` and the server treats `subagent_stop` events without `agent_type` as anonymous subagent runs — still useful, just no per-agent breakdown.

### `hooks.json`

Add `SubagentStop` block pointing at `subagent-stop-capture.sh`.

### `.mcp.json`

Replace `"Authorization": "ApiKey ${MEMORY_API_KEY}"` with
`"Authorization": "Bearer ${MEMORY_BEARER}"`. README updated to explain that
`MEMORY_BEARER` is sourced from `memory-refresh` (already-documented
`.env` / `direnv` pattern applies).

**Known limitation:** Claude Code resolves `${...}` in `.mcp.json` from the OS
environment at plugin load, and `memory-refresh` produces a token that lives
~1 hour. Practical implications:

- The MCP transport's Bearer is the snapshot taken at Claude Code launch.
  Long sessions can exceed the token TTL; the MCP server then sees 401 and
  the user must restart Claude Code OR run `memory-refresh` then restart.
- Hook scripts are immune: they call `memory-refresh` on each invocation, so
  hook traffic always carries a fresh Bearer.
- A future iteration (out of scope here) could ship a small token agent or
  Clerk client-credentials flow keyed to the user, but the current
  `.env` + `direnv` pattern stays for v1.

### Env vars

Add to `.env.local` + `.env.azuredev`:

```
MEMORY_INGEST_RETRIES=2
MEMORY_INGEST_RETRY_SLEEP=1
MEMORY_SUBAGENT_MAX_TURNS=12
MEMORY_SUBAGENT_MAX_CHARS=8000
```

Drop `MEMORY_API_KEY` from both `.env.*`.

### Tests

Under `tests/`:

- `ingest-scrub.test.mjs` — feed strings with JWT / AKIA / `sk-ant-` / `api_key=...`,
  assert each redacted to `[redacted:<kind>]`.
- `ingest-retry.test.mjs` — mock fetch returning 503 then 202, assert exactly
  1 retry occurred; mock returning 503 twice, assert exactly 2 retries (default).
- `ingest-payload.test.mjs` — assert produced payload matches the contract:
  required fields present, `turns[]` shape, `client_scrub_applied` flag.

## Rollout

Three independently shippable phases.

### Phase 1 — Server `/ingest/transcript` endpoint (memory repo)

- `TranscriptIngestController` + request DTO.
- Stores raw turns as `type=summary` memory (preserves current behavior).
- Invokes extractor synchronously in v1 (returns once extractor commits;
  async queue is Phase 4).
- Server scrub pass.
- Idempotency cache (in-memory `ConcurrentDictionary`, 24 h TTL; Redis-backed later).
- Rate limiter via existing middleware.
- Auth: Bearer-only via existing Clerk middleware.

### Phase 2 — Server `TranscriptExtractor` + graph linker (memory repo)

- New `ITranscriptExtractor` service.
- `MemoryGraphLinker` with entity-ref + similarity + supersedes passes.
- Reuse `IMemoryGraphService` if present; add `memory_edges` table if not.
- EF Core migration for any new tables.
- Tests: prompt golden file, deterministic linker tests with fixed embeddings,
  integration test happy path.

### Phase 3 — Plugin client work (this repo)

- `_ingest-transcript.sh` helper with scrub + retry + Bearer.
- Refactor `pre-compact-capture.sh` + `session-end-summary.sh` to call helper.
- New `subagent-stop-capture.sh`.
- `hooks.json` adds `SubagentStop`.
- `.mcp.json` swaps ApiKey → Bearer.
- Drop `MEMORY_API_KEY` from `.env.*`.
- New env vars documented in README.
- Tests: scrub, retry, payload shape.
- Bump plugin version 0.2.0 → 0.3.0 (breaking: ApiKey path removed).

### Phase 4 — Async extraction queue (deferred)

Move extraction off request path to background worker. Endpoint returns 202
immediately with `extraction_job_id`. `/extractions/jobs/{id}` for status. Skip
for v1 — synchronous is fine until traffic warrants the move.

## Migration / breaking changes

- Plugin v0.3.0 drops `MEMORY_API_KEY`. Users on `azuredev` who haven't run
  `memory-login` see hooks silently skip. README updated with one-line bootstrap.
- Server `/memories` POST still accepts ApiKey for back-compat.
  `/ingest/transcript` is Bearer-only from day one.

## Out of scope

- Disk spool / offline retry (fire-and-forget chosen).
- `task_result` memory type (4-type set chosen).
- PowerShell-native hooks (Git Bash assumption stays).
- `Stop` event hook (high volume, skipped — `SubagentStop` covers structured work).
- Frontend UI for `/extractions` pending review (already exists per existing controllers).

## Assumptions confirmed by existing code

1. Endpoint base path lives under `AstraMemory.Api`; plugin's `MEMORY_API_URL`
   already routes there via YARP `/memory-api`.
2. Extractor reuses configured `ILlmCompletionProvider` (same as
   existing `EngineeringExtractionService`).
3. Tenant resolution via existing `HttpContext.GetTenantContext()` from Clerk
   JWT claim.
4. Embedding model reuses configured `IEmbeddingProvider`.

## Success criteria

- A session that includes 1+ deliberate decisions ("we chose Bearer over ApiKey
  because …") produces a `type=decision` memory linked to prior `FEAT-*` /
  `SPEC-*` memories via `mentions` edges.
- Hooks never block compaction; `exit 0` on every failure path.
- Network outage during POST results in at most 2 client retries, then quiet drop.
- Secrets-shaped strings never reach server in cleartext (client scrub catches
  the obvious cases; server scrub is the safety net).
- `subagent-stop-capture.sh` fires on `Task` agent completion and produces a
  scoped memory tagged with `agent_type`.
- `.mcp.json` works with Bearer in `azuredev` profile against the live gateway.
