import { asc, and, eq, gte, lte, lt, inArray, or } from "drizzle-orm";
import { db, evaluationPredictionsTable, calibrationModelsTable, historicalMatchesTable, type HistoricalMatchRow, type CalibrationKnotJson } from "@workspace/db";
import { logger } from "../../lib/logger";
import { scoreHistoricalMatch, type HistoricalScoringContext } from "./historicalScoring";
import { getPredictionSettings } from "./settle";
import { getActiveSpecialistSegments } from "./specialistWeights";
import { buildMatchHistoryIndex } from "../historicalData/matchRecordReconstruction";
import { buildEloHistoryIndex } from "../predictionEngine/opponentStrength";
import { buildPlayerIdentityIndex } from "../tennisData/playerIdentity";
import { HISTORICAL_MODEL_VERSION, type ResultType, type RetirementRule } from "./types";
import { defaultPredictionMode, derivePredictionStrategyIdentity } from "./strategyIdentity";

/**
 * Shadow-mode replay (see the task spec): a faster-but-honestly-labeled alternative to waiting
 * for real live paper-trading to slowly accumulate graded fixtures one real match at a time.
 *
 * This reuses the exact same leak-proof point-in-time scoring path walk-forward uses
 * (`scoreHistoricalMatch`, bounded by each match's own frozen `cutoffAt`) but differs from
 * walk-forward in three deliberate ways that matter for what this evidence honestly means:
 *
 *  1. It writes to its own `runKind: 'paper_trade_shadow'` bucket -- never `historical_test`
 *     (walk-forward's fold-fit/out-of-sample bucket) and never `paper_trade`/`live` (genuinely
 *     real-time evidence). Nothing here is ever merged into either of those in any report.
 *  2. It is APPEND-ONLY by construction: the shared `(runKind, historicalMatchId)` unique index
 *     means a given historical match can only ever hold ONE shadow-replay row, ever, no matter
 *     how many times or under how many batch labels a replay is invoked. A second replay over an
 *     overlapping date range simply skips matches an earlier batch already claimed -- it can
 *     never duplicate or silently rescored them. Explicit `overwrite: true` on an EXACT existing
 *     `batchLabel` is the only way to replace a batch's own rows, and it deletes ONLY rows with
 *     that exact `(runKind, shadowBatchLabel)` pair -- it can never touch another batch, and it
 *     can never touch `paper_trade`/`historical_test` rows (different `runKind` entirely).
 *  3. It grades using whichever calibration mapping was ACTUALLY ACTIVE as of each individual
 *     match's own `cutoffAt` (Task #160) -- not a mapping fit from this same run's own data, and
 *     not today's currently-active mapping applied uniformly across the whole range. See
 *     `getCalibrationMappingAsOf` below and `historicalScoring.ts`'s doc on
 *     `activeCalibrationOverride`. This is what makes the result a genuine simulation of "what
 *     would live paper trading have produced on that date", rather than an in-sample backtest
 *     number OR "what today's model would say about the past".
 *
 * HONEST CAVEAT (also surfaced in the dashboard copy, not just here): this is still not a full
 * substitute for genuinely-live validation. It replays historical matches through the SAME engine
 * version being evaluated today, and the calibration-mapping history it reconstructs is only as
 * fine-grained as how often walk-forward has actually refit `calibration_models` -- unlike real
 * paper trading, it cannot tell you how the model would have behaved under conditions that were
 * truly unknown at decision time (e.g. segment-specialist fits available today did not exist on
 * those historical dates). Treat it as fast, leakage-safe, directional evidence for
 * confidence/tier claims -- never as equivalent to a genuinely-live-graded sample.
 */

export interface ShadowReplayOptions {
  /** Inclusive UTC calendar date (YYYY-MM-DD) to start replaying from. */
  startDate: string;
  /** Inclusive UTC calendar date (YYYY-MM-DD) to replay through. */
  endDate: string;
  /** Identifies this replay invocation/group; distinct batches never collide or overwrite each other. */
  batchLabel: string;
  /**
   * When true, first deletes ONLY this exact batch's own existing `paper_trade_shadow` rows
   * (matched on `runKind='paper_trade_shadow' AND shadowBatchLabel=batchLabel`), then replays the
   * requested range fresh under the same label. Default false (pure append). Never deletes any
   * other batch's rows, and never touches `paper_trade`/`historical_test` rows regardless of
   * this flag.
   */
  overwrite?: boolean;
}

