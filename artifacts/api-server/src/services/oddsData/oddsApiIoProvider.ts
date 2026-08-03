import { logger } from "../../lib/logger";
import { withRetry, isTransientError } from "../../lib/retry";
import { CircuitBreaker } from "../../lib/circuitBreaker";
import { TtlCache } from "../tennisData/cache";
import { matchPlayersToEvent } from "./nameMatch";
import { OddsProviderRateLimitedError, OddsProviderUnavailableError, type OddsProvider, type OddsProviderStatusInfo, type OddsQuote } from "./types";

const BASE_URL = "https://api.odds-api.io/v3";
const EVENTS_TTL_MS = 5 * 60 * 1000;
const ODDS_TTL_MS = 5 * 60 * 1000;
const COMMENCE_TIME_TOLERANCE_MS = 36 * 60 * 60 * 1000;
// The `/odds` endpoint 400s with "Missing bookmakers" if this isn't sent explicitly on every call
// -- selecting bookmakers via PUT /bookmakers/selected/select (done once, out of band) only
// authorizes these names for the account, it does not make the query param optional. Our plan
// caps this at 2 bookmakers (see /bookmakers/selected for the account's current allowance), so
// this must stay in sync with whatever is actually selected on the account.
const REQUESTED_BOOKMAKERS = "Bet365,Unibet";

interface EventRow {
  id: number;
  home: string;
  away: string;
  date: string;
}

interface OddsLine {
  home?: string;
  away?: string;
}

interface MarketEntry {
  name: string;
  odds: OddsLine[];
}

interface OddsResponse {
  id: number;
  home: string;
  away: string;
  date: string;
  bookmakers: Record<string, MarketEntry[]>;
}

/**
 * Fallback pre-match odds source (https://odds-api.io), used automatically when The Odds API is
 * unavailable or rate-limited. Odds-API.io's moneyline/match-winner market is named "ML" across
 * bookmakers on this provider.
 */
export class OddsApiIoProvider implements OddsProvider {
  readonly name = "Odds-API.io";

  private apiKey: string;
  private cache = new TtlCache();
  private lastSuccessfulCallAt: string | null = null;
  private lastError: string | null = null;
  private readonly breaker = new CircuitBreaker("odds-api-io", {
    failureThreshold: 4,
    openDurationMs: 60_000, // odds providers can stay down longer; wait a full minute
    windowMs: 120_000,
  });

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getStatus(): OddsProviderStatusInfo {
    return { provider: this.name, connected: this.lastSuccessfulCallAt !== null, lastSuccessfulCallAt: this.lastSuccessfulCallAt, lastError: this.lastError };
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("apiKey", this.apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    try {
      const body = await this.breaker.execute(() =>
        withRetry(
          async () => {
            let response: Response;
            try {
              response = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
            } catch (err) {
              throw err; // Network errors bubble up to withRetry
            }
            // 401/429 are not transient — don't retry; let the error propagate immediately
            if (response.status === 401 || response.status === 429) {
              const msg = `Odds-API.io reported ${response.status} (rate/usage limit or invalid key)`;
              throw Object.assign(new OddsProviderRateLimitedError(msg), { status: response.status });
            }
            if (!response.ok) {
              throw Object.assign(
                new Error(`Odds-API.io responded with HTTP ${response.status}`),
                { status: response.status },
              );
            }
            const data = (await response.json()) as T | { error: string };
            if (data && typeof data === "object" && "error" in data) {
              throw new OddsProviderUnavailableError(
                `Odds-API.io error: ${(data as { error: string }).error}`,
              );
            }
            return data as T;
          },
          {
            attempts: 3,
            baseDelayMs: 400,
            maxDelayMs: 5_000,
            // Don't retry on 4xx (client errors / rate limits)
            retryOn: (err) =>
              !(err instanceof OddsProviderRateLimitedError) && isTransientError(err),
            onRetry: (err, attempt) =>
              logger.warn({ err, path, attempt }, "Odds-API.io request retrying"),
          },
        ),
      );
      this.lastSuccessfulCallAt = new Date().toISOString();
      this.lastError = null;
      return body;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error calling Odds-API.io";
      this.lastError = message;
      if (err instanceof OddsProviderRateLimitedError) throw err;
      throw new OddsProviderUnavailableError(message);
    }
  }

  private async getTennisEvents(): Promise<EventRow[]> {
    // Without a status filter, /events returns a rolling window ordered such that already-settled
    // matches from the last ~24h can crowd out today's genuinely upcoming ones once enough of them
    // accumulate -- a real, still-pending ATP main-draw match can silently fall outside even a
    // limit=100 window. Restricting to pending/live keeps this window meaningful for pre-match odds.
    return this.cache.getOrFetch("events:tennis", EVENTS_TTL_MS, () =>
      this.request<EventRow[]>("/events", { sport: "tennis", status: "pending,live", limit: "100" }),
    );
  }

  private async getOddsForEvent(eventId: number): Promise<OddsResponse> {
    return this.cache.getOrFetch(`odds:${eventId}`, ODDS_TTL_MS, () =>
      this.request<OddsResponse>("/odds", { eventId: String(eventId), bookmakers: REQUESTED_BOOKMAKERS }),
    );
  }

  async getMatchOdds(player1Name: string, player2Name: string, scheduledStart: Date | null): Promise<OddsQuote | null> {
    const events = await this.getTennisEvents();

    for (const event of events ?? []) {
      if (scheduledStart) {
        const eventDate = new Date(event.date).getTime();
        if (Number.isNaN(eventDate) || Math.abs(eventDate - scheduledStart.getTime()) > COMMENCE_TIME_TOLERANCE_MS) continue;
      }

      const match = matchPlayersToEvent(player1Name, player2Name, event.home, event.away);
      if (!match) continue;

      let odds: OddsResponse;
      try {
        odds = await this.getOddsForEvent(event.id);
      } catch (err) {
        if (err instanceof OddsProviderRateLimitedError) throw err;
        logger.warn({ err, eventId: event.id }, "Odds-API.io: failed to load odds for one matched event, skipping");
        continue;
      }

      const player1IsHome = match === "aIsPlayer1";
      const homePrices: number[] = [];
      const awayPrices: number[] = [];
      for (const markets of Object.values(odds.bookmakers ?? {})) {
        const moneyline = markets.find((m) => m.name === "ML" || /money ?line|match ?winner/i.test(m.name));
        if (!moneyline) continue;
        for (const line of moneyline.odds ?? []) {
          const home = line.home ? parseFloat(line.home) : NaN;
          const away = line.away ? parseFloat(line.away) : NaN;
          if (Number.isFinite(home) && home > 1) homePrices.push(home);
          if (Number.isFinite(away) && away > 1) awayPrices.push(away);
        }
      }
      if (homePrices.length === 0 || awayPrices.length === 0) continue;

      const avgHome = homePrices.reduce((a, b) => a + b, 0) / homePrices.length;
      const avgAway = awayPrices.reduce((a, b) => a + b, 0) / awayPrices.length;

      return {
        provider: this.name,
        player1DecimalOdds: player1IsHome ? avgHome : avgAway,
        player2DecimalOdds: player1IsHome ? avgAway : avgHome,
        fetchedAt: new Date().toISOString(),
      };
    }

    return null;
  }
}
