---
name: Specialist calibration Clay-only disable
description: Walk-forward rescore corrected the original Ticket 1 finding; specialist calibration is only disabled for Clay, not globally.
---

## Rule
Specialist calibration is disabled for Clay-surface matches only (`specialistDisabledForSurface = input.surface === "Clay"` in `index.ts` Phase 6 block). It remains active for Grass, Hard, and IndoorHard.

**Why:** Full 196,924-row corpus rescore (2026-08-08) showed:
- Overall: specialist slightly better (+0.34pp: 62.83% vs 62.49%)
- Clay: specialist worse −1.67pp (61.37% vs 63.04%)
- Grass: specialist better +2.19pp; Hard: +1.30pp; IndoorHard: +1.47pp

Global disable would cost real gains on three surfaces to fix a Clay-only problem.

**Original Ticket 1 figures were wrong:** The ticket stated "specialist applied → 60.9%, off → 64.0% (−3.1pp overall, −7.0pp Clay)". These figures were NOT reproduced on the current corpus. The original analysis likely used a different data window or filter. The corpus-wide figures above are what the Clay-only decision is based on. Do not treat the original −7.0pp figure as current fact.

**How to apply:** When auditing specialist calibration accuracy: expect Clay to improve post-change, and Grass/Hard/IndoorHard to stay near their specialist-on baselines. A post-change rescore on fresh (non-overlapping) Clay paper_trade rows will confirm whether the −1.67pp gap closes.

**Follow-up:** Revisit Clay specialist once DQ scoring redesign (Ticket 3 follow-up) produces cleaner per-surface signals. The Clay specialist model data itself is unchanged — only its application to live scoring is suspended.
