import type { computeSurfaceEloModule } from "./surfaceElo";
import type { computeServeReturnModule } from "./serveReturn";
import type { computeRecentFormModule } from "./recentForm";
import type { computeFatigueModule } from "./fatigue";
import type { computeHeadToHeadModule } from "./headToHead";
import type { MatchRecord, PlayerProfile, Surface } from "../tennisData/types";
import { edgeToProbability } from "./ensemble";

/** How close the raw ensemble probability has to sit to 50 before the close-match disclosure fires. */
export const TIE_BAND = 3;

export interface TieBreakerInputs {
  surfaceElo: ReturnType<typeof computeSurfaceEloModule>;
  serveReturn: ReturnType<typeof computeServeReturnModule>;
  recentForm: ReturnType<typeof computeRecentFormModule>;
  fatigue: ReturnType<typeof computeFatigueModule>;
  headToHead: ReturnType<typeof computeHeadToHeadModule>;
  player1: PlayerProfile;
  player2: PlayerProfile;
  player1Matches: MatchRecord[];
  player2Matches: MatchRecord[];
  surface: Surface;
  defaultedInputs?: string[];
}

export interface TieBreakerResult {
  applied: boolean;
  dataIncomplete: boolean;
  direction: 1 | -1 | 0;
  adjustedProbability: number;
  note: string | null;
  decidingStep: string | null;
}

/** Minimum standalone confidence-from-50 (in percentage points) for a core module signal to be "decisive" on its own. */
const CORE_DECISIVE_SIGNAL_POINTS = TIE_BAND;

function probabilityDistanceFromCoinFlip(edge: number): number {
  return Math.abs(edgeToProbability(edge) - 50);
}

function getDiagnosticDecidingStep(inputs: TieBreakerInputs): string | null {
  const serveReturnEdge =
    inputs.serveReturn.player1ServeRating +
    inputs.serveReturn.player1ReturnRating -
    inputs.serveReturn.player2ServeRating -
    inputs.serveReturn.player2ReturnRating;
  if (Math.abs(serveReturnEdge) > 0) return "Serve & Return";

  const surfaceEloEdge = inputs.surfaceElo.eloDifference / 8;
  if (Math.abs(surfaceEloEdge) > 0) return "Surface Elo";

  const recentFormEdge = (inputs.recentForm.player1Form - inputs.recentForm.player2Form) / 2;
  if (Math.abs(recentFormEdge) > 0) return "Recent Form";

  return null;
}

function hasDecisiveCoreSignal(inputs: TieBreakerInputs): boolean {
  const surfaceEloEdge = inputs.surfaceElo.eloDifference / 8;
  const serveReturnEdge =
    inputs.serveReturn.player1ServeRating +
    inputs.serveReturn.player1ReturnRating -
    inputs.serveReturn.player2ServeRating -
    inputs.serveReturn.player2ReturnRating;
  const recentFormEdge = (inputs.recentForm.player1Form - inputs.recentForm.player2Form) / 2;
  return (
    probabilityDistanceFromCoinFlip(surfaceEloEdge) >= CORE_DECISIVE_SIGNAL_POINTS ||
    probabilityDistanceFromCoinFlip(serveReturnEdge) >= CORE_DECISIVE_SIGNAL_POINTS ||
    probabilityDistanceFromCoinFlip(recentFormEdge) >= CORE_DECISIVE_SIGNAL_POINTS
  );
}

/**
 * Identifies genuinely close matchups (raw ensemble within `TIE_BAND` of 50) and surfaces an
 * honest disclosure. No directional nudge is applied.
 *
 * HISTORY — why the old cascade was removed (Task #5, 2026-07-15):
 * The previous implementation ran a 7-step priority cascade (Serve & Return → Surface Elo →
 * Recent Form → surface win-rate history → ranking → Fatigue → Head-to-Head) and nudged the
 * probability by ±2.5 points whenever a step had a non-trivial signal. A graded-outcome audit
 * against 1,509 validation rows where the cascade actually fired found every step with usable
 * sample size performed at or below a coin flip in the tight-signal regime:
 *
 *   - Serve & Return (n=1,374, decides 91% of cases): 53.7% accuracy
 *   - Surface Elo (n=120): 46.7% accuracy (worse than random)
 *   - Non-applied baseline: 66.7% accuracy
 *
 * Every applied step was 13–20 points below the non-applied baseline. Nudging the probability
 * in a direction validated to be wrong is actively worse than passing the raw ensemble number
 * through unchanged. It was also dishonest: the cascade displayed a named justification ("Serve &
 * Return gives a modest lean") that reads as trustworthy while performing worse than an explicit
 * 50/50 would.
 *
 * The fix: when within TIE_BAND, the raw ensemble probability passes through unchanged with an
 * honest "genuinely close matchup" note. `applied: true` is still set so the UI can surface the
 * disclosure without implying any directional lean was taken.
 *
 * Task #163 follow-up: keep a diagnostic breadcrumb (`decidingStep`) showing which CORE module
 * the old cascade would have reached first (Serve & Return → Surface Elo → Recent Form), but
 * never let that diagnostic decide the final winner.
 */
export function applyTieBreaker(rawEnsembleProbability: number, inputs: TieBreakerInputs): TieBreakerResult {
  const dataIncomplete = inputs.defaultedInputs?.length ? true : false;
  if (Math.abs(rawEnsembleProbability - 50) >= TIE_BAND) {
    return { applied: false, dataIncomplete, direction: 0, adjustedProbability: rawEnsembleProbability, note: dataIncomplete ? `Data incomplete: ${inputs.defaultedInputs!.join(", ")}.` : null, decidingStep: null };
  }

  const decidingStep = getDiagnosticDecidingStep(inputs);
  const decisiveCoreSignal = hasDecisiveCoreSignal(inputs);
  const decisiveText = decisiveCoreSignal
    ? `At least one core module has a standalone signal of >= ${CORE_DECISIVE_SIGNAL_POINTS} points from 50%, but this is still treated as no-pick in close-match mode.`
    : `None of the core modules has a standalone signal of >= ${CORE_DECISIVE_SIGNAL_POINTS} points from 50%.`;
  const diagnosticText = decidingStep
    ? `Diagnostic only: the retired cascade would have reached \"${decidingStep}\" first.`
    : "Diagnostic only: no core module produced a non-zero directional edge.";

  return {
    applied: true,
    dataIncomplete,
    direction: 0,
    adjustedProbability: rawEnsembleProbability,
    decidingStep,
    note: dataIncomplete
      ? `Data incomplete: ${inputs.defaultedInputs!.join(", ")}. The raw ensemble is within ${TIE_BAND} points of 50%, but missing inputs prevent a genuine close-call classification.`
      : `Core signals are within ${TIE_BAND} points of a coin flip (raw ${rawEnsembleProbability.toFixed(1)}%). ${decisiveText} ${diagnosticText} The ensemble's natural probability is used as-is; no directional pick or nudge is applied.`,
  };
}
