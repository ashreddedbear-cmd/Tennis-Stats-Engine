import { Router, type IRouter } from "express";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { db, predictionsTable } from "@workspace/db";
import {
  ListPredictionsQueryParams,
  ListPredictionsResponse,
  CreatePredictionBody,
  CreatePredictionResponse,
  GetPredictionStatsResponse,
  GetPredictionParams,
  GetPredictionResponse,
  RecordPredictionOutcomeParams,
  RecordPredictionOutcomeBody,
  RecordPredictionOutcomeResponse,
  DeletePredictionParams,
  BulkDeletePredictionsBody,
  BulkDeletePredictionsResponse,
  GradePendingLedgerPredictionsResponse,
  PreviewDuplicatePredictionsResponse,
  RemoveDuplicatePredictionsResponse,
  SearchLedgerPlayersQueryParams,
  SearchLedgerPlayersResponse,
  GetLedgerPlayerPredictionsParams,
  GetLedgerPlayerPredictionsResponse,
} from "@workspace/api-zod";
import { getTennisDataProvider, ProviderUnavailableError } from "../services/tennisData";
import { usedHistoricalMatchFallback } from "../services/predictionEngine/playerProfileWarnings";
import { computeMatchIdentityKey, computeInputSnapshotHash } from "../services/predictionEngine/predictionIdentity";
import { gradePendingLedgerPredictions } from "../services/evaluation/ledgerGrading";
import { findDuplicatePredictionGroups, removeDuplicatePredictions } from "../services/evaluation/ledgerDuplicates";
import { searchLedgerPlayers, getPredictionsForPlayer } from "../services/evaluation/ledgerPlayers";
import { saveOrUpdatePrediction } from "../services/evaluation/savePrediction";
import { predictFromSnapshot, PredictionSnapshotResolutionError } from "../services/evaluation/predictionSnapshot";
import { LIVE_MODEL_VERSION } from "../services/evaluation/types";
import { defaultPredictionMode, derivePredictionStrategyIdentity, getCurrentProductionStrategyIdentity } from "../services/evaluation/strategyIdentity";
import { enforceEntitlement } from "../lib/entitlements";
import { isAdminSessionCookieValid } from "../lib/adminAuth";
import { logger } from "../lib/logger";
import { formatDatabaseError } from "../lib/databaseError";
import {
  assertPredictionIdentityIntegrity,
  getExternalFixtureIdFromRequestMatchId,
  parsePredictionRequestIntegrityHeaders,
} from "./predictionRequestIntegrity";
import { requireClerkUser } from "../middlewares/requireClerkUser";
import { predictionLimiter } from "../middlewares/rateLimiter";
import { getAuth } from "@clerk/express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { searchKnownPlayers, normalizePlayerName } from "../services/tennisData/playerIdentity";
import { isDoublesLikeName } from "./predictionRequestIntegrity";
import {
  canUsePredictionHistory,
} from "../services/payments/entitlementService";

/**
 * Fixture cards from MatchStat carry MatchStat player IDs, which do NOT share an ID space with
 * API-Tennis. Calling getPlayer(<matchstat-id>) on API-Tennis returns an unrelated player (often
 * a doubles team). When submitted player names are available we can do a name-based search to
 * recover the correct canonical API-Tennis ID before running the prediction engine.
 */
