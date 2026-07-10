# Market findings: What can our runner/crew SDD loop steal from GitHub Spec Kit, Kiro, BMAD-METHOD, and Tessl?

Accessed: 2026-07-09. All URLs below were fetched this session.

## Our baseline (for framing "steal")

Runner/crew already has: backlog FEATs with Given-When-Then acceptance criteria,
PM triage scoring, SPEC bodies (`prd`/`user-journey`/`sre`/`research`/`adr` types
under `.claude/artifacts/loop/specs/`), architect-feature contract artifacts
(OpenAPI yaml + md), slices, DEC-NNN ADRs
(`.claude/artifacts/loop/decisions/`), a pre-slice-1 architect+risk gate, cost
tracking, and git-worktree parallelism. Prior session already concluded the
OpenSpec-borrowable idea: a maintained `specs/`-as-source-of-truth tree paired
with a change-archive loop (we already have proposals -> contracts -> slices;
not re-verified today, carried forward as given).

### Answer

Of the four frameworks, none is a wholesale fit — each optimizes for a
different agent runtime (IDE vs CLI vs registry) — but each has exactly one
mechanism worth lifting: Spec Kit's codebase-vs-spec drift auditor
(`/speckit.converge`), Kiro's spec-derived property-based testing, BMAD's
self-contained "sharded" story context, and Tessl's dependency-spec pinning
against API hallucination. The rest of each framework (persona proliferation,
full spec-as-source code regeneration, EARS-strict grammar) is a worse fit for
a Claude-Code-plugin harness than what we already run.

## Evidence

| Claim | Source (URL) | Accessed | Tier | Consensus |
|---|---|---|---|---|
| Spec Kit ships slash commands `/speckit.constitution`, `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, `/speckit.implement`, `/speckit.clarify`, `/speckit.converge` | https://github.com/github/spec-kit | 2026-07-09 | T1 | strong (repo is primary source) |
| Spec Kit's constitution lives at `.specify/memory/constitution.md`, holds non-negotiable project principles referenced during planning | https://github.com/github/spec-kit | 2026-07-09 | T1 | strong |
| Spec Kit: 119,000+ stars, 10,500+ forks, latest release v0.12.9 (2026-07-09), MIT license, 30+ supported agents | https://github.com/github/spec-kit | 2026-07-09 | T1 | strong |
| Kiro specs = `requirements.md` (EARS notation) + `design.md` + `tasks.md`, three-phase workflow | https://kiro.dev/docs/specs/feature-specs/ | 2026-07-09 | T2 | strong |
| EARS pattern example: "WHEN a user submits a form with invalid data THE SYSTEM SHALL display validation errors next to the relevant fields" | https://kiro.dev/docs/specs/feature-specs/ | 2026-07-09 | T2 | strong |
| Kiro reached GA on 2025-11-17, adding property-based testing (PBT) that extracts properties from EARS specs and generates randomized test cases to check implementation against the spec | https://kiro.dev/blog/general-availability/ | 2026-07-09 | T2 | single_source (no independent T3 corroboration fetched) |
| Kiro pricing: Free (50 credits), Pro $20/mo, Pro+ $40/mo, Power $200/mo, overage $0.04/credit | https://kiro.dev/blog/new-pricing-plans-and-auto/ | 2026-07-09 | T2 | strong |
| BMAD-METHOD = agent personas (PM, Architect, Dev, UX, Scrum Master, etc.) run through Analysis -> Planning -> Architecture -> Implementation | https://github.com/bmad-code-org/BMAD-METHOD | 2026-07-09 | T1 | strong |
| BMAD-METHOD: 50.3k stars, 5.8k forks, latest release v6.10.0 (2026-07-03), MIT license | https://github.com/bmad-code-org/BMAD-METHOD | 2026-07-09 | T1 | strong |
| BMAD's Scrum Master persona "shards" PRD + architecture into self-contained story files carrying embedded PRD excerpts, architecture snippets, data contracts, and acceptance tests so the Dev agent doesn't re-read source docs | third-party blogs (CodeMySpec, GMO engineering blog, Medium — no BMAD-owned page confirmed this session) | 2026-07-09 | T3/T4 | moderate (consistent across 3 independent third-party writeups, but not confirmed against BMAD's own docs this session) |
| Tessl's thesis: "the spec is now the long-lived artifact," code is derived from a complete spec rather than the reverse | https://tessl.io/blog/from-code-centric-to-spec-centric/ (2025-06-27) | 2026-07-09 | T2 | strong |
| Tessl workflow: requirements gathering -> spec written to `specs/` -> stakeholder approval checkpoint -> implementation + spec update from discoveries | https://docs.tessl.io/use/spec-driven-development-with-tessl | 2026-07-09 | T2 | strong |
| Tessl Registry: 10,000+ pre-built dependency specs to reduce API hallucination in agent-generated code (registry scale not confirmed on the docs page fetched directly; from search aggregation only) | https://tessl.io/blog/tessl-launches-spec-driven-framework-and-registry/ (not independently fetched this session — search-snippet only) | 2026-07-09 | T3 | single_source — flagged, see Knowledge gaps |
| Independent comparative critique: Kiro is "lightweight...linear," Spec Kit is "spec-first" despite constitution aspirations, Tessl is the only one pursuing true spec-anchored/spec-as-source with `// GENERATED FROM SPEC — DO NOT EDIT` markers and remains in private beta | https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html (Birgitta Böckeler, Thoughtworks, 2025-10-15) | 2026-07-09 | T3 | strong (named author, reputable venue, hands-on account) |
| Same source: SDD tooling risks scale mismatch (a trivial bug produced "4 user stories with 16 acceptance criteria"), verbose-markdown review burden, and historical parallel to Model-Driven Development's inflexibility+non-determinism combo | https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html | 2026-07-09 | T3 | single_source (one author's field report; treat as directional signal, not proven) |

