/**
 * Post-import bridge: re-resolves ext-{tour}-{id} (and legacy ext-{id}) player slots in
 * historical_matches to existing Sackmann / API-Tennis IDs using surname + first-initial
 * disambiguation.
 *
 * Why this is needed:
 *   The initial CSV import uses surname-only matching and falls back to "ext-{tour}-{id}"
 *   when a surname appears for multiple players (e.g. "Murray" → Andy + Jamie). That results
 *   in ~89% unresolved IDs and broken Elo chains across year boundaries.
 *
 * Cross-tour safety:
 *   ATP and WTA CSVs share the same numeric player-ID namespace. To prevent a WTA player
 *   "ext-12345" from being conflated with an ATP player "ext-12345", every slot is keyed by
 *   (ext_id, tour) throughout — in the query, the resolution map, and both UPDATE statements.
 *   New imports produce "ext-atp-{id}" / "ext-wta-{id}" fallbacks; legacy "ext-{id}" rows
 *   are handled by also filtering on h.tour in the UPDATE.
 *
 * Atomicity:
 *   All four UPDATE statements (player1_id, player2_id, winner_id in historical_matches plus
 *   player_id in match_feature_snapshots) run inside a single database transaction. If any
 *   statement fails the entire migration rolls back, leaving no partially-updated rows. Because
 *   the mutation is idempotent-by-design (ext-{…} IDs that were replaced are gone; a retry
 *   skips those slots automatically), a safe re-run after any failure is always possible.
 *
 * This bridge:
 *   1. Scans historical_matches WHERE provider='ext-csv' for rows with ext-{…} player IDs,
 *      collecting unique (ext_id, tour) slots.
 *   2. Builds an enhanced index from all NON-ext-csv rows: surname+initial → [{id, name}].
 *   3. For each unique (ext_id, tour, stored_name) slot, tries:
 *        a. Exact surname + first-initial → unique match = resolved
 *        b. Surname-only if globally unambiguous = resolved
 *        c. Otherwise: stays as ext-{…}
 *   4. Runs all UPDATEs atomically inside a single transaction so a mid-migration failure
 *      never leaves split player identities.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { createDatabaseCanonicalIngestionResolver } from "../identity/canonicalIngestionResolver.js";

// ── Name-parsing helpers ──────────────────────────────────────────────────────

/**
 * Parse a DB-stored player name (expected format "First [Middle] Last") into
 * surname key and first initial.
 * "Novak Djokovic"              → { surname: "djokovic",          initial: "n" }
 * "Alejandro Davidovich Fokina" → { surname: "davidovich fokina", initial: "a" }
 * "Barbora Krejcikova"          → { surname: "krejcikova",        initial: "b" }
 */
function dbNameParts(name: string): { surname: string; initial: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { surname: "", initial: "" };
  if (words.length === 1) {
    return { surname: words[0].toLowerCase(), initial: words[0][0]?.toLowerCase() ?? "" };
  }
  return {
    initial: words[0][0]?.toLowerCase() ?? "",
    surname: words.slice(1).join(" ").toLowerCase(),
  };
}

/**
 * Parse a CSV abbreviated name (format "Last F." or "Compound Last F.") into
 * surname key and first initial.
 * "Djokovic N."          → { surname: "djokovic",          initial: "n" }
 * "Davidovich Fokina A." → { surname: "davidovich fokina", initial: "a" }
 * "De Minaur A."         → { surname: "de minaur",         initial: "a" }
 * "Osaka"                → { surname: "osaka",             initial: null }
 */
export function csvNameParts(name: string): { surname: string; initial: string | null } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { surname: "", initial: null };
  if (words.length === 1) return { surname: words[0].toLowerCase(), initial: null };

  const lastToken = words[words.length - 1];
  // Treat as initial when: single letter, optionally with trailing dot
  if (/^[A-Za-z]\.?$/.test(lastToken)) {
    return {
      surname: words.slice(0, -1).join(" ").toLowerCase(),
      initial: lastToken.replace(".", "").toLowerCase(),
    };
  }
  // No initial found — full string is the name (edge case)
  return { surname: name.trim().toLowerCase(), initial: null };
}

