import { useEffect, useState } from "react"
import { useLocation } from "wouter"
import { searchPlayers, type PlayerSummary, type Surface, type TournamentLevel } from "@workspace/api-client-react"
import { parseMatchupLines, type ParsedMatchupLine } from "@/lib/matchupLineParser"
import { expandNickname, isGrandSlam } from "@/lib/grandSlam"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { ClipboardPaste, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Activity, HelpCircle } from "lucide-react"
import { buildClientMatchId, createPredictionWithIntegrity } from "@/lib/predictionRequestIntegrity"

const STORAGE_KEY = "pasteMatchupPredictor.text.v1"
const RESOLVE_CONCURRENCY = 4

type LineStatus =
  | "resolving"
  | "resolved"
  | "ambiguous"
  | "not-found"
  | "parse-error"
  | "predict-pending"
  | "predict-success"
  | "predict-error"

interface PasteLine {
  key: string
  raw: string
  parsed: ParsedMatchupLine
  status: LineStatus
  player1: PlayerSummary | null
  player2: PlayerSummary | null
  errorMessage: string | null
  predictionId: number | null
  resolvedTournament: string | null
  /** Auto-detected from the tournament name via /api/tournament/surface */
  detectedSurface: Surface | null
  detectedLevel: TournamentLevel | null
  /** Date annotation extracted from the paste line — display only, not used to gate prediction. */
  parsedDate: string | null
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let nextIndex = 0
  async function runNext(): Promise<void> {
    const index = nextIndex++
    if (index >= items.length) return
    await worker(items[index], index)
    await runNext()
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext))
}

/**
 * Normalize a player name for fuzzy comparison:
 * - NFD decompose + strip combining diacritical marks (ñ→n, é→e, ø→o, etc.)
 * - Collapse whitespace
 * - Lowercase
 * This lets "Carreño Busta" match against "Carreno Busta", "García" match "Garcia", etc.
 */
function normName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")  // strip combining diacritical marks
    .replace(/[''ʼ\u2019]/g, "") // strip apostrophes (O'Brien → OBrien)
    .replace(/-/g, " ")          // expand hyphens to spaces (Haddad-Maia → Haddad Maia)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
}

/**
 * Resolves a pasted player name to a real PlayerSummary by name search.
 *
 * Resolution pipeline (tried in order):
 * 1. Exact case+diacritic-insensitive match on the full normalized name.
 * 2. Word-subset match: all query words appear in the candidate name (handles surname-only, etc.).
 * 3. Initial-aware match: strips leading initials from the query ("A. Shevchenko" → "Shevchenko"),
 *    checks word-subset, then verifies the initial matches the candidate's first name letter.
 * 4. Nickname expansion ("Rafa" → "Rafael Nadal") before retrying steps 1–3.
 *
 * Returns null (with a user-readable error) for ambiguous or not-found cases. Never guesses.
 */
