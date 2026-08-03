import type { Surface, TournamentLevel } from "./types";

// API-Tennis does not report court surface or tournament tier on `get_fixtures` rows directly,
// but (confirmed live, 2026-07-11 -- verify live, don't trust docs, per prior provider quirks)
// its separate `get_tournaments` endpoint returns real per-tournament surface data
// (`tournament_sourface`, sic) for essentially every tournament it knows about (~10,100 rows
// checked live, keyed by `tournament_key`, which every fixture also carries). That closes the
// coverage gap this table used to have almost entirely: a live 7-day fixtures pull previously
// found only 1 of 43 distinct tournament names resolved via this regex table alone (every
// Challenger/ITF event -- the majority of match volume -- came back `null`). See
// `ApiTennisProvider`'s tournament-surface lookup for how the two sources are combined:
// `tournament_key` lookup is tried FIRST (real, tournament-specific data covering nearly
// everything), and this name-based table is used only when that lookup has no entry.
//
// This table remains the source of truth for tournament LEVEL/tier for the events it lists
// (Grand Slam / Masters1000 / WTA1000 / the more prominent ATP500/WTA500s) since
// `get_tournaments` doesn't expose that granularity -- only a coarse tour/event-type label. For
// everything else, `inferLevelFromEventType` below assigns a defensible default tier from that
// coarse label. Anything that can't be resolved by either path stays `null` -- never guessed.
const TOURNAMENT_SURFACE: Array<{ match: RegExp; surface: Surface; level?: TournamentLevel; tour?: "ATP" | "WTA" }> = [
  { match: /wimbledon/i, surface: "Grass", level: "GrandSlam" },
  { match: /roland garros|french open/i, surface: "Clay", level: "GrandSlam" },
  { match: /\bus open\b/i, surface: "Hard", level: "GrandSlam" },
  { match: /australian open/i, surface: "Hard", level: "GrandSlam" },
  { match: /indian wells/i, surface: "Hard", level: "Masters1000" },
  { match: /miami open/i, surface: "Hard", level: "Masters1000" },
  { match: /monte.?carlo/i, surface: "Clay", level: "Masters1000" },
  { match: /madrid open/i, surface: "Clay", level: "Masters1000" },
  { match: /^rome\b|italian open/i, surface: "Clay", level: "Masters1000" },
  { match: /canadian open|\bmontreal\b|\btoronto\b/i, surface: "Hard", level: "Masters1000" },
  { match: /\bcincinnati\b/i, surface: "Hard", level: "Masters1000" },
  { match: /\bshanghai\b/i, surface: "Hard", level: "Masters1000" },
  { match: /paris masters|\bbercy\b/i, surface: "IndoorHard", level: "Masters1000" },
  { match: /\bhalle\b/i, surface: "Grass", level: "ATP500" },
  { match: /queen'?s club|\bqueens\b/i, surface: "Grass", level: "ATP500" },
  { match: /\bbarcelona\b/i, surface: "Clay", level: "ATP500" },
  // Hamburg: ATP500 clay for men (Hamburg European Open); WTA Hamburg is a separate WTA250 event.
  // Tour-restricted so WTA Hamburg falls through to inferLevelFromEventType (WTA250 default).
  { match: /\bhamburg\b/i, surface: "Clay", level: "ATP500", tour: "ATP" },
  { match: /\bdubai\b/i, surface: "Hard", level: "ATP500" },
  { match: /\bacapulco\b/i, surface: "Hard", level: "ATP500" },
  { match: /\brotterdam\b/i, surface: "IndoorHard", level: "ATP500" },
  { match: /\bbasel\b/i, surface: "IndoorHard", level: "ATP500" },
  { match: /\bvienna\b/i, surface: "IndoorHard", level: "ATP500" },
  { match: /atp finals|\bnitto\b/i, surface: "IndoorHard", level: "Masters1000" },
  { match: /wta finals/i, surface: "IndoorHard", level: "WTA1000" },
  { match: /\bdoha\b|\bqatar\b/i, surface: "Hard", level: "WTA1000" },
  { match: /\bwuhan\b/i, surface: "Hard", level: "WTA1000" },
  { match: /\bbeijing\b/i, surface: "Hard", level: "WTA1000" },
  // ATP250/WTA250 grass/clay swing events -- single fixed venue and surface every year, so a
  // name match is as reliable as the majors/Masters entries above. Level intentionally omitted
  // (falls back to inferLevelFromEventType's ATP250/WTA250 default) since these aren't 500-level.
  { match: /\bnewport\b/i, surface: "Grass" },
  { match: /\bbastad\b|b\u00e5stad/i, surface: "Clay" },
  { match: /\bumag\b/i, surface: "Clay" },
  { match: /\bgstaad\b/i, surface: "Clay" },
  { match: /\biasi\b/i, surface: "Clay" },
  { match: /\bkitzbuhel\b|kitzb\u00fchel/i, surface: "Clay" },
  { match: /\bathens\b/i, surface: "Hard" },
  // Fall indoor hard-court swing (ATP/WTA) -- fixed indoor arenas every year, verified live
  // (2026-07-14) against `get_tournaments`: the provider already tags most of these correctly as
  // "Hard (Indoor)" for their ATP/WTA rows, but a `tour` restriction is still applied wherever the
  // same city name is shared with a *different*, unconfirmed-surface edition on the other tour or
  // with a lower-tier ITF/Challenger event of the same bare name -- never assume both tours (or
  // both tiers) at a shared city name share a surface. Entries with no `tour` are only reachable
  // for real ATP/WTA rows anyway (see the event-type guard in resolveSurfaceAndLevel below), so
  // they're safe to leave unrestricted when both tours that exist there share the surface.
  { match: /\bmarseille\b/i, surface: "IndoorHard", tour: "ATP" },
  { match: /\bmetz\b/i, surface: "IndoorHard", tour: "ATP" },
  { match: /\bsofia\b/i, surface: "IndoorHard" },
  { match: /st\.?\s*petersburg/i, surface: "IndoorHard" },
  { match: /\balmaty\b/i, surface: "IndoorHard", tour: "ATP" },
  { match: /\bastana\b/i, surface: "IndoorHard", tour: "ATP" },
  { match: /\blinz\b/i, surface: "IndoorHard", tour: "WTA" },
  { match: /\btel aviv\b/i, surface: "IndoorHard", tour: "ATP" },
  { match: /z[u\u00fc]rich/i, surface: "IndoorHard", tour: "WTA" },
  // Only the 2020 pandemic-bubble "Cologne" ATP 250 (the bare-name edition; "Cologne 2" is
  // already tagged correctly by the provider) -- both editions were played indoors at Lanxess
  // Arena, but this fixes a real, confirmed-live provider tagging gap for the first one.
  { match: /\bcologne\b/i, surface: "IndoorHard", tour: "ATP" },

  // ── WTA clay swing (spring/summer) ─────────────────────────────────────────
  // Prague: WTA 250 clay (Sparta Prague Academy; runs July)
  { match: /\bprague\b/i, surface: "Clay", level: "WTA250", tour: "WTA" },
  // Palermo: WTA 250 clay (oldest WTA clay event on tour)
  { match: /\bpalermo\b/i, surface: "Clay", level: "WTA250" },
  // Lausanne: WTA 250 clay (runs summer)
  { match: /\blausanne\b/i, surface: "Clay", level: "WTA250" },
  // Warsaw: WTA 250 clay (BNP Paribas Poland Open)
  { match: /\bwarsaw\b|\bwarsawa\b/i, surface: "Clay", level: "WTA250", tour: "WTA" },
  // Iasi: already listed above; added for completeness
  // Rabat: WTA 250 clay (Moroccan Open)
  { match: /\brabat\b/i, surface: "Clay", level: "WTA250" },

  // ── WTA grass swing (June/July) ─────────────────────────────────────────────
  // Eastbourne: WTA 250 grass (Rothesay International)
  { match: /\beastbourne\b/i, surface: "Grass", level: "WTA250" },
  // Birmingham: WTA 250 grass (Rothesay Classic) -- tour-restricted because Birmingham ATP
  // (indoor hard) is a different event on a completely different surface.
  { match: /\bbirmingham\b/i, surface: "Grass", level: "WTA250", tour: "WTA" },
  // Rosmalen/'s-Hertogenbosch: shared ATP/WTA grass event (Libema Open)
  { match: /hertogenbosch|rosmalen|libema/i, surface: "Grass" },
  // Mallorca/Majorca: grass doubles + singles (both tours)
  { match: /\bmallorca\b|\bmajorca\b/i, surface: "Grass" },

  // ── ATP grass swing (June/July) ─────────────────────────────────────────────
  // Nottingham: ATP 250 grass (Rothesay Open) -- tour-restricted; Nottingham WTA is
  // a different tier event and not always held on the same surface.
  { match: /\bnottingham\b/i, surface: "Grass", level: "ATP250", tour: "ATP" },

  // ── ATP 500 hard-court events ────────────────────────────────────────────────
  // Washington DC: ATP 500 hard outdoor (Citi Open)
  { match: /\bwashington\b|\bciti open\b/i, surface: "Hard", level: "ATP500", tour: "ATP" },

  // ── ATP 250 hard-court events ────────────────────────────────────────────────
  { match: /los cabos/i, surface: "Hard", level: "ATP250" },
  { match: /\badelaide\b/i, surface: "Hard", level: "ATP250" },

  // ── WTA 125k hard-court events ───────────────────────────────────────────────
  // Tour-restricted (WTA only) — Memphis and Vancouver are WTA 125k hard-court events;
  // a hypothetical ATP event in either city would be on a different tier and surface.
  // Level set to WTA250 — closest available tier (no WTA125 type); prevents the provider
  // from overriding with a stale "ATP250" label from an old ATP Memphis/Vancouver edition.
  { match: /\bmemphis\b/i, surface: "Hard", level: "WTA250", tour: "WTA" },
  { match: /\bvancouver\b/i, surface: "Hard", level: "WTA250", tour: "WTA" },

  // ── ATP 250 clay events ──────────────────────────────────────────────────────
  { match: /buenos aires/i, surface: "Clay", level: "ATP250" },
  { match: /\bcordoba\b/i, surface: "Clay", level: "ATP250" },
  { match: /\bsantiago\b/i, surface: "Clay", level: "ATP250" },
  { match: /\bestoril\b/i, surface: "Clay", level: "ATP250" },
  { match: /\bmarrakech\b/i, surface: "Clay", level: "ATP250" },
  { match: /\bgeneva\b|\bgen[eè]ve\b/i, surface: "Clay", level: "ATP250" },
  // Lyon: ATP clay event (tour-restricted; WTA Lyon if held would need separate confirmation)
  { match: /\blyon\b/i, surface: "Clay", level: "ATP250", tour: "ATP" },
];

// Verified live (2026-07-11): tournament names for lower-tier events routinely contain
// substrings that collide with the short single-word entries above -- e.g. "Challenger"
// contains "halle" (C-h-a-l-l-e-n-g-e-r), which without a word boundary silently misclassified
// every Challenger-level event as the ATP500 grass event in Halle. As defense in depth beyond
// the \b word boundaries added above, any name containing one of these structural markers of a
// lower-tier/non-tour event is never run through the named table at all -- no major, Masters, or
// 500-level tournament is ever named with these words, so this can only prevent false positives,
// never suppress a real match.
const NEVER_NAMED_TABLE = /challenger|\bitf\b|\bqualif|\bjunior|\bboys\b|\bgirls\b/i;

function inferLevelFromNameOnlyTournament(tournamentName: string): TournamentLevel | null {
  // ITF tournament shorthand appears as "W15", "W35", "M25", etc.
  if (/\b[WM]\d{2,3}\b/i.test(tournamentName)) return "ITF";
  return null;
}

// Verified live (2026-07-14): API-Tennis's `tournament_name` field is NOT reliably prefixed with
// a tier marker -- e.g. some ITF events come back as "M15 St. Petersburg 4" (catches
// NEVER_NAMED_TABLE above), but others come back as a completely bare city name like "Marseille"
// with no ITF/Challenger marker anywhere in the name string, only in the separate
// `event_type_type` field ("Itf Women Singles"). A name-only guard can never catch these. Any
// caller that has real `event_type_type` data (i.e. everything except the legacy name-only
// `inferSurfaceAndLevel` used for OCR'd screenshot text) must gate the named table on this too.
const NEVER_NAMED_TABLE_EVENT_TYPE = /challenger|\bitf\b|\bqualif|\bjunior|\bboys\b|\bgirls\b|exhibition|teams|\bmixed\b/i;

/** Real tour derived from the provider's own event-type label -- null when it doesn't say. */
function tourFromEventType(eventTypeType: string | null | undefined): "ATP" | "WTA" | null {
  const type = eventTypeType ?? "";
  if (/wta/i.test(type)) return "WTA";
  if (/atp/i.test(type)) return "ATP";
  return null;
}

/**
 * Named-table lookup used by `resolveSurfaceAndLevel`, which (unlike the legacy
 * `inferSurfaceAndLevel`) has real `event_type_type` data available. Applies two guards the
 * legacy path can't: skips the table entirely for real non-tour event types (closing the
 * bare-name ITF/Challenger collision above), and skips any tour-restricted entry when the row's
 * real tour doesn't match -- never assumes a shared city name means a shared surface across tours
 * or tiers.
 */
function inferSurfaceAndLevelForResolve(
  tournamentName: string | null | undefined,
  eventTypeType: string | null | undefined,
): { surface: Surface | null; level: TournamentLevel | null } {
  if (!tournamentName || NEVER_NAMED_TABLE.test(tournamentName) || NEVER_NAMED_TABLE_EVENT_TYPE.test(eventTypeType ?? "")) {
    return { surface: null, level: null };
  }
  const tour = tourFromEventType(eventTypeType);
  for (const entry of TOURNAMENT_SURFACE) {
    if (entry.tour && entry.tour !== tour) continue;
    if (entry.match.test(tournamentName)) {
      return { surface: entry.surface, level: entry.level ?? null };
    }
  }
  return { surface: null, level: null };
}

// Deliberately never added to the named table above, even when a specific single-surface city is
// known for a given edition: any "ATP Challenger <city>"/"ITF <event>" name is caught by
// NEVER_NAMED_TABLE and resolved via the real tournament_key -> surface lookup instead (already
// near-complete coverage, per the note at the top of this file). Generic "ATP"/"WTA"/"ITF
// Doubles" tour-wide labels and multi-surface/varies-by-edition events (e.g. a 125K event that
// alternates between clay and hard) have no single correct surface to hardcode -- guessing one
// would violate the "absent, not faked" rule this table follows everywhere else.

/** Legacy name-only lookup -- kept for callers that don't have a tournament_key. Only ever
 * resolves the ~26 majors/Masters/500-level events in the table above. */
export function inferSurfaceAndLevel(tournamentName: string | null | undefined): {
  surface: Surface | null;
  level: TournamentLevel | null;
} {
  if (!tournamentName || NEVER_NAMED_TABLE.test(tournamentName)) return { surface: null, level: null };
  for (const entry of TOURNAMENT_SURFACE) {
    if (entry.match.test(tournamentName)) {
      return { surface: entry.surface, level: entry.level ?? null };
    }
  }
  return { surface: null, level: inferLevelFromNameOnlyTournament(tournamentName) };
}

/**
 * Normalizes the real `tournament_sourface` string from API-Tennis's `get_tournaments` endpoint
 * into our `Surface` enum. Confirmed live (2026-07-11) values include mixed casing ("Hard" /
 * "hard"), indoor variants ("Hard (Indoor)", "Clay (Indoor)", "Grass (Indoor)"), and a handful of
 * non-surface junk values for team-event rows ("- Promotion", "- Play Offs", "", null, etc).
 * Our `Surface` type only distinguishes indoor for hard courts (matching the rest of the app's
 * data model), so indoor clay/grass -- vanishingly rare in practice -- fold into their base
 * surface rather than being fabricated into a category the app doesn't otherwise track.
 * Anything unrecognized returns null rather than guessing.
 */
export function normalizeProviderSurface(raw: string | null | undefined): Surface | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (lower.startsWith("hard")) return lower.includes("indoor") ? "IndoorHard" : "Hard";
  if (lower.startsWith("clay")) return "Clay";
  if (lower.startsWith("grass")) return "Grass";
  return null;
}

