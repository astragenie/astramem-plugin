# @astragenie/astramem-plugin

![test](https://github.com/astragenie/astramem-plugin/actions/workflows/test.yml/badge.svg)
![release](https://img.shields.io/github/v/tag/astragenie/astramem-plugin?label=release&sort=semver)
![license](https://img.shields.io/github/license/astragenie/astramem-plugin)

Claude Code plugin bridging the `astramem` CLI, provider selector, and auto-capture hooks to
AstraMemory — local or cloud. **v0.5.0:** Plugin now speaks the canonical `wire_version: v1.0` 
shape to both SaaS and local backends, closing out the wire-contract unification (FEAT-4a Phase 3).

---

## Quick start

```bash
# 1. Install Bun (https://bun.sh) if not already present
curl -fsSL https://bun.sh/install | bash

# 2. Install the plugin globally
bun add -g @astragenie/astramem-plugin

# 3. Pair this workstation to a provider
astramem connect                        # local daemon (astramem-local must be running on :7777)
# OR — if you have a dashboard claim code, use the separate memory-connect bin
# (aliased as astramem-connect; NOT a subcommand of `astramem`):
astramem-connect ABCD-1234 --env prod
```

`astramem connect` and `astramem-connect <code>` are two different bins: the former (`src/cli/connect.ts`)
takes no arguments and probes the local daemon's `GET /health`; the latter (`bin/memory-connect.ts`,
aliased `astramem-connect`) redeems a dashboard claim code against the SaaS API and writes a token file.
See [Back-compat bins](#back-compat-bins) for the full alias list.

---

## Development

```bash
# Install dependencies (creates / refreshes bun.lock)
bun install

# Run the test suite
bun test

# Type-check
bun run typecheck      # equivalent: bunx tsc --noEmit

# Link the bin locally for manual testing
bun link
```

> **Publish** — `bun publish` writes to GitHub Packages via the `.npmrc` auth config (same
> as the previous npm publish path). Requires `NODE_AUTH_TOKEN` set in the environment.
> Bun 1.1+ supports `bun publish` natively.

After pairing, Claude Code hooks and slash commands (`/astramem:recall`, `/astramem:remember`) resolve the provider
automatically. No manual env-var export required for day-to-day use.

---

## Slash commands

| Command | What it does |
| --- | --- |
| `/astramem:recall <query>` | Searches astramem and injects the top 5 hits into context. |
| `/astramem:remember <text>` | Stores the text as a typed memory (`fact`, `decision`, `note`, etc.). |

Both commands invoke `bin/astramem` internally via `bun ${CLAUDE_PLUGIN_ROOT}/bin/astramem`.
If the provider is unreachable they suggest `astramem health` for diagnosis.

---

## `astramem` CLI — sub-commands

| Sub-command | Description |
| --- | --- |
| `ingest-transcript` | Fire-and-forget: ingest a JSONL transcript file. Exit 0 always (errors go to log). Hook shim target. |
| `recall` | Recall memories matching a query. Prints `{ hits: [...] }` JSON to stdout. |
| `remember` | Store a new typed memory item. |
| `health` | Probe configured provider(s). JSON output `{ ok, provider, url, latencyMs }`. |
| `config` | Read/write config file via dot-path keys (`config get`, `config set`, `config unset`). |
| `doctor` | Print env vars, last 5 log lines, selector resolution, config validation, and per-alias env-deprecation hit counts. |
| `connect` | Probe the local daemon's health (no args). For SaaS dashboard claim codes use the separate `astramem-connect` bin instead. |
| `export-md` | Write a repo-visible `MEMORY.md` digest of deliberate memories (decision/lesson by default). |

Full flag reference: `astramem --help` or `astramem <subcommand> --help`.

---

## Provider selector

The selector resolves which provider handles each call. Resolution order (highest precedence first):

1. `--provider local|saas|auto` flag on the CLI invocation.
2. `ASTRAMEM_PROVIDER` environment variable.
3. `provider` field in `~/.config/astramem/config.json` (or `%APPDATA%\Astramem\config.json`).
4. `auto` default: probe local (`http://127.0.0.1:7777/health`) with a 5-second cached result;
   fall back to SaaS if local is not reachable.

The selector implements auto-probe with automatic fallback, routing calls transparently between
local and SaaS backends. See `src/lib/selector.ts` for the implementation.

The selector source is reported in `astramem doctor` output and in structured log lines emitted
at each dispatch.

### Using the selector as a library

`resolveProvider()` is importable outside the CLI via the `./selector` export
(see `exports` in `package.json`):

```ts
import { resolveProvider } from '@astragenie/astramem-plugin/selector';

const result = await resolveProvider({});
result.providerName; // 'local' | 'saas' — THE supported backend-identity field
result.provider.backend; // 'local' | 'saas' — same value, readable off the
                          // provider handle alone when that's all a caller has
```

`SelectorResult.providerName` is the canonical field for "which backend did the
selector choose" — prefer it whenever you have a `SelectorResult` in hand. For
code paths that only receive the `provider` object (e.g. after destructuring
`const { provider } = await resolveProvider()`), the resolved provider
instance is also stamped with a readonly `backend` property carrying the same
value, so backend identity never has to be threaded through separately.

---

## Unified config directory

All plugin state (config, ingest log, secrets) lives in one location:

| Platform | Path |
| --- | --- |
| POSIX (Linux / macOS) | `~/.config/astramem/` |
| Windows | `%APPDATA%\Astramem\` |

Key files:

| File | Purpose |
| --- | --- |
| `config.json` | Provider preference, SaaS URL, local URL, logging options. |
| `secrets.env` | Bearer token written by `astramem connect` (never committed). |
| `ingest.log` | Append-only log of every ingest attempt (scrubbed). |
| `ingest.log.1` | Previous rotation (overwritten on the next rotation event). |

Legacy `~/.astramemory/` paths (written by pre-v0.4.0 `memory-connect`) are read as a migration
fallback and left untouched.

---

## Bearer scrubbing

Every value written to stdout, stderr, `ingest.log`, or any structured log line is passed through
two scrub passes before write:

1. **Regex scrub** — `/Bearer\s+[A-Fa-f0-9]{32,128}/g` replaces matching substrings with
   `Bearer [REDACTED]`.
2. **Key scrub** — recursively walks any JSON object and replaces the value of any key matching
   `/api[_-]?key|token|bearer|secret|password/i` with `"[REDACTED]"`.

The scrub is applied in `src/lib/scrub.ts` and called at every provider error path and log sink.

---

## Fail-silent ingest log

`astramem ingest-transcript` (called by the PreCompact / SessionEnd / SubagentStop hooks) writes
structured one-line JSON entries to `ingest.log` on every attempt — success or failure. Errors
from a down provider are recorded here rather than surfaced to the calling process. The log is
append-only and human-readable; inspect it with `astramem doctor` or `tail` it directly.

---

## Log rotation

On each write to `ingest.log`, the logger checks the current file size. If the file exceeds
**10 MB**, it renames `ingest.log` → `ingest.log.1` (overwriting any prior `.1`) and starts
a fresh `ingest.log`. Only one backup is kept. All content in the backup has already been
scrubbed prior to write.

---

## Environment variables

Source of truth: `src/lib/env-specs.ts` (the `ENV` registry consumed by `resolveEnv()` in
`src/lib/env.ts`). Canonical wins over alias; alias reads emit a one-shot deprecation warning
(visible in `astramem doctor --json` as `deprecation_hits`) unless `MEMORY_DEPRECATION_OPT_OUT=1`.

**Provider selector + daemon connection:**

| Canonical | Legacy aliases | Default | Purpose |
| --- | --- | --- | --- |
| `ASTRAMEM_PROVIDER` | `MEMORY_PROVIDER` | (none) | Override provider selection (`local`, `saas`, `auto`). |
| `MEMORY_BEARER` | `ASTRAMEMORY_API_KEY` | (resolved via `secrets.env`, written by `astramem connect`) | Bearer token for the local daemon and for the MCP transport (`.mcp.json`). |
| `MEMORY_API_URL_LOCAL` | `ASTRAMEMORY_API_URL` (when the value looks like `localhost`/`127.0.0.1`/`0.0.0.0`) | `http://127.0.0.1:7777` | Local daemon base URL. |
| `MEMORY_API_URL_SAAS` | `MEMORY_API_URL`, `ASTRAMEMORY_API_URL` (when the value does NOT look local) | (none — must be configured for the `saas` provider) | SaaS gateway base URL. |

**Transcript-capture hooks** (turn/char caps passed to `ingest-transcript`):

| Canonical | Legacy alias | Default | Hook |
| --- | --- | --- | --- |
| `MEMORY_PRECOMPACT_MAX_TURNS` / `_MAX_CHARS` | (none) | `20` / `12000` | PreCompact |
| `MEMORY_SESSIONEND_MAX_TURNS` / `_MAX_CHARS` | `MEMORY_SESSION_MAX_TURNS` / `MEMORY_SESSION_MAX_CHARS` | `20` / `12000` | SessionEnd |
| `MEMORY_SUBAGENT_MAX_TURNS` / `_MAX_CHARS` | (none) | `20` / `12000` | SubagentStop |

**Read-side / export hooks** (read directly by the shell shims — no alias resolution or
deprecation tracking; see `hooks/scripts/*.sh`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_SESSIONSTART_RECALL_DISABLE` | (unset = enabled) | Set `1` to skip the SessionStart recall hook entirely. |
| `MEMORY_SESSIONSTART_RECALL_K` | `8` | Top-K hits injected as SessionStart context. |
| `MEMORY_SESSIONSTART_RECALL_QUERY` | `"project context decisions lessons constraints state"` | Recall query override. |
| `MEMORY_SESSIONSTART_MAX_ATOM_CHARS` | `300` | Per-atom truncation in the injected context. |
| `MEMORY_EXPORT_MD_ENABLE` | (unset = off) | Set `1` to turn on the opt-in SessionEnd `export-md` hook. |
| `MEMORY_EXPORT_MD_OUT` | `.claude/astramem/MEMORY.md` | Output path override. |
| `MEMORY_EXPORT_MD_K` | `10` | Top-K per type. |
| `MEMORY_EXPORT_MD_TYPES` | `decision,lesson` | Comma-separated memory types to include. |

**Misc:**

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASTRAMEM_HOOK_DEBUG` | `0` | Set `1` to emit one debug line per hook fire to stderr. |
| `MEMORY_DEPRECATION_OPT_OUT` | `0` | Set `1` to silence legacy-alias deprecation warnings. |
| `ASTRAMEMORY_ENV` | `prod` | Env profile used by `astramem-connect`/`memory-connect` and legacy `~/.astramemory/` lookup. |

For the exact resolution algorithm, see `resolveEnv()` in `src/lib/env.ts`.

---

## Hooks

| Hook | Trigger | Max turns | Override |
| --- | --- | --- | --- |
| PreCompact | Before context compaction | 20 | `MEMORY_PRECOMPACT_MAX_TURNS` |
| SessionEnd | Claude Code session exit | 20 | `MEMORY_SESSIONEND_MAX_TURNS` (legacy alias `MEMORY_SESSION_MAX_TURNS`) |
| SubagentStop | Sub-agent task end | 20 | `MEMORY_SUBAGENT_MAX_TURNS` |

All hooks exit 0 and never block the triggering event. Failures (provider down, no Bearer,
`jq` missing) are written to `ingest.log` and silently swallowed.

---

## Provider endpoint map

Each provider implements the same MemoryProvider interface but targets different backends:

| Method | Local provider | SaaS provider |
|---|---|---|
| `ingest()` (generic item) | not used by hooks | `POST /ingest` |
| `ingestTranscript()` (hooks) | `POST /ingest/transcript` | `POST /ingest/transcript` |
| `recall()` | `POST /recall` | `POST /memories/search` |
| `remember()` | `POST /remember` | `POST /memories` |
| `health()` | `GET /health` | `GET /health` |
| `version()` | `GET /version` | `GET /version` |

**Local daemon:** `https://github.com/astragenie/astramemory-local` running at `http://127.0.0.1:7777`  
**SaaS deployment:** `https://api.astramemory.com` (configure via `MEMORY_API_URL_SAAS`)

Both providers accept the same wire contract (SaaS-canonical envelope) for `ingestTranscript()`. See [FEAT 4a wire-contract unification](docs/superpowers/specs/2026-06-29-hooks-provider-migration-4a.md) for the full schema and three-repo convergence plan.

---

## MCP server

`.mcp.json` registers an HTTP MCP server at `${MEMORY_API_URL}/mcp`, authenticated with
`Authorization: Bearer ${MEMORY_BEARER}`. The slash commands do **not** go through MCP — they
invoke `bin/astramem` directly. The MCP server remains available for other agents or tools that
prefer the MCP protocol.

Export `MEMORY_BEARER` and `MEMORY_API_URL` before launching Claude Code if you want the MCP
transport live alongside the CLI path (`MEMORY_API_URL` here is read literally by `.mcp.json`'s
env substitution — it is not resolved through `resolveEnv()`/`env-specs.ts` the way the CLI's
`MEMORY_API_URL_LOCAL`/`MEMORY_API_URL_SAAS` are).

---

## Daily ops cheatsheet

```bash
# Ingest a transcript file (this is what the hook shims call — see hooks/scripts/*.sh)
astramem ingest-transcript --event session_end --session-id s1 --transcript-path ./transcript.jsonl

# Recall recent decisions
astramem recall --query "provider selector decision" --k 10

# Store a note
astramem remember --content "We chose Bun over Node for the plugin runtime" --type decision

# Check provider health
astramem health

# Diagnose config + env (includes deprecation-hit counts)
astramem doctor

# Same as above, but JSON output with deprecation_hits array
astramem doctor --json

# Get / set config values
astramem config get
astramem config get provider
astramem config set provider local

# Pair workstation (local daemon)
astramem connect

# Pair workstation (dashboard claim code) — separate bin, not an `astramem` subcommand
astramem-connect ABCD-1234 --env prod
```

Example `astramem doctor --json` output (partial):
```json
{
  "env_vars": { "MEMORY_BEARER": "[present, redacted]", "MEMORY_API_URL": null, "ASTRAMEM_PROVIDER": "auto" },
  "deprecation_hits": [
    { "canonical": "ASTRAMEM_PROVIDER", "alias": "MEMORY_PROVIDER", "hits": 3 },
    { "canonical": "MEMORY_API_URL_LOCAL", "alias": "ASTRAMEMORY_API_URL", "hits": 1 }
  ]
}
```

---

## Companion projects

- [astramem-local](https://github.com/astragenie/astramemory-local) — local daemon that the
  `local` provider talks to. Run it on `localhost:7777` for offline / private memory.
- [runner-plugin](https://github.com/astragenie/runner-plugin) — Engineering OS runner plugin;
  shares the `astramem ingest-transcript` path for session digests.
- [crew / GEPA loop](https://github.com/astragenie/crew) — dev-team crew plugin whose
  PreCompact hooks feed into AstraMemory via this plugin.

---

## Back-compat bins

The following legacy bin names still work (shims that delegate to their `astramem`-prefixed
equivalents):

- `memory-login` → `astramem-login`
- `memory-refresh` → `astramem-refresh`
- `memory-token` → `astramem-token`
- `memory-connect` → `astramem-connect`

---

## Upgrading from memory-plugin (any pre-v0.5.0)

See `CHANGELOG.md` v0.5.0 entry for the breakdown. Quick checklist:

1. Reinstall under the new key:
   ```bash
   claude /plugin uninstall memory@astra-marketplace
   claude /plugin marketplace update astra-marketplace
   claude /plugin install astramem@astra-marketplace
   ```
2. Rename slash command references: `/memory:recall` → `/astramem:recall`,
   `/memory:remember` → `/astramem:remember`. Update any saved keybindings, hooks, or
   scripts.
3. Run `astramem connect` once to write the unified config dir.
4. Remove `ASTRAMEMORY_API_URL` and `ASTRAMEMORY_API_KEY` raw env vars from your shell rc
   (deprecated; removed at v1.7).
5. Restart Claude Code.
