import { db, historicalMatchesTable } from "@workspace/db";
import { auditIdentityRecords } from "../services/identity/identityAudit.js";
import type { ResolverCandidate } from "../services/identity/canonicalPlayerResolver.js";

/** Read-only audit. It deliberately does not create canonical players or aliases. */
const rows = await db.select({ provider: historicalMatchesTable.provider, player1Id: historicalMatchesTable.player1Id, player1Name: historicalMatchesTable.player1Name, player2Id: historicalMatchesTable.player2Id, player2Name: historicalMatchesTable.player2Name, tour: historicalMatchesTable.tour }).from(historicalMatchesTable);
const candidates: ResolverCandidate[] = [];
const seen = new Set<string>();
for (const row of rows) {
  for (const [id, name] of [[row.player1Id, row.player1Name], [row.player2Id, row.player2Name]] as const) {
    if (name.includes("/") || seen.has(`${row.provider}:${id}`)) continue;
    seen.add(`${row.provider}:${id}`);
    candidates.push({ canonicalPlayerId: `dry-run:${row.provider}:${id}`, displayName: name, names: [], metadata: { tour: row.tour } });
  }
}
const records = rows.flatMap((row) => [
  { provider: row.provider, externalPlayerId: row.player1Id, externalPlayerName: row.player1Name, metadata: { tour: row.tour } },
  { provider: row.provider, externalPlayerId: row.player2Id, externalPlayerName: row.player2Name, metadata: { tour: row.tour } },
]);
const report = auditIdentityRecords(records, candidates);
console.log(JSON.stringify({ mode: "dry-run", ...report, results: undefined }, null, 2));