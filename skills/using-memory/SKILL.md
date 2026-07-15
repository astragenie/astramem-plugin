---
name: using-memory
description: Use at the START of any substantial task (writing/reviewing/debugging code, designing, planning, answering a non-trivial question) to ground yourself in prior memory BEFORE acting — load your agent track record (recurring lessons, decisions, and past mistakes) and task-specific recall from astramem, then record which memories actually helped. Triggers on "recall", "what did we decide", "have we hit this before", "prior lessons", "load my memory", or simply when you are about to start real work and haven't yet checked memory this task.
---

# Using Memory (astramem)

Agents that don't read their own history re-learn the same things and repeat the
same mistakes. This skill closes that loop against the astramem MCP server: it
**loads** relevant memory before you act and **feeds back** which memory helped,
so the ranking gets better over time.

Requires the astramem MCP server to be configured (see the plugin README →
"Universal memory: make any agent smarter"). If the tools below are unavailable,
skip silently — never block the task on memory.

## When to run

At the **start** of substantial work, before writing code / making a decision /
answering — once per task. Skip for trivial acknowledgements or pure chit-chat.

## Step 1 — Load (two reads, cheap, parallel)

1. **Your track record** — call `agent_profile` with your agent/role name
   (e.g. the subagent type, or `claude-code` for the main session). It returns
   `top_lessons`, `recent_decisions`, and **`corrections`** (things this role got
   wrong before and had to reverse). Corrections are the highest-value signal —
   read them first.
2. **This task's context** — call `recall_memory` (or `search_memory`) with a
   short query built from the task: the feature/area, key file or component
   names, and words like "decision lessons failures". Scope with `project` /
   `repo` when you know them.

Both calls are best-effort. If either returns nothing or errors, proceed with
whatever you got (or nothing).

## Step 2 — Use

Fold the loaded memory into how you work THIS task:
- Treat `corrections` as guardrails — do not repeat a reversed decision.
- Reuse `recent_decisions` as settled choices unless you have a reason to revisit.
- Let `top_lessons` + recall hits inform your approach.
Keep a short mental note of **which memory ids you actually relied on** — you
need them for Step 3. (Each lesson/decision/hit carries an `id`.)

## Step 3 — Feed back (this is what makes it smarter)

When a loaded memory genuinely influenced your work — you followed a correction,
reused a decision, or a recalled fact changed your approach — call
`submit_feedback` (or `mark_memory_used`) with that memory's `id`. This is the
signal that lifts useful memory up the ranking and lets dead memory fall away.
Only credit memory you actually used; do not credit everything you loaded.

## Step 4 — Store what's new (optional, at the end)

If this task produced a durable lesson, decision, or corrected a prior belief,
call `remember` (or `/remember`) so the next agent inherits it. Prefer one
crisp, standalone sentence per item; skip transient details.

## Fail-silent contract

Memory is grounding, never a gate. Any unavailable tool, empty result, or error
means "proceed without it" — never surface an error or pause the task because
memory was unreachable.
