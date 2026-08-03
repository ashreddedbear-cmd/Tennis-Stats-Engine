/**
 * Recalibrated model-disagreement scoring (2026-07-13 disagreement/upset-risk spec, Part A).
 *
 * Replaces the old raw max-min spread (which counted every model equally, so a single
 * low-reliability secondary module -- or even a fringe blend stage -- could single-handedly push
 * a match into "High Disagreement" even when the validated core signals agreed) with a weighted
 * standard deviation over each model's EXISTING effective ensemble weight
 * (`weightUsed` = reliability x its `ENSEMBLE_WEIGHT_PRIOR`, already normalized to sum to 1 by
 * `buildEnsemble` -- see dataQuality.ts). No new walk-forward/Brier/ECE tracking is invented here;
 * "validation reliability" is exactly the reliability score + prior the engine already computes.
 */

export type ModelAgreement = "Strong" | "Moderate" | "Mixed" | "HighDisagreement";

export const AGREEMENT_ORDER: ModelAgreement[] = ["Strong", "Moderate", "Mixed", "HighDisagreement"];

/** The more cautious (worse) of two agreement readings -- used to fold secondary votes (general-vs-specialist, pre-simulator-vs-simulator) into the overall agreement without ever letting one good reading paper over a bad one. */
export function worseAgreement(a: ModelAgreement, b: ModelAgreement): ModelAgreement {
  return AGREEMENT_ORDER.indexOf(a) >= AGREEMENT_ORDER.indexOf(b) ? a : b;
}

/**
 * The three feature modules the 2026-07-13 ablation report validated as the engine's real
 * predictive signal (see `ENSEMBLE_WEIGHT_PRIOR` in dataQuality.ts). These are the only models
 * whose own directional conflict, by itself, is allowed to push disagreement all the way to
 * HighDisagreement (spec Part A.C: "prioritize the validated core models").
 */
export const CORE_MODEL_NAMES = new Set(["Surface Elo", "Serve & Return", "Recent Form"]);

/**
 * A model needs at least this share of the vote's total effective weight before it counts as a
 * real, opinionated voice for the direction-conflict check or the disagreement explanation. Below
 * this floor a model can still nudge the weighted mean/stddev a little, but can never by itself
 * flip the category or headline the explanation -- this is what stops a reliability-5 or
 * weight-0.01 module from manufacturing a HighDisagreement reading alone (spec Part A.B/A.C).
 */
const MEANINGFUL_WEIGHT_SHARE = 0.15;

/**
 * Task #146 ("stop correlated modules from double-counting the same evidence"): Surface Elo,
 * Serve & Return, and Recent Form all derive their edges from largely the same underlying
 * recent-match history for each player (see surfaceElo.ts/serveReturn.ts/recentForm.ts), so their
 * agreement is not three independent confirmations -- it's frequently the same evidence expressed
 * three ways. A real-data check (docs/audit-task146-correlated-cluster-overconfidence.md) over
 * 1,031 graded rows with a stored engine breakdown found: (1) the trio's pairwise same-direction
 * rate is 74.2% (vs ~50% expected if genuinely independent); (2) with Fatigue/Availability/Match
 * Load Recovery excluded from the ensemble vote (`EXCLUDED_FROM_ENSEMBLE`, dataQuality.ts),
 * Head-to-Head is the ONLY other module that ever votes alongside the trio, and it never reaches
 * `MEANINGFUL_WEIGHT_SHARE` -- so in practice every "Strong" reading today is driven by the trio
 * alone, with no genuinely independent confirmation; (3) rows where "Strong" is driven only by
 * the trio show log loss 0.715 (WORSE than a coin flip's 0.693) and calibrated ECE 0.079, both
 * markedly worse than rows where the trio genuinely disagrees (log loss 0.692, ECE 0.040) -- the
 * confidence the trio's agreement currently buys is not supported by real outcomes.
 */
export const CORRELATED_CORE_CLUSTER = new Set(["Surface Elo", "Serve & Return", "Recent Form"]);

