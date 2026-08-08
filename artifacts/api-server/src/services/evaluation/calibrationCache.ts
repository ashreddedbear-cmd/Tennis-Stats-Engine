/**
 * Task #154: short-lived in-memory cache for the active calibration model.
 *
 * The active calibration row (a JSONB mapping blob) is fetched by every prediction call via
 * `db.select().from(calibrationModelsTable).where(active=true).limit(1)`. The model only
 * changes when the calibration-refit job runs (at most once every 2 hours by cooldown), so
 * caching it for 5 minutes is safe and zero-risk to accuracy — the cache will never serve
 * a stale model for long, and `invalidateCalibrationCache()` is called immediately on each
 * refit so the very first post-refit prediction always gets fresh data.
 */

import { db, calibrationModelsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { CalibrationKnotJson } from "@workspace/db";

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

interface CacheEntry {
  value: CalibrationKnotJson[] | null;
  /** The full DB row id, stored so the caller can write `activeCalibrationId`. */
  modelId: number | null;
  expiresAt: number;
}

let _cache: CacheEntry | null = null;

/**
 * Returns the currently-active calibration model's mapping (knots array), or null when no
 * model has ever been fitted.  Warm hits are served from memory in ~0 ms; cold misses hit the
 * DB once and then cache the result for 5 minutes.
 */
export async function getActiveCalibration(): Promise<{ mapping: CalibrationKnotJson[] | null; modelId: number | null }> {
  const now = Date.now();
  if (_cache && _cache.expiresAt > now) {
    return { mapping: _cache.value, modelId: _cache.modelId };
  }

  const [row] = await db
    .select({ id: calibrationModelsTable.id, mapping: calibrationModelsTable.mapping })
    .from(calibrationModelsTable)
    .where(eq(calibrationModelsTable.active, true))
    .limit(1);

  const entry: CacheEntry = {
    value: row?.mapping ?? null,
    modelId: row?.id ?? null,
    expiresAt: now + CACHE_TTL_MS,
  };
  _cache = entry;
  return { mapping: entry.value, modelId: entry.modelId };
}

/**
 * Immediately evicts the in-memory cache so the next prediction call fetches the freshly
 * activated calibration model from the DB.  Must be called from `runCalibrationRefitJob.ts`
 * after a new calibration model row has been written with `active = true`.
 */
export function invalidateCalibrationCache(): void {
  _cache = null;
}
