import { db, canonicalPlayersTable, playerAliasesTable } from "@workspace/db";
import { enqueuePlayerResolutionReview, upsertProviderAlias } from "./canonicalPlayerPersistence.js";
import {
  buildResolverIndex,
  resolveCanonicalPlayer,
  type PlayerMetadata,
  type PlayerResolutionResult,
  type ResolverCandidate,
} from "./canonicalPlayerResolver.js";

export interface IngestionPlayerInput {
  provider: string;
  externalPlayerId: string;
  externalPlayerName: string;
  metadata?: PlayerMetadata;
}

export interface CanonicalIngestionDependencies {
  candidates: ResolverCandidate[];
  aliases?: Array<{ provider: string; externalPlayerId: string; canonicalPlayerId: string }>;
  persistAlias?: (input: {
    provider: string;
    externalPlayerId: string;
    externalPlayerName: string;
    canonicalPlayerId: string;
    aliasType?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  enqueueReview?: (input: {
    source: string;
    provider?: string | null;
    externalPlayerId?: string | null;
    externalPlayerName: string;
    result: PlayerResolutionResult;
  }) => Promise<void>;
}

export async function loadCanonicalIngestionDependencies(): Promise<CanonicalIngestionDependencies> {
  const [players, aliases] = await Promise.all([
    db.select().from(canonicalPlayersTable),
    db.select({ provider: playerAliasesTable.provider, externalPlayerId: playerAliasesTable.externalPlayerId, canonicalPlayerId: playerAliasesTable.canonicalPlayerId }).from(playerAliasesTable),
  ]);

  return {
    candidates: players.map((player) => ({
      canonicalPlayerId: player.id,
      displayName: player.displayName,
      names: [],
      metadata: {
        tour: player.tour,
        nationality: player.nationality,
        dateOfBirth: player.dateOfBirth,
        handedness: player.handedness,
        heightCm: player.heightCm,
        activeFrom: player.activeFrom,
        activeTo: player.activeTo,
      },
    })),
    aliases,
  };
}

export function createCanonicalIngestionResolver(
  source: string,
  dependencies: CanonicalIngestionDependencies,
) {
  const index = buildResolverIndex(dependencies);
  const processed = new Set<string>();
  const persistAlias = dependencies.persistAlias ?? upsertProviderAlias;
  const enqueueReview = dependencies.enqueueReview ?? enqueuePlayerResolutionReview;

  async function resolve(input: IngestionPlayerInput): Promise<PlayerResolutionResult> {
    const result = resolveCanonicalPlayer({ ...input, source }, index);
    const key = `${input.provider}:${input.externalPlayerId}:${input.externalPlayerName}`;
    if (!processed.has(key)) {
      processed.add(key);
      if (result.canonicalPlayerId) {
        await persistAlias({
          provider: input.provider,
          externalPlayerId: input.externalPlayerId,
          externalPlayerName: input.externalPlayerName,
          canonicalPlayerId: result.canonicalPlayerId,
          aliasType: result.resolutionMethod,
          metadata: input.metadata ? { ...input.metadata } : {},
        });
      } else {
        await enqueueReview({
          source,
          provider: input.provider,
          externalPlayerId: input.externalPlayerId,
          externalPlayerName: input.externalPlayerName,
          result,
        });
      }
    }
    return result;
  }

  return { resolve };
}

export async function createDatabaseCanonicalIngestionResolver(source: string) {
  return createCanonicalIngestionResolver(source, await loadCanonicalIngestionDependencies());
}