/**
 * Collapses any present members of `CORRELATED_CORE_CLUSTER` into a single combined vote (same
 * total weight, weight-averaged probability) before the spread/support statistics below are
 * computed, so their mutual agreement can no longer manufacture an artificially tight weighted
 * spread / high `leadingSupportPercent` on its own -- it now counts for exactly what one combined
 * vote of that size would. This intentionally does NOT touch `ensembleProbability` (computed
 * separately in `ensemble.ts`, out of this task's scope -- see its own doc) or the raw, per-module
 * `coreModelsConflict`/`meaningfulModelsConflict` checks below, which still read the ORIGINAL
 * per-module votes so a genuine internal split within the trio (e.g. Surface Elo favoring player 1
 * while Recent Form favors player 2) is never hidden by the collapse.
 */
function collapseCorrelatedCluster(models: DisagreementModelInput[]): DisagreementModelInput[] {
  const clusterMembers = models.filter((m) => CORRELATED_CORE_CLUSTER.has(m.modelName));
  const clusterWeight = clusterMembers.reduce((sum, m) => sum + m.weightUsed, 0);
  if (clusterMembers.length < 2 || clusterWeight === 0) return models;

  // Only collapse when the cluster members actually AGREE on direction. When they genuinely
  // conflict (e.g. Surface Elo favors player 1 while Recent Form favors player 2), that spread is
  // real, independent-of-shared-data information -- collapsing it away would flatten a genuine
  // internal split into a single artificial ~50/50 point and erase the weighted-spread magnitude
  // the disagreement explanation displays (`coreModelsConflict`, computed separately below off the
  // raw list, still catches the conflict for the category itself either way).
  const firstDirection = clusterMembers[0].player1Probability >= 50;
  const allAgreeOnDirection = clusterMembers.every((m) => (m.player1Probability >= 50) === firstDirection);
  if (!allAgreeOnDirection) return models;

  const clusterProbability = clusterMembers.reduce((sum, m) => sum + m.player1Probability * m.weightUsed, 0) / clusterWeight;
  const others = models.filter((m) => !CORRELATED_CORE_CLUSTER.has(m.modelName));
  return [
    ...others,
    {
      modelName: clusterMembers.map((m) => m.modelName).join(" / "),
      player1Probability: clusterProbability,
      weightUsed: clusterWeight,
    },
  ];
}

export interface DisagreementModelInput {
  modelName: string;
  player1Probability: number;
  weightUsed: number;
}

export interface WeightedDisagreement {
  modelAgreement: ModelAgreement;
  /** Weighted standard deviation (percentage points) of player1Probability across the vote. */
  weightedStdDev: number;
  /** % of the vote's total effective weight backing whichever player has the most support -- 100 means every meaningfully-weighted model points the same direction; near 50 means the vote is split. This is a DIRECTIONAL measure, not a margin-from-50 one: three models clustered at 52/53/55 for the same player score 100 here, not ~53 (spec Part A.E). */
  leadingSupportPercent: number;
  /** % of the vote's total effective weight specifically backing player 1 (0–100, player-1-relative, can be below 50).
   * Use normalizeSupportToWinner() before displaying this on any card or export -- never show it raw. */
  player1SupportPercent: number;
  /** True only when at least two of the three validated core models each carry a meaningful weight share AND point at different players. */
  coreModelsConflict: boolean;
  /** Every model carrying a meaningful weight share, sorted by weight descending -- the models actually capable of driving the reading. Used to build the human-readable explanation. Empty when modelAgreement is "Strong". */
  conflictingModels: DisagreementModelInput[];
}

/**
 * Computes weighted mean/variance/stddev and directional support over a set of model votes,
 * using each model's own `weightUsed` as its effective weight -- no separate validation-reliability
 * tracking needs to exist; `weightUsed` already bakes in reliability x the module's fixed
 * importance prior. Intended to be called once over the core feature-module vote (Surface Elo,
 * Serve & Return, Recent Form, Fatigue, Head-to-Head -- the same set `buildEnsemble` already
 * builds), and again, separately, over any 2-model blend stage (general-vs-specialist,
 * pre-simulator-vs-simulator) that needs to fold its own reading into the overall agreement.
 */
