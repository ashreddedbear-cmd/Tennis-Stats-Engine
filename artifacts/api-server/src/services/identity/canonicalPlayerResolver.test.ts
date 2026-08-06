import test from "node:test";
import assert from "node:assert/strict";
import { auditIdentityRecords } from "./identityAudit.js";
import { buildResolverIndex, normalizeCanonicalPlayerName, resolveCanonicalPlayer, type ResolverCandidate } from "./canonicalPlayerResolver.js";

const players: ResolverCandidate[] = [
  ["djokovic", "Novak Djokovic", "ATP"], ["nadal", "Rafael Nadal", "ATP"], ["alcaraz", "Carlos Alcaraz", "ATP"],
  ["sinner", "Jannik Sinner", "ATP"], ["zverev", "Alexander Zverev", "ATP"], ["fritz", "Taylor Fritz", "ATP"],
  ["tiafoe", "Frances Tiafoe", "ATP"], ["oconnell", "Christopher O'Connell", "ATP"], ["struff", "Jan-Lennard Struff", "ATP"],
  ["davidovich", "Alejandro Davidovich Fokina", "ATP"], ["deminaur", "Alex de Minaur", "ATP"], ["gauff", "Coco Gauff", "WTA"],
  ["swiatek", "Iga Swiatek", "WTA"], ["zheng", "Qinwen Zheng", "WTA"], ["krejcikova", "Barbora Krejcikova", "WTA"],
  ["vondrousova", "Marketa Vondrousova", "WTA"], ["jabeur", "Ons Jabeur", "WTA"], ["ostapenko", "Jelena Ostapenko", "WTA"],
  ["raducanu", "Emma Raducanu", "WTA"], ["snigur", "Daria Snigur", "Challenger"], ["cazaux", "Arthur Cazaux", "Challenger"],
  ["safiullin", "Roman Safiullin", "ATP"], ["andy-murray", "Andy Murray", "ATP"], ["jamie-murray", "Jamie Murray", "ATP"],
  ["serena", "Serena Williams", "WTA"], ["venus", "Venus Williams", "WTA"], ["garcia-1", "Caroline Garcia", "WTA"],
  ["garcia-2", "Maria Garcia", "WTA"], ["bondar", "Anna Bondar", "WTA"], ["smith-a", "Andy Smith", "Challenger"],
  ["smith-j", "James Smith", "Challenger"], ["smith-a2", "Aaron Smith", "Challenger"],
].map(([canonicalPlayerId, displayName, tour]) => ({ canonicalPlayerId, displayName, names: [], metadata: { tour } }));

const index = buildResolverIndex({
  candidates: players,
  aliases: [{ provider: "api-tennis", externalPlayerId: "42", canonicalPlayerId: "djokovic" }, { provider: "sackmann", externalPlayerId: "104925", canonicalPlayerId: "nadal" }],
  knownAliases: { Rafa: "nadal", Nole: "djokovic", Coco: "gauff" },
});

function resolve(name: string, metadata?: { tour?: string; nationality?: string }) {
  return resolveCanonicalPlayer({ externalPlayerName: name, source: "test", metadata }, index);
}

test("normalization handles accents, punctuation, apostrophes, hyphens, and whitespace", () => {
  assert.equal(normalizeCanonicalPlayerName("  Novak Đoković  "), "novak dokovic");
  assert.equal(normalizeCanonicalPlayerName("O’Connell"), "o connell");
  assert.equal(normalizeCanonicalPlayerName("Jan-Lennard"), "jan lennard");
});

