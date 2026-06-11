# cortex plugin

Slash commands + auto-capture hooks bridging Claude Code to the local cortex
memory service. Wraps the existing MCP server with one-keystroke recall/store
and durable session capture across compaction.

## What's in it

### Slash commands

- `/recall <query>` — searches cortex for memories matching the query and
  injects the top results into context. Uses the cortex MCP `search_memory`
  tool. Honors inline filters like "in loop" / "for crew" → `project_id`,
  "handoffs" / "cost-reports" → `tags`.
- `/remember <text>` — stores the supplied text as a memory in cortex with
  metadata inferred from context (project = repo name, tags = topical
  keywords, type = note / decision / fact based on phrasing).

### Hooks

- **PreCompact** — `hooks/scripts/pre-compact-capture.sh` runs right before
  Claude Code compacts the conversation. Tails the last 20 user+assistant
  turns from the live transcript, stores them as a `type=summary` memory
  with `source=claude-code-precompact` and `tags=[claude-code, pre-compact,
  session-digest]`. Substance survives the compaction window.
- **SessionEnd** — `hooks/scripts/session-end-summary.sh` runs on session
  close. Captures the last 40 turns as a `type=summary` memory with
  `source=claude-code-session-end` so the next session can recall what
  happened.

Both hooks are best-effort: if cortex is unreachable, jq is missing, or the
transcript is gone, they silently `exit 0`. They never block compaction or
session shutdown.

## Configuration

Environment variables (all optional):

| Var                              | Default                 | Purpose |
| -------------------------------- | ----------------------- | ------- |
| `CORTEX_API_URL`                 | `http://localhost:5201` | API base |
| `CORTEX_API_KEY`                 | `dev-bootstrap-local`   | API key |
| `CORTEX_PRECOMPACT_MAX_TURNS`    | `20`                    | Turns captured pre-compact |
| `CORTEX_PRECOMPACT_MAX_CHARS`    | `12000`                 | Hard byte cap on the digest |
| `CORTEX_SESSION_MAX_TURNS`       | `40`                    | Turns captured at session end |
| `CORTEX_SESSION_MAX_CHARS`       | `20000`                 | Hard byte cap on the digest |

## Requirements

- cortex stack running (`dotnet run --project src/MemoryService.AppHost`).
- Hooks need `curl` and `jq` on the shell PATH. On Windows, run inside Git
  Bash or set `CLAUDE_BASH_PATH` to an MSYS bash. Without jq the hooks exit
  cleanly without recording anything.
- The slash commands use the cortex **MCP server** that's already shipped
  with this repo — no extra wiring beyond having the MCP server connected
  to Claude Code.

## Relationship to MCP

The MCP server (`src/MemoryService.Mcp`) is the data plane. This plugin is
a thin UX layer on top:

- Slash commands give you keyboard-fast access to MCP tools without the
  model having to decide whether to call them.
- Hooks give you deterministic durable capture independent of the model's
  search behavior.

Use both. They compose.