async function resolveCanonicalPlayerIdFromName(
  provider: ReturnType<typeof getTennisDataProvider>,
  submittedName: string,
  fallbackId: string,
): Promise<string> {
  try {
    const candidates = await searchKnownPlayers(provider, submittedName);
    const normalizedQuery = normalizePlayerName(submittedName);
    const queryWords = normalizedQuery.split(" ").filter(Boolean);

    // searchKnownPlayers merges live API-Tennis results (no source / source="live") with
    // historical DB entries (source="historical-match"). Historical entries often have MatchStat
    // IDs that collide with unrelated API-Tennis records. Priority order:
    //   1. Live exact match       — e.g. API-Tennis returns "Alexander Bublik" id=24245
    //   2. Live abbreviated match — e.g. API-Tennis returns "T. Valentova" id=8976
    //   3. Historical exact match — fallback only; may be a MatchStat ID
    //   4. Historical abbreviated — last resort
    type Candidate = { id: string; name: string };
    let liveExact: Candidate | null = null;
    let liveAbbrev: Candidate | null = null;
    let histExact: Candidate | null = null;
    let histAbbrev: Candidate | null = null;

    for (const c of candidates) {
      if (isDoublesLikeName(c.name)) continue;
      const cn = normalizePlayerName(c.name);
      const isHistorical = (c as { source?: string }).source === "historical-match";

      // Exact normalised match
      const isExact = cn === normalizedQuery;
      if (isExact) {
        if (!isHistorical && !liveExact) liveExact = c;
        else if (isHistorical && !histExact) histExact = c;
      }

      // Abbreviated form: after normalizePlayerName strips dots, "T. Valentova" → "t valentova"
      // so we check for a single-letter first word matching the query's first-name initial.
      if (queryWords.length >= 2 && !isExact) {
        const initial = queryWords[0]![0]!;
        const surnames = queryWords.slice(1);
        const cnWords = cn.split(" ").filter(Boolean);
        const isAbbrev =
          cnWords.length === surnames.length + 1 &&
          cnWords[0]!.length === 1 &&
          cnWords[0] === initial &&
          surnames.every((s, i) => cnWords[i + 1] === s);
        if (isAbbrev) {
          if (!isHistorical && !liveAbbrev) liveAbbrev = c;
          else if (isHistorical && !histAbbrev) histAbbrev = c;
        }
      }
    }

    const best = liveExact ?? liveAbbrev ?? histExact ?? histAbbrev;
    if (best) {
      const via = liveExact ? "live-exact" : liveAbbrev ? "live-abbrev" : histExact ? "hist-exact" : "hist-abbrev";
      // Task #24: detect when multiple candidates tied at the winning level — silent disambiguation
      // risk. Count how many candidates share the same priority tier as `best`.
      const tiebreakerPool = liveExact
        ? candidates.filter(c => !(c as { source?: string }).source?.startsWith("historical") && !isDoublesLikeName(c.name) && normalizePlayerName(c.name) === normalizedQuery)
        : liveAbbrev
          ? candidates.filter(c => {
              if ((c as { source?: string }).source?.startsWith("historical") || isDoublesLikeName(c.name)) return false;
              const cn = normalizePlayerName(c.name).split(" ").filter(Boolean);
              if (queryWords.length < 2 || cn.length !== queryWords.length) return false;
              const init = queryWords[0]![0]!;
              return cn[0]!.length === 1 && cn[0] === init && queryWords.slice(1).every((s, i) => cn[i + 1] === s);
            })
          : [];
      if (tiebreakerPool.length > 1) {
        logger.warn(
          { submittedName, resolvedId: best.id, resolvedName: best.name, via, ambiguousCandidates: tiebreakerPool.slice(0, 5).map(c => ({ id: c.id, name: c.name })) },
          "resolveCanonicalPlayerIdFromName: ambiguous — multiple equally-scored candidates, picked first",
        );
      }
      logger.info({ submittedName, resolvedId: best.id, resolvedName: best.name, via }, "resolveCanonicalPlayerIdFromName: resolved");
      return best.id;
    }

    logger.warn({ submittedName, fallbackId, candidates: candidates.slice(0, 5).map(c => ({ id: c.id, name: c.name })) }, "resolveCanonicalPlayerIdFromName: no match found, using fallback");
  } catch (err) {
    logger.warn({ err, submittedName, fallbackId }, "resolveCanonicalPlayerIdFromName: error, using fallback");
  }
  return fallbackId;
}

const router: IRouter = Router();

