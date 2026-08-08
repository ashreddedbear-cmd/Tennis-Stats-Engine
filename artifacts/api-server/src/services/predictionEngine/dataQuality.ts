export type DataQualityLabel = "Excellent" | "Strong" | "Acceptable" | "Limited" | "Poor";

/**
 * Fixed prior weight for how much each engine module should count toward the overall Data
 * Quality score. This is NOT a measure of how much real data resolved for a given match --
 * that's exactly what the module's own `reliability` already measures -- it's a prior on how
 * central the module actually is to the prediction, and on how meaningfully its reliability
 * really varies with real data richness (vs. being structurally low/constant for reasons that
 * have nothing to do with this match being under-supported).
 *
 * Surface Elo, Serve & Return, and Recent Form carry most of the real predictive signal in the
 * ensemble, and their reliability genuinely tracks how much real per-match data resolved for
 * this specific matchup -- weighted highest.
 *
 * Availability's reliability also genuinely tracks per-match data resolution (rest days almost
 * always resolve from real match records; travel distance depends on venue coverage) -- weighted
 * just under the core three.
 *
 * Head-to-Head's reliability collapses toward its floor whenever two players simply haven't met
 * before -- the NORMAL case for most real matchups (especially first rounds and lower tiers), not
 * a fixable data gap. A low importance weight was tried first (parity would let this expected
 * rarity single-handedly cap an otherwise well-supported prediction), but even a low, non-zero
 * weight still let the common "no meetings yet" case drag down an otherwise strong score across
 * the whole corpus. See `EXCLUDED_FROM_DATA_QUALITY` below -- Head-to-Head is now fully excluded
 * from this blend, the same way Availability is excluded from the ensemble vote.
 *
 * Fatigue's reliability is currently a fixed constant (see fatigue.ts) rather than a real
 * per-match signal of data richness -- it is weighted low enough that this constant can't
 * dominate the blended score or mask genuine weakness in the core signals.
 *
 * Match Load Recovery (Task #93, live-wiring the Task #91 redesign) also carries a fixed
 * reliability constant (see matchLoadRecovery.ts) and is a thin, single-bit signal (whether the
 * player's single most recent match went the distance) -- weighted at the same tier as
 * Head-to-Head, its closest analog in "real but structurally thin" signal importance.
 */
export const MODULE_IMPORTANCE = {
  surfaceElo: 1.3,
  serveReturn: 1.2,
  recentForm: 1.1,
  availability: 0.9,
  fatigue: 0.7,
  headToHead: 0.5,
  matchLoadRecovery: 0.4,
} as const;

/**
 * Modules excluded from the numeric Data Quality BLEND entirely (but still fully computed and
 * shown in `EngineBreakdown` for transparency -- reliability/notes/warnings are never hidden).
 *
 * Rule: any module whose reliability score cannot affect model inputs, player matching, feature
 * calculations, prediction output, calibration, or recommendation reliability must have zero
 * prediction-DQ weight. These modules can still surface warnings and be monitored for technical
 * issues -- only their reliability score is cut from the blend.
 *
 * Head-to-Head: most real matchups (especially first rounds and lower tiers) have no prior meeting
 * on record at all -- the NORMAL case, not a fixable data gap -- yet its reliability collapses
 * toward its floor exactly then. Even a low importance weight let this expected rarity visibly drag
 * down an otherwise well-supported score. Head-to-Head keeps voting in the ensemble
 * (`ENSEMBLE_WEIGHT_PRIOR.headToHead`) and stays fully visible in the UI.
 *
 * Fatigue: excluded from the ensemble vote entirely (see `EXCLUDED_FROM_ENSEMBLE`). Its reliability
 * is a fixed constant (70) -- not a real per-match signal of data richness -- so including it adds
 * a constant drag on every prediction regardless of the match. Its warnings (missing set-score
 * data) still feed `upsetRiskUncertaintyWarnings` in `index.ts` as before; that path is
 * independent of the reliability score and is unchanged by this exclusion.
 *
 * Availability: excluded from the ensemble vote (see `EXCLUDED_FROM_ENSEMBLE`). Its warnings
 * (venue-coverage gaps, travel distance) are deliberately excluded from `upsetRiskUncertaintyWarnings`
 * in `index.ts` (see the comment there). Its reliability genuinely tracks per-match data resolution,
 * but since neither its reliability nor its warnings reach any prediction-output path, including it
 * in DQ silently penalises predictions where venue data is unavailable even though that gap never
 * affects the probability, calibration, recommendation, or Elite tier.
 *
 * Match Load Recovery: excluded from the ensemble vote (see `EXCLUDED_FROM_ENSEMBLE`). Its
 * reliability is a fixed constant (70), same as Fatigue above. Its warnings do not feed into any
 * prediction-output path. Including it adds a constant drag identical in form to Fatigue's.
 */
