---
findings: "🔴:0,🟡:1,❓:2"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-10T17:31:27.598Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Worktree-aware fallback is correct for the normal main/linked-worktree cases and fully failure-safe, but mis-derives the repo root for bare-repo + worktree layouts (an isolated, low-risk fix).
- Evidence Checked:
  - Verified precedence: flag/env/config all return before the git probe (project.ts:89-111)
  - so the git subprocess only runs on the pure-basename path. Verified catch is total (try/catch wraps the whole execFileSync+derivation
  - project.ts:61-79) — not-a-repo
  - missing git
  - and timeout all fall through to undefined -> plain basename. Live repro confirmed main-worktree commonDir='.git' (relative) and linked-worktree commonDir=absolute path to main .git
  - both correctly reduced via dirname/basename on this Windows box (forward-slash git output handled fine by node:path). Live repro of a bare-repo+worktree layout (bare2/bare.git + bare2/wt-from-bare) shows git-common-dir returns the bare dir itself (no '.git' child)
  - so dirname() strips one level too far and resolves to the bare repo's *parent* dir name instead of the repo's own name -- silent misattribution
  - not a crash. bun test tests/lib/project.test.ts: 14/14 pass (re-ran independently). bunx tsc --noEmit not re-run here (author already reported clean
  - no lib changes since).
- Files Reviewed:
  - src/lib/project.ts
  - tests/lib/project.test.ts
- Test Adequacy: 3 new tests cover main-worktree, linked-worktree, and flag/env-override-wins paths hermetically (fresh mkdtemp git repos, no dependency on the outer repo's real .git); no test covers the bare-repo/worktree layout, which is exactly where the fallback derivation breaks.
- Risks: Bare-repo+worktree layouts (a real, documented git pattern) get project scope silently mis-set to the bare dir's parent directory name rather than erroring -- could pollute memory scoping for affected users without any visible failure. Secondary: the pre-existing 'defaults cwd to process.cwd()' test (project.test.ts, untouched by this diff) implicitly assumes the test runner's cwd is the main worktree; since this repo's own loop/crew harness runs parallel work in linked worktrees, invoking bun test from inside one would make that older test fail even though the new code is behaving correctly.
- Required Follow-up: [HIGH] src/lib/project.ts:60-80 (resolveGitMainRepoName) -- only dirname() the resolved commonDir when its basename is literally '.git'; when it is not (bare-repo case, commonDir IS the repo root), use the resolved commonDir path itself as repoRoot. Add a test that inits a bare repo + 'git worktree add' off it and asserts the bare repo's own directory name (not its parent) is returned. [LOW] Update the issue #33 CLAUDE.md section to mention the worktree-aware git tier, consistent with how every other project.ts behavior change in this repo is documented there. [LOW] Flag-follow-up only, non-blocking: the pre-existing process.cwd()-default test may go flaky if ever run from inside a linked worktree of this repo.