/**
 * Task #30: attaches the real historical-match-fallback disclosure (derived from this row's own
 * stored `engine.warnings`, per `usedHistoricalMatchFallback`) to a raw `predictionsTable` row so
 * list endpoints -- which serialize through the trimmed `PredictionSummary` schema and would
 * otherwise silently drop the full `engine` blob -- can still surface it as a real, non-guessed
 * boolean.
 */
function withHistoricalMatchFallbackFlag<T extends { engine: unknown }>(row: T): T & { usedHistoricalMatchFallback: boolean } {
  const warnings = (row.engine as { warnings?: unknown } | null)?.warnings;
  return { ...row, usedHistoricalMatchFallback: usedHistoricalMatchFallback(warnings) };
}

router.get("/predictions", requireClerkUser, async (req, res): Promise<void> => {
  // Prediction history is gated by Clerk auth only — same reasoning as POST /predictions.
  // Removing the subscription check prevents "not found" on results pages when the workspace
  // subscription_status is null (no active Stripe webhook yet).

  const parsed = ListPredictionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const clerkUserId = getAuth(req).userId;
  // Admin sessions (signed cookie, no Clerk JWT) have no clerkUserId — they see the full
  // ledger for oversight. Clerk-authenticated users are always scoped to their own rows.
  // If neither condition holds, requireClerkUser already rejected the request.
  const isAdmin = isAdminSessionCookieValid(req.signedCookies);

  if (!isAdmin && !clerkUserId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const query = db
    .select()
    .from(predictionsTable)
    .orderBy(desc(predictionsTable.createdAt))
    .limit(parsed.data.limit)
    .offset(parsed.data.offset);

  const rows = clerkUserId
    ? await query.where(eq(predictionsTable.clerkUserId, clerkUserId))
    : await query;

  res.json(ListPredictionsResponse.parse(rows.map(withHistoricalMatchFallbackFlag)));
});

router.get("/predictions/stats", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  // Aggregated in SQL rather than loading every row into Node -- same output shape as before,
  // but the endpoint no longer scales linearly with total prediction count.
  const [totals] = await db
    .select({
      totalPredictions: sql<number>`count(*)`.mapWith(Number),
      resolvedPredictions: sql<number>`count(*) filter (where ${predictionsTable.actualWinnerId} is not null)`.mapWith(Number),
      correctPredictions: sql<number>`count(*) filter (where ${predictionsTable.actualWinnerId} = ${predictionsTable.predictedWinnerId})`.mapWith(
        Number,
      ),
    })
    .from(predictionsTable);

  const byRecommendationRows = await db
    .select({
      recommendation: predictionsTable.recommendation,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(predictionsTable)
    .groupBy(predictionsTable.recommendation);

  const { totalPredictions, resolvedPredictions, correctPredictions } = totals ?? {
    totalPredictions: 0,
    resolvedPredictions: 0,
    correctPredictions: 0,
  };
  const accuracy = resolvedPredictions > 0 ? Math.round((correctPredictions / resolvedPredictions) * 1000) / 10 : null;

  res.json(
    GetPredictionStatsResponse.parse({
      totalPredictions,
      resolvedPredictions,
      correctPredictions,
      accuracy,
      byRecommendation: byRecommendationRows,
    }),
  );
});

// Registered before /predictions/:predictionId and /predictions/players/:playerId so that
// "/predictions/players/search" resolves as this literal route rather than being swallowed by
// the :playerId param route below.
router.get("/predictions/players/search", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const parsed = SearchLedgerPlayersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const players = await searchLedgerPlayers(parsed.data.query);
  res.json(SearchLedgerPlayersResponse.parse(players));
});

router.get("/predictions/players/:playerId", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const params = GetLedgerPlayerPredictionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const rows = await getPredictionsForPlayer(params.data.playerId);
  res.json(GetLedgerPlayerPredictionsResponse.parse(rows.map(withHistoricalMatchFallbackFlag)));
});

