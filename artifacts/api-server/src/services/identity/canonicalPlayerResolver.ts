export type PlayerResolutionMethod =
  | "provider-alias"
  | "exact-normalized-name"
  | "reversed-normalized-name"
  | "known-alias"
  | "surname-initial"
  | "fuzzy-with-metadata"
  | "unique-surname"
  | "ambiguous"
  | "unresolved";

export interface PlayerMetadata {
  tour?: string | null;
  nationality?: string | null;
  dateOfBirth?: string | Date | null;
  age?: number | null;
  handedness?: string | null;
  heightCm?: number | null;
  activeFrom?: string | Date | null;
  activeTo?: string | Date | null;
  tournamentNames?: string[];
  rankingHistory?: number[];
}

export interface ResolverCandidate {
  canonicalPlayerId: string;
  displayName: string;
  names: string[];
  providerAliases?: Array<{ provider: string; externalPlayerId: string; externalPlayerName?: string }>;
  metadata?: PlayerMetadata;
}

export interface PlayerResolverIndex {
  candidates: ResolverCandidate[];
  aliases: Map<string, string>;
  knownAliases?: Map<string, string>;
}

export interface PlayerResolutionResult {
  canonicalPlayerId: string | null;
  resolutionMethod: PlayerResolutionMethod;
  confidence: number;
  source: string;
  manualReviewRequired: boolean;
  normalizedName: string;
  candidateCanonicalIds: string[];
  reason: string | null;
  supportingMetadata: PlayerMetadata | null;
}

function foldSpecialLetters(value: string): string {
  return value.replace(/[Đđ]/g, "d").replace(/[Łł]/g, "l").replace(/[Øø]/g, "o")
    .replace(/[Ææ]/g, "ae").replace(/[Œœ]/g, "oe").replace(/ß/g, "ss");
}

