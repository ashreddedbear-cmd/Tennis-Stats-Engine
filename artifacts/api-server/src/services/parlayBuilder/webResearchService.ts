/**
 * Web Research Service — Tier 5 data source for the Parlay Builder.
 *
 * Uses Gemini 1.5 Flash with Google Search grounding to research real-time
 * player injury status, fitness, recent news, and fatigue indicators.
 * This feeds the injuryRisk factor which was previously unavailable.
 *
 * Architecture:
 *   - Called once per validate request (parallel with player resolution)
 *   - Skipped in backfill mode (asOfDate set) — historical news is unreliable
 *   - Skipped if GEMINI_API_KEY is not configured
 *   - Never throws — always returns null on any failure
 *   - Results are NOT cached (injury news is time-sensitive)
 *
 * Output feeds injuryRisk factor in builderScoringService.ts:
 *   riskLevel 0 = no injury risk (fully fit)
 *   riskLevel 100 = serious injury / withdrawal likely
 */

import { logger } from "../../lib/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlayerResearch {
  playerName: string;
  injuryStatus: "fit" | "questionable" | "injured" | "withdrawn" | "unknown";
  injuryDetail: string | null;
  fatigueLevel: "fresh" | "moderate" | "tired" | "unknown";
  /** 0 = no risk (fit), 100 = serious risk (injured/withdrawn) */
  riskLevel: number;
  newsItems: string[];
  confidence: number; // 0–1
}

export interface MatchupResearch {
  selected: PlayerResearch;
  opponent: PlayerResearch;
  /** Combined confidence — use this to decide whether to trust the data. */
  confidence: number;
  /** Timestamp of the research call. */
  researchedAt: Date;
}

// ─── Gemini call ──────────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-1.5-flash";
const GEMINI_TIMEOUT_MS = 20_000;