// ── Enhanced player ID map ────────────────────────────────────────────────────

type PlayerEntry = { id: string; name: string };
export type EnhancedPlayerIdMap = {
  /**
   * Keys are "${TOUR}:${surname}|${initial}" (e.g. "ATP:alcaraz|c").
   * Tour-scoped so an ATP "C. Smith" and a WTA "C. Smith" never occupy the
   * same bucket and can both be resolved unambiguously.
   * Unique entry = unambiguous match within that tour.
   */
  byInitial: Map<string, PlayerEntry[]>;
  /**
   * Keys are "${TOUR}:${surname}" (e.g. "ATP:osaka").
   * Used as fallback when the slot name carries no initial.
   */
  bySurname: Map<string, PlayerEntry[]>;
};

function addToMap<K>(map: Map<K, PlayerEntry[]>, key: K, entry: PlayerEntry): void {
  if (!map.has(key)) map.set(key, []);
  const bucket = map.get(key)!;
  if (!bucket.some(e => e.id === entry.id)) bucket.push(entry);
}

/**
 * Infer a provider bucket from a player ID string.
 * Exported for testing; used as a tiebreaker when selecting which ID to
 * keep after a verified-safe collapse.
 */
export function idProviderBucket(id: string): string {
  if (/^\d+$/.test(id)) return "api-tennis";
  if (id.startsWith("sackmann-")) return "sackmann";
  if (id.startsWith("tennis-data-co-uk-")) return "tennis-data-co-uk";
  return "other";
}

/**
 * Returns true if the player name's first word is an abbreviated initial
 * (a single letter, optionally followed by a dot): "C. Alcaraz", "N.".
 * Returns false when the first word is a full first name: "Carlos", "Novak".
 */
export function isAbbreviatedFirstName(name: string): boolean {
  const firstWord = name.trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-z]\.?$/.test(firstWord);
}

/**
 * Lowercase, remove punctuation except spaces, collapse whitespace.
 * Used to compare two full names from different providers for identity.
 */
