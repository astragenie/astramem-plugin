# FEAT 4c: Agentic API Extension (v0.7.0)

**Date:** 2026-06-30
**Status:** Architect-reviewed (crew:3rdparty:architect-reviewer 2026-06-30); awaiting build
**Predecessor:** FEAT 4a (hooks + wire-contract unification, v0.6.0)
**Successor:** FEAT 4d (route audience split, v0.8.0)
**Target version:** Plugin v0.7.0, SaaS minor bump, daemon v0.3.0
**Architect verdict:** Reviewer P0 — `/memories/hydrate` is the missing primitive that makes agentic UX feel fast. P1 — typed `/memories/decision` + `/memories/continuation` close the cross-session gap. P2 — plugin slash commands + provider surface expansion.

---

## 1. Problem

FEAT 4a ships hooks migration + wire-contract unification. Plugin SaaS provider gains `recall`, `remember`, `ingestTranscript` — but reviewer finding shows agent session-boot UX is broken by design without new primitives:

1. **No session-boot bundle endpoint.** Agent boot today requires 3 sequential SaaS calls (`recent` + `search` + `narrative`) to hydrate context. At 10 agents × 3 sessions/day × 3 calls = monthly quota burn by lunch. Latency budget at session boot — the worst possible time to be slow.

2. **No typed decision endpoint.** Plugin sends raw `remember(text)` for everything. `StoreMemoryRequest.cs:21-31` already has `decision_basis`, `source_excerpt`, `confidence` fields, but the generic `POST /memories` doesn't *require* them. Agents skip the discipline.

3. **No cross-session continuation cursor.** "What was I working on" requires every agent to re-derive from raw recents. No primitive for `(tenant, project, agent) → {last_session_id, last_activity_at, summary}`.

4. **Existing rich SaaS endpoints unused.** `GET /memories/recent`, `GET /memories/{id}/related`, `GET /memories/narrative` already implemented + deployed. Plugin doesn't wire any of them. Agents lack "what happened lately," "follow-the-thread," and "catch me up" verbs.

5. **Plugin slash command surface too thin.** `/astramem:recall` + `/astramem:remember` are core but miss the killer agent verb: `/hydrate` for cold session boot.

## 2. Goal

Make agentic dev feel fast + smart from session boot. One server-curated hydrate call replaces 3 client calls. Typed decision capture forces rationale. Continuation cursor enables genuine cross-session continuity. Plugin provider + slash commands expose these as first-class agent verbs while server stays REST-conventional (anti-corruption layer pattern).

## 3. Non-goals (v0.7.0)

- Route audience split (`/agent/v1/*` vs `/admin/v1/*`) — deferred to FEAT 4d
- Smart inject (intent-aware curation without explicit query) — premature ML; wait for telemetry on what helps
- Memory subscription (SSE/websocket for cross-agent events) — YAGNI until multi-agent collaboration is on the roadmap
- Chat endpoint adoption (`POST /memories/chat`) — agents ARE the chat; no proxy
- Admin endpoint exposure (share/approve/reject/transition/state-history/bulk-delete/report) — blast-radius risk if agents call. Lead-only via web UI.

## 4. Design

### 4.1 SaaS new endpoints (3)

#### 4.1.1 `POST /memories/hydrate` — session-boot bundle (P0)

Single call returns curated context for agent session boot.

**Request:**
```json
{
  "project_id": "string",
  "agent_id": "string?",
  "cwd": "string?",
  "repo": "string?",
  "hint": "string?",      // optional task description
  "k_relevant": 10,        // hybrid search result count, default 10
  "k_recent": 20           // recent items count, default 20
}
```

**Response:**
```json
{
  "recent": [MemoryItem, ...],          // last k_recent decisions/events in project
  "relevant": [SearchHit, ...],         // hybrid search vs cwd+repo+hint
  "narrative": "string",                 // one-paragraph "where you left off"
  "continuation": {                      // null if no prior session
    "last_session_id": "string",
    "last_activity_at": "ISO-8601",
    "summary": "string"
  } | null,
  "quota_consumed": 1                    // billable as ONE call (key trade-off, §6 below)
}
```

