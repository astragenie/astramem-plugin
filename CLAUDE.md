# astramem-plugin — Developer Reference

## Architecture overview

```
hooks/scripts/          Bash shims — thin JSON parsers, exec bin/astramem
src/cli/                TypeScript subcommand implementations
src/lib/                Shared library modules
src/contracts/          Zod schemas + TypeScript types
tests/                  Vitest unit tests
.claude-plugin/         Plugin manifest (plugin.json)
bin/astramem            Entry-point dispatcher
```

## Pending retry queue

**Purpose**: prevent silent transcript loss when the AstraMemory daemon is down or
restarting. Any hook invocation that fails with a transient error (ECONNREFUSED,
timeout, 5xx) writes the payload to a local pending directory instead of discarding it.

**Location**:
- Windows: `%APPDATA%\Astramem\pending\`
- Linux/macOS: `~/.config/astramem/pending/`

**When it drains**: at the top of every `astramem ingest-transcript` invocation
(i.e., every hook fire). The drain runs before the live call, processing up to 20
oldest files per invocation to keep hook latency bounded.

**Drain outcomes per file**:
- **200 OK** → file deleted, logged as `pending: drained <filename>`
- **Transient failure** → file left in place, retried next invocation
- **Deterministic failure (4xx / schema error)** → file moved to `pending/rejected/`, logged

**Cap**: if `pending/` reaches 100 files OR 100 MB, oldest files are deleted
with a warning in `ingest.log`. This prevents unbounded growth during extended
daemon outages.

**Rejected files**: stored in `pending/rejected/`. These payloads failed with a
non-retriable error (e.g. bad payload shape, authentication failure). They are
kept for forensic inspection but never re-retried automatically.

**Observability**: `astramem doctor` prints a PENDING section:
```
PENDING
  count: N files (M MB)
  oldest: 2026-07-01 00:19:23 (age: 4h)
  rejected: R files
