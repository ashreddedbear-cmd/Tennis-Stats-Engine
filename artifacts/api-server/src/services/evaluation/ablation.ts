import { asc, eq } from "drizzle-orm";
import { db, historicalMatchesTable, calibrationModelsTable, specialistModelsTable, type HistoricalMatchRow } from "@workspace/db";
import { logger } from "../../lib/logger";
import { runPredictionEngine, type EngineOutput } from "../predictionEngine";
import type { AblationModelKey, SegmentSpecialistInput } from "../predictionEngine/types";
import { resolveOpponentStrengthFromIndex, buildEloHistoryIndex, type EloHistoryIndex } from "../predictionEngine/opponentStrength";
import { reconstructHeadToHead, reconstructPlayerMatchHistory, buildMatchHistoryIndex, type MatchHistoryIndex } from "../historicalData/matchRecordReconstruction";
import { resolveSegment } from "../predictionEngine/segments";
import type { MatchFormat, PlayerProfile, Surface } from "../tennisData/types";
import type { CalibrationKnot } from "./types";

/**
 * One-time model ablation analysis (see the task spec). This intentionally never writes to
 * `evaluation_predictions`/`evaluation_runs` -- those tables are the walk-forward
 * fit/out-of-sample-test ledger, and this is a diagnostic replay against the SAME frozen
 * historical corpus, not another evaluation run. Everything here is computed in memory and
 * either returned over HTTP or written to a standalone report file.
 */

// NOTE: "marketOdds" is intentionally absent from MODEL_DEFS even though it is a valid
// AblationModelKey. This runner works exclusively on the historical corpus and never passes
// `input.marketOdds` to scoreMatch() — the Market Consensus module only fires when
// `input.marketOdds != null`, so an "ablate_marketOdds" leave-one-out variant would be
// identically equal to baseline (the module was never active in either case). Running it here
// would produce a meaningless delta of exactly 0.0pp.
//
// The correct ablation for market odds requires paper_trade graded rows that had real odds
// locked at cutoff time. See:
//   - scripts/auditMarketConsensusAblation.ts — the dedicated ablation runner
//   - docs/audit-market-consensus-ablation.md — the 2026-07-31 results (n=180, EXCLUDE pending ≥200)
export const MODEL_DEFS: ReadonlyArray<{ key: AblationModelKey; label: string }> = [
  { key: "surfaceElo", label: "Surface Elo" },
  { key: "serveReturn", label: "Serve & Return" },
  { key: "recentForm", label: "Recent Form" },
  { key: "fatigue", label: "Fatigue" },
  { key: "availability", label: "Availability (rest/travel/injury)" },
  { key: "headToHead", label: "Head-to-Head" },
  { key: "matchLoadRecovery", label: "Match Load Recovery" },
  { key: "generalEnsemble", label: "General Ensemble" },
  { key: "segmentSpecialist", label: "Active Segment Specialist" },
];

interface Variant {
  key: string;
  label: string;
  excluded: ReadonlySet<AblationModelKey>;
  /** Which MODEL_DEFS key this variant corresponds to for the leave-one-out delta table, or null for the extra multi-model combinations. */
  loo: AblationModelKey | null;
}

const BASELINE_VARIANT: Variant = { key: "baseline", label: "Everything active (baseline)", excluded: new Set(), loo: null };

const LEAVE_ONE_OUT_VARIANTS: Variant[] = MODEL_DEFS.map((m) => ({
  key: `ablate_${m.key}`,
  label: `${m.label} removed`,
  excluded: new Set([m.key]),
  loo: m.key,
}));

const COMBO_VARIANTS: Variant[] = [
  { key: "combo_everything", label: "Everything active", excluded: new Set(), loo: null },
  {
    key: "combo_core_signals_only",
    label: "Core signals only (Surface Elo, Serve & Return, Recent Form)",
    excluded: new Set(["fatigue", "availability", "headToHead"]),
    loo: null,
  },
  { key: "combo_specialists_off", label: "Segment specialists off", excluded: new Set(["segmentSpecialist"]), loo: null },
  {
    key: "combo_no_calibration_no_specialist",
    label: "General calibration + specialists off (raw ensemble only)",
    excluded: new Set(["generalEnsemble", "segmentSpecialist"]),
    loo: null,
  },
];

