# Task Handoff: SLICE-2 test-plan fact-check: envelope tests, daemon-spawn precedent, daemon pinning, port conventions

- Created: 2026-07-04T08:06:31.836Z
- From: researcher
- To: dispatcher
- Objective: astramemory-plugin has thorough unit tests for the v1.0 wire envelope shape but zero precedent for spawning a real daemon process; no existing convention pins which daemon build/version an integration test would target.
- Allowed Scope:
  - Read-only fact-finding in C:/work/mega/astramemory-plugin: existing wire-envelope tests
  - spawned-process/live-HTTP test precedent
  - daemon version/path pinning conventions
  - test runner + port conventions
  - wire.ts envelope builder.
- Forbidden Scope: -
- Deliverable: 5-point findings list (below) with file:line citations, no recommendations per request.
- Changed Files:
  - src/contracts/wire.ts
  - tests/contracts/transcript-wire.test.ts
  - tests/e2e/_helpers.ts
  - tests/providers/local.test.ts
  - tests/providers/_contract.ts
  - tests/ingest-payload.test.ts
  - tests/ingest-retry.test.ts
  - tests/memory-connect.test.ts
  - README.md
  - package.json
- Confidence: high
- Risks: Did not check .claude/worktrees/v0.5.2-local-first (a stale/parallel worktree with duplicate test files) — only the main working tree was inspected, matching what SLICE-2 would actually build against. No vitest.config.ts exists (default config), so no repo-level port-reservation registry was found to check for collision with the daemon's 17777/17778/18950/19000+ ports — absence confirmed by file search, not by reading a config that explicitly says so.
- Suggested Next Handoff: If SLICE-2 proceeds, the new integration test needs its own port/convention decision since none exists yet; also decide whether it belongs under tests/e2e/ (existing convention for fake-server based flow tests) or a new tests/integration/ dir since all tests/e2e/ tests currently use an in-process fake server, not a real spawned process.