// marketOdds: excluded from Data Quality because the absence of live odds for a matchup is not
// a data-richness gap -- the core prediction signals (match history, form, Elo) are independent
// of whether a bookmaker happens to have listed odds today. Including it would silently penalise
// every non-covered tournament even though the underlying prediction evidence is unchanged.
export const EXCLUDED_FROM_DATA_QUALITY = new Set(["headToHead", "fatigue", "availability", "matchLoadRecovery", "marketOdds"]);

/**
 * Fixed prior on how much each module's vote counts toward the ACTUAL blended probability
 * (`ensembleProbability` in `ensemble.ts`) -- distinct from `MODULE_IMPORTANCE` above, which only
 * feeds the Data Quality score. Before this existed, ensemble voting weight was driven purely by
 * each module's own `reliability`, so `MODULE_IMPORTANCE`'s "Surface Elo/Serve&Return/Recent Form
 * are the real signal" judgment never actually reached the prediction itself.
 *
 * Re-tuned from the 2026-07-13 ablation report's leave-one-out deltas: Surface Elo, Serve &
 * Return, and Recent Form are the only modules whose removal measurably hurt accuracy (they are
 * the real signal and are now the dominant vote); Fatigue and Head-to-Head were statistically
 * neutral (kept as legitimate minor tie-breakers, not zeroed, in case future data proves them
 * useful in specific segments); Availability is fully excluded from voting (see
 * `EXCLUDED_FROM_ENSEMBLE` below) because removing it measurably IMPROVED accuracy.
 */
export const ENSEMBLE_WEIGHT_PRIOR = {
  surfaceElo: 1.5,
  serveReturn: 1.5,
  recentForm: 1.3,
  fatigue: 0.4,
  headToHead: 0.4,
  /**
   * Applies only if/when `EXCLUDED_FROM_ENSEMBLE` below no longer contains "availability" --
   * see the 2026-07-13 walk-forward re-validation note in `EXCLUDED_FROM_ENSEMBLE`'s comment for
   * the current include/exclude decision and its measured accuracy delta.
   */
  availability: 0.4,
  /**
   * Task #93 starting prior, per `docs/audit-fatigue-redesign-investigation.md`'s proposed
   * constants -- below Head-to-Head's 0.4, since Match Load Recovery is the weakest newly-
   * introduced validated signal (2-6pp above coin-flip depending on surface in standalone
   * validation). See `docs/audit-matchloadrecovery-live-revalidation.md` for the live ablation
   * result that confirmed this module's ensemble inclusion.
   */
  matchLoadRecovery: 0.3,
} as const;

