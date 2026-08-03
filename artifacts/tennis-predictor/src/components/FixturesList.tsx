import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import {
  useGetUpcomingFixtures,
  useGetLiveFixtureScores,
  getGetLiveFixtureScoresQueryKey,
  type Fixture,
  type LiveScore,
} from "@workspace/api-client-react"
import { useLocation } from "wouter"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyDataState } from "./DataWarning"
import { Calendar, Clock, Trash2, Zap, RefreshCw, Wifi, XCircle } from "lucide-react"
import { formatEasternDateTime } from "@/lib/timezone"
import { createPredictionWithIntegrity } from "@/lib/predictionRequestIntegrity"

// Specific TournamentLevel strings + the legacy aggregate shorthands ("atp", "wta", "itf").
// Aggregate shorthands are kept for backward compatibility; specific values are passed through
// directly to matchesFilter for an exact TournamentLevel comparison.
export type TourFilter =
  | "all"
  | "atp"
  | "wta"
  | "itf"
  | "GrandSlam"
  | "Masters1000"
  | "WTA1000"
  | "ATP500"
  | "WTA500"
  | "ATP250"
  | "WTA250"
  | "Challenger"
  | "ITF"

const WTA_LEVELS = new Set(["WTA1000", "WTA500", "WTA250"])
const ATP_LEVELS = new Set(["Masters1000", "ATP500", "ATP250"])
const ITF_LEVELS = new Set(["Challenger", "ITF"])

/**
 * Fixture has no per-match tour/gender field, so ATP/WTA/ITF buckets are inferred from
 * tournamentLevel. GrandSlam draws host both ATP and WTA -- we can't disambiguate a specific
 * fixture without more data, so a Slam match is honestly counted in BOTH buckets rather than
 * guessed into one. Challenger and ITF are folded into a single "ITF" bucket since the requested
 * filter has no separate slot for them.
 *
 * Task #84: a fixture whose level couldn't be resolved at all (null) is NOT the same as a fixture
 * we know doesn't belong to the selected tour -- it's a real, upcoming match we simply can't
 * classify yet (shown with the generic "TOURNAMENT" badge). Hiding it under every specific tour
 * filter silently loses real matches with no indication they exist, so -- same honesty principle
 * as GrandSlam above -- it's shown under every tour filter rather than guessed into one or
 * dropped.
 */
function matchesFilter(fixture: Fixture, filter: TourFilter): boolean {
  if (filter === "all") return true
  const level = fixture.tournamentLevel
  if (!level) return true
  // Aggregate filters
  if (filter === "wta") return WTA_LEVELS.has(level) || level === "GrandSlam"
  if (filter === "atp") return ATP_LEVELS.has(level) || level === "GrandSlam"
  if (filter === "itf") return ITF_LEVELS.has(level)
  // Specific TournamentLevel filter — exact match
  return filter === level
}

/**
 * Task #110: real, independent second filter alongside the tour/level one -- matches on the
 * fixture's actual tournamentName, never a guess. A null/undefined tournamentFilter (or the
 * "all" sentinel) matches everything, same convention as TourFilter's "all".
 */
function matchesTournament(fixture: Fixture, tournamentFilter: string | null): boolean {
  if (!tournamentFilter || tournamentFilter === "all") return true
  return fixture.tournamentName === tournamentFilter
}

/**
 * Sort key for a fixture's real start time. Fixtures with no provider-confirmed time ("Time TBD")
 * sort after every confirmed fixture on the same calendar date, rather than being guessed into
 * some position -- never fabricated, never inherited from another match or the tournament date.
 */
function timeSortKey(fixture: Fixture): number {
  return fixture.scheduledStart ? new Date(fixture.scheduledStart).getTime() : new Date(`${fixture.date}T23:59:59.999Z`).getTime()
}

/**
 * Live (already-started, no winner yet) fixtures sort as a group ahead of every not-yet-started
 * fixture, mirroring the server's own `liveFirstSortKey` -- a live match is the most actionable
 * thing to show first, regardless of how its own start time compares to an upcoming match's.
 */
