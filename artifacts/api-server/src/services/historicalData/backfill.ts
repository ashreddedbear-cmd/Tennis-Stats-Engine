import { db, historicalMatchesTable, matchFeatureSnapshotsTable, evaluationPredictionsTable } from "@workspace/db";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import type { Surface, TennisDataProvider, HistoricalFixture } from "../tennisData/types";
import { combineDateTimeUtc } from "../tennisData/apiTennisProvider";
import { resolveTournamentTimezone } from "../tennisData/timezoneMap";
import { applyMatchResult, computeFeatures, createPlayerState, type PlayerState } from "./features";
import { CUTOFF_MINUTES, DEFAULT_CUTOFF, type BackfillOptions, type BackfillSummary, type CutoffOption } from "./types";
import { createDatabaseCanonicalIngestionResolver } from "../identity/canonicalIngestionResolver.js";

type GameMargins = Array<{ player1Games: number; player2Games: number }>;

interface StoredMatchForFold {
  player1Id: string;
  player2Id: string;
  winnerId: string | null;
  cancelled: boolean;
  surface: Surface | null;
  scheduledStartAt: Date;
  gameMarginsPlayer1: GameMargins;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function chunkDateRange(dateStart: string, dateStop: string, chunkDays: number): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  let cursor = dateStart;
  while (cursor <= dateStop) {
    const chunkEnd = addDays(cursor, chunkDays - 1);
    chunks.push([cursor, chunkEnd > dateStop ? dateStop : chunkEnd]);
    cursor = addDays(chunkEnd > dateStop ? dateStop : chunkEnd, 1);
  }
  return chunks;
}

interface ScheduledStart {
  scheduledStartAt: Date;
  /** False when the venue's timezone couldn't be confidently resolved -- `scheduledStartAt` then
   * falls back to the fixture's date at UTC midnight, a documented and flagged fallback, never a
   * silent guess. Mirrors the live-fixtures path's `timeConfirmed` (`apiTennisProvider.ts`). */
  timeConfirmed: boolean;
}

/**
 * Resolves a fixture's real UTC scheduled start. `fixture.time` is the tournament venue's real
 * LOCAL wall-clock time, not UTC (see `timezoneMap.ts`'s header for the live evidence) -- this
 * reuses the exact same `resolveTournamentTimezone` + `combineDateTimeUtc` conversion the live
 * upcoming-fixtures path uses, so historical and live rows are computed identically. When the
 * venue's timezone can't be confidently resolved, or the provider gave no time at all, this
 * falls back to the fixture's date at UTC midnight with `timeConfirmed: false` -- a clearly
 * flagged fallback, never a silent guess.
 */
function toScheduledStart(fixture: HistoricalFixture): ScheduledStart {
  const timezone = resolveTournamentTimezone(fixture.tournamentName);
  const combined = combineDateTimeUtc(fixture.date, fixture.time ?? undefined, timezone);
  if (combined !== null) {
    return { scheduledStartAt: new Date(combined), timeConfirmed: true };
  }
  return { scheduledStartAt: new Date(`${fixture.date}T00:00:00.000Z`), timeConfirmed: false };
}

function gameShareFor(margins: GameMargins, forPlayer1: boolean): number | null {
  if (margins.length === 0) return null;
  let won = 0;
  let total = 0;
  for (const m of margins) {
    won += forPlayer1 ? m.player1Games : m.player2Games;
    total += m.player1Games + m.player2Games;
  }
  return total > 0 ? won / total : null;
}

function getOrCreateState(playerStates: Map<string, PlayerState>, playerId: string): PlayerState {
  let state = playerStates.get(playerId);
  if (!state) {
    state = createPlayerState();
    playerStates.set(playerId, state);
  }
  return state;
}

