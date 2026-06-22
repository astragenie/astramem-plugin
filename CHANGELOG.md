# Changelog

## 0.4.1 — 2026-06-22

### Fixed
- **Hook env-resolution test harness** (FEAT-283): fixed AC13 test `bash -c` invocation — `cwd=` variable assignment before `. builtin` now uses `;` separator so `cwd` is set in the sourced shell scope (builtin prefix-assignment form does not propagate for dot/source). All 13 AC assertions now pass cross-platform.
- **CLI test infrastructure** (FEAT-282 partial): `withServer.close()` now calls `closeAllConnections()` (Node ≥18.2) before `srv.close()` so keep-alive sockets are torn down promptly on Windows; `run()` spawnSync wraps every CLI invocation with a 15s `timeout` so a stalled subprocess no longer blocks the suite for 304s; expired-path test server sends `Connection: close` header. Expired-path assertion harden + final Windows hang investigation still open.

### Added
- **CI workflow** (FEAT-283): added `.github/workflows/test.yml` with `node-tests` + `hook-tests` jobs, each on `ubuntu-latest / windows-latest / macos-latest` matrix.

## 0.4.0 — 2026-06-22

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
