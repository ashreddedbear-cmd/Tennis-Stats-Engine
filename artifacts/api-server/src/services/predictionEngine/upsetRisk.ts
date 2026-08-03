import type { WeightedDisagreement } from "./disagreement";

/**
 * Recalibrated upset-risk scoring (2026-07-13 disagreement/upset-risk spec, Part 2).
 *
 * Replaces the old two-input version (favorite margin + modelAgreement enum only) with an
 * auditable, component-based score. Each component is named and exposed on the result so a risk
 * label is never a black box -- `buildUpsetRiskNote` names the actual top contributors, the same
 * pattern `buildDisagreementNote`/`modelConflictNote` already use.
 *
 * Component weights and tier boundaries were NOT hand-picked: they come from
 * `src/scripts/analyzeUpsetRiskCalibration.ts`, a one-off batch analysis (see that file's header
 * -- like `runWalkForwardEvaluation`, not something to re-run casually) over 4,081 graded,
 * out-of-sample historical_test/test-segment `evaluation_predictions` rows on 2026-07-13. Two
 * findings drove the design:
 *
 *  1. Raw favorite margin (closeness to 50%) is the ONE cleanly monotonic real signal: favorite
 *     loss rate fell from 47.3% (margin 0-3) to 45.1% (3-7) to 41.8% (7-13) to 35.2% (13+). It is
 *     therefore the dominant component.
 *  2. `modelAgreement` alone correlated WEAKLY and in places in the WRONG direction (Strong:
 *     45.4% favorite-loss vs. HighDisagreement: 36.8%) -- so the old design's implicit trust in
 *     modelAgreement as a strong upset signal was not supported by real outcomes. Its per-band
 *     contribution here is intentionally small; only a genuine `coreModelsConflict` (>=2 of the
 *     three validated core models pointing at different players with real weight) gets a
 *     meaningful bump, matching this task's "never from one weak/missing field alone" gate.
 *
 * Baseline favorite-loss rates on this corpus run high overall (~35-47%, not the illustrative
 * <25%/25-35%/35-45%/45%+ example bands in the spec) -- an existing, separately-tracked
 * calibration-accuracy characteristic of this engine, not something this task changes (out of
 * scope: calibration methodology itself). Tier boundaries below are calibrated against this
 * corpus's OWN observed range rather than forced to match the illustrative percentages.
 */

export type UpsetRisk = "LOW" | "MODERATE" | "HIGH" | "EXTREME";

export interface UpsetRiskComponents {
  /** Core-model direction conflict + modelAgreement band. Max 33 (8 band + 25 core-conflict bonus). */
  modelConflict: number;
  /** How close the final probability sits to a coin flip. Max 45 -- the one component with a clean, monotonic real-outcome relationship (see header). */
  favoriteWeakness: number;
  /** Missing/weak inputs not already double-counted by `sampleDepth` below (identity, serve/return, availability gaps) plus a raw-vs-calibrated divergence bump. Max 15. */
  uncertainty: number;
  /** Thin surface-Elo sample for either player. Max 10. */
  sampleDepth: number;
  /** Tournament-level favorite-loss deviation from this corpus's own average, among clear favorites only, for levels with enough real sample (n>=30) to trust the deviation. Max 7; 0 (not negative) when the level actually skews SAFER (e.g. ITF), since this component only ever adds risk, never removes it. */
  volatility: number;
  /**
   * No genuinely validated match-hazard signal (e.g. weather, altitude, retirement risk) exists
   * in this engine's evaluation history yet -- always 0, visibly, rather than fabricated. See
   * `matchupHazardNote` on the result for the honest disclosure.
   */
  matchupHazard: number;
}

export interface UpsetRiskInput {
  /** Player-1-relative final calibrated probability. */
  calibratedProbability: number;
  /** The governing disagreement reading already computed for this prediction (2026-07-13 disagreement recalibration). */
  disagreement: WeightedDisagreement;
  /** `modelConflict` from index.ts -- true when calibration/specialist/simulator blending flipped the pick away from the raw evidence vote. A real, separate uncertainty signal from disagreement (which measures spread among modules, not raw-vs-final divergence). */
  rawVsCalibratedConflict: boolean;
  /** Warnings NOT already about thin surface-Elo sample or missing head-to-head (both already have their own, deliberately separate treatment -- see the double-counting note below) -- e.g. identity-resolution, serve/return-data, or availability-data gaps. */
  uncertaintyWarningCount: number;
  /** min(surfaceElo.sampleSizePlayer1, surfaceElo.sampleSizePlayer2). */
  minSurfaceSampleSize: number;
  /** `evaluation_predictions.tournamentLevel`-style label (e.g. "ATP250", "Challenger", "ITF"), or null when unknown. */
  tournamentLevel: string | null;
}