const cases: Array<[string, string, string]> = [
  ["Novak Djokovic", "djokovic", "exact-normalized-name"], ["Djokovic, Novak", "djokovic", "reversed-normalized-name"],
  ["Rafael Nadal", "nadal", "exact-normalized-name"], ["Nadal, Rafael", "nadal", "reversed-normalized-name"],
  ["Carlos Alcaraz", "alcaraz", "exact-normalized-name"], ["Alcaraz Carlos", "alcaraz", "reversed-normalized-name"],
  ["Jannik Sinner", "sinner", "exact-normalized-name"], ["Sinner Jannik", "sinner", "reversed-normalized-name"],
  ["Alexander Zverev", "zverev", "exact-normalized-name"], ["Taylor Fritz", "fritz", "exact-normalized-name"],
  ["Frances Tiafoe", "tiafoe", "exact-normalized-name"], ["Christopher O'Connell", "oconnell", "exact-normalized-name"],
  ["Jan Lennard Struff", "struff", "exact-normalized-name"], ["Alejandro Davidovich Fokina", "davidovich", "exact-normalized-name"],
  ["Alex de Minaur", "deminaur", "exact-normalized-name"], ["Qinwen Zheng", "zheng", "exact-normalized-name"],
  ["Barbora Krejcikova", "krejcikova", "exact-normalized-name"], ["Marketa Vondrousova", "vondrousova", "exact-normalized-name"],
  ["Ons Jabeur", "jabeur", "exact-normalized-name"], ["Jelena Ostapenko", "ostapenko", "exact-normalized-name"],
  ["Emma Raducanu", "raducanu", "exact-normalized-name"], ["Daria Snigur", "snigur", "exact-normalized-name"],
  ["Arthur Cazaux", "cazaux", "exact-normalized-name"], ["Roman Safiullin", "safiullin", "exact-normalized-name"],
  ["Andy Murray", "andy-murray", "exact-normalized-name"], ["Jamie Murray", "jamie-murray", "exact-normalized-name"],
  ["Serena Williams", "serena", "exact-normalized-name"], ["Venus Williams", "venus", "exact-normalized-name"],
];

for (const [name, expectedId, expectedMethod] of cases) {
  test(`real player case: ${name}`, () => {
    const result = resolve(name);
    assert.equal(result.canonicalPlayerId, expectedId);
    assert.equal(result.resolutionMethod, expectedMethod);
    assert.equal(result.manualReviewRequired, false);
  });
}

test("different provider IDs resolve to the same canonical player", () => {
  assert.equal(resolveCanonicalPlayer({ provider: "api-tennis", externalPlayerId: "42", externalPlayerName: "unrelated spelling", source: "test" }, index).canonicalPlayerId, "djokovic");
  assert.equal(resolveCanonicalPlayer({ provider: "sackmann", externalPlayerId: "104925", externalPlayerName: "Rafael Nadal", source: "test" }, index).canonicalPlayerId, "nadal");
});

test("known aliases resolve without merging unrelated names", () => {
  assert.equal(resolve("Rafa").resolutionMethod, "known-alias");
  assert.equal(resolve("Nole").canonicalPlayerId, "djokovic");
});

test("initial resolves only when unambiguous", () => {
  assert.equal(resolve("A. Smith").resolutionMethod, "ambiguous");
  assert.equal(resolve("A. Zverev").canonicalPlayerId, "zverev");
});

test("common surnames do not merge incorrectly", () => {
  const result = resolve("Garcia");
  assert.equal(result.canonicalPlayerId, null);
  assert.equal(result.resolutionMethod, "ambiguous");
  assert.equal(result.manualReviewRequired, true);
});

test("fuzzy matching uses supporting metadata and remains reviewable", () => {
  const result = resolve("Anna Bondarx", { tour: "WTA" });
  assert.equal(result.canonicalPlayerId, "bondar");
  assert.equal(result.resolutionMethod, "fuzzy-with-metadata");
  assert.ok(result.confidence > 0.7);
});

test("unresolved records are explicit and require review", () => {
  const result = resolve("Completely Unknown Player");
  assert.equal(result.canonicalPlayerId, null);
  assert.equal(result.resolutionMethod, "unresolved");
  assert.equal(result.manualReviewRequired, true);
});

test("audit report counts mappings and reports collisions without writing", () => {
  const report = auditIdentityRecords([
    { provider: "p1", externalPlayerId: "1", externalPlayerName: "Novak Djokovic" },
    { provider: "p2", externalPlayerId: "2", externalPlayerName: "Garcia" },
    { provider: "p3", externalPlayerId: "3", externalPlayerName: "No Such Player" },
  ], players);
  assert.equal(report.total, 3);
  assert.equal(report.exact, 1);
  assert.equal(report.ambiguous, 1);
  assert.equal(report.unresolved, 1);
  assert.ok(report.collisions.some((collision) => collision.normalizedName === "garcia"));
});