async function resolvePlayerByName(name: string): Promise<{ player: PlayerSummary | null; error: string | null }> {
  try {
    if (name.trim().length < 2) return { player: null, error: `"${name}" is too short to search` }

    // Run the full resolution pipeline with a given query string.
    /**
     * When multiple candidates all share the same normalized name they are the same player
     * recorded under different MatchStat season IDs. Rather than reporting "ambiguous",
     * collapse to the single best candidate: prefer live > ranked > lower rank number.
     * When candidates have genuinely different names it remains "ambiguous".
     */
    function resolveMultiple(hits: PlayerSummary[]): PlayerSummary | "ambiguous" {
      if (hits.length === 0) return "ambiguous"
      const firstName = normName(hits[0]!.name)
      if (!hits.every((c) => normName(c.name) === firstName)) return "ambiguous"
      // All same name — same player, different historical IDs. Pick best.
      return hits.slice().sort((a, b) => {
        const aLive = (a.source ?? "live") !== "historical-match" ? 0 : 1
        const bLive = (b.source ?? "live") !== "historical-match" ? 0 : 1
        if (aLive !== bLive) return aLive - bLive
        const aR = a.currentRank != null ? 0 : 1
        const bR = b.currentRank != null ? 0 : 1
        if (aR !== bR) return aR - bR
        if (a.currentRank != null && b.currentRank != null) return a.currentRank - b.currentRank
        return 0
      })[0]!
    }

    async function attempt(searchName: string): Promise<PlayerSummary | null | "ambiguous"> {
      const candidates = await searchPlayers({ query: searchName })

      const qNorm = normName(searchName)

      // 1. Exact normalized match
      const exact = candidates.filter((c) => normName(c.name) === qNorm)
      if (exact.length === 1) return exact[0]
      if (exact.length > 1) return resolveMultiple(exact)

      // 2. Word-subset match (all query words must appear in candidate)
      const words = qNorm.split(" ").filter(Boolean)
      const confident = candidates.filter((c) => {
        const cWords = new Set(normName(c.name).split(" ").filter(Boolean))
        return words.length > 0 && words.every((w) => cWords.has(w))
      })
      if (confident.length === 1) return confident[0]
      if (confident.length > 1) return resolveMultiple(confident)

      // 3. Initial-aware match: split off leading "X." tokens, match on remaining words,
      //    then verify any initials match the candidate's first name letter.
      //    Handles query="A. Smith" / candidate="Alexander Smith".
      const initialPattern = /^[a-z]\.?$/
      const initials = words.filter((w) => initialPattern.test(w)).map((w) => w.replace(".", ""))
      const substantive = words.filter((w) => !initialPattern.test(w))
      if (substantive.length > 0 && substantive.length < words.length) {
        const bySubstantive = candidates.filter((c) => {
          const cWords = normName(c.name).split(" ").filter(Boolean)
          const cWordSet = new Set(cWords)
          if (!substantive.every((w) => cWordSet.has(w))) return false
          if (initials.length === 0) return true
          const firstLetter = cWords[0]?.[0] ?? ""
          return initials.every((ini) => ini === firstLetter)
        })
        if (bySubstantive.length === 1) return bySubstantive[0]
        if (bySubstantive.length > 1) return resolveMultiple(bySubstantive)
      }

      // 4. Reverse-initial match: the candidate's first name is an initial ("T. Kokkinakis")
      //    but the query provides the full name ("Thanasi Kokkinakis"). Match when:
      //    - Candidate first token is a single letter (with optional period)
      //    - Query first word starts with that same letter
      //    - All remaining candidate words appear as query words
      if (words.length >= 2) {
        const byReverseInitial = candidates.filter((c) => {
          const cWords = normName(c.name).split(" ").filter(Boolean)
          if (cWords.length < 2) return false
          const cFirst = cWords[0]!.replace(".", "")
          if (cFirst.length !== 1) return false
          if (!words[0] || words[0][0] !== cFirst) return false
          const qWordSet = new Set(words)
          return cWords.slice(1).every((w) => qWordSet.has(w))
        })
        if (byReverseInitial.length === 1) return byReverseInitial[0]
        if (byReverseInitial.length > 1) return resolveMultiple(byReverseInitial)
      }

      return null
    }

    // Try with original name first, then with nickname expansion.
    const direct = await attempt(name)
    if (direct === "ambiguous") return { player: null, error: `"${name}" matches multiple players — use Player Search to select` }
    if (direct) return { player: direct, error: null }

    const expandedName = expandNickname(name)
    if (expandedName !== name) {
      const expanded = await attempt(expandedName)
      if (expanded === "ambiguous") return { player: null, error: `"${name}" matches multiple players — use Player Search to select` }
      if (expanded) return { player: expanded, error: null }
    }

    return { player: null, error: `"${name}" not found — check spelling or use Player Search` }
  } catch {
    return { player: null, error: `Search failed for "${name}" — try again` }
  }
}

/**
 * Calls GET /api/tournament/surface?name=... to detect surface + level from a tournament name.
 * Returns null on any error so a failed lookup never blocks the rest of the resolve flow.
 */
async function lookupTournamentSurface(
  name: string,
): Promise<{ surface: Surface | null; level: TournamentLevel | null } | null> {
  try {
    const res = await fetch(`/api/tournament/surface?${new URLSearchParams({ name })}`)
    if (!res.ok) return null
    return (await res.json()) as { surface: Surface | null; level: TournamentLevel | null }
  } catch {
    return null
  }
}

/** Label shown per surface type */
const SURFACE_LABEL: Record<Surface, string> = {
  Hard: "Hard",
  Clay: "Clay",
  Grass: "Grass",
  IndoorHard: "Indoor",
}

/**
 * Multi-line paste → prediction batch.
 * Accepts one matchup per line in any of the supported formats (A vs B, A v B, A - B, A — B,
 * A versus B, with optional (Tournament) suffix). Resolves player names against the live player
 * search and shows per-line status. Never fails the whole batch on one bad line.
 * Pasted text is preserved in sessionStorage across page refreshes.
 * Tournament names are auto-resolved to surface + level via the backend lookup.
 */