/**
 * Assigns a defensible tournament-tier default from API-Tennis's coarse `event_type_type` label
 * (e.g. "Challenger Men Singles", "Itf Women Doubles", "Atp Singles") for tournaments not already
 * classified by the name-based table above (which covers the specific majors/Masters/500-level
 * events at real precision). This is a real classification of the provider's own category label,
 * not a guess about a specific tournament's importance -- an unlisted ATP-tour event defaults to
 * ATP250 (the most common tier by far once Masters/500s are excluded), and likewise WTA250 for
 * WTA-tour events; genuinely non-tour formats (exhibitions, juniors, mixed/team events) get
 * "Other" rather than being forced into a tier that doesn't apply to them.
 */
export function inferLevelFromEventType(eventTypeType: string | undefined | null): TournamentLevel | null {
  const type = eventTypeType ?? "";
  if (!type) return null;
  if (/challenger/i.test(type)) return "Challenger";
  if (/itf/i.test(type)) return "ITF";
  if (/boys|girls|junior|exhibition|mixed|teams/i.test(type)) return "Other";
  if (/wta/i.test(type)) return "WTA250";
  if (/atp/i.test(type)) return "ATP250";
  return "Other";
}

/**
 * Primary surface/level resolver: tries the name-based table first (authoritative, precise tier
 * for the majors/Masters/500-level events it lists), then a real tournament_key -> surface
 * lookup built from `get_tournaments` (covers nearly every tournament the provider knows about,
 * including Challenger/ITF), then falls back to a coarse event-type-based tier default. Only
 * returns null fields when no real signal is available at all -- never fabricated.
 */
export function resolveSurfaceAndLevel(params: {
  tournamentName: string | null | undefined;
  tournamentKey: string | null | undefined;
  eventTypeType: string | null | undefined;
  surfaceByTournamentKey: ReadonlyMap<string, Surface | null>;
}): { surface: Surface | null; level: TournamentLevel | null } {
  const named = inferSurfaceAndLevelForResolve(params.tournamentName, params.eventTypeType);
  if (named.surface !== null) return named;

  const surfaceFromKey = params.tournamentKey ? (params.surfaceByTournamentKey.get(params.tournamentKey) ?? null) : null;
  const level = named.level ?? inferLevelFromEventType(params.eventTypeType);
  return { surface: surfaceFromKey, level };
}