/**
 * Modules excluded from the ensemble VOTE entirely (but still fully computed and shown in
 * `EngineBreakdown` for transparency -- warnings/notes/raw numbers are never hidden).
 *
 * Availability was excluded per an earlier ablation report (its old, thin rest/travel/
 * mid-match-retirement-only signal measurably hurt accuracy). The module's inputs were then
 * reworked (finer travel-distance buckets, explicit rest-day thresholds, and a real confirmed-
 * withdrawal signal that now also checks pre-match walkovers, not just mid-match retirements) and
 * re-validated on 2026-07-13 via a live ablation replay over the full historical corpus (18281
 * matches): including the reworked module in the ensemble gave 57.3% overall accuracy vs 57.4%
 * with it excluded (leave-one-out delta +0.1pt for REMOVING it, i.e. -0.1pt for including it).
 * Not a net positive, so it remains excluded here -- see
 * `docs/audit-phase45-availability-revalidation.md` for the full numbers. Only a future run
 * clearing that bar should remove "availability" from this set.
 *
 * Fatigue was temporarily excluded on 2026-07-14 after fixing a backtest-only bug (Fatigue was
 * comparing dates against `Date.now()` instead of each row's real as-of date, so it silently
 * never fired during walk-forward scoring). Once fixed, Fatigue does fire, but a full walk-forward
 * re-run showed only 45.6-45.8% conditional accuracy (below a coin flip) while carrying ~16.5%
 * ensemble weight in the 48-59% calibration band. A follow-up investigation (2026-07-14, see
 * `docs/audit-fatigue-window-logic-investigation.md`) found the root cause: the module's 3/7/14-
 * day recency-weighted MATCH-COUNT windows aren't measuring physical tiredness at all -- across
 * 7,321 real decided matches, the MORE "fatigued" player actually won 54.9% of the time (not the
 * less-fatigued one), and that inversion strengthens with a wider score gap (up to 61.7% at the
 * widest gaps), which is the signature of a real confound, not noise. Cause: playing more matches
 * in a short window overwhelmingly means recently WINNING and advancing (tournament survivorship),
 * not accumulating fatigue -- confirmed by 61.5% directional agreement between "more fatigued" and
 * the separately-computed, win-rate-based Recent Form module. A naive sign-flip was rejected as a
 * fix: it would just re-emit Recent Form's own signal under Fatigue's name (the two already agree
 * 61.5% of the time), double-counting one real effect as two independent ensemble votes instead of
 * adding genuine incremental information. Excluded here PERMANENTLY pending a real redesign (e.g.
 * a quick-turnaround/back-to-back-match indicator decorrelated from win/loss outcome) that
 * measures tiredness instead of win momentum -- still fully computed and shown in
 * `EngineBreakdown` for transparency. Only a future rework that clears its own independent
 * walk-forward/ablation bar (the same bar Availability was held to above) should remove "fatigue"
 * from this set.
 */
// matchLoadRecovery (Task #93): computed and shown on every prediction (transparency), but held
// OUT of the live vote. Its live ablation re-validation was started via
// POST /api/evaluation/ablation/run (temporarily removing it from this set so the baseline could
// include it) but was stopped by explicit instruction before any variant finished -- see
// docs/audit-matchloadrecovery-live-revalidation.md for the exact stopped state, the observed
// per-variant pace, and the follow-up task to finish it. Per this task's own rule ("only keep it
// live if the ablation shows real accuracy benefit"), the default without a finished, positive
// result is EXCLUDED, matching how Availability was excluded pending its own proof.
// matchLoadRecovery stays excluded: a 4,001-match representative-sample leave-one-out ablation
// (2026-07-14) found removing it changes ~2.9% of individual predictions (83/2,820 scored matches
// flip) but moves OVERALL accuracy by exactly 0.0pp (57.3% both with and without it) -- the
// flips roughly cancel out. Per-surface/per-tour deltas look inconsistent in sign and sit on
// small subsamples (e.g. Grass n=35, Junior n=27), so they read as noise, not a real
// surface-specific edge. See docs/audit-matchloadrecovery-live-revalidation.md for the full
// breakdown; re-run the ablation if the historical corpus grows substantially and this decision
// should be revisited.
//
// marketOdds: excluded pending the live paper-trade Section B ablation reaching n≥200 processed
// rows. As of 2026-08-08 the corrected paired-arm ablation (both arms from stored
// preCalibrationProbability through the SAME active calibration → specialist → simulator pipeline,
// S cross-validated against stored weightUsed per row) ran at n=174 processed rows (184 eligible;
// 10 rejected by cross-validation where |Σ(p×w) − preCalP1| > 1.5pp) and shows Δacc=+3.45pp,
// Δlog-loss=−0.0519 — both thresholds met, but n<200. Will be removed from this set once n≥200
// rows pass cross-validation AND the re-run confirms Δacc≥+0.5pp AND Δlog-loss≤−0.010.
// See docs/audit-market-consensus-ablation.md and scripts/auditMarketConsensusAblation.ts.
export const EXCLUDED_FROM_ENSEMBLE = new Set(["availability", "fatigue", "matchLoadRecovery", "marketOdds"]);