export interface ShadowReplaySummary {
  batchLabel: string;
  startDate: string;
  endDate: string;
  overwrite: boolean;
  /** Rows deleted because `overwrite: true` and this exact batch already had rows. 0 otherwise. */
  deletedExistingBatchRows: number;
  /** Real, non-cancelled historical matches whose scheduledStartAt fell within the requested range. */
  matchesInRange: number;
  /** Newly written this run. */
  inserted: number;
  /** Matches in range already claimed by a DIFFERENT shadow batch (or, without overwrite, by this same batch from an earlier run) -- append-only skip, never a duplicate or a silent rescoring. */
  skippedAlreadyClaimed: number;
  /** scoreHistoricalMatch returned null (no prior history for one/both players, or surface/format unresolved) -- never inserted, never a fabricated guess. */
  skippedInsufficientData: number;
  /** Distinct UTC calendar days actually walked while pacing this replay. */
  daysSimulated: number;
}

function classifyResult(match: Pick<HistoricalMatchRow, "winnerId" | "retired" | "walkover" | "cancelled">): ResultType {
  if (match.cancelled) return "cancelled";
  if (match.walkover) return "walkover";
  if (match.retired) return "retired";
  return "normal";
}

function parseUtcDateBoundary(dateStr: string, endOfDay: boolean): Date {
  const d = new Date(`${dateStr}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${dateStr}", expected YYYY-MM-DD`);
  return d;
}

interface CalibrationHistoryEntry {
  fittedAt: Date;
  mapping: CalibrationKnotJson[];
}

/**
 * Task #160: the WHOLE fitted-calibration history, ordered oldest-first, loaded ONCE per replay
 * run. `walkForward.ts` never deletes a superseded row -- it flips the old row's `active` to
 * false and inserts a new `active: true` row with a fresh `fittedAt` -- so this table's own rows
 * already ARE a durable timeline of "which mapping was live from its own fittedAt until the next
 * row's fittedAt superseded it". This reconstructs that timeline directly from the rows
 * themselves rather than trusting the CURRENT `active` flag (which only ever describes right
 * now), so a replayed match gets the mapping that was genuinely in force on ITS OWN date.
 */
async function loadCalibrationHistory(): Promise<CalibrationHistoryEntry[]> {
  const rows = await db
    .select({ fittedAt: calibrationModelsTable.fittedAt, mapping: calibrationModelsTable.mapping })
    .from(calibrationModelsTable)
    .orderBy(asc(calibrationModelsTable.fittedAt));
  return rows;
}

/**
 * The mapping that was active as of `asOf` -- i.e. the LATEST history entry whose `fittedAt` is
 * at or before `asOf`. Returns null when `asOf` predates the very first calibration fit (no
 * mapping existed yet at that point in real history -- honestly absent, never backfilled with a
 * later mapping that didn't exist yet). `history` must already be sorted ascending by `fittedAt`
 * (see `loadCalibrationHistory`); binary search keeps this cheap even though it's called once per
 * scored match.
 */
