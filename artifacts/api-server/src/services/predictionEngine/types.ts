import type { MatchFormat, MatchRecord, PlayerProfile, Surface, HeadToHeadRecord } from "../tennisData/types";
import type { OddsQuote } from "../oddsData/types";
import type { OpponentEloLookup } from "./opponentStrength";
import type { WeatherConditions } from "./weather";
import type { CalibrationKnot } from "../evaluation/types";

/** Standard shape returned by every engine module. */
export interface ModuleResult {
  player1Edge: number; // signed edge toward player 1, roughly -50..50
  player2Edge: number;
  reliability: number; // 0-100
  summary: string;
  warnings: string[];
}

export interface PredictionEngineInput {
  player1: PlayerProfile;
  player2: PlayerProfile;
  player1Matches: MatchRecord[];
  player2Matches: MatchRecord[];
  headToHead: HeadToHeadRecord;
  surface: Surface;
  matchFormat: MatchFormat;
  /**
   * Real opponent-strength estimates (from Phase 3's historical Elo store), pre-resolved by the
   * caller via `resolveOpponentStrength` -- the engine itself stays synchronous/DB-free. Omit or
   * pass empty maps to fall back to the pre-Phase-5, opponent-neutral behavior.
   */
  player1OpponentElo?: OpponentEloLookup;
  player2OpponentElo?: OpponentEloLookup;
  /**
   * Task #77: opt-in only. When true, the engine's opponent-Elo replay records structured
   * fallback-tracker events (see `fallbackTracking.ts`) for this call, keyed off `player1.id`/
   * `player2.id`. Must be set ONLY by run-oriented, batch-scoped callers that `reset()` the
   * tracker themselves at the start of their own run (walk-forward evaluation, the full-corpus
   * rebuild script) -- NEVER by live per-fixture callers (prediction routes, paper trading,
   * ablation, ledger regeneration). Defaulting to false/omitted keeps the tracker's global
   * singleton from silently accumulating an unbounded event log across ordinary live traffic,
   * which has no run boundary to reset it.
   */
  trackEloFallback?: boolean;
  /**
   * Real forecast conditions for a genuinely upcoming fixture with a known venue, pre-resolved by
   * the caller via `getUpcomingConditions`. Informational only -- never used to adjust the
   * ensemble's probability. Null/omitted means "not available", never a guess.
   */
  weather?: WeatherConditions | null;
  /**
   * The tournament name for this match, used only to look up real venue coordinates (via
   * `venueMap.ts`, the same static lookup weather uses) for the rest/travel signals in
   * `availability.ts`. Omit/null when unknown -- travel distance simply reports as unavailable,
   * never a guess.
   */
  tournamentName?: string | null;
  /**
   * Tournament level label (e.g. "ATP250", "Challenger", "ITF") when known, used only by the
   * upset-risk volatility component (`upsetRisk.ts`) -- a small, historically-measured adjustment
   * for levels this engine's own evaluation corpus showed a real (not fabricated) deviation for.
   * Omit/null when unknown -- the volatility component simply reports 0 for this match rather
   * than guessing.
   */
  tournamentLevel?: string | null;
  /**
   * Task #107 (Phase 5): Optional real-time web-research result for this matchup (injury status,
   * fatigue, recent news), fetched by the caller via `researchPlayerMatchup` from
   * `services/shared/webResearchProvider`. The engine itself stays synchronous/external-API-free;
   * the caller decides whether the prediction context warrants the Gemini call (e.g. close
   * predictions near 50%, or explicit user requests). Omit/null to skip entirely.
   */
  webResearch?: import("../shared/webResearchProvider.js").MatchupResearch | null;
  /**
   * The currently active Phase 4 isotonic calibration mapping (fitted from real walk-forward
   * validation data), pre-fetched by the caller. When present, this is used in place of the
   * engine's own dataQuality-based heuristic shrink -- a real, data-validated calibration beats a
   * hand-tuned stand-in. Omit/empty to fall back to the heuristic (e.g. before any evaluation run
   * has ever produced a fitted model).
   */
  activeCalibration?: CalibrationKnot[] | null;
  /**
   * Phase 6 tour/surface specialist for this match's segment, pre-resolved by the caller (mirrors
   * the `activeCalibration` pattern -- the engine stays sync/DB-free). Omit/null when the match's
   * tour isn't one of Phase 6's candidate segments at all (e.g. Challenger/ITF/Exhibition) --
   * distinct from a *resolved* segment that simply doesn't meet its data threshold yet
   * (`meetsThreshold: false`), so the engine can surface an honest, specific disclaimer either way
   * instead of silently doing the same thing for two different reasons.
   */
  segment?: SegmentSpecialistInput | null;
  /**
   * Phase 7: whether the Monte Carlo point-by-point simulator has been validated (against real
   * historical/live outcomes) well enough to earn a vote in the ensemble, pre-resolved by the
   * caller (mirrors the `segment` pattern -- the engine stays sync/DB-free). Omit/null to fall
   * back to "not yet validated" -- the simulation is still computed and shown, just not blended
   * into calibratedProbability.
   */
  simulatorAdoption?: SimulatorAdoptionInput | null;
  /**
   * Real pre-match head-to-head market odds for this specific matchup, pre-fetched by the caller
   * via `fetchMarketOdds` (mirrors the `activeCalibration` pattern — the engine stays sync/DB-free).
   * Orientation: `player1DecimalOdds` / `player2DecimalOdds` are player-1-relative (same as every
   * other engine input). When present, the engine adds a Market Consensus vote to the ensemble
   * using the vig-normalized implied probability. Omit/null when no odds are available for this
   * matchup — the module is simply absent from the ensemble rather than falling back to 50/50.
   */
  marketOdds?: OddsQuote | null;
  /**
   * Ablation-analysis only (see `services/evaluation/ablation.ts`). When present, each named
   * model source is removed from the ensemble for this single call: the remaining feature
   * modules' weights are re-normalized by the ensemble's own existing method (nothing special
   * added for this), "generalEnsemble" skips the general-model calibration step (falls back to
   * the raw ensemble probability as the blend base), and "segmentSpecialist" forces the segment
   * specialist off regardless of `segment`. Omit/undefined in every real (non-ablation) call --
   * this never changes live prediction behavior.
   */
  excludedModels?: ReadonlySet<AblationModelKey>;
  /**
   * The instant Fatigue's 3/7/14-day recency windows are measured against (see `fatigue.ts`).
   * Omit for every live call -- it defaults to the real current time, which is correct there.
   * Walk-forward/backtest evaluation (`historicalScoring.ts`) passes each match's own frozen
   * `cutoffAt` here instead, so historical rows measure recency against their own as-of moment
   * rather than today's wall-clock time. 2026-07-14 fix -- before this, backtest fatigue always
   * compared match dates from years ago against `Date.now()`, so the windows were always empty.
   */
  asOfDate?: Date;
}

