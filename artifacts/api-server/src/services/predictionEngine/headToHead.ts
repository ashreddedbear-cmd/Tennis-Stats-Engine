import type { HeadToHeadRecord, Surface } from "../tennisData/types";
import { inferSurfaceAndLevel } from "../tennisData/surfaceMap";

export interface HeadToHeadResult {
  player1Wins: number;
  player2Wins: number;
  surfaceMeetings: number;
  recentMeetings: number;
  /** Recency- and tournament-level-weighted edge toward player1 (-1..1), 0 when meetings are even/absent. */
  weightedEdge: number;
  reliability: number;
  /** True when no direct meetings were available; weightedEdge is then neutral by construction. */
  defaulted: boolean;
  warnings: string[];
}

const MIN_MEETINGS_FOR_NO_WARNING = 2;

/** Bigger, higher-stakes tournaments are a stronger signal of true matchup quality than a routine early-round meeting. */
const LEVEL_WEIGHT: Record<string, number> = {
  GrandSlam: 1.5,
  Masters1000: 1.3,
  WTA1000: 1.3,
  ATP500: 1.1,
  WTA500: 1.1,
  ATP250: 1,
  WTA250: 1,
  Challenger: 0.8,
  ITF: 0.6,
  Other: 0.9,
};

export function computeHeadToHeadModule(h2h: HeadToHeadRecord, surface: Surface): HeadToHeadResult {
  const player1Wins = h2h.meetings.filter((m) => m.winnerId === h2h.player1Id).length;
  const player2Wins = h2h.meetings.filter((m) => m.winnerId === h2h.player2Id).length;
  const surfaceMeetings = h2h.meetings.filter((m) => m.surface === surface).length;

  const threeYearsAgo = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;
  const recentMeetings = h2h.meetings.filter((m) => new Date(m.date).getTime() >= threeYearsAgo).length;

  // Opponent-quality-adjusted weighting: recency decay (a meeting from 5 years ago says less about
  // the players today than one from last month) combined with tournament-level weight (a Grand
  // Slam final is a cleaner signal than a Challenger first round). Both factors are derived from
  // real, already-available match metadata -- no fabricated per-match quality score.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const meeting of h2h.meetings) {
    const ageMs = Date.now() - new Date(meeting.date).getTime();
    const ageYears = ageMs / (365 * 24 * 60 * 60 * 1000);
    const recencyWeight = Math.pow(0.85, Math.max(0, ageYears)); // ~15% decay per year
    const { level } = inferSurfaceAndLevel(meeting.tournamentName);
    const levelWeight = level ? LEVEL_WEIGHT[level] ?? 1 : 0.9; // unknown level (common for Challenger/ITF) treated as slightly below baseline
    const weight = recencyWeight * levelWeight;
    const sign = meeting.winnerId === h2h.player1Id ? 1 : meeting.winnerId === h2h.player2Id ? -1 : 0;
    weightedSum += sign * weight;
    weightTotal += weight;
  }
  const weightedEdge = weightTotal > 0 ? weightedSum / weightTotal : 0;

  const totalMeetings = player1Wins + player2Wins;
  const reliability = Math.max(5, Math.min(100, totalMeetings * 20));

  const warnings: string[] = [];
  if (totalMeetings < MIN_MEETINGS_FOR_NO_WARNING) {
    warnings.push(
      totalMeetings === 0
        ? "No prior head-to-head meetings -- this matchup has no direct precedent."
        : "Only one prior head-to-head meeting -- this signal is low-confidence.",
    );
  }

  return {
    player1Wins,
    player2Wins,
    surfaceMeetings,
    recentMeetings,
    weightedEdge: Math.round(weightedEdge * 1000) / 1000,
    reliability: Math.round(reliability),
    defaulted: totalMeetings === 0,
    warnings,
  };
}
