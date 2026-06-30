# FEAT 4d: Route Audience Split (v0.8.0)

**Date:** 2026-06-30
**Status:** Architect-flagged (crew:3rdparty:architect-reviewer 2026-06-30 — 2-year horizon warning); awaiting design review
**Predecessors:** FEAT 4a (v0.6.0), FEAT 4c (v0.7.0)
**Target version:** SaaS minor bump (audience namespace introduced); Plugin v0.8.0 (consumes new namespace)
**Architect verdict:** 2-year-horizon lock-in if not addressed. "Without splitting routes by audience, every future auth/quota/rate-limit change has to consider all three consumer classes."

---

## 1. Problem

`C:\work\mega\memory\src\AstraMemory.Api\Controllers\MemoriesController.cs` (20+ endpoints) mixes three consumer audiences on one controller:

1. **Web UI / human curation** — `/memories/{id}/share`, `/approve`, `/reject`, `/transition`, `/state-history`, `/report`, `/bulk-delete`
2. **Agentic dev (plugin)** — `/memories/search`, `/memories` POST, `/memories/recent`, `/memories/{id}/related`, `/memories/narrative`, `/memories/chat`, FEAT 4c additions
3. **Admin / lead operations** — `/memories/export`, `/memories/feedback`, `/admin/*` (separate controllers)

Result of conflation:
- Auth model uniform across audiences (Bearer for all). Agent token should NOT be able to call `/reject` even with valid bearer.
- Rate limits / quotas shared across consumer classes — a misbehaving web UI can starve agents.
- Future feature work has to consider all three audiences. Every PR has 3× the review burden.
- Public agentic API ambitions blocked — exposing the controller exposes admin surface.

Reviewer 2-year horizon: "Lock-in: the choice to put share/approve/transition on the same controller as search means auth, rate-limits, and quota all conflate audiences."

## 2. Goal

Split route audiences into distinct URL namespaces. Each namespace has its own auth scope, rate limit, quota policy. Future features land in the right audience by URL convention.

## 3. Non-goals

- Refactor controller class structure (one controller per audience would explode the codebase)
- Break existing web UI clients (legacy `/memories/*` aliased through one release)
- Build new endpoints (this is purely routing + auth)

## 4. Design

### 4.1 Audience namespaces

| Namespace | Audience | Auth scope | Rate limit | Quota |
|---|---|---|---|---|
| `/agent/v1/*` | Agentic dev (plugin, CLI, future MCP) | `agent:read`, `agent:write` | high QPS for boot bursts | shared per `(tenant, agent_id)` |
| `/web/v1/*` | Browser dashboard | `web:read`, `web:write` | medium QPS | shared per `(tenant, user_id)` |
| `/admin/v1/*` | Lead curation, audit | `admin:read`, `admin:write` | low QPS | unbounded for read |
| `/integrations/v1/*` | 3rd-party API (future) | scoped OAuth | strict | per-integration-id |

### 4.2 Endpoint allocation

| Existing route | New audience namespace |
|---|---|
| `POST /memories` | `POST /agent/v1/memories` AND `POST /web/v1/memories` (same handler, different auth) |
| `POST /memories/search` | `POST /agent/v1/memories/search` AND `POST /web/v1/memories/search` |
| `GET /memories/recent` | `GET /agent/v1/memories/recent` AND `GET /web/v1/memories/recent` |
| `GET /memories/{id}/related` | `GET /agent/v1/memories/{id}/related` AND `GET /web/v1/memories/{id}/related` |
| `GET /memories/narrative` | `GET /agent/v1/memories/narrative` AND `GET /web/v1/memories/narrative` |
| `POST /memories/chat` | `POST /web/v1/memories/chat` (agents are the chat — not for them) |
| `POST /memories/{id}/share` | `POST /web/v1/memories/{id}/share` (UI only) |
| `POST /memories/{id}/approve` | `POST /admin/v1/memories/{id}/approve` |
| `POST /memories/{id}/reject` | `POST /admin/v1/memories/{id}/reject` |
| `POST /memories/{id}/transition` | `POST /admin/v1/memories/{id}/transition` |
| `GET /memories/{id}/state-history` | `GET /admin/v1/memories/{id}/state-history` |
| `POST /memories/bulk` | `POST /web/v1/memories/bulk` |
| `POST /memories/bulk-delete` | `POST /admin/v1/memories/bulk-delete` |
| `GET /memories/export` | `GET /admin/v1/memories/export` |
| `POST /memories/report` | `POST /admin/v1/memories/report` |
| `POST /memories/hydrate` (FEAT 4c) | `POST /agent/v1/memories/hydrate` only |
| `POST /memories/decision` (FEAT 4c) | `POST /agent/v1/memories/decision` only |
| `PUT/GET /memories/continuation` (FEAT 4c) | `/agent/v1/memories/continuation` only |
| `POST /ingest/transcript` | `POST /agent/v1/ingest/transcript` only |
| `GET /version` | `GET /version` (no namespace — discovery) |
| `GET /health`, `GET /status`, `GET /health/ready` | no namespace — uptime checks |