function normalizeFullName(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Collapse verified cross-provider duplicate entries in `byInitial`.
 *
 * The same physical player frequently appears under multiple provider IDs.
 * The classic example: "C. Alcaraz" (API-Tennis id 2382, abbreviated first
 * name) and "Carlos Alcaraz" (Sackmann id sackmann-207989, full first name)
 * both parse to "ATP:alcaraz|c", creating two entries that block resolution.
 *
 * **Identity verification rule** — a bucket is collapsed only when there is
 * unambiguous name-structure evidence that all entries refer to the same person:
 *
 *   A. Exactly one entry has a **full first name** (not abbreviated) and every
 *      other entry has an abbreviated initial.  The abbreviated entries are
 *      consistent with the full name by construction (same key = same initial),
 *      so this is a safe merge.
 *
 *   B. All entries have **full first names** that normalize to the exact same
 *      string (e.g. "Carlos Alcaraz" from Sackmann and tennis-data-co-uk).
 *      Identical full names from independent sources are overwhelmingly the
 *      same player.
 *
 * Buckets that do **not** satisfy A or B are left unchanged:
 *   - All abbreviated initials → cannot verify identity without a full name.
 *   - Multiple distinct full names (e.g. "John Smith" vs "James Smith") →
 *     genuinely different players that happen to share surname and initial.
 *     Provider diversity is NOT identity proof; such buckets must stay
 *     ambiguous so the resolver correctly returns null.
 *
 * Because keys are already tour-scoped ("ATP:…" vs "WTA:…"), this function
 * never merges an ATP player into a WTA bucket.
 *
 * Exported so tests can construct maps directly and verify the collapse logic
 * without a live database.
 */
export function collapseByInitialDuplicates(byInitial: Map<string, PlayerEntry[]>): void {
  for (const [key, entries] of byInitial) {
    if (entries.length <= 1) continue;

    const fullNameEntries = entries.filter(e => !isAbbreviatedFirstName(e.name));
    const abbrevEntries   = entries.filter(e =>  isAbbreviatedFirstName(e.name));

    // Rule A: exactly one full first name, rest abbreviated.
    // The abbreviated entries are already constrained to the same initial by
    // the map key, so they are consistent with the full name.
    const ruleA = fullNameEntries.length === 1;

    // Rule B: every entry has a full first name AND they all normalize to the
    // same string (e.g. "Carlos Alcaraz" from two different providers).
    const ruleB =
      fullNameEntries.length > 1 &&
      abbrevEntries.length === 0 &&
      new Set(fullNameEntries.map(e => normalizeFullName(e.name))).size === 1;

    if (!ruleA && !ruleB) continue;

    // Prefer numeric (API-Tennis) IDs → Sackmann → others.
    const preferred =
      entries.find(e => /^\d+$/.test(e.id)) ??
      entries.find(e => e.id.startsWith("sackmann-")) ??
      entries[0];
    byInitial.set(key, [preferred]);
  }
}

/**
 * Build the enhanced map from all non-ext-csv historical_matches rows.
 * One DB round-trip; keys are tour-scoped ("ATP:alcaraz|c", "WTA:osaka|n").
 */
async function buildEnhancedPlayerIdMap(): Promise<EnhancedPlayerIdMap> {
  const byInitial = new Map<string, PlayerEntry[]>();
  const bySurname = new Map<string, PlayerEntry[]>();

  const result = await db.execute(sql`
    SELECT player_id, player_name, tour FROM (
      SELECT DISTINCT player1_id AS player_id, player1_name AS player_name,
             UPPER(COALESCE(tour, '')) AS tour
        FROM historical_matches
       WHERE player1_name IS NOT NULL AND player1_name != ''
         AND provider != 'ext-csv'
      UNION
      SELECT DISTINCT player2_id AS player_id, player2_name AS player_name,
             UPPER(COALESCE(tour, '')) AS tour
        FROM historical_matches
       WHERE player2_name IS NOT NULL AND player2_name != ''
         AND provider != 'ext-csv'
    ) sub
  `);

  for (const r of result.rows as Array<{ player_id: string; player_name: string; tour: string }>) {
    if (!r.player_id || !r.player_name) continue;
    const entry: PlayerEntry = { id: r.player_id, name: r.player_name };
    const { surname, initial } = dbNameParts(r.player_name);
    if (!surname) continue;
    const tourKey = r.tour; // already upper-cased by SQL UPPER()

    addToMap(bySurname, `${tourKey}:${surname}`, entry);
    if (initial) addToMap(byInitial, `${tourKey}:${surname}|${initial}`, entry);
  }

  // Collapse cross-provider duplicates now that keys are tour-scoped.
  // (ATP and WTA buckets are already separated so no cross-tour collapse
  // is possible.)
  collapseByInitialDuplicates(byInitial);

  return { byInitial, bySurname };
}

/**
 * Resolve a CSV player (stored name) to the best available real player ID.
 *
 * @param storedName - Player name as stored in the ext-csv row (e.g. "Alcaraz C.").
 * @param map        - Map built by buildEnhancedPlayerIdMap (tour-scoped keys).
 * @param tour       - Tour of the ext-csv slot ("ATP", "WTA", …).  Used to
 *                     scope the lookup so an ATP "C. Smith" and a WTA "C. Smith"
 *                     each resolve to their own correct player.
 *
 * Returns null if no unambiguous match was found within that tour.
 */
export function resolveCsvPlayerToRealId(
  storedName: string,
  map: EnhancedPlayerIdMap,
  tour: string,
): string | null {
  const { surname, initial } = csvNameParts(storedName);
  if (!surname) return null;
  const t = tour.toUpperCase();

  // 1. Try surname + initial (most specific — disambiguates Murray A./Murray J. etc.)
  if (initial) {
    const candidates = map.byInitial.get(`${t}:${surname}|${initial}`);
    if (candidates && candidates.length === 1) return candidates[0].id;
    // Multiple players share same tour + surname + initial → fall through
  }

  // 2. Surname-only fallback — only when unambiguous within this tour
  const surnameCandidates = map.bySurname.get(`${t}:${surname}`);
  if (surnameCandidates && surnameCandidates.length === 1) return surnameCandidates[0].id;

  return null;
}

// ── Bridge result type ────────────────────────────────────────────────────────

export interface ExtCsvBridgeResult {
  /** Total distinct (ext_id, tour) player slots found in ext-csv rows. */
  extPlayerSlotsFound: number;
  /** Slots resolved to a real Sackmann/API-Tennis ID. */
  resolved: number;
  /** Slots that remained ext-{…} (ambiguous or genuinely new players). */
  unresolved: number;
  /** historical_matches rows updated (p1 + p2 + winner combined). */
  matchRowsUpdated: number;
  /** match_feature_snapshots rows updated. */
  featureRowsUpdated: number;
  /** ATP main-draw player match rate 0–100, or null if no ATP rows. */
  atpMatchRate: number | null;
  /** WTA player match rate 0–100, or null if no WTA rows. */
  wtaMatchRate: number | null;
  /**
   * Unique historical_matches.id values (integers) that had at least one
   * player-ID column corrected by this bridge run.  Used by the route to
   * delete their stale evaluation_predictions so walk-forward re-scores them
   * with the corrected identities.
   */
  affectedMatchIds: number[];
}

// ── Resolution entry ──────────────────────────────────────────────────────────

/** One resolved mapping: an ext player slot → a canonical real player ID. */
export type ResolutionEntry = {
  extId: string;
  /** Tour of the match row that contained this player slot ("ATP", "WTA", etc.). */
  tour:  string;
  realId: string;
};

// ── SQL array helper ──────────────────────────────────────────────────────────

/**
 * Safely embed a list of plain text values as a PostgreSQL text[] literal.
 * Values are internal IDs/tour strings — no user-supplied input.
 */
function pgTextArray(values: string[]): string {
  return `ARRAY[${values.map(v => `'${v.replace(/'/g, "''")}'`).join(",")}]`;
}

