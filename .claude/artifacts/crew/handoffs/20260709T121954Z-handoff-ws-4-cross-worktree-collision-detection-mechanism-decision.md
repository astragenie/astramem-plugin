# Task Handoff: WS-4 cross-worktree collision detection: mechanism decision

- Created: 2026-07-09T12:19:54.274Z
- From: researcher
- To: dispatcher
- Objective: Use a git-native scan (git worktree list --porcelain + git for-each-ref, both already run against the SAME repoPath from any worktree) instead of a new lock file or shared state file — no new primitive needed, only a new query function plus two call sites.
- Allowed Scope:
  - Read-only design spike in runner-plugin (worktree-manager.mts
  - slice-linker/start-slice.mts
  - halt-badge-state.mts) and dev-team (commands/build.md
  - commands/fix.md) to decide the WS-4 collision-detection mechanism for 'isolate in worktree only when another build/fix/slice is in-progress on the same branch'.
- Forbidden Scope: -
- Deliverable: Decision: reuse the git-native pattern already proven in worktree-manager.mts (findExistingWorktree at line 187 runs 'git worktree list --porcelain' from ANY worktree path against the shared .git dir, so it is inherently cross-worktree — git metadata lives once per repo, not per-worktree). Add one new function, e.g. isBranchInProgress(repoPath, branch): scan 'git worktree list --porcelain' for a worktree whose HEAD branch matches (or has a slice/<id> prefix matching the target branch's slice family), OR cheaper: 'git for-each-ref refs/heads/slice/*' to enumerate live slice branches and cross-reference against .claude/state/crew/workflow-state.json's currentRun.sliceId in each candidate worktree path returned by 'worktree list' (only feasible if worktrees are reachable on disk — porcelain output includes each worktree's path, so read <path>/.claude/state/crew/workflow-state.json directly, no shared root file needed). No lock file, no advisory-lock library exists anywhere in runner-plugin (grep for lock/flock/lockfile/fileLockManager in src/scripts returned zero hits) or dev-team commands, so introducing one would be new machinery; the git-list-scan approach reuses git's own single-source-of-truth (the object database is shared across worktrees) and existing parse helpers (parseWorktreeList, canonicalizePath already in worktree-manager.mts) rather than inventing state-file synchronization semantics (staleness, cleanup-on-crash, cross-plugin write races) that a lock/shared-state file would require.
- Changed Files:
  - C:/work/mega/runner-plugin/src/scripts/lib/worktree-manager.mts
  - C:/work/mega/runner-plugin/src/scripts/lib/slice-linker/start-slice.mts
  - C:/work/mega/runner-plugin/src/scripts/lib/halt-badge-state.mts
  - C:/work/mega/dev-team/commands/build.md
  - C:/work/mega/dev-team/commands/fix.md
- Confidence: medium
- Risks: 1) 'workflow-state.currentRun' is per-worktree (each worktree has its own .claude/state/ per CLAUDE.md), so the currentRun.sliceId cross-reference step requires reading a file inside EACH sibling worktree path returned by 'git worktree list' — this is doable (paths are known) but adds N filesystem reads per check, not O(1). 2) dev-team commands/build.md and commands/fix.md contain NO existing worktree or in-progress references at all (grep returned zero hits) — the check does not exist there today and both files need a new pre-flight step added from scratch, not a wire-up to something existing. 3) Did not find any prior art for 'is this branch already being worked' outside worktree-manager's own path-collision check (which only detects the SAME target path/branch already registered, not a DIFFERENT in-progress slice on the same branch) — the semantics WS-4 wants (branch-level collision, not path-level) needs new logic, findExistingWorktree only solves path-level dedup.
- Suggested Next Handoff: crew:architect or crew:builder to design isBranchInProgress() signature and wire it into runner:start's dispatchInstruction gate plus commands/build.md and commands/fix.md pre-flight; effort estimate below.

