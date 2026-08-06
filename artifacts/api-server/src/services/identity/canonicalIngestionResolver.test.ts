import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCanonicalIngestionResolver, type CanonicalIngestionDependencies } from "./canonicalIngestionResolver.js";

function makeDependencies(overrides: Partial<CanonicalIngestionDependencies> = {}) {
  const aliases: Array<Record<string, unknown>> = [];
  const reviews: Array<Record<string, unknown>> = [];
  const dependencies: CanonicalIngestionDependencies = {
    candidates: [
      { canonicalPlayerId: "player-novak", displayName: "Novak Djokovic", names: [], metadata: { tour: "ATP" } },
      { canonicalPlayerId: "player-andy", displayName: "Andy Murray", names: [], metadata: { tour: "ATP" } },
      { canonicalPlayerId: "player-jamie", displayName: "Jamie Murray", names: [], metadata: { tour: "ATP" } },
      { canonicalPlayerId: "player-alex-smith", displayName: "Alex Smith", names: [], metadata: { tour: "ATP" } },
      { canonicalPlayerId: "player-anna-smith", displayName: "Anna Smith", names: [], metadata: { tour: "ATP" } },
    ],
    persistAlias: async (input) => { aliases.push(input); },
    enqueueReview: async (input) => { reviews.push(input); },
    ...overrides,
  };
  return { dependencies, aliases, reviews };
}

describe("canonical ingestion resolver", () => {
  it("persists the source provider ID and canonical alias for a resolved player", async () => {
    const { dependencies, aliases, reviews } = makeDependencies();
    const resolver = createCanonicalIngestionResolver("sackmann-backfill", dependencies);

    const result = await resolver.resolve({
      provider: "sackmann",
      externalPlayerId: "104925",
      externalPlayerName: "Novak Djokovic",
      metadata: { tour: "ATP", tournamentNames: ["Australian Open"] },
    });

    assert.equal(result.canonicalPlayerId, "player-novak");
    assert.equal(result.resolutionMethod, "exact-normalized-name");
    assert.deepEqual(aliases, [{
      provider: "sackmann",
      externalPlayerId: "104925",
      externalPlayerName: "Novak Djokovic",
      canonicalPlayerId: "player-novak",
      aliasType: "exact-normalized-name",
      metadata: { tour: "ATP", tournamentNames: ["Australian Open"] },
    }]);
    assert.equal(reviews.length, 0);
  });

  it("queues ambiguous surname-plus-initial matches instead of selecting a player", async () => {
    const { dependencies, aliases, reviews } = makeDependencies();
    const resolver = createCanonicalIngestionResolver("external-csv-bridge", dependencies);

    const result = await resolver.resolve({
      provider: "ext-csv",
      externalPlayerId: "ext-atp-42",
      externalPlayerName: "Smith A.",
      metadata: { tour: "ATP" },
    });

    assert.equal(result.canonicalPlayerId, null);
    assert.equal(result.resolutionMethod, "ambiguous");
    assert.equal(result.manualReviewRequired, true);
    assert.equal(aliases.length, 0);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].source, "external-csv-bridge");
    assert.equal(reviews[0].provider, "ext-csv");
    assert.equal(reviews[0].externalPlayerId, "ext-atp-42");
  });

  it("does not persist or queue the same provider slot twice in one ingestion run", async () => {
    const { dependencies, aliases, reviews } = makeDependencies();
    const resolver = createCanonicalIngestionResolver("api-tennis-backfill", dependencies);
    const input = {
      provider: "api-tennis",
      externalPlayerId: "42",
      externalPlayerName: "Novak Djokovic",
      metadata: { tour: "ATP" },
    };

    await resolver.resolve(input);
    await resolver.resolve(input);

    assert.equal(aliases.length, 1);
    assert.equal(reviews.length, 0);
  });

  it("preserves provider-scoped IDs when the same numeric ID appears in another source", async () => {
    const { dependencies, aliases } = makeDependencies();
    const resolver = createCanonicalIngestionResolver("multi-source-backfill", dependencies);

    await resolver.resolve({ provider: "api-tennis", externalPlayerId: "42", externalPlayerName: "Novak Djokovic" });
    await resolver.resolve({ provider: "matchstat", externalPlayerId: "42", externalPlayerName: "Novak Djokovic" });

    assert.deepEqual(aliases.map((alias) => [alias.provider, alias.externalPlayerId]), [
      ["api-tennis", "42"],
      ["matchstat", "42"],
    ]);
  });
});
