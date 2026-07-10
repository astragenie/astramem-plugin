---
findings: "🔴:0,🟡:2,❓:2"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-09T15:01:35.848Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Guard/fallback logic in a2ce9e4 is correct and empirically verified (no double-ingest, no silent drop, no regression when astramem-local is absent); approved with notes for a missing regression test and a missing timeout bound on the new external-binary call.
- Evidence Checked:
  - Read: hooks/scripts/subagent-stop-capture.sh
  - hooks/scripts/session-end-summary.sh (full diff a2ce9e4)
  - hooks/scripts/pre-compact-capture.sh (unchanged
  - context)
  - src/cli/ingest-transcript.ts:405-412 (existing 2s timeout-race convention)
  - tests/hooks/shim.test.ts (existing hook test harness
  - unmodified by this commit).
Manual verification harness built with fake astramem-local/bun stubs on an isolated PATH
  - run against the real hook scripts (bash
  - not a rewrite):
- Test1 astramem-local ABSENT (today's real state): falls to legacy path
  - exit 0
  - legacy invoked once. PASS.
- Test2 astramem-local capture SUCCEEDS: exit 0
  - legacy NEVER invoked (no double-ingest). PASS.
- Test3 astramem-local present
  - capture subcommand FAILS (simulates unknown-subcommand pre-FEAT-449): falls through to legacy
  - exit 0
  - legacy invoked exactly once. PASS.
- Test4 same as Test3 with ASTRAMEM_HOOK_DEBUG=1 (debug-branch parity): identical fallthrough behavior. PASS.
- Test5 astramem-local HANGS (sleep 30
  - simulating a stuck daemon CLI/lock): hook script has no internal bound around the capture call — had to be killed by an external `timeout 5`; exit 124 confirms the script itself would have blocked for the full 30s. This contradicts the file's own header comment ("Fire-and-forget: exits 0 even if jq/bun fails or transcript missing") and the codebase's established pattern of racing external calls against an explicit wallclock timeout (src/cli/ingest-transcript.ts:408-412
  - 2s Promise.race).
Path normalization (backslash->forward-slash) confirmed to run BEFORE the new capture block in both files
  - so capture always receives an already-normalized path — no regression vs issue #12 fix.
pre-compact-capture.sh correctly left untouched: its transcript source is the live session transcript (.transcript_path)
  - not a subagent/worktree path subject to the cleanup race described in #394 — omission looks intentionally scoped
  - not an oversight.
- Files Reviewed:
  - hooks/scripts/subagent-stop-capture.sh
  - hooks/scripts/session-end-summary.sh (changed); hooks/scripts/pre-compact-capture.sh
  - src/cli/ingest-transcript.ts
  - tests/hooks/shim.test.ts (context
  - unchanged)
- Test Adequacy: No test was added in a2ce9e4 for the new capture/fallback branch; the existing tests/hooks/shim.test.ts harness (runShim, PATH-injectable) is directly reusable for this but was not extended — I substituted manual PATH-stub verification (5 scenarios, all PASS) in place of the missing automated regression test.
- Risks: (1) HIGH/TDD-gate: this is a bug fix (#394) with no regression test, despite an existing, well-suited test harness (tests/hooks/shim.test.ts) capable of injecting a fake astramem-local via PATH — isolated and low-risk to add, not blocking merge but should follow promptly. (2) MEDIUM: astramem-local capture claude ... is invoked with no timeout wrapper; empirically confirmed (Test5) that a hung/stuck astramem-local blocks the hook indefinitely, violating the fire-and-forget/never-block-the-session contract this file's own header advertises. Currently low real-world exposure since astramem-local is not yet installed (FEAT-449 unshipped), but the gap activates automatically once it ships, with no further code review checkpoint in between. (3) LOW nits: debug-mode stdout redirection asymmetry between the new capture call (>&2 always) and the legacy exec's debug branch (unredirected) — cosmetic only. (4) LOW nit: file header comments in both scripts are now stale/incomplete relative to the new issue #394 block comment beneath them.
- Required Follow-up: Before or shortly after this ships: (a) add 2 tests to tests/hooks/shim.test.ts covering capture-success (legacy never invoked) and capture-failure/absent (legacy invoked exactly once), reusing runShim's PATH-injection pattern with a fake astramem-local fixture; (b) wrap the capture invocation in both files with an explicit bound, e.g. 'timeout 5 astramem-local capture claude ...' (or an equivalent portable guard), matching the 2s timeout-race convention already used in src/cli/ingest-transcript.ts. Neither is blocking for merge given the change is small and manually verified correct end-to-end, but both should be tracked as immediate follow-up, not deferred indefinitely.