function buildPrompt(playerName: string, opponentName: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. You are a tennis analyst assistant. Use web search to research the CURRENT fitness and injury status of these two tennis players:

PLAYER 1: ${playerName}
PLAYER 2: ${opponentName}

For EACH player, search for and assess:
1. Any active injuries, physical complaints, or health concerns right now
2. Recent match retirements, walkover withdrawals, or late scratches
3. Post-match or press conference statements about physical condition
4. Match load in the last 14 days (count of matches played)
5. Upcoming tournament withdrawal announcements
6. Travel fatigue indicators (multiple continents recently, long flights)

Return ONLY a valid JSON object — no markdown, no explanation, no backticks:

{
  "player1": {
    "playerName": "${playerName}",
    "injuryStatus": "fit|questionable|injured|withdrawn|unknown",
    "injuryDetail": "brief specific description or null",
    "fatigueLevel": "fresh|moderate|tired|unknown",
    "riskLevel": 0,
    "newsItems": ["finding 1", "finding 2"],
    "confidence": 0.0
  },
  "player2": {
    "playerName": "${opponentName}",
    "injuryStatus": "fit|questionable|injured|withdrawn|unknown",
    "injuryDetail": "brief specific description or null",
    "fatigueLevel": "fresh|moderate|tired|unknown",
    "riskLevel": 0,
    "newsItems": ["finding 1", "finding 2"],
    "confidence": 0.0
  }
}

riskLevel: 0 = fully fit with no concerns, 50 = minor issue worth noting, 75 = significant concern, 100 = serious injury or withdrawn.
confidence: how confident are you in this data (0 = no relevant search results found, 1 = multiple reliable sources confirm).
If you find no information about a player, set injuryStatus "unknown", riskLevel 0, confidence 0.`;
}

function extractJsonFromText(text: string): unknown | null {
  // Try direct parse first
  try {
    return JSON.parse(text.trim());
  } catch {
    // Extract JSON object from mixed text
  }

  // Find the outermost {...} block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parsePlayerResearch(raw: unknown, fallbackName: string): PlayerResearch {
  const UNKNOWN: PlayerResearch = {
    playerName: fallbackName,
    injuryStatus: "unknown",
    injuryDetail: null,
    fatigueLevel: "unknown",
    riskLevel: 0,
    newsItems: [],
    confidence: 0,
  };

  if (!raw || typeof raw !== "object") return UNKNOWN;
  const r = raw as Record<string, unknown>;

  const validStatuses = ["fit", "questionable", "injured", "withdrawn", "unknown"] as const;
  const validFatigue = ["fresh", "moderate", "tired", "unknown"] as const;

  const injuryStatus = validStatuses.includes(r["injuryStatus"] as (typeof validStatuses)[number])
    ? (r["injuryStatus"] as PlayerResearch["injuryStatus"])
    : "unknown";

  const fatigueLevel = validFatigue.includes(r["fatigueLevel"] as (typeof validFatigue)[number])
    ? (r["fatigueLevel"] as PlayerResearch["fatigueLevel"])
    : "unknown";

  const riskLevel = typeof r["riskLevel"] === "number"
    ? Math.max(0, Math.min(100, r["riskLevel"]))
    : 0;

  const confidence = typeof r["confidence"] === "number"
    ? Math.max(0, Math.min(1, r["confidence"]))
    : 0;

  const newsItems = Array.isArray(r["newsItems"])
    ? (r["newsItems"] as unknown[]).filter((x) => typeof x === "string").slice(0, 5) as string[]
    : [];

  const injuryDetail = typeof r["injuryDetail"] === "string" && r["injuryDetail"].length > 0
    ? r["injuryDetail"]
    : null;

  const playerName = typeof r["playerName"] === "string" && r["playerName"].length > 0
    ? r["playerName"]
    : fallbackName;

  return { playerName, injuryStatus, injuryDetail, fatigueLevel, riskLevel, newsItems, confidence };
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Research current injury/fitness status for both players in a matchup.
 *
 * Returns null when:
 * - GEMINI_API_KEY is not configured
 * - The API call fails or times out
 * - The response cannot be parsed
 *
 * Callers should treat null as "no web research data" and fall back to
 * the neutral (50) injuryRisk score.
 */
export async function researchPlayerMatchup(
  selectedPlayerName: string,
  opponentName: string,
): Promise<MatchupResearch | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.debug("webResearchService: GEMINI_API_KEY not set — skipping web research");
    return null;
  }

  const prompt = buildPrompt(selectedPlayerName, opponentName);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ googleSearchRetrieval: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC", dynamicThreshold: 0.3 } } }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 1024,
          },
        }),
      },
    ).finally(() => clearTimeout(timer));

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 200) },
        "webResearchService: Gemini API error",
      );
      return null;
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      error?: { message: string };
    };

    if (data.error) {
      logger.warn({ error: data.error }, "webResearchService: Gemini returned error field");
      return null;
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) {
      logger.warn("webResearchService: Gemini returned empty text");
      return null;
    }

    const parsed = extractJsonFromText(text);
    if (!parsed || typeof parsed !== "object") {
      logger.warn({ text: text.slice(0, 300) }, "webResearchService: could not extract JSON from Gemini response");
      return null;
    }

    const p = parsed as Record<string, unknown>;
    const selected = parsePlayerResearch(p["player1"], selectedPlayerName);
    const opponent = parsePlayerResearch(p["player2"], opponentName);
    const combinedConfidence = (selected.confidence + opponent.confidence) / 2;

    logger.info(
      {
        selectedPlayerName,
        opponentName,
        selStatus: selected.injuryStatus,
        selRisk: selected.riskLevel,
        oppStatus: opponent.injuryStatus,
        oppRisk: opponent.riskLevel,
        confidence: combinedConfidence,
      },
      "webResearchService: research complete",
    );

    return {
      selected,
      opponent,
      confidence: combinedConfidence,
      researchedAt: new Date(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("timeout")) {
      logger.warn({ selectedPlayerName, opponentName }, "webResearchService: Gemini call timed out");
    } else {
      logger.warn({ err, selectedPlayerName, opponentName }, "webResearchService: unexpected error");
    }
    return null;
  }
}