export function PasteMatchupPredictor() {
  const [text, setText] = useState("")
  const [lines, setLines] = useState<PasteLine[]>([])
  const [isResolving, setIsResolving] = useState(false)
  const [isPredicting, setIsPredicting] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [, setLocation] = useLocation()

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY)
      if (saved) setText(saved)
    } catch { /* best-effort */ }
  }, [])

  const handleTextChange = (newText: string) => {
    setText(newText)
    try { sessionStorage.setItem(STORAGE_KEY, newText) } catch { /* best-effort */ }
  }

  const handleResolve = async () => {
    setBatchError(null)
    const parsed = parseMatchupLines(text)

    if (parsed.length === 0) {
      setBatchError('No matchup lines found. Paste one or more lines like "Player A vs Player B".')
      return
    }

    // Propagate tournament context from section headers (e.g. "ATP Estoril") to the matchup
    // lines that follow them. Headers are silently skipped — never shown as parse errors.
    let currentHeaderTournament: string | null = null
    const initialLines: PasteLine[] = []
    parsed.forEach((p, i) => {
      if (p.isTournamentHeader) {
        // Update running context, don't add a row for the header itself.
        currentHeaderTournament = p.tournamentName
        return
      }
      // Matchup line: use its own tournament name if present, otherwise fall back to the
      // most recent section header.
      const resolvedTournament = p.tournamentName ?? currentHeaderTournament
      initialLines.push({
        key: `line-${i}-${crypto.randomUUID()}`,
        raw: p.raw,
        parsed: { ...p, tournamentName: resolvedTournament },
        status: p.parseError ? ("parse-error" as LineStatus) : ("resolving" as LineStatus),
        player1: null,
        player2: null,
        errorMessage: p.parseError,
        predictionId: null,
        resolvedTournament,
        detectedSurface: null,
        detectedLevel: null,
        parsedDate: p.matchDate ?? null,
      })
    })

    if (initialLines.length === 0) {
      setBatchError('No matchup lines found. Paste one or more lines like "Player A vs Player B".')
      return
    }

    setLines(initialLines)
    setIsResolving(true)

    const resolvable = initialLines.filter((l) => !l.parsed.parseError && l.parsed.playerAName && l.parsed.playerBName)

    await runWithConcurrency(resolvable, RESOLVE_CONCURRENCY, async (lineItem) => {
      const { parsed: p } = lineItem
      if (!p.playerAName || !p.playerBName) return

      // Resolve players and tournament surface concurrently
      const [resA, resB, surfaceResult] = await Promise.all([
        resolvePlayerByName(p.playerAName),
        resolvePlayerByName(p.playerBName),
        p.tournamentName ? lookupTournamentSurface(p.tournamentName) : Promise.resolve(null),
      ])

      let status: LineStatus
      let errorMessage: string | null = null

      if (resA.player && resB.player) {
        if (resA.player.id === resB.player.id) {
          status = "ambiguous"
          errorMessage = "Both names resolved to the same player — check the matchup"
        } else {
          status = "resolved"
        }
      } else {
        const errs = [resA.error, resB.error].filter(Boolean)
        status = "not-found"
        errorMessage = errs.join(" | ")
      }

      setLines((prev) =>
        prev.map((l) =>
          l.key === lineItem.key
            ? {
                ...l,
                status,
                player1: resA.player,
                player2: resB.player,
                errorMessage,
                detectedSurface: surfaceResult?.surface ?? null,
                detectedLevel: surfaceResult?.level ?? null,
              }
            : l,
        ),
      )
    })

    setIsResolving(false)
  }

  const handlePredict = async () => {
    setBatchError(null)
    const toPredict = lines.filter((l) => l.status === "resolved" && l.player1 && l.player2)
    if (toPredict.length === 0) return

    setIsPredicting(true)
    setLines((prev) => prev.map((l) => (l.status === "resolved" ? { ...l, status: "predict-pending" as LineStatus } : l)))

    const resultIds: number[] = []

    for (const line of toPredict) {
      if (!line.player1 || !line.player2) continue
      try {
        // Grand Slam ATP men's matches are Best-of-5; all others are Best-of-3.
        const isATPMatch = line.player1?.tour === "ATP" || line.player2?.tour === "ATP"
        const matchFormat = isGrandSlam(line.resolvedTournament) && isATPMatch ? "BestOf5" : "BestOf3"
        const requestMatchId = buildClientMatchId({
          source: "paste",
          player1Id: line.player1.id,
          player2Id: line.player2.id,
          tournamentName: line.resolvedTournament,
          surface: line.detectedSurface ?? "Hard",
          matchFormat,
        })
        const prediction = await createPredictionWithIntegrity(
          {
            player1Id: line.player1.id,
            player2Id: line.player2.id,
            // Use auto-detected surface/level when available; fall back to sensible defaults.
            surface: line.detectedSurface ?? "Hard",
            matchFormat,
            tournamentLevel: line.detectedLevel ?? "ATP250",
            tournamentName: line.resolvedTournament,
          },
          {
            requestMatchId,
            submittedPlayer1Name: line.player1.name,
            submittedPlayer2Name: line.player2.name,
          },
        )
        resultIds.push(prediction.id)
        setLines((prev) =>
          prev.map((l) => (l.key === line.key ? { ...l, status: "predict-success" as LineStatus, predictionId: prediction.id } : l)),
        )
      } catch {
        setLines((prev) =>
          prev.map((l) =>
            l.key === line.key
              ? { ...l, status: "predict-error" as LineStatus, errorMessage: "Failed to run prediction engine for this matchup" }
              : l,
          ),
        )
      }
    }

    setIsPredicting(false)

    if (resultIds.length > 0) {
      setLocation(`/predictions/${resultIds[0]}?batch=${resultIds.join(",")}`)
    } else {
      setBatchError("None of the matchups could be predicted. Check the errors below.")
    }
  }

  const handleReset = () => {
    setLines([])
    setBatchError(null)
  }

  const pendingPredictCount = lines.filter((l) => l.status === "resolved").length
  const resolvingCount = lines.filter((l) => l.status === "resolving").length
  const notFoundCount = lines.filter((l) => l.status === "not-found" || l.status === "ambiguous").length
  const parseErrorCount = lines.filter((l) => l.status === "parse-error").length

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground font-mono">
        Paste one matchup per line — supported formats:{" "}
        <code className="bg-secondary/60 px-1 rounded text-[0.6875rem]">A vs B</code>,{" "}
        <code className="bg-secondary/60 px-1 rounded text-[0.6875rem]">A v B</code>,{" "}
        <code className="bg-secondary/60 px-1 rounded text-[0.6875rem]">A versus B</code>,{" "}
        <code className="bg-secondary/60 px-1 rounded text-[0.6875rem]">A - B</code>,{" "}
        <code className="bg-secondary/60 px-1 rounded text-[0.6875rem]">A — B</code>,{" "}
        with optional{" "}
        <code className="bg-secondary/60 px-1 rounded text-[0.6875rem]">(Tournament)</code> suffix.
        Surface and level are auto-detected from the tournament name.
      </p>

      <Textarea
        value={text}
        onChange={(e) => handleTextChange(e.target.value)}
        placeholder={"Alcaraz vs Sinner\nDjokovic v Zverev (Wimbledon)\nSwiatek — Sabalenka (Prague)"}
        className="min-h-[120px] font-mono text-sm bg-background/50 resize-y"
        disabled={isResolving || isPredicting}
      />

      {lines.length > 0 && (
        <div className="flex flex-wrap gap-2 text-[11px] font-mono text-muted-foreground">
          {pendingPredictCount > 0 && (
            <span className="flex items-center gap-1 text-success">
              <CheckCircle2 className="w-3 h-3" /> {pendingPredictCount} ready
            </span>
          )}
          {resolvingCount > 0 && (
            <span className="flex items-center gap-1 animate-pulse">
              <RefreshCw className="w-3 h-3" /> {resolvingCount} resolving
            </span>
          )}
          {notFoundCount > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <XCircle className="w-3 h-3" /> {notFoundCount} not found
            </span>
          )}
          {parseErrorCount > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <AlertTriangle className="w-3 h-3" /> {parseErrorCount} parse error
            </span>
          )}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {lines.length === 0 ? (
          <Button
            size="sm"
            variant="accent"
            className="font-mono gap-1.5"
            disabled={!text.trim() || isResolving}
            onClick={handleResolve}
          >
            {isResolving ? (
              <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Resolving...</>
            ) : (
              <><ClipboardPaste className="w-3.5 h-3.5" /> RESOLVE PLAYERS</>
            )}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="accent"
              className="font-mono gap-1.5"
              disabled={isPredicting || isResolving || pendingPredictCount === 0}
              onClick={handlePredict}
            >
              {isPredicting ? (
                <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Predicting...</>
              ) : (
                <><Activity className="w-3.5 h-3.5" /> PREDICT {pendingPredictCount} MATCHUP{pendingPredictCount === 1 ? "" : "S"}</>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="font-mono text-xs gap-1.5"
              disabled={isResolving || isPredicting}
              onClick={handleReset}
            >
              CLEAR
            </Button>
          </>
        )}
      </div>

      {batchError && (
        <div className="p-3 border border-destructive/30 bg-destructive/10 text-destructive text-xs rounded-md font-mono flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{batchError}</span>
        </div>
      )}

      {lines.length > 0 && (
        <div className="space-y-1.5">
          {lines.map((line) => (
            <PasteLineRow key={line.key} line={line} surfaceLabel={SURFACE_LABEL} />
          ))}
        </div>
      )}
    </div>
  )
}