function getCalibrationMappingAsOf(history: CalibrationHistoryEntry[], asOf: Date): CalibrationKnotJson[] | null {
  const asOfMs = asOf.getTime();
  let lo = 0;
  let hi = history.length - 1;
  let result: CalibrationKnotJson[] | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].fittedAt.getTime() <= asOfMs) {
      result = history[mid].mapping;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export async function runShadowPaperTradingReplay(options: ShadowReplayOptions): Promise<ShadowReplaySummary> {
  const { startDate, endDate, batchLabel, overwrite = false } = options;
  if (!batchLabel.trim()) throw new Error("batchLabel is required and cannot be blank");
  const rangeStart = parseUtcDateBoundary(startDate, false);
  const rangeEnd = parseUtcDateBoundary(endDate, true);
  if (rangeEnd.getTime() < rangeStart.getTime()) throw new Error("endDate must be on or after startDate");

  const settings = await getPredictionSettings();

  let deletedExistingBatchRows = 0;
  if (overwrite) {
    const deleted = await db
      .delete(evaluationPredictionsTable)
      .where(and(eq(evaluationPredictionsTable.runKind, "paper_trade_shadow"), eq(evaluationPredictionsTable.shadowBatchLabel, batchLabel)))
      .returning({ id: evaluationPredictionsTable.id });
    deletedExistingBatchRows = deleted.length;
  }

  const summary: ShadowReplaySummary = {
    batchLabel,
    startDate,
    endDate,
    overwrite,
    deletedExistingBatchRows,
    matchesInRange: 0,
    inserted: 0,
    skippedAlreadyClaimed: 0,
    skippedInsufficientData: 0,
    daysSimulated: 0,
  };

  // Task #159 rework: unlike walk-forward (which genuinely scores the WHOLE corpus every run, so
  // a full-corpus preload is unavoidable there), a shadow-replay batch only ever scores a bounded
  // date range -- but this corpus's match graph is highly connected (a real check found a single
  // ACTIVE MONTH's players' own combined histories already cover ~78% of the whole 130K+ row
  // corpus), so scoping history-reconstruction queries by "every player touched anywhere in the
  // requested range" does NOT bound memory for realistic (week/month-scale) batches -- it still
  // approaches a full-corpus load. What DOES stay bounded regardless of how long the requested
  // range is: processing ONE UTC calendar day at a time, each with its OWN small scoped context
  // (that day's matches' players, their direct histories, and those histories' own opponents'
  // Elo) that is built, used, and discarded before moving to the next day. A single day's fan-out
  // was measured at ~14% of the full corpus on a busy day -- comparable to walk-forward's own
  // per-fold cost, not a full-corpus spike -- and peak memory never grows with the requested
  // range's length, only with how busy any ONE day in it is.
  const identityIndex = await buildPlayerIdentityIndex();
  const previousSpecialistRows = await getActiveSpecialistSegments();
  const specialistRowsBySegmentKey = new Map(previousSpecialistRows.map((row) => [row.segmentKey, row]));
  // Task #160: the full fitted-calibration timeline, loaded ONCE for this whole run -- each
  // match below looks up the entry that was actually in force as of ITS OWN cutoffAt, rather
  // than one mapping applied uniformly across the whole replayed range. See this file's top doc
  // and `getCalibrationMappingAsOf`'s doc for why this is honest to do here but NOT circular.
  const calibrationHistory = await loadCalibrationHistory();
  const retirementRule = settings.retirementRule as RetirementRule;

  for (let dayStart = new Date(rangeStart); dayStart.getTime() <= rangeEnd.getTime(); dayStart.setUTCDate(dayStart.getUTCDate() + 1)) {
    const dayEnd = new Date(Math.min(new Date(dayStart).setUTCHours(23, 59, 59, 999), rangeEnd.getTime()));

    const dayMatches = await db
      .select()
      .from(historicalMatchesTable)
      .where(and(eq(historicalMatchesTable.cancelled, false), gte(historicalMatchesTable.scheduledStartAt, dayStart), lte(historicalMatchesTable.scheduledStartAt, dayEnd)))
      .orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));

    if (dayMatches.length === 0) continue;
    summary.matchesInRange += dayMatches.length;
    summary.daysSimulated += 1;

    // Already-claimed matches (this or any other batch) -- append-only skip, checked up front in
    // one query rather than per-match, then re-checked at insert time via onConflictDoNothing for
    // safety against concurrent replay invocations.
    const existingClaims = await db
      .select({ historicalMatchId: evaluationPredictionsTable.historicalMatchId })
      .from(evaluationPredictionsTable)
      .where(
        and(
          eq(evaluationPredictionsTable.runKind, "paper_trade_shadow"),
          inArray(
            evaluationPredictionsTable.historicalMatchId,
            dayMatches.map((m) => m.id),
          ),
        ),
      );
    const alreadyClaimed = new Set(existingClaims.map((r) => r.historicalMatchId));

    // Reconstructing each of TODAY's matches' own two players' PRIOR history (and their
    // head-to-head) only ever needs matches where one of THOSE two players took part AND that
    // happened strictly before this batch's cutoffs -- every scoring call filters by its own
    // exact `cutoffAt` regardless, so a match scheduled on or after `dayEnd` can never be picked
    // up by ANY of today's lookups. Pushing that upper bound into the query too (not just the
    // player filter) matters in practice: this corpus spans 2021-2026, so for an ACTIVE player,
    // roughly half their career sits on either side of any given day, and loading the "after"
    // half is pure wasted memory for a replay that will never score anything back in time.
    const targetPlayerIds = [...new Set(dayMatches.flatMap((m) => [m.player1Id, m.player2Id]))];
    const directMatches = await db
      .select()
      .from(historicalMatchesTable)
      .where(
        and(
          lt(historicalMatchesTable.scheduledStartAt, dayEnd),
          or(inArray(historicalMatchesTable.player1Id, targetPlayerIds), inArray(historicalMatchesTable.player2Id, targetPlayerIds)),
        ),
      );

    // Opponent-strength resolution (see `opponentStrength.ts`) needs each of today's players'
    // PAST opponents' own Elo timelines too -- one level beyond the target players themselves --
    // so the Elo index is scoped to target players UNION every opponent found in `directMatches`.
    const eloPlayerIds = new Set(targetPlayerIds);
    for (const m of directMatches) {
      eloPlayerIds.add(m.player1Id);
      eloPlayerIds.add(m.player2Id);
    }

    const scoringContext: HistoricalScoringContext = {
      matchHistory: buildMatchHistoryIndex(directMatches),
      eloHistory: await buildEloHistoryIndex(identityIndex, [...eloPlayerIds]),
      identityIndex,
      specialistRowsBySegmentKey,
      // Shadow replay is point-in-time historical evaluation: suppress the segment specialist
      // so its today's-DB calibration doesn't override the per-match historical general
      // calibration resolved by `getCalibrationMappingAsOf`. See HistoricalScoringContext for
      // the full rationale. This is set unconditionally (not gated on whether a calibration
      // override was resolved for a given match) so specialist behaviour is consistent across
      // the entire replay run regardless of calibration history coverage.
      isPointInTimeReplay: true,
    };

    for (const match of dayMatches) {
      if (alreadyClaimed.has(match.id)) {
        summary.skippedAlreadyClaimed += 1;
        continue;
      }

      const resultType = classifyResult(match);
      const isVoid = resultType === "walkover" || resultType === "cancelled";

      const calibrationMapping = getCalibrationMappingAsOf(calibrationHistory, match.cutoffAt);
      const scored = scoreHistoricalMatch(match, scoringContext, calibrationMapping);
      if (!scored) {
        summary.skippedInsufficientData += 1;
        continue;
      }

      const favorsPlayer1 = scored.calibratedProbability >= 0.5;
      const predictedWinnerId = favorsPlayer1 ? match.player1Id : match.player2Id;
      const includedInAccuracy = !isVoid && (resultType === "normal" || retirementRule === "included");

      const inserted = await db
        .insert(evaluationPredictionsTable)
        .values({
          predictionMode: defaultPredictionMode("paper_trade_shadow"),
          strategyId: derivePredictionStrategyIdentity({ predictionMode: defaultPredictionMode("paper_trade_shadow"), modelVersion: HISTORICAL_MODEL_VERSION, createdAt: new Date() }).strategyId,
          strategyVersion: derivePredictionStrategyIdentity({ predictionMode: defaultPredictionMode("paper_trade_shadow"), modelVersion: HISTORICAL_MODEL_VERSION, createdAt: new Date() }).strategyVersion,
          strategyFingerprint: HISTORICAL_MODEL_VERSION,
          optimizerRunId: null,
          calibrationVersion: null,
          competitiveBalanceVersion: null,
          evidenceReliabilityVersion: null,
          runKind: "paper_trade_shadow",
          shadowBatchLabel: batchLabel,
          historicalMatchId: match.id,
          player1Id: match.player1Id,
          player1Name: match.player1Name,
          player2Id: match.player2Id,
          player2Name: match.player2Name,
          surface: match.surface,
          matchFormat: match.matchFormat,
          tournamentLevel: match.tournamentLevel,
          tournamentName: match.tournamentName,
          scheduledStartAt: match.scheduledStartAt,
          cutoffAt: match.cutoffAt,
          lockedAt: new Date(),
          modelVersion: HISTORICAL_MODEL_VERSION,
          featureSnapshot: scored.snapshot,
          modelAgreement: scored.modelAgreement,
          upsetRiskTier: scored.upsetRiskTier,
          rawProbability: scored.rawProbability * 100,
          calibratedProbability: scored.calibratedProbability * 100,
          predictedWinnerId,
          predictedWinnerName: predictedWinnerId === match.player1Id ? match.player1Name : match.player2Name,
          status: isVoid ? "void" : "graded",
          actualWinnerId: match.winnerId,
          actualWinnerName: match.winnerId ? (match.winnerId === match.player1Id ? match.player1Name : match.player2Name) : null,
          resultType,
          includedInAccuracy,
          gradedAt: new Date(),
        })
        .onConflictDoNothing({ target: [evaluationPredictionsTable.runKind, evaluationPredictionsTable.historicalMatchId] })
        .returning({ id: evaluationPredictionsTable.id });

      if (inserted.length > 0) {
        summary.inserted += 1;
      } else {
        // Lost a race against a concurrent replay invocation claiming the same match between the
        // upfront check and this insert -- treat exactly like a pre-existing claim, never an error.
        summary.skippedAlreadyClaimed += 1;
      }
    }
    // `dayMatches`/`directMatches`/`scoringContext` fall out of scope here -- nothing from one
    // day's scoped context is retained once the next day's iteration begins.
  }

  logger.info(
    {
      batchLabel,
      startDate,
      endDate,
      overwrite,
      matchesInRange: summary.matchesInRange,
      inserted: summary.inserted,
      skippedAlreadyClaimed: summary.skippedAlreadyClaimed,
      skippedInsufficientData: summary.skippedInsufficientData,
      daysSimulated: summary.daysSimulated,
    },
    "Shadow paper-trading replay batch completed",
  );

  return summary;
}

