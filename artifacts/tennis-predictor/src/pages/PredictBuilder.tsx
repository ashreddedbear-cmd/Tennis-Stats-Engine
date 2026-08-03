import { useState, useEffect } from "react"
import { useLocation, useSearch } from "wouter"
import { useGetPlayer, getGetPlayerQueryKey, useGetPlayerStats, useGetAdminAuthStatus, Surface, MatchFormat, TournamentLevel } from "@workspace/api-client-react"
import type { PredictionSummary } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { PlayerSearch } from "@/components/PlayerSearch"
import { PasteMatchupPredictor } from "@/components/PasteMatchupPredictor"
import { BulkMatchupPredictor } from "@/components/BulkMatchupPredictor"
import { Activity, Search, Swords, Settings2, RefreshCw, ClipboardPaste, Layers, ChevronDown, FolderOpen, X } from "lucide-react"
import { buildClientMatchId, createPredictionWithIntegrity } from "@/lib/predictionRequestIntegrity"
import { SavedPredictionCards } from "@/components/SavedPredictionCards"

function PlayerCard({ 
  playerId, 
  title, 
  onRemove 
}: { 
  playerId: string | null
  title: string
  onRemove: () => void 
}) {
  const { data: player, isLoading, isError } = useGetPlayer(playerId || "", {
    query: { queryKey: getGetPlayerQueryKey(playerId || ""), enabled: !!playerId }
  })
  const { data: stats } = useGetPlayerStats(playerId || "", {
    enabled: !!playerId,
    // Stats are cached — stale-while-revalidate for 5 minutes is fine.
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  if (!playerId) {
    return (
      <Card className="h-full border-dashed border-2 bg-secondary/30 glass-panel">
        <CardContent className="p-4 sm:p-8 h-full flex flex-col justify-center items-center text-center space-y-3 min-h-[140px] sm:min-h-[200px]">
          <div className="w-10 h-10 sm:w-16 sm:h-16 rounded-full bg-background shadow-sm flex items-center justify-center border border-border">
            <Swords className="w-4 h-4 sm:w-6 sm:h-6 text-muted-foreground/50" />
          </div>
          <div>
            <h3 className="font-display font-bold text-base sm:text-xl">{title}</h3>
            <p className="text-xs text-muted-foreground font-mono mt-1">Select player from search below</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (isLoading) return <Card className="h-[240px] animate-pulse bg-muted rounded-2xl" />

  if (isError || !player) {
    return (
      <Card className="border-destructive/50 bg-destructive/5">
        <CardContent className="p-8 text-center min-h-[240px] flex flex-col justify-center items-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center mb-4">
            <Activity className="w-5 h-5" />
          </div>
          <p className="text-destructive font-mono text-sm font-medium">Failed to load player data.</p>
          <Button variant="outline" size="sm" onClick={onRemove} className="mt-4">Clear Selection</Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="h-full relative overflow-hidden border border-primary/20 shadow-lg hover-lift group">
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-accent" />
      <div className="absolute right-0 bottom-0 opacity-[0.02] mix-blend-overlay pointer-events-none group-hover:scale-110 transition-transform duration-700">
        <Swords className="w-32 h-32 sm:w-48 sm:h-48 -mb-6 -mr-6 sm:-mb-10 sm:-mr-10" />
      </div>
      <CardContent className="p-3 sm:p-6 flex flex-col h-full relative z-10">
        <div className="flex justify-between items-start gap-2">
          <div className="space-y-0.5 min-w-0">
            <p className="text-[9px] font-mono font-bold text-muted-foreground uppercase tracking-widest">{title}</p>
            <h3 className="text-lg sm:text-2xl font-display font-bold tracking-tight text-foreground/90 truncate">{player.name}</h3>
          </div>
          {player.countryCode && (
            <Badge variant="secondary" className="font-mono bg-background border shadow-sm shrink-0 text-xs">{player.countryCode}</Badge>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-3 mt-3 sm:mt-6">
          <div className="bg-secondary/50 rounded-lg p-2 text-center border border-border/50">
            <p className="text-[9px] font-mono font-bold text-muted-foreground mb-0.5">RANK</p>
            <p className="font-bold font-mono text-base sm:text-lg tabular-nums">{player.currentRank || '--'}</p>
          </div>
          <div className="bg-secondary/50 rounded-lg p-2 text-center border border-border/50">
            <p className="text-[9px] font-mono font-bold text-muted-foreground mb-0.5">AGE</p>
            <p className="font-bold font-mono text-base sm:text-lg tabular-nums">{player.age || '--'}</p>
          </div>
          <div className="bg-secondary/50 rounded-lg p-2 text-center border border-border/50">
            <p className="text-[9px] font-mono font-bold text-muted-foreground mb-0.5">PLAYS</p>
            <p className="font-bold text-xs uppercase tracking-wide mt-1">{player.plays || '--'}</p>
          </div>
          <div className="bg-secondary/50 rounded-lg p-2 text-center border border-border/50">
            <p className="text-[9px] font-mono font-bold text-muted-foreground mb-0.5">TOUR</p>
            <p className="font-bold text-xs uppercase tracking-wide mt-1">{player.tour || '--'}</p>
          </div>
        </div>

        {/* ── Cached performance stats (from player_stats table) ── */}
        {stats && (
          <div className="mt-2 sm:mt-3 space-y-1.5">
            <div className="grid grid-cols-3 gap-1.5">
              <div className="bg-primary/5 rounded-lg p-2 text-center border border-primary/15">
                <p className="text-[9px] font-mono font-bold text-muted-foreground mb-0.5">MATCHES</p>
                <p className="font-bold font-mono text-sm sm:text-base tabular-nums">{stats.matchesPlayed}</p>
              </div>
              <div className="bg-primary/5 rounded-lg p-2 text-center border border-primary/15">
                <p className="text-[9px] font-mono font-bold text-muted-foreground mb-0.5">WIN% L100</p>
                <p className="font-bold font-mono text-sm sm:text-base tabular-nums">
                  {stats.winRateLast100 != null ? `${Math.round(stats.winRateLast100 * 100)}%` : '--'}
                </p>
              </div>
              <div className="bg-primary/5 rounded-lg p-2 text-center border border-primary/15">
                <p className="text-[9px] font-mono font-bold text-muted-foreground mb-0.5">OVR ELO</p>
                <p className="font-bold font-mono text-sm sm:text-base tabular-nums">{stats.overallElo ?? '--'}</p>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              <div className={`rounded-md p-1.5 text-center border ${stats.eloHard != null ? 'bg-sky-500/10 border-sky-500/20' : 'bg-secondary/30 border-border/30 opacity-50'}`}>
                <p className="text-[8px] font-mono font-bold text-muted-foreground mb-0.5">H.ELO</p>
                <p className="font-bold font-mono text-xs tabular-nums">{stats.eloHard ?? '--'}</p>
              </div>
              <div className={`rounded-md p-1.5 text-center border ${stats.eloClay != null ? 'bg-orange-500/10 border-orange-500/20' : 'bg-secondary/30 border-border/30 opacity-50'}`}>
                <p className="text-[8px] font-mono font-bold text-muted-foreground mb-0.5">C.ELO</p>
                <p className="font-bold font-mono text-xs tabular-nums">{stats.eloClay ?? '--'}</p>
              </div>
              <div className={`rounded-md p-1.5 text-center border ${stats.eloGrass != null ? 'bg-green-500/10 border-green-500/20' : 'bg-secondary/30 border-border/30 opacity-50'}`}>
                <p className="text-[8px] font-mono font-bold text-muted-foreground mb-0.5">G.ELO</p>
                <p className="font-bold font-mono text-xs tabular-nums">{stats.eloGrass ?? '--'}</p>
              </div>
              <div className={`rounded-md p-1.5 text-center border ${stats.serveRatingProxy != null ? 'bg-violet-500/10 border-violet-500/20' : 'bg-secondary/30 border-border/30 opacity-50'}`}>
                <p className="text-[8px] font-mono font-bold text-muted-foreground mb-0.5">MARGIN</p>
                <p className="font-bold font-mono text-xs tabular-nums">{stats.serveRatingProxy ?? '--'}</p>
              </div>
            </div>
          </div>
        )}

        <Button variant="ghost" size="sm" onClick={onRemove} className="w-full mt-3 text-muted-foreground font-mono text-xs hover:text-destructive hover:bg-destructive/10 h-7">
          CHANGE PLAYER
        </Button>
      </CardContent>
    </Card>
  )
}

export default function PredictBuilderPage() {
  const [, setLocation] = useLocation()
  const searchString = useSearch()
  const { data: adminAuth } = useGetAdminAuthStatus()
  const isAdmin = adminAuth?.authenticated === true
  const searchParams = new URLSearchParams(searchString)
  
  const p1 = searchParams.get('p1')
  const p2 = searchParams.get('p2')
  // Auto-detected from the real fixture when arriving via "Custom Match" on Today's Fixtures --
  // still fully editable below, this only changes the starting values.
  const prefillSurface = searchParams.get('surface') as Surface | null
  const prefillFormat = searchParams.get('format') as MatchFormat | null
  const prefillLevel = searchParams.get('level') as TournamentLevel | null
  const prefillTournamentName = searchParams.get('tournamentName')

  const [player1Id, setPlayer1Id] = useState<string | null>(p1)
  const [player2Id, setPlayer2Id] = useState<string | null>(p2)
  const [player1Name, setPlayer1Name] = useState<string | null>(null)
  const [player2Name, setPlayer2Name] = useState<string | null>(null)
  const [surface, setSurface] = useState<Surface>(prefillSurface ?? 'Hard')
  const [format, setFormat] = useState<MatchFormat>(prefillFormat ?? 'BestOf3')
  const [level, setLevel] = useState<TournamentLevel>(prefillLevel ?? 'ATP250')
  // Free-text tournament name, separate from Level -- this is what venue/weather/travel lookups
  // match against, so it needs to be the real tournament name (e.g. "Cincinnati Open"), not
  // derived or guessed from the Level dropdown.
  const [tournamentName, setTournamentName] = useState(prefillTournamentName ?? '')
  const wasAutoDetected = !!(prefillSurface || prefillFormat || prefillLevel)

  // Match Conditions collapsed/expanded state — persisted to localStorage so it survives refreshes.
  const [isPredictionPending, setIsPredictionPending] = useState(false)
  const [isPredictionError, setIsPredictionError] = useState(false)
  // Expose mutation-like shape so JSX can reference createPrediction.isPending / isError
  const createPrediction = { isPending: isPredictionPending, isError: isPredictionError }

  const [savedCardsOpen, setSavedCardsOpen] = useState(false)

  const [conditionsExpanded, setConditionsExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem("matchConditionsExpanded") === "true" } catch { return false }
  })

  useEffect(() => {
    try { localStorage.setItem("matchConditionsExpanded", conditionsExpanded ? "true" : "false") } catch { /* best-effort */ }
  }, [conditionsExpanded])

  useEffect(() => {
    setPlayer1Id(p1)
    setPlayer2Id(p2)
    setSurface(prefillSurface ?? "Hard")
    setFormat(prefillFormat ?? "BestOf3")
    setLevel(prefillLevel ?? "ATP250")
    setTournamentName(prefillTournamentName ?? "")
    setPlayer1Name(null)
    setPlayer2Name(null)
  }, [p1, p2, prefillSurface, prefillFormat, prefillLevel, prefillTournamentName])

  const handleRunModel = async () => {
    if (!player1Id || !player2Id) return

    const trimmedTournamentName = tournamentName.trim()

    const requestMatchId = buildClientMatchId({
      source: "manual",
      player1Id,
      player2Id,
      tournamentName: trimmedTournamentName || null,
      surface,
      matchFormat: format,
    })

    setIsPredictionPending(true)
    setIsPredictionError(false)
    try {
      const prediction = await createPredictionWithIntegrity(
        {
        player1Id,
        player2Id,
        surface,
        matchFormat: format,
        tournamentLevel: level,
          tournamentName: trimmedTournamentName || null,
        },
        {
          requestMatchId,
          submittedPlayer1Name: player1Name,
          submittedPlayer2Name: player2Name,
        },
      )
      setLocation(`/predictions/${prediction.id}`)
    } catch {
      setIsPredictionError(true)
    } finally {
      setIsPredictionPending(false)
    }
  }

  return (
    <div className="space-y-4 sm:space-y-8 animate-in fade-in duration-500 max-w-5xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-2 border-b border-border/50 pb-4">
        <div>
          <h1 className="text-2xl sm:text-4xl font-display font-bold tracking-tight">{wasAutoDetected ? "Custom Match" : "Run Model"}</h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-lg">
            {wasAutoDetected
              ? "Terrain and tournament auto-detected from the fixture — adjust anything below before running the engine."
              : "Search players, configure parameters, and run the prediction engine."}
          </p>
        </div>
      </div>

      {/* Box 1 + Box 2 — Player One and Player Two slots */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-8">
        <PlayerCard 
          title="PLAYER 1" 
          playerId={player1Id} 
          onRemove={() => { setPlayer1Id(null); setPlayer1Name(null) }} 
        />
        <PlayerCard 
          title="PLAYER 2" 
          playerId={player2Id} 
          onRemove={() => { setPlayer2Id(null); setPlayer2Name(null) }} 
        />
      </div>

      {/* Box 3 — Input methods: Player Search, Paste Search (multi-line), Bulk Upload (screenshots) */}
      <Card className="border-border shadow-md glass-panel">
        <CardContent className="p-4 pt-4">
          <Tabs defaultValue="search">
            <div className="mb-3 flex items-center gap-2">
              <TabsList className="flex-1">
                <TabsTrigger value="search" className="font-mono gap-1.5 flex-1">
                  <Search className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden sm:inline">PLAYER </span>SEARCH
                </TabsTrigger>
                <TabsTrigger value="paste" className="font-mono gap-1.5 flex-1">
                  <ClipboardPaste className="w-3.5 h-3.5 shrink-0" />
                  PASTE<span className="hidden sm:inline"> SEARCH</span>
                </TabsTrigger>
                <TabsTrigger value="bulk" className="font-mono gap-1.5 flex-1">
                  <Layers className="w-3.5 h-3.5 shrink-0" />
                  BULK<span className="hidden sm:inline"> UPLOAD</span>
                </TabsTrigger>
              </TabsList>
              {/* Saved Prediction Cards — toggle the saved cards panel */}
              <Button
                variant="outline"
                size="sm"
                className={`font-mono gap-1.5 shrink-0 h-9 text-xs border-primary/40 text-primary hover:bg-primary/10 transition-colors ${savedCardsOpen ? "bg-primary/10" : ""}`}
                onClick={() => setSavedCardsOpen(prev => !prev)}
              >
                <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden xs:inline">SAVED </span>CARDS
              </Button>
            </div>

            <TabsContent value="search">
              <PlayerSearch 
                onSelect={(player) => {
                  if (!player1Id) {
                    setPlayer1Id(player.id)
                    setPlayer1Name(player.name)
                  } else if (!player2Id && player.id !== player1Id) {
                    setPlayer2Id(player.id)
                    setPlayer2Name(player.name)
                  }
                }} 
              />
            </TabsContent>

            <TabsContent value="paste">
              <PasteMatchupPredictor />
            </TabsContent>

            <TabsContent value="bulk">
              <BulkMatchupPredictor />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Saved Prediction Cards panel — toggled by the SAVED CARDS button above */}
      {savedCardsOpen && (
        <Card className="border-border/60 shadow-sm glass-panel animate-in fade-in duration-200">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">
              Saved Prediction Cards
            </p>
            <button
              onClick={() => setSavedCardsOpen(false)}
              className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
              aria-label="Close saved cards"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <CardContent className="px-4 pb-4 pt-0">
            <SavedPredictionCards isAdmin={isAdmin} />
          </CardContent>
        </Card>
      )}

      {/* Match Conditions — only visible once both players are selected */}
      {player1Id && player2Id && (
        <Card className="border-primary/30 shadow-xl overflow-hidden glass-panel relative">
          <div className="absolute top-0 right-0 w-96 h-96 bg-primary/5 rounded-full blur-3xl -mr-48 -mt-48 pointer-events-none" />

          {/* Collapsible header — always visible, click to expand/collapse the settings */}
          <button
            type="button"
            className="w-full text-left bg-secondary/40 border-b border-border/50 relative z-10 p-6 sm:p-8 hover:bg-secondary/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            onClick={() => setConditionsExpanded((prev) => !prev)}
            aria-expanded={conditionsExpanded}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <Settings2 className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-2xl font-display">Match Conditions</CardTitle>
                  <CardDescription className="text-base mt-1">
                    {conditionsExpanded ? "Engine weights adjust based on these parameters." : "Tap to set surface, format, and tournament."}
                  </CardDescription>
                </div>
              </div>
              <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform duration-200 ${conditionsExpanded ? "rotate-180" : ""}`} />
            </div>
          </button>

          {/* Collapsible fields */}
          {conditionsExpanded && (
            <CardContent className="p-6 sm:p-8 relative z-10">
              <div className="space-y-3 mb-8">
                <label className="text-[11px] font-mono font-bold text-muted-foreground flex items-center gap-2 uppercase tracking-widest">
                  Tournament Name
                  {prefillTournamentName && <Badge variant="secondary" className="text-[9px] px-1.5 py-0">AUTO-DETECTED</Badge>}
                </label>
                <Input
                  value={tournamentName}
                  onChange={(e) => setTournamentName(e.target.value)}
                  placeholder="e.g. Cincinnati Open"
                  className="h-12 text-base bg-background/50 border-border/60 focus:border-primary focus:ring-primary/20 transition-all"
                />
                <p className="text-xs text-muted-foreground/80 font-mono">
                  Used to look up real venue weather and travel distance. Separate from Level below — enter the actual tournament name, not a category.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
                <div className="space-y-3">
                  <label className="text-[11px] font-mono font-bold text-muted-foreground flex items-center gap-2 uppercase tracking-widest">
                    Surface
                    {prefillSurface && <Badge variant="secondary" className="text-[9px] px-1.5 py-0">AUTO-DETECTED</Badge>}
                  </label>
                  <Select value={surface} onChange={(e) => setSurface(e.target.value as Surface)} className="h-12 bg-background/50">
                    <option value="Hard">Hard Court</option>
                    <option value="Clay">Clay</option>
                    <option value="Grass">Grass</option>
                    <option value="IndoorHard">Indoor Hard</option>
                  </Select>
                </div>
                <div className="space-y-3">
                  <label className="text-[11px] font-mono font-bold text-muted-foreground uppercase tracking-widest">Format</label>
                  <Select value={format} onChange={(e) => setFormat(e.target.value as MatchFormat)} className="h-12 bg-background/50">
                    <option value="BestOf3">Best of 3</option>
                    <option value="BestOf5">Best of 5 (Slams)</option>
                  </Select>
                </div>
                <div className="space-y-3">
                  <label className="text-[11px] font-mono font-bold text-muted-foreground flex items-center gap-2 uppercase tracking-widest">
                    Level
                    {prefillLevel && <Badge variant="secondary" className="text-[9px] px-1.5 py-0">AUTO-DETECTED</Badge>}
                  </label>
                  <Select value={level} onChange={(e) => setLevel(e.target.value as TournamentLevel)} className="h-12 bg-background/50">
                    <option value="GrandSlam">Grand Slam</option>
                    <option value="Masters1000">Masters 1000</option>
                    <option value="WTA1000">WTA 1000</option>
                    <option value="ATP500">ATP 500</option>
                    <option value="WTA500">WTA 500</option>
                    <option value="ATP250">ATP 250</option>
                    <option value="WTA250">WTA 250</option>
                    <option value="Challenger">Challenger</option>
                  </Select>
                </div>
              </div>
            </CardContent>
          )}

          {/* Execute button — always visible regardless of collapse state */}
          <div className="p-6 sm:p-8 pt-0 relative z-10">
            {createPrediction.isError && conditionsExpanded && (
              <div className="mb-6 p-4 border border-destructive/30 bg-destructive/5 text-destructive text-sm rounded-xl font-mono flex items-start gap-3">
                <Activity className="w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <strong className="block mb-1">ENGINE ERROR:</strong>
                  Failed to run prediction. Provider may be unavailable or matchup data is insufficient.
                </div>
              </div>
            )}
            {createPrediction.isError && !conditionsExpanded && (
              <div className="mb-4 p-3 border border-destructive/30 bg-destructive/5 text-destructive text-xs rounded-lg font-mono flex items-center gap-2">
                <Activity className="w-4 h-4 shrink-0" />
                Engine error — expand Match Conditions for details.
              </div>
            )}

            <Button 
              size="lg" 
              className="w-full font-bold font-mono text-lg h-16 rounded-xl relative overflow-hidden group" 
              variant="accent"
              disabled={createPrediction.isPending || player1Id === player2Id}
              onClick={handleRunModel}
            >
              <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out" />
              <span className="relative z-10 flex items-center justify-center gap-3">
                {createPrediction.isPending ? (
                  <><RefreshCw className="w-6 h-6 animate-spin" /> RUNNING MODELS...</>
                ) : (
                  <><Activity className="w-6 h-6" /> EXECUTE PREDICTION ENGINE</>
                )}
              </span>
            </Button>
          </div>
        </Card>
      )}

    </div>
  )
}