const STATUS_ICON: Record<LineStatus, React.ReactNode> = {
  resolving: <RefreshCw className="w-3 h-3 animate-spin text-primary" />,
  resolved: <CheckCircle2 className="w-3 h-3 text-success" />,
  ambiguous: <HelpCircle className="w-3 h-3 text-warning" />,
  "not-found": <XCircle className="w-3 h-3 text-destructive" />,
  "parse-error": <XCircle className="w-3 h-3 text-muted-foreground" />,
  "predict-pending": <RefreshCw className="w-3 h-3 animate-spin text-primary" />,
  "predict-success": <CheckCircle2 className="w-3 h-3 text-success" />,
  "predict-error": <XCircle className="w-3 h-3 text-destructive" />,
}

const STATUS_LABEL: Record<LineStatus, string> = {
  resolving: "SEARCHING",
  resolved: "READY",
  ambiguous: "AMBIGUOUS",
  "not-found": "NOT FOUND",
  "parse-error": "PARSE ERROR",
  "predict-pending": "PREDICTING",
  "predict-success": "PREDICTED",
  "predict-error": "FAILED",
}

type BadgeVariant = "default" | "secondary" | "success" | "warning" | "destructive"
const STATUS_BADGE: Record<LineStatus, BadgeVariant> = {
  resolving: "secondary",
  resolved: "success",
  ambiguous: "warning",
  "not-found": "destructive",
  "parse-error": "secondary",
  "predict-pending": "secondary",
  "predict-success": "success",
  "predict-error": "destructive",
}