/**
 * Folds one already-decided match's result into both players' running state. Used for THREE
 * distinct cases that must all agree on the exact same logic: (1) a freshly-inserted match this
 * run, (2) a duplicate match this run already stored by an earlier run (still needs to inform
 * this run's in-memory state), and (3) hydration -- replaying a player's entire prior real
 * history from the database at the start of a run, so a later run always continues from full
 * history rather than cold-starting Elo/form at zero.
 */
function foldMatchIntoStates(playerStates: Map<string, PlayerState>, match: StoredMatchForFold): void {
  if (match.cancelled || match.winnerId === null) return;

  const state1 = getOrCreateState(playerStates, match.player1Id);
  const state2 = getOrCreateState(playerStates, match.player2Id);

  const player1Won = match.winnerId === match.player1Id;
  const gameShare1 = gameShareFor(match.gameMarginsPlayer1, true);
  const gameShare2 = gameShare1 === null ? null : 1 - gameShare1;

  const preMatchElo1 = state1.eloOverall;
  const preMatchElo2 = state2.eloOverall;
  const preMatchEloSurface1 = match.surface ? (state1.eloBySurface[match.surface] ?? null) : null;
  const preMatchEloSurface2 = match.surface ? (state2.eloBySurface[match.surface] ?? null) : null;

  applyMatchResult(state1, preMatchElo2, preMatchEloSurface2, match.scheduledStartAt, match.surface, player1Won, gameShare1);
  applyMatchResult(state2, preMatchElo1, preMatchEloSurface1, match.scheduledStartAt, match.surface, !player1Won, gameShare2);
}

/**
 * Rebuilds every player's running feature state strictly from matches already stored in the
 * database with `scheduledStartAt < beforeTimestamp`, replayed in the same chronological order
 * they originally happened. This is what makes the pipeline safe to run incrementally in
 * separate process invocations: a later run never cold-starts a player's Elo/form history just
 * because it happens to run in a new process.
 */
async function hydratePlayerStates(beforeTimestamp: Date): Promise<Map<string, PlayerState>> {
  const playerStates = new Map<string, PlayerState>();

  const priorMatches = await db
    .select({
      id: historicalMatchesTable.id,
      player1Id: historicalMatchesTable.player1Id,
      player2Id: historicalMatchesTable.player2Id,
      winnerId: historicalMatchesTable.winnerId,
      cancelled: historicalMatchesTable.cancelled,
      surface: historicalMatchesTable.surface,
      scheduledStartAt: historicalMatchesTable.scheduledStartAt,
      gameMarginsPlayer1: historicalMatchesTable.gameMarginsPlayer1,
    })
    .from(historicalMatchesTable)
    .where(lt(historicalMatchesTable.scheduledStartAt, beforeTimestamp))
    .orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));

  for (const row of priorMatches) {
    foldMatchIntoStates(playerStates, {
      player1Id: row.player1Id,
      player2Id: row.player2Id,
      winnerId: row.winnerId,
      cancelled: row.cancelled,
      surface: row.surface as Surface | null,
      scheduledStartAt: row.scheduledStartAt,
      gameMarginsPlayer1: (row.gameMarginsPlayer1 as GameMargins) ?? [],
    });
  }

  logger.info({ beforeTimestamp, priorMatchCount: priorMatches.length, playersHydrated: playerStates.size }, "Hydrated player state from stored history");
  return playerStates;
}

/**
 * Runs a leak-proof historical backfill over [dateStart, dateStop]. Matches are fetched in
 * chronological chunks and processed strictly in ascending (date, time, externalId) order so
 * that every player's running state (Elo, recent form, ...) used to build match N's snapshot
 * contains only matches strictly before match N -- never match N itself, and never anything
 * later. Idempotent: matches already present (by provider + externalId) are skipped, but their
 * presence does not update the in-memory state for THIS run (the fully-reprocessed run always
 * derives features fresh); re-running a fully-imported range is a safe no-op other than
 * refreshing the summary.
 */
