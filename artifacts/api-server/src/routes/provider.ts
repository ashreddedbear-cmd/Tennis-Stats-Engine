import { Router, type IRouter } from "express";
import { GetProviderStatusResponse } from "@workspace/api-zod";
import { getTennisDataProvider } from "../services/tennisData";
import { requireAdmin } from "../lib/adminAuth";
import { probeBsdPlayerSearch } from "../services/tennisData/bsdTennisProvider";

const router: IRouter = Router();

router.get("/provider/status", (_req, res): void => {
  const provider = getTennisDataProvider();
  const status = provider.getStatus();
  res.json(GetProviderStatusResponse.parse(status));
});

/**
 * Admin diagnostic: probes the BSD Tennis player-search endpoint for a given player name.
 * Confirms whether the /tennis/api/v2/players/?search= endpoint is reachable and whether
 * the search-fallback path resolves sub-500 players.
 *
 * GET /provider/bsd-probe?name=<player+name>
 * Returns BsdSearchProbeResult (see bsdTennisProvider.ts).
 */
router.get("/provider/bsd-probe", requireAdmin, async (req, res): Promise<void> => {
  const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "Missing required query parameter: name" });
    return;
  }
  try {
    const probe = await probeBsdPlayerSearch(name);
    res.json(probe);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