**Server logic:**
1. Filter memories by `(tenant, project_id)` — `agent_id` wildcard if absent (cross-agent visibility within project)
2. Recent: `GET /memories/recent` semantics, project-scoped, limit k_recent
3. Relevant: hybrid search vs `hint || repo || cwd`, limit k_relevant
4. Narrative: invoke existing `/memories/narrative` handler internally with project context
5. Continuation: read from `continuation` table (FEAT 4c §4.1.3)
6. Quota: counts as 1 call. Cheaper than 3 separate.

Handler file: `C:\work\mega\memory\src\AstraMemory.Api\Controllers\MemoriesController.cs` (add to existing controller). DTO at `C:\work\mega\memory\src\AstraMemory.Api\Models\HydrateRequest.cs` + `HydrateResponse.cs`.

#### 4.1.2 `POST /memories/decision` — typed-store sugar with required rationale (P1)

Forces agents to capture decisions WITH reasoning, not just text.

**Request:**
```json
{
  "project_id": "string",
  "agent_id": "string?",
  "decision_text": "string",          // required: what was decided
  "decision_basis": "string",          // required: why
  "source_excerpt": "string?",         // optional: quote from transcript or code
  "confidence": 0.0-1.0,               // required: 0-1
  "alternatives_considered": ["..."],  // optional: rejected options
  "supersedes_memory_id": "uuid?"      // optional: previous decision this overrides
}
```

**Response:** `MemoryItem` (created memory).

Server logic: same path as `POST /memories` but with `type: "decision"` hardcoded, rationale fields required by validation. Sugar — not a new storage class.

#### 4.1.3 `PUT /memories/continuation` + `GET /memories/continuation?project_id=` — per-context cursor (P1)

**PUT request:**
```json
{
  "project_id": "string",
  "agent_id": "string?",
  "last_session_id": "string",
  "last_activity_at": "ISO-8601",
  "summary": "string"
}
```

**GET response:**
```json
{
  "last_session_id": "string" | null,
  "last_activity_at": "ISO-8601" | null,
  "summary": "string" | null,
  "updated_at": "ISO-8601" | null
}
```

New table `memory_continuation`:
```sql
CREATE TABLE memory_continuation (
  tenant_id UUID NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  last_session_id TEXT NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  summary TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, project_id, agent_id)
);
```

PUT is upsert. GET returns null fields if no row.

### 4.2 Plugin provider surface expansion

File: `C:\work\mega\astramemory-plugin\src\providers\saas.ts` + `local.ts`. Add 4 methods to `MemoryProvider` interface:

```ts
interface MemoryProvider {
  // existing
  recall(req: RecallRequest): Promise<RecallResponse>;
  remember(req: IngestPayload): Promise<void>;
  ingestTranscript(req: TranscriptIngestPayload): Promise<void>;
  health(): Promise<HealthResponse>;

  // NEW (FEAT 4c)
  hydrate(req: HydrateRequest): Promise<HydrateResponse>;
  recent(req: RecentRequest): Promise<RecentResponse>;
  related(req: RelatedRequest): Promise<RelatedResponse>;
  narrative(req: NarrativeRequest): Promise<NarrativeResponse>;
}
```

**SaaS provider wiring:**

| Method | URL | Wraps existing? |
|---|---|---|
| `hydrate` | `POST /memories/hydrate` | NEW endpoint (§4.1.1) |
| `recent` | `GET /memories/recent` | EXISTS (`MemoriesController.cs:196`), wire it |
| `related` | `GET /memories/{id}/related` | EXISTS, wire it |
| `narrative` | `GET /memories/narrative` | EXISTS, wire it |

**Local daemon wiring (deferred to v0.3.0+):** daemon stubs these endpoints initially. Returns `{}` / empty arrays. Real implementation lands when daemon v0.4.0 adds extraction-aware queries.

**`decide` method:** add to plugin as sugar over `remember` (sends `POST /memories/decision` on SaaS, falls back to `remember(type=decision)` on daemon). Plugin-side helper, not a provider method.

### 4.3 Plugin slash commands (3 new)

Files at `C:\work\mega\astramemory-plugin\commands\`:

#### 4.3.1 `/astramem:hydrate` — session-boot context (KILLER COMMAND)

Calls `provider.hydrate({project_id: <basename(cwd)>, agent_id: 'claude-code', cwd: <cwd>, repo: <git remote>, hint: $ARGUMENTS})`. Formats response into compact markdown:

```markdown
## Where you left off
{narrative}