## Contradictions

- **"Constitution" as differentiator vs. reality**: Spec Kit markets
  `constitution.md` as a distinctive governance mechanism (T1, repo README).
  We already run the equivalent — `.claude/crew/constitution.md` +
  `CLAUDE.md` — so it is not a net-new steal for us, only a naming
  confirmation that the pattern is industry-validated. Resolution: not a gap,
  already covered.
- **Spec-first vs spec-anchored framing**: Tessl's own marketing (T2) presents
  itself as the rigorous end of the spectrum; Böckeler's independent
  hands-on account (T3) corroborates that only Tessl attempts true
  spec-as-source, but also flags it as the least mature (private beta) and
  draws a contrarian parallel to Model-Driven Development's historical
  failure mode. Resolution: Tessl's differentiator is real but immature —
  treat the mechanism as worth studying, not worth adopting wholesale.
- **BMAD's "sharded story" mechanism** is well corroborated across three
  independent third-party writeups (moderate consensus) but I could not
  fetch a BMAD-owned page that describes it in the same terms this session
  (the official README returned partial-load errors) — flagged as
  `requires_further_research` if this becomes load-bearing for an actual
  implementation decision, not just a research steal-list.

## Per-framework analysis

### 1. GitHub Spec Kit

**What it is / maturity.** MIT-licensed CLI (`specify`) plus a family of
slash-command prompts (`/speckit.constitution`, `/speckit.specify`,
`/speckit.plan`, `/speckit.tasks`, `/speckit.implement`, `/speckit.clarify`,
`/speckit.converge`) that wire spec-driven development into 30+ AI coding
agents (Copilot, Claude Code, Gemini, etc.). By far the largest community
footprint of the four: 119k+ stars, 10.5k+ forks, actively released (v0.12.9
on 2026-07-09 — same day as this research). [github.com/github/spec-kit, 2026-07-09]

**Distinctive mechanism.** The `constitution.md` file
(`.specify/memory/constitution.md`) is a standing, non-negotiable
principles doc the agent must satisfy at every planning step — but the more
novel piece for a mature harness is `/speckit.converge`, which "assess[es]
the codebase against artifacts and identif[ies] remaining work" — i.e., a
drift auditor that runs *after* code exists, not just before.

**Steal candidate.** `/speckit.converge`'s codebase-vs-spec reconciliation.
We have per-slice grading and a pre-slice-1 architect+risk gate, but nothing
that periodically re-checks whether shipped code across a whole *phase*
still matches its FEATs'/SPECs' acceptance criteria and architect-feature
contracts — drift (undocumented scope creep, silently-abandoned ACs) can
accumulate between phase gates. **Plug-in point:** extend
`/runner:phase-gate` with a converge-style step that diffs completed slice
output against the phase's FEAT acceptance criteria and architect contracts
before allowing the next phase to open.

**Do not copy.** `constitution.md` itself — we already have the equivalent
(`.claude/crew/constitution.md` + `CLAUDE.md`); reimplementing it under a
new name would just fragment where "the rules" live. Also skip the
sequential `/specify -> /plan -> /tasks` rigidity as a *user-facing* command
surface — our FEAT -> SPEC -> slice pipeline already has the same shape with
PM triage and an architect gate Spec Kit lacks.

### 2. Kiro (AWS)

