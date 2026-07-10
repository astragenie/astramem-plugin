---
findings: "🔴:0,🟡:1,❓:1"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-07T10:06:39.022Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Stdout-purity contract holds under static + semantic audit (single jq emission point, atomic if/then/else, unconditional exit 0, RESP captured not streamed); escalation is approved with notes on test coverage.
- Evidence Checked:
  - Read hooks/scripts/session-start-recall.sh in full (77 lines)
  - hooks/hooks.json
  - tests/hooks/shim.test.ts
  - CHANGELOG.md
  - package.json diffs (git show 545db4d). Cross-referenced session-end-summary.sh
  - subagent-stop-capture.sh
  - pre-compact-capture.sh for convention parity. Verified via jq semantics reasoning: the only unredirected-stdout statement is the single terminal `jq -c` pipe (line 60-76); every other write goes to stderr (`>&2`) or into RESP via command substitution (line 49
  - CLI's own stderr also redirected to /dev/null). The final jq program is one atomic if/then/else expression over a single parsed input document
  - so it can only ever emit 0 or 1 top-level values -- no code path can print a partial/garbled object. Confirmed the script does `exit 0` unconditionally after the jq pipe (line 77) regardless of jq's own exit status
  - so even a jq startup failure (e.g. non-numeric --argjson max) still yields rc=0. Traced --argjson max "$MAX_CHARS": non-numeric value fails jq arg parsing before any input is read
  - so no stdout leak (verified by design
  - not by a test -- see gap below). Confirmed CWD is basename'd via safely-quoted `"$(basename "$CWD")"` (no injection). Ran the actual hook-schema validator against both current and pre-PR hooks.json and got the identical jq-indexing warning on both -- pre-existing generic-validator limitation with the plugin wrapper format
  - not introduced by this diff. Checked CI: gh pr checks 32 all green (ubuntu/macos/windows Tests
  - Type-check
  - cross-repo-roundtrip).
- Files Reviewed:
  - hooks/scripts/session-start-recall.sh
  - hooks/hooks.json
  - tests/hooks/shim.test.ts
  - CHANGELOG.md
  - package.json
- Test Adequacy: 3 new shim tests assert exit-0 + literally-empty stdout + no-secret-leak for dead-provider, empty-stdin, and disabled-flag paths (confirmed via direct read of assertions) -- but the success/transform path (the actual hits->additionalContext JSON emission: truncation, gsub, .type mapping) has zero automated coverage, resting only on the PR description's manual Windows pipe-test; a regression in the jq filter would not be caught by CI.
- Risks: Primary residual risk: the jq transform (truncation slicing, .type interpolation, whitespace gsub) that produces the actual injected context has no CI-enforced regression test -- future edits to that filter could silently break or malform the injected JSON and only be caught by manual testing. Secondary: non-numeric MEMORY_SESSIONSTART_MAX_ATOM_CHARS is unexercised by tests (verified safe by code-path reasoning only: jq --argjson startup failure happens before any output and the script exits 0 unconditionally).
- Required Follow-up: Add a fixture-based test for session-start-recall.sh success path (stub the CLI response, e.g. via a fake astramem shim script or PATH override, feeding canned {hits:[...]} JSON) asserting the exact hookSpecificOutput.additionalContext shape, plus one case for zero-usable-hits and one for non-numeric MEMORY_SESSIONSTART_MAX_ATOM_CHARS. Optional/low-priority: fix the misleading line-32 comment (claims parity with session-end-summary.sh's normalization, which actually normalizes TRANSCRIPT_PATH not CWD -- this script is the first to normalize CWD, which is correct behavior, just an inaccurate comment).

