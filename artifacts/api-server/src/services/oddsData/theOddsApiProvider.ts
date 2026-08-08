import { logger } from "../../lib/logger";
import { withRetry, isTransientError } from "../../lib/retry";
import { CircuitBreaker } from "../../lib/circuitBreaker";
import { TtlCache } from "../tennisData/cache";
import { matchPlayersToEvent } from "./nameMatch";
import { OddsProviderRateLimitedError, OddsProviderUnavailableError, type OddsProvider, type OddsProviderStatusInfo, type OddsQuote } from "./types";

const BASE_URL = "https://api.the-odds-api.com/v4";
const SPORTS_TTL_MS = 6 * 60 * 60 * 1000; // in-season tennis tournaments change slowly
const ODDS_TTL_MS = 2 * 60 * 60 * 1000;
// A provider event's commence_time must fall within this window of our fixture's own scheduled
// start to be trusted as the SAME match -- guards against matching e.g. an earlier-round meeting
// between the same two players in a different event.
const COMMENCE_TIME_TOLERANCE_MS = 36 * 60 * 60 * 1000;

interface SportRow {
  key: string;
  group: string;
  active: boolean;
}

interface OutcomeRow {
  name: string;
  price: number;
}

interface MarketRow {
  key: string;
  outcomes: OutcomeRow[];
}

interface BookmakerRow {
  key: string;
  markets: MarketRow[];
}

interface EventRow {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: BookmakerRow[];
}

/**
 * Real-market pre-match odds from The Odds API (https://the-odds-api.com), used as the primary
 * odds source. Tennis on this provider has no single generic "tennis" sport key -- each covered
 * tournament (Grand Slams, ATP/WTA 500+) is its own sport key like `tennis_atp_wimbledon`, so a
 * lookup has to enumerate the currently in-season tennis sport keys and search each one's events.
 */
export class TheOddsApiProvider implements OddsProvider {
  readonly name = "The Odds API";

  private apiKey: string;
  private cache = new TtlCache();
  private lastSuccessfulCallAt: string | null = null;
  private lastError: string | null = null;
  private readonly breaker = new CircuitBreaker("the-odds-api", {
    failureThreshold: 4,
    openDurationMs: 60_000,
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
              throw err;
            }
            if (response.status === 401 || response.status === 429) {
              throw Object.assign(
                new OddsProviderRateLimitedError(
                  `The Odds API reported ${response.status} (rate/usage limit or invalid key)`,
                ),
                { status: response.status },
              );
            }
            if (!response.ok) {
              throw Object.assign(
                new Error(`The Odds API responded with HTTP ${response.status}`),
                { status: response.status },
              );
            }
            return (await response.json()) as T;
          },
          {
            attempts: 3,
            baseDelayMs: 400,
            maxDelayMs: 5_000,
            retryOn: (err) =>
              !(err instanceof OddsProviderRateLimitedError) && isTransientError(err),
            onRetry: (err, attempt) =>
              logger.warn({ err, path, attempt }, "The Odds API request retrying"),
          },
        ),
      );
      this.lastSuccessfulCallAt = new Date().toISOString();
      this.lastError = null;
      return body;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error calling The Odds API";
      this.lastError = message;
      if (err instanceof OddsProviderRateLimitedError) throw err;
      throw new OddsProviderUnavailableError(message);
    }
  }

  private async getActiveTennisSportKeys(): Promise<string[]> {
    return this.cache.getOrFetch("sports", SPORTS_TTL_MS, async () => {
      const sports = await this.request<SportRow[]>("/sports");
      return (sports ?? []).filter((s) => s.active && s.group === "Tennis").map((s) => s.key);
    });
  }

  private async getEventsForSport(sportKey: string): Promise<EventRow[]> {
    return this.cache.getOrFetch(`odds:${sportKey}`, ODDS_TTL_MS, () =>
      this.request<EventRow[]>(`/sports/${sportKey}/odds`, { regions: "us", markets: "h2h", oddsFormat: "decimal" }),
    );
  }

  async getMatchOdds(player1Name: string, player2Name: string, scheduledStart: Date | null): Promise<OddsQuote | null> {
    const sportKeys = await this.getActiveTennisSportKeys();

    for (const sportKey of sportKeys) {
      let events: EventRow[];
      try {
        events = await this.getEventsForSport(sportKey);
      } catch (err) {
        // A single covered tournament failing to load (transient blip, no events published yet)
        // shouldn't abort the whole lookup across every other in-season tennis tournament -- but
        // a rate-limit hit means every subsequent call will fail identically, so propagate that.
        if (err instanceof OddsProviderRateLimitedError) throw err;
        logger.warn({ err, sportKey }, "The Odds API: failed to load odds for one tennis sport key, skipping");
        continue;
      }

      for (const event of events ?? []) {
        if (scheduledStart) {
          const commence = new Date(event.commence_time).getTime();
          if (Number.isNaN(commence) || Math.abs(commence - scheduledStart.getTime()) > COMMENCE_TIME_TOLERANCE_MS) continue;
        }

        const match = matchPlayersToEvent(player1Name, player2Name, event.home_team, event.away_team);
        if (!match) continue;

        const player1IsHome = match === "aIsPlayer1";
        const homePrices: number[] = [];
        const awayPrices: number[] = [];
        for (const bookmaker of event.bookmakers ?? []) {
          const h2h = bookmaker.markets?.find((m) => m.key === "h2h");
          if (!h2h) continue;
          const home = h2h.outcomes.find((o) => o.name === event.home_team);
          const away = h2h.outcomes.find((o) => o.name === event.away_team);
          if (home && home.price > 1) homePrices.push(home.price);
          if (away && away.price > 1) awayPrices.push(away.price);
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
    }

    return null;
  }
}