## Last session
{continuation.summary} — {continuation.last_activity_at}

## Recent decisions
- {recent[0].text}
- ...

## Relevant context
- {relevant[0].text} (score {relevant[0].score})
- ...
```

Dumps into agent context. Triggers automatically via SessionStart hook (optional config flag `MEMORY_AUTO_HYDRATE=1`, default off).

#### 4.3.2 `/astramem:decide <decision>` — typed decision capture

Prompts agent for rationale fields. Argv: free-text decision. Workflow:
1. Agent reads `$ARGUMENTS` as decision_text
2. Agent generates `decision_basis` from current context
3. Agent generates `source_excerpt` if available from recent transcript
4. Agent estimates confidence
5. CLI calls `POST /memories/decision` with full payload

#### 4.3.3 `/astramem:continue` — read cursor + last 5 recents

Calls `GET /memories/continuation` + `GET /memories/recent?project_id=&limit=5`. Formats as narrative:

```markdown
Last activity: {continuation.summary} ({continuation.last_activity_at})

Recent context:
1. {recent[0].text}
2. {recent[1].text}
...
```

### 4.4 Plugin CLI subcommands

Add to `bin/astramem`:
- `astramem hydrate` — invokes `provider.hydrate(...)`, prints JSON
- `astramem decide --text <s> --basis <s> [--confidence <n>] [--excerpt <s>]`
- `astramem continue [--project <s>]` — reads cursor + recents

## 5. Test plan

- SaaS: handler tests for hydrate/decision/continuation. Quota assertion (hydrate = 1 call).
- SaaS: contract tests against OpenAPI for new endpoints.
- Plugin: provider tests for hydrate/recent/related/narrative methods (mock HTTP).
- Plugin: CLI tests for new subcommands.
- Plugin: slash command end-to-end tests (mock daemon + recorded SaaS fixtures).
- Daemon: stub endpoint return-empty tests.

## 6. Open questions

1. **Quota model for `/hydrate`** — count as 1 search or 3 (recent + search + narrative)? Reviewer recommends 1 (incentivize use). Counter: hidden cost of curation may need 3-call billing for fairness. **Lead decision.**
2. **`continuation` table — auto-populate or explicit PUT?** Auto: server writes continuation row on every transcript ingest using `event=session_end`. Explicit: client must call PUT. Auto = better UX, no client coordination. Recommend auto.
3. **`/hydrate` cache TTL** — server-side cache curated bundle per `(project, agent)` for N seconds? Reduces quota burn on session-rapid-restart scenarios. Default: no cache. Add later if metrics show repeat hydrate within <60s.
4. **`/astramem:hydrate` auto-fire** — `SessionStart` hook calls hydrate automatically if `MEMORY_AUTO_HYDRATE=1`. Default off to preserve user agency, or default on so agentic UX is good out-of-the-box? Recommend default OFF in v0.7.0, flip to ON in v0.8.0 once stability is proven.
5. **Cross-tenant boundaries on `/hydrate`** — what if agent_id matches across tenants? Should be impossible (tenant_id filter enforced via auth context), but worth explicit test.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Hydrate endpoint latency (3 sub-queries in one call) | Parallelize sub-queries server-side. P95 budget ≤300ms cold. |
| Decision endpoint adoption — agents skip rationale fields if "forced" | Sugar layer client-side: agent prompts user for missing fields before send. |
| Continuation cursor staleness | Auto-populate via session_end ingest (see §6.2). |
| Plugin slash command discoverability | README + `/astramem help` lists all commands. |
| Local daemon stub returns empty | Document in CHANGELOG: agentic features SaaS-only until daemon v0.4.0. |

## 8. Rollout

1. SaaS endpoints + DTOs + OpenAPI + tests → merge `memory` repo
2. Daemon stubs → merge `astramemory-local` repo
3. Plugin provider methods + CLI + slash commands → merge `astramemory-plugin` repo
4. Plugin v0.7.0 release + marketplace bump

Phase order strict — SaaS endpoints must exist before plugin wires to them.

## 9. Dependencies

- FEAT 4a (v0.6.0) must ship first — wire-contract unification is prerequisite
- FEAT 4d may run in parallel — different concern (route audience split)
