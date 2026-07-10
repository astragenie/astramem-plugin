# Task Handoff: archGateBudgetUsdPerFeat sizing spike

- Created: 2026-07-09T12:21:37.174Z
- From: researcher
- To: dispatcher
- Objective: Proposed $3 archGateBudgetUsdPerFeat is 15-50x too low; recommend $100 default / $160 hard ceiling, checked per-cycle and per-FEAT with halt-on-exceed.
- Allowed Scope:
  - Read-only cost sizing for the GATE reject loop (pm --rescope + crew:architect-feature[researcher+architect] + crew:architect-reviewer)
  - up to 2 cycles per FEAT. Read agent frontmatter in dev-team/agents/{architect-reviewer
  - architect
  - researcher}.md and runner-plugin/agents/pm.md; searched runner-plugin cost telemetry (cost-report artifacts
  - model-routing audit
  - triage budget default) for real $/msg anchors.
- Forbidden Scope: -
- Deliverable: Recommendation: archGateBudgetUsdPerFeat=100 (soft, per-FEAT aggregate), hard ceiling=160, plus a per-cycle checkpoint (~55-80) sampled after each of the 4 dispatches per cycle, mirroring the existing triageBudgetUsdPerBatch halt-on-BudgetExceeded pattern (no silent defer). Arithmetic: architect-reviewer (opus/15-turn) alone costs an estimated $12-24/dispatch (mid) or up to $23.55 worst-case using the real SLICE-36 anchor ($1.57/opus-msg, from docs/research/2026-06-04-model-routing-audit.md), which already blows the $3 whole-FEAT budget on its own. Full 2-cycle loop: mid $88, worst-case ~$159.
- Changed Files:
  - none (read-only spike; no files changed)
- Confidence: medium
- Risks: No architect-reviewer cost artifacts exist yet (feature never run) — per-dispatch costs are inferred from model+maxTurns+real anchors (SLICE-36 $1.57/opus-msg worst-case, aggregate cost-report $0.68/opus-msg best-case, triageBudgetUsdPerBatch=$5 as the pm-rescope analog), not measured. Recalibrate from live GATE-loop runs once available.
- Suggested Next Handoff: architect/builder to wire archGateBudgetUsdPerFeat=100, hard ceiling=160, and per-cycle budget-delta checks into the GATE reject-loop design, reusing the halt_reason=budget_exceeded pattern from runner-plugin/skills/triage/SKILL.md.