router.post("/predictions", requireClerkUser, predictionLimiter, async (req, res): Promise<void> => {
  // Predictions are gated by Clerk auth + rate limit only. Subscription tiers control
  // features within the result (Elite badge, deep explanations) — not whether the prediction
  // runs. Hard-blocking authenticated users based on subscription state causes a confusing
  // "engine error" when the Stripe webhook hasn't fired yet.

  const parsed = CreatePredictionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;

  if (body.player1Id === body.player2Id) {
    res.status(400).json({ error: "player1Id and player2Id must be different players" });
    return;
  }

  const integrity = parsePredictionRequestIntegrityHeaders(req.headers as Record<string, unknown>);
  if ("code" in integrity) {
    res.status(400).json({ error: integrity.message });
    return;
  }

  const provider = getTennisDataProvider();

  try {
    const currentProductionIdentity = await getCurrentProductionStrategyIdentity();
    const fallbackProductionIdentity = derivePredictionStrategyIdentity({
      predictionMode: defaultPredictionMode("live"),
      modelVersion: LIVE_MODEL_VERSION,
      createdAt: new Date(),
    });
    const effectiveProductionIdentity = {
      strategyId: currentProductionIdentity.strategyId ?? fallbackProductionIdentity.strategyId,
      strategyVersion: currentProductionIdentity.strategyVersion ?? fallbackProductionIdentity.strategyVersion,
      strategyFingerprint: currentProductionIdentity.strategyFingerprint ?? LIVE_MODEL_VERSION,
    };

    // When submitted player names are present (fixture card predictions), pre-resolve IDs by name.
    // MatchStat fixture IDs do not share an ID space with API-Tennis — calling getPlayer(<matchstat-id>)
    // returns an unrelated player (often a doubles team). Name-based lookup recovers the correct
    // canonical API-Tennis ID before the prediction engine runs.
    const [resolvedPlayer1Id, resolvedPlayer2Id] = await Promise.all([
      integrity.submittedPlayer1Name
        ? resolveCanonicalPlayerIdFromName(provider, integrity.submittedPlayer1Name, body.player1Id)
        : Promise.resolve(body.player1Id),
      integrity.submittedPlayer2Name
        ? resolveCanonicalPlayerIdFromName(provider, integrity.submittedPlayer2Name, body.player2Id)
        : Promise.resolve(body.player2Id),
    ]);

    const {
      player1,
      player2,
      player1Matches,
      player2Matches,
      headToHead,
      player1OpponentStrength,
      player2OpponentStrength,
      activeCalibrationId,
      output,
    } = await predictFromSnapshot({
      provider,
      player1Id: resolvedPlayer1Id,
      player2Id: resolvedPlayer2Id,
      player1SubmittedName: integrity.submittedPlayer1Name ?? undefined,
      player2SubmittedName: integrity.submittedPlayer2Name ?? undefined,
      surface: body.surface,
      matchFormat: body.matchFormat,
      tournamentName: body.tournamentName ?? null,
      tournamentLevel: body.tournamentLevel ?? null,
      // Ad-hoc live-search predictions have no fixture start time, so weather remains intentionally
      // unavailable here while using the same canonical snapshot scorer as paper trading.
      includeWeather: false,
    });

    // Use canonical resolved IDs for the integrity check. MatchStat fixture IDs may differ
    // from the API-Tennis canonical IDs that the prediction engine resolves to — substituting
    // the canonical IDs prevents a false 409 while the name-match check still catches any
    // real identity substitution.
    const canonicalBody = { ...body, player1Id: player1.id, player2Id: player2.id };
    const identityViolation = assertPredictionIdentityIntegrity(canonicalBody, integrity, player1, player2);
    if (identityViolation) {
      logger.warn({ identityViolation, bodyP1: body.player1Id, bodyP2: body.player2Id, resolvedP1: player1.id, resolvedP2: player2.id, p1Name: player1.name, p2Name: player2.name, submittedP1Name: integrity.submittedPlayer1Name, submittedP2Name: integrity.submittedPlayer2Name }, "409: assertPredictionIdentityIntegrity failed");
      res.status(identityViolation.code === "BAD_REQUEST" ? 400 : 409).json({ error: identityViolation.message });
      return;
    }

    const matchIdentityKey = computeMatchIdentityKey(player1.id, player2.id, body.tournamentName ?? null, body.surface, body.matchFormat);
    const inputSnapshotHash = computeInputSnapshotHash({
      player1Id: player1.id,
      player2Id: player2.id,
      player1Matches,
      player2Matches,
      headToHead,
      player1OpponentElo: player1OpponentStrength.lookup,
      player2OpponentElo: player2OpponentStrength.lookup,
    });

    // Request IDs are internal integrity tokens stored via inputSnapshotHash above -- never
    // surface them as user-facing warning bullets.

    const saved = await saveOrUpdatePrediction({
      player1Id: player1.id,
      player1Name: player1.name,
      player2Id: player2.id,
      player2Name: player2.name,
      surface: body.surface,
      matchFormat: body.matchFormat,
      tournamentLevel: body.tournamentLevel ?? null,
      tournamentName: body.tournamentName ?? null,
      strategyId: effectiveProductionIdentity.strategyId,
      strategyVersion: effectiveProductionIdentity.strategyVersion,
      calibrationVersion: activeCalibrationId,
      externalFixtureId: getExternalFixtureIdFromRequestMatchId(integrity.requestMatchId),
      snapshotCapturedAt: new Date(),
      predictedWinnerId: output.predictedWinnerId,
      predictedWinnerName: output.predictedWinnerName,
      calibratedProbability: output.calibratedProbability,
      predictedWinnerProbability: output.predictedWinnerProbability,
      dataQuality: output.dataQuality,
      dataQualityLabel: output.dataQualityLabel,
      upsetRisk: output.upsetRisk,
      recommendation: output.recommendation,
      predictedSetScore: output.predictedSetScore,
      engine: output.engine,
      decisionTrace: output.decisionTrace,
      crossEngineAgreement: output.crossEngineAgreement,
      matchIdentityKey,
      inputSnapshotHash,
      // Stamp the requesting Clerk user ID so history is scoped per-user.
      // Admin sessions have no Clerk userId — their predictions remain unscoped (null).
      clerkUserId: getAuth(req).userId ?? null,
    });

    if (
      saved.player1Id !== player1.id ||
      saved.player2Id !== player2.id ||
      saved.surface !== body.surface ||
      saved.matchFormat !== body.matchFormat ||
      (saved.tournamentName ?? null) !== (body.tournamentName ?? null)
    ) {
      logger.warn({ savedP1: saved.player1Id, savedP2: saved.player2Id, resolvedP1: player1.id, resolvedP2: player2.id, savedSurface: saved.surface, bodySurface: body.surface, savedFormat: saved.matchFormat, bodyFormat: body.matchFormat, savedTournament: saved.tournamentName, bodyTournament: body.tournamentName }, "409: post-save player/surface/format check failed");
      res.status(409).json({ error: "Integrity check failed: saved prediction no longer matches the submitted request context" });
      return;
    }

    if ((saved.externalFixtureId ?? null) !== getExternalFixtureIdFromRequestMatchId(integrity.requestMatchId)) {
      logger.warn({ savedFixtureId: saved.externalFixtureId, requestMatchId: integrity.requestMatchId, extracted: getExternalFixtureIdFromRequestMatchId(integrity.requestMatchId) }, "409: fixture lineage check failed");
      res.status(409).json({ error: "Integrity check failed: saved fixture lineage no longer matches the submitted request context" });
      return;
    }

    res.setHeader("x-prediction-request-id", integrity.requestId);
    res.setHeader("x-prediction-match-id", integrity.requestMatchId);

    // Augment with rawEnsembleProbability sourced from the persisted decisionTrace.pipeline so
    // the client can display the pre-calibration value in the "Too Close to Call" banner without
    // relying on the decisionTrace field (which is not in the API schema to keep payloads lean).
    const savedWithRaw = { ...saved, rawEnsembleProbability: (saved.decisionTrace as any)?.pipeline?.rawEnsemble ?? null };
    res.status(201).json(CreatePredictionResponse.parse(savedWithRaw));
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      res.status(502).json({ error: "Tennis data provider unavailable", detail: err.message });
      return;
    }
    if (err instanceof PredictionSnapshotResolutionError) {
      logger.warn({ err, requestBody: body }, "Prediction blocked due to unresolved required player identity inputs");
      res.status(422).json({
        error: "Prediction cannot run because required player identity data is unavailable.",
        detail: err.message,
        missingFields: err.missingFields,
      });
      return;
    }
    const dbErr = formatDatabaseError(err, "Prediction insert failed");
    logger.error({ err, requestBody: body, dbError: dbErr.log }, "Prediction engine failed during persistence");
    res.status(dbErr.status).json(dbErr.body);
    return;
  }
});

