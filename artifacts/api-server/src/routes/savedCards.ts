import { Router } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, savedPredictionCardsTable, predictionsTable } from "@workspace/db";
import { requireClerkUser } from "../middlewares/requireClerkUser";
import { isAdminSessionCookieValid } from "../lib/adminAuth";
import { getAuth } from "@clerk/express";
import { logger } from "../lib/logger";

const router = Router();

// Resolve the effective user ID for saved-cards operations.
// Admin sessions use a fixed "__admin__" bucket so they can save/retrieve cards
// without a Clerk identity.
function resolveUserId(req: import("express").Request): string {
  if (isAdminSessionCookieValid(req.signedCookies)) return "__admin__";
  return getAuth(req).userId!;
}

// ── GET /api/saved-cards ──────────────────────────────────────────────────────
// Returns all saved prediction cards for the authenticated Clerk user (or the
// shared admin bucket for admin sessions), joined with the predictions row.
router.get("/saved-cards", requireClerkUser, async (req, res): Promise<void> => {
  const clerkUserId = resolveUserId(req);

  try {
    const rows = await db
      .select({
        id: savedPredictionCardsTable.id,
        predictionId: savedPredictionCardsTable.predictionId,
        note: savedPredictionCardsTable.note,
        savedAt: savedPredictionCardsTable.savedAt,
        // Prediction display fields
        player1Name: predictionsTable.player1Name,
        player2Name: predictionsTable.player2Name,
        surface: predictionsTable.surface,
        tournamentName: predictionsTable.tournamentName,
        tournamentLevel: predictionsTable.tournamentLevel,
        recommendation: predictionsTable.recommendation,
        calibratedProbability: predictionsTable.calibratedProbability,
        predictedWinnerName: predictionsTable.predictedWinnerName,
        predictedWinnerProbability: predictionsTable.predictedWinnerProbability,
        createdAt: predictionsTable.createdAt,
      })
      .from(savedPredictionCardsTable)
      .innerJoin(
        predictionsTable,
        eq(savedPredictionCardsTable.predictionId, predictionsTable.id),
      )
      .where(eq(savedPredictionCardsTable.clerkUserId, clerkUserId))
      .orderBy(desc(savedPredictionCardsTable.savedAt));

    res.json({ cards: rows });
  } catch (err) {
    logger.error({ err }, "Failed to fetch saved prediction cards");
    res.status(500).json({ error: "Failed to fetch saved cards" });
  }
});

// ── POST /api/saved-cards ─────────────────────────────────────────────────────
// Save a prediction card. Returns { id, alreadySaved } — callers can detect
// duplicate saves and show appropriate feedback without throwing an error.
router.post("/saved-cards", requireClerkUser, async (req, res): Promise<void> => {
  const clerkUserId = resolveUserId(req);
  const predictionId = Number(req.body?.predictionId);
  const note: string | undefined = req.body?.note || undefined;

  if (!predictionId || !Number.isFinite(predictionId)) {
    res.status(400).json({ error: "predictionId is required" });
    return;
  }

  try {
    // Check for an existing save — return it rather than throwing a unique-constraint error.
    const existing = await db
      .select({ id: savedPredictionCardsTable.id })
      .from(savedPredictionCardsTable)
      .where(
        and(
          eq(savedPredictionCardsTable.clerkUserId, clerkUserId),
          eq(savedPredictionCardsTable.predictionId, predictionId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      res.json({ id: existing[0].id, alreadySaved: true });
      return;
    }

    const [row] = await db
      .insert(savedPredictionCardsTable)
      .values({ clerkUserId, predictionId, note: note ?? null })
      .returning({ id: savedPredictionCardsTable.id });

    res.json({ id: row.id, alreadySaved: false });
  } catch (err) {
    logger.error({ err, predictionId }, "Failed to save prediction card");
    res.status(500).json({ error: "Failed to save prediction card" });
  }
});

// ── DELETE /api/saved-cards ────────────────────────────────────────────────────
// Clear ALL saved cards for the current user (or admin bucket). Used by the
// bulk batch auto-save to replace the previous batch with a fresh set.
router.delete("/saved-cards", requireClerkUser, async (req, res): Promise<void> => {
  const clerkUserId = resolveUserId(req);

  try {
    await db
      .delete(savedPredictionCardsTable)
      .where(eq(savedPredictionCardsTable.clerkUserId, clerkUserId));

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to clear saved prediction cards");
    res.status(500).json({ error: "Failed to clear saved cards" });
  }
});

// ── DELETE /api/saved-cards/:id ───────────────────────────────────────────────
// Delete a single saved card. Scoped to the requesting user (or admin bucket)
// so a caller cannot delete another user's saved card even if the id is known.
router.delete("/saved-cards/:id", requireClerkUser, async (req, res): Promise<void> => {
  const clerkUserId = resolveUserId(req);
  const id = parseInt(req.params.id as string, 10);

  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    await db
      .delete(savedPredictionCardsTable)
      .where(
        and(
          eq(savedPredictionCardsTable.id, id),
          eq(savedPredictionCardsTable.clerkUserId, clerkUserId),
        ),
      );

    res.json({ success: true });
  } catch (err) {
    logger.error({ err, id }, "Failed to delete saved prediction card");
    res.status(500).json({ error: "Failed to delete saved prediction card" });
  }
});

export default router;