**What it is / maturity.** A Code-OSS-based IDE from AWS, GA since
2025-11-17 (preview from July 2025), with credit-metered pricing (Free
50 credits; Pro $20/mo; Pro+ $40/mo; Power $200/mo; $0.04/credit overage).
[kiro.dev/blog/general-availability/, kiro.dev/blog/new-pricing-plans-and-auto/,
2026-07-09]

**Distinctive mechanism.** Requirements are written in EARS notation
("WHEN [condition] THE SYSTEM SHALL [behavior]") which the agent parses into
`design.md` and `tasks.md`. At GA, Kiro added **property-based testing (PBT)
derived directly from the EARS spec**: it extracts the property implied by a
requirement statement and generates many randomized test cases (different
users, entities, edge cases) to check that the implementation actually
satisfies the stated behavior, rather than relying on one hand-written
example test. [kiro.dev/blog/general-availability/, 2026-07-09]

**Steal candidate.** Spec-derived property-based testing. Our
Given-When-Then acceptance criteria are already structurally close to EARS
(constrained WHEN/SHALL-equivalent grammar), so we could extract the
"property" implied by each AC line and auto-generate a property-based test
sweep instead of trusting that the builder's hand-written unit test actually
covers the AC's intent. **Plug-in point:** the validator stage — after a
slice implements code against GWT ACs, run a PBT-generation step (per AC) as
part of validation evidence, supplementing rather than replacing existing
tests.

**Do not copy.** The IDE-centric, closed-source, credit-metered runtime
model — Kiro's spec workflow is inseparable from its own agent loop and
Bedrock billing; there's no standalone CLI/library to vendor. Also skip
strict EARS grammar substitution for GWT — the two notations are functionally
equivalent for our purposes, and migrating existing FEATs would be pure
churn with no new expressive power.

### 3. BMAD-METHOD

**What it is / maturity.** MIT-licensed, "Breakthrough Method for Agile
AI-Driven Development" — a persona-driven framework (Analyst, PM, Architect,
UX, Scrum Master, Dev, 12+ personas total per its own README) that runs
Analysis -> Planning -> Architecture -> Implementation. Second-largest
community footprint of the four: 50.3k stars, 5.8k forks, latest release
v6.10.0 (2026-07-03), very active (1,974+ commits, 38 releases).
[github.com/bmad-code-org/BMAD-METHOD, 2026-07-09]

**Distinctive mechanism.** "Epic sharding": a Scrum Master persona breaks
the PRD + architecture doc into individual, self-contained story files, each
embedding the relevant PRD excerpt, architecture snippet, data contracts,
and acceptance tests directly inline — explicitly aimed at preventing
"context collapse" where a Dev agent has to re-read sprawling source docs to
get full context on one unit of work. (Corroborated by three independent
third-party writeups; BMAD's own README did not fully render this session —
see Contradictions.)

**Steal candidate.** Embedded, self-contained slice context. Our
`/runner:slice start` ceremony hands a `dispatchInstruction` to the builder
subagent, but if that instruction only *points at* the FEAT/SPEC/architect
contract files rather than inlining the relevant excerpts, the builder still
pays a rediscovery cost every slice, and larger backlogs are exactly where
context loss bites hardest. **Plug-in point:** the slice-start dispatch
payload — inline the FEAT's acceptance criteria, the relevant architect
contract excerpt, and any related DEC-NNN summary directly into the
`dispatchInstruction` text rather than requiring the builder to re-open
three separate files. Low effort, directly addresses a known failure mode
of long-running loops.

**Do not copy.** The persona count. Six-plus named agent personas (Analyst,
PM, Architect, UX, Scrum Master, Dev) duplicates and fragments the roles we
already run (PM/architect/builder/reviewer/validator/deployer) and directly
conflicts with our constitution's "one owner per task" rule — adding more
named personas without collapsing existing ones would multiply handoffs,
not context, and is a scope-discipline violation per our own harness rules.

### 4. Tessl

**What it is / maturity.** Founded by Guy Podjarny; positions itself at the
most aggressive end of the spectrum — "spec-as-source," where the spec is
the durable artifact and code is a build output, marked with
`// GENERATED FROM SPEC — DO NOT EDIT` comments and (per Böckeler's
first-hand account) currently a one-spec-to-one-file mapping. Still in
**private beta** per the only independent field report I could fetch this
session — no GA date or public usage numbers found. [tessl.io/blog/from-code-centric-to-spec-centric/,
martinfowler.com/.../sdd-3-tools.html, 2026-07-09]

**Distinctive mechanism.** The Tessl Registry — a catalog of dependency
specs (claimed 10,000+, unverified this session, see Knowledge gaps) meant
to give agents an accurate contract for third-party library APIs so
generated code doesn't hallucinate methods/versions. This is the one piece
of Tessl that's usable independent of the full spec-as-source pipeline.