function liveFirstCompare(a: Fixture, b: Fixture): number {
  const aGroup = a.isLive ? 0 : 1
  const bGroup = b.isLive ? 0 : 1
  return aGroup !== bGroup ? aGroup - bGroup : timeSortKey(a) - timeSortKey(b)
}

function filterFixtures(fixtures: Fixture[], tourFilter: TourFilter, tournamentFilter: string | null): Fixture[] {
  return fixtures
    .filter((fixture) => matchesFilter(fixture, tourFilter) && matchesTournament(fixture, tournamentFilter))
    .sort(liveFirstCompare)
}

/**
 * A fixture is considered "stale/cancelled" when:
 * - It has a confirmed scheduled start time that is in the past
 * - It is NOT flagged as live (meaning the provider never reported it as in-progress)
 * The provider sometimes leaves these in the upcoming window after postponements or cancellations.
 */
function isStaleFixture(fixture: Fixture): boolean {
  if (!fixture.scheduledStart || fixture.isLive) return false
  return new Date(fixture.scheduledStart).getTime() < Date.now()
}

function formatFixtureTime(fixture: Fixture): string {
  if (fixture.scheduledStart) {
    return formatEasternDateTime(fixture.scheduledStart)
  }
  // No confirmed match time — show the tournament date so users know when the match is
  // scheduled without fabricating a time from the raw tournament-start timestamp.
  if (fixture.date) {
    const dateOnly = fixture.date.slice(0, 10) // handles both "2026-08-03" and "2026-08-03T…"
    const dateLabel = new Date(dateOnly + "T12:00:00Z").toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
    })
    return `${dateLabel} · Time TBD`
  }
  return "Time TBD"
}

/** Level badge colour tiers */
function levelVariant(level: string | null | undefined): "default" | "secondary" | "outline" {
  if (!level) return "outline"
  if (level === "GrandSlam") return "default"
  if (level === "Masters1000" || level === "WTA1000") return "secondary"
  return "outline"
}

/** Surface colour class for the accent bar */
function surfaceBarClass(surface: string | null | undefined): string {
  switch (surface) {
    case "Hard": return "bg-[hsl(var(--surface-hard))]"
    case "IndoorHard": return "bg-[hsl(var(--surface-indoor))]"
    case "Clay": return "bg-[hsl(var(--surface-clay))]"
    case "Grass": return "bg-[hsl(var(--surface-grass))]"
    default: return "bg-border"
  }
}

/** Surface colour for the small dot/text label */
function surfaceTextClass(surface: string | null | undefined): string {
  switch (surface) {
    case "Hard": return "text-[hsl(var(--surface-hard))]"
    case "IndoorHard": return "text-[hsl(var(--surface-indoor))]"
    case "Clay": return "text-[hsl(var(--surface-clay))]"
    case "Grass": return "text-[hsl(var(--surface-grass))]"
    default: return "text-muted-foreground"
  }
}

/** Formats a LiveScore's set array as "6-4, 3-2" style string (player1 score first). */
function formatSetScores(score: LiveScore): string {
  return score.sets.map((s) => `${s.player1Games}-${s.player2Games}`).join("  ")
}

// ─── Dismissed fixture IDs (persisted to sessionStorage across soft-navigations) ─────────────
const DISMISSED_KEY = "dismissedFixtureIds.v1"

function loadDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch { return new Set() }
}

function persistDismissed(ids: Set<string>) {
  try { sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids])) } catch {}
}

// ─── Swipeable card ───────────────────────────────────────────────────────────────────────────
/**
 * Wraps a fixture card with swipe-left-to-reveal-delete UX.
 * - Touch start: record finger X
 * - Touch move: translate card left proportionally, revealing the red delete panel underneath
 * - Touch end: snap open if dragged > 40% of panel width, otherwise snap shut
 * - Tap DELETE once → changes label to CONFIRM; tap again → calls onDismiss
 * The card snaps back if swiped right while open.
 */
