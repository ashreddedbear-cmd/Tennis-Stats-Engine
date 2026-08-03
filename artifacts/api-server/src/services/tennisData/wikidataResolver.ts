/**
 * Wikidata name resolver (Task #107 Phase 2).
 *
 * Queries the Wikidata SPARQL endpoint for aliases, birth names, and common transliterations
 * of tennis player names. No API key required. Used as an additional name-variant source when
 * the standard provider lookup fails to resolve an identity (e.g. Galán / Galan, Chiesa,
 * Feistel / Feistl, players with diacritic variants).
 *
 * Results are cached in-memory for 24 hours to avoid hammering the public endpoint.
 */
import { logger } from "../../lib/logger";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 h

interface CacheEntry {
  aliases: string[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

// ── SPARQL query ─────────────────────────────────────────────────────────────

/**
 * Returns all English-language labels and alt-labels on Wikidata for tennis players whose name
 * matches (or contains) `playerName`. The result includes the canonical label AND every
 * skos:altLabel (birth name, nickname, transliteration, etc.).
 */
async function sparqlAliases(playerName: string): Promise<string[]> {
  const normalized = playerName.toLowerCase().trim();

  // Use exact-match filter for short names to avoid noise, substring for longer ones.
  const filterExpr = normalized.length <= 10
    ? `LCASE(STR(?lbl)) = LCASE("${normalized}")`
    : `CONTAINS(LCASE(STR(?lbl)), LCASE("${normalized}"))`;

  const query = `
SELECT DISTINCT ?alias WHERE {
  ?player wdt:P106 wd:Q10833314 .       # occupation: tennis player
  ?player rdfs:label|skos:altLabel ?lbl FILTER(LANG(?lbl) = "en")
  FILTER(${filterExpr})
  ?player rdfs:label|skos:altLabel ?alias FILTER(LANG(?alias) = "en")
}
LIMIT 60`;

  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/sparql-results+json" },
    });
    if (!res.ok) throw new Error(`Wikidata SPARQL returned HTTP ${res.status}`);
    const data = (await res.json()) as {
      results: { bindings: Array<{ alias: { value: string } }> };
    };
    return data.results.bindings.map((b) => b.alias.value).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns all known aliases (labels + alt-labels) from Wikidata for tennis players matching
 * `playerName`. Returns an empty array on network/parse failure so callers never throw.
 *
 * Typical aliases include: transliterations without diacritics (Galán → Galan), birth names,
 * short/nickname forms. Deduplicated and cached for 24 h.
 */
export async function resolveWikidataAliases(playerName: string): Promise<string[]> {
  const key = playerName.toLowerCase().trim();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.aliases;
  }

  try {
    const raw = await sparqlAliases(playerName);
    // Deduplicate, case-fold so identity checks downstream are simpler
    const unique = [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
    cache.set(key, { aliases: unique, fetchedAt: Date.now() });
    logger.debug({ playerName, aliasCount: unique.length }, "wikidataResolver: aliases fetched");
    return unique;
  } catch (err) {
    logger.warn({ err, playerName }, "wikidataResolver: query failed (non-fatal, returning empty)");
    // Cache empty so we don't re-flood on repeated misses
    cache.set(key, { aliases: [], fetchedAt: Date.now() });
    return [];
  }
}

/** Convenience: returns the aliases that differ from `playerName` itself (the "extra" variants). */
export async function resolveWikidataAliasVariants(playerName: string): Promise<string[]> {
  const aliases = await resolveWikidataAliases(playerName);
  const norm = playerName.toLowerCase().trim();
  return aliases.filter((a) => a.toLowerCase().trim() !== norm);
}

/** Clear the in-memory cache (useful in tests / manual refresh). */
export function clearWikidataCache(): void {
  cache.clear();
}