**Steal candidate.** A small, internal analog of the dependency registry:
when a slice integrates a third-party API/library, pin a short
"how this dependency's API actually works" contract snippet alongside the
architect-feature contract (which today covers *our own* OpenAPI
surface, not external dependencies we call into). **Plug-in point:** the
architect-feature contract stage — extend it to optionally attach a pinned
external-API contract excerpt when a slice's acceptance criteria require
integrating a third-party service, reducing hallucinated-API risk during
implementation.

**Do not copy.** Full spec-as-source with regenerate-on-change code and
"DO NOT EDIT" markers. This is the least proven idea of the four (private
beta, no GA, one-to-one file mapping still evolving) and Böckeler's
independent critique explicitly flags the historical failure mode it risks
reprising (Model-Driven Development's rigidity, combined with LLM
non-determinism — arguably worse than either alone). Our harness's model —
humans and agents both hand-editing code directly, with specs as guidance
rather than a compile source — is a poor fit for wholesale replacement by
a regenerate-from-spec pipeline.

## Ranked steal shortlist (top 5, across all 4 + OpenSpec)

| Rank | Idea | Source | Effort | Lands in |
|---|---|---|---|---|
| 1 | Maintained `specs/`-as-source-of-truth tree + change-archive loop (already concluded prior session; carried forward, not re-verified today) | OpenSpec | M | `specsRoot` lifecycle (`draft -> approved -> decomposed -> satisfied -> archived`) + decisions archive |
| 2 | Codebase-vs-spec drift auditor (converge-style reconciliation after code ships, not just before) | Spec Kit `/speckit.converge` | M | `/runner:phase-gate` |
| 3 | Embedded, self-contained slice-dispatch context (inline FEAT ACs + architect-contract excerpt + related DEC-NNN summary instead of file pointers) | BMAD epic sharding | S | `/runner:slice start` dispatchInstruction |
| 4 | Spec-derived property-based test generation from GWT acceptance criteria | Kiro PBT-from-EARS | S | validator stage, per-AC test sweep |
| 5 | Internal mini dependency-spec pinning for third-party APIs a slice integrates against | Tessl Registry | L | architect-feature contract stage (extension) |

Effort scale: S = single-session harness tweak (prompt/template change), M =
new artifact type or gate logic, L = new subsystem (registry, storage,
lookup tooling).

## Knowledge gaps

- Tessl Registry's "10,000+ specs" figure came from a search-engine summary
  of a Tessl blog post I did not independently fetch this session — treat
  as `single_source`/unverified until fetched directly.
- BMAD's "epic sharding" story-file mechanism is corroborated by three
  independent third-party writeups but the BMAD-METHOD GitHub README itself
  returned partial-load errors when fetched — if this steal item (rank 3)
  moves to implementation, re-verify against BMAD's own docs (e.g. its
  `docs/` folder or user guide) before committing to the exact story-file
  schema.
- Kiro's PBT-from-EARS claim rests on a single T2 source (Kiro's own GA
  announcement) with no independent T3 corroboration fetched this session —
  reasonable to trust as "what Kiro claims to ship" but not yet
  cross-checked against a third-party hands-on account.
- No repo/release-cadence inspection was done for any of the four (no git
  clone or commit-log analysis) — maturity signals here are limited to
  stars/forks/release-tag dates, which is a weaker trajectory signal than
  commit velocity or contributor count per Framework 1 guidance. If a steal
  decision becomes higher-stakes, pull `git log --oneline -20` on
  `github/spec-kit` and `bmad-code-org/BMAD-METHOD` for real cadence data.
- Böckeler's critique (Fowler article) is a single author's field report
  from October 2025; I did not find a second independent contrarian source
  making the same "MDD-parallel" argument — flagged as `single_source` for
  that specific claim, though the underlying complaint (verbose markdown,
  scale mismatch) is a reasonable directional signal even standing alone.
- Did not re-research OpenSpec in this session (per task framing, it was
  given as an already-concluded prior finding) — rank-1 shortlist item is
  carried forward, not independently re-verified today.

## Confidence

medium — every framework-specific mechanism claim is backed by a T1/T2
primary source fetched this session, and the Kiro/Spec Kit/Tessl comparative
framing is corroborated by an independent T3 field report; confidence is
capped at medium (not high) because one steal-relevant claim (BMAD story
sharding) rests on T3/T4 third-party sources only, one claim (Tessl registry
scale) is single-source and unfetched directly, and no repo-velocity
(commit-level) inspection was performed for any of the four frameworks.