export interface UpsetRiskResult {
  upsetRisk: UpsetRisk;
  /** Raw combined score (not itself shown to users) -- exposed for auditability/testing. */
  score: number;
  components: UpsetRiskComponents;
  /** Names of the components that meaningfully contributed to this score, most-contributing first. Empty only when every component is 0. */
  topContributors: string[];
  /** Always present -- explains which components drove the tier, or (Low tier / no meaningful contributors) states plainly that no single factor stood out. Mirrors `disagreementNote`/`modelConflictNote`'s "never a silent label" pattern. */
  note: string;
}

// See the module-level doc comment for how these were derived.
const AGREEMENT_BAND: Record<WeightedDisagreement["modelAgreement"], number> = { Strong: 0, Moderate: 2, Mixed: 4, HighDisagreement: 8 };
const CORE_CONFLICT_BONUS = 25;

function favoriteWeaknessScore(margin: number): number {
  if (margin < 3) return 45;
  if (margin < 7) return 30;
  if (margin < 13) return 15;
  return 0;
}

function sampleDepthScore(minSample: number): number {
  if (minSample === 0) return 10;
  if (minSample < 3) return 7;
  if (minSample < 5) return 4;
  return 0;
}

/**
 * Only levels with n>=30 clear-favorite (margin>=15) rows in the 2026-07-13 calibration run are
 * included -- everything else (Masters1000/GrandSlam/WTA1000/unknown/etc.) showed either too
 * small a sample to trust or a deviation too small to call real, so they stay at 0 rather than
 * fabricating a level-specific adjustment. ITF is a genuine negative deviation (favorites there
 * lost LESS often than this corpus's average), but the component floors at 0 -- see its doc.
 */
const VOLATILITY_BY_LEVEL: Record<string, number> = { Challenger: 7, WTA250: 7, ATP500: 7, ATP250: 3, ITF: 0 };

// Tier boundaries calibrated against the analysis script's decile table (see module doc): scores
// 8-24 (deciles 1-2) averaged ~36% favorite-loss, 24-39 (deciles 3-5) ~38-43%, 39-64 (deciles
// 6-9) ~37-47% trending up, 64+ (decile 10) ~46.5%. Boundaries below land on the clearest breaks
// in that trend.
const LOW_MAX = 25;
const MODERATE_MAX = 40;
const HIGH_MAX = 55;

export function computeUpsetRisk(input: UpsetRiskInput): UpsetRiskResult {
  const margin = Math.abs(input.calibratedProbability - 50);

  let modelConflict = AGREEMENT_BAND[input.disagreement.modelAgreement];
  if (input.disagreement.coreModelsConflict) modelConflict += CORE_CONFLICT_BONUS;

  const favoriteWeakness = favoriteWeaknessScore(margin);
  const sampleDepth = sampleDepthScore(input.minSurfaceSampleSize);
  const uncertainty = Math.min(15, input.uncertaintyWarningCount * 3 + (input.rawVsCalibratedConflict ? 5 : 0));
  const volatility = margin >= 15 ? (VOLATILITY_BY_LEVEL[input.tournamentLevel ?? ""] ?? 0) : 0;
  const matchupHazard = 0; // see field doc -- no validated hazard signal exists yet

  const components: UpsetRiskComponents = { modelConflict, favoriteWeakness, uncertainty, sampleDepth, volatility, matchupHazard };
  const score = modelConflict + favoriteWeakness + uncertainty + sampleDepth + volatility + matchupHazard;

  let upsetRisk: UpsetRisk;
  if (score < LOW_MAX) upsetRisk = "LOW";
  else if (score < MODERATE_MAX) upsetRisk = "MODERATE";
  else if (score < HIGH_MAX) upsetRisk = "HIGH";
  else upsetRisk = "EXTREME";

  // Requirement 3 of the spec: Extreme can never come from one weak/missing field alone. Even
  // when the summed score crosses HIGH_MAX, require at least one of these independently real
  // conditions before allowing EXTREME -- otherwise cap at HIGH. (In practice this rarely
  // downgrades anything: favoriteWeakness alone maxes at 45, below HIGH_MAX, so reaching EXTREME
  // already requires a real secondary contributor -- this is a hard guardrail against future
  // weight-tuning drift silently reintroducing a single-field EXTREME.)
  if (upsetRisk === "EXTREME") {
    const strongCoreConflict = input.disagreement.coreModelsConflict;
    const closeAndUncertain = margin < 3 && uncertainty >= 10;
    const severeSampleGap = input.minSurfaceSampleSize === 0;
    const highMeasuredUncertainty = uncertainty >= 15;
    if (!strongCoreConflict && !closeAndUncertain && !severeSampleGap && !highMeasuredUncertainty) {
      upsetRisk = "HIGH";
    }
  }

  const topContributors = Object.entries(components)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  return {
    upsetRisk,
    score,
    components,
    topContributors,
    note: buildUpsetRiskNote(upsetRisk, components, topContributors, margin, input.disagreement.coreModelsConflict),
  };
}