### 4.3 Auth scope migration

- Add `scope` claim to JWT (Clerk session). Default `agent:read agent:write` for plugin tokens; `web:read web:write` for browser sessions; `admin:*` for lead role.
- ASP.NET attribute `[Authorize(Scopes = "agent:write")]` on `/agent/v1/*` POST routes.
- 403 returned if scope insufficient (NOT 401 — bearer is valid, just lacks permission).

### 4.4 Legacy alias period

Keep `/memories/*` (no prefix) routes functional for one release (v0.x → v0.x+1). Each legacy route:
- Logs deprecation warning to telemetry
- Returns `Deprecation: true` header with `Link: <new-url>; rel="successor-version"`
- Auth treated as web scope (most permissive — least surprising)

Removal: NLT next major. CHANGELOG documents migration table.

## 5. Test plan

- Controller routing tests — every endpoint resolves on new namespace
- Auth tests — agent token can call `/agent/v1/*`, gets 403 on `/admin/v1/*`
- Legacy alias tests — old paths still work, emit deprecation header
- Plugin update — `SaasProvider` consumes `/agent/v1/*` exclusively

## 6. Open questions

1. **Scope granularity** — coarse (`agent:read`, `agent:write`) or fine (`agent:memories:write`, `agent:transcript:write`)? Fine is RBAC overhead; coarse is enough for v1. Recommend coarse.
2. **3rd-party API timeline** — `/integrations/v1/*` namespace reserved but not opened. Worth standing up auth scaffolding now or YAGNI? Recommend reserve namespace, defer auth.
3. **`/version` and health endpoints** — should they be in a namespace? Convention says no (always at root). Confirm.
4. **Per-namespace API versioning** — does `v1` lock all endpoints in the namespace to one version, or can endpoints version independently? Recommend namespace-level versioning (simpler).
5. **OpenAPI document structure** — one spec or three (per namespace)? Reviewer recommends one spec with `tags` per audience. Easier to publish to npm package consumer.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Web UI breaks on alias removal | Legacy aliases for one release + deprecation header + CHANGELOG migration table |
| Plugin token wrong scope after migration | Clerk session claim updated server-side; plugin re-auths transparently on 403 |
| Two audiences need same endpoint (e.g. POST /memories) | Dual-route registration, single handler, audience inferred from URL prefix |
| Audit log scope confusion | Audit row tagged with namespace + scope; admin actions filterable |

## 8. Rollout

1. Define audience scopes + JWT claim shape (SaaS auth team)
2. Move endpoints to new namespaces; register legacy aliases with deprecation
3. Update plugin `SaasProvider` to use `/agent/v1/*` URLs
4. CHANGELOG migration table + READMEs
5. Plugin v0.8.0 release + marketplace bump

## 9. Dependencies

- FEAT 4a (v0.6.0) — wire-contract unified
- FEAT 4c (v0.7.0) — new agentic endpoints exist before namespacing
- Clerk session schema may need scope claim addition (verify with auth lead)
