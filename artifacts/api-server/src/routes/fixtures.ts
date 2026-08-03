import { Router, type IRouter } from "express";
import {
  GetUpcomingFixturesQueryParams,
  GetUpcomingFixturesResponse,
  GetLiveFixtureScoresQueryParams,
  GetLiveFixtureScoresResponse,
} from "@workspace/api-zod";
import { getTennisDataProvider, ProviderUnavailableError } from "../services/tennisData";
import { collectUpcomingWindow } from "./upcomingWindow";

const router: IRouter = Router();

const DEFAULT_LIMIT = 50;

router.get("/fixtures/upcoming", async (req, res): Promise<void> => {
  const parsed = GetUpcomingFixturesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const limit = parsed.data.limit ?? DEFAULT_LIMIT;
  const offset = parsed.data.offset ?? 0;
  const bypassCache = parsed.data.force === true;
  const provider = getTennisDataProvider();

  try {
    const window = await collectUpcomingWindow(
      (dateStart, dateStop) => provider.getUpcomingFixturesRange(dateStart, dateStop, { bypassCache }),
      {
        limit,
        offset,
        nowMs: Date.now(),
      },
    );
    res.json(GetUpcomingFixturesResponse.parse(window));
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      res.status(502).json({ error: "Tennis data provider unavailable", detail: err.message });
      return;
    }
    throw err;
  }
});

router.get("/fixtures/live-scores", async (req, res): Promise<void> => {
  const parsed = GetLiveFixtureScoresQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const ids = parsed.data.ids
    .split(",")
    .map((id: string) => id.trim())
    .filter((id: string) => id.length > 0);
  if (ids.length === 0) {
    res.status(400).json({ error: "ids must contain at least one non-empty fixture id" });
    return;
  }

  const provider = getTennisDataProvider();
  try {
    const scoresMap = await provider.getLiveScores(ids);
    const scores: Record<string, unknown> = {};
    for (const [id, score] of scoresMap) scores[id] = score;
    res.json(GetLiveFixtureScoresResponse.parse({ scores }));
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      res.status(502).json({ error: "Tennis data provider unavailable", detail: err.message });
      return;
    }
    throw err;
  }
});

export default router;
