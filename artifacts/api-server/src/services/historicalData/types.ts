/**
 * Configurable prediction cutoff: how long before a match's scheduled start the pre-match
 * feature snapshot is frozen. Anything timestamped at or after (scheduledStart - cutoff) is
 * ineligible for that match's snapshot. Default is 30 minutes -- late enough to capture
 * same-day news (withdrawals, last-minute lineup info) without risking any in-match leakage.
 */
export type CutoffOption = "24h" | "12h" | "6h" | "1h" | "30min" | "15min";

export const CUTOFF_MINUTES: Record<CutoffOption, number> = {
  "24h": 24 * 60,
  "12h": 12 * 60,
  "6h": 6 * 60,
  "1h": 60,
  "30min": 30,
  "15min": 15,
};

export const DEFAULT_CUTOFF: CutoffOption = "30min";

export interface BackfillOptions {
  /** Inclusive, YYYY-MM-DD. */
  dateStart: string;
  /** Inclusive, YYYY-MM-DD. */
  dateStop: string;
  cutoff?: CutoffOption;
  /** Size of each provider request window, in days. Provider is known to fail on ~month-long windows. */
  chunkDays?: number;
  /**
   * When true, a fixture that already has a stored row is NOT treated as a normal duplicate to
   * skip -- its existing row, feature snapshots, and any `historical_test` evaluation_predictions
   * pointing at it are purged first, then it's re-inserted fresh through the exact same
   * timezone-aware `toScheduledStart` + `computeFeatures` path a brand-new fixture would take.
   * This is the supported way to recompute previously-imported matches after a fix to how
   * `scheduledStartAt` (or any other stored/derived field) is computed -- e.g. Task #73's
   * venue-timezone fix -- without a separate one-off script or a manual DB wipe.
   */
  recompute?: boolean;
}

export interface BackfillSummary {
  dateStart: string;
  dateStop: string;
  cutoff: CutoffOption;
  cutoffMinutes: number;
  fixturesFetched: number;
  matchesInserted: number;
  /** Count of fixtures purged and rebuilt because `options.recompute` was set (Task #73). 0 outside recompute mode. */
  matchesRecomputed: number;
  matchesSkippedDuplicate: number;
  matchesSkippedNoTerminalResult: number;
  /** Fixtures skipped because player1Id === player2Id — corrupt source data (player can't play themselves). */
  matchesSkippedBadData: number;
  featureRowsInserted: number;
  byTour: Record<string, number>;
  bySurface: Record<string, number>;
  /** Match count by calendar year (YYYY), built from `fixture.date` of newly-inserted matches. */
  byYear: Record<string, number>;
  earliestImportedMatchDate: string | null;
  latestImportedMatchDate: string | null;
  /**
   * Date gaps of more than 30 days within the full historical_matches coverage detected at run
   * end. Each entry is a gap in the stored record — not necessarily in the provider's data (the
   * provider may simply have had no matches in that window). Empty when coverage is contiguous.
   */
  dateGapsOver30Days: Array<{ fromDate: string; toDate: string; dayCount: number }>;
  durationMs: number;
}
