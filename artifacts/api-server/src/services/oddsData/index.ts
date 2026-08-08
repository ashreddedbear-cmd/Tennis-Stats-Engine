import { logger } from "../../lib/logger";
import { OddsApiIoProvider } from "./oddsApiIoProvider";
import { TheOddsApiProvider } from "./theOddsApiProvider";
import { OddsProviderUnavailableError, type OddsProvider, type OddsProviderStatusInfo, type OddsQuote } from "./types";

export * from "./types";

/**
 * Task #146: three-state odds outcome — distinguishes "no odds for this match yet" (expected,
 * match outside the ~28-31h availability window) from a real provider failure. Used by callers
 * that need to record the distinction rather than treating both null cases identically.
 */
export type OddsStatus = "included" | "outside_window" | "provider_error";

export interface MarketOddsResult {
  quote: OddsQuote | null;
  status: OddsStatus;
}

let primary: OddsProvider | null | undefined;
let fallback: OddsProvider | null | undefined;

function getPrimaryProvider(): OddsProvider | null {
  if (primary === undefined) {
    const apiKey = process.env.THE_ODDS_API_KEY;
    primary = apiKey ? new TheOddsApiProvider(apiKey) : null;
  }
  return primary;
}

function getFallbackProvider(): OddsProvider | null {
  if (fallback === undefined) {
    const apiKey = process.env.ODDS_API_IO_KEY;
    fallback = apiKey ? new OddsApiIoProvider(apiKey) : null;
  }
  return fallback;
}

export function getOddsProviderStatuses(): OddsProviderStatusInfo[] {
  const statuses: OddsProviderStatusInfo[] = [];
  const p = getPrimaryProvider();
  const f = getFallbackProvider();
  if (p) statuses.push(p.getStatus());
  if (f) statuses.push(f.getStatus());
  return statuses;
}

/**
 * Looks up real pre-match head-to-head odds for one matchup, trying The Odds API first and
 * automatically falling back to Odds-API.io when the primary is unavailable or has hit its
 * rate/usage limit. Returns null -- never fabricated -- when neither provider is configured, or
 * neither has real odds for this matchup. Callers must treat null as "no odds available for this
 * prediction", not as "assume 50/50" or any other synthesized value.
 */
export async function fetchMarketOdds(player1Name: string, player2Name: string, scheduledStart: Date | null): Promise<OddsQuote | null> {
  const primaryProvider = getPrimaryProvider();
  if (primaryProvider) {
    try {
      const quote = await primaryProvider.getMatchOdds(player1Name, player2Name, scheduledStart);
      if (quote) return quote;
      // Primary is up but genuinely has no odds for this matchup -- still worth checking the
      // fallback, since coverage differs by provider (different bookmaker panels/tournaments).
    } catch (err) {
      logger.warn({ err }, "The Odds API unavailable or rate-limited, falling back to Odds-API.io");
    }
  }

  const fallbackProvider = getFallbackProvider();
  if (fallbackProvider) {
    try {
      return await fallbackProvider.getMatchOdds(player1Name, player2Name, scheduledStart);
    } catch (err) {
      logger.warn({ err }, "Odds-API.io unavailable, no market odds for this matchup this cycle");
      return null;
    }
  }

  return null;
}

/**
 * Task #146: same provider chain as fetchMarketOdds, but surfaces which of three states occurred:
 * - "included"       — a real OddsQuote was returned
 * - "outside_window" — providers are up but returned no odds for this matchup (expected when the
 *                      match is >~31h out or not covered by either provider's sport keys)
 * - "provider_error" — at least one provider threw (quota exhausted, network, circuit open)
 *
 * Never throws. Callers that only need the quote (not the status) can continue using fetchMarketOdds.
 */
export async function fetchMarketOddsWithStatus(
  player1Name: string,
  player2Name: string,
  scheduledStart: Date | null,
): Promise<MarketOddsResult> {
  let anyProviderError = false;

  const primaryProvider = getPrimaryProvider();
  if (primaryProvider) {
    try {
      const quote = await primaryProvider.getMatchOdds(player1Name, player2Name, scheduledStart);
      if (quote) return { quote, status: "included" };
      // Primary is up but has no odds for this matchup — still try fallback (coverage differs).
    } catch (err) {
      anyProviderError = true;
      logger.warn({ err }, "The Odds API unavailable or rate-limited, falling back to Odds-API.io");
    }
  }

  const fallbackProvider = getFallbackProvider();
  if (fallbackProvider) {
    try {
      const quote = await fallbackProvider.getMatchOdds(player1Name, player2Name, scheduledStart);
      if (quote) return { quote, status: "included" };
      return { quote: null, status: anyProviderError ? "provider_error" : "outside_window" };
    } catch (err) {
      anyProviderError = true;
      logger.warn({ err }, "Odds-API.io unavailable, no market odds for this matchup this cycle");
    }
  }

  return { quote: null, status: anyProviderError ? "provider_error" : "outside_window" };
}

/** Exported for tests only -- resets the cached provider singletons between test cases. */
export function _resetOddsProvidersForTest(): void {
  primary = undefined;
  fallback = undefined;
}

export { OddsProviderUnavailableError };