function minimalProfile(id: string, name: string): PlayerProfile {
  return { id, name, countryCode: null, currentRank: null, tour: null, age: null, plays: null, fullName: null };
}

export interface SampleInfo {
  /** The target sample size that was requested, or null when this run scored the full eligible corpus. */
  requestedSampleSize: number | null;
  /** The eligible corpus size the sample was drawn from (before sampling). */
  totalEligible: number;
  /** How many matches were actually scored (equals totalEligible when requestedSampleSize is null). */
  scoredCount: number;
  /** Per-(surface, year) stratum: how many matches existed in the full corpus vs. how many were drawn into the sample. Empty when unsampled. */
  strata: Array<{ surface: string; year: number; corpusCount: number; sampleCount: number }>;
}

/**
 * Draws a proportional stratified sample from `eligible`, grouped by (surface, calendar year of
 * `scheduledStartAt`) so a sampled run stays representative of the full corpus's surface mix and
 * time span -- unlike a recent-date slice, which would both under-represent older data and be too
 * small on its own. Sampling only shrinks the list of matches that get SCORED; callers must still
 * build match-history/Elo context from the FULL corpus so a sampled match's reconstructed history
 * remains accurate (an older or thinner-surface match must not lose real prior-match context just
 * because it was chosen for the sample).
 *
 * Selection within each stratum takes an evenly-spaced subsequence (not `Math.random()`) so the
 * chosen sample is deterministic and reproducible across repeated runs of the same target size.
 */
export function buildRepresentativeSample(eligible: HistoricalMatchRow[], targetSize: number): { sample: HistoricalMatchRow[]; info: SampleInfo } {
  if (targetSize >= eligible.length) {
    return { sample: eligible, info: { requestedSampleSize: targetSize, totalEligible: eligible.length, scoredCount: eligible.length, strata: [] } };
  }

  const strataMap = new Map<string, HistoricalMatchRow[]>();
  for (const match of eligible) {
    const surface = match.surface ?? "Unknown";
    const year = match.scheduledStartAt.getUTCFullYear();
    const key = `${surface}::${year}`;
    if (!strataMap.has(key)) strataMap.set(key, []);
    strataMap.get(key)!.push(match);
  }

  const strata: SampleInfo["strata"] = [];
  const sample: HistoricalMatchRow[] = [];
  let allocated = 0;
  const keys = [...strataMap.keys()];

  for (const key of keys) {
    const [surface, yearStr] = key.split("::");
    const group = strataMap.get(key)!;
    // Proportional share of the target, rounded, but never zero for a non-empty stratum and never
    // more than the stratum itself has -- every surface/year present in the corpus stays represented.
    const share = Math.min(group.length, Math.max(1, Math.round((group.length / eligible.length) * targetSize)));
    // Evenly-spaced deterministic subsequence, not the group's natural (chronological) order, so a
    // stratum's own sample still spans its full sub-range rather than clustering at one end.
    const picked: HistoricalMatchRow[] = [];
    if (share >= group.length) {
      picked.push(...group);
    } else {
      const step = group.length / share;
      for (let i = 0; i < share; i++) {
        picked.push(group[Math.floor(i * step)]);
      }
    }
    sample.push(...picked);
    allocated += picked.length;
    strata.push({ surface, year: Number(yearStr), corpusCount: group.length, sampleCount: picked.length });
  }

  // Keep the sample in the same chronological order as the source corpus -- scoring order doesn't
  // affect correctness, but it keeps progress/logging behavior consistent with the unsampled path.
  sample.sort((a, b) => a.scheduledStartAt.getTime() - b.scheduledStartAt.getTime());

  return {
    sample,
    info: { requestedSampleSize: targetSize, totalEligible: eligible.length, scoredCount: allocated, strata: strata.sort((a, b) => a.surface.localeCompare(b.surface) || a.year - b.year) },
  };
}

interface AblationContext {
  matchHistory: MatchHistoryIndex;
  eloHistory: EloHistoryIndex;
  activeCalibration: CalibrationKnot[] | null;
  segmentBySegmentKey: Map<string, SegmentSpecialistInput>;
}

