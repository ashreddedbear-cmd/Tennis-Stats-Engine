import { randomUUID } from "node:crypto";
import { db, canonicalPlayersTable, playerAliasesTable, playerResolutionReviewsTable } from "@workspace/db";
import { normalizeCanonicalPlayerName, type PlayerResolutionResult } from "./canonicalPlayerResolver.js";

export async function upsertCanonicalPlayer(input: { id?: string; displayName: string; tour?: string | null; nationality?: string | null; dateOfBirth?: Date | null; handedness?: string | null; heightCm?: number | null }): Promise<string> {
  const id = input.id ?? `canonical-${randomUUID()}`;
  await db.insert(canonicalPlayersTable).values({ id, displayName: input.displayName, normalizedName: normalizeCanonicalPlayerName(input.displayName), tour: input.tour ?? null, nationality: input.nationality ?? null, dateOfBirth: input.dateOfBirth ?? null, handedness: input.handedness ?? null, heightCm: input.heightCm ?? null }).onConflictDoNothing({ target: canonicalPlayersTable.id });
  return id;
}

export async function upsertProviderAlias(input: { provider: string; externalPlayerId: string; externalPlayerName: string; canonicalPlayerId: string; aliasType?: string; metadata?: Record<string, unknown> }): Promise<void> {
  await db.insert(playerAliasesTable).values({ id: `alias-${randomUUID()}`, provider: input.provider, externalPlayerId: input.externalPlayerId, externalPlayerName: input.externalPlayerName, normalizedName: normalizeCanonicalPlayerName(input.externalPlayerName), canonicalPlayerId: input.canonicalPlayerId, aliasType: input.aliasType ?? "provider-id", metadata: input.metadata ?? {} }).onConflictDoUpdate({ target: [playerAliasesTable.provider, playerAliasesTable.externalPlayerId], set: { externalPlayerName: input.externalPlayerName, normalizedName: normalizeCanonicalPlayerName(input.externalPlayerName), canonicalPlayerId: input.canonicalPlayerId, metadata: input.metadata ?? {} } });
}

export async function enqueuePlayerResolutionReview(input: { source: string; provider?: string | null; externalPlayerId?: string | null; externalPlayerName: string; result: PlayerResolutionResult }): Promise<void> {
  if (!input.result.manualReviewRequired) return;
  await db.insert(playerResolutionReviewsTable).values({ id: `review-${randomUUID()}`, source: input.source, provider: input.provider ?? null, externalPlayerId: input.externalPlayerId ?? null, externalPlayerName: input.externalPlayerName, normalizedName: input.result.normalizedName, candidateCanonicalIds: input.result.candidateCanonicalIds, resolutionMethod: input.result.resolutionMethod, confidence: input.result.confidence, supportingMetadata: input.result.supportingMetadata ?? {}, reason: input.result.reason }).onConflictDoNothing();
}