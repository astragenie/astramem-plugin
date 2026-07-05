# Recall filter contract

There are three surfaces that accept a "recall" / "search" request today, and each
speaks a slightly different wire shape for the same underlying filters. This
document defines the **one canonical filter contract** all three should converge
on, and records where each surface currently stands relative to it.

See also: `astramem-local` `docs/recall-filters.md` (FEAT-423) — the local daemon
side of this contract, including the nested `filters` object rationale (issue #56:
sending `repo`/`project`/`agent` flat was a silent no-op).

## Canonical contract

```ts
interface RecallFilterContract {
  type?: string[];               // memory type(s) to include (OR)
  repo?: string;                 // originating repo/source identifier
  project?: string | string[];   // project/workspace scope (OR when array)
  agent?: string | string[];     // provenance agent/agent_type scope (OR when array)
  since?: string;                // ISO 8601 — only memories created/updated at or after
  as_of?: string;                // ISO 8601 — point-in-time "valid at" query (FEAT-214)
  entity?: string;                // named-entity filter
}
```

`project` and `agent` accept a single value or a list (OR semantics) as of
v0.6.0 of the plugin's `RecallRequest` schema (`src/contracts/wire.ts`).

## Mapping table

| Canonical field | Local daemon (`astramem-local` `POST /recall`) | Plugin `LocalProvider` (`src/providers/local.ts`) | Plugin `SaasProvider` (`src/providers/saas.ts`) | Memory SaaS (`POST /memories/search`, `AstraMemory.Modules.Search`) |
|---|---|---|---|---|
| `type[]` | nested `filters.type` | not yet forwarded | not yet forwarded | `types` (top-level, `string[]`) |
| `repo` | nested `filters.repo` | `filters.repo` | `source` (top-level) | `source` (top-level, single string) |
| `project` (string\|string[]) | nested `filters.project` | `filters.project` | `project_id` (top-level, string or array passed verbatim) | `project_id` (top-level, **single string only** — no array support) |
| `agent` (string\|string[]) | nested `filters.agent` | `filters.agent` | `agent` (top-level, string or array passed verbatim) — **FEAT-424, previously dropped entirely** | **not implemented.** Closest existing field is `agent_id` (top-level, single string) — no `agent` filter and no multi-value support exist yet |
| `since` | not yet forwarded | not yet forwarded | not yet forwarded | not yet forwarded |
| `as_of` | not yet forwarded | not yet forwarded | not yet forwarded | `as_of` (top-level, ISO 8601 string, FEAT-214) |
| `entity` | not yet forwarded | not yet forwarded | not yet forwarded | not yet forwarded |

## ⚠️ Caller-facing caveat — `agent` against the SaaS provider is a silent no-op today

When a caller sets `agent` on a recall that resolves to the **SaaS** provider,
the plugin forwards it but the SaaS API drops the unknown key — the caller gets
an **unfiltered** result set with **no error**. This is the same silent-no-op
class that issue #56 fixed on the local daemon (there, a wrong filter value now
correctly returns zero rather than everything). Until `astragenie/memory` grows
a canonical `agent` filter, treat `agent` as **effective only against the local
daemon provider**. (Multi-value `project` degrades the same way — see below.)

## Gaps and follow-ups

- **Memory SaaS has no `agent` filter.** The nearest field, `agent_id`
  (`AstraMemory.Modules.Search/Application/SearchQuery.cs:32`), is a single
  string with different semantics (looks like a literal agent identity filter,
  not a provenance-agent-type OR-list). Until the SaaS API grows a canonical
  `agent` filter matching this contract, `SaasProvider.recall()` forwards
  `body.agent` defensively (dead weight server-side today) so the plugin
  doesn't need another wire-shape change once SaaS catches up. Tracked in
  `astragenie/memory` — **out of scope for this repo (FEAT-424 plugin half)**.
- **`project_id` on SaaS is single-value only** — passing an array today will
  be accepted by the plugin's type system (`RecallRequest.project` is
  `string | string[]`) but the SaaS controller only reads a single string. No
  server-side breakage (unknown-shape JSON is just not bound), but multi-project
  recall silently degrades to "no filter" server-side until SaaS adds array
  support.
- **`type`, `since`, `entity` are not forwarded by either plugin provider**
  today, despite being part of the canonical contract above. Local daemon and
  SaaS already have partial support (`types`, `as_of`) that the plugin doesn't
  yet surface in `RecallRequest`. Flagged here rather than fixed — out of
  scope for FEAT-424.