async function buildContext(allMatches: HistoricalMatchRow[]): Promise<AblationContext> {
  const [activeCalibrationRow] = await db.select().from(calibrationModelsTable).where(eq(calibrationModelsTable.active, true)).limit(1);
  const specialistRows = await db.select().from(specialistModelsTable);

  const segmentBySegmentKey = new Map<string, SegmentSpecialistInput>();
  for (const row of specialistRows) {
    segmentBySegmentKey.set(row.segmentKey, {
      segmentKey: row.segmentKey,
      label: row.label,
      meetsThreshold: row.meetsThreshold,
      historicalMatchCount: row.historicalMatchCount,
      validationSampleSize: row.validationSampleSize,
      minHistoricalMatches: 0,
      minValidationSamples: 0,
      calibrationMapping: row.meetsThreshold ? (row.calibrationMapping as CalibrationKnot[]) : undefined,
      weight: row.meetsThreshold ? row.weight : undefined,
    });
  }

  return {
    matchHistory: buildMatchHistoryIndex(allMatches),
    eloHistory: await buildEloHistoryIndex(),
    activeCalibration: activeCalibrationRow ? (activeCalibrationRow.mapping as CalibrationKnot[]) : null,
    segmentBySegmentKey,
  };
}

function scoreMatch(match: HistoricalMatchRow, excluded: ReadonlySet<AblationModelKey>, ctx: AblationContext): EngineOutput | null {
  if (!match.surface || !match.matchFormat || !match.winnerId) return null;
  const surface = match.surface as Surface;
  const matchFormat = match.matchFormat as MatchFormat;

  const player1Matches = reconstructPlayerMatchHistory(ctx.matchHistory, match.player1Id, match.cutoffAt);
  const player2Matches = reconstructPlayerMatchHistory(ctx.matchHistory, match.player2Id, match.cutoffAt);
  if (player1Matches.length === 0 || player2Matches.length === 0) return null;

  const player1OpponentStrength = resolveOpponentStrengthFromIndex(player1Matches, ctx.eloHistory);
  const player2OpponentStrength = resolveOpponentStrengthFromIndex(player2Matches, ctx.eloHistory);
  const headToHead = reconstructHeadToHead(ctx.matchHistory, match.player1Id, match.player2Id, match.cutoffAt);

  const segmentDef = resolveSegment(match.tour, surface);
  const segment = segmentDef ? ctx.segmentBySegmentKey.get(segmentDef.segmentKey) ?? null : null;

  return runPredictionEngine({
    player1: minimalProfile(match.player1Id, match.player1Name),
    player2: minimalProfile(match.player2Id, match.player2Name),
    player1Matches,
    player2Matches,
    headToHead,
    surface,
    matchFormat,
    player1OpponentElo: player1OpponentStrength.lookup,
    player2OpponentElo: player2OpponentStrength.lookup,
    tournamentName: match.tournamentName,
    weather: null,
    segment,
    simulatorAdoption: null,
    activeCalibration: ctx.activeCalibration,
    excludedModels: excluded,
  });
}

interface BaselineRecord {
  matchId: number;
  tour: string | null;
  surface: string;
  tournamentLevel: string | null;
  dataQuality: number;
  predictedWinnerId: string;
  actualWinnerId: string;
  correct: boolean;
}

interface Bucket {
  n: number;
  correct: number;
}

function emptyBucket(): Bucket {
  return { n: 0, correct: 0 };
}
function bump(bucket: Bucket, correct: boolean) {
  bucket.n += 1;
  if (correct) bucket.correct += 1;
}
function accuracyOf(bucket: Bucket): number | null {
  return bucket.n > 0 ? Math.round((bucket.correct / bucket.n) * 1000) / 10 : null;
}

export interface SegmentAccuracy {
  n: number;
  accuracy: number | null;
}
function toSegmentAccuracy(b: Bucket): SegmentAccuracy {
  return { n: b.n, accuracy: accuracyOf(b) };
}

const DQ_HIGH_THRESHOLD = 65; // matches the engine's own "Strong" data-quality label floor

async function yieldToEventLoop() {
  await new Promise((resolve) => setImmediate(resolve));
}

export interface AblationProgress {
  phase: "loading" | "baseline" | "variants" | "diagnostics" | "done";
  variantIndex: number;
  variantCount: number;
  matchIndex: number;
  matchCount: number;
}

export interface VariantResult {
  key: string;
  label: string;
  overall: SegmentAccuracy;
  byTour: Record<string, SegmentAccuracy>;
  bySurface: Record<string, SegmentAccuracy>;
  byDataQuality: { high: SegmentAccuracy; low: SegmentAccuracy };
  byFavorite: { agreesWithBaseline: SegmentAccuracy; divergesFromBaseline: SegmentAccuracy };
}

