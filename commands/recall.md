---
description: Search astramem for memories matching a query and inject the top hits into context.
---

# /recall

Search astramem for memories matching the user's query and inject the top results into the
conversation so the rest of the session can use them as grounding context.

User query: $ARGUMENTS

Workflow:

1. Invoke the astramem CLI:

   ```
   bun ${CLAUDE_PLUGIN_ROOT}/bin/astramem recall --query "$query" --k 5
   ```

   - Set `$query` to the user's query above.
   - If the user named a project (e.g. "in loop", "for crew"), append `--project <name>`.
   - If the user named a repo, append `--repo <name>`.
   - The CLI exits 0 and prints a JSON object `{ hits: [...] }` to stdout.
   - Exit 3 means the provider is unreachable — see the fallback step below.

2. Parse the JSON response. Each hit has: `id`, `type`, `text`, `score`, and optional `source`.

3. Format the results compactly: one line per hit with type, source (if present), first 120 chars
   of text, and score. Example:
   ```
   [0.92] (decision) Provider selector uses local-first auto-fallback — see selector.ts
   [0.78] (fact)     Bearer scrub regex covers 32-128 hex chars after "Bearer "
   ```

4. End with a short synthesis: what these memories collectively say about the query.

If no hits are returned (`hits` array is empty): say so plainly and suggest `/remember` to store
something relevant now.

If the CLI exits 3 or the command fails to run: hint that the astramem provider is unreachable.
Run `bun ${CLAUDE_PLUGIN_ROOT}/bin/astramem health` to diagnose which providers are down.