```
And in `--json` mode:
```json
{
  "pending": {
    "count": 3,
    "bytes": 12288,
    "oldest_epoch_ms": 1751404800000,
    "rejected_count": 0
  }
}
```

**Source**: `src/lib/pending.ts` — `enqueue()`, `drain()`, `capEnforce()`, `stats()`

## Hook scripts

All hook scripts in `hooks/scripts/` follow the same pattern:

1. Read JSON payload from stdin via `jq`
2. Normalize `TRANSCRIPT_PATH` separators (`\\` → `/`)
3. Optionally emit debug info when `ASTRAMEM_HOOK_DEBUG=1`
4. `exec bun bin/astramem ingest-transcript ...`

**Debug mode**: set `ASTRAMEM_HOOK_DEBUG=1` in the environment before invoking
Claude Code. All three hook scripts will print to stderr:
- `session_id`, `transcript_path`, `cwd`
- Contents of the transcript file's parent directory

This surfaces path resolution failures without modifying normal fire-and-forget
behaviour.

## Default project-scope resolution (issue #33)

`--project`/`--agent` flags on `remember`/`recall` already existed and are wired
straight through to the daemon (`metadata.project` on write, `provenance.project`
on read — no wire schema change here). The gap this closed: nothing resolved a
*default* project when the flag was omitted, so the CLI (no flag → no scope) and
the hooks (`basename $CWD` in bash) derived scope independently and could drift.

**`resolveProject()`** (`src/lib/project.ts`) is now the single source of truth,
used by every project-scope call site — `remember`, `recall`,
`ingest-transcript`, and (via the CLI, not bash) all four hook shims. Precedence,
highest wins:

1. `flag` — explicit `--project` value the caller parsed
2. `env` — `ASTRAMEM_PROJECT`
3. `config` — `project` field in the unified config (`astramem config set project <name>`)
4. `basename` — `basename(cwd)`, falling back to `'default'` if empty

`cwd` defaults to `process.cwd()`; callers that receive an explicit `cwd` from a
hook payload (`--cwd` on `remember`/`recall`/`ingest-transcript`) pass it through
so the resolution matches the session's working directory rather than the hook
subprocess's own cwd.

Client-local only — deliberately does **not** read `.claude/loop.json` (that's a
different "project" concept scoped to the loop harness; reading it here risked
drift between the two, deferred to a future slice) and does not touch any wire
schema.

**Observability**: with `ASTRAMEM_HOOK_DEBUG=1`, `resolveProject()` prints which
precedence tier won to stderr: `[astramem-hook-debug] resolveProject: tier=<flag|env|config|basename> value=<...>`.

## MEMORY.md digest vs SessionStart recall (issue #34)

Two different read-side surfaces exist and are deliberately not merged:

- **SessionStart recall hook** (`hooks/scripts/session-start-recall.sh`, issues
  #31/#32) — *live, machine-local session injection*. Fires every session
  start, recalls all types unfiltered, and never touches disk. On by default.
- **`astramem export-md`** (`src/cli/export-md.ts`) — *committed, human/CI-readable
  snapshot*. Recalls only deliberate memory types (`decision`,`lesson` by
  default — free-form/auto-distilled types are excluded on purpose, since a
  git sink is a much higher-stakes destination than a transient prompt) and
  writes them to `.claude/astramem/MEMORY.md` (default path).

Because the wire `RecallRequest` has no per-type filter, `export-md` over-fetches
with one semantic query and buckets the results by `hit.type` client-side,
keeping the top `--k` per type.

**Re-scrub at export time**: ingest-time scrubbing only ever runs once, when an
atom is first captured. `export-md` re-runs `scrubWithLabels()` over every
atom's text immediately before writing — a git-committed file persists (history,
forks, CI logs) in a way the local daemon's own store does not, so it gets a
second, independent scrub pass rather than trusting the one already applied.

**write-if-different**: if the rendered markdown is byte-identical to what's
already on disk, the file is left untouched (no wall-clock timestamp is
stamped into the file, specifically so this comparison is stable run-to-run).

**Opt-in freshness hook**: `hooks/scripts/session-end-export-md.sh` runs
`export-md` on `SessionEnd`, gated on `MEMORY_EXPORT_MD_ENABLE=1` (default
**off** — a hook must never write into a user's repo without explicit opt-in).
When disabled it's a fast no-op.

```sh
astramem export-md [--project <name>] [--out <path>] [--k <N>] [--types <csv>] [--cwd <path>]
# --project   default via resolveProject({ cwd })
# --out       default .claude/astramem/MEMORY.md
# --k         per-type cap, default 10
# --types     default "decision,lesson"
```

## Path handling (issue #12)

Claude Code may hand a subagent transcript path with:
- Windows backslash separators preserved through JSON parsing
- A race where the JSONL file is not yet fully flushed when the hook fires

The fix operates at two levels:
1. **Bash shims**: `TRANSCRIPT_PATH="${TRANSCRIPT_PATH//\\//}"` normalises separators before the path reaches the CLI
2. **CLI** (`ingest-transcript.ts`): `path.resolve(transcriptPath)` canonicalises the path, then polls up to 3 times with 200ms + 300ms gaps before declaring the file not found

## Ingest log

Location: `%APPDATA%\Astramem\ingest.log` (Windows) or `~/.config/astramem/ingest.log`

Rotated at 10 MB → `ingest.log.1`. All entries are scrubbed.

## Running tests

```sh
bun test tests/cli/ingest-transcript.test.ts tests/lib/pending.test.ts
bun test                    # full suite (some vi.* API tests known-fail on bun 1.3)
bunx tsc --noEmit           # type check
```

<!-- crew:start -->
<!-- Crew framework memory. Run /crew:install after plugin updates that change framework memory. -->
@.claude/crew/constitution.md
<!-- crew:end -->

<!-- runner:start -->
<!-- Installed by /runner:install. Edit .claude/loop.json to change stack-specific commands; re-run /runner:install to regenerate this block. The full HARD RULES live at .claude/loop/rules.md so this block stays small in per-session context. -->

## Autonomous Loop — HARD RULES (summary)

This repo runs the Wiggin Loop autonomously. Full rules: `.claude/loop/rules.md`.

- **Run until PASS.** Do not stop for confirmation. Stop only when every acceptance criterion is PASS with evidence, or the work is externally blocked.
- **Auto mode (default — `loop.marathonMode: true`).** Loop walks the entire backlog. Stops only on backlog exhaustion, crew `escalated_to_human`, warn-severity pattern alerts, or high-severity cost alerts. Iteration cap and soft `blocked` badge are advisory in this mode — set `loop.marathonMode: false` in `.claude/loop.json` to restore the legacy five-condition gating.
- **Slice start ceremony.** Every slice MUST open via `/runner:slice start --id SLICE-NN` (rotates `currentRun` so cost auto-emit attributes the work correctly + refreshes `.claude/state/crew/slice-progress.md`).
- **Dispatch discipline.** The loop is an orchestrator, not an implementer. Hand the `slice start` return's `dispatchInstruction` to a `crew:builder` subagent (implementation only); after it returns, dispatch `crew:reviewer`, then `crew:validator` if behavior changed; pivot to `/crew:fix` on any needs_fix or fail. Inline implementation is reserved for trivial single-line fixups.
- **Slice close ceremony.** Every slice MUST close via `/runner:slice complete --id SLICE-NN` (writes handoff + final-synthesis + cost-report + cost-advise) followed by `/runner:slice grade*`. Manual file moves + a `docs(slice): mark ... complete` commit are NOT a substitute.
- **Build entry points.** `/crew:build` is the interactive single-slice path (lighter — no run-brief required). Autonomous loop is the unattended multi-slice path (full ceremony). Never run both against the same branch — they race on workflow-state.
- **Auto-continue.** After the ceremony, scan `.claude/artifacts/loop/specs/` → `.claude/artifacts/loop/backlog/pending/` → `.claude/artifacts/loop/backlog/triaged/` and promote the next item without asking.
- **Phase gate.** When the last slice in a phase completes, run `/runner:phase-gate` before starting the next phase.
- **Worktree parallelism.** Run parallel features in sibling git worktrees — each has its own `.claude/state/`. Cost attribution is auto-scoped per worktree. Use `crew fleet --repo "$PWD"` for a one-glance view. Never check out the same branch twice; never push from inside the loop.

First action when starting the runner: read `.claude/loop/rules.md` → `.claude/artifacts/loop/ai-loop/00-entry/MASTER_PROMPT.md` → `.claude/artifacts/loop/ai-loop/backlog/approved-slices.md`.

<!-- runner:end -->