/** Stable comparison form shared by the new identity layer. */
export function normalizeCanonicalPlayerName(name: string): string {
  const folded = foldSpecialLetters(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return folded.toLowerCase()
    .replace(/[\u2018\u2019`']/g, " ")
    .replace(/[\u2010-\u2015-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function variants(name: string): string[] {
  const direct = normalizeCanonicalPlayerName(name);
  if (!direct) return [];
  const result = [direct];
  const words = direct.split(" ");
  if (words.length > 1) result.push([...words].reverse().join(" "));
  return [...new Set(result)];
}

function surnameAndInitial(name: string): { surname: string; initial: string } {
  const words = normalizeCanonicalPlayerName(name).split(" ").filter(Boolean);
  if (words.length < 2) return { surname: words[0] ?? "", initial: "" };
  const firstIsInitial = words[0].length === 1;
  return firstIsInitial
    ? { surname: words.slice(1).join(" "), initial: words[0] }
    : { surname: words.slice(1).join(" "), initial: words[0][0] ?? "" };
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[right.length];
}

function metadataScore(input: PlayerMetadata | undefined, candidate: PlayerMetadata | undefined): number {
  if (!input || !candidate) return 0;
  let score = 0;
  if (input.tour && candidate.tour && input.tour.toLowerCase() === candidate.tour.toLowerCase()) score += 2;
  if (input.nationality && candidate.nationality && input.nationality.toLowerCase() === candidate.nationality.toLowerCase()) score += 2;
  if (input.handedness && candidate.handedness && input.handedness.toLowerCase() === candidate.handedness.toLowerCase()) score += 1;
  if (input.heightCm && candidate.heightCm && Math.abs(input.heightCm - candidate.heightCm) <= 2) score += 1;
  if (input.dateOfBirth && candidate.dateOfBirth) {
    const a = new Date(input.dateOfBirth).getTime();
    const b = new Date(candidate.dateOfBirth).getTime();
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 366 * 24 * 60 * 60 * 1000) score += 3;
  }
  return score;
}

function result(base: Partial<PlayerResolutionResult> & Pick<PlayerResolutionResult, "resolutionMethod" | "confidence" | "source" | "normalizedName">): PlayerResolutionResult {
  return {
    canonicalPlayerId: null,
    manualReviewRequired: false,
    candidateCanonicalIds: [],
    reason: null,
    supportingMetadata: null,
    ...base,
  };
}

export function resolveCanonicalPlayer(input: {
  provider?: string | null;
  externalPlayerId?: string | null;
  externalPlayerName: string;
  metadata?: PlayerMetadata;
  source: string;
}, index: PlayerResolverIndex): PlayerResolutionResult {
  const normalizedName = normalizeCanonicalPlayerName(input.externalPlayerName);
  const providerAliasKey = input.provider && input.externalPlayerId ? `${input.provider}:${input.externalPlayerId}` : null;
  if (providerAliasKey) {
    const aliasId = index.aliases.get(providerAliasKey);
    if (aliasId) return result({ canonicalPlayerId: aliasId, resolutionMethod: "provider-alias", confidence: 1, source: input.source, normalizedName });
  }

  const byName = new Map<string, ResolverCandidate[]>();
  for (const candidate of index.candidates) {
    for (const name of [candidate.displayName, ...candidate.names]) {
      const directName = normalizeCanonicalPlayerName(name);
      const bucket = byName.get(directName) ?? [];
      if (!bucket.some((item) => item.canonicalPlayerId === candidate.canonicalPlayerId)) bucket.push(candidate);
      byName.set(directName, bucket);
    }
  }

  const direct = byName.get(variants(input.externalPlayerName)[0] ?? "") ?? [];
  if (direct.length === 1) return result({ canonicalPlayerId: direct[0].canonicalPlayerId, resolutionMethod: "exact-normalized-name", confidence: 0.98, source: input.source, normalizedName, supportingMetadata: direct[0].metadata ?? null });
  if (direct.length > 1) return result({ resolutionMethod: "ambiguous", confidence: 0, source: input.source, normalizedName, candidateCanonicalIds: direct.map((candidate) => candidate.canonicalPlayerId), manualReviewRequired: true, reason: "multiple canonical players share the normalized full name" });

  const reversed = byName.get(variants(input.externalPlayerName)[1] ?? "") ?? [];
  if (reversed.length === 1) return result({ canonicalPlayerId: reversed[0].canonicalPlayerId, resolutionMethod: "reversed-normalized-name", confidence: 0.96, source: input.source, normalizedName, supportingMetadata: reversed[0].metadata ?? null });
  if (reversed.length > 1) return result({ resolutionMethod: "ambiguous", confidence: 0, source: input.source, normalizedName, candidateCanonicalIds: reversed.map((candidate) => candidate.canonicalPlayerId), manualReviewRequired: true, reason: "reversed name maps to multiple canonical players" });

  const knownId = index.knownAliases?.get(normalizedName);
  if (knownId) return result({ canonicalPlayerId: knownId, resolutionMethod: "known-alias", confidence: 0.93, source: input.source, normalizedName });

  const { surname, initial } = surnameAndInitial(input.externalPlayerName);
  const initialMatches = index.candidates.filter((candidate) => {
    const parsed = surnameAndInitial(candidate.displayName);
    return parsed.surname === surname && parsed.initial === initial;
  });
  if (initialMatches.length === 1) return result({ canonicalPlayerId: initialMatches[0].canonicalPlayerId, resolutionMethod: "surname-initial", confidence: 0.88, source: input.source, normalizedName, supportingMetadata: initialMatches[0].metadata ?? null });
  if (initialMatches.length > 1) return result({ resolutionMethod: "ambiguous", confidence: 0, source: input.source, normalizedName, candidateCanonicalIds: initialMatches.map((candidate) => candidate.canonicalPlayerId), manualReviewRequired: true, reason: "surname and first initial are shared by multiple players" });

  const fuzzy = index.candidates.map((candidate) => {
    const distance = editDistance(normalizedName, normalizeCanonicalPlayerName(candidate.displayName));
    return { candidate, distance, metadata: metadataScore(input.metadata, candidate.metadata) };
  }).filter((entry) => entry.distance <= Math.max(2, Math.floor(normalizedName.length * 0.2)))
    .sort((left, right) => right.metadata - left.metadata || left.distance - right.distance);
  if (fuzzy.length > 0 && (fuzzy.length === 1 || fuzzy[0].metadata > fuzzy[1].metadata)) {
    const best = fuzzy[0];
    return result({ canonicalPlayerId: best.candidate.canonicalPlayerId, resolutionMethod: "fuzzy-with-metadata", confidence: Math.min(0.92, 0.7 + best.metadata * 0.04), source: input.source, normalizedName, supportingMetadata: best.candidate.metadata ?? null });
  }
  if (fuzzy.length > 1) return result({ resolutionMethod: "ambiguous", confidence: 0, source: input.source, normalizedName, candidateCanonicalIds: fuzzy.map((entry) => entry.candidate.canonicalPlayerId), manualReviewRequired: true, reason: "fuzzy candidates are not uniquely distinguished by metadata" });

  const surnameMatches = index.candidates.filter((candidate) => surnameAndInitial(candidate.displayName).surname === surname);
  if (surnameMatches.length === 1) return result({ canonicalPlayerId: surnameMatches[0].canonicalPlayerId, resolutionMethod: "unique-surname", confidence: 0.72, source: input.source, normalizedName, supportingMetadata: surnameMatches[0].metadata ?? null });
  if (surnameMatches.length > 1) return result({ resolutionMethod: "ambiguous", confidence: 0, source: input.source, normalizedName, candidateCanonicalIds: surnameMatches.map((candidate) => candidate.canonicalPlayerId), manualReviewRequired: true, reason: "surname fallback is not unique" });
  return result({ resolutionMethod: "unresolved", confidence: 0, source: input.source, normalizedName, manualReviewRequired: true, reason: "no safe identity candidate found" });
}

export function buildResolverIndex(input: { candidates: ResolverCandidate[]; aliases?: Array<{ provider: string; externalPlayerId: string; canonicalPlayerId: string }>; knownAliases?: Record<string, string> }): PlayerResolverIndex {
  return {
    candidates: input.candidates,
    aliases: new Map((input.aliases ?? []).map((alias) => [`${alias.provider}:${alias.externalPlayerId}`, alias.canonicalPlayerId])),
    knownAliases: new Map(Object.entries(input.knownAliases ?? {}).map(([name, id]) => [normalizeCanonicalPlayerName(name), id])),
  };
}