// ── Transactional mutation (exported for testing) ─────────────────────────────

/**
 * A minimal subset of the drizzle `db` / transaction object that the mutation
 * needs. Typed narrowly so tests can inject a mock without importing drizzle.
 */
export interface DbLike {
  execute(query: unknown): Promise<{ rowCount?: number; rows?: Array<Record<string, unknown>> }>;
}

// ── Bridge refresh orchestration ─────────────────────────────────────────────

/**
 * Result of a bridge-triggered refresh cycle (clear + walk-forward scheduling).
 */
export interface BridgeRefreshCycleResult {
  /** Number of evaluation_predictions rows deleted. */
  affectedEvalRowsCleared: number;
  /** Whether a walk-forward job was successfully started. */
  walkForwardStarted: boolean;
  /**
   * Human-readable reason for not starting the job, or undefined when it started.
   * Possible values: "no_resolved_matches" | "walk_forward_already_running" |
   *   "clear_failed" | "already_running_at_start" | (job-specific reason string)
   */
  walkForwardSkipReason?: string;
}

/**
 * Orchestrate the bridge refresh cycle:
 *   1. If no matches were resolved, return early (no-op).
 *   2. If a walk-forward job is already running, return early WITHOUT deleting
 *      rows (the in-flight run pre-built its alreadyScoredIds before our
 *      bridge completed; deleting now would orphan those rows).
 *   3. Delete stale historical_test evaluation_predictions for the affected
 *      matches and await the result (must finish before step 4 is scheduled).
 *   4. Start walk-forward scoped to the affected matchIds.  evaluationOnly:true
 *      short-circuits the 500-match training minimum so even 1 corrected match
 *      is re-scored without triggering a full calibration refit.
 *   5. If clearPredictions throws, abort and surface the failure.
 *
 * All dependencies are injected so this function is unit-testable without an
 * Express route, a real DB, or a running walk-forward job.
 */
