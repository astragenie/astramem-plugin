---
findings: "🔴:0,🟡:2,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-07T12:51:18.326Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Issue #29 abort/unref plumbing is correct and backward-compatible (tsc clean, 175/175 tests green, no live caller regression); two MEDIUM latent defects found in currently-dead code paths that will bite the first time a caller actually passes a signal.
- Evidence Checked:
  - Reviewed full diff (git diff --stat: 11 files
  - 458+/34-) plus new src/lib/abort.ts and tests/lib/abort.test.ts. Confirmed via grep that zero current callers (src/cli/*.ts) pass a signal today — signal plumbing is pure groundwork
  - not yet load-bearing. Reproduced the linkSignals fallback leak empirically: bun -e script forcing AbortSignal.any=undefined
  - 5 calls with one shared never-aborted external signal -> 5 permanently attached addEventListener('abort'
  - ...) listeners (once:true self-removes only if that signal itself fires
  - never on normal completion). Confirmed native AbortSignal.any IS present on this Bun 1.3.14 build
  - so the manual-merge fallback is dead code here today but is explicitly documented as intended for other Bun builds. Confirmed local.ts/saas.ts ingest+ingestTranscript retry-once-on-TransientError blocks retry unconditionally without checking signal?.aborted first (traced full retry path; harmless today only because no caller passes signal and an already-aborted fetch signal short-circuits without real I/O). Ran bunx tsc --noEmit (clean) and bunx vitest run tests/lib/abort.test.ts tests/providers/local.test.ts tests/providers/saas.test.ts tests/lib/selector.test.ts -> 7 files
  - 175 passed. Verified error-classification (caller-abort vs internal-timeout) is correct and race-safe (single-threaded event loop
  - externalSignal?.aborted read is synchronous). Verified linkSignals identity-return path (defined.length===1) makes existing no-signal callers byte-identical to pre-change behavior.
- Files Reviewed:
  - src/lib/abort.ts (new)
  - tests/lib/abort.test.ts (new)
  - src/contracts/provider.ts
  - src/lib/selector.ts
  - src/lib/wire-probe.ts
  - src/providers/local.ts
  - src/providers/saas.ts
  - src/cli/ingest-transcript.ts
  - tests/lib/selector.test.ts
  - tests/providers/local.test.ts
  - tests/providers/saas.test.ts
- Test Adequacy: New tests cover unref() invocation, native-AbortSignal.any merge behavior, early-abort timing (AC-2 asserts abort resolves before the internal deadline via a never-resolving mock fetch; AC-4 asserts elapsed <500ms with an already-aborted signal; AC-3 uses a real ~3s wait to prove the internal timeout genuinely still fires) -- not trivially green. Gap: no test forces the AbortSignal.any-absent fallback path (all runs happen on Bun 1.3.14 which has it natively), and no test exercises the retry-after-caller-abort scenario in local.ts/saas.ts ingest -- both gaps line up exactly with the two findings below.
- Risks: Both findings are in currently-unreachable/dead code paths (no production caller passes a signal yet) so there is no live regression to ship today. They will activate silently the first time any caller (CLI flag, MCP wrapper, SIGINT wiring) starts passing a real AbortSignal, at which point (1) a shared/long-lived external signal on a runtime lacking AbortSignal.any will accumulate one leaked listener per call, and (2) an aborted caller mid-ingest will still pay for one wasted retry attempt.
- Required Follow-up: Before any caller starts passing a live signal into these providers/selector: (1) fix linkSignals' manual-merge fallback to remove its listeners once the combined signal is no longer needed (e.g. via an internal AbortController tied to fetch completion, not just once:true on the abort event), and add a fallback-path test that stubs AbortSignal.any away; (2) add a signal?.aborted early-return check before the retry attempt in LocalProvider/SaasProvider ingest() and ingestTranscript(), with a regression test asserting no second attemptIngest call fires after caller abort.