router.get("/predictions/:predictionId", requireClerkUser, async (req, res): Promise<void> => {
  const params = GetPredictionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db.select().from(predictionsTable).where(eq(predictionsTable.id, params.data.predictionId));

  if (!row) {
    res.status(404).json({ error: "Prediction not found" });
    return;
  }

  const rowWithRaw = { ...row, rawEnsembleProbability: (row.decisionTrace as any)?.pipeline?.rawEnsemble ?? null };
  res.json(GetPredictionResponse.parse(rowWithRaw));
});

/**
 * Task #35: plain-language explanation of a prediction pick.
 * Calls OpenAI to narrate the key engine signals in 2 readable paragraphs.
 * On-demand only (never pre-generated) so costs stay low — the user clicks a button to fetch.
 */
router.get("/predictions/:predictionId/explain", requireClerkUser, async (req, res): Promise<void> => {
  const params = GetPredictionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db.select().from(predictionsTable).where(eq(predictionsTable.id, params.data.predictionId));
  if (!row) {
    res.status(404).json({ error: "Prediction not found" });
    return;
  }

  try {
    const engine = row.engine as Record<string, unknown>;
    const loserName = row.predictedWinnerId === row.player1Id ? row.player2Name : row.player1Name;

    const lines: string[] = [
      `Match: ${row.player1Name} vs ${row.player2Name}`,
      `Surface: ${row.surface}${row.tournamentName ? ` — ${row.tournamentName}` : ""}${row.tournamentLevel ? ` (${row.tournamentLevel})` : ""}`,
      `Predicted winner: ${row.predictedWinnerName} at ${row.predictedWinnerProbability.toFixed(1)}% confidence (over ${loserName})`,
      `Engine call: ${row.recommendation} · Upset risk: ${row.upsetRisk} · Data quality: ${row.dataQualityLabel}`,
      `Model agreement: ${String(engine.modelAgreement ?? "unknown")}`,
    ];

    const reasons = engine.reasons as string[] | undefined;
    const risks = engine.risks as string[] | undefined;
    const disclosures = engine.disclosures as string[] | undefined;

    if (reasons?.length) lines.push(`Key reasons:\n${reasons.map((r) => `- ${r}`).join("\n")}`);
    if (risks?.length) lines.push(`Risk factors:\n${risks.map((r) => `- ${r}`).join("\n")}`);
    if (disclosures?.length) lines.push(`Additional context:\n${disclosures.map((d) => `- ${d}`).join("\n")}`);
    if (engine.disagreementNote) lines.push(`Model disagreement: ${String(engine.disagreementNote)}`);
    if (engine.tieBreakerApplied) lines.push("Note: This is a coin-flip match — models sat within ±3% of 50/50.");
    if (engine.isEliteTier) lines.push(`Elite tier: ${String(engine.eliteTierReason ?? "all strictest gates passed")}`);

    const upsetBreakdown = engine.upsetRiskBreakdown as { note?: string } | undefined;
    if (upsetBreakdown?.note) lines.push(`Upset risk detail: ${upsetBreakdown.note}`);

    const response = await openai.chat.completions.create({
      model: "gpt-5.6-luna",
      max_completion_tokens: 350,
      messages: [
        {
          role: "system",
          content:
            "You are a concise, honest tennis analyst explaining an AI prediction pick in plain English. " +
            "Write exactly 2 short paragraphs — no headers, no markdown, no bullet points. " +
            "Paragraph 1: explain WHY the engine picked this player, naming the actual signals provided (surface Elo, recent form, head-to-head, etc.). " +
            "Paragraph 2: cover the risk factors, model caveats, and close with an honest note about uncertainty. " +
            "Be specific and factual. Never fabricate statistics or imply certainty. Keep it under 200 words total.",
        },
        {
          role: "user",
          content: `Explain this AI tennis prediction in plain English:\n\n${lines.join("\n\n")}`,
        },
      ],
    });

    const explanation = response.choices[0]?.message?.content?.trim() ?? "Explanation unavailable.";
    res.json({ explanation });
  } catch (err) {
    logger.error({ err }, "Failed to generate prediction explanation");
    res.status(502).json({ error: "Failed to generate explanation" });
  }
});

