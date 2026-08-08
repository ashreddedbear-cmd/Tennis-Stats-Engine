import type { EngineOutput } from "../predictionEngine";
import { runPredictionEngine } from "../predictionEngine";
import { buildPlayerProfileWarnings } from "../predictionEngine/playerProfileWarnings";
import { resolveOpponentStrength, type OpponentStrengthResolution } from "../predictionEngine/opponentStrength";
import { getUpcomingConditions, type WeatherConditions } from "../predictionEngine/weather";
import type { MatchFormat, MatchRecord, PlayerProfile, Surface, TennisDataProvider, TournamentLevel, HeadToHeadRecord } from "../tennisData";
import { enrichPlayerRankFromSearch, resolvePlayerProfileForPrediction } from "../tennisData/playerIdentity";
import { CompositeTennisProvider } from "../tennisData/compositeProvider.js";
import { resolveSegmentSpecialistInput } from "./specialistWeights";
import { resolveSimulatorAdoption } from "./simulatorValidation";
import { fetchMarketOddsWithStatus, type OddsQuote, type OddsStatus } from "../oddsData/index.js";
import { getActiveCalibration } from "./calibrationCache.js";

// ---------------------------------------------------------------------------
// Task #154: per-phase timing instrumentation
// ---------------------------------------------------------------------------
// Enabled in development (NODE_ENV !== 'production') or whenever PERF_LOG=true.
// Format: [PERF] <label>: <ms>ms (or TOTAL: <ms>ms for the full request).
// ---------------------------------------------------------------------------
const PERF_ENABLED =
  process.env["NODE_ENV"] !== "production" || process.env["PERF_LOG"] === "true";

function perfPhase(label: string, startMs: number): void {
  if (!PERF_ENABLED) return;
  const elapsed = performance.now() - startMs;
  console.log(`[PERF] ${label}: ${elapsed.toFixed(1)}ms`);
}

export class PredictionSnapshotResolutionError extends Error {
  readonly missingFields: string[];

  constructor(message: string, missingFields: string[]) {
    super(message);
    this.name = "PredictionSnapshotResolutionError";
    this.missingFields = missingFields;
  }
}

export interface PredictionSnapshotInput {
  provider: TennisDataProvider;
  player1Id: string;
  player2Id: string;
  /** Submitted player names (from fixture card headers). Used by resolution to recover the
   *  correct provider ID via name-search when the submitted fixture ID is from a different
   *  ID namespace (e.g. MatchStat IDs collide with unrelated API-Tennis records). */
  player1SubmittedName?: string | null;
  player2SubmittedName?: string | null;
  surface: Surface;
  matchFormat: MatchFormat;
  tournamentName?: string | null;
  tournamentLevel?: TournamentLevel | null;
  scheduledStartAt?: Date | null;
  includeWeather?: boolean;
}

export interface PredictionSnapshotResult {
  player1: PlayerProfile;
  player2: PlayerProfile;
  player1Matches: MatchRecord[];
  player2Matches: MatchRecord[];
  headToHead: HeadToHeadRecord;
  player1OpponentStrength: OpponentStrengthResolution;
  player2OpponentStrength: OpponentStrengthResolution;
  weather: WeatherConditions | null;
  activeCalibrationId: string | null;
  output: EngineOutput;
  /**
   * Task #146: the raw OddsQuote that was passed to the engine's Market Consensus module, or null
   * when no odds were available. Exposed so callers (paper trading, user-facing route) can write
   * audit columns from the same fetch that the engine already consumed — no second fetch needed.
   */
  marketOdds: OddsQuote | null;
  /**
   * Task #146: three-state odds outcome — "included" / "outside_window" / "provider_error".
   * Callers record this on their respective rows so it's distinguishable at query time.
   */
  marketOddsStatus: OddsStatus;
}

/**
 * Canonical pre-match snapshot scorer used by both live-search and paper-trading paths.
 * Every caller gets the same profile enrichment, feature assembly, and engine invocation flow.
 */