/**
 * Per-model confidence shrink (see `EnsembleModuleInput.confidenceShrink`), derived directly from
 * the 2026-07-13 ablation report's confidence-miscalibration numbers: Serve & Return's stated
 * confidence overstated its real observed hit rate by ~9.5pts (66.8% stated vs 57.3% observed --
 * deviation-from-50 ratio 7.3/16.8 ~= 0.43), Recent Form by ~8.8pts (63.2% vs 54.4% -- ratio
 * 4.4/13.2 ~= 0.33). Rounded to 0.45 / 0.35. This shrinks each module's OWN vote toward its real
 * hit rate without reducing its ensemble voting weight (see `ENSEMBLE_WEIGHT_PRIOR`) -- being a
 * "primary" signal and being "recalibrated" are independent fixes.
 */
export const CONFIDENCE_SHRINK = {
  serveReturn: 0.45,
  recentForm: 0.35,
} as const;

/**
 * Additional post-calibration shrink toward 50%, applied in `predictionEngine/index.ts` ONLY when
 * no segment specialist actually voted for this match (a segment that clears its own threshold
 * already gets a real, data-fit correction instead of this coarse fallback -- see
 * `specialistWeights.ts`).
 *
 * Task #151: the 2026-07-13 full-corpus ablation report found ATP-tour predictions genuinely
 * underperform (54.6% baseline accuracy, n=1,242) against both the pooled average (57.3%) and
 * ITF's own baseline (58.9%), with no ATP surface segment currently clearing the segment-
 * specialist volume threshold to correct for it directly. Sized the same way `CONFIDENCE_SHRINK`
 * above was: (observedAccuracy - 50) / (poolAccuracy - 50) = 4.6 / 7.3 ~= 0.63. Keyed by tour
 * (parsed from `segment.segmentKey`, e.g. "ATP-Hard") rather than a one-off boolean so a future
 * tour showing the same pattern can be added here without new plumbing.
 *
 * Task #158: re-checked whether WTA (the only other real candidate tour -- see `CANDIDATE_TOURS`
 * in `segments.ts`) belongs here too. The SAME 2026-07-13 report already shows a WTA baseline of
 * 55.2% (n=1,155) against the same 57.3% pool -- a real but visibly smaller gap than ATP's
 * ((55.2-50)/(57.3-50) ~= 0.71 vs. ATP's 0.63), and, unlike ATP, WTA is one of only two tours
 * `specialistWeights.ts` ever fits a segment specialist for at all, so part of that pooled 55.2%
 * may already be corrected by a specialist on some WTA surfaces (this discount only fires when
 * `!specialistApplied`) -- the pooled tour-level number isn't a clean read of the uncorrected
 * subset the way ATP's is. No newer ablation run or accumulated `specialist_models`/
 * `evaluation_predictions` data has superseded that 2026-07-13 report as of 2026-07-14 (checked:
 * `specialist_models` has no rows in the current environment). Left out for now -- add a `WTA`
 * (or other tour) entry here, sized by the exact same formula, only once a report specifically
 * measures that tour's accuracy gap on the matches where NO specialist actually voted (not the
 * tour's pooled accuracy across corrected and uncorrected matches together), and cite that
 * report/data inline the way this ATP entry does.
 *
 * Task #33: this discount is skipped in `predictionEngine/index.ts` when a real pooled isotonic
 * calibration model is active. The calibration is fitted on raw_probability → actual_outcome
 * across the full corpus and already bakes in per-tour accuracy differences through its knots;
 * applying this discount on top double-corrects and causes systematic underconfidence (~17 pts in
 * the 60-70% tier per paper-trade data, n=520 graded). This entry is preserved for the
 * calibration-fallback path (no fitted model yet) and for future reference.
 */
export const TOUR_RELIABILITY_DISCOUNT: Partial<Record<string, number>> = {
  ATP: 0.63,
};

