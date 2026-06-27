---
description: Store the supplied text as a memory in astramem with sensible defaults inferred from the current repo and context.
---

# /remember

Persist the supplied text into astramem so future sessions can recall it.

User input: $ARGUMENTS

Workflow:

1. Decide the right metadata:
   - **type**: pick from `fact`, `preference`, `decision`, `event`, `task_result`, `lesson`,
     `summary`, `note`. Default to `note` if unclear. Use `decision` if the text reads like an
     ADR / "we chose X over Y" / "going with...".
   - **content**: strip any leading `[project:...]`, `[tag:...]`, `[type:...]` tokens after
     parsing — they're config, not body content.

2. Invoke the astramem CLI:

   ```
   bun ${CLAUDE_PLUGIN_ROOT}/bin/astramem remember --content "$text" --type "$type"
   ```

   - Set `$text` to the cleaned body text.
   - Set `$type` to the inferred type from step 1.
   - The CLI exits 0 and prints `ok` to stdout on success.
   - Exit 3 means the provider is unreachable — see the fallback step below.

3. Report back a one-line confirmation with the inferred type and a brief summary of what was
   stored. If the CLI returned an error message on stderr, include it in the response.

If the CLI exits 3 or the command fails to run: hint that the astramem provider is unreachable.
Run `bun ${CLAUDE_PLUGIN_ROOT}/bin/astramem health` to diagnose which providers are down.
