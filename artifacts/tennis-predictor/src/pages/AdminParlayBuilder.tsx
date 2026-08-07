import { useRef, useState, useEffect, useCallback } from "react"
import { useSearch } from "wouter"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import {
  Layers, ImagePlus, RefreshCw, AlertTriangle, CheckCircle2, XCircle,
  ChevronDown, ChevronUp, Trash2, RotateCcw, Search, Play, FlaskConical,
  Shield, ShieldAlert, ShieldOff, TrendingUp, Activity, BarChart2, ArrowLeftRight,
  Wifi, WifiOff, Server, Database, Bookmark, BookmarkCheck, History, X, UserX, Trophy,
} from "lucide-react"
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  Cell, ResponsiveContainer, ComposedChart, Line, Legend,
} from "recharts"

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
const api = (path: string) => `${BASE}${path}`

const MAX_FILES = 150
const RESOLVE_CONCURRENCY = 4

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileToBase64DataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, idx: number) => Promise<void>): Promise<void> {
  let next = 0
  const run = async (): Promise<void> => {
    const i = next++
    if (i >= items.length) return
    await worker(items[i], i)
    await run()
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResolvedPlayer { playerId: string | null; recognizedName: string }
interface ScreenshotResult {
  player1: ResolvedPlayer
  player2: ResolvedPlayer
  event: { recognizedName: string | null; surface: string | null; level: string | null }
  warnings: string[]
  matchups?: Array<{ player1: ResolvedPlayer; player2: ResolvedPlayer; event: { recognizedName: string | null; surface: string | null; level: string | null }; warnings: string[]; resolved: boolean }>
}

type LegStatus = "resolving" | "resolved" | "unresolved" | "error"

interface PlayerCandidate { id: string; name: string; countryCode: string | null; currentRank?: number | null; tour?: string | null }

interface ParlayLeg {
  key: string
  status: LegStatus
  // Resolved matchup data
  player1Name: string; player1Id: string | null
  player2Name: string; player2Id: string | null
  tournamentName: string | null; surface: string | null
  warnings: string[]
  // Ambiguous candidates (status === "ambiguous" on one or both players)
  player1Candidates?: PlayerCandidate[]
  player2Candidates?: PlayerCandidate[]
  // User selections
  selectedSide: "1" | "2" | null  // which player they're backing
  marketOdds: string   // decimal odds input
  // Screenshot diagnostics
  debugLog?: string[]; errorMessage?: string
}

interface CheckResult { label: string; value: string; status: "pass" | "warn" | "fail" }

// ── Builder Validation (Task 105 — Independent Validation Engine) ─────────────
interface BuilderFactorScore {
  name: string; score: number; weight: number; available: boolean; contribution: number
}

type PlayerDataStatus = "data_available" | "insufficient_data" | "player_not_found"
type ProviderOutcome = "CACHE_HIT" | "CACHE_MISS" | "PLAYER_RESOLVED" | "DATA_FOUND" |
  "SOURCE_UNAVAILABLE" | "PLAYER_NOT_FOUND" | "NO_MATCH_HISTORY" | "DATA_UNAVAILABLE"
interface ProviderSourceDiag { source: string; attempted: boolean; succeeded: boolean; playerFound: boolean; recordsReturned: number; providerPlayerId?: string; failureReason?: string }
interface LiveFetchDiagnostics {
  outcome: ProviderOutcome
  sourcesConfigured: string[]; sourcesAttempted: string[]; sourcesSuccessful: string[]; sourcesFailed: string[]
  playerResolutionMethod: string
  providerIdsFound: Record<string, string>; recordsPerSource: Record<string, number>
  failureReasons: string[]; sources: ProviderSourceDiag[]
}
interface DataSourceDiagnostics {
  selectedPlayerStatus: PlayerDataStatus; opponentStatus: PlayerDataStatus
  selectedPlayerMatchCount: number; opponentMatchCount: number; h2hMatchCount: number
  selectedPlayerResolvedVia?: string; opponentResolvedVia?: string
  selectedPlayerProviderDiag?: LiveFetchDiagnostics; opponentProviderDiag?: LiveFetchDiagnostics
  isProviderOutage?: boolean
  noDataReason?: "provider-unreachable" | "not-configured" | "player-not-found" | "no-history"
  dataConfidenceNote?: string
}

interface BuilderLegResult {
  selectedPlayerName: string; opponentName: string
  tournamentName: string | null; surface: string | null
  validationScore: number       // 0–100
  riskScore: number             // 0–100
  matchupCloseness?: number     // 0–100, higher = more evenly matched; drives risk floor
  reliabilityGrade: "A" | "B" | "C" | "D" | "F"
  parlayGrade: "Elite" | "Strong" | "Moderate" | "Weak" | "Reject"
  removalProbability: number    // 0–100
  decision: "KEEP" | "BORDERLINE" | "REMOVE" | "DATA_UNAVAILABLE"
  reasons: string[]
  criticalFlags: string[]
  dataCoverage: number; sourceAgreement: number
  sourcesAgreeing: number; sourcesTotal: number  // sourcesTotal = opinionated sources only
  factorScores: BuilderFactorScore[]
  dataSourceDiagnostics?: DataSourceDiagnostics
  builderVersion: string
}
interface BuilderSession {
  legs: BuilderLegResult[]
  summary: {
    keepCount: number; borderlineCount: number; removeCount: number
    avgValidationScore: number; avgRiskScore: number; overallParlayGrade: string
  }
}

// ── OCR Provider Health ───────────────────────────────────────────────────────
type ProviderStatus = "healthy" | "rate_limited" | "quota_exhausted" | "auth_failed" | "offline"
interface ProviderHealthEntry {
  label: string; status: ProviderStatus
  lastErrorAt: string | null; lastSuccessAt: string | null
  permanentFailures: number; transientFailures: number
}
interface ProviderHealthReport {
  providers: ProviderHealthEntry[]
  cache: { entries: number; maxEntries: number; ttlMs: number }
  reportedAt: string
}

// Legacy evaluate types (kept for /evaluate fallback only)
interface SlipResult { legs: unknown[]; fragility: string; correlationWarning: string | null; removeCount: number; cautionCount: number; approvedCount: number }

interface BacktestLegRow {
  id: number
  player1_name: string; player2_name: string
  calibrated_probability: number
  tournament_name: string | null; surface: string | null
  scheduled_start_at: string
  data_quality: number
  upset_risk_tier: string | null
}

interface BacktestResult {
  legs: Array<{
    predictionId: number
    player1Name: string; player2Name: string; selectedName: string
    tournamentName: string | null; surface: string | null; matchDate: string
    winnerProb: number; score: number; decision: "Approved" | "Caution" | "Remove"
    reasons: string[]; selectedWon: boolean | null
  }>
  metrics: {
    lossCaptureRate: number | null; falseRemovalRate: number | null
    approvedAccuracy: number | null; survivalImprovement: number
    totalLegs: number; removeCount: number; cautionCount: number; approvedCount: number
  }
}

// ── Decision styling ──────────────────────────────────────────────────────────

function decisionBadge(d: string, size = "sm") {
  const cls = size === "lg" ? "text-xs px-3 py-1" : "text-[10px]"
  if (d === "KEEP") return <Badge className={`${cls} bg-success/20 text-success border-success/30 gap-1`}><CheckCircle2 className="w-2.5 h-2.5" />KEEP</Badge>
  if (d === "REMOVE") return <Badge variant="destructive" className={`${cls} gap-1`}><XCircle className="w-2.5 h-2.5" />REMOVE</Badge>
  if (d === "DATA_UNAVAILABLE") return <Badge className={`${cls} bg-muted text-muted-foreground border-border/50 gap-1`}><WifiOff className="w-2.5 h-2.5" />NO DATA</Badge>
  return <Badge className={`${cls} bg-warning/20 text-warning border-warning/30 gap-1`}><AlertTriangle className="w-2.5 h-2.5" />BORDERLINE</Badge>
}

function parlayGradeBadge(g: string) {
  const map: Record<string, string> = {
    Elite: "bg-purple-500/20 text-purple-300 border-purple-500/30",
    Strong: "bg-success/20 text-success border-success/30",
    Moderate: "bg-primary/20 text-primary border-primary/30",
    Weak: "bg-warning/20 text-warning border-warning/30",
    Reject: "bg-destructive/20 text-destructive border-destructive/30",
  }
  return <Badge className={`text-xs gap-1 ${map[g] ?? ""}`}><Shield className="w-3 h-3" />{g.toUpperCase()}</Badge>
}

function checkIcon(status: "pass" | "warn" | "fail") {
  if (status === "pass") return <CheckCircle2 className="w-3 h-3 text-success shrink-0" />
  if (status === "fail") return <XCircle className="w-3 h-3 text-destructive shrink-0" />
  return <AlertTriangle className="w-3 h-3 text-warning shrink-0" />
}

function scoreBar(score: number) {
  const pct = (score / 10) * 100
  const color = score >= 7 ? "bg-success" : score >= 4 ? "bg-warning" : "bg-destructive"
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono font-bold tabular-nums w-6 text-right">{score.toFixed(1)}</span>
    </div>
  )
}

// ── OCR Provider Health Panel ────────────────────────────────────────────────

function statusDot(status: ProviderStatus) {
  const map: Record<ProviderStatus, string> = {
    healthy: "bg-success",
    rate_limited: "bg-warning",
    quota_exhausted: "bg-destructive",
    auth_failed: "bg-destructive",
    offline: "bg-muted-foreground",
  }
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${map[status]}`} />
}

function statusLabel(status: ProviderStatus) {
  const map: Record<ProviderStatus, string> = {
    healthy: "Healthy",
    rate_limited: "Rate Limited",
    quota_exhausted: "Quota Exhausted",
    auth_failed: "Auth Failed",
    offline: "Offline",
  }
  return map[status]
}

function ProviderHealthPanel({ onClose }: { onClose: () => void }) {
  const { toast } = useToast()
  const [report, setReport] = useState<ProviderHealthReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)

  const fetchHealth = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(api("/api/admin/screenshot-import/health"), { credentials: "include" })
      if (r.ok) setReport(await r.json())
    } catch { /* silently ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const clearCache = async () => {
    setClearing(true)
    try {
      const r = await fetch(api("/api/admin/screenshot-import/cache/clear"), {
        method: "POST", credentials: "include",
      })
      if (r.ok) { toast({ title: "Cache cleared" }); await fetchHealth() }
    } catch { toast({ title: "Failed to clear cache", variant: "destructive" }) }
    finally { setClearing(false) }
  }

  const resetProvider = async (label: string) => {
    const r = await fetch(api(`/api/admin/screenshot-import/health/reset/${encodeURIComponent(label)}`), {
      method: "POST", credentials: "include",
    })
    if (r.ok) { toast({ title: `${label} reset to healthy` }); await fetchHealth() }
  }

  return (
    <Card className="border-border/60">
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest">OCR PROVIDER HEALTH</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchHealth} className="text-muted-foreground hover:text-foreground transition-colors">
              <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
              <XCircle className="w-3 h-3" />
            </button>
          </div>
        </div>

        {loading && !report && (
          <p className="text-[11px] font-mono text-muted-foreground">Loading…</p>
        )}

        {report && (
          <>
            {report.providers.length === 0 ? (
              <p className="text-[11px] font-mono text-muted-foreground">No providers have been used yet this session.</p>
            ) : (
              <div className="space-y-1.5">
                {report.providers.map(p => (
                  <div key={p.label} className="flex items-center gap-2 text-[11px]">
                    {statusDot(p.status)}
                    <span className="font-mono text-foreground flex-1">{p.label}</span>
                    <span className={`font-mono ${p.status === "healthy" ? "text-success" : p.status === "offline" ? "text-muted-foreground" : "text-destructive"}`}>
                      {statusLabel(p.status)}
                    </span>
                    {(p.status === "quota_exhausted" || p.status === "auth_failed") && (
                      <button
                        onClick={() => resetProvider(p.label)}
                        className="text-[9px] font-mono text-primary hover:underline ml-1 shrink-0"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between pt-1 border-t border-border/30">
              <p className="text-[10px] font-mono text-muted-foreground">
                Image cache: {report.cache.entries}/{report.cache.maxEntries} entries
              </p>
              <button
                onClick={clearCache}
                disabled={clearing || report.cache.entries === 0}
                className="text-[9px] font-mono text-primary hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {clearing ? "Clearing…" : "Clear cache"}
              </button>
            </div>

            <p className="text-[9px] font-mono text-muted-foreground/40">
              Reported {new Date(report.reportedAt).toLocaleTimeString()} · health resets on server restart
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ── Screenshot upload zone ────────────────────────────────────────────────────

function ScreenshotZone({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handle = (files: FileList | null) => {
    if (!files || files.length === 0) return
    onFiles(Array.from(files).filter(f => f.type.startsWith("image/")))
  }

  return (
    <div
      className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer ${dragging ? "border-primary bg-primary/5" : "border-border/50 hover:border-primary/40"} ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files) }}
    >
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden"
        onChange={e => { handle(e.target.files); e.target.value = "" }} />
      <ImagePlus className="w-7 h-7 mx-auto mb-2 text-muted-foreground" />
      <p className="font-mono font-bold text-sm">UPLOAD SCREENSHOT(S)</p>
      <p className="text-xs text-muted-foreground mt-1">Drag & drop or click — supports multi-match images, up to {MAX_FILES} files</p>
      <p className="text-[10px] text-muted-foreground/60 mt-1 font-mono">Same OCR engine as Bulk Predict</p>
    </div>
  )
}

// ── Leg card (during input / selection phase) ─────────────────────────────────

function LegInputCard({ leg, index, onSelect, onOdds, onRemove }: {
  leg: ParlayLeg; index: number
  onSelect: (side: "1" | "2") => void
  onOdds: (odds: string) => void
  onRemove: () => void
}) {
  if (leg.status === "resolving") {
    return (
      <Card className="border-border/40">
        <CardContent className="p-3 flex items-center gap-3">
          <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-mono text-muted-foreground">Reading screenshot…</p>
            <p className="text-[10px] text-muted-foreground/50 font-mono">Identifying players & event</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Hard error — OCR totally failed, no names at all
  if (leg.status === "error") {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-destructive break-words">
                {leg.player1Name && leg.player2Name ? `${leg.player1Name} vs ${leg.player2Name}` : "Could not read matchup"}
              </p>
              <p className="text-[10px] text-muted-foreground font-mono break-words mt-0.5">
                {leg.errorMessage ?? "OCR failed — try a clearer screenshot"}
              </p>
            </div>
            <button onClick={onRemove} className="text-muted-foreground hover:text-destructive transition-colors shrink-0">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const isUnresolved = leg.status === "unresolved"
  const backed = leg.selectedSide === "1" ? leg.player1Name : leg.player2Name
  const opponent = leg.selectedSide === "1" ? leg.player2Name : leg.player1Name
  const backedId = leg.selectedSide === "1" ? leg.player1Id : leg.player2Id
  const flipSide = () => onSelect(leg.selectedSide === "1" ? "2" : "1")

  return (
    <Card className={`border transition-colors ${
      isUnresolved ? "border-warning/30 bg-warning/5" : "border-border/50"
    }`}>
      <CardContent className="p-3 space-y-2">
        {/* Header: leg number + tournament */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">LEG {index + 1}</p>
              {isUnresolved && (
                <span className="text-[9px] font-mono text-warning bg-warning/10 px-1.5 py-0.5 rounded border border-warning/20">LOW DATA</span>
              )}
            </div>
            {leg.tournamentName && (
              <p className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
                {leg.tournamentName}{leg.surface ? ` · ${leg.surface}` : ""}
              </p>
            )}
          </div>
          <button onClick={onRemove} className="text-muted-foreground hover:text-destructive transition-colors shrink-0 mt-0.5">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Backing row — auto-selected, flip button to swap */}
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2">
            <p className="text-[9px] font-mono text-primary/60 uppercase tracking-wider leading-none mb-0.5">BACKING</p>
            <p className="text-sm font-semibold text-primary leading-tight" style={{ wordBreak: "break-word" }}>
              {backed || "—"}
            </p>
            {opponent && (
              <p className="text-[10px] text-muted-foreground font-mono leading-tight mt-0.5">
                vs {opponent}
              </p>
            )}
            {!backedId && !isUnresolved && (
              <p className="text-[9px] font-mono text-warning/80 mt-0.5">⚠ unresolved</p>
            )}
          </div>
          <button
            onClick={flipSide}
            title="Swap selection"
            className="shrink-0 p-2 rounded-lg border border-border/50 hover:border-primary/40 hover:bg-secondary/40 active:bg-secondary/70 transition-colors"
          >
            <ArrowLeftRight className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>

        {/* Warning — only for truly unresolved (no IDs at all) */}
        {isUnresolved && !leg.player1Id && !leg.player2Id && (
          <p className="text-[10px] font-mono text-warning/80 leading-snug" style={{ wordBreak: "break-word" }}>
            ⚠ {leg.warnings.find(w => !w.startsWith("[resolver-debug]")) ?? "Players not found — analysis will show limited data"}
          </p>
        )}

        {/* Odds input */}
        <div className="flex items-center gap-2">
          <Input
            className="h-7 text-xs font-mono w-24 shrink-0"
            placeholder="e.g. 1.85"
            value={leg.marketOdds}
            onChange={e => onOdds(e.target.value)}
          />
          <span className="text-[10px] text-muted-foreground font-mono">decimal odds (optional)</span>
        </div>
      </CardContent>
    </Card>
  )
}

// ── History Mode ──────────────────────────────────────────────────────────────

interface HistoryLeg {
  id: number
  selected_player_name: string
  opponent_name: string
  tournament_name: string | null
  surface: string | null
  validation_score: number
  risk_score: number
  reliability_grade: string
  parlay_grade: string
  decision: string
  data_coverage: number
  source_agreement: number
  removal_probability: number
  matchup_closeness: number | null
  source: string
  actual_winner_id: string | null
  selected_player_id: string
  created_at: string
  resolved_at: string | null
  market_odds: string | null
}

function HistoryMode() {
  const { toast } = useToast()
  const [legs, setLegs] = useState<HistoryLeg[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "wins" | "losses">("all")
  const limit = 100

  const fetchHistory = useCallback(async (newOffset = 0) => {
    setLoading(true)
    try {
      const r = await fetch(api(`/api/admin/parlay/history?limit=${limit}&offset=${newOffset}`), { credentials: "include" })
      if (!r.ok) throw new Error(await r.text())
      const j = await r.json()
      setLegs(j.legs ?? [])
      setTotal(j.total ?? 0)
      setOffset(newOffset)
    } catch (e) {
      toast({ title: "Failed to load history", description: String(e), variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { void fetchHistory(0) }, [fetchHistory])

  const outcomeFor = (leg: HistoryLeg) => {
    if (!leg.actual_winner_id) return null
    return leg.actual_winner_id === leg.selected_player_id
  }

  const visibleLegs = legs.filter(leg => {
    const won = outcomeFor(leg)
    return outcomeFilter === "all" || (outcomeFilter === "wins" ? won === true : won === false)
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-display font-semibold text-base">Leg History</h2>
          <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
            {total.toLocaleString()} total legs · live + backfill
          </p>
        </div>
        <button
          onClick={() => fetchHistory(offset)}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="flex gap-1 flex-wrap">
        {(["all", "wins", "losses"] as const).map(filter => (
          <button key={filter} onClick={() => setOutcomeFilter(filter)} className={`text-[10px] font-mono px-2.5 py-1 rounded border transition-colors ${outcomeFilter === filter ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:border-primary/40"}`}>
            {filter === "all" ? "All legs" : filter === "wins" ? "Wins" : "Losses"}
          </button>
        ))}
      </div>

      {loading && legs.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono py-12 justify-center">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading history…
        </div>
      ) : visibleLegs.length === 0 ? (
        <Card className="border-dashed bg-secondary/20">
          <CardContent className="py-12 text-center space-y-2">
            <History className="w-10 h-10 text-muted-foreground/30 mx-auto" />
            <p className="text-sm font-mono text-muted-foreground">No legs yet</p>
            <p className="text-[11px] text-muted-foreground/60 font-mono">Run Analyze Parlay or the calibration backfill to populate history</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="max-h-[min(70vh,900px)] overflow-y-auto space-y-2 pr-1">
            {visibleLegs.map(leg => <HistoryMiniCard key={leg.id} leg={leg} outcome={outcomeFor(leg)} />)}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between gap-2 text-xs font-mono text-muted-foreground">
            <span>{offset + 1}–{Math.min(offset + limit, total)} of {total.toLocaleString()}</span>
            <div className="flex gap-2">
              <button
                disabled={offset === 0 || loading}
                onClick={() => fetchHistory(Math.max(0, offset - limit))}
                className="px-3 py-1 rounded border border-border hover:border-primary/40 disabled:opacity-40 transition-colors"
              >← Prev</button>
              <button
                disabled={offset + limit >= total || loading}
                onClick={() => fetchHistory(offset + limit)}
                className="px-3 py-1 rounded border border-border hover:border-primary/40 disabled:opacity-40 transition-colors"
              >Next →</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function HistoryMiniCard({ leg, outcome }: { leg: HistoryLeg; outcome: boolean | null }) {
  const scoreColor = (score: number) => score >= 65 ? "bg-success" : score >= 45 ? "bg-warning" : "bg-destructive"
  const riskColor = (score: number) => score <= 35 ? "bg-success" : score <= 55 ? "bg-warning" : "bg-destructive"

  return (
    <Card className={`border ${leg.decision === "KEEP" ? "border-success/30 bg-success/5" : leg.decision === "REMOVE" ? "border-destructive/40 bg-destructive/5" : "border-warning/30 bg-warning/5"}`}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              {decisionBadge(leg.decision)}
              {parlayGradeBadge(leg.parlay_grade)}
              <Badge variant="outline" className="text-[9px] font-mono px-1.5">Grade {leg.reliability_grade}</Badge>
              <span className="text-[10px] font-mono text-muted-foreground truncate">{leg.tournament_name ?? "—"}</span>
            </div>
            <p className="text-sm font-medium leading-snug mt-1"><span className="text-primary font-bold">{leg.selected_player_name}</span><span className="text-muted-foreground mx-1.5 font-mono text-xs">vs</span><span className="text-muted-foreground">{leg.opponent_name}</span></p>
          </div>
          <div className="shrink-0 text-right"><p className="text-xl font-display font-bold tabular-nums leading-none">{leg.validation_score}</p><p className="text-[9px] font-mono text-muted-foreground">/ 100</p></div>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2"><span className="text-[10px] font-mono text-muted-foreground w-20 shrink-0">Validation</span><div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden"><div className={`h-full ${scoreColor(leg.validation_score)}`} style={{ width: `${leg.validation_score}%` }} /></div><span className="text-[10px] font-mono tabular-nums w-8 text-right">{leg.validation_score}%</span></div>
          <div className="flex items-center gap-2"><span className="text-[10px] font-mono text-muted-foreground w-20 shrink-0">Risk</span><div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden"><div className={`h-full ${riskColor(leg.risk_score)}`} style={{ width: `${leg.risk_score}%` }} /></div><span className="text-[10px] font-mono tabular-nums w-8 text-right">{leg.risk_score}%</span></div>
        </div>
        <div className="flex gap-3 text-[10px] font-mono flex-wrap"><span className="text-muted-foreground">Removal: <b className="text-foreground">{leg.removal_probability}%</b></span><span className="text-muted-foreground">Coverage: <b className="text-foreground">{leg.data_coverage}%</b></span><span className="text-muted-foreground">Agreement: <b className="text-foreground">{leg.source_agreement}%</b></span><span className="text-muted-foreground">Closeness: <b className="text-foreground">{leg.matchup_closeness ?? "—"}</b></span><span className="text-muted-foreground">Surface: <b className="text-foreground">{leg.surface ?? "—"}</b></span></div>
        <div className={`text-[10px] font-mono font-bold ${outcome === true ? "text-success" : outcome === false ? "text-destructive" : "text-muted-foreground"}`}>{outcome === true ? "WON ✓" : outcome === false ? "LOST ✗" : "PENDING"}</div>
      </CardContent>
    </Card>
  )
}

// ── Saved Parlays Panel ───────────────────────────────────────────────────────

interface SavedLegRow { id: number; saved_at: string; leg_payload: BuilderLegResult }

function SavedParlaysPanel({
  onClose,
  onAddSelected,
}: {
  onClose: () => void
  onAddSelected: (legs: BuilderLegResult[]) => void
}) {
  const { toast } = useToast()
  const [rows, setRows] = useState<SavedLegRow[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirmClear, setConfirmClear] = useState(false)

  const fetchSaved = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(api("/api/admin/parlay/saved-legs"), { credentials: "include" })
      if (!r.ok) throw new Error(await r.text())
      const j = await r.json()
      setRows(j.legs ?? [])
    } catch (e) {
      toast({ title: "Failed to load saved legs", description: String(e), variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { void fetchSaved() }, [fetchSaved])

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleAddSelected = () => {
    const toAdd = rows.filter(r => selected.has(r.id)).map(r => r.leg_payload)
    if (toAdd.length === 0) return
    onAddSelected(toAdd)
    onClose()
  }

  const handleClearAll = async () => {
    if (!confirmClear) { setConfirmClear(true); return }
    try {
      const resp = await fetch(api("/api/admin/parlay/saved-legs"), { method: "DELETE", credentials: "include" })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      // Only clear local state once the server confirmed the delete
      setRows([])
      setSelected(new Set())
      setConfirmClear(false)
    } catch (e) {
      toast({ title: "Failed to clear", description: String(e), variant: "destructive" })
      setConfirmClear(false)
    }
  }

  return (
    <Card className="border-primary/30 bg-card shadow-lg">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest">SAVED PARLAYS</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono py-4 justify-center">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm font-mono text-muted-foreground text-center py-4">No saved legs yet — click the bookmark icon on any leg card</p>
        ) : (
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {rows.map(row => (
              <div
                key={row.id}
                onClick={() => toggleSelect(row.id)}
                className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${selected.has(row.id) ? "bg-primary/10 border border-primary/20" : "hover:bg-secondary/40"}`}
              >
                <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${selected.has(row.id) ? "border-primary bg-primary" : "border-muted-foreground/40"}`}>
                  {selected.has(row.id) && <CheckCircle2 className="w-2.5 h-2.5 text-primary-foreground" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{row.leg_payload.selectedPlayerName} <span className="text-muted-foreground font-normal">vs {row.leg_payload.opponentName}</span></p>
                  <p className="text-[10px] font-mono text-muted-foreground">
                    {decisionBadge(row.leg_payload.decision)} · Val {row.leg_payload.validationScore} · {new Date(row.saved_at).toLocaleDateString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className="flex items-center gap-2 pt-1 border-t border-border/40">
            <Button
              size="sm"
              className="font-mono text-xs h-7 flex-1"
              disabled={selected.size === 0}
              onClick={handleAddSelected}
            >
              Add Selected ({selected.size})
            </Button>
            <button
              onClick={handleClearAll}
              className={`text-xs font-mono px-3 py-1.5 rounded border transition-colors ${confirmClear ? "border-destructive text-destructive bg-destructive/10" : "border-border text-muted-foreground hover:border-destructive/50 hover:text-destructive"}`}
            >
              {confirmClear ? "Confirm clear?" : "Clear All"}
            </button>
            {confirmClear && (
              <button
                onClick={() => setConfirmClear(false)}
                className="text-xs font-mono px-2 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
              >Cancel</button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Validation Leg Card (Independent Validation Engine — Task 105) ────────────

function ValidationLegCard({ leg, isAutoSelected, isSaved, onToggleSave }: {
  leg: BuilderLegResult; isAutoSelected?: boolean
  isSaved?: boolean; onToggleSave?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [expandFactors, setExpandFactors] = useState(false)
  const borderCls =
    leg.decision === "KEEP" ? "border-success/30 bg-success/5"
    : leg.decision === "DATA_UNAVAILABLE" ? "border-border/40 bg-muted/30"
    : leg.decision === "REMOVE" ? "border-destructive/40 bg-destructive/5"
    : "border-warning/30 bg-warning/5"

  const scoreColor = (s: number) => s >= 65 ? "bg-success" : s >= 45 ? "bg-warning" : "bg-destructive"
  const riskColor = (s: number) => s <= 35 ? "bg-success" : s <= 55 ? "bg-warning" : "bg-destructive"

  return (
    <Card className={`border ${borderCls} ${isAutoSelected ? "ring-2 ring-primary" : ""}`}>
      <CardContent className="p-3 space-y-2.5">
        {/* Header row */}
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              {decisionBadge(leg.decision)}
              {parlayGradeBadge(leg.parlayGrade)}
              <Badge variant="outline" className="text-[9px] font-mono px-1.5">Grade {leg.reliabilityGrade}</Badge>
              {leg.tournamentName && (
                <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[130px]">{leg.tournamentName}</span>
              )}
            </div>
            <p className="text-sm font-medium leading-snug">
              <span className="text-primary font-bold" style={{ wordBreak: "break-word" }}>{leg.selectedPlayerName}</span>
              <span className="text-muted-foreground mx-1.5 font-mono text-xs">vs</span>
              <span className="text-muted-foreground" style={{ wordBreak: "break-word" }}>{leg.opponentName}</span>
            </p>
          </div>
          {/* Validation score pill */}
          <div className="shrink-0 text-right">
            <p className="text-2xl font-display font-bold tabular-nums leading-none">{leg.validationScore}</p>
            <p className="text-[9px] font-mono text-muted-foreground mt-0.5">/ 100</p>
          </div>
        </div>

        {/* Score bars */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground w-20 shrink-0">Validation</span>
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${scoreColor(leg.validationScore)}`} style={{ width: `${leg.validationScore}%` }} />
            </div>
            <span className="text-[10px] font-mono tabular-nums w-8 text-right">{leg.validationScore}%</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground w-20 shrink-0">Risk</span>
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${riskColor(leg.riskScore)}`} style={{ width: `${leg.riskScore}%` }} />
            </div>
            <span className="text-[10px] font-mono tabular-nums w-8 text-right">{leg.riskScore}%</span>
          </div>
        </div>

        {/* Stats strip */}
        <div className="flex gap-3 text-[10px] font-mono flex-wrap">
          <span className="text-muted-foreground">Removal: <span className={`font-bold ${leg.removalProbability >= 60 ? "text-destructive" : leg.removalProbability >= 40 ? "text-warning" : "text-success"}`}>{leg.removalProbability}%</span></span>
          <span className="text-muted-foreground">Coverage: <span className="text-foreground">{leg.dataCoverage}%</span></span>
          {leg.sourcesTotal > 0 ? (
            <span className="text-muted-foreground">Agreement: <span className="text-foreground">{leg.sourceAgreement}%</span> <span className="text-muted-foreground/60">({leg.sourcesAgreeing}/{leg.sourcesTotal})</span></span>
          ) : (
            <span className="text-muted-foreground">Agreement: <span className="text-warning/80">No data</span></span>
          )}
          {leg.matchupCloseness != null && (
            <span className="text-muted-foreground">
              Closeness:{" "}
              <span className={`font-bold ${leg.matchupCloseness >= 80 ? "text-destructive" : leg.matchupCloseness >= 65 ? "text-warning" : "text-success"}`}>
                {leg.matchupCloseness}
              </span>
              {leg.matchupCloseness >= 80 && <span className="text-destructive/70 ml-0.5">⚑</span>}
            </span>
          )}
          {leg.surface && <span className="text-muted-foreground">Surface: <span className="text-foreground">{leg.surface}</span></span>}
        </div>

        {/* DATA_UNAVAILABLE — no real evidence; distinct from low-confidence */}
        {leg.decision === "DATA_UNAVAILABLE" && leg.dataSourceDiagnostics?.isProviderOutage && (
          <div className="flex items-start gap-1.5 p-2 rounded-lg bg-muted/60 border border-border/40">
            {leg.dataSourceDiagnostics.noDataReason === "player-not-found" ? (
              <UserX className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
            ) : leg.dataSourceDiagnostics.noDataReason === "no-history" ? (
              <Database className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
            ) : (
              <WifiOff className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
            )}
            <div className="min-w-0 space-y-0.5">
              <p className="text-[10px] font-mono text-foreground font-bold">
                {leg.dataSourceDiagnostics.noDataReason === "player-not-found"
                  ? "PLAYER NOT FOUND"
                  : leg.dataSourceDiagnostics.noDataReason === "no-history"
                    ? "NO MATCH RECORDS"
                    : leg.dataSourceDiagnostics.noDataReason === "not-configured"
                      ? "PROVIDERS NOT CONFIGURED"
                      : "DATA UNAVAILABLE"}
              </p>
              <p className="text-[10px] font-mono text-muted-foreground leading-snug">{leg.dataSourceDiagnostics.dataConfidenceNote}</p>
              {/* Per-player provider outcome detail */}
              {leg.dataSourceDiagnostics.selectedPlayerProviderDiag && (
                <p className="text-[9px] font-mono text-muted-foreground/60">
                  Selected player — sources tried: {leg.dataSourceDiagnostics.selectedPlayerProviderDiag.sourcesAttempted.join(", ") || "none"}
                  {leg.dataSourceDiagnostics.selectedPlayerProviderDiag.outcome !== "DATA_FOUND" && (
                    <span className="ml-1 text-muted-foreground/40">({leg.dataSourceDiagnostics.selectedPlayerProviderDiag.outcome})</span>
                  )}
                </p>
              )}
              {leg.dataSourceDiagnostics.opponentProviderDiag && (
                <p className="text-[9px] font-mono text-muted-foreground/60">
                  Opponent — sources tried: {leg.dataSourceDiagnostics.opponentProviderDiag.sourcesAttempted.join(", ") || "none"}
                  {leg.dataSourceDiagnostics.opponentProviderDiag.outcome !== "DATA_FOUND" && (
                    <span className="ml-1 text-muted-foreground/40">({leg.dataSourceDiagnostics.opponentProviderDiag.outcome})</span>
                  )}
                </p>
              )}
              {leg.dataSourceDiagnostics.noDataReason === "player-not-found" && (
                <p className="text-[9px] font-mono text-warning/70">
                  Check name spelling — use the exact name the provider uses (e.g. "R. Nadal" or "Rafael Nadal")
                </p>
              )}
            </div>
          </div>
        )}

        {/* Insufficient data / not found — player-level notice */}
        {leg.decision !== "DATA_UNAVAILABLE" && leg.dataSourceDiagnostics?.dataConfidenceNote && (
          <div className="flex items-start gap-1.5 p-2 rounded-lg bg-warning/10 border border-warning/20">
            <AlertTriangle className="w-3 h-3 text-warning shrink-0 mt-0.5" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-[10px] font-mono text-warning font-bold">INSUFFICIENT DATA</p>
              <p className="text-[10px] font-mono text-warning/80 leading-snug">{leg.dataSourceDiagnostics.dataConfidenceNote}</p>
              <div className="text-[9px] font-mono text-muted-foreground space-y-0.5">
                <p>
                  {leg.dataSourceDiagnostics.selectedPlayerMatchCount} match{leg.dataSourceDiagnostics.selectedPlayerMatchCount !== 1 ? "es" : ""} found for selected
                  {leg.dataSourceDiagnostics.selectedPlayerResolvedVia && leg.dataSourceDiagnostics.selectedPlayerResolvedVia !== "direct"
                    ? ` (via ${leg.dataSourceDiagnostics.selectedPlayerResolvedVia})`
                    : ""}
                  {" · "}
                  {leg.dataSourceDiagnostics.opponentMatchCount} for opponent
                  {leg.dataSourceDiagnostics.opponentResolvedVia && leg.dataSourceDiagnostics.opponentResolvedVia !== "direct"
                    ? ` (via ${leg.dataSourceDiagnostics.opponentResolvedVia})`
                    : ""}
                </p>
                {/* Provider diag — show when a live fetch was attempted */}
                {(leg.dataSourceDiagnostics.selectedPlayerProviderDiag?.outcome === "PLAYER_NOT_FOUND" ||
                  leg.dataSourceDiagnostics.selectedPlayerProviderDiag?.outcome === "NO_MATCH_HISTORY") && (
                  <p className="text-warning/60">
                    Provider search ({leg.dataSourceDiagnostics.selectedPlayerProviderDiag.sourcesAttempted.join(", ")}):
                    {" "}{leg.dataSourceDiagnostics.selectedPlayerProviderDiag.outcome === "PLAYER_NOT_FOUND"
                      ? "player not recognised — check name spelling"
                      : "player found but no match records returned"}
                  </p>
                )}
                {(leg.dataSourceDiagnostics.opponentProviderDiag?.outcome === "PLAYER_NOT_FOUND" ||
                  leg.dataSourceDiagnostics.opponentProviderDiag?.outcome === "NO_MATCH_HISTORY") && (
                  <p className="text-warning/60">
                    Opponent provider search: {leg.dataSourceDiagnostics.opponentProviderDiag.outcome === "PLAYER_NOT_FOUND"
                      ? "not recognised"
                      : "no match records"}
                  </p>
                )}
                {leg.dataSourceDiagnostics.selectedPlayerProviderDiag?.outcome === "DATA_FOUND" && (
                  <p className="text-success/70">
                    Live data fetched from {leg.dataSourceDiagnostics.selectedPlayerProviderDiag.sourcesSuccessful.join(", ")}
                    {" "}({leg.dataSourceDiagnostics.selectedPlayerProviderDiag.recordsPerSource
                      ? Object.values(leg.dataSourceDiagnostics.selectedPlayerProviderDiag.recordsPerSource)[0]
                      : "?"} records)
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Critical flags */}
        {leg.criticalFlags.length > 0 && (
          <div className="space-y-0.5">
            {leg.criticalFlags.map((f, i) => (
              <p key={i} className="text-[10px] font-mono text-destructive flex items-start gap-1">
                <XCircle className="w-3 h-3 shrink-0 mt-0.5" />
                <span style={{ wordBreak: "break-word" }}>{f}</span>
              </p>
            ))}
          </div>
        )}

        {/* Action row: reasons toggle + factor breakdown toggle + save bookmark */}
        {/* validationScore is the authoritative "better pick" signal used for sort and display */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? "Hide" : "Show"} {leg.reasons.length} reason{leg.reasons.length !== 1 ? "s" : ""}
          </button>
          {leg.factorScores.length > 0 && (
            <button
              onClick={() => setExpandFactors(e => !e)}
              className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              {expandFactors ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {expandFactors ? "Hide" : "Show"} factor breakdown ({leg.factorScores.filter(f => f.available).length} active)
            </button>
          )}
          {/* Bookmark/save — saves this leg snapshot to the Saved Parlays folder */}
          {onToggleSave && (
            <button
              onClick={onToggleSave}
              title={isSaved ? "Remove from Saved Parlays" : "Save to Saved Parlays"}
              className={`ml-auto flex items-center gap-1 text-[10px] font-mono transition-colors ${isSaved ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
            >
              {isSaved ? <BookmarkCheck className="w-3.5 h-3.5" fill="currentColor" /> : <Bookmark className="w-3.5 h-3.5" />}
              {isSaved ? "Saved" : "Save"}
            </button>
          )}
        </div>

        {expanded && (
          <div className="space-y-0.5 pt-0.5 border-t border-border/30">
            {leg.reasons.map((r, i) => (
              <p key={i} className="text-[11px] text-muted-foreground font-mono leading-snug" style={{ wordBreak: "break-word" }}>· {r}</p>
            ))}
          </div>
        )}

        {/* Factor scores (expandable) */}
        {leg.factorScores.length > 0 && expandFactors && (
          <div className="space-y-1.5 pt-1 border-t border-border/30">
            {leg.factorScores.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-[10px]">
                <span className={`w-2 h-2 rounded-full shrink-0 ${f.available ? (f.score >= 65 ? "bg-success" : f.score >= 45 ? "bg-warning" : "bg-destructive") : "bg-muted"}`} />
                <span className="font-mono text-muted-foreground shrink-0 w-28 truncate">{f.name}</span>
                {f.available ? (
                  <>
                    <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-primary/60 transition-all" style={{ width: `${f.score}%` }} />
                    </div>
                    <span className="font-mono tabular-nums w-7 text-right text-foreground">{f.score}</span>
                    <span className="font-mono text-muted-foreground/60 w-12 text-right">{f.weight}%w</span>
                  </>
                ) : (
                  <span className="font-mono text-muted-foreground/50 italic">unavailable</span>
                )}
              </div>
            ))}
            <p className="text-[9px] font-mono text-muted-foreground/40 pt-1">Builder v{leg.builderVersion} — Independent from Prediction Engine</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Backtest ──────────────────────────────────────────────────────────────────

function BacktestMode() {
  const { toast } = useToast()
  const [search, setSearch] = useState("")
  const [legs, setLegs] = useState<BacktestLegRow[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Map<number, { side: "1" | "2"; odds: string }>>(new Map())
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [running, setRunning] = useState(false)

  const fetchLegs = async () => {
    setLoading(true)
    try {
      const r = await fetch(api(`/api/admin/parlay/backtest-legs?search=${encodeURIComponent(search)}&limit=60`), { credentials: "include" })
      const j = await r.json()
      setLegs(j.legs ?? [])
    } catch { toast({ title: "Failed to load", variant: "destructive" }) }
    finally { setLoading(false) }
  }

  const toggleLeg = (id: number) => {
    setSelected(prev => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, { side: "1", odds: "" })
      return next
    })
  }

  const runBacktest = async () => {
    if (selected.size === 0) return
    setRunning(true)
    try {
      const legs = Array.from(selected.entries()).map(([predictionId, { side, odds }]) => ({
        predictionId, selectedSide: side,
        marketOdds: odds && !isNaN(parseFloat(odds)) ? parseFloat(odds) : null,
      }))
      const r = await fetch(api("/api/admin/parlay/backtest"), {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legs }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? "Backtest failed")
      setResult(j)
    } catch (e) { toast({ title: "Backtest failed", description: String(e), variant: "destructive" }) }
    finally { setRunning(false) }
  }

  return (
    <div className="space-y-5">
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest">SEARCH SETTLED PREDICTIONS</p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
              <Input className="pl-8 h-9 font-mono text-sm" placeholder="Player name…" value={search} onChange={e => setSearch(e.target.value)}
                onKeyDown={e => e.key === "Enter" && fetchLegs()} />
            </div>
            <Button size="sm" variant="outline" className="font-mono gap-1.5" onClick={fetchLegs} disabled={loading}>
              {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              Search
            </Button>
          </div>

          {legs.length > 0 && (
            <div className="max-h-64 overflow-y-auto space-y-1 rounded-lg border border-border/40 p-2">
              {legs.map(leg => {
                const sel = selected.get(leg.id)
                return (
                  <div key={leg.id} className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-secondary/40 transition-colors ${sel ? "bg-primary/10 border border-primary/20" : ""}`}
                    onClick={() => toggleLeg(leg.id)}>
                    <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${sel ? "border-primary bg-primary" : "border-muted-foreground/40"}`}>
                      {sel && <CheckCircle2 className="w-2.5 h-2.5 text-primary-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{leg.player1_name} vs {leg.player2_name}</p>
                      <p className="text-[10px] font-mono text-muted-foreground">{leg.tournament_name ?? "—"} · {leg.surface ?? "—"} · {new Date(leg.scheduled_start_at).toLocaleDateString()}</p>
                    </div>
                    {sel && (
                      <div className="flex gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                        <button onClick={() => setSelected(prev => { const n = new Map(prev); n.set(leg.id, { ...n.get(leg.id)!, side: "1" }); return n })}
                          className={`text-[9px] px-1.5 py-0.5 rounded font-mono border ${sel.side === "1" ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
                          {leg.player1_name.split(" ").pop()}
                        </button>
                        <button onClick={() => setSelected(prev => { const n = new Map(prev); n.set(leg.id, { ...n.get(leg.id)!, side: "2" }); return n })}
                          className={`text-[9px] px-1.5 py-0.5 rounded font-mono border ${sel.side === "2" ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
                          {leg.player2_name.split(" ").pop()}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {selected.size > 0 && (
            <Button className="font-mono gap-2 w-full" onClick={runBacktest} disabled={running}>
              {running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
              Run Backtest ({selected.size} leg{selected.size > 1 ? "s" : ""})
            </Button>
          )}
        </CardContent>
      </Card>

      {result && (
        <div className="space-y-4">
          {/* Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "LOSS CAPTURE", value: result.metrics.lossCaptureRate != null ? `${result.metrics.lossCaptureRate}%` : "—", tip: "% of actual losses that were Remove or Caution" },
              { label: "FALSE REMOVAL", value: result.metrics.falseRemovalRate != null ? `${result.metrics.falseRemovalRate}%` : "—", tip: "% of Removed legs that actually won", warn: (result.metrics.falseRemovalRate ?? 0) > 30 },
              { label: "APPROVED ACCURACY", value: result.metrics.approvedAccuracy != null ? `${result.metrics.approvedAccuracy}%` : "—", tip: "% of Approved legs that won" },
              { label: "SURVIVAL LIFT", value: `${result.metrics.survivalImprovement > 0 ? "+" : ""}${result.metrics.survivalImprovement.toFixed(1)}%`, tip: "Parlay survival improvement by removing Remove legs", warn: result.metrics.survivalImprovement < 0 },
            ].map(m => (
              <Card key={m.label} className={m.warn ? "border-warning/30 bg-warning/5" : "bg-card"}>
                <CardContent className="p-3">
                  <p className="text-[9px] font-mono font-bold text-muted-foreground tracking-widest">{m.label}</p>
                  <p className="text-xl font-display font-bold tabular-nums text-primary mt-0.5">{m.value}</p>
                  <p className="text-[9px] font-mono text-muted-foreground mt-0.5">{m.tip}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Per-leg backtest results */}
          <div className="space-y-2">
            {result.legs.map((leg, i) => (
              <Card key={i} className={`border ${leg.selectedWon === null ? "border-border/40" : leg.selectedWon ? "border-success/30 bg-success/3" : "border-destructive/30 bg-destructive/3"}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        {decisionBadge(leg.decision)}
                        {leg.selectedWon === null ? <Badge variant="outline" className="text-[10px]">UNRESOLVED</Badge>
                          : leg.selectedWon ? <Badge className="text-[10px] bg-success/20 text-success border-success/30">WON ✓</Badge>
                          : <Badge variant="destructive" className="text-[10px]">LOST ✗</Badge>}
                      </div>
                      <p className="text-sm font-medium">{leg.selectedName}</p>
                      <p className="text-xs text-muted-foreground font-mono">{leg.tournamentName ?? "—"} · {new Date(leg.matchDate).toLocaleDateString()}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-display font-bold tabular-nums">{leg.score.toFixed(1)}</p>
                      <p className="text-[9px] font-mono text-muted-foreground">{leg.winnerProb.toFixed(1)}% cal.</p>
                    </div>
                  </div>
                  <div className="mt-2 space-y-0.5">
                    {leg.reasons.map((r, j) => <p key={j} className="text-[10px] font-mono text-muted-foreground">· {r}</p>)}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

// Shared key with BulkMatchupPredictor — must stay in sync.
const PARLAY_DRAFT_KEY = "parlayDraft.pending.v1"

interface ParlayDraftLeg {
  player1Name: string
  player1Id: string | null
  player2Name: string
  player2Id: string | null
  tournamentName: string | null
  surface: string | null
}

// ── Calibration Dashboard ─────────────────────────────────────────────────────

interface CalibrationBucket { range: string; lo: number; hi: number; count: number; wins: number; losses: number; winRate: number | null; expected: number }
interface DecisionTier { decision: string; count: number; wins: number; losses: number; winRate: number | null; avgValidation: number | null; avgRisk: number | null }
interface ParlayGradeRow { grade: string; count: number; wins: number; winRate: number | null }
interface CalibrationSummary {
  totalLegs: number; backfillLegs: number; liveLegs: number
  overallWinRate: number; filteredWinRate: number | null; removedWinRate: number | null
  removeFilterImprovement: number | null; keepVsRemoveSeparation: number | null
  lossCaptureRate: number | null; falseRemovalRate: number | null
  keepCount: number; borderlineCount: number; removeCount: number
}
interface CalibrationData {
  summary: CalibrationSummary | null
  buckets: CalibrationBucket[]
  decisionTiers: DecisionTier[]
  parlayGrades: ParlayGradeRow[]
  message?: string
}

type PipelineStatus = {
  lastRunAt: string | null
  hoursSinceLastRun: number | null
  quietWindowHours: number
  pipelineQuiet: boolean
  gradedCount: number
  totalCount: number
}

function CalibrationDashboard() {
  const [data, setData] = useState<CalibrationData | null>(null)
  const [loading, setLoading] = useState(false)
  const [backfillStatus, setBackfillStatus] = useState<{ running: boolean; lastResult: { inserted: number; skipped: number; errors: number; finishedAt: string } | null } | null>(null)
  const [triggering, setTriggering] = useState(false)
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus | null>(null)
  const { toast } = useToast()

  const fetchCalibration = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(api("/api/admin/parlay/calibration"), { credentials: "include" })
      if (!r.ok) throw new Error(await r.text())
      setData(await r.json())
    } catch (e) {
      toast({ title: "Failed to load calibration", description: String(e), variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  const fetchBackfillStatus = useCallback(async () => {
    try {
      const r = await fetch(api("/api/admin/parlay/backfill/status"), { credentials: "include" })
      if (r.ok) setBackfillStatus(await r.json())
    } catch { /* silent */ }
  }, [])

  const fetchPipelineStatus = useCallback(async () => {
    try {
      const r = await fetch(api("/api/evaluation/paper-trading/status"), { credentials: "include" })
      if (r.ok) setPipelineStatus(await r.json())
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    void fetchCalibration()
    void fetchBackfillStatus()
    void fetchPipelineStatus()
  }, [fetchCalibration, fetchBackfillStatus, fetchPipelineStatus])

  // Poll while backfill is running
  useEffect(() => {
    if (!backfillStatus?.running) return
    const id = setInterval(() => { void fetchBackfillStatus() }, 4000)
    return () => clearInterval(id)
  }, [backfillStatus?.running, fetchBackfillStatus])

  // Refresh calibration data when backfill finishes
  const prevRunning = useRef(false)
  useEffect(() => {
    if (prevRunning.current && backfillStatus && !backfillStatus.running) {
      void fetchCalibration()
    }
    prevRunning.current = backfillStatus?.running ?? false
  }, [backfillStatus, fetchCalibration])

  const triggerBackfill = async () => {
    setTriggering(true)
    try {
      const r = await fetch(api("/api/admin/parlay/backfill"), {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 1000, minDate: "2022-01-01" }),
      })
      const j = await r.json()
      if (j.started) {
        toast({ title: "Backfill started", description: "Scoring 1,000 historical matches in the background" })
        setBackfillStatus({ running: true, lastResult: null })
      } else {
        toast({ title: j.message ?? "Already running" })
      }
    } catch (e) {
      toast({ title: "Failed to start backfill", description: String(e), variant: "destructive" })
    } finally {
      setTriggering(false)
    }
  }

  const tierColor = (decision: string) =>
    decision === "KEEP" ? "#22c55e" : decision === "REMOVE" ? "#ef4444" : "#94a3b8"

  const bucketColor = (winRate: number | null, expected: number) => {
    if (winRate == null) return "#334155"
    const gap = winRate - expected
    if (gap > 8) return "#22c55e"
    if (gap < -8) return "#ef4444"
    return "#6366f1"
  }

  if (loading && !data) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono py-12 justify-center"><RefreshCw className="w-4 h-4 animate-spin" /> Loading calibration data…</div>
  }

  const s = data?.summary

  return (
    <div className="space-y-5">
      {/* Paper-trading pipeline status banner (Task #110) */}
      {pipelineStatus && (
        <div className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border text-[11px] font-mono ${
          pipelineStatus.pipelineQuiet
            ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
        }`}>
          <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${pipelineStatus.pipelineQuiet ? "bg-amber-400 animate-pulse" : "bg-emerald-400"}`} />
          <span>
            {pipelineStatus.pipelineQuiet
              ? `⚠ Paper-trading pipeline quiet — last run ${pipelineStatus.hoursSinceLastRun != null ? `${pipelineStatus.hoursSinceLastRun}h ago` : "never"} (alert threshold: >${pipelineStatus.quietWindowHours}h)`
              : `✓ Paper-trading pipeline active — last run ${pipelineStatus.hoursSinceLastRun}h ago`
            }
          </span>
          <span className="ml-auto text-muted-foreground">
            {pipelineStatus.gradedCount.toLocaleString()} graded / {pipelineStatus.totalCount.toLocaleString()} total legs
          </span>
        </div>
      )}

      {/* Header + controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-display font-semibold text-base">Calibration Report</h2>
          <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
            {s ? `${s.totalLegs.toLocaleString()} resolved legs (${s.backfillLegs} backfill · ${s.liveLegs} live)` : "No data yet — run the historical backfill first"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {backfillStatus?.running && (
            <span className="flex items-center gap-1.5 text-[11px] font-mono text-amber-400">
              <RefreshCw className="w-3 h-3 animate-spin" /> Backfill running…
            </span>
          )}
          {backfillStatus?.lastResult && !backfillStatus.running && (
            <span className="text-[11px] font-mono text-muted-foreground">
              Last run: +{backfillStatus.lastResult.inserted} rows
            </span>
          )}
          <button onClick={triggerBackfill} disabled={triggering || backfillStatus?.running}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-40">
            <Database className="w-3.5 h-3.5" />
            {backfillStatus?.running ? "Running…" : "Run Backfill"}
          </button>
          <button onClick={() => { void fetchCalibration(); void fetchBackfillStatus() }}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-40">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {!s ? (
        <Card className="border-dashed bg-secondary/20">
          <CardContent className="py-12 text-center space-y-3">
            <Database className="w-10 h-10 text-muted-foreground/30 mx-auto" />
            <p className="text-sm font-mono text-muted-foreground">No resolved legs found</p>
            <p className="text-xs text-muted-foreground/60 font-mono">Run the historical backfill to generate calibration data</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Overall Win Rate", value: `${s.overallWinRate}%`, sub: `${s.totalLegs} legs` },
              { label: "KEEP Win Rate", value: s.filteredWinRate != null ? `${s.filteredWinRate}%` : "—", sub: `${s.keepCount} KEEP legs` },
              { label: "REMOVE Win Rate", value: s.removedWinRate != null ? `${s.removedWinRate}%` : "—", sub: `${s.removeCount} removed` },
              { label: "KEEP–REMOVE Gap", value: s.keepVsRemoveSeparation != null ? `${s.keepVsRemoveSeparation > 0 ? "+" : ""}${s.keepVsRemoveSeparation}pp` : "—",
                sub: s.keepVsRemoveSeparation != null ? (s.keepVsRemoveSeparation >= 15 ? "✓ Strong separation" : s.keepVsRemoveSeparation >= 5 ? "⚠ Moderate" : "✗ Weak") : "" },
            ].map(c => (
              <Card key={c.label} className="bg-secondary/20">
                <CardContent className="p-3">
                  <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">{c.label}</p>
                  <p className="text-2xl font-display font-bold tabular-nums mt-1">{c.value}</p>
                  <p className="text-[10px] font-mono text-muted-foreground/70 mt-0.5">{c.sub}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Before/After REMOVE filter row */}
          <Card className="bg-secondary/20">
            <CardContent className="p-4 space-y-2">
              <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Remove Filter Impact</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div>
                  <p className="text-lg font-display font-bold tabular-nums">{s.overallWinRate}%</p>
                  <p className="text-[10px] font-mono text-muted-foreground">Win rate (all legs)</p>
                </div>
                <div>
                  <p className={`text-lg font-display font-bold tabular-nums ${(s.removeFilterImprovement ?? 0) > 0 ? "text-success" : "text-destructive"}`}>
                    {s.filteredWinRate ?? "—"}% {s.removeFilterImprovement != null ? `(${s.removeFilterImprovement > 0 ? "+" : ""}${s.removeFilterImprovement}pp)` : ""}
                  </p>
                  <p className="text-[10px] font-mono text-muted-foreground">After removing REMOVE legs</p>
                </div>
                <div>
                  <p className="text-lg font-display font-bold tabular-nums">{s.lossCaptureRate ?? "—"}%</p>
                  <p className="text-[10px] font-mono text-muted-foreground">Losses captured by REMOVE</p>
                </div>
                <div>
                  <p className="text-lg font-display font-bold tabular-nums">{s.falseRemovalRate ?? "—"}%</p>
                  <p className="text-[10px] font-mono text-muted-foreground">REMOVE rows that won (false removals)</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Validation Score Calibration Chart */}
          <Card className="bg-secondary/20">
            <CardContent className="p-4 space-y-3">
              <div>
                <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Validation Score Calibration</p>
                <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">Actual win rate per 10-point score bucket vs expected diagonal. Bars above the line = better than expected.</p>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={data!.buckets} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="range" tick={{ fontSize: 10, fontFamily: "monospace", fill: "#64748b" }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fontFamily: "monospace", fill: "#64748b" }} tickFormatter={v => `${v}%`} />
                  <Tooltip
                    contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 6, fontSize: 12, fontFamily: "monospace" }}
                    formatter={(value: number, name: string) => [`${value}%`, name === "winRate" ? "Actual win rate" : name === "expected" ? "Expected (diagonal)" : name]}
                    labelFormatter={l => `Score bucket: ${l}`}
                  />
                  <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace" }} />
                  <Bar dataKey="winRate" name="Actual win rate" radius={[2, 2, 0, 0]} maxBarSize={32}>
                    {data!.buckets.map((b, i) => <Cell key={i} fill={bucketColor(b.winRate, b.expected)} fillOpacity={0.85} />)}
                  </Bar>
                  <Line type="monotone" dataKey="expected" name="Expected" stroke="#475569" strokeDasharray="4 2" dot={false} strokeWidth={1.5} />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Decision tier table */}
          <div className="grid md:grid-cols-2 gap-3">
            <Card className="bg-secondary/20">
              <CardContent className="p-4 space-y-3">
                <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Per Decision Tier</p>
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-muted-foreground/60 text-[10px]">
                      <th className="text-left pb-2">Decision</th>
                      <th className="text-right pb-2">n</th>
                      <th className="text-right pb-2">Win %</th>
                      <th className="text-right pb-2">Avg Val</th>
                      <th className="text-right pb-2">Avg Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.decisionTiers.filter(t => t.count > 0).map(t => (
                      <tr key={t.decision} className="border-t border-border/30">
                        <td className="py-1.5 pr-2">
                          <span className="inline-flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full" style={{ background: tierColor(t.decision) }} />
                            {t.decision}
                          </span>
                        </td>
                        <td className="text-right text-muted-foreground">{t.count}</td>
                        <td className="text-right font-bold" style={{ color: tierColor(t.decision) }}>
                          {t.winRate != null ? `${t.winRate}%` : "—"}
                        </td>
                        <td className="text-right text-muted-foreground">{t.avgValidation ?? "—"}</td>
                        <td className="text-right text-muted-foreground">{t.avgRisk ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResponsiveContainer width="100%" height={100}>
                  <BarChart data={data!.decisionTiers.filter(t => t.count > 0)} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <XAxis dataKey="decision" tick={{ fontSize: 9, fontFamily: "monospace", fill: "#64748b" }} />
                    <YAxis domain={[0, 100]} hide />
                    <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", fontSize: 11, fontFamily: "monospace" }} formatter={(v: number) => [`${v}%`, "Win rate"]} />
                    <Bar dataKey="winRate" radius={[2, 2, 0, 0]} maxBarSize={36}>
                      {data!.decisionTiers.filter(t => t.count > 0).map((t, i) => <Cell key={i} fill={tierColor(t.decision)} fillOpacity={0.85} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="bg-secondary/20">
              <CardContent className="p-4 space-y-3">
                <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Per Parlay Grade</p>
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-muted-foreground/60 text-[10px]">
                      <th className="text-left pb-2">Grade</th>
                      <th className="text-right pb-2">n</th>
                      <th className="text-right pb-2">Wins</th>
                      <th className="text-right pb-2">Win %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.parlayGrades.filter(g => g.count > 0).map(g => (
                      <tr key={g.grade} className="border-t border-border/30">
                        <td className="py-1.5 pr-2 font-semibold">{g.grade}</td>
                        <td className="text-right text-muted-foreground">{g.count}</td>
                        <td className="text-right text-muted-foreground">{g.wins}</td>
                        <td className="text-right font-bold">{g.winRate != null ? `${g.winRate}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

export default function AdminParlayBuilder() {
  const { toast } = useToast()
  const search = useSearch()
  const [mode, setMode] = useState<"live" | "history" | "backtest" | "calibration">("live")
  const resultsRef = useRef<HTMLDivElement>(null)

  // Input-phase state
  const [legs, setLegs] = useState<ParlayLeg[]>([])
  const [isResolving, setIsResolving] = useState(false)
  const [showHealthPanel, setShowHealthPanel] = useState(false)

  // Results state
  const [result, setResult] = useState<BuilderSession | null>(null)
  const [evaluating, setEvaluating] = useState(false)
  const [analyzePhase, setAnalyzePhase] = useState<"predicting" | "evaluating" | null>(null)
  const [slipView, setSlipView] = useState<"all" | "KEEP" | "BORDERLINE" | "REMOVE">("all")
  const [agreementOnly, setAgreementOnly] = useState(false)
  const [engineAgreementKeys, setEngineAgreementKeys] = useState<Set<string>>(new Set())
  const [loadingAgreement, setLoadingAgreement] = useState(false)
  const [autoSelected, setAutoSelected] = useState<Set<number>>(new Set())
  // Maps result.legs[i] → the ParlayLeg key that produced it, so we can flip legs by result decision
  const [resultLegKeys, setResultLegKeys] = useState<string[]>([])

  // Saved parlays: Map of "selectedPlayerName|opponentName" → DB row id
  const [savedMap, setSavedMap] = useState<Map<string, number>>(new Map())
  const [showSavedPanel, setShowSavedPanel] = useState(false)

  // Session persistence: debounce ref so rapid changes don't spam the server
  const sessionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionRestoredRef = useRef(false)

  // Stores the predicted winner per leg key from the most recent analysis run,
  // so Best of Best can flip all legs to the engine's preferred pick without re-running predictions.
  const legSignalsRef = useRef<Record<string, { predictedWinnerSide: "1" | "2" } | null>>({})

  // ── Bulk predictor draft handoff ───────────────────────────────────────────
  // When navigated to with ?draft=1, read match data from sessionStorage and
  // preload as idle legs. Nothing is auto-triggered — the user controls every
  // subsequent action (Validate, Analyze, Build Parlay, etc.).
  useEffect(() => {
    const params = new URLSearchParams(search)
    if (!params.has("draft")) return

    try {
      const raw = sessionStorage.getItem(PARLAY_DRAFT_KEY)
      if (!raw) return
      const draft: ParlayDraftLeg[] = JSON.parse(raw)
      if (!Array.isArray(draft) || draft.length === 0) return

      const preloaded: ParlayLeg[] = draft.map((d, i) => ({
        key: `draft-${i}-${Math.random()}`,
        status: "resolved" as LegStatus,
        player1Name: d.player1Name,
        player1Id: d.player1Id,
        player2Name: d.player2Name,
        player2Id: d.player2Id,
        tournamentName: d.tournamentName,
        surface: d.surface,
        warnings: [],
        selectedSide: "1",
        marketOdds: "",
      }))

      setLegs(preloaded)
      sessionStorage.removeItem(PARLAY_DRAFT_KEY)

      toast({
        title: `${preloaded.length} leg${preloaded.length === 1 ? "" : "s"} loaded`,
        description: "Review the matchups below, then click Analyze Parlay when ready.",
      })
    } catch {
      // Corrupt or missing draft — open blank, user can add legs manually.
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — intentionally runs once on mount only

  // ── Session persistence: restore previous session on mount ─────────────────
  // Separate from the draft handoff above; the draft handoff only fires when ?draft=1
  // is in the URL. This effect restores the session on every non-draft load.
  //
  // IMPORTANT: sessionRestoredRef.current is only set true AFTER the async GET
  // completes (success or error). The debounced save checks this flag before
  // writing, preventing the initial-empty-state PUT from overwriting a stored session.
  useEffect(() => {
    if (sessionRestoredRef.current) return
    const params = new URLSearchParams(search)
    if (params.has("draft")) {
      // Draft takes precedence — treat restore as complete so saves work normally
      sessionRestoredRef.current = true
      return
    }
    void (async () => {
      try {
        const r = await fetch(api("/api/admin/parlay/session"), { credentials: "include" })
        if (r.ok) {
          const payload = await r.json()
          if (payload && typeof payload === "object") {
            if (Array.isArray(payload.legs) && payload.legs.length > 0) {
              setLegs(payload.legs as ParlayLeg[])
            }
            if (payload.slipView) setSlipView(payload.slipView)
            if (payload.result) setResult(payload.result as BuilderSession)
          }
        }
      } catch { /* silent — session restore is best-effort */ }
      finally {
        // Mark restore complete regardless of outcome so subsequent saves can proceed
        sessionRestoredRef.current = true
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — runs once on mount only

  // ── Session persistence: debounced save on legs/filter/result changes ──────
  // Gate on sessionRestoredRef.current so the initial empty-state render
  // cannot fire a PUT before the GET restore has had a chance to resolve.
  useEffect(() => {
    if (sessionDebounceRef.current) clearTimeout(sessionDebounceRef.current)
    sessionDebounceRef.current = setTimeout(() => {
      if (!sessionRestoredRef.current) return // restore still in flight — skip
      void fetch(api("/api/admin/parlay/session"), {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legs, slipView, result }),
      }).catch(() => { /* fire-and-forget, silent failure */ })
    }, 500)
    return () => {
      if (sessionDebounceRef.current) clearTimeout(sessionDebounceRef.current)
    }
  }, [legs, slipView, result])

  // ── Load saved legs on mount to populate savedMap ─────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(api("/api/admin/parlay/saved-legs"), { credentials: "include" })
        if (!r.ok) return
        const j = await r.json()
        const rows: Array<{ id: number; leg_payload: BuilderLegResult }> = j.legs ?? []
        setSavedMap(new Map(rows.map(row => [
          `${row.leg_payload.selectedPlayerName}|${row.leg_payload.opponentName}`,
          row.id,
        ])))
      } catch { /* silent */ }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — runs once on mount only

  // ── Save / unsave a leg ────────────────────────────────────────────────────
  const handleToggleSave = useCallback(async (leg: BuilderLegResult) => {
    const key = `${leg.selectedPlayerName}|${leg.opponentName}`
    const existingId = savedMap.get(key)
    if (existingId != null) {
      // Unsave — check response.ok before removing from local state
      try {
        const resp = await fetch(api(`/api/admin/parlay/saved-legs/${existingId}`), { method: "DELETE", credentials: "include" })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        setSavedMap(prev => { const n = new Map(prev); n.delete(key); return n })
      } catch (e) {
        toast({ title: "Failed to unsave", description: String(e), variant: "destructive" })
      }
    } else {
      // Save — check response.ok before updating local state
      try {
        const r = await fetch(api("/api/admin/parlay/saved-legs"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ legPayload: leg }),
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
        const j = await r.json()
        setSavedMap(prev => new Map(prev).set(key, j.id as number))
      } catch (e) {
        toast({ title: "Failed to save", description: String(e), variant: "destructive" })
      }
    }
  }, [savedMap, toast])

  // ── Screenshot processing (identical to BulkMatchupPredictor) ─────────────

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return
    setResult(null)

    const toProcess = files.slice(0, MAX_FILES)
    if (files.length > MAX_FILES) toast({ title: `Only first ${MAX_FILES} screenshots used` })

    const initialLegs: ParlayLeg[] = toProcess.map((f, i) => ({
      key: `${f.name}-${f.lastModified}-${i}-${Math.random()}`,
      status: "resolving",
      player1Name: "", player1Id: null,
      player2Name: "", player2Id: null,
      tournamentName: null, surface: null,
      warnings: [], selectedSide: "1", marketOdds: "",
    }))

    setLegs(prev => [...prev, ...initialLegs])
    setIsResolving(true)

    await runWithConcurrency(toProcess, RESOLVE_CONCURRENCY, async (file, idx) => {
      const key = initialLegs[idx].key
      try {
        const imageBase64 = await fileToBase64DataUrl(file)
        const res = await fetch(api("/api/matchups/from-screenshot"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64 }),
        })
        const data = await res.json() as ScreenshotResult & { debugLog?: string[] }

        if (!res.ok) {
          setLegs(prev => prev.map(l => l.key !== key ? l : {
            ...l, status: "error", errorMessage: (data as any).error ?? `HTTP ${res.status}`, debugLog: data.debugLog,
          }))
          return
        }

        // Helper to extract player info from a player slot in the API response
        const extractPlayer = (slot: any) => ({
          id: slot?.player?.id ?? null as string | null,
          name: slot?.recognizedName ?? "" as string,
          candidates: (slot?.candidates ?? []) as PlayerCandidate[],
          isAmbiguous: slot?.status === "ambiguous",
        })

        // Multi-matchup image: expand each matchup to its own leg
        if (data.matchups && data.matchups.length > 1) {
          const expandedLegs: ParlayLeg[] = data.matchups.map((m, mi) => {
            const p1 = extractPlayer(m.player1)
            const p2 = extractPlayer(m.player2)
            const bothResolved = !!p1.id && !!p2.id
            return {
              key: `${key}-m${mi}`,
              status: (bothResolved ? "resolved" : "unresolved") as LegStatus,
              player1Name: p1.name,
              player1Id: p1.id,
              player1Candidates: p1.candidates,
              player2Name: p2.name,
              player2Id: p2.id,
              player2Candidates: p2.candidates,
              tournamentName: m.event.recognizedName ?? null,
              surface: m.event.surface ?? null,
              warnings: m.warnings ?? [],
              selectedSide: "1", marketOdds: "",
              debugLog: data.debugLog,
            }
          })
          setLegs(prev => {
            const idx2 = prev.findIndex(l => l.key === key)
            if (idx2 === -1) return prev
            return [...prev.slice(0, idx2), ...expandedLegs, ...prev.slice(idx2 + 1)]
          })
        } else {
          const p1 = extractPlayer((data as any).player1)
          const p2 = extractPlayer((data as any).player2)
          const ready = !!p1.id && !!p2.id
          setLegs(prev => prev.map(l => l.key !== key ? l : {
            ...l,
            status: ready ? "resolved" : "unresolved",
            player1Name: p1.name,
            player1Id: p1.id,
            player1Candidates: p1.candidates,
            player2Name: p2.name,
            player2Id: p2.id,
            player2Candidates: p2.candidates,
            tournamentName: data.event?.recognizedName ?? null,
            surface: data.event?.surface ?? null,
            warnings: data.warnings ?? [],
            debugLog: data.debugLog,
          }))
        }
      } catch (e) {
        setLegs(prev => prev.map(l => l.key !== key ? l : {
          ...l, status: "error", errorMessage: e instanceof Error ? e.message : "Upload failed",
        }))
      }
    })
    setIsResolving(false)
  }

  const updateLeg = (key: string, patch: Partial<ParlayLeg>) =>
    setLegs(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l))

  const removeLeg = (key: string) => setLegs(prev => prev.filter(l => l.key !== key))

  // ── Analyze Parlay ─────────────────────────────────────────────────────────

  const analyzeParlay = async (overrideLegs?: ParlayLeg[]) => {
    // All legs with names — selectedSide defaults to "1" so no manual click needed
    const sourcLegs = overrideLegs ?? legs
    const ready = sourcLegs.filter(l =>
      l.status !== "resolving" && l.status !== "error" &&
      (l.player1Name || l.player2Name)
    )
    if (ready.length === 0) { toast({ title: "Upload at least one match before analyzing" }); return }
    // Record the key order so switchBorderlineLegs can map result[i] → leg key
    setResultLegKeys(ready.map(l => l.key))

    setEvaluating(true)
    setResult(null)
    try {
      // ── Phase 1: Run fresh predictions, auto-determine which side to back ─────
      setAnalyzePhase("predicting")
      type InlineSignals = {
        calibratedProbabilityP1: number
        dataQuality: number
        dataQualityLabel: string
        upsetRisk: string
        modelAgreement: string
        closenessTo50: number | null
        /** Auto-determined from calibratedProbabilityP1: back the predicted winner */
        predictedWinnerSide: "1" | "2"
      }
      const legSignals: Record<string, InlineSignals | null> = {}

      await Promise.all(ready.map(async (l) => {
        if (!l.player1Id || !l.player2Id) { legSignals[l.key] = null; return }
        try {
          const r = await fetch(api("/api/predictions"), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              player1Id: l.player1Id,
              player2Id: l.player2Id,
              surface: l.surface ?? "Hard",
              matchFormat: "best-of-3",
              tournamentName: l.tournamentName ?? null,
            }),
          })
          if (!r.ok) { legSignals[l.key] = null; return }
          const pred = await r.json()
          const calibP1 = Number(pred.calibratedProbability)
          legSignals[l.key] = {
            calibratedProbabilityP1: calibP1,
            dataQuality: Number(pred.dataQuality),
            dataQualityLabel: pred.dataQualityLabel ?? "Unknown",
            upsetRisk: pred.upsetRisk ?? "UNKNOWN",
            modelAgreement: pred.engine?.modelAgreement ?? "Unknown",
            closenessTo50: typeof pred.engine?.closenessTo50 === "number" ? pred.engine.closenessTo50 : null,
            predictedWinnerSide: calibP1 >= 50 ? "1" : "2",
          }
        } catch {
          legSignals[l.key] = null
        }
      }))

      // Persist signals so Best of Best can flip all legs to the predicted winner
      // even after the user has manually toggled some legs post-analysis.
      legSignalsRef.current = Object.fromEntries(
        Object.entries(legSignals).map(([k, v]) => [k, v ? { predictedWinnerSide: v.predictedWinnerSide } : null])
      )

      // Update selectedSide in state to reflect the auto-picked predicted winner
      // (skip if we were called with overrideLegs — those already have the right side)
      if (!overrideLegs) {
        setLegs(prev => prev.map(l => {
          const sig = legSignals[l.key]
          if (!sig) return l
          return { ...l, selectedSide: sig.predictedWinnerSide }
        }))
      }

      // ── Phase 2: Independent Builder Validation (Task 105) ───────────────────
      // Reads historical_matches directly — NEVER uses engine scores or predictions table.
      setAnalyzePhase("evaluating")
      const validateBody = {
        legs: ready.map(l => {
          const sig = legSignals[l.key]
          const selectedSide: "1" | "2" = sig?.predictedWinnerSide ?? l.selectedSide ?? "1"
          return {
            selectedPlayerId: selectedSide === "1"
              ? (l.player1Id ?? `unresolved-${l.key}-p1`)
              : (l.player2Id ?? `unresolved-${l.key}-p2`),
            selectedPlayerName: selectedSide === "1"
              ? (l.player1Name ?? "Unknown")
              : (l.player2Name ?? "Unknown"),
            opponentId: selectedSide === "1"
              ? (l.player2Id ?? `unresolved-${l.key}-p2`)
              : (l.player1Id ?? `unresolved-${l.key}-p1`),
            opponentName: selectedSide === "1"
              ? (l.player2Name ?? "Unknown")
              : (l.player1Name ?? "Unknown"),
            surface: l.surface ?? null,
            tournamentName: l.tournamentName ?? null,
            marketOdds: l.marketOdds && !isNaN(parseFloat(l.marketOdds)) ? parseFloat(l.marketOdds) : null,
          }
        }),
      }
      const r = await fetch(api("/api/admin/parlay/validate"), {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validateBody),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? "Validation failed")
      setResult(j as BuilderSession)
      setAutoSelected(new Set())
    } catch (e) {
      toast({ title: "Validation failed", description: String(e), variant: "destructive" })
    } finally {
      setEvaluating(false)
      setAnalyzePhase(null)
    }
  }

  // Auto-scroll to results on mobile when analysis completes
  useEffect(() => {
    if (result) {
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100)
    }
  }, [result])

  // ── Derived state ──────────────────────────────────────────────────────────

  // All legs with names are ready to analyze — selectedSide is auto-defaulted to "1"
  const legsWithSelection = legs.filter(l =>
    l.status !== "resolving" && l.status !== "error" &&
    (l.player1Name || l.player2Name)
  )
  const canAnalyze = legsWithSelection.length > 0 && !isResolving && !evaluating

  // Auto-sort: higher validationScore (the authoritative "better pick" signal) appears first.
  // Applied at display layer only — does not mutate the underlying result.legs array.
  const filteredResultLegs: BuilderLegResult[] = (result?.legs.filter((l: BuilderLegResult, index: number) => {
    const key = resultLegKeys[index]
    return (slipView === "all" || l.decision === slipView) && (!agreementOnly || engineAgreementKeys.has(key))
  }) ?? []).slice().sort((a, b) => b.validationScore - a.validationScore)

  const toggleEngineAgreement = async () => {
    if (agreementOnly) {
      setAgreementOnly(false)
      return
    }
    if (legs.length === 0) return
    setLoadingAgreement(true)
    try {
      const lookupLegs = legs.map(leg => ({
        key: leg.key, player1Id: leg.player1Id, player2Id: leg.player2Id,
      }))
      const response = await fetch(api("/api/admin/parlay/engine-agreement"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legs: lookupLegs }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? "Engine agreement lookup failed")
      const agreeingKeys = new Set<string>()
      for (const prediction of payload.predictions ?? []) {
        const leg = legs.find(candidate => candidate.key === prediction.key)
        const predictedSide = leg?.player1Id === prediction.predictedWinnerId ? "1" : leg?.player2Id === prediction.predictedWinnerId ? "2" : null
        if (leg && predictedSide === leg.selectedSide) agreeingKeys.add(leg.key)
      }
      setEngineAgreementKeys(agreeingKeys)
      setAgreementOnly(true)
    } catch (e) {
      toast({ title: "Engine agreement lookup failed", description: String(e), variant: "destructive" })
    } finally {
      setLoadingAgreement(false)
    }
  }

  // Auto Builder helpers — pick KEEP legs sorted by validationScore
  const autoPickLegs = (count: number | "all", sortBy: "validationScore" | "riskScore" = "validationScore") => {
    if (!result) return
    const keepLegs = result.legs
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.decision === "KEEP")
      .sort((a, b) => sortBy === "riskScore" ? a.l.riskScore - b.l.riskScore : b.l.validationScore - a.l.validationScore)
    const pick = count === "all" ? keepLegs : keepLegs.slice(0, count)
    setAutoSelected(new Set(pick.map(({ i }) => i)))
    setSlipView("all")
  }

  // ── Switch Borderline ───────────────────────────────────────────────────────
  // Flip the selected player for every BORDERLINE leg, then re-run the analysis.
  // result.legs[i] maps to the leg with key resultLegKeys[i] (recorded at analysis time).
  const borderlineCount = result?.legs.filter(l => l.decision === "BORDERLINE").length ?? 0

  const switchBorderlineLegs = () => {
    if (!result || resultLegKeys.length === 0) return

    // Build set of keys that scored BORDERLINE
    const borderlineKeySet = new Set(
      result.legs
        .map((leg, i) => leg.decision === "BORDERLINE" ? resultLegKeys[i] : null)
        .filter((k): k is string => k != null)
    )
    if (borderlineKeySet.size === 0) return

    // Flip those legs to the opposite player, keep everything else intact
    const flipped = legs.map(l =>
      borderlineKeySet.has(l.key)
        ? { ...l, selectedSide: (l.selectedSide === "1" ? "2" : "1") as "1" | "2" }
        : l
    )
    setLegs(flipped)
    // Re-run analysis immediately with the flipped legs (pass directly so we
    // don't wait for the React state update to propagate)
    analyzeParlay(flipped)

    toast({
      title: `Switched ${borderlineKeySet.size} BORDERLINE leg${borderlineKeySet.size === 1 ? "" : "s"}`,
      description: "Re-running analysis with the opposing players selected.",
    })
  }

  const removeDecisionLegs = (decision: "BORDERLINE" | "REMOVE") => {
    if (!result || resultLegKeys.length === 0) return
    const keys = new Set(result.legs.map((leg, index) => leg.decision === decision ? resultLegKeys[index] : null).filter((key): key is string => key != null))
    if (keys.size === 0) return
    setLegs(legs.filter(leg => !keys.has(leg.key)))
    setResult(null)
    setAutoSelected(new Set())
    setSlipView("all")
    toast({ title: `Removed ${keys.size} ${decision} leg${keys.size === 1 ? "" : "s"}` })
  }

  const switchRemoveLegs = () => {
    if (!result || resultLegKeys.length === 0) return
    const keys = new Set(result.legs.map((leg, index) => leg.decision === "REMOVE" ? resultLegKeys[index] : null).filter((key): key is string => key != null))
    if (keys.size === 0) return
    const flipped = legs.map(leg => keys.has(leg.key) ? { ...leg, selectedSide: (leg.selectedSide === "1" ? "2" : "1") as "1" | "2" } : leg)
    setLegs(flipped)
    analyzeParlay(flipped)
    toast({ title: `Switched ${keys.size} REMOVE leg${keys.size === 1 ? "" : "s"}`, description: "Re-running analysis with the opposing players selected." })
  }

  // ── Best of Best ────────────────────────────────────────────────────────────
  // Scans every leg and flips it to the player with the higher win probability
  // (the engine's predicted winner from the last analysis), then re-runs the
  // full validation. Saves the user from manually toggling each leg individually.
  const bestOfBest = () => {
    if (!result || resultLegKeys.length === 0) return
    const signals = legSignalsRef.current
    let flippedCount = 0

    const optimized = legs.map(l => {
      const sig = signals[l.key]
      if (!sig) return l
      const ideal = sig.predictedWinnerSide
      if (l.selectedSide === ideal) return l          // already on the better player
      flippedCount++
      return { ...l, selectedSide: ideal }
    })

    setLegs(optimized)
    analyzeParlay(optimized)

    toast({
      title: flippedCount > 0
        ? `Best of Best: flipped ${flippedCount} leg${flippedCount === 1 ? "" : "s"} to the stronger player`
        : "Best of Best: all legs are already on the stronger player",
      description: flippedCount > 0 ? "Re-running analysis with optimised picks." : undefined,
    })
  }

  return (
    <div className="space-y-5 pb-16">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl md:text-3xl font-display font-bold tracking-tight flex items-center gap-2">
            <Layers className="w-6 h-6 text-primary" /> Parlay Builder
          </h1>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">Evaluates legs using engine signals — admin only</p>
        </div>
        {/* OCR health monitor toggle */}
        <button
          onClick={() => setShowHealthPanel(p => !p)}
          title="OCR provider health"
          className={`p-1.5 rounded-lg border transition-colors shrink-0 ${showHealthPanel ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"}`}
        >
          <Server className="w-4 h-4" />
        </button>
        {/* Mode toggle — order: LIVE → HISTORY → BACKTEST → CALIBRATION */}
        <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
          <button onClick={() => { setMode("live"); setResult(null) }}
            className={`px-3 py-1.5 text-xs font-mono transition-colors ${mode === "live" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            LIVE
          </button>
          <button onClick={() => setMode("history")}
            className={`px-3 py-1.5 text-xs font-mono border-l border-border transition-colors ${mode === "history" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            HISTORY
          </button>
          <button onClick={() => setMode("backtest")}
            className={`px-3 py-1.5 text-xs font-mono border-l border-border transition-colors ${mode === "backtest" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            BACKTEST
          </button>
          <button onClick={() => setMode("calibration")}
            className={`px-3 py-1.5 text-xs font-mono border-l border-border transition-colors ${mode === "calibration" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            CALIBRATION
          </button>
        </div>
      </div>

      {/* OCR Provider Health Panel — shown when toggle is on */}
      {showHealthPanel && mode === "live" && (
        <ProviderHealthPanel onClose={() => setShowHealthPanel(false)} />
      )}

      {mode === "calibration" ? <CalibrationDashboard /> : mode === "history" ? <HistoryMode /> : mode === "backtest" ? <BacktestMode /> : (
        <div className="grid lg:grid-cols-2 gap-5 items-start">

          {/* ── Input column ── always first on desktop; on mobile goes below results when results exist */}
          <div className={`space-y-4 ${result ? "order-last lg:order-first" : ""}`}>
            <ScreenshotZone onFiles={handleFiles} disabled={isResolving} />

            {isResolving && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono">
                <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                <span>Reading screenshots…</span>
              </div>
            )}

            {legs.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest">
                    LEGS ({legs.length}) · TAP A PLAYER TO BACK
                  </p>
                  <button
                    onClick={() => { setLegs([]); setResult(null) }}
                    className="text-[10px] font-mono text-muted-foreground hover:text-destructive transition-colors shrink-0"
                  >
                    Clear all
                  </button>
                </div>
                {legs.map((leg, i) => (
                  <LegInputCard key={leg.key} leg={leg} index={i}
                    onSelect={side => updateLeg(leg.key, { selectedSide: side })}
                    onOdds={odds => updateLeg(leg.key, { marketOdds: odds })}
                    onRemove={() => removeLeg(leg.key)}
                  />
                ))}
              </div>
            )}

            {legs.length > 0 && (
              <Button
                className="w-full font-mono gap-2 sticky bottom-20 lg:static shadow-lg lg:shadow-none"
                size="lg"
                onClick={() => analyzeParlay()}
                disabled={!canAnalyze}
              >
                {evaluating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
                {evaluating
                  ? analyzePhase === "predicting"
                    ? `Running predictions…`
                    : "Validating parlay…"
                  : `Analyze Parlay (${legsWithSelection.length} leg${legsWithSelection.length !== 1 ? "s" : ""})`}
              </Button>
            )}

            {legs.length === 0 && (
              <Card className="bg-secondary/20 border-dashed">
                <CardContent className="p-6 text-center space-y-2">
                  <Layers className="w-8 h-8 mx-auto text-muted-foreground/40" />
                  <p className="text-sm font-mono text-muted-foreground">Upload screenshots to build your slip</p>
                  <p className="text-[11px] text-muted-foreground/60 font-mono">Each image can contain one or many matches</p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* ── Results column ── on mobile shows FIRST when results are ready */}
          <div className={`space-y-3 ${result ? "" : "hidden lg:block"}`} ref={resultsRef}>
            {result ? (
              <>
                {/* Builder Summary card */}
                <Card className="bg-card sticky top-2 z-10 shadow-md">
                  <CardContent className="p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest">INDEPENDENT VALIDATION</p>
                      {parlayGradeBadge(result.summary.overallParlayGrade)}
                    </div>

                    {/* Score summary */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="p-2 rounded-lg bg-secondary/40 space-y-0.5">
                        <p className="text-[9px] font-mono text-muted-foreground tracking-wider">AVG VALIDATION</p>
                        <p className="text-lg font-display font-bold">{result.summary.avgValidationScore}<span className="text-[10px] text-muted-foreground font-mono">/100</span></p>
                      </div>
                      <div className="p-2 rounded-lg bg-secondary/40 space-y-0.5">
                        <p className="text-[9px] font-mono text-muted-foreground tracking-wider">AVG RISK</p>
                        <p className="text-lg font-display font-bold">{result.summary.avgRiskScore}<span className="text-[10px] text-muted-foreground font-mono">/100</span></p>
                      </div>
                    </div>

                    {/* Decision counts */}
                    <div className="flex gap-3 text-xs font-mono">
                      <span className="text-success font-bold">{result.summary.keepCount} KEEP</span>
                      <span className="text-warning font-bold">{result.summary.borderlineCount} BORDERLINE</span>
                      <span className="text-destructive font-bold">{result.summary.removeCount} REMOVE</span>
                    </div>

                    {/* Auto Builder */}
                    {result.summary.keepCount > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[9px] font-mono text-muted-foreground tracking-wider">AUTO BUILDER</p>
                        <div className="flex flex-wrap gap-1">
                          {([3, 5, 8, 10] as const).map(n => result.summary.keepCount >= n && (
                            <button key={n}
                              onClick={() => autoPickLegs(n)}
                              className={`text-[9px] font-mono px-2 py-1 rounded border transition-colors ${
                                autoSelected.size === n && [...autoSelected].every(i => result.legs[i]?.decision === "KEEP")
                                  ? "border-primary text-primary bg-primary/10"
                                  : "border-border text-muted-foreground hover:border-primary/40"
                              }`}>
                              Best {n}
                            </button>
                          ))}
                          <button
                            onClick={() => autoPickLegs("all")}
                            className="text-[9px] font-mono px-2 py-1 rounded border border-border text-muted-foreground hover:border-primary/40 transition-colors">
                            All KEEP
                          </button>
                          <button
                            onClick={() => autoPickLegs(5, "riskScore")}
                            className="text-[9px] font-mono px-2 py-1 rounded border border-border text-muted-foreground hover:border-primary/40 transition-colors">
                            Lowest Risk
                          </button>
                          {autoSelected.size > 0 && (
                            <button
                              onClick={() => setAutoSelected(new Set())}
                              className="text-[9px] font-mono px-2 py-1 rounded border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors">
                              Clear ({autoSelected.size})
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm" variant="outline"
                        className="font-mono text-xs gap-1.5 h-8"
                        onClick={() => { setResult(null); setAutoSelected(new Set()) }}
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> Reset
                      </Button>
                      <Button
                        size="sm" variant="outline"
                        className={`font-mono text-xs gap-1.5 h-8 ${showSavedPanel ? "border-primary text-primary bg-primary/10" : ""}`}
                        onClick={() => setShowSavedPanel(p => !p)}
                      >
                        <Bookmark className="w-3.5 h-3.5" /> Saved {savedMap.size > 0 ? `(${savedMap.size})` : ""}
                      </Button>
                    </div>

                    {/* Filter tabs + Switch Borderline action */}
                    <div className="flex gap-1 flex-wrap items-center">
                      {(["all", "KEEP", "BORDERLINE", "REMOVE"] as const).map(v => (
                        <button
                          key={v}
                          onClick={() => setSlipView(v)}
                          className={`text-[9px] font-mono px-2 py-0.5 rounded border transition-colors ${
                            slipView === v
                              ? "border-primary text-primary bg-primary/10"
                              : "border-border text-muted-foreground hover:border-primary/40"
                          }`}
                        >
                          {v}
                        </button>
                      ))}
                      <button
                        onClick={() => { void toggleEngineAgreement() }}
                        disabled={!result || loadingAgreement}
                        title="Show only legs where the engine and parlay builder select the same winner"
                        className={`text-[9px] font-mono px-2 py-0.5 rounded border transition-colors ${agreementOnly ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:border-primary/40"} disabled:opacity-40`}
                      >
                        {loadingAgreement ? "Loading agreement…" : "🤝 Engine Agreement"}
                      </button>
                      {/* Switch Borderline — flips all BORDERLINE legs to the opposing player and re-runs */}
                      {borderlineCount > 0 && (
                        <button
                          onClick={switchBorderlineLegs}
                          disabled={evaluating}
                          title={`Flip all ${borderlineCount} BORDERLINE leg${borderlineCount === 1 ? "" : "s"} to the opposing player and re-run`}
                          className="text-[9px] font-mono px-2 py-0.5 rounded border transition-colors border-warning/50 text-warning bg-warning/10 hover:bg-warning/20 hover:border-warning active:bg-warning/30 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                          <ArrowLeftRight className="w-2.5 h-2.5" />
                          Switch {borderlineCount} Borderline
                        </button>
                      )}
                      {borderlineCount > 0 && (
                        <button
                          onClick={() => removeDecisionLegs("BORDERLINE")}
                          disabled={evaluating}
                          className="text-[9px] font-mono px-2 py-0.5 rounded border border-warning/50 text-warning hover:bg-warning/20 disabled:opacity-40"
                        >
                          Remove Borderline
                        </button>
                      )}
                      {result.summary.removeCount > 0 && (
                        <>
                          <button
                            onClick={() => removeDecisionLegs("REMOVE")}
                            disabled={evaluating}
                            className="text-[9px] font-mono px-2 py-0.5 rounded border border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-40"
                          >
                            Remove Removes
                          </button>
                          <button
                            onClick={switchRemoveLegs}
                            disabled={evaluating}
                            className="text-[9px] font-mono px-2 py-0.5 rounded border border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-40 flex items-center gap-1"
                          >
                            <ArrowLeftRight className="w-2.5 h-2.5" /> Switch Removes
                          </button>
                        </>
                      )}
                      {/* Best of Best — flips every leg to the engine's predicted winner and re-runs */}
                      <button
                        onClick={bestOfBest}
                        disabled={evaluating || !result}
                        title="Flip every leg to the stronger player (engine's predicted winner) and re-run analysis"
                        className="text-[9px] font-mono px-2 py-0.5 rounded border transition-colors border-primary/50 text-primary bg-primary/10 hover:bg-primary/20 hover:border-primary active:bg-primary/30 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                      >
                        <Trophy className="w-2.5 h-2.5" />
                        Best of Best
                      </button>
                    </div>
                  </CardContent>
                </Card>

                {/* Saved Parlays panel — shown when Saved button is active */}
                {showSavedPanel && (
                  <SavedParlaysPanel
                    onClose={() => setShowSavedPanel(false)}
                    onAddSelected={(savedLegs) => {
                      // Merge saved BuilderLegResult snapshots back into the results for inspection
                      // They won't have a full session, so surface as a toast with the count
                      toast({
                        title: `${savedLegs.length} saved leg${savedLegs.length === 1 ? "" : "s"} loaded`,
                        description: "Scroll down to see the leg cards below.",
                      })
                      // Re-run with the saved legs by synthesising a minimal session overlay
                      setResult(prev => {
                        if (!prev) return { legs: savedLegs, summary: {
                          keepCount: savedLegs.filter(l => l.decision === "KEEP").length,
                          borderlineCount: savedLegs.filter(l => l.decision === "BORDERLINE").length,
                          removeCount: savedLegs.filter(l => l.decision === "REMOVE").length,
                          avgValidationScore: Math.round(savedLegs.reduce((s, l) => s + l.validationScore, 0) / savedLegs.length),
                          avgRiskScore: Math.round(savedLegs.reduce((s, l) => s + l.riskScore, 0) / savedLegs.length),
                          overallParlayGrade: "Moderate" as const,
                        }}
                        const merged = [...prev.legs, ...savedLegs]
                        return { ...prev, legs: merged, summary: {
                          ...prev.summary,
                          keepCount: merged.filter(l => l.decision === "KEEP").length,
                          borderlineCount: merged.filter(l => l.decision === "BORDERLINE").length,
                          removeCount: merged.filter(l => l.decision === "REMOVE").length,
                          avgValidationScore: Math.round(merged.reduce((s, l) => s + l.validationScore, 0) / merged.length),
                          avgRiskScore: Math.round(merged.reduce((s, l) => s + l.riskScore, 0) / merged.length),
                        }}
                      })
                      setShowSavedPanel(false)
                    }}
                  />
                )}

                {/* Per-leg results — sorted by validationScore desc (best picks first) */}
                <div className="space-y-2">
                  {filteredResultLegs.map((leg, i) => {
                    const globalIdx = result.legs.indexOf(leg)
                    const saveKey = `${leg.selectedPlayerName}|${leg.opponentName}`
                    return (
                      <ValidationLegCard
                        key={i}
                        leg={leg}
                        isAutoSelected={autoSelected.has(globalIdx)}
                        isSaved={savedMap.has(saveKey)}
                        onToggleSave={() => handleToggleSave(leg)}
                      />
                    )
                  })}
                  {filteredResultLegs.length === 0 && (
                    <p className="text-sm text-muted-foreground font-mono text-center py-4">
                      No legs match this filter
                    </p>
                  )}
                </div>
              </>
            ) : (
              <Card className="bg-secondary/20 border-dashed min-h-40 hidden lg:flex">
                <CardContent className="p-8 text-center space-y-3 flex flex-col items-center justify-center w-full">
                  <BarChart2 className="w-10 h-10 text-muted-foreground/30" />
                  <div>
                    <p className="font-mono text-sm text-muted-foreground">Results will appear here</p>
                    <p className="text-[11px] text-muted-foreground/60 font-mono mt-1">Remove → Caution → Approved</p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