/** Surface colour coding — matches the rest of the app's convention */
const SURFACE_COLOR: Record<Surface, string> = {
  Clay: "text-orange-500",
  Grass: "text-green-500",
  Hard: "text-blue-400",
  IndoorHard: "text-purple-400",
}

function PasteLineRow({
  line,
  surfaceLabel,
}: {
  line: PasteLine
  surfaceLabel: Record<Surface, string>
}) {
  return (
    <div className="p-2.5 border rounded-md bg-secondary/20 text-xs font-mono">
      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_ICON[line.status]}
        <span className="truncate flex-1 min-w-0 text-foreground/80">{line.raw}</span>
        {/* Auto-detected surface pill */}
        {line.detectedSurface && (
          <span className={`text-[0.6rem] font-bold uppercase ${SURFACE_COLOR[line.detectedSurface]}`}>
            {surfaceLabel[line.detectedSurface]}
          </span>
        )}
        {/* Auto-detected level pill */}
        {line.detectedLevel && (
          <span className="text-[0.6rem] text-muted-foreground/70 uppercase">{line.detectedLevel}</span>
        )}
        <Badge variant={STATUS_BADGE[line.status]} className="text-[0.625rem] px-1.5 py-0 h-4 leading-none shrink-0">
          {STATUS_LABEL[line.status]}
        </Badge>
      </div>

      {line.status === "resolved" && line.player1 && line.player2 && (
        <div className="mt-1.5 text-muted-foreground/70">
          {line.player1.name}{line.player1.currentRank ? ` #${line.player1.currentRank}` : ""}
          {" vs "}
          {line.player2.name}{line.player2.currentRank ? ` #${line.player2.currentRank}` : ""}
          {line.resolvedTournament && (
            <span className="ml-2 text-muted-foreground/50">· {line.resolvedTournament}</span>
          )}
          {!line.detectedSurface && line.resolvedTournament && (
            <span className="ml-1 text-muted-foreground/40">· surface unknown</span>
          )}
          {line.parsedDate && (
            <span className="ml-2 text-muted-foreground/50">· {line.parsedDate}</span>
          )}
        </div>
      )}

      {line.errorMessage && (line.status === "not-found" || line.status === "ambiguous" || line.status === "predict-error" || line.status === "parse-error") && (
        <div className="mt-1 text-muted-foreground/70 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-warning" />
          <span>{line.errorMessage}</span>
        </div>
      )}

      {line.status === "predict-success" && line.predictionId != null && (
        <div className="mt-1 text-success/70">Prediction #{line.predictionId} created ✓</div>
      )}
    </div>
  )
}