const SNAP_WIDTH = 80 // px width of the revealed delete panel

function SwipeableCard({
  id,
  onDismiss,
  children,
}: {
  id: string
  onDismiss: () => void
  children: React.ReactNode
}) {
  const [offset, setOffset] = useState(0)
  const [snapped, setSnapped] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const startXRef = useRef<number | null>(null)
  const currentOffsetRef = useRef(0)

  // Keep ref in sync so touchmove can read latest value without stale closure
  useEffect(() => { currentOffsetRef.current = offset }, [offset])

  const handleTouchStart = (e: React.TouchEvent) => {
    startXRef.current = e.touches[0].clientX
    setConfirm(false)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (startXRef.current === null) return
    const delta = e.touches[0].clientX - startXRef.current
    if (snapped) {
      // Already open — allow swiping right to close, don't allow going further left
      const newOffset = Math.min(0, Math.max(-SNAP_WIDTH, -SNAP_WIDTH + delta))
      setOffset(newOffset)
    } else {
      // Closed — only track leftward swipes
      if (delta < 0) setOffset(Math.max(delta, -SNAP_WIDTH))
    }
  }

  const handleTouchEnd = () => {
    const shouldSnap = offset < -(SNAP_WIDTH * 0.4)
    const shouldClose = snapped && offset > -(SNAP_WIDTH * 0.6)
    if (shouldClose) {
      setSnapped(false)
      setOffset(0)
    } else if (shouldSnap || snapped) {
      setSnapped(true)
      setOffset(-SNAP_WIDTH)
    } else {
      setOffset(0)
    }
    startXRef.current = null
  }

  const handleDeleteTap = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm) {
      setConfirm(true)
    } else {
      onDismiss()
    }
  }

  // Tap on card body while open → snap shut
  const handleCardTap = () => {
    if (snapped) {
      setSnapped(false)
      setOffset(0)
      setConfirm(false)
    }
  }

  const isTracking = startXRef.current !== null

  return (
    <div className="relative overflow-hidden rounded-xl">
      {/* Delete panel — always rendered, revealed by translating the card */}
      <div
        className="absolute right-0 top-0 bottom-0 flex items-center justify-center bg-destructive rounded-r-xl"
        style={{ width: SNAP_WIDTH }}
        onClick={handleDeleteTap}
      >
        <div className="flex flex-col items-center gap-1 text-white select-none cursor-pointer">
          <Trash2 className="w-4 h-4" />
          <span className="text-[0.6rem] font-mono font-bold tracking-widest">
            {confirm ? "CONFIRM?" : "REMOVE"}
          </span>
        </div>
      </div>

      {/* Swipeable card layer */}
      <div
        style={{
          transform: `translateX(${offset}px)`,
          transition: isTracking ? "none" : "transform 0.22s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={handleCardTap}
      >
        {children}
      </div>
    </div>
  )
}

// ─── FixturesList ──────────────────────────────────────────────────────────────────────────────

export type FixturesListHandle = {
  /** Refetches fixtures from the server. Used by the Home page's "Go" button. */
  refetch: () => void
}

const INITIAL_PAGE_SIZE = 50
const PAGE_SIZE_INCREMENT = 50

export const FixturesList = forwardRef<
  FixturesListHandle,
  {
    tourFilter?: TourFilter
    tournamentFilter?: string | null
    /**
     * Reports all tournament name+level pairs from the loaded fixtures so callers
     * can build filtered dropdowns. Includes duplicates (one entry per fixture) —
     * callers should deduplicate. Changed from string[] to include level so the
     * Home page can narrow EVENT options based on the selected LEVEL filter.
     */
    onTournamentsChange?: (entries: { name: string; level: string | null | undefined }[]) => void
  }
>(
  function FixturesList({ tourFilter = "all", tournamentFilter = null, onTournamentsChange }, ref) {
  const [limit, setLimit] = useState(INITIAL_PAGE_SIZE)
  // Task: "Refresh Fixtures" must actually pull fresh data, not silently re-serve the provider's
  // 5-minute in-memory cache. `force` flips true only for the single request the button
  // triggers (a distinct query key, so it's a real new network call, never a no-op cache hit),
  // then resets so normal/automatic loads go back through the cache as usual.
  const [force, setForce] = useState(false)
  const { data, isLoading, isError, isFetching } = useGetUpcomingFixtures({ limit, force: force || undefined })
  const fixtures = data?.fixtures
  const hasMore = data?.hasMore ?? false
  const [, setLocation] = useLocation()
  const [predictNowFixtureId, setPredictNowFixtureId] = useState<string | null>(null)
  const [predictNowError, setPredictNowError] = useState<string | null>(null)

  // Dismissed fixture IDs — user-dismissed via swipe-delete or "Remove Cancelled" button
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(loadDismissed)

  // Auto-clear stale dismissals: when the provider returns fixtures but every one of them is
  // in the dismissed set (sessionStorage poisoning across page-loads), silently reset so the
  // list isn't permanently blank without the user pressing Refresh.
  // Guard with a ref so this only fires once per fixtures-load, not on every re-render.
  const autoResetDoneRef = useRef(false)
  useEffect(() => {
    if (!fixtures || fixtures.length === 0) return
    if (autoResetDoneRef.current) return
    const allDismissed = fixtures.every(f => dismissedIds.has(f.id))
    if (allDismissed && dismissedIds.size > 0) {
      setDismissedIds(new Set())
      persistDismissed(new Set())
    }
    autoResetDoneRef.current = true
  }, [fixtures]) // eslint-disable-line react-hooks/exhaustive-deps

  const dismissFixture = (id: string) => {
    setDismissedIds(prev => {
      const next = new Set(prev)
      next.add(id)
      persistDismissed(next)
      return next
    })
  }

  // Count of stale/cancelled fixtures that haven't been dismissed yet
  const staleCount = useMemo(() => {
    return (fixtures ?? []).filter(f => !dismissedIds.has(f.id) && isStaleFixture(f)).length
  }, [fixtures, dismissedIds])

  const handleRemoveCancelled = () => {
    const toRemove = (fixtures ?? []).filter(isStaleFixture).map(f => f.id)
    setDismissedIds(prev => {
      const next = new Set([...prev, ...toRemove])
      persistDismissed(next)
      return next
    })
  }

  const handleRefresh = () => {
    setForce(true)
    // Also clear dismissals on explicit refresh so freshly re-loaded data starts clean
    setDismissedIds(new Set())
    persistDismissed(new Set())
  }

  useEffect(() => {
    if (!force || isFetching) return
    setForce(false)
  }, [force, isFetching])

  useImperativeHandle(ref, () => ({
    refetch: () => { setLimit(INITIAL_PAGE_SIZE); handleRefresh() },
  }), [])

  // Report all tournament name+level pairs to the parent so it can build filtered EVENT options.
  useEffect(() => {
    if (!onTournamentsChange) return
    const entries = (fixtures ?? [])
      .filter((f): f is Fixture & { tournamentName: string } => !!f.tournamentName)
      .map((f) => ({ name: f.tournamentName, level: f.tournamentLevel }))
    onTournamentsChange(entries)
  }, [fixtures, onTournamentsChange])

  const visibleFixtures = useMemo(() => {
    if (!fixtures) return []
    return filterFixtures(fixtures, tourFilter, tournamentFilter)
      .filter(f => !dismissedIds.has(f.id))
  }, [fixtures, tourFilter, tournamentFilter, dismissedIds])

  const groupedFixtures = useMemo(() => {
    const now = Date.now()
    const soonCutoffMs = now + 90 * 60_000
    const today = new Date(now).toISOString().slice(0, 10)

    const liveNow: Fixture[] = []
    const startingSoon: Fixture[] = []
    const laterToday: Fixture[] = []
    const recentlyCompleted: Fixture[] = []
    // Future fixtures grouped by calendar date (YYYY-MM-DD key, sorted ascending in render)
    const upcomingByDate = new Map<string, Fixture[]>()

    for (const fixture of visibleFixtures) {
      const scheduledMs = fixture.scheduledStart ? new Date(fixture.scheduledStart).getTime() : null
      // Normalise to "YYYY-MM-DD" regardless of whether the API returned a bare date or full ISO
      const fixtureDate = (fixture.date ?? "").slice(0, 10)

      if (fixture.isLive) {
        liveNow.push(fixture)
        continue
      }
      if (scheduledMs !== null && !Number.isNaN(scheduledMs) && scheduledMs <= now && now - scheduledMs <= 3 * 60 * 60_000) {
        recentlyCompleted.push(fixture)
        continue
      }
      if (scheduledMs !== null && !Number.isNaN(scheduledMs) && scheduledMs <= soonCutoffMs) {
        startingSoon.push(fixture)
        continue
      }
      if (fixtureDate === today) {
        laterToday.push(fixture)
        continue
      }
      // Future date — group by YYYY-MM-DD so each day gets its own labeled section
      const bucket = upcomingByDate.get(fixtureDate) ?? []
      bucket.push(fixture)
      upcomingByDate.set(fixtureDate, bucket)
    }

    return { liveNow, startingSoon, laterToday, recentlyCompleted, upcomingByDate }
  }, [visibleFixtures])

  const diagnostics = useMemo(() => {
    const providerFixturesReceived = fixtures?.length ?? 0
    const filteredByTourOrEvent = (fixtures ?? []).filter((f) => !matchesFilter(f, tourFilter) || !matchesTournament(f, tournamentFilter)).length
    const excludedDismissed = (fixtures ?? []).filter((f) => dismissedIds.has(f.id)).length
    const retained = visibleFixtures.length
    return {
      providerFixturesReceived,
      retained,
      filteredByTourOrEvent,
      excludedDismissed,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lastRefresh: new Date().toISOString(),
    }
  }, [fixtures, tourFilter, tournamentFilter, dismissedIds, visibleFixtures.length])

  // Live score polling — only fires when there are live fixtures, every 6 seconds.
  const liveFixtureIds = useMemo(
    () => (fixtures ?? []).filter((f) => f.isLive).map((f) => f.id),
    [fixtures],
  )
  const liveScoresIds = liveFixtureIds.join(",")
  const { data: liveScoresData } = useGetLiveFixtureScores(
    { ids: liveScoresIds },
    {
      query: {
        queryKey: getGetLiveFixtureScoresQueryKey({ ids: liveScoresIds }),
        refetchInterval: 6000,
        enabled: liveFixtureIds.length > 0,
      },
    },
  )
  const liveScores = liveScoresData?.scores

  const handlePredictNow = async (fixture: Fixture) => {
    setPredictNowError(null)
    setPredictNowFixtureId(fixture.id)

    try {
      const prediction = await createPredictionWithIntegrity(
        {
          player1Id: fixture.player1Id,
          player2Id: fixture.player2Id,
          surface: fixture.surface ?? "Hard",
          matchFormat: fixture.matchFormat ?? (fixture.tournamentLevel === "GrandSlam" ? "BestOf5" : "BestOf3"),
          tournamentLevel: fixture.tournamentLevel ?? undefined,
          tournamentName: fixture.tournamentName ?? null,
        },
        {
          requestMatchId: `fixture:${fixture.id}`,
          submittedPlayer1Name: fixture.player1Name,
          submittedPlayer2Name: fixture.player2Name,
        },
      )
      setPredictNowFixtureId(null)
      setLocation(`/predictions/${prediction.id}?from=home`)
    } catch {
      setPredictNowFixtureId(null)
      setPredictNowError(fixture.id)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-2.5">
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="h-[7rem] rounded-xl overflow-hidden flex">
            <Skeleton className="w-1 self-stretch rounded-none" />
            <Skeleton className="flex-1 rounded-none rounded-r-xl" />
          </div>
        ))}
      </div>
    )
  }

  if (isError) {
    return <EmptyDataState message="Unable to load upcoming fixtures" icon={Calendar} />
  }

  return (
    <div className="space-y-2.5">
      {/* Toolbar: cancelled removal + refresh */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {staleCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="font-mono text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5 h-8"
            onClick={handleRemoveCancelled}
          >
            <XCircle className="w-3.5 h-3.5" />
            REMOVE {staleCount} CANCELLED
          </Button>
        ) : (
          <div /> /* spacer */
        )}
        <Button
          variant="ghost"
          size="sm"
          className="font-mono text-xs text-muted-foreground gap-1.5 h-8"
          disabled={isFetching}
          onClick={handleRefresh}
        >
          <RefreshCw className={`w-3 h-3 ${isFetching ? "animate-spin" : ""}`} />
          REFRESH
        </Button>
      </div>

      <div className="rounded-xl border border-border/50 bg-secondary/20 p-3 text-[11px] font-mono text-muted-foreground">
        <div className="font-bold tracking-wider text-foreground">Fixtures Diagnostics</div>
        <div className="mt-1.5 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1">
          <span>Provider received: {diagnostics.providerFixturesReceived}</span>
          <span>Retained: {diagnostics.retained}</span>
          <span>Filtered: {diagnostics.filteredByTourOrEvent}</span>
          <span>Dismissed: {diagnostics.excludedDismissed}</span>
          <span>Timezone: {diagnostics.timezone}</span>
          <span>Last refresh: {new Date(diagnostics.lastRefresh).toLocaleTimeString()}</span>
        </div>
      </div>

      {visibleFixtures.length === 0 ? (
        <div className="p-10 border border-dashed border-border/60 rounded-xl text-center text-muted-foreground font-mono text-xs tracking-widest uppercase">
          No upcoming fixtures found
        </div>
      ) : (
        [
          { title: "Live Now", items: groupedFixtures.liveNow },
          { title: "Starting Soon", items: groupedFixtures.startingSoon },
          { title: "Later Today", items: groupedFixtures.laterToday },
          { title: "Recently Completed", items: groupedFixtures.recentlyCompleted },
          // Future dates sorted ascending — each calendar day becomes its own labeled section
          ...[...groupedFixtures.upcomingByDate.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([dateStr, items]) => ({
              title: new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
                timeZone: "America/New_York",
                weekday: "short",
                month: "short",
                day: "numeric",
              }),
              items,
            })),
        ].map((group) => {
          if (group.items.length === 0) return null
          return (
            <div key={group.title} className="space-y-2">
              <div className="text-[11px] font-mono font-bold tracking-[0.18em] uppercase text-muted-foreground px-1">{group.title} ({group.items.length})</div>
              {group.items.map((fixture) => {
          const liveScore = liveScores?.[fixture.id]
          return (
            <SwipeableCard key={fixture.id} id={fixture.id} onDismiss={() => dismissFixture(fixture.id)}>
              <div
                className="group flex rounded-xl border border-border/60 bg-card overflow-hidden hover:border-primary/40 hover:shadow-sm transition-all duration-200"
              >
                {/* Surface accent bar */}
                <div className={`w-[3px] shrink-0 self-stretch ${surfaceBarClass(fixture.surface)}`} />

                {/* Main content */}
                <div className="flex-1 flex flex-col sm:flex-row min-w-0">
                  <div className="flex-1 p-4 flex flex-col justify-between gap-2.5 min-w-0">
                    {/* Meta row: level + tournament + round + surface */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] font-mono text-muted-foreground">
                      <Badge
                        variant={levelVariant(fixture.tournamentLevel)}
                        className="rounded-sm font-mono text-[0.625rem] px-1.5 py-0 h-4 leading-none border-primary/40 bg-secondary/80 text-secondary-foreground"
                      >
                        {fixture.tournamentLevel || 'TOURNAMENT'}
                      </Badge>
                      {fixture.tournamentName && (
                        <span className="truncate min-w-0 sm:max-w-[180px] text-muted-foreground/80">
                          {fixture.tournamentName}
                        </span>
                      )}
                      {fixture.round && (
                        <>
                          <span className="text-border/60">·</span>
                          <span className="text-muted-foreground/70">{fixture.round}</span>
                        </>
                      )}
                      <span className="text-border/60">·</span>
                      <span className={`font-semibold ${surfaceTextClass(fixture.surface)}`}>
                        {fixture.surface ?? 'Unknown'}{fixture.indoor ? ' (Indoor)' : ''}
                      </span>
                    </div>

                    {/* Time row — dedicated, always visible, larger than meta text */}
                    <div className="flex items-center gap-1.5">
                      {fixture.isLive ? (
                        <span className="inline-flex items-center gap-1.5 font-bold text-primary text-[0.75rem] font-mono">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
                          </span>
                          LIVE NOW
                        </span>
                      ) : (
                        <>
                          <Clock className={`w-3.5 h-3.5 shrink-0 ${fixture.scheduledStart ? "text-primary/70" : "text-muted-foreground/40"}`} />
                          <span className={`text-[0.75rem] font-mono font-semibold ${
                            fixture.scheduledStart
                              ? "text-foreground/80"
                              : "text-muted-foreground/50 italic"
                          }`}>
                            {formatFixtureTime(fixture)}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Players */}
                    <div className="space-y-1">
                      <div className="font-display font-bold text-[1.0625rem] leading-snug truncate">{fixture.player1Name}</div>
                      <div className="text-[0.6875rem] font-mono text-muted-foreground/50 uppercase tracking-widest font-bold">vs</div>
                      <div className="font-display font-bold text-[1.0625rem] leading-snug truncate">{fixture.player2Name}</div>
                    </div>

                    {/* Live set scores */}
                    {fixture.isLive && liveScore && liveScore.sets.length > 0 && (
                      <div className="flex items-center gap-3 text-[0.6875rem] font-mono">
                        <span className="font-bold text-destructive tabular-nums tracking-wide">
                          {formatSetScores(liveScore)}
                        </span>
                        {liveScore.statusText && (
                          <span className="text-muted-foreground/70">{liveScore.statusText}</span>
                        )}
                      </div>
                    )}

                    {predictNowError === fixture.id && (
                      <p className="text-[0.6875rem] text-destructive font-mono">Predict Now failed — provider may be unavailable.</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex sm:flex-col items-center justify-end gap-2 px-4 py-3 sm:px-3 sm:py-4 bg-secondary/30 border-t sm:border-t-0 sm:border-l border-border/40 sm:min-w-[7.5rem]">
                    <Button
                      size="sm"
                      className="flex-1 sm:w-full font-mono font-bold text-[0.6875rem] h-9 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm gap-1.5"
                      disabled={predictNowFixtureId === fixture.id}
                      onClick={(e) => { e.stopPropagation(); handlePredictNow(fixture) }}
                    >
                      {predictNowFixtureId === fixture.id ? (
                        <RefreshCw className="w-3 h-3 animate-spin" />
                      ) : (
                        <Zap className="w-3 h-3" />
                      )}
                      PREDICT
                    </Button>
                  </div>
                </div>
              </div>
            </SwipeableCard>
          )
              })}
            </div>
          )
        })
      )}

      {hasMore && (
        <div className="flex justify-center pt-3">
          <Button
            variant="outline"
            size="sm"
            className="font-mono text-xs gap-1.5 h-9"
            disabled={isFetching}
            onClick={() => setLimit((l) => l + PAGE_SIZE_INCREMENT)}
          >
            {isFetching ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
            LOAD MORE MATCHES
          </Button>
        </div>
      )}
    </div>
  )
})
