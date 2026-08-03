import { createHash } from "node:crypto";
import type { HeadToHeadRecord, MatchRecord } from "../tennisData/types";
import type { OpponentEloLookup } from "./opponentStrength";

/**
 * Preventive duplicate-prediction protection (2026-07-13 spec, Part 4): every stored prediction
 * is keyed by (1) the match's identity -- the two players, tournament, surface, and format -- and
 * (2) a hash of the actual resolved inputs (match histories, head-to-head, opponent-strength
 * lookups) that fed the engine for that specific request. A genuinely identical repeat request
 * (same match, same inputs) reuses/updates the existing row instead of inserting a new one; a
 * request for the same match with materially different inputs (e.g. newer match history pulled
 * in since the last prediction) still creates a new row, because its input snapshot hash differs.
 *
 * This is deliberately separate from `ledgerDuplicates.ts`'s manual cleanup tool, which only
 * detects/removes duplicates after the fact and intentionally ignores predicted winner/inputs --
 * this module is a stricter, narrower key used only to prevent inserting an exact repeat at
 * write time.
 */

// Sentinel for "no tournament name" -- must never collide with a real (trimmed, lowercased)
// tournament name, and must be a plain string Postgres text columns will accept (unlike the
// literal null byte U+0000 this used to be, which Postgres rejects outright in a text column
// and broke every no-tournament insert into `predictions.match_identity_key`).
const NO_TOURNAMENT_SENTINEL = "__no_tournament__";

function normalizeTournamentName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : NO_TOURNAMENT_SENTINEL;
}

/**
 * Order-independent match-identity key: the same two players, tournament, surface, and format
 * always produce the same key regardless of which one is passed as player1 vs player2.
 */
export function computeMatchIdentityKey(
  player1Id: string,
  player2Id: string,
  tournamentName: string | null | undefined,
  surface: string,
  matchFormat: string,
): string {
  const pairKey = [player1Id, player2Id].sort().join("|");
  return [pairKey, normalizeTournamentName(tournamentName), surface, matchFormat].join("::");
}

/** Stable, order-independent projection of one player's match history for hashing. */
function normalizeMatches(matches: MatchRecord[]): unknown[] {
  return [...matches]
    .map((m) => ({
      id: m.id,
      date: m.date,
      surface: m.surface,
      result: m.result,
      opponentId: m.opponentId,
      tournamentLevel: m.tournamentLevel,
      retired: m.retired,
      walkover: m.walkover,
      score: m.score,
      setGameMargins: m.setGameMargins,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Stable, order-independent projection of an opponent-Elo lookup for hashing. */
function normalizeOpponentElo(lookup: OpponentEloLookup | undefined): Array<[string, number]> {
  if (!lookup) return [];
  return Array.from(lookup.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Stable, order-independent projection of head-to-head meetings for hashing. */
function normalizeHeadToHead(headToHead: HeadToHeadRecord | null | undefined): unknown {
  if (!headToHead) return null;
  return [...headToHead.meetings]
    .map((m) => ({ date: m.date, tournamentName: m.tournamentName, surface: m.surface, score: m.score, winnerId: m.winnerId }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.winnerId < b.winnerId ? -1 : a.winnerId > b.winnerId ? 1 : 0));
}

export interface InputSnapshotFields {
  player1Id: string;
  player2Id: string;
  player1Matches: MatchRecord[];
  player2Matches: MatchRecord[];
  headToHead: HeadToHeadRecord | null;
  player1OpponentElo?: OpponentEloLookup;
  player2OpponentElo?: OpponentEloLookup;
}

/**
 * SHA-256 hash of the actual resolved inputs used to compute a prediction, keyed by real player
 * id (not by "player1"/"player2" role) so the hash is identical no matter which player happens to
 * be designated player1 in a given request -- matching `computeMatchIdentityKey`'s own
 * order-independence. Deliberately excludes per-request metadata: two entry points that resolve
 * to the same real pre-match snapshot must hash identically so persistence can collapse them to a
 * single stored prediction instead of keeping contradictory duplicates alive.
 */
export function computeInputSnapshotHash(input: InputSnapshotFields): string {
  const perPlayer = [
    {
      id: input.player1Id,
      matches: normalizeMatches(input.player1Matches),
      opponentElo: normalizeOpponentElo(input.player1OpponentElo),
    },
    {
      id: input.player2Id,
      matches: normalizeMatches(input.player2Matches),
      opponentElo: normalizeOpponentElo(input.player2OpponentElo),
    },
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const snapshot = {
    players: perPlayer,
    headToHead: normalizeHeadToHead(input.headToHead),
  };

  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
