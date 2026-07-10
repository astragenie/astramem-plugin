# U3 — Plugin + cloud adopt @astragenie/astramem-contracts

Worktree: `.worktrees/u3-plugin-adopt`, branch `feat/u3-plugin-adopt-contracts` (off U0).
Program: `memory/docs/research/audit-2026-07/15-unification-program.md`.

## Prerequisites — status

- ✅ U1 (types) + U1b (Zod validators) landed on astramem-local branch
  `feat/contracts-ts-typegen`. Package `@astragenie/astramem-contracts` now ships:
  `./types` (compile-time), `./zod` (runtime `<Name>V<N>Schema`), `./schemas` (JSON), `./fixtures`.
  This is everything the plugin needs to replace its hand-rolled `src/contracts/wire.ts`.
- ⛔ **BLOCKER — consumption mechanism (needs decision).** The package is `private:true` and
  unpublished in the astramem-local repo. The plugin is a *separate repo* and cannot `import` it
  until it is reachable. Options:
  - **(A) Publish to GitHub Packages** (`@astragenie/*` already lives there — see the repo's
    NODE_AUTH_TOKEN setup). Proper, shippable. But publishing a version is an outward, immutable
    action → needs explicit user OK. Requires flipping `private:false`.
  - **(B) bun `file:` / workspace link** to `../astramemory-local/contracts`. Works on this dev
    box only; NOT shippable (breaks CI + other machines). Fine to prototype U3 locally, must
    become (A) before merge.
  Recommendation: (A) publish `@astragenie/astramem-contracts@1.0.0` to GitHub Packages.

## U3 splits — the adapter deletion is gated on cloud

- **U3a — plugin adopts (this worktree).** Replace `src/contracts/wire.ts`'s hand-rolled
  `RecallRequestSchema`/`IngestPayloadSchema`/`TranscriptIngestPayloadSchema`/`RecallResponseSchema`
  with imports from `@astragenie/astramem-contracts/zod` + `/types`. Migrate to canonical field
  names (D3): `text`/`limit`/`mode`/`filters.*`. `LocalProvider` already speaks the local daemon's
  near-canonical shape → thin/no mapping. `SaasProvider` **keeps a mapping layer** because cloud
  has not adopted yet (see U3b) — so U0's adapter *shrinks* here but does not fully delete.
- **U3b — cloud adopts (separate, large .NET slice).** Cloud C# DTOs conform to the canonical
  schemas (validate against `contracts/schemas/*` in CI; rename `query`→`text`, `top_k`→`limit`,
  `project_id`→`filters.project`, etc. — cloud's SDKs have no external consumers to protect).
  **Only when U3b lands does `SaasProvider`'s mapping fully delete.** This is the real "delete the
  adapter" milestone and it is cloud-side work, not plugin-side.

## Route sub-fork — RESOLVED (recommended)

Keep cloud's resource routes (`POST /memories`, `POST /memories/search`); unify only payload
shapes + field names. Do NOT grow `/recall`+`/remember` on cloud. U0 already points the plugin at
cloud's real routes; this keeps that valid. (Confirm if you disagree.)

## Execution order

1. Decide consumption mechanism (A publish / B file-link). ← **blocks everything below**
2. U3a: plugin depends on the package; migrate `wire.ts` to re-export canonical zod/types;
   update the two providers + tests; delete the now-duplicated local schema defs. Verify 794+ tests.
3. U3b: cloud conforms (separate branch/PR in the memory repo). Then return here and delete
   `SaasProvider`'s mapping block.
4. U4 (type taxonomy) / U5 (MCP) / U6 (version probe) per program.