export interface ShadowReplayBatchSummary {
  batchLabel: string;
  n: number;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  earliestLockedAt: string | null;
  latestLockedAt: string | null;
}

/** Lists every distinct shadow-replay batch currently on record, most recently touched first. */
export async function listShadowReplayBatches(): Promise<ShadowReplayBatchSummary[]> {
  const rows = await db
    .select({
      shadowBatchLabel: evaluationPredictionsTable.shadowBatchLabel,
      scheduledStartAt: evaluationPredictionsTable.scheduledStartAt,
      lockedAt: evaluationPredictionsTable.lockedAt,
    })
    .from(evaluationPredictionsTable)
    .where(eq(evaluationPredictionsTable.runKind, "paper_trade_shadow"));

  const byBatch = new Map<string, { scheduledStarts: number[]; lockedAts: number[] }>();
  for (const row of rows) {
    const label = row.shadowBatchLabel ?? "(unlabeled)";
    if (!byBatch.has(label)) byBatch.set(label, { scheduledStarts: [], lockedAts: [] });
    const bucket = byBatch.get(label)!;
    bucket.scheduledStarts.push(row.scheduledStartAt.getTime());
    bucket.lockedAts.push(row.lockedAt.getTime());
  }

  return [...byBatch.entries()]
    .map(([batchLabel, bucket]) => ({
      batchLabel,
      n: bucket.scheduledStarts.length,
      dateRangeStart: bucket.scheduledStarts.length ? new Date(Math.min(...bucket.scheduledStarts)).toISOString() : null,
      dateRangeEnd: bucket.scheduledStarts.length ? new Date(Math.max(...bucket.scheduledStarts)).toISOString() : null,
      earliestLockedAt: bucket.lockedAts.length ? new Date(Math.min(...bucket.lockedAts)).toISOString() : null,
      latestLockedAt: bucket.lockedAts.length ? new Date(Math.max(...bucket.lockedAts)).toISOString() : null,
    }))
    .sort((a, b) => (b.latestLockedAt ?? "").localeCompare(a.latestLockedAt ?? ""));
}