export async function runHistoricalBackfill(
  provider: TennisDataProvider,
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const startedAt = Date.now();
  const cutoff = options.cutoff ?? DEFAULT_CUTOFF;
  if (!(cutoff in CUTOFF_MINUTES)) {
    throw new Error(`Invalid cutoff "${cutoff}". Must be one of: ${Object.keys(CUTOFF_MINUTES).join(", ")}`);
  }
  const cutoffMinutes = CUTOFF_MINUTES[cutoff as CutoffOption];

  // Provider is known (verified live 2026-07-11) to return HTTP 500 on ~2-week+ windows during
  // busy periods -- payloads for even a single week can run into the tens of megabytes. 5 days
  // is a safe default; callers can override for known-sparser historical periods.
  const chunkDays = options.chunkDays ?? 5;
  if (!Number.isInteger(chunkDays) || chunkDays < 1) {
    throw new Error(`Invalid chunkDays "${options.chunkDays}". Must be a positive integer.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.dateStart) || Number.isNaN(Date.parse(options.dateStart))) {
    throw new Error(`Invalid dateStart "${options.dateStart}". Must be YYYY-MM-DD.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.dateStop) || Number.isNaN(Date.parse(options.dateStop))) {
    throw new Error(`Invalid dateStop "${options.dateStop}". Must be YYYY-MM-DD.`);
  }
  if (options.dateStart > options.dateStop) {
    throw new Error(`dateStart (${options.dateStart}) must not be after dateStop (${options.dateStop}).`);
  }

  const chunks = chunkDateRange(options.dateStart, options.dateStop, chunkDays);

  const summary: BackfillSummary = {
    dateStart: options.dateStart,
    dateStop: options.dateStop,
    cutoff,
    cutoffMinutes,
    fixturesFetched: 0,
    matchesInserted: 0,
    matchesRecomputed: 0,
    matchesSkippedDuplicate: 0,
    matchesSkippedNoTerminalResult: 0,
    matchesSkippedBadData: 0,
    featureRowsInserted: 0,
    byTour: {},
    bySurface: {},
    byYear: {},
    earliestImportedMatchDate: null,
    latestImportedMatchDate: null,
    dateGapsOver30Days: [],
    durationMs: 0,
  };

  const identityResolver = await createDatabaseCanonicalIngestionResolver(`historical-backfill:${provider.name}`);

  // Hydrate from everything already stored strictly before this run's window -- this is what
  // makes running the pipeline across multiple separate process invocations safe: a run started
  // fresh never cold-starts a continuing player's Elo/form history.
  const runWindowStart = new Date(`${options.dateStart}T00:00:00.000Z`);
  const playerStates = await hydratePlayerStates(runWindowStart);

  for (const [chunkStart, chunkEnd] of chunks) {
    logger.info({ chunkStart, chunkEnd }, "Fetching historical fixtures chunk");
    const fixtures = await provider.getCompletedMatchesByDateRange(chunkStart, chunkEnd);
    summary.fixturesFetched += fixtures.length;

    // Resolve each fixture's real scheduled start once (timezone resolution is pure per
    // fixture, but no need to redo it repeatedly across the sort comparator and the insert path
    // below).
    const withSchedule = fixtures.map((fixture) => ({ fixture, schedule: toScheduledStart(fixture) }));

    // Sort ascending within the chunk; chunks themselves are already non-overlapping and in
    // ascending order, so this guarantees a fully correct global chronological pass.
    const sorted = [...withSchedule].sort((a, b) => {
      const aStart = a.schedule.scheduledStartAt.getTime();
      const bStart = b.schedule.scheduledStartAt.getTime();
      if (aStart !== bStart) return aStart - bStart;
      return a.fixture.id.localeCompare(b.fixture.id);
    });

    for (const { fixture, schedule } of sorted) {
      await Promise.all([
        identityResolver.resolve({
          provider: fixture.provider,
          externalPlayerId: fixture.player1Id,
          externalPlayerName: fixture.player1Name,
          metadata: { tour: fixture.tour, tournamentNames: fixture.tournamentName ? [fixture.tournamentName] : [] },
        }),
        identityResolver.resolve({
          provider: fixture.provider,
          externalPlayerId: fixture.player2Id,
          externalPlayerName: fixture.player2Name,
          metadata: { tour: fixture.tour, tournamentNames: fixture.tournamentName ? [fixture.tournamentName] : [] },
        }),
      ]);
      if (!fixture.cancelled && fixture.winnerId === null) {
        summary.matchesSkippedNoTerminalResult += 1;
        continue;
      }

      // Skip fixtures where both players resolve to the same ID — corrupt source data (a player
      // cannot play themselves). This most commonly happens when two Sackmann entries share an
      // abbreviated name and get collapsed by identity resolution.  Inserting such a fixture would
      // produce duplicate (matchId, playerId, featureName) snapshot rows, violating the unique
      // constraint.
      if (fixture.player1Id === fixture.player2Id) {
        logger.warn({ externalId: fixture.id, playerId: fixture.player1Id }, "backfill: skipping same-player fixture (bad data)");
        summary.matchesSkippedBadData += 1;
        continue;
      }

      const [existing] = await db
        .select({
          id: historicalMatchesTable.id,
          winnerId: historicalMatchesTable.winnerId,
          cancelled: historicalMatchesTable.cancelled,
          surface: historicalMatchesTable.surface,
          scheduledStartAt: historicalMatchesTable.scheduledStartAt,
          cutoffAt: historicalMatchesTable.cutoffAt,
          gameMarginsPlayer1: historicalMatchesTable.gameMarginsPlayer1,
        })
        .from(historicalMatchesTable)
        .where(and(eq(historicalMatchesTable.provider, fixture.provider), eq(historicalMatchesTable.externalId, fixture.id)));

      if (existing && options.recompute) {
        // Recompute mode (Task #73): purge this fixture's stored row, its feature snapshots, and
        // any `historical_test` evaluation_predictions pointing at it, then fall through to the
        // normal insert path below so it's rebuilt fresh -- through the exact same
        // timezone-aware `toScheduledStart` + `computeFeatures` logic a brand-new fixture uses.
        // Not folded into playerStates here; the freshly-inserted row folds it in below instead.
        await db.delete(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.historicalMatchId, existing.id));
        await db.delete(matchFeatureSnapshotsTable).where(eq(matchFeatureSnapshotsTable.matchId, existing.id));
        await db.delete(historicalMatchesTable).where(eq(historicalMatchesTable.id, existing.id));
        summary.matchesRecomputed += 1;
      } else if (existing) {
        // Defense in depth: match row + its feature snapshots are written in one DB transaction
        // (see below), so a match can never legitimately exist without exactly the feature
        // snapshots that WOULD be computed for it right now, given the identical running state.
        // Because we process strictly in chronological order and playerStates has already been
        // folded up through every match before this one (via hydration + this run's own earlier
        // matches), computeFeatures() on that exact state reproduces exactly what the pipeline
        // computed at import time -- not a heuristic, the same function the insert path uses. If
        // the persisted count doesn't match, that's real data loss (e.g. a row from before this
        // transaction was introduced); fail fast rather than silently treating it as a normal
        // duplicate, which would permanently lose the mismatch with no repair path.
        if (!existing.cancelled && existing.winnerId !== null) {
          const state1 = getOrCreateState(playerStates, fixture.player1Id);
          const state2 = getOrCreateState(playerStates, fixture.player2Id);
          const surface = existing.surface as Surface | null;
          const expectedCount =
            computeFeatures(state1, surface).filter((f) => f.sourceTimestamp.getTime() < existing.cutoffAt.getTime()).length +
            computeFeatures(state2, surface).filter((f) => f.sourceTimestamp.getTime() < existing.cutoffAt.getTime()).length;

          if (expectedCount > 0) {
            const [row] = await db
              .select({ count: sql<number>`count(*)::int` })
              .from(matchFeatureSnapshotsTable)
              .where(eq(matchFeatureSnapshotsTable.matchId, existing.id));
            if ((row?.count ?? 0) !== expectedCount) {
              throw new Error(
                `Data integrity violation: historical match id=${existing.id} (provider=${fixture.provider}, externalId=${fixture.id}) ` +
                  `has ${row?.count ?? 0} feature snapshot(s) stored but ${expectedCount} expected from its players' running state at ` +
                  `import time. This should be impossible given transactional writes -- investigate and repair (e.g. delete the ` +
                  `orphaned match row so it can be re-imported) before continuing.`,
              );
            }
          }
        }

        summary.matchesSkippedDuplicate += 1;
        // Already stored (by this run or an earlier one) -- don't re-insert or re-snapshot, but
        // DO fold it into this run's in-memory state so later matches in this same run still see
        // it, matching what hydration would have done had this row existed before the run started.
        foldMatchIntoStates(playerStates, {
          player1Id: fixture.player1Id,
          player2Id: fixture.player2Id,
          winnerId: existing.winnerId,
          cancelled: existing.cancelled,
          surface: existing.surface as Surface | null,
          scheduledStartAt: existing.scheduledStartAt,
          gameMarginsPlayer1: (existing.gameMarginsPlayer1 as GameMargins) ?? [],
        });
        continue;
      }

      const { scheduledStartAt, timeConfirmed: scheduledStartTimeConfirmed } = schedule;
      const cutoffAt = new Date(scheduledStartAt.getTime() - cutoffMinutes * 60_000);

      const state1 = getOrCreateState(playerStates, fixture.player1Id);
      const state2 = getOrCreateState(playerStates, fixture.player2Id);

      const features1 = computeFeatures(state1, fixture.surface);
      const features2 = computeFeatures(state2, fixture.surface);

      const featureRows = [
        ...features1.map((f) => ({ playerId: fixture.player1Id, ...f })),
        ...features2.map((f) => ({ playerId: fixture.player2Id, ...f })),
      ]
        // Defense in depth: never write a feature whose own source timestamp fails its cutoff
        // check, even though computeFeatures() only ever draws from strictly-earlier matches.
        .filter((f) => f.sourceTimestamp.getTime() < cutoffAt.getTime())
        // Defense in depth: deduplicate on (playerId, featureName) so that if player1Id ===
        // player2Id somehow slips through (should be caught above), we don't violate the unique
        // constraint on match_feature_snapshots.
        .filter((f, i, arr) => arr.findIndex((g) => g.playerId === f.playerId && g.featureName === f.featureName) === i);

      // The match row and ALL of its frozen feature snapshots must land together or not at all --
      // otherwise a process failure between the two inserts would leave an orphaned match with no
      // snapshots, and the idempotency check above would treat it as already-imported forever,
      // silently and permanently losing that match's features with no repair path.
      await db.transaction(async (tx) => {
        const [insertedMatch] = await tx
          .insert(historicalMatchesTable)
          .values({
            externalId: fixture.id,
            provider: fixture.provider,
            tour: fixture.tour,
            tournamentName: fixture.tournamentName,
            tournamentLevel: fixture.tournamentLevel,
            surface: fixture.surface,
            round: fixture.round,
            matchFormat: fixture.matchFormat,
            player1Id: fixture.player1Id,
            player1Name: fixture.player1Name,
            player2Id: fixture.player2Id,
            player2Name: fixture.player2Name,
            winnerId: fixture.winnerId,
            score: fixture.score,
            retired: fixture.retired,
            walkover: fixture.walkover,
            cancelled: fixture.cancelled,
            scheduledStartAt,
            scheduledStartTimeConfirmed,
            cutoffMinutes,
            cutoffAt,
            gameMarginsPlayer1: fixture.setGameMargins,
            indoor: fixture.indoor,
            player1Rank: fixture.player1Rank,
            player2Rank: fixture.player2Rank,
            rawSource: fixture.raw as object,
          })
          .returning({ id: historicalMatchesTable.id });

        if (featureRows.length > 0) {
          await tx.insert(matchFeatureSnapshotsTable).values(
            featureRows.map((f) => ({
              matchId: insertedMatch.id,
              playerId: f.playerId,
              featureName: f.featureName,
              featureValue: f.featureValue,
              sourceTimestamp: f.sourceTimestamp,
              matchCutoffAt: cutoffAt,
              existedBeforeCutoff: true,
            })),
          );
        }
      });

      summary.matchesInserted += 1;
      summary.featureRowsInserted += featureRows.length;
      summary.byTour[fixture.tour ?? "Unknown"] = (summary.byTour[fixture.tour ?? "Unknown"] ?? 0) + 1;
      summary.bySurface[fixture.surface ?? "Unknown"] = (summary.bySurface[fixture.surface ?? "Unknown"] ?? 0) + 1;
      summary.byYear[fixture.date.slice(0, 4)] = (summary.byYear[fixture.date.slice(0, 4)] ?? 0) + 1;
      if (!summary.earliestImportedMatchDate || fixture.date < summary.earliestImportedMatchDate) {
        summary.earliestImportedMatchDate = fixture.date;
      }
      if (!summary.latestImportedMatchDate || fixture.date > summary.latestImportedMatchDate) {
        summary.latestImportedMatchDate = fixture.date;
      }

      // Only now, after both snapshots are captured and written, fold this match's own result
      // into each player's running state so it can inform LATER matches (this run's, or a
      // future run's -- via hydration).
      foldMatchIntoStates(playerStates, {
        player1Id: fixture.player1Id,
        player2Id: fixture.player2Id,
        winnerId: fixture.winnerId,
        cancelled: fixture.cancelled,
        surface: fixture.surface,
        scheduledStartAt,
        gameMarginsPlayer1: fixture.setGameMargins,
      });
    }
  }

  summary.durationMs = Date.now() - startedAt;

  // Detect gaps > 30 days across the FULL historical_matches store (not just this run's window)
  // so the summary gives a complete picture of coverage health every time it's checked.
  summary.dateGapsOver30Days = await detectStoredDateGaps();

  logger.info({ summary }, "Historical backfill complete");

  // Refresh the player stats cache for every player whose match history changed this run.
  // Done after the full run (not per-chunk) so each player is processed exactly once even
  // when they appear across multiple chunks. Non-blocking: failures are logged, not rethrown.
  const affectedPlayerIds = Array.from(playerStates.keys());
  if (affectedPlayerIds.length > 0) {
    logger.info({ playerCount: affectedPlayerIds.length }, "Refreshing player stats cache after backfill");
    // Imported lazily to avoid a circular-dependency risk with the backfill's own imports.
    const { refreshPlayerStats } = await import("../playerStats/compute");
    await refreshPlayerStats(affectedPlayerIds).catch((err) =>
      logger.warn({ err }, "Player stats refresh after backfill failed — stats may be stale"),
    );
  }

  return summary;
}