export interface ModelDelta {
  modelKey: AblationModelKey;
  modelLabel: string;
  baselineAccuracy: number | null;
  ablatedAccuracy: number | null;
  deltaPoints: number | null; // ablated - baseline, in accuracy percentage points. Negative = removing this model HURT accuracy (it was earning its place).
  recommendation: "Keep" | "Review" | "Candidate for lower weight";
  rank: "Most Valuable" | "Valuable" | "Neutral" | "Weak" | "Harmful";
  segments: {
    byFavoriteVsUnderdog: { agreesWithBaseline: { baseline: SegmentAccuracy; ablated: SegmentAccuracy }; divergesFromBaseline: { baseline: SegmentAccuracy; ablated: SegmentAccuracy } };
    byTour: Record<string, { baseline: SegmentAccuracy; ablated: SegmentAccuracy; deltaPoints: number | null }>;
    bySurface: Record<string, { baseline: SegmentAccuracy; ablated: SegmentAccuracy; deltaPoints: number | null }>;
    byDataQuality: { high: { baseline: SegmentAccuracy; ablated: SegmentAccuracy; deltaPoints: number | null }; low: { baseline: SegmentAccuracy; ablated: SegmentAccuracy; deltaPoints: number | null } };
  };
}

function rankAndRecommend(deltaPoints: number | null): { rank: ModelDelta["rank"]; recommendation: ModelDelta["recommendation"] } {
  if (deltaPoints === null) return { rank: "Neutral", recommendation: "Review" };
  if (deltaPoints <= -3) return { rank: "Most Valuable", recommendation: "Keep" };
  if (deltaPoints <= -1) return { rank: "Valuable", recommendation: "Keep" };
  if (deltaPoints < 1) return { rank: "Neutral", recommendation: "Review" };
  if (deltaPoints < 3) return { rank: "Weak", recommendation: "Candidate for lower weight" };
  return { rank: "Harmful", recommendation: "Candidate for lower weight" };
}

export interface DiagnosticRow {
  modelKey: AblationModelKey;
  modelLabel: string;
  n: number;
  rate: number | null; // 0-100
}

export interface ConfidenceMiscalibrationRow {
  modelKey: AblationModelKey;
  modelLabel: string;
  n: number;
  avgPredictedConfidence: number | null; // 0-100
  observedHitRate: number | null; // 0-100
  overconfidencePoints: number | null; // avgPredictedConfidence - observedHitRate; positive = overconfident
}

export interface AblationDiagnostics {
  /** Q1: which model's own vote most often matched the final prediction on matches the engine actually lost. */
  losingPredictionAttribution: DiagnosticRow[];
  /** Q2: among each model's "strong" votes (>=65% confidence toward one player), how often the strongly-favored player actually lost. */
  overconfidentStrongVoteFailureRate: DiagnosticRow[];
  /** Q3: each model's average stated confidence vs. its real observed hit rate -- positive overconfidencePoints means the model's vote strength systematically overstates its real accuracy. */
  confidenceMiscalibration: ConfidenceMiscalibrationRow[];
  /** Q4: how often each model's own vote disagreed with the engine's final pick, and how often that dissent would have been the correct call. */
  dissentFromFinalPrediction: Array<DiagnosticRow & { correctDissentRate: number | null }>;
}

export interface AblationReport {
  generatedAt: string;
  matchCount: number;
  caveats: string[];
  baseline: VariantResult;
  modelDeltas: ModelDelta[];
  combinations: VariantResult[];
  diagnostics: AblationDiagnostics;
  /** Present (non-null) whenever this run scored a stratified sample instead of the full eligible corpus -- see `buildRepresentativeSample`. */
  sampleInfo: SampleInfo | null;
}

/** Maps a baseline `EngineBreakdown.models[].modelName` back to one of the 8 ablatable categories. */
function categorizeModelName(modelName: string): AblationModelKey | null {
  if (modelName === "Surface Elo") return "surfaceElo";
  if (modelName === "Serve & Return") return "serveReturn";
  if (modelName === "Recent Form") return "recentForm";
  if (modelName === "Fatigue") return "fatigue";
  if (modelName.startsWith("Availability")) return "availability";
  if (modelName === "Head-to-Head") return "headToHead";
  if (modelName === "Match Load Recovery") return "matchLoadRecovery";
  if (modelName === "General Model") return "generalEnsemble";
  if (modelName.startsWith("Segment Specialist")) return "segmentSpecialist";
  return null;
}

