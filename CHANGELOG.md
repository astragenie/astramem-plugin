# Changelog

## [0.6.1] — 2026-07-07

Read-side session context (issue #31).

### Added
- **`SessionStart` recall hook** (`hooks/scripts/session-start-recall.sh`) — the read-side counterpart to the three capture hooks. Derives the project from `basename(cwd)` (same rule as the capture shims), runs `astramem recall --project <project> --k 8`, and injects the top hits as `hookSpecificOutput.additionalContext` with a "background memory, verify before acting" preamble. Every session now opens with what the store already knows about the project.
- Env knobs: `MEMORY_SESSIONSTART_RECALL_DISABLE=1` (skip), `MEMORY_SESSIONSTART_RECALL_K` (default 8), `MEMORY_SESSIONSTART_RECALL_QUERY` (query override), `MEMORY_SESSIONSTART_MAX_ATOM_CHARS` (default 300). `ASTRAMEM_HOOK_DEBUG=1` supported like the other shims.

### Notes
- Fire-and-forget contract, with a twist: on success the hook PRINTS one JSON object; on any failure (daemon down, zero hits, jq error, disabled) it prints NOTHING and exits 0 — partial stdout would be injected into the session as garbled context, so the failure contract is stricter than the capture shims'.
- Recall quality depends on the daemon-side distiller durability gate (astramemory-local FEAT-441 / memory#659) — low-signal atoms currently dilute the injected context; improves automatically as the gate lands.

## [0.6.0] — 2026-07-05

Project- and agent-scoped recall (astramem-local FEAT-423 / issue #56).

### Fixed
- **`recall` scoping was a silent no-op.** `LocalProvider.recall()` POSTed `repo`/`project` at the **top level**, but the daemon reads scoping under a nested `filters` object — so every `--repo`/`--project` value returned the full result set (astramem-local#56). Now builds `{ query, k, filters: { repo, project, agent } }`; an unscoped recall still omits `filters` entirely (byte-identical to before).

### Added
- **`astramem recall --agent <name>`** — filter by provenance agent/agent_type.
- **Comma-separated `--project` / `--agent`** on `recall` → array (OR-semantics), e.g. `--project runner-plugin,astramem`.
- **`astramem remember --project / --agent`** convenience flags — fold into `metadata` (explicit `--metadata` JSON keys win) so the atom is later recallable under those filters.
- **`RecallRequestSchema`** gains `agent` and array support on `project`/`agent` (`src/contracts/wire.ts`).

### Notes
- SaaS provider still maps `project → project_id` and does **not** forward `agent` — cross-provider parity tracked in astramem-local FEAT-424.
- Requires daemon astramem-local ≥ 0.7.0 for `agent` + multi-value (project filtering works against any version that honors `filters`).

## [0.5.0] — 2026-06-30

Closes out FEAT-4a Phase 3 (plugin wire-contract unification, Path 3a-saas). Daemon `astramemory-local` v0.2.0 ships in lockstep; SaaS backend `memory` PR #530 lands the canonical envelope.

### Regression Disclosure (v0.4.0)

v0.4.0 (released 2026-06-27) shipped with `saas.ts.ingestTranscript()` entirely missing. Any user with `provider: saas` (flag/env/config) lost every transcript ingest silently to a `TypeError` swallowed by the CLI's fire-and-forget catch path.

Affected versions: v0.4.0 only. Earlier versions did not have a separable SaaS provider.

Workaround: pin v0.5.0 or later. Backport to v0.4.x is recommended for sites that cannot upgrade past 0.4.x — track in backlog.

### Added
- **`wire_version` field on `TranscriptIngestPayloadSchema`** (required, regex `^v\d+\.\d+$`); `WIRE_VERSION = 'v1.0'` constant exported from `src/contracts/wire.ts`
- **Both providers emit `wire_version: "v1.0"`** on every ingest call:
  - `src/providers/local.ts`: wire_version filled in envelope at ingest site
  - `src/providers/saas.ts`: ingestTranscript() method added (was completely absent); fire-and-forget semantics; defensive wire_version fill from WIRE_VERSION constant
- **`astramem doctor` now surfaces per-alias env-deprecation hit counts** in both text and `--json` modes (new `deprecation_hits` field in JSON output listing canonical env name, deprecated alias, and hit count; sorted descending)
- **E2E test `tests/e2e/wire-flow.test.ts`** exercising selector + both providers against fake servers (9 cases):
  - auto-resolve to local, fallback to saas, flag override, env override
  - wire_version on every payload
  - bearer scrub gate (token never appears in posted JSON or stderr)
- **Cross-OS CI matrix `.github/workflows/test.yml`**: ubuntu-latest + macos-latest + windows-latest × bun latest; fail-fast off; concurrency cancel on non-main branches

### Changed
- **`TranscriptIngestPayloadSchema` now requires `wire_version`** (was missing). Plugin builds older than 0.5.0 that talked to the SaaS canonical endpoint would have been rejected; this aligns the plugin emission to match the SaaS requirement.

### Tests / CI
- 12 new assertions in `tests/contracts/transcript-wire.test.ts`, `tests/providers/local.test.ts`, `tests/providers/saas.test.ts`
- 3 new tests in `tests/cli/doctor.test.ts` for deprecation-hit surface
- 9 E2E cases in `tests/e2e/wire-flow.test.ts`
- All 7 hook golden fixtures updated to include `wire_version: "v1.0"`
- Local Windows run: 380 pass / 18 skipped / 0 fail

### Coordination
- Lands together with `astramemory-local` v0.2.0 + `memory` PR #530 (SaaS canonical envelope)
- Marketplace bump per [feedback_marketplace_bump](https://github.com/astragenie/feedback/blob/main/feedback_marketplace_bump.md): bump `astra-marketplace.version` same push as the plugin tag

### Commits
- `06d20a8` — wire_version emission on both providers + WIRE_VERSION constant + schema update
- `4db957f` — `astramem doctor` surfaces env-deprecation hit counts
- `5fb99e6` — E2E `tests/e2e/wire-flow.test.ts` (9 cases: auto-resolve, fallback, flag/env override, wire_version on every payload, bearer scrub)
- `2345a5d` — cross-OS CI matrix (ubuntu/macos/windows × bun latest)

### References
- Spec: [docs/superpowers/specs/2026-06-29-hooks-provider-migration-4a.md](docs/superpowers/specs/2026-06-29-hooks-provider-migration-4a.md)

## 0.5.0 — 2026-06-28

### Changed
- **Plugin manifest `name` re-flipped to `"astramem"`** after the `0.4.0` post-release revert
  to `"memory"`. Slash-command namespace returns to `/astramem:recall` and
  `/astramem:remember`. Users who installed `0.4.0` after the revert should reinstall under
  the `astramem` key.

### Migration
- `claude /plugin uninstall memory@astra-marketplace` (if installed under the reverted name)
- `claude /plugin install astramem@astra-marketplace`
- Any saved keybindings, hooks, or scripts referencing `/memory:recall` or
  `/memory:remember` must be updated to `/astramem:recall` and `/astramem:remember`.

## 0.4.0 — 2026-06-27

### Renamed
- **Package renamed** to `@astragenie/astramem-plugin` (was `@astragenie/memory-plugin`).
  Plugin manifest `name` changed to `"astramem"`. Slash commands: `/memory:recall` →
  `/recall`, `/memory:remember` → `/remember`.

### Migrated
- **Codebase migrated from `.mjs` → TypeScript + Bun.** All `lib/*.mjs` and `bin/*.mjs`
  files converted to `.ts` with strict-mode TypeScript. Shebang `#!/usr/bin/env bun` enables
  direct `.ts` execution — no build step, no `dist/`. Test runner changed from `node --test`
  to Vitest.

### Added
- **`bin/astramem` CLI with 7 subcommands:**
  `ingest` / `recall` / `remember` / `health` / `config` / `doctor` / `connect`.
  Run `astramem --help` for the full flag reference.
- **Provider selector** (`src/lib/selector.ts`): resolution order — `--provider` flag →
  `ASTRAMEM_PROVIDER` env → `config.json` → `auto` (probe local, fall back to SaaS).
  Probe result cached in-process for 5 seconds.
- **Unified config directory**: `~/.config/astramem/` on POSIX, `%APPDATA%\Astramem\` on
  Windows. Config, secrets, and ingest log all colocated. Legacy `~/.astramemory/` paths
  remain readable as migration fallback.
- **Bearer scrub regex** applied before every write to stdout, stderr, and `ingest.log`:
  matches `Bearer [32-128 hex chars]` and sensitive JSON keys
  (`api_key`, `token`, `bearer`, `secret`, `password`).
- **Fail-silent ingest log**: every ingest attempt (success or error) appends a scrubbed
  one-line entry to `ingest.log`. Provider errors never propagate to the calling process.
- **10 MB log rotation**: on next write when `ingest.log` exceeds 10 MB, the file is renamed
  to `ingest.log.1` (overwriting any prior backup) and a fresh log is started.
- **Back-compat bin aliases**: `astramem-login`, `astramem-refresh`, `astramem-token`,
  `astramem-connect` added as forward-compat aliases. Legacy `memory-*` bins remain working
  as shims.
- **`commands/recall.md` + `commands/remember.md`** rewritten to invoke `bin/astramem` via
  `bun ${CLAUDE_PLUGIN_ROOT}/bin/astramem recall|remember` instead of the MCP call path.
- **Cross-OS Bun CI** (Wave 4): `.github/workflows/test.yml` replaced with Bun matrix
  (`ubuntu-latest`, `macos-latest`, `windows-latest`) × (`bun 1.1.30`, `latest`).
  Steps: checkout → setup-bun@v2 → `bun install --frozen-lockfile` → `bun run typecheck`
  → `bun run test` (Vitest). `fail-fast: false`.
- **Lint workflow**: `.github/workflows/lint.yml` added — fast type-check on PR + push to
  main (ubuntu-latest, latest Bun).
- **Dependabot config**: `.github/dependabot.yml` added — npm + actions weekly updates,
  major version bumps grouped and disabled by default.

### Deprecated
- `ASTRAMEMORY_API_URL` and `ASTRAMEMORY_API_KEY` raw env vars accepted through v1.6;
  **removed at v1.7**. Migrate: run `astramem connect <code>` to write profile files.

## 0.3.2 — 2026-06-22

### Fixed
- **Hook env-resolution test harness** (FEAT-283): fixed AC13 test `bash -c` invocation — `cwd=` variable assignment before `. builtin` now uses `;` separator so `cwd` is set in the sourced shell scope (builtin prefix-assignment form does not propagate for dot/source). All 13 AC assertions now pass cross-platform.
- **CLI test infrastructure** (FEAT-282 partial): `withServer.close()` now calls `closeAllConnections()` (Node ≥18.2) before `srv.close()` so keep-alive sockets are torn down promptly on Windows; `run()` spawnSync wraps every CLI invocation with a 15s `timeout` so a stalled subprocess no longer blocks the suite for 304s; expired-path test server sends `Connection: close` header. Expired-path assertion harden + final Windows hang investigation still open.

### Added
- **CI workflow** (FEAT-283): added `.github/workflows/test.yml` with `node-tests` + `hook-tests` jobs, each on `ubuntu-latest / windows-latest / macos-latest` matrix.

## 0.3.1 — 2026-06-22

### Added
- **`memory-connect` CLI** (FEAT-279): redeems a dashboard claim code via
  `POST /claims/<code>/redeem` and stores the resulting `ApiKey` in
  `~/.astramemory/tokens.<env>.json` keyed by `workspaceId`. Fires a one-shot
  `POST /memories` handshake envelope to flip the dashboard SSE
  `first_event_received` event. Atomic write (tmp + rename) preserves existing
  workspace entries on append. `ApiKey` masked to last 4 chars in all output;
  structured JSON observability line written to stderr per attempt.
  Usage: `memory-connect <code> [--env prod] [--url <override>] [--workspace <name>]`.
  Exit codes: `0` success · `1` code expired · `2` network · `3` fs · `4` profile missing.
- **`lib/profileResolver.mjs`** (FEAT-279): shared helpers `resolveProfile(env)`,
  `resolveToken(env, workspaceId)`, `writeToken(env, workspaceId, entry)`.
  `ASTRAMEMORY_HOME` env var overrides `~/.astramemory` for tests and CI.
- **Profile-file env resolution** (FEAT-280 Part B): hook scripts now resolve
  `ASTRAMEMORY_API_URL` and `ASTRAMEMORY_API_KEY` from
  `~/.astramemory/profiles.json` + `~/.astramemory/tokens.<env>.json` written
  by `memory-connect` (FEAT-279). Resolution order: explicit env var → profile
  file → hard default. Supports multi-env workstations via `ASTRAMEMORY_ENV`
  (default `prod`).
- **Hook debug tracing**: set `ASTRAMEMORY_HOOK_DEBUG=1` to emit a one-line
  stderr log per hook fire (`[astramemory-hook] script=... env=... workspace=...
  url=... key_source=... outcome=...`). Key value is never logged.
- **`ASTRAMEMORY_API_KEY` auth path**: when no Bearer JWT is available from
  `memory-refresh`, hooks fall back to the profile-resolved API key as the
  Authorization header.

### Deprecated
- `ASTRAMEMORY_API_URL` and `ASTRAMEMORY_API_KEY` raw env vars accepted through
  v1.6 (this release). **Will be removed at v1.7.** Migrate using
  `memory-connect <code>` — see README "Pair a workstation" section.

## 0.3.0 — 2026-06-19

### Breaking
- Drop `MEMORY_API_KEY` from `.env.local` and `.env.azuredev`. All ingest traffic uses Clerk Bearer via `memory-refresh`.
- `.mcp.json` Authorization header is now `Bearer ${MEMORY_BEARER}`. Operators must export `MEMORY_BEARER` from their shell rc (e.g. `export MEMORY_BEARER="$(memory-refresh)"`). Long sessions may need a Claude Code restart when the bearer TTL expires.

### Added
- POST `/ingest/transcript` server endpoint (server work tracked separately): scrub + summary + LLM extraction of `decision` / `fact` / `lesson` / `event` atoms + graph edges (`mentions`, `relates_to`, `supersedes`).
- `SubagentStop` hook captures Task-agent transcript tails.
- Client-side regex scrub (JWT / AWS / Anthropic / generic secret patterns) with hit count reported to server.
- Client-side retry (default 2) on 5xx / network errors. 4xx is final.

### Changed
- `pre-compact-capture.sh` and `session-end-summary.sh` now delegate to `_ingest-transcript.sh`. They no longer POST directly to `/memories`.