export async function orchestrateBridgeRefresh(opts: {
  affectedMatchIds: number[];
  resolved: number;
  db: DbLike;
  isJobRunning: () => boolean;
  clearPredictions: (db: DbLike, ids: number[]) => Promise<number>;
  startJob: (ids: number[]) => { started: boolean; reason?: string };
}): Promise<BridgeRefreshCycleResult> {
  if (opts.resolved === 0 || opts.affectedMatchIds.length === 0) {
    return {
      affectedEvalRowsCleared: 0,
      walkForwardStarted: false,
      walkForwardSkipReason: "no_resolved_matches",
    };
  }

  if (opts.isJobRunning()) {
    return {
      affectedEvalRowsCleared: 0,
      walkForwardStarted: false,
      walkForwardSkipReason: "walk_forward_already_running",
    };
  }

  // Safe window: idle → await deletion → synchronously claim job slot.
  // By the time the event loop next yields, deletion is committed and the
  // job's alreadyScoredIds query will see the post-deletion DB state.
  let affectedEvalRowsCleared = 0;
  try {
    affectedEvalRowsCleared = await opts.clearPredictions(opts.db, opts.affectedMatchIds);
  } catch {
    return {
      affectedEvalRowsCleared: 0,
      walkForwardStarted: false,
      walkForwardSkipReason: "clear_failed",
    };
  }

  const wfResult = opts.startJob(opts.affectedMatchIds);
  return {
    affectedEvalRowsCleared,
    walkForwardStarted: wfResult.started,
    walkForwardSkipReason: wfResult.started
      ? undefined
      : wfResult.reason ?? "already_running_at_start",
  };
}

/**
 * Delete stale `historical_test` evaluation_predictions for the given historical
 * match IDs.  Called after the bridge commits so walk-forward re-scores those
 * matches with the corrected player identities.
 *
 * Accepts a `DbLike` so tests can inject a mock without importing drizzle.
 *
 * @returns number of rows deleted.
 */
