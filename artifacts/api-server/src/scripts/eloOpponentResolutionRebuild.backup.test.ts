import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backupMatchFeatureSnapshots, cachedHeadToHead, cachedPlayerHistory, createVerificationHistoryCache } from "./eloOpponentResolutionRebuild.js";
import { buildMatchHistoryIndex, reconstructHeadToHead, reconstructPlayerMatchHistory } from "../services/historicalData/matchRecordReconstruction.js";
import type { HistoricalMatchRow } from "@workspace/db";
import type { MatchFeatureSnapshotRow } from "@workspace/db";

function row(id: number): MatchFeatureSnapshotRow {
  return {
    id,
    matchId: id,
    playerId: `player-${id}`,
    featureName: "eloOverall",
    featureValue: 1500 + id,
    sourceTimestamp: new Date(`2025-01-${String(id).padStart(2, "0")}T00:00:00.000Z`),
    matchCutoffAt: new Date(`2025-01-${String(id).padStart(2, "0")}T00:00:00.000Z`),
    existedBeforeCutoff: true,
    recordedAt: new Date(`2025-01-${String(id).padStart(2, "0")}T00:00:00.000Z`),
  };
}

function fakeFiles() {
  const files = new Map<string, string>();
  const opened: Array<{ path: string; closed: boolean }> = [];
  return {
    files,
    opened,
    api: {
      async mkdir() {},
      async open(filePath: string) {
        files.set(filePath, "");
        const handle = { path: filePath, closed: false };
        opened.push(handle);
        return {
          async writeFile(data: string) { files.set(filePath, `${files.get(filePath) ?? ""}${data}`); },
          async close() { handle.closed = true; },
        };
      },
      async rename(source: string, destination: string) {
        files.set(destination, files.get(source) ?? "");
        files.delete(source);
      },
      async stat(filePath: string) { return { size: new TextEncoder().encode(files.get(filePath) ?? "").length }; },
    },
  };
}

describe("snapshot JSONL backup", () => {
  it("exports multiple primary-key batches as valid newline-delimited JSON", async () => {
    const fake = fakeFiles();
    const result = await backupMatchFeatureSnapshots({
      backupDir: "/backups",
      finalFilename: "snapshots.jsonl",
      batchSize: 2,
      files: fake.api,
      fetchBatch: async (lastId) => lastId === 0 ? [row(1), row(2)] : lastId === 2 ? [row(3)] : [],
    });
    const lines = fake.files.get("/backups/snapshots.jsonl")!.trim().split("\n");
    assert.equal(result.totalRows, 3);
    assert.equal(result.batchesCompleted, 2);
    assert.equal(result.lastExportedRowId, 3);
    assert.equal(fake.files.has("/backups/snapshots.jsonl.partial"), false);
    assert.deepEqual(lines.map((line) => JSON.parse(line).id), [1, 2, 3]);
  });

  it("renames an empty partial file only after an empty-table export succeeds", async () => {
    const fake = fakeFiles();
    const result = await backupMatchFeatureSnapshots({
      backupDir: "/backups",
      files: fake.api,
      fetchBatch: async () => [],
    });
    assert.equal(result.totalRows, 0);
    assert.equal(result.batchesCompleted, 0);
    assert.equal(result.lastExportedRowId, null);
    assert.equal(fake.files.has(result.backupPath), true);
    assert.equal(fake.files.get(result.backupPath), "");
  });

  it("preserves the partial path and does not rename after a batch failure", async () => {
    const fake = fakeFiles();
    await assert.rejects(
      () => backupMatchFeatureSnapshots({
        backupDir: "/backups",
        finalFilename: "failed.jsonl",
        files: fake.api,
        fetchBatch: async (lastId) => {
          if (lastId === 0) return [row(1)];
          throw new Error("simulated database failure");
        },
      }),
      /partial file preserved at \/backups\/failed\.jsonl\.partial/,
    );
    assert.equal(fake.files.has("/backups/failed.jsonl"), false);
    assert.equal(fake.files.has("/backups/failed.jsonl.partial"), true);
    assert.equal(JSON.parse(fake.files.get("/backups/failed.jsonl.partial")!.trim()).id, 1);
  });

  it("preserves a partial file when writing a row fails", async () => {
    const fake = fakeFiles();
    let writes = 0;
    const originalOpen = fake.api.open;
    fake.api.open = async (filePath: string) => {
      const handle = await originalOpen(filePath);
      return {
        async writeFile(data: string) {
          writes += 1;
          if (writes === 2) throw new Error("simulated write failure");
          return handle.writeFile(data);
        },
        close: handle.close,
      };
    };
    await assert.rejects(() => backupMatchFeatureSnapshots({
      backupDir: "/backups", finalFilename: "write-failed.jsonl", files: fake.api,
      fetchBatch: async () => [row(1), row(2)],
    }), /partial file preserved/);
    assert.equal(fake.files.has("/backups/write-failed.jsonl"), false);
    assert.equal(fake.files.has("/backups/write-failed.jsonl.partial"), true);
  });
});

function match(id: number, player1Id: string, player2Id: string, start: string, winnerId: string | null = player1Id): HistoricalMatchRow {
  return {
    id, externalId: `m-${id}`, provider: "test", tour: "ATP", tournamentName: "Cache Open",
    tournamentLevel: "ATP250", surface: "Hard", round: "F", matchFormat: "BestOf3",
    player1Id, player1Name: player1Id, player2Id, player2Name: player2Id, winnerId,
    score: "6-4 6-4", retired: false, walkover: false, cancelled: false,
    gameMarginsPlayer1: [], indoor: null, player1Rank: null, player2Rank: null,
    scheduledStartAt: new Date(start), scheduledStartTimeConfirmed: true, cutoffMinutes: 30,
    cutoffAt: new Date(new Date(start).getTime() - 30 * 60_000), rawSource: {}, importedAt: new Date(start),
  };
}

it("verification cache returns the same history and H2H as scan reconstruction", () => {
  const rows = [
    match(1, "p1", "p2", "2025-01-01T10:00:00.000Z"),
    match(2, "p2", "p3", "2025-01-02T10:00:00.000Z", "p3"),
    match(3, "p1", "p3", "2025-01-03T10:00:00.000Z", "p1"),
    match(4, "p1", "p2", "2025-01-04T10:00:00.000Z", "p2"),
    match(5, "p1", "p2", "2025-01-05T10:00:00.000Z", null),
  ];
  const index = buildMatchHistoryIndex(rows);
  const cutoff = new Date("2025-01-05T00:00:00.000Z");
  const cache = createVerificationHistoryCache();
  const scanHistory = reconstructPlayerMatchHistory(index, "p1", cutoff);
  const cachedHistory = cachedPlayerHistory(cache, index, "p1", cutoff);
  assert.deepEqual(cachedHistory, scanHistory);
  assert.strictEqual(cachedPlayerHistory(cache, index, "p1", cutoff), cachedHistory);

  const scanH2h = reconstructHeadToHead(index, "p1", "p2", cutoff);
  const cachedH2h = cachedHeadToHead(cache, index, "p1", "p2", cutoff);
  assert.deepEqual(cachedH2h, scanH2h);
  assert.strictEqual(cachedHeadToHead(cache, index, "p1", "p2", cutoff), cachedH2h);
  assert.equal(scanHistory.length, 3, "cancelled/undecided rows remain excluded by the shared index");
});
