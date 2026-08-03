/**
 * Image hash cache for screenshot OCR results.
 *
 * Key  = MD5 hex of the raw base64 image data (before the data: prefix).
 * Value = the full resolved matchup result.
 *
 * TTL: 1 hour (images in a session are unlikely to change within the hour).
 * Max entries: 200 (LRU eviction — oldest insertion dropped first).
 */

import { createHash } from "crypto";

export interface CacheEntry<T> {
  value: T;
  storedAt: number; // Date.now()
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 200;

// Ordered map so we can evict oldest-inserted entry (insertion order).
const _cache = new Map<string, CacheEntry<unknown>>();

export function imageHash(imageBase64: string): string {
  // Strip data URL prefix if present before hashing so the hash is stable
  // regardless of whether the caller includes the data: header.
  const raw = imageBase64.startsWith("data:")
    ? imageBase64.slice(imageBase64.indexOf(",") + 1)
    : imageBase64;
  return createHash("md5").update(raw).digest("hex");
}

export function cacheGet<T>(hash: string): T | null {
  const entry = _cache.get(hash) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() - entry.storedAt > TTL_MS) {
    _cache.delete(hash);
    return null;
  }
  return entry.value;
}

export function cacheSet<T>(hash: string, value: T): void {
  // Evict oldest entry when at capacity
  if (_cache.size >= MAX_ENTRIES) {
    const oldestKey = _cache.keys().next().value;
    if (oldestKey) _cache.delete(oldestKey);
  }
  _cache.set(hash, { value, storedAt: Date.now() });
}

export function cacheStats(): { entries: number; maxEntries: number; ttlMs: number } {
  return { entries: _cache.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS };
}

export function cacheClear(): void {
  _cache.clear();
}