export function computeWeightedDisagreement(models: DisagreementModelInput[]): WeightedDisagreement {
  const totalWeightRaw = models.reduce((sum, m) => sum + m.weightUsed, 0);

  // No real votes to disagree over -- an empty model list or a set of models that all carry zero
  // weight. Previously the `|| 1` fallback below on a genuinely-zero total weight, combined with
  // `player2Support = totalWeight - player1Support`, fabricated 100% support for player 2 out of
  // no data at all (an empty array trivially has zero player1Support, so the subtraction assigned
  // the entire fallback weight to player 2). Report a neutral, no-conflict reading instead of
  // inventing a leader.
  if (models.length === 0 || totalWeightRaw === 0) {
    return { modelAgreement: "Strong", weightedStdDev: 0, leadingSupportPercent: 50, player1SupportPercent: 50, coreModelsConflict: false, conflictingModels: [] };
  }
  const totalWeight = totalWeightRaw;

  // Task #146: spread/support are computed over the CORRELATED-CLUSTER-COLLAPSED vote list (see
  // `collapseCorrelatedCluster`'s doc), not the raw per-module list, so Surface Elo/Serve &
  // Return/Recent Form all pointing the same way -- likely the same underlying recent-match
  // evidence, not three independent confirmations -- can't by itself manufacture a tighter spread
  // or higher leading-support reading than one combined vote of that size would produce. Total
  // weight is unchanged by collapsing (it's a partition of the same weights), so `totalWeight`
  // above still applies to the collapsed list too.
  const effectiveModels = collapseCorrelatedCluster(models);

  const weightedMean = effectiveModels.reduce((sum, m) => sum + m.player1Probability * m.weightUsed, 0) / totalWeight;
  const weightedVariance = effectiveModels.reduce((sum, m) => sum + m.weightUsed * (m.player1Probability - weightedMean) ** 2, 0) / totalWeight;
  const weightedStdDev = Math.sqrt(weightedVariance);

  const player1Support = effectiveModels.filter((m) => m.player1Probability >= 50).reduce((sum, m) => sum + m.weightUsed, 0);
  const player2Support = totalWeight - player1Support;
  const leadingSupportPercent = (Math.max(player1Support, player2Support) / totalWeight) * 100;

  // The genuine-conflict checks below intentionally keep reading the RAW, uncollapsed `models` --
  // collapsing would blend away a real internal split within the trio (e.g. Surface Elo favoring
  // player 1 while Recent Form favors player 2), which is exactly the case `coreModelsConflict`
  // exists to catch. `conflictingModels` (used for the human-readable explanation) is built from
  // the raw list too, so the explanation still names each real module's own vote.
  const meaningfulModels = models.filter((m) => m.weightUsed / totalWeight >= MEANINGFUL_WEIGHT_SHARE);
  const meaningfulCoreModels = meaningfulModels.filter((m) => CORE_MODEL_NAMES.has(m.modelName));
  const coreModelsConflict =
    meaningfulCoreModels.some((m) => m.player1Probability >= 50) && meaningfulCoreModels.some((m) => m.player1Probability < 50);

  // Task #114 fix: a matchup where every MEANINGFULLY-weighted model favors the same player must
  // never be classified as HighDisagreement, no matter how wide their confidence spread is (e.g.
  // Surface Elo 74%/Serve & Return 51%/Recent Form 51%, all favoring the same player, previously
  // hit HighDisagreement purely off `weightedStdDev > 11` -- that conflates "models differ in how
  // strongly they favor a player" with "models favor different players"). HighDisagreement now
  // requires genuine directional conflict: meaningful effective weight on BOTH sides of 50%,
  // either among the validated core models specifically (`coreModelsConflict`) or more broadly
  // among any meaningfully-weighted models (`meaningfulModelsConflict`, e.g. a non-core model
  // conflicting with a core one). A wide spread with no such conflict still degrades the category
  // -- just never past "Mixed", via the stddev/support thresholds below.
  const meaningfulModelsConflict =
    meaningfulModels.some((m) => m.player1Probability >= 50) && meaningfulModels.some((m) => m.player1Probability < 50);
  const genuineDirectionalConflict = coreModelsConflict || meaningfulModelsConflict;

  // Thresholds derived from spec Part A.D's starting categories (weighted stddev <6/6-11/>11,
  // effective support >=70/58-70/<58). The original >11/<58 band fed HighDisagreement directly;
  // it now folds into "Mixed" (its severity is still reflected there) since HighDisagreement is
  // reserved for genuine directional conflict per the fix above.
  let modelAgreement: ModelAgreement;
  if (genuineDirectionalConflict) {
    modelAgreement = "HighDisagreement";
  } else if (weightedStdDev > 9 || leadingSupportPercent < 65) {
    modelAgreement = "Mixed";
  } else if (weightedStdDev > 6 || leadingSupportPercent < 75) {
    modelAgreement = "Moderate";
  } else {
    modelAgreement = "Strong";
  }

  const conflictingModels = modelAgreement === "Strong" ? [] : meaningfulModels.slice().sort((a, b) => b.weightUsed - a.weightUsed);

  return {
    modelAgreement,
    weightedStdDev: Math.round(weightedStdDev * 10) / 10,
    leadingSupportPercent: Math.round(leadingSupportPercent * 10) / 10,
    player1SupportPercent: Math.round((player1Support / totalWeight) * 1000) / 10,
    coreModelsConflict,
    conflictingModels,
  };
}