export interface RunAblationOptions {
  /**
   * When set, scores a proportional stratified sample of roughly this many matches (see
   * `buildRepresentativeSample`) instead of the full eligible corpus -- sized to complete in one
   * sitting. The match-history/Elo context is always built from the FULL corpus regardless of this
   * option, so a sampled match's reconstructed history stays accurate.
   */
  sampleSize?: number;
}

export async function runAblationAnalysis(onProgress?: (p: AblationProgress) => void, options: RunAblationOptions = {}): Promise<AblationReport> {
  onProgress?.({ phase: "loading", variantIndex: 0, variantCount: 0, matchIndex: 0, matchCount: 0 });

  const allMatches = await db.select().from(historicalMatchesTable).orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));
  const eligibleFull = allMatches.filter((m) => !m.cancelled && m.winnerId);
  const ctx = await buildContext(allMatches);

  const sampled = options.sampleSize != null ? buildRepresentativeSample(eligibleFull, options.sampleSize) : null;
  const sampleInfo: SampleInfo | null = sampled?.info ?? null;
  const eligible = sampled?.sample ?? eligibleFull;

  const variants = [BASELINE_VARIANT, ...LEAVE_ONE_OUT_VARIANTS, ...COMBO_VARIANTS];

  const baselineRecords: BaselineRecord[] = [];
  const diagBuckets = new Map<
    AblationModelKey,
    {
      losingAttributionHit: number;
      losingAttributionTotal: number;
      strongVoteWrong: number;
      strongVoteTotal: number;
      confBuckets: Map<string, { n: number; sumConfidence: number; hits: number }>;
      dissentTotal: number;
      dissentCorrect: number;
    }
  >();
  for (const def of MODEL_DEFS) {
    diagBuckets.set(def.key, {
      losingAttributionHit: 0,
      losingAttributionTotal: 0,
      strongVoteWrong: 0,
      strongVoteTotal: 0,
      confBuckets: new Map(),
      dissentTotal: 0,
      dissentCorrect: 0,
    });
  }

  // --- Baseline pass: also gathers per-match model votes for the diagnostic questions. ---
  const overallBaseline = emptyBucket();
  const byTourBaseline = new Map<string, Bucket>();
  const bySurfaceBaseline = new Map<string, Bucket>();
  const byDQBaseline = { high: emptyBucket(), low: emptyBucket() };

  for (let i = 0; i < eligible.length; i++) {
    if (i % 500 === 0) {
      onProgress?.({ phase: "baseline", variantIndex: 0, variantCount: variants.length, matchIndex: i, matchCount: eligible.length });
      await yieldToEventLoop();
    }
    const match = eligible[i];
    const output = scoreMatch(match, BASELINE_VARIANT.excluded, ctx);
    if (!output) continue;

    const correct = output.predictedWinnerId === match.winnerId;
    baselineRecords.push({
      matchId: match.id,
      tour: match.tour,
      surface: match.surface as string,
      tournamentLevel: match.tournamentLevel,
      dataQuality: output.dataQuality,
      predictedWinnerId: output.predictedWinnerId,
      actualWinnerId: match.winnerId as string,
      correct,
    });

    bump(overallBaseline, correct);
    const tourKey = match.tour ?? "Unknown";
    if (!byTourBaseline.has(tourKey)) byTourBaseline.set(tourKey, emptyBucket());
    bump(byTourBaseline.get(tourKey)!, correct);
    const surfaceKey = (match.surface as string) ?? "Unknown";
    if (!bySurfaceBaseline.has(surfaceKey)) bySurfaceBaseline.set(surfaceKey, emptyBucket());
    bump(bySurfaceBaseline.get(surfaceKey)!, correct);
    bump(output.dataQuality >= DQ_HIGH_THRESHOLD ? byDQBaseline.high : byDQBaseline.low, correct);

    // Diagnostics, computed once from this same baseline pass.
    for (const vote of output.engine.models) {
      const category = categorizeModelName(vote.modelName);
      if (!category) continue;
      const bucket = diagBuckets.get(category)!;
      const modelFavoredId = vote.player1Probability >= 50 ? match.player1Id : match.player2Id;
      const confidence = Math.max(vote.player1Probability, 100 - vote.player1Probability);

      // Q1: losing-prediction attribution.
      if (!correct) {
        bucket.losingAttributionTotal += 1;
        if (modelFavoredId === output.predictedWinnerId) bucket.losingAttributionHit += 1;
      }

      // Q2: strong-vote (>=65%) failure rate.
      if (confidence >= 65) {
        bucket.strongVoteTotal += 1;
        if (modelFavoredId !== match.winnerId) bucket.strongVoteWrong += 1;
      }

      // Q3: confidence calibration bucket (50-60/60-70/70-80/80-100).
      const bucketLabel = confidence >= 80 ? "80-100" : confidence >= 70 ? "70-80" : confidence >= 60 ? "60-70" : "50-60";
      if (!bucket.confBuckets.has(bucketLabel)) bucket.confBuckets.set(bucketLabel, { n: 0, sumConfidence: 0, hits: 0 });
      const cb = bucket.confBuckets.get(bucketLabel)!;
      cb.n += 1;
      cb.sumConfidence += confidence;
      if (modelFavoredId === match.winnerId) cb.hits += 1;

      // Q4: dissent from the final blended pick, and whether that dissent would have been correct.
      if (modelFavoredId !== output.predictedWinnerId) {
        bucket.dissentTotal += 1;
        if (modelFavoredId === match.winnerId) bucket.dissentCorrect += 1;
      }
    }
  }

  const baselineResult: VariantResult = {
    key: BASELINE_VARIANT.key,
    label: BASELINE_VARIANT.label,
    overall: toSegmentAccuracy(overallBaseline),
    byTour: Object.fromEntries([...byTourBaseline.entries()].map(([k, v]) => [k, toSegmentAccuracy(v)])),
    bySurface: Object.fromEntries([...bySurfaceBaseline.entries()].map(([k, v]) => [k, toSegmentAccuracy(v)])),
    byDataQuality: { high: toSegmentAccuracy(byDQBaseline.high), low: toSegmentAccuracy(byDQBaseline.low) },
    byFavorite: { agreesWithBaseline: toSegmentAccuracy(overallBaseline), divergesFromBaseline: { n: 0, accuracy: null } },
  };

  const baselineByMatchId = new Map(baselineRecords.map((r) => [r.matchId, r]));

  // --- Variant passes (leave-one-out + combinations), scored against the SAME eligible list, segmented using the baseline's own labels. ---
  async function runVariant(variant: Variant, variantIndex: number): Promise<VariantResult> {
    if (variant.key === BASELINE_VARIANT.key || variant.key === "combo_everything") return { ...baselineResult, key: variant.key, label: variant.label };

    const overall = emptyBucket();
    const byTour = new Map<string, Bucket>();
    const bySurface = new Map<string, Bucket>();
    const byDQ = { high: emptyBucket(), low: emptyBucket() };
    const byFavorite = { agrees: emptyBucket(), diverges: emptyBucket() };

    for (let i = 0; i < eligible.length; i++) {
      if (i % 1000 === 0) {
        onProgress?.({ phase: "variants", variantIndex, variantCount: variants.length, matchIndex: i, matchCount: eligible.length });
        await yieldToEventLoop();
      }
      const match = eligible[i];
      const baselineRecord = baselineByMatchId.get(match.id);
      if (!baselineRecord) continue;

      const output = scoreMatch(match, variant.excluded, ctx);
      if (!output) continue;

      const correct = output.predictedWinnerId === match.winnerId;
      bump(overall, correct);
      const tourKey = match.tour ?? "Unknown";
      if (!byTour.has(tourKey)) byTour.set(tourKey, emptyBucket());
      bump(byTour.get(tourKey)!, correct);
      const surfaceKey = (match.surface as string) ?? "Unknown";
      if (!bySurface.has(surfaceKey)) bySurface.set(surfaceKey, emptyBucket());
      bump(bySurface.get(surfaceKey)!, correct);
      bump(output.dataQuality >= DQ_HIGH_THRESHOLD ? byDQ.high : byDQ.low, correct);
      bump(output.predictedWinnerId === baselineRecord.predictedWinnerId ? byFavorite.agrees : byFavorite.diverges, correct);
    }

    return {
      key: variant.key,
      label: variant.label,
      overall: toSegmentAccuracy(overall),
      byTour: Object.fromEntries([...byTour.entries()].map(([k, v]) => [k, toSegmentAccuracy(v)])),
      bySurface: Object.fromEntries([...bySurface.entries()].map(([k, v]) => [k, toSegmentAccuracy(v)])),
      byDataQuality: { high: toSegmentAccuracy(byDQ.high), low: toSegmentAccuracy(byDQ.low) },
      byFavorite: { agreesWithBaseline: toSegmentAccuracy(byFavorite.agrees), divergesFromBaseline: toSegmentAccuracy(byFavorite.diverges) },
    };
  }

  const leaveOneOutResults = new Map<AblationModelKey, VariantResult>();
  for (let i = 0; i < LEAVE_ONE_OUT_VARIANTS.length; i++) {
    const variant = LEAVE_ONE_OUT_VARIANTS[i];
    const result = await runVariant(variant, i + 1);
    leaveOneOutResults.set(variant.loo as AblationModelKey, result);
  }

  const combinationResults: VariantResult[] = [];
  for (let i = 0; i < COMBO_VARIANTS.length; i++) {
    const variant = COMBO_VARIANTS[i];
    combinationResults.push(await runVariant(variant, LEAVE_ONE_OUT_VARIANTS.length + i + 1));
  }

  onProgress?.({ phase: "diagnostics", variantIndex: variants.length, variantCount: variants.length, matchIndex: eligible.length, matchCount: eligible.length });

  function deltaPointsOf(baseline: SegmentAccuracy, ablated: SegmentAccuracy): number | null {
    if (baseline.accuracy === null || ablated.accuracy === null) return null;
    return Math.round((ablated.accuracy - baseline.accuracy) * 10) / 10;
  }

  const modelDeltas: ModelDelta[] = MODEL_DEFS.map((def) => {
    const ablated = leaveOneOutResults.get(def.key)!;
    const overallDelta = deltaPointsOf(baselineResult.overall, ablated.overall);
    const { rank, recommendation } = rankAndRecommend(overallDelta);

    const allTourKeys = new Set([...Object.keys(baselineResult.byTour), ...Object.keys(ablated.byTour)]);
    const allSurfaceKeys = new Set([...Object.keys(baselineResult.bySurface), ...Object.keys(ablated.bySurface)]);

    return {
      modelKey: def.key,
      modelLabel: def.label,
      baselineAccuracy: baselineResult.overall.accuracy,
      ablatedAccuracy: ablated.overall.accuracy,
      deltaPoints: overallDelta,
      recommendation,
      rank,
      segments: {
        byFavoriteVsUnderdog: {
          agreesWithBaseline: { baseline: baselineResult.overall, ablated: ablated.byFavorite.agreesWithBaseline },
          divergesFromBaseline: { baseline: { n: 0, accuracy: null }, ablated: ablated.byFavorite.divergesFromBaseline },
        },
        byTour: Object.fromEntries(
          [...allTourKeys].map((k) => {
            const b = baselineResult.byTour[k] ?? { n: 0, accuracy: null };
            const a = ablated.byTour[k] ?? { n: 0, accuracy: null };
            return [k, { baseline: b, ablated: a, deltaPoints: deltaPointsOf(b, a) }];
          }),
        ),
        bySurface: Object.fromEntries(
          [...allSurfaceKeys].map((k) => {
            const b = baselineResult.bySurface[k] ?? { n: 0, accuracy: null };
            const a = ablated.bySurface[k] ?? { n: 0, accuracy: null };
            return [k, { baseline: b, ablated: a, deltaPoints: deltaPointsOf(b, a) }];
          }),
        ),
        byDataQuality: {
          high: { baseline: baselineResult.byDataQuality.high, ablated: ablated.byDataQuality.high, deltaPoints: deltaPointsOf(baselineResult.byDataQuality.high, ablated.byDataQuality.high) },
          low: { baseline: baselineResult.byDataQuality.low, ablated: ablated.byDataQuality.low, deltaPoints: deltaPointsOf(baselineResult.byDataQuality.low, ablated.byDataQuality.low) },
        },
      },
    };
  });

  function rate(hit: number, total: number): number | null {
    return total > 0 ? Math.round((hit / total) * 1000) / 10 : null;
  }

  const losingPredictionAttribution: DiagnosticRow[] = MODEL_DEFS.map((def) => {
    const b = diagBuckets.get(def.key)!;
    return { modelKey: def.key, modelLabel: def.label, n: b.losingAttributionTotal, rate: rate(b.losingAttributionHit, b.losingAttributionTotal) };
  }).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));

  const overconfidentStrongVoteFailureRate: DiagnosticRow[] = MODEL_DEFS.map((def) => {
    const b = diagBuckets.get(def.key)!;
    return { modelKey: def.key, modelLabel: def.label, n: b.strongVoteTotal, rate: rate(b.strongVoteWrong, b.strongVoteTotal) };
  }).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));

  const confidenceMiscalibration: ConfidenceMiscalibrationRow[] = MODEL_DEFS.map((def) => {
    const b = diagBuckets.get(def.key)!;
    let totalN = 0;
    let weightedConfidence = 0;
    let weightedHitRate = 0;
    for (const cb of b.confBuckets.values()) {
      if (cb.n < 15) continue; // too few samples in this confidence band to trust its hit rate
      totalN += cb.n;
      weightedConfidence += cb.sumConfidence;
      weightedHitRate += cb.hits;
    }
    const avgPredictedConfidence = totalN > 0 ? Math.round((weightedConfidence / totalN) * 10) / 10 : null;
    const observedHitRate = totalN > 0 ? Math.round((weightedHitRate / totalN) * 1000) / 10 : null;
    const overconfidencePoints = avgPredictedConfidence !== null && observedHitRate !== null ? Math.round((avgPredictedConfidence - observedHitRate) * 10) / 10 : null;
    return { modelKey: def.key, modelLabel: def.label, n: totalN, avgPredictedConfidence, observedHitRate, overconfidencePoints };
  }).sort((a, b) => (b.overconfidencePoints ?? -999) - (a.overconfidencePoints ?? -999));

  const dissentFromFinalPrediction = MODEL_DEFS.map((def) => {
    const b = diagBuckets.get(def.key)!;
    return {
      modelKey: def.key,
      modelLabel: def.label,
      n: b.dissentTotal,
      rate: eligible.length > 0 ? Math.round((b.dissentTotal / eligible.length) * 1000) / 10 : null,
      correctDissentRate: rate(b.dissentCorrect, b.dissentTotal),
    };
  }).sort((a, b) => (b.correctDissentRate ?? -1) - (a.correctDissentRate ?? -1));

  onProgress?.({ phase: "done", variantIndex: variants.length, variantCount: variants.length, matchIndex: eligible.length, matchCount: eligible.length });

  logger.info({ matchCount: eligible.length, variantCount: variants.length }, "Ablation analysis complete");

  return {
    generatedAt: new Date().toISOString(),
    matchCount: eligible.length,
    sampleInfo,
    caveats: [
      ...(sampleInfo
        ? [
            `This run scored a REPRESENTATIVE SAMPLE of ${sampleInfo.scoredCount} matches (requested ${sampleInfo.requestedSampleSize}), stratified proportionally by surface and calendar year, out of ${sampleInfo.totalEligible} eligible matches in the full corpus -- not the full corpus. Match-history/Elo context was still built from the full corpus, so each sampled match's reconstructed history is accurate; only which matches were SCORED was reduced.`,
          ]
        : []),
      "This report replays the historical backtest corpus (frozen pre-match snapshots, no hindsight leakage) through the exact live ensemble engine, using the CURRENTLY ACTIVE calibration and segment-specialist models. Those were themselves fit on walk-forward folds of this same corpus, so this is a diagnostic on the current production configuration, not a fresh out-of-sample benchmark.",
      "\"Active Segment Specialist\" ablation only changes matches whose tour/surface is an actual candidate segment (ATP/WTA on Hard/Clay/Grass/IndoorHard) with an active specialist that has cleared its data threshold -- it is a true no-op on every other match, which is expected, not a bug.",
      "\"Favorite vs. underdog\" segments compare each variant's own pick against the BASELINE (full-engine) run's pick for the same match -- there is no independent market-odds favorite in this historical corpus, so the full engine's own pick is used as the reference favorite.",
      "No engine code, weights, or active models were changed by generating this report -- it is evidence and recommendations only.",
    ],
    baseline: baselineResult,
    modelDeltas,
    combinations: combinationResults,
    diagnostics: {
      losingPredictionAttribution,
      overconfidentStrongVoteFailureRate,
      confidenceMiscalibration,
      dissentFromFinalPrediction,
    },
  };
}