/** The named vote sources the ablation analysis can remove one (or a few) of at a time. */
export type AblationModelKey =
  | "surfaceElo"
  | "serveReturn"
  | "recentForm"
  | "fatigue"
  | "availability"
  | "headToHead"
  | "matchLoadRecovery"
  | "marketOdds"
  | "generalEnsemble"
  | "segmentSpecialist";

export interface SimulatorAdoptionInput {
  /** True only once the simulator has cleared its own sample-size threshold AND measurably improved on the general model's logLoss on real graded outcomes. */
  adopted: boolean;
  /** This simulator's measured blend weight (0-1) against the rest of the ensemble. Present only when `adopted` is true. */
  weight?: number;
  sampleSize: number;
  minSampleSize: number;
  /** Always present -- explains why the simulator is or isn't voting yet, never silent. */
  note: string;
}

export interface SegmentSpecialistInput {
  segmentKey: string;
  label: string;
  meetsThreshold: boolean;
  historicalMatchCount: number;
  validationSampleSize: number;
  minHistoricalMatches: number;
  minValidationSamples: number;
  /** Present only when `meetsThreshold` is true. */
  calibrationMapping?: CalibrationKnot[];
  /** This segment's measured blend weight (0-1) against the general model. Present only when `meetsThreshold` is true. */
  weight?: number;
}