/** YYYY-MM-DD for `date`, in UTC. */
function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Scans the full `historical_matches` store for consecutive date gaps exceeding 30 days.
 * Returns one entry per gap, sorted chronologically. An empty array means coverage is
 * contiguous (or the table is empty). At most ~3,650 distinct dates for a decade of
 * data, so loading them into memory is fine -- no full table scan needed.
 */
async function detectStoredDateGaps(): Promise<Array<{ fromDate: string; toDate: string; dayCount: number }>> {
  const dateRows = await db
    .select({ matchDate: sql<string>`(scheduled_start_at AT TIME ZONE 'UTC')::date::text` })
    .from(historicalMatchesTable)
    .groupBy(sql`(scheduled_start_at AT TIME ZONE 'UTC')::date`)
    .orderBy(sql`(scheduled_start_at AT TIME ZONE 'UTC')::date`);

  const gaps: Array<{ fromDate: string; toDate: string; dayCount: number }> = [];
  for (let i = 1; i < dateRows.length; i++) {
    const fromDate = dateRows[i - 1].matchDate;
    const toDate = dateRows[i].matchDate;
    const dayCount = Math.round(
      (Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) / (24 * 60 * 60 * 1000),
    );
    if (dayCount > 30) gaps.push({ fromDate, toDate, dayCount });
  }
  return gaps;
}