router.delete("/predictions/:predictionId", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const params = DeletePredictionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const deleted = await db
    .delete(predictionsTable)
    .where(eq(predictionsTable.id, params.data.predictionId))
    .returning({ id: predictionsTable.id });

  if (deleted.length === 0) {
    res.status(404).json({ error: "Prediction not found" });
    return;
  }

  res.status(204).end();
});

router.post("/predictions/bulk-delete", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const parsed = BulkDeletePredictionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const deleted = await db
    .delete(predictionsTable)
    .where(inArray(predictionsTable.id, parsed.data.ids))
    .returning({ id: predictionsTable.id });

  res.json(BulkDeletePredictionsResponse.parse({ deletedCount: deleted.length }));
});

router.post("/predictions/duplicates/preview", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const groups = await findDuplicatePredictionGroups();
  const removableCount = groups.reduce((sum, g) => sum + g.removeIds.length, 0);
  res.json(PreviewDuplicatePredictionsResponse.parse({ removableCount, groups }));
});

router.post("/predictions/duplicates/remove", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const { removedCount, groups } = await removeDuplicatePredictions();
  res.json(RemoveDuplicatePredictionsResponse.parse({ removedCount, groups }));
});

router.post("/predictions/grade-pending", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  try {
    const summary = await gradePendingLedgerPredictions();
    res.json(GradePendingLedgerPredictionsResponse.parse(summary));
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      res.status(502).json({ error: "Tennis data provider unavailable", detail: err.message });
      return;
    }
    throw err;
  }
});

router.patch("/predictions/:predictionId/outcome", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const params = RecordPredictionOutcomeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = RecordPredictionOutcomeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(predictionsTable).where(eq(predictionsTable.id, params.data.predictionId));
  if (!existing) {
    res.status(404).json({ error: "Prediction not found" });
    return;
  }

  const actualWinnerName =
    body.data.actualWinnerId === existing.player1Id
      ? existing.player1Name
      : body.data.actualWinnerId === existing.player2Id
        ? existing.player2Name
        : null;

  const [updated] = await db
    .update(predictionsTable)
    .set({
      actualWinnerId: body.data.actualWinnerId,
      actualWinnerName,
      resolvedAt: new Date(),
    })
    .where(eq(predictionsTable.id, params.data.predictionId))
    .returning();

  const updatedWithRaw = { ...updated, rawEnsembleProbability: (updated?.decisionTrace as any)?.pipeline?.rawEnsemble ?? null };
  res.json(GetPredictionResponse.parse(updatedWithRaw));
});

export default router;
