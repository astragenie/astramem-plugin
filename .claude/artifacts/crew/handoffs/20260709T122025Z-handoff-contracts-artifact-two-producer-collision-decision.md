# Task Handoff: Contracts artifact: two-producer collision decision

- Created: 2026-07-09T12:20:25.934Z
- From: researcher
- To: dispatcher
- Objective: GATE must key existence on .openapi.yaml only; contracts-artifact.mts is dead code (safe to repoint from .md to .openapi.yaml); orchestrate-slice Step 1 has no guard against clobbering an architect-feature-authored .md, and the reverse order collision (architect-feature running after orchestrate-slice) silently drops tag write-back too.
- Allowed Scope:
  - Read-only design spike across dev-team/commands/orchestrate-slice.md Step 1
  - dev-team/commands/architect-feature.md Step 2
  - dev-team/skills/domain/architecture/openapi-authoring/SKILL.md
  - runner-plugin/src/scripts/lib/contracts-artifact.mts
  - and a repo-wide grep for its callers.
- Forbidden Scope: -
- Deliverable: Decision: (1) GATE keys skip-redispatch on .claude/artifacts/crew/designs/<FEAT-ID>-contracts.openapi.yaml existence only -- not .md, not both, not a new marker -- because .md has two incompatible schemas (architect-feature's TS-Interfaces/API-Contracts/Event-Schemas/Data-Contracts/Inferred-Tags vs orchestrate-slice's companion Decision-rationale/Data-Contracts/Revisions per SKILL.md:42) while .yaml has exactly one producer/schema. (2) contracts-artifact.mts has ZERO live TS callers repo-wide (grep only hits its own test file plus changelog/artifact prose) -- it is confirmed dead code, free to repoint: change getContractsPath (contracts-artifact.mts:11-13) from '-contracts.md' to '-contracts.openapi.yaml'; contractsArtifactExists (lines 19-24) needs no change since it composes on getContractsPath. (3) CONFIRMED clobber/silent-break risk both directions: orchestrate-slice.md Step 1 decision tree (lines 68-93) branches solely on .openapi.yaml presence and has no step reading a pre-existing .md before dispatching architect to (re)write the companion .md at the same path (line 106) -- architect-feature.md's own idempotency guard ('If the contract artifact already exists: add a Feature Revision subsection... Do NOT remove or overwrite', lines 83-85) has no equivalent in orchestrate-slice's architect prompt (lines 95-120), so a pre-existing architect-feature .md (with ## Inferred Tags) is at risk of being overwritten by the openapi-authoring companion schema. Reverse order: if architect-feature Step 2 runs AFTER orchestrate-slice already wrote its companion .md, architect-feature's existence check will misfire against the wrong schema and Step 3's tag-parse (lines 114-124) will silently skip tag write-back (only a warning printed, not a hard failure) because ## Inferred Tags is absent from the openapi-authoring-schema .md.
- Changed Files:
  - dev-team/commands/orchestrate-slice.md:68-93
  - 95-120; dev-team/commands/architect-feature.md:79
  - 83-85
  - 112-124; dev-team/skills/domain/architecture/openapi-authoring/SKILL.md:42; runner-plugin/src/scripts/lib/contracts-artifact.mts:11-24; runner-plugin/src/tests/contracts-artifact.test.mts (all .endsWith assertions); runner-plugin/CHANGELOG.md:2574-2678 (stale .md-only docs); runner-plugin/docs/conventions/report-filenames-writer-audit.md:149
  - 223
- Confidence: high
- Risks: The 'architect will overwrite' claim is inferred from prompt text, not from an observed execution -- no test run confirms actual agent behavior. Also unresolved: whether to fix architect-feature.md's Step 2 existence check in the same slice as the GATE fix, or file it as a follow-up FEAT -- recommend same slice since the reverse-order collision is a silent (non-crashing) data-loss bug that would otherwise ship un-flagged.
- Suggested Next Handoff: Dispatch crew:architect or crew:fullstack-dev to: (a) repoint contracts-artifact.mts + its test fixtures to .openapi.yaml, (b) add a pre-existing-.md guard to orchestrate-slice.md Step 1 mirroring architect-feature.md's Feature-Revision append pattern, (c) add a matching guard to architect-feature.md Step 2 for the reverse-order case.