/** How near the FINAL probability sits to a coin flip -- deliberately independent of modelAgreement above. A match can be close (near 50/50) while every model agrees on direction (low disagreement, spec Part A.E), or genuinely disagree while the blended probability lands well away from 50. */
export type MatchupCloseness = "VeryClose" | "Close" | "Moderate" | "Clear";

export function computeMatchupCloseness(finalProbability: number): MatchupCloseness {
  const margin = Math.abs(finalProbability - 50);
  return margin < 5 ? "VeryClose" : margin < 15 ? "Close" : margin < 30 ? "Moderate" : "Clear";
}

/**
 * Human-readable explanation naming the actual conflicting models, their probabilities, and their
 * weights (spec Part A.F: "do not show High Disagreement without identifying the actual
 * conflict"). Null exactly when modelAgreement is "Strong" -- there is nothing to explain.
 *
 * Task #114 fix: a wide confidence spread with every meaningfully-weighted model favoring the SAME
 * player (Moderate/Mixed from stddev/support alone, never HighDisagreement per the gate above) is
 * a genuinely different situation from real directional conflict, and must read that way -- never
 * phrased so it implies the models are in disagreement about who wins.
 */
/**
 * Converts a player-1-relative support percentage to the predicted winner's perspective.
 * Always call this before showing agreement on any card, export, or admin view -- never display
 * player1SupportPercent directly when the predicted winner may be player2.
 */
export function normalizeSupportToWinner(
  player1SupportPercent: number,
  player1Id: string,
  predictedWinnerId: string,
): number {
  return predictedWinnerId === player1Id ? player1SupportPercent : 100 - player1SupportPercent;
}

export function buildDisagreementNote(disagreement: WeightedDisagreement, player1Name: string, player2Name: string): string | null {
  if (disagreement.modelAgreement === "Strong" || disagreement.conflictingModels.length === 0) return null;

  const agreementLabel = disagreement.modelAgreement.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
  const votes = disagreement.conflictingModels
    .map((m) => {
      const favorsPlayer1 = m.player1Probability >= 50;
      const displayProbability = favorsPlayer1 ? m.player1Probability : 100 - m.player1Probability;
      return `${m.modelName} favors ${favorsPlayer1 ? player1Name : player2Name} at ${displayProbability.toFixed(0)}% (weight ${m.weightUsed.toFixed(2)})`;
    })
    .join("; ");

  const allFavorPlayer1 = disagreement.conflictingModels.every((m) => m.player1Probability >= 50);
  const allFavorPlayer2 = disagreement.conflictingModels.every((m) => m.player1Probability < 50);
  const isUnanimousDirection = !disagreement.coreModelsConflict && (allFavorPlayer1 || allFavorPlayer2);

  if (isUnanimousDirection) {
    const leaderName = allFavorPlayer1 ? player1Name : player2Name;
    return `${agreementLabel}: all meaningfully weighted models favor ${leaderName} (${votes}), but their confidence levels vary -- weighted spread ${disagreement.weightedStdDev.toFixed(1)}pts, ${disagreement.leadingSupportPercent.toFixed(0)}% of effective weight behind ${leaderName}. This is a confidence-spread reading, not a real conflict over who wins.`;
  }

  return `${agreementLabel}: ${votes}. Weighted spread ${disagreement.weightedStdDev.toFixed(1)}pts across meaningfully-weighted models, ${disagreement.leadingSupportPercent.toFixed(0)}% of effective weight behind the leader.`;
}