export async function predictFromSnapshot(input: PredictionSnapshotInput): Promise<PredictionSnapshotResult> {
  const totalStart = performance.now();

  // ── Phase: DB player lookup / provider profile resolution ──────────────────
  const t0 = performance.now();
  const [player1Resolution, player2Resolution] = await Promise.all([
    resolvePlayerProfileForPrediction(input.provider, input.player1Id, input.player1SubmittedName ?? undefined),
    resolvePlayerProfileForPrediction(input.provider, input.player2Id, input.player2SubmittedName ?? undefined),
  ]);
  perfPhase("DB player lookup", t0);

  const player1Raw = player1Resolution.profile;
  const player2Raw = player2Resolution.profile;

  if (!player1Raw || !player2Raw) {
    const missingFields: string[] = [];
    if (!player1Raw) missingFields.push("player1Id");
    if (!player2Raw) missingFields.push("player2Id");
    const detail = [player1Resolution.detail, player2Resolution.detail].filter(Boolean).join(" | ");
    throw new PredictionSnapshotResolutionError(
      detail || "One or both players could not be resolved to a provider-backed player ID.",
      missingFields,
    );
  }

  const resolvedPlayer1Id = player1Resolution.resolvedPlayerId;
  const resolvedPlayer2Id = player2Resolution.resolvedPlayerId;

  // Pre-seed the composite provider's name cache so the Sofascore tier-3 in
  // getPlayerMatches can activate even if getPlayer() fails for both primary and
  // fallback (e.g. API-Tennis circuit open, player not in MatchStat rankings).
  // Submitted names come from fixture card headers — they are the real names
  // from the source that generated the fixture, not guesses.
  if (input.provider instanceof CompositeTennisProvider) {
    if (input.player1SubmittedName && resolvedPlayer1Id) {
      input.provider.seedPlayerName(resolvedPlayer1Id, input.player1SubmittedName);
    }
    if (input.player2SubmittedName && resolvedPlayer2Id) {
      input.provider.seedPlayerName(resolvedPlayer2Id, input.player2SubmittedName);
    }
  }

  const t1 = performance.now();
  const [player1, player2] = await Promise.all([
    enrichPlayerRankFromSearch(input.provider, player1Raw),
    enrichPlayerRankFromSearch(input.provider, player2Raw),
  ]);
  perfPhase("rank enrichment", t1);

  // Guard every provider call: when the circuit breaker is open these throw
  // ProviderUnavailableError.  Falling back to empty match lists / null h2h lets
  // the prediction engine run on historical-DB data alone (data quality will be
  // lower, disclosures will fire) rather than hard-failing with 502.
  const safeGetMatches = async (id: string) => {
    try { return await input.provider.getPlayerMatches(id); }
    catch { return []; }
  };
  const safeGetH2H = async (id1: string, id2: string): Promise<HeadToHeadRecord> => {
    try { return await input.provider.getHeadToHead(id1, id2); }
    catch { return { player1Id: id1, player2Id: id2, meetings: [] }; }
  };

  const t2 = performance.now();
  const [player1Matches, player2Matches, headToHead] = await Promise.all([
    safeGetMatches(resolvedPlayer1Id),
    safeGetMatches(resolvedPlayer2Id),
    safeGetH2H(resolvedPlayer1Id, resolvedPlayer2Id),
  ]);
  perfPhase("H2H + match history fetch", t2);

  const matchTour = player1.tour ?? player2.tour;

  // ── Phase: calibration lookup (cached, ~0ms on warm hits) ─────────────────
  const t3 = performance.now();
  const [
    player1OpponentStrength,
    player2OpponentStrength,
    calibrationResult,
    segment,
    simulatorAdoption,
    weather,
    marketOddsResult,
  ] = await Promise.all([
    resolveOpponentStrength(player1Matches),
    resolveOpponentStrength(player2Matches),
    // Task #154: 5-minute TTL cache replaces a fresh DB SELECT on every prediction call.
    getActiveCalibration(),
    resolveSegmentSpecialistInput(matchTour, input.surface),
    resolveSimulatorAdoption(),
    input.includeWeather && input.scheduledStartAt
      ? getUpcomingConditions(input.tournamentName ?? null, input.scheduledStartAt)
      : Promise.resolve(null),
    // Real pre-match market odds (The Odds API primary → Odds-API.io fallback).
    // Passed to the engine so the Market Consensus module can vote when real odds are available.
    // fetchMarketOddsWithStatus never throws — returns { quote, status } distinguishing
    // "outside window" (no odds yet, expected) from "provider_error" (quota/network failure).
    fetchMarketOddsWithStatus(player1.name, player2.name, input.scheduledStartAt ?? null),
  ]);
  perfPhase("calibration + opponent strength + odds fetch", t3);

  // ── Phase: engine run (includes Monte Carlo on worker thread) ──────────────
  const t4 = performance.now();
  const output = await runPredictionEngine({
    player1,
    player2,
    player1Matches,
    player2Matches,
    headToHead,
    surface: input.surface,
    matchFormat: input.matchFormat,
    player1OpponentElo: player1OpponentStrength.lookup,
    player2OpponentElo: player2OpponentStrength.lookup,
    activeCalibration: calibrationResult.mapping ?? null,
    weather,
    tournamentName: input.tournamentName ?? null,
    tournamentLevel: input.tournamentLevel ?? null,
    segment,
    simulatorAdoption,
    marketOdds: marketOddsResult.quote,
  });
  perfPhase("prediction engine (incl. Monte Carlo)", t4);

  output.engine.warnings.push(...buildPlayerProfileWarnings(player1, player2));

  perfPhase("TOTAL predictFromSnapshot", totalStart);

  return {
    player1,
    player2,
    player1Matches,
    player2Matches,
    headToHead,
    player1OpponentStrength,
    player2OpponentStrength,
    weather,
    activeCalibrationId: calibrationResult.modelId !== null ? String(calibrationResult.modelId) : null,
    output,
    marketOdds: marketOddsResult.quote,
    marketOddsStatus: marketOddsResult.status,
  };
}