/**
 * The most recent `scheduledStartAt` date already stored in `historical_matches`, as YYYY-MM-DD,
 * or null if the table is empty (a fresh environment that has never had an initial backfill run).
 * This is the single source of truth for "how far the canonical historical record reaches" --
 * used both to pick up an incremental run where the last one left off, and to surface staleness
 * to a person (Task #144) rather than requiring them to notice a stale record silently.
 */
export async function getLatestCoveredMatchDate(): Promise<string | null> {
  const [row] = await db
    .select({ scheduledStartAt: historicalMatchesTable.scheduledStartAt })
    .from(historicalMatchesTable)
    .orderBy(desc(historicalMatchesTable.scheduledStartAt))
    .limit(1);
  return row ? toDateStr(row.scheduledStartAt) : null;
}

export interface IncrementalBackfillResult {
  /** True when there was nothing new to fetch (already caught up through yesterday). `summary` is null in that case. */
  skipped: boolean;
  /** Why the run was skipped, only set when `skipped` is true. */
  skippedReason?: string;
  summary: BackfillSummary | null;
}

/**
 * Self-advancing wrapper around `runHistoricalBackfill` (Task #144): instead of a person having
 * to remember to re-run the CLI with new `--start`/`--stop` dates, this picks up the day right
 * after whatever `historical_matches` currently covers and extends forward through yesterday
 * (UTC) -- "yesterday" rather than "today" because a match scheduled today may not have a
 * terminal result yet, and the pipeline already skips/no-ops non-terminal fixtures anyway, so
 * stopping at yesterday avoids repeatedly re-fetching today's still-in-progress date until it's
 * actually finished. Chunking above the provider's known window limit is already handled inside
 * `runHistoricalBackfill` (`chunkDays`), so an arbitrarily long gap (e.g. after this job hasn't
 * run in a while) is still fetched safely in bounded windows.
 *
 * Requires `historical_matches` to already have at least one row -- this is an incremental
 * *advance*, not a substitute for the initial one-off backfill (out of scope per Task #144: "no
 * backfilling further into the past than what's already covered"). On a genuinely empty table,
 * this throws rather than guessing an arbitrary start date.
 */
export async function runIncrementalHistoricalBackfill(
  provider: TennisDataProvider,
  options?: { cutoff?: CutoffOption; chunkDays?: number },
): Promise<IncrementalBackfillResult> {
  const latestCovered = await getLatestCoveredMatchDate();
  if (!latestCovered) {
    throw new Error(
      "historical_matches is empty -- run the initial one-off backfill manually first " +
        "(pnpm --filter @workspace/api-server run backfill -- --start YYYY-MM-DD --stop YYYY-MM-DD) " +
        "before relying on the incremental job to advance it.",
    );
  }

  const dateStart = addDays(latestCovered, 1);
  const dateStop = toDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));

  if (dateStart > dateStop) {
    return {
      skipped: true,
      skippedReason: `Already caught up through ${latestCovered}; nothing new before ${dateStop} to fetch yet.`,
      summary: null,
    };
  }

  const summary = await runHistoricalBackfill(provider, {
    dateStart,
    dateStop,
    cutoff: options?.cutoff,
    chunkDays: options?.chunkDays,
  });
  return { skipped: false, summary };
}