export async function clearAffectedEvalPredictions(
  dbLike: DbLike,
  matchIds: number[],
): Promise<number> {
  if (matchIds.length === 0) return 0;
  // matchIds are SERIAL integers — safe to embed directly without quoting.
  const result = await dbLike.execute(
    sql.raw(`
      DELETE FROM evaluation_predictions
       WHERE historical_match_id = ANY(ARRAY[${matchIds.join(",")}]::int[])
         AND run_kind = 'historical_test'
    `),
  );
  return (result as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Execute all four UPDATE statements that constitute the identity migration.
 *
 * All statements run through the same `tx` connection; callers must wrap this
 * in `db.transaction()` so a failure in any statement rolls back the others.
 *
 * Each of the three historical_matches UPDATEs uses `RETURNING h.id` to
 * collect the match IDs that were actually changed.  The caller uses those IDs
 * to clear stale evaluation_predictions so walk-forward re-scores the affected
 * matches with the corrected player identities.
 *
 * Exported so tests can inject a mock `tx` and verify atomicity without a real DB.
 */
export async function runBridgeMigration(
  tx: DbLike,
  entries: ResolutionEntry[],
): Promise<{ p1Rows: number; p2Rows: number; winRows: number; featureRowsUpdated: number; affectedMatchIds: number[] }> {
  if (entries.length === 0) return { p1Rows: 0, p2Rows: 0, winRows: 0, featureRowsUpdated: 0, affectedMatchIds: [] };

  const extIds  = entries.map(e => e.extId);
  const tours   = entries.map(e => e.tour);
  const realIds = entries.map(e => e.realId);

  /** UPDATE one player-ID column, returning the IDs of all touched match rows. */
  function matchUpdate(column: string): string {
    return `
      UPDATE historical_matches AS h
         SET ${column} = m.real_id
        FROM (
               SELECT unnest(${pgTextArray(extIds)})  AS ext_id,
                      unnest(${pgTextArray(tours)})   AS tour,
                      unnest(${pgTextArray(realIds)}) AS real_id
             ) AS m
       WHERE h.provider  = 'ext-csv'
         AND h.${column} = m.ext_id
         AND h.tour      = m.tour
      RETURNING h.id
    `;
  }

  /** Extract positive integer match IDs from a RETURNING result. */
  function extractIds(result: unknown): number[] {
    const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    return rows.map(r => Number(r["id"])).filter(n => Number.isInteger(n) && n > 0);
  }

  // Run sequentially within the transaction — parallel execution inside a single
  // transaction offers no benefit and makes failure ordering harder to reason about.
  const p1Result  = await tx.execute(sql.raw(matchUpdate("player1_id")));
  const p2Result  = await tx.execute(sql.raw(matchUpdate("player2_id")));
  const winResult = await tx.execute(sql.raw(matchUpdate("winner_id")));

  // Collect unique match IDs from all three column updates.
  // (winner_id is always p1 or p2, but a prior partial run may have left only
  //  winner_id as ext-xxx, so collect from all three to be complete.)
  const idSet = new Set<number>([
    ...extractIds(p1Result),
    ...extractIds(p2Result),
    ...extractIds(winResult),
  ]);

  // Snapshot update joins through historical_matches to inherit the tour filter.
  const snapshotResult = await tx.execute(sql.raw(`
    UPDATE match_feature_snapshots AS f
       SET player_id = m.real_id
      FROM historical_matches AS h,
           (
             SELECT unnest(${pgTextArray(extIds)})  AS ext_id,
                    unnest(${pgTextArray(tours)})   AS tour,
                    unnest(${pgTextArray(realIds)}) AS real_id
           ) AS m
     WHERE f.match_id  = h.id
       AND f.player_id = m.ext_id
       AND h.tour      = m.tour
       AND h.provider  = 'ext-csv'
  `));

  return {
    p1Rows:            (p1Result  as unknown as { rowCount?: number }).rowCount  ?? 0,
    p2Rows:            (p2Result  as unknown as { rowCount?: number }).rowCount  ?? 0,
    winRows:           (winResult as unknown as { rowCount?: number }).rowCount  ?? 0,
    featureRowsUpdated:(snapshotResult as unknown as { rowCount?: number }).rowCount ?? 0,
    affectedMatchIds:  Array.from(idSet),
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the post-import bridge.
 *
 * Safe to run repeatedly — idempotent once all ext-{…} IDs have been replaced
 * (subsequent runs find no matching rows and the transaction is a no-op).
 */
export async function runExternalCsvBridge(): Promise<ExtCsvBridgeResult> {
  const identityResolver = await createDatabaseCanonicalIngestionResolver("external-csv-bridge");

  // ── Step 1: Collect unique (ext_id, tour) player slots ────────────────────
  const slotsResult = await db.execute(sql`
    SELECT DISTINCT slot_id, slot_name, tour
      FROM (
             SELECT player1_id   AS slot_id, player1_name AS slot_name, tour
               FROM historical_matches
              WHERE provider = 'ext-csv'
                AND player1_id LIKE 'ext-%'
                AND player1_id IS NOT NULL
                AND player1_name IS NOT NULL AND player1_name != ''
             UNION ALL
             SELECT player2_id, player2_name, tour
               FROM historical_matches
              WHERE provider = 'ext-csv'
                AND player2_id LIKE 'ext-%'
                AND player2_id IS NOT NULL
                AND player2_name IS NOT NULL AND player2_name != ''
           ) sub
  `);

  type SlotRow = { slot_id: string; slot_name: string; tour: string | null };
  const allSlots = slotsResult.rows as SlotRow[];

  // Deduplicate by (slot_id, tour) — ATP "ext-12345" and WTA "ext-12345" are separate slots
  const slotByKey = new Map<string, SlotRow>(); // key: `${tour}||${slot_id}`
  for (const row of allSlots) {
    const key = `${row.tour ?? ""}||${row.slot_id}`;
    if (!slotByKey.has(key)) slotByKey.set(key, row);
  }

  logger.info(
    { rawSlotRows: allSlots.length, uniqueSlots: slotByKey.size },
    "ext-csv-bridge: discovered ext-id player slots (keyed by ext_id+tour)",
  );

  // ── Step 2: Resolve each (ext_id, tour) slot ──────────────────────────────
  const resolutionEntries: ResolutionEntry[] = [];
  let atpResolved = 0; let atpTotal = 0;
  let wtaResolved = 0; let wtaTotal = 0;

  for (const slot of slotByKey.values()) {
    const isAtp = /^atp/i.test(slot.tour ?? "");
    const isWta = /^wta/i.test(slot.tour ?? "");
    if (isAtp) atpTotal++;
    else if (isWta) wtaTotal++;

    const resolution = await identityResolver.resolve({
      provider: "ext-csv",
      externalPlayerId: slot.slot_id,
      externalPlayerName: slot.slot_name,
      metadata: { tour: slot.tour ?? undefined },
    });
    if (resolution.canonicalPlayerId) {
      resolutionEntries.push({ extId: slot.slot_id, tour: slot.tour ?? "", realId: resolution.canonicalPlayerId });
      if (isAtp) atpResolved++;
      else if (isWta) wtaResolved++;
    }
  }

  const resolved    = resolutionEntries.length;
  const unresolved  = slotByKey.size - resolved;
  const overallRate = slotByKey.size > 0 ? Math.round((resolved / slotByKey.size) * 100) : 0;
  const atpRate     = atpTotal > 0 ? Math.round((atpResolved / atpTotal) * 100) : null;
  const wtaRate     = wtaTotal > 0 ? Math.round((wtaResolved / wtaTotal) * 100) : null;

  logger.info(
    {
      uniqueSlots:    slotByKey.size,
      resolved,
      unresolved,
      overallRatePct: `${overallRate}%`,
      atpResolved,    atpTotal,
      atpRatePct:     atpRate !== null ? `${atpRate}%` : "n/a",
      wtaResolved,    wtaTotal,
      wtaRatePct:     wtaRate !== null ? `${wtaRate}%` : "n/a",
    },
    "ext-csv-bridge: resolution complete",
  );

  if (resolutionEntries.length === 0) {
    logger.info("ext-csv-bridge: no resolutions found — already bridged or no ext-csv data");
    return {
      extPlayerSlotsFound: slotByKey.size,
      resolved: 0, unresolved,
      matchRowsUpdated: 0, featureRowsUpdated: 0,
      atpMatchRate: atpRate, wtaMatchRate: wtaRate,
      affectedMatchIds: [],
    };
  }

  // ── Step 3: Apply all updates atomically ──────────────────────────────────
  // All four statements run in a single transaction. If any fails the entire
  // migration rolls back — no partially-updated rows are ever committed.
  // RETURNING h.id on each match-column UPDATE gives us the IDs of rows that
  // were actually changed, so the caller can clear their stale eval predictions.
  const { p1Rows, p2Rows, winRows, featureRowsUpdated, affectedMatchIds } =
    await db.transaction(async (tx) => {
      return runBridgeMigration(tx as unknown as DbLike, resolutionEntries);
    });

  const matchRowsUpdated = p1Rows + p2Rows + winRows;

  logger.info(
    { p1Rows, p2Rows, winRows, matchRowsUpdated, featureRowsUpdated, affectedMatchCount: affectedMatchIds.length },
    "ext-csv-bridge: migration committed",
  );

  return {
    extPlayerSlotsFound: slotByKey.size,
    resolved, unresolved,
    matchRowsUpdated, featureRowsUpdated,
    atpMatchRate: atpRate, wtaMatchRate: wtaRate,
    affectedMatchIds,
  };
}