/**
 * Additional post-calibration shrink toward 50%, applied in `predictionEngine/index.ts` ONLY when
 * no segment specialist actually voted (see `TOUR_RELIABILITY_DISCOUNT` above for why) AND this
 * match's surface sample depth is "Low" (`computeSurfaceSampleDepth`, below
 * `SURFACE_SAMPLE_LOW_THRESHOLD` prior matches for the thinner-sampled player).
 *
 * Task #151: the same 2026-07-13 ablation report found Surface Elo, Fatigue, and Availability
 * each show their single largest per-surface leave-one-out swing on Grass (-1.3, -1.9, -1.9pts
 * respectively, n=162) -- the thinnest-volume surface in the whole corpus. That is the signature
 * of those modules' own reliability estimates being noisiest exactly where real per-surface
 * sample size is thinnest, not a Grass-specific effect as such -- so this discount is keyed to the
 * general, already-computed sample-depth signal (not hardcoded to "Grass"), and also protects e.g.
 * a clay specialist's grass tournament debut. 0.75 is a deliberately modest shrink (smaller than
 * the ATP discount above): unlike the ATP finding, this isn't a validated accuracy gap on its own
 * baseline, just added noise-sensitivity on top of already-thin data that
 * `calibrateProbability`'s Data Quality curve only partly captures.
 *
 * Task #157 re-check (2026-07-15, `docs/audit-task157-confidence-discount-revalidation.md`): a
 * fresh ablation replay shows the ATP gap this file's discounts target still persists at a
 * similar relative size (ratio 0.69 vs. the 0.63 `TOUR_RELIABILITY_DISCOUNT.ATP` was sized from),
 * and the Grass leave-one-out volatility this constant targets looked improved (deltas moved to
 * 0 from -1.3/-1.9/-1.9) -- but both readings came from samples far thinner (n=231, n=119) than
 * the ones the constants were originally sized from (n=1,242, n=162), so neither constant was
 * re-tuned off this evidence alone.
 */
export const LOW_SURFACE_SAMPLE_DISCOUNT = 0.75;

export type SurfaceSampleLabel = "Low" | "Moderate" | "High";

/** A player's surface sample is "Low" below this many prior matches on the relevant surface -- matches `surfaceElo.ts`'s own low-confidence warning threshold, so the two signals never disagree about what counts as thin. */
const SURFACE_SAMPLE_LOW_THRESHOLD = 5;
/** At or above this many prior matches on the relevant surface, sample depth is "High" rather than merely "Moderate". */
const SURFACE_SAMPLE_HIGH_THRESHOLD = 15;

export interface SurfaceSampleDepth {
  player1Sample: number;
  player2Sample: number;
  /** The weaker (smaller) of the two players' sample counts -- a matchup is only as well-supported as its thinner side. */
  minSample: number;
  label: SurfaceSampleLabel;
}

/**
 * Surfaces, explicitly and per-matchup, how many prior matches each player has on the relevant
 * surface (within whatever match-history window the caller already resolved -- the same window
 * `computeSurfaceEloModule` used to build its own rating) -- so a low-sample surface prediction
 * is visibly flagged instead of being silently blended into a single probability number, right
 * alongside the Data Quality tier it already sits near in the UI.
 */
export function computeSurfaceSampleDepth(sampleSizePlayer1: number, sampleSizePlayer2: number): SurfaceSampleDepth {
  const minSample = Math.min(sampleSizePlayer1, sampleSizePlayer2);
  const label: SurfaceSampleLabel = minSample < SURFACE_SAMPLE_LOW_THRESHOLD ? "Low" : minSample < SURFACE_SAMPLE_HIGH_THRESHOLD ? "Moderate" : "High";
  return { player1Sample: sampleSizePlayer1, player2Sample: sampleSizePlayer2, minSample, label };
}

export interface DataQualityModuleInput {
  reliability: number;
  /** One of the `MODULE_IMPORTANCE` weights above -- how much this module should count toward the blended score. */
  importance: number;
}

export interface MatchupDifficultySignal {
  /** Preferred source: absolute ATP/WTA rank gap when both ranks are known and positive. */
  rankGap: number | null;
  /** Fallback source: absolute Surface Elo-derived probability margin from 50 (0-50 points). */
  eloGapProbabilityPoints: number | null;
  /** 0-100 scale where higher means this matchup is structurally less competitive/easier to call. */
  decisivenessScore: number;
  source: "rank-gap" | "elo-gap-fallback";
}

