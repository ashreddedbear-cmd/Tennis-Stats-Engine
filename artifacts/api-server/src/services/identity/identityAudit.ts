import { normalizeCanonicalPlayerName, resolveCanonicalPlayer, buildResolverIndex, type PlayerMetadata, type ResolverCandidate } from "./canonicalPlayerResolver.js";

export interface AuditRecord { provider: string; externalPlayerId: string; externalPlayerName: string; metadata?: PlayerMetadata; }
export interface IdentityAuditReport { total: number; exact: number; alias: number; fuzzy: number; ambiguous: number; unresolved: number; collisions: Array<{ normalizedName: string; canonicalPlayerIds: string[] }>; results: ReturnType<typeof resolveCanonicalPlayer>[]; }

export function auditIdentityRecords(records: AuditRecord[], candidates: ResolverCandidate[], aliases: Array<{ provider: string; externalPlayerId: string; canonicalPlayerId: string }> = []): IdentityAuditReport {
  const index = buildResolverIndex({ candidates, aliases });
  const results = records.map((record) => resolveCanonicalPlayer({ ...record, source: "dry-run-audit" }, index));
  const collisionMap = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const normalized = normalizeCanonicalPlayerName(candidate.displayName);
    const words = normalized.split(" ").filter(Boolean);
    const name = words.length > 1 ? words[words.length - 1] : normalized;
    const ids = collisionMap.get(name) ?? new Set<string>();
    ids.add(candidate.canonicalPlayerId);
    collisionMap.set(name, ids);
  }
  const collisions = [...collisionMap.entries()].filter(([, ids]) => ids.size > 1).map(([normalizedName, ids]) => ({ normalizedName, canonicalPlayerIds: [...ids] }));
  return {
    total: records.length,
    exact: results.filter((result) => result.resolutionMethod === "exact-normalized-name" || result.resolutionMethod === "reversed-normalized-name").length,
    alias: results.filter((result) => result.resolutionMethod === "provider-alias" || result.resolutionMethod === "known-alias").length,
    fuzzy: results.filter((result) => result.resolutionMethod === "fuzzy-with-metadata").length,
    ambiguous: results.filter((result) => result.resolutionMethod === "ambiguous").length,
    unresolved: results.filter((result) => result.resolutionMethod === "unresolved").length,
    collisions,
    results,
  };
}