// `modelConflict` is intentionally absent here -- its label depends on *why* the component is
// nonzero (a real coreModelsConflict vs. the agreement-band term alone), so it's resolved in
// `buildUpsetRiskNote` instead of being a static string. See that function.
const COMPONENT_LABELS: Record<Exclude<keyof UpsetRiskComponents, "modelConflict">, string> = {
  favoriteWeakness: "the favorite's edge is thin",
  uncertainty: "real gaps in the underlying data",
  sampleDepth: "a very thin surface-history sample for one or both players",
  volatility: "this tournament level's historically higher favorite-upset rate",
  matchupHazard: "a verified match hazard", // never actually reachable today -- see field doc; kept for forward-compat if a real hazard signal is added
};

/**
 * Always present -- never a silent LOW/MODERATE/HIGH/EXTREME label with no stated reason.
 *
 * `modelConflict` is nonzero for two structurally different reasons -- a genuine
 * `coreModelsConflict` (>=2 core models pointing at different players) OR the agreement-band term
 * alone (e.g. HighDisagreement from spread/support alone, with no core-model direction conflict).
 * Claiming "the core models disagree on direction" in the second case is a real, checkable false
 * statement (see `disagreement.coreModelsConflict`), so the label branches on that flag rather
 * than assuming the component's presence always means a direction conflict.
 *
 * LOW tier uses a different framing from MODERATE/HIGH/EXTREME deliberately:
 *   - MODERATE/HIGH/EXTREME: "mainly because [factor]" — the factor IS elevating the tier.
 *   - LOW with no contributors: "the edge is comfortable and no risk factor is present."
 *   - LOW with contributors: "[factor] is present, but no amplifying signal compounds it to raise
 *     the risk higher." — the factor raises the score without changing the tier; saying "mainly
 *     because [thin edge]" when the tier is LOW implies the thin edge causes low risk, which is
 *     the opposite of the truth (a thin edge is a risk driver, not a safety net).
 */
function buildUpsetRiskNote(
  upsetRisk: UpsetRisk,
  components: UpsetRiskComponents,
  topContributors: string[],
  margin: number,
  coreModelsConflict: boolean,
): string {
  if (topContributors.length === 0) {
    return `${upsetRisk}: the favorite's edge is comfortable (${margin.toFixed(0)}pts from a coin flip) and no other risk factor is present.`;
  }

  // Labels used when listing contributors for MODERATE/HIGH/EXTREME tier notes.
  const namedForHighTier = topContributors
    .slice(0, 2)
    .map((key) =>
      key === "modelConflict"
        ? coreModelsConflict
          ? "the core models disagree on direction"
          : "the models' overall agreement is less than strong"
        : COMPONENT_LABELS[key as Exclude<keyof UpsetRiskComponents, "modelConflict">],
    )
    .join(" and ");

  // For MODERATE and above: factors are genuinely elevating the tier — "mainly because X" is accurate.
  if (upsetRisk !== "LOW") {
    return `${upsetRisk} upset risk, mainly because ${namedForHighTier}.`;
  }

  // LOW tier: factors contribute to the score but don't push the tier higher.
  // Use compact noun phrases so "is present" reads naturally.
  const LOW_FACTOR_NOUNS: Partial<Record<keyof UpsetRiskComponents, string>> = {
    favoriteWeakness: "a thin edge",
    uncertainty: "some data uncertainty",
    sampleDepth: "a thin surface sample for at least one player",
    volatility: "tournament-level volatility",
    matchupHazard: "a match hazard",
  };
  const namedForLow = topContributors
    .slice(0, 2)
    .map((key) =>
      key === "modelConflict"
        ? coreModelsConflict
          ? "a core-model direction conflict"
          : "partial model disagreement"
        : (LOW_FACTOR_NOUNS[key as keyof UpsetRiskComponents] ?? key),
    )
    .join(" and ");
  const isOrAre = topContributors.slice(0, 2).length === 1 ? "is" : "are";
  return `${upsetRisk} upset risk — ${namedForLow} ${isOrAre} present, but no amplifying signal compounds it to raise the risk higher.`;
}