const RANK_GAP_DECISIVENESS_CAP = 120;
const DQ_MATCHUP_DIFFICULTY_MAX_ADJUSTMENT = 8;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rankGapToDecisivenessScore(rankGap: number): number {
  // Saturating curve: early rank-gap gains move decisiveness most; large gaps flatten.
  const normalized = clamp01(1 - Math.exp(-Math.max(0, rankGap) / RANK_GAP_DECISIVENESS_CAP));
  return Math.round(normalized * 1000) / 10;
}

function eloGapToDecisivenessScore(eloGapProbabilityPoints: number): number {
  // 0-50 probability-point margin maps to 0-100 decisiveness.
  const normalized = clamp01(Math.max(0, eloGapProbabilityPoints) / 50);
  return Math.round(normalized * 1000) / 10;
}

/**
 * Measures how structurally COMPETITIVE this specific matchup is, independent of data richness.
 *
 * Preferred source is absolute rank gap (real ATP/WTA ranking parity). When rank is unknown for
 * either player, falls back to absolute Surface Elo probability margin so the signal still
 * resolves for lower-tier players that often lack live rankings.
 */
export function computeMatchupDifficultySignal(input: {
  player1Rank: number | null;
  player2Rank: number | null;
  surfaceEloEdge: number;
}): MatchupDifficultySignal {
  const hasRanks =
    typeof input.player1Rank === "number" &&
    Number.isFinite(input.player1Rank) &&
    input.player1Rank > 0 &&
    typeof input.player2Rank === "number" &&
    Number.isFinite(input.player2Rank) &&
    input.player2Rank > 0;

  if (hasRanks) {
    const rankGap = Math.abs((input.player1Rank as number) - (input.player2Rank as number));
    return {
      rankGap,
      eloGapProbabilityPoints: null,
      decisivenessScore: rankGapToDecisivenessScore(rankGap),
      source: "rank-gap",
    };
  }

  const eloGapProbabilityPoints = Math.abs((1 / (1 + Math.exp(-Math.max(-50, Math.min(50, input.surfaceEloEdge)) / 12))) * 100 - 50);
  return {
    rankGap: null,
    eloGapProbabilityPoints: Math.round(eloGapProbabilityPoints * 10) / 10,
    decisivenessScore: eloGapToDecisivenessScore(eloGapProbabilityPoints),
    source: "elo-gap-fallback",
  };
}

/**
 * Additive Data Quality adjustment from matchup difficulty: close/parity matchups reduce trust,
 * lopsided matchups increase it, while preserving sample-richness reliability as the base score.
 */
export function adjustDataQualityForMatchupDifficulty(baseDataQuality: number, signal: MatchupDifficultySignal): number {
  const sourceWeight = signal.source === "rank-gap" ? 1 : 0.7;
  const centered = (signal.decisivenessScore - 50) / 50; // -1..+1 centered around neutral parity
  const delta = centered * DQ_MATCHUP_DIFFICULTY_MAX_ADJUSTMENT * sourceWeight;
  return Math.max(0, Math.min(100, Math.round(baseDataQuality + delta)));
}

export function dataQualityLabelForScore(score: number): DataQualityLabel {
  return score >= 85 ? "Excellent" : score >= 65 ? "Strong" : score >= 45 ? "Acceptable" : score >= 25 ? "Limited" : "Poor";
}

/**
 * Blends per-module reliabilities into one overall Data Quality score, weighted by each module's
 * fixed importance prior (see `MODULE_IMPORTANCE`) rather than a flat average. A flat average
 * would let a structurally rare-but-real gap (no prior head-to-head meetings, unresolved travel
 * distance) cap the score just as hard as a genuinely thin core signal -- this blend instead lets
 * the modules that actually drive the prediction (and whose reliability genuinely tracks real
 * data richness) carry most of the weight, while low-importance modules can still nudge the score
 * up when their data happens to be strong.
 */
export function computeDataQuality(modules: DataQualityModuleInput[]): { score: number; label: DataQualityLabel } {
  const weightTotal = modules.reduce((sum, m) => sum + m.importance, 0);
  const weightedSum = modules.reduce((sum, m) => sum + m.reliability * m.importance, 0);
  const score = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;
  const label = dataQualityLabelForScore(score);
  return { score, label };
}
