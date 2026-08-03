import { useState } from "react"
import { Link, useLocation } from "wouter"
import {
  useListBacktests,
  useCreateBacktest,
  useCancelBacktest,
  useDeleteBacktest,
  usePreviewBacktest,
  useListCandidateConfigs,
  useUpdateCandidateConfig,
  useDeleteCandidateConfig,
  getListBacktestsQueryKey,
  useRunRankingVerification,
  useRunHistoricalBackfillCycle,
  useRunHistoricalBackfillRange,
  useGetBackfillLiveProgress,
  type RankingVerificationResult,
  type BacktestRun,
  type BacktestFilters,
  type BacktestDateRange,
} from "@workspace/api-client-react"
import { useGetHistoricalDataFreshness } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  FlaskConical,
  Plus,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertTriangle,
  ChevronRight,
  Trash2,
  X,
  Filter,
  ChevronDown,
  ChevronUp,
  Info,
  BarChart3,
  Settings2,
  Database,
} from "lucide-react"
import { formatDate } from "@/lib/utils"

// ─── Helpers ────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; variant: "success" | "warning" | "destructive" | "secondary" | "outline"; icon: typeof CheckCircle2 }> = {
  queued: { label: "QUEUED", variant: "outline", icon: Clock },
  validating: { label: "VALIDATING", variant: "secondary", icon: Loader2 },
  preparing: { label: "PREPARING", variant: "secondary", icon: Loader2 },
  running: { label: "RUNNING", variant: "secondary", icon: Loader2 },
  training: { label: "TRAINING", variant: "secondary", icon: Loader2 },
  "generating-report": { label: "REPORTING", variant: "secondary", icon: Loader2 },
  completed: { label: "COMPLETED", variant: "success", icon: CheckCircle2 },
  "completed-with-warnings": { label: "WARNINGS", variant: "warning", icon: AlertTriangle },
  failed: { label: "FAILED", variant: "destructive", icon: XCircle },
  cancelled: { label: "CANCELLED", variant: "outline", icon: XCircle },
}

const ACTIVE_STATUSES = new Set(["queued", "validating", "preparing", "running", "training", "generating-report"])

function isActive(s: string) { return ACTIVE_STATUSES.has(s) }

function RunStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status.toUpperCase(), variant: "outline" as const, icon: Info }
  const Icon = meta.icon
  return (
    <Badge variant={meta.variant as "success" | "warning" | "destructive" | "secondary" | "outline"} className="font-mono text-[10px] tracking-widest flex items-center gap-1.5 px-2 py-0.5">
      {isActive(status) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
      {meta.label}
    </Badge>
  )
}

function pct(n: number | null | undefined) {
  return n == null ? "—" : `${n}%`
}

function fmt3(n: number | null | undefined) {
  return n == null ? "—" : n.toFixed(3)
}

// ─── New Backtest Form ───────────────────────────────────────────────────────

function NewBacktestForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState("")
  const [mode, setMode] = useState<"evaluation" | "optimization">("evaluation")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const [surface, setSurface] = useState("")
  const [level, setLevel] = useState("")
  const [includeRetirements, setIncludeRetirements] = useState(false)
  const [includeWalkovers, setIncludeWalkovers] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const preview = usePreviewBacktest()
  const create = useCreateBacktest()

  const filters: BacktestFilters = {
    ...(surface ? { surface } : {}),
    ...(level ? { tournamentLevel: level } : {}),
    includeRetirements,
    includeWalkovers,
  }

  const dateRange: BacktestDateRange = { start, end }

  const canPreview = start && end && start <= end
  const canCreate = canPreview && name.trim().length > 0 && !create.isPending

  function handlePreview() {
    if (!canPreview) return
    preview.mutate({ dateRange, filters })
  }

  function handleCreate() {
    if (!canCreate) return
    create.mutate(
      { name: name.trim(), mode, dateRange, filters },
      { onSuccess: (run) => onCreated(run.id) },
    )
  }

  const dateError = start && end && start > end ? "Start date must be before end date" : null

  return (
    <Card className="glass-panel border-primary/20">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-5">
        <CardTitle className="text-lg font-display flex items-center gap-2">
          <Plus className="w-4 h-4 text-primary" />
          New Backtest Run
        </CardTitle>
      </CardHeader>
      <CardContent className="p-5 space-y-5">

        {/* Name + Mode */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Run Name *</Label>
            <Input
              placeholder="e.g. Clay 2024 Evaluation"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Mode</Label>
            <div className="flex gap-2">
              {(["evaluation", "optimization"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-mono font-bold tracking-widest uppercase transition-colors ${mode === m ? "border-primary bg-primary/10 text-primary" : "border-border/50 text-muted-foreground hover:border-primary/40"}`}
                >
                  {m === "evaluation" ? "Evaluation Only" : "Training & Opt."}
                </button>
              ))}
            </div>
          </div>
        </div>

        {mode === "optimization" && (
          <div className="flex items-start gap-2.5 p-3 bg-warning/5 border border-warning/30 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
            <p className="text-xs font-mono text-muted-foreground leading-relaxed">
              <strong className="text-foreground">TRAINING MODE:</strong> Refits calibration on the training window and evaluates on holdout. Produces a candidate config — never overwrites production. (Currently executed as evaluation-only until the optimizer service is available.)
            </p>
          </div>
        )}

        {/* Date range */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Match Date — From *</Label>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Match Date — To *</Label>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        {dateError && <p className="text-xs text-destructive font-mono">{dateError}</p>}

        {/* Quick filters */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Surface</Label>
            <select
              className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm font-mono"
              value={surface}
              onChange={(e) => setSurface(e.target.value)}
            >
              <option value="">All surfaces</option>
              <option value="Hard">Hard</option>
              <option value="Clay">Clay</option>
              <option value="Grass">Grass</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Tournament Level</Label>
            <select
              className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm font-mono"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              <option value="">All levels</option>
              <option value="Grand Slam">Grand Slam</option>
              <option value="Masters">Masters 1000</option>
              <option value="ATP500">ATP 500</option>
              <option value="ATP250">ATP 250</option>
              <option value="ITF">ITF</option>
            </select>
          </div>
        </div>

        {/* Advanced filters toggle */}
        <button
          className="flex items-center gap-2 text-xs font-mono font-bold text-muted-foreground tracking-widest uppercase hover:text-foreground transition-colors"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <Filter className="w-3.5 h-3.5" />
          Advanced Filters
          {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>

        {showAdvanced && (
          <div className="space-y-3 p-4 bg-secondary/20 rounded-lg border border-border/50">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={includeRetirements}
                onChange={(e) => setIncludeRetirements(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm font-mono">Include retirements in accuracy</span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={includeWalkovers}
                onChange={(e) => setIncludeWalkovers(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm font-mono">Include walkovers</span>
            </label>
          </div>
        )}

        {/* Preview */}
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePreview}
            disabled={!canPreview || preview.isPending}
            className="font-mono text-[11px] tracking-widest"
          >
            {preview.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Database className="w-3.5 h-3.5 mr-1.5" />}
            PREVIEW ROWS
          </Button>
          {preview.data && (
            <div className="flex items-center gap-3 text-xs font-mono text-muted-foreground">
              <span className="text-foreground font-bold">{preview.data.eligible.toLocaleString()} eligible</span>
              <span>/ {preview.data.total.toLocaleString()} total</span>
              {preview.data.excluded > 0 && (
                <span className="text-muted-foreground/70">{preview.data.excluded} excluded</span>
              )}
            </div>
          )}
        </div>

        {preview.data && preview.data.excluded > 0 && Object.keys(preview.data.exclusionReasons).length > 0 && (
          <div className="text-[10px] font-mono text-muted-foreground space-y-1 p-3 bg-secondary/20 rounded-lg border border-border/40">
            <div className="font-bold uppercase tracking-widest mb-1.5 text-foreground/70">Exclusion Reasons</div>
            {Object.entries(preview.data.exclusionReasons).map(([reason, count]) => (
              <div key={reason} className="flex justify-between">
                <span>{reason.replace(/_/g, " ")}</span>
                <span className="text-foreground">{count}</span>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-2.5 pt-2 border-t border-border/40">
          <Button
            className="flex-1 font-mono text-[11px] tracking-widest uppercase"
            onClick={handleCreate}
            disabled={!canCreate}
          >
            {create.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <FlaskConical className="w-4 h-4 mr-2" />}
            Run Backtest
          </Button>
          <Button variant="outline" onClick={onCancel} className="font-mono text-[11px] tracking-widest">
            <X className="w-3.5 h-3.5 mr-1.5" /> Cancel
          </Button>
        </div>

        {create.isError && (
          <p className="text-xs text-destructive font-mono">{create.error?.message}</p>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Run Card ───────────────────────────────────────────────────────────────

function RunCard({ run }: { run: BacktestRun }) {
  const [, navigate] = useLocation()
  const cancel = useCancelBacktest()
  const del = useDeleteBacktest()
  const m = run.metrics

  const active = isActive(run.status)

  return (
    <div className="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
      {/* Header row */}
      <div className="flex items-start gap-3 p-4 border-b border-border/40 bg-secondary/10">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display font-bold text-sm text-foreground truncate">{run.name}</span>
            <RunStatusBadge status={run.status} />
            <Badge variant="outline" className="font-mono text-[9px] tracking-widest uppercase border-muted-foreground/30">
              {run.mode}
            </Badge>
          </div>
          {run.dateRange && (
            <p className="text-[10px] font-mono text-muted-foreground mt-1">
              {run.dateRange.start} → {run.dateRange.end}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {active && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 font-mono text-[10px] tracking-widest text-muted-foreground hover:text-destructive"
              onClick={() => cancel.mutate(run.id)}
              disabled={cancel.isPending}
            >
              CANCEL
            </Button>
          )}
          {!active && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 font-mono text-[10px] tracking-widest"
                onClick={() => navigate(`/backtesting/${run.id}`)}
              >
                VIEW <ChevronRight className="w-3 h-3 ml-0.5" />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-muted-foreground/50 hover:text-destructive"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete backtest run?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will soft-delete <strong>{run.name}</strong>. Prediction rows are preserved for audit and are never deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep it</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive hover:bg-destructive/90"
                      onClick={() => del.mutate(run.id)}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>
      </div>

      {/* Active progress */}
      {active && (
        <div className="p-4 space-y-2">
          <p className="text-xs font-mono text-muted-foreground">{run.currentStage ?? "Starting…"}</p>
          {run.totalRows > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                <span>{run.processedRows} / {run.totalRows} matches</span>
                <span>{Math.round((run.processedRows / run.totalRows) * 100)}%</span>
              </div>
              <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-500 rounded-full"
                  style={{ width: `${Math.min(100, (run.processedRows / run.totalRows) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Completed metrics */}
      {!active && m && (
        <div className="grid grid-cols-3 divide-x divide-border/30 p-0">
          <div className="p-3 text-center">
            <div className="text-[9px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-0.5">ACCURACY</div>
            <div className="text-base font-bold font-mono tabular-nums text-primary">{pct(m.accuracy)}</div>
            <div className="text-[9px] font-mono text-muted-foreground">n={m.n}</div>
          </div>
          <div className="p-3 text-center">
            <div className="text-[9px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-0.5">LOG LOSS</div>
            <div className="text-base font-bold font-mono tabular-nums">{fmt3(m.logLoss)}</div>
          </div>
          <div className="p-3 text-center">
            <div className="text-[9px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-0.5">BRIER</div>
            <div className="text-base font-bold font-mono tabular-nums">{fmt3(m.brier)}</div>
          </div>
        </div>
      )}

      {/* Failed message */}
      {run.status === "failed" && run.errors && run.errors.length > 0 && (
        <div className="p-3 bg-destructive/5 border-t border-destructive/20">
          <p className="text-xs font-mono text-destructive">{run.errors[0].message}</p>
        </div>
      )}

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border/30 bg-secondary/5">
        <p className="text-[10px] font-mono text-muted-foreground">
          Created {formatDate(run.createdAt)}
          {run.completedAt && <span> · Completed {formatDate(run.completedAt)}</span>}
          {run.rowCounts && <span> · {run.rowCounts.eligible} eligible matches</span>}
        </p>
      </div>
    </div>
  )
}

// ─── Candidate Configs Section ───────────────────────────────────────────────

function CandidateConfigsSection() {
  const { data: configs, isLoading } = useListCandidateConfigs()
  const update = useUpdateCandidateConfig()
  const del = useDeleteCandidateConfig()

  if (isLoading) return <Skeleton className="h-24 rounded-xl" />

  if (!configs || configs.length === 0) {
    return (
      <div className="py-10 text-center border border-dashed rounded-xl text-muted-foreground font-mono text-xs tracking-widest uppercase">
        No candidate configs yet — run a backtest in Training mode to generate one
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {configs.map((c) => (
        <div key={c.id} className="rounded-xl border border-border/50 bg-background p-4 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold text-sm">{c.name}</span>
            <Badge
              variant={c.status === "promoted" ? "success" : c.status === "rejected" ? "destructive" : "outline"}
              className="font-mono text-[9px] tracking-widest"
            >
              {c.status.toUpperCase()}
            </Badge>
          </div>
          {c.notes && <p className="text-xs text-muted-foreground">{c.notes}</p>}
          <div className="flex gap-2 pt-1">
            {c.status !== "promoted" && c.status !== "rejected" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 font-mono text-[10px] tracking-widest text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={() => update.mutate({ id: c.id, data: { status: "rejected" } })}
              >
                Reject
              </Button>
            )}
            {c.status !== "promoted" && c.status !== "rejected" && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-muted-foreground/50 hover:text-destructive"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete candidate config?</AlertDialogTitle>
                    <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive hover:bg-destructive/90"
                      onClick={() => del.mutate(c.id)}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <p className="ml-auto text-[10px] font-mono text-muted-foreground self-center">
              Created {formatDate(c.createdAt)}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Data Health Panel ───────────────────────────────────────────────────────

function DataHealthPanel() {
  const { data: freshness, isLoading: freshnessLoading, refetch: refetchFreshness } = useGetHistoricalDataFreshness()
  const rankVerify = useRunRankingVerification()
  const backfillCycle = useRunHistoricalBackfillCycle()
  const backfillRange = useRunHistoricalBackfillRange()
  const [verifyResult, setVerifyResult] = useState<RankingVerificationResult | null>(null)
  const [showDiscrepancies, setShowDiscrepancies] = useState(false)
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null)
  const [fillingGap, setFillingGap] = useState<string | null>(null)
  // Task #64: live status polling — set to the ISO trigger timestamp after a range backfill fires.
  const [backfillTriggeredAt, setBackfillTriggeredAt] = useState<string | null>(null)
  const liveProgress = useGetBackfillLiveProgress({ triggeredAt: backfillTriggeredAt })

  // HistoricalDataFreshness only carries latestCoveredDate / daysBehind / asOf.
  // The extended gap/missing-rank fields were removed from the schema but may
  // still be present in the runtime response, so we cast to access them safely.
  type FreshnessExt = typeof freshness & {
    matchesMissingOpponentRank?: number
    matchesMissingSurface?: number
    dateGapsOver30Days?: Array<{ fromDate: string; toDate: string; dayCount: number }>
  }
  const freshnessExt = freshness as FreshnessExt
  const missingRank = freshnessExt?.matchesMissingOpponentRank
  const missingSurface = freshnessExt?.matchesMissingSurface
  const gaps = freshnessExt?.dateGapsOver30Days ?? []

  function handleVerify() {
    rankVerify.mutate(undefined, {
      onSuccess: (result) => {
        setVerifyResult(result)
        setShowDiscrepancies(false)
      },
    })
  }

  function handleBackfillCycle() {
    setBackfillMessage(null)
    backfillCycle.mutate(undefined, {
      onSuccess: (result) => {
        if (result.skipped) {
          setBackfillMessage(`Already up to date — ${result.skippedReason ?? "nothing new to fetch."}`)
        } else {
          const inserted = result.summary?.matchesInserted ?? 0
          setBackfillMessage(`Cycle complete — ${inserted.toLocaleString()} match${inserted !== 1 ? "es" : ""} inserted.`)
          refetchFreshness()
        }
      },
      onError: () => setBackfillMessage("Backfill cycle failed — check logs."),
    })
  }

  function handleFillGap(dateStart: string, dateStop: string) {
    const key = `${dateStart}|${dateStop}`
    setFillingGap(key)
    setBackfillMessage(null)
    backfillRange.mutate({ data: { dateStart, dateStop } }, {
      onSuccess: () => {
        // Task #64: record trigger time so live-progress polling can detect completion.
        setBackfillTriggeredAt(new Date().toISOString())
        setBackfillMessage(null)
        setFillingGap(null)
      },
      onError: () => {
        setBackfillMessage("Failed to start range backfill — check logs.")
        setFillingGap(null)
      },
    })
  }

  return (
    <Card className="glass-panel border-border/40">
      <CardHeader className="border-b border-border/50 bg-secondary/10 px-5 py-3.5">
        <CardTitle className="text-xs font-mono font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-2">
          <Database className="w-3.5 h-3.5" />
          Data Health
        </CardTitle>
      </CardHeader>
      <CardContent className="p-5 space-y-4">
        {/* Coverage stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            {
              label: "Latest Date",
              value: freshnessLoading ? "…" : (freshness?.latestCoveredDate ?? "—"),
              warn: false,
            },
            {
              label: "Days Behind",
              value: freshnessLoading ? "…" : (freshness?.daysBehind != null ? `${freshness.daysBehind}d` : "—"),
              warn: (freshness?.daysBehind ?? 0) > 7,
            },
            {
              label: "Missing Rank",
              value: freshnessLoading ? "…" : (missingRank != null ? missingRank.toLocaleString() : "—"),
              warn: (missingRank ?? 0) > 100,
            },
            {
              label: "Missing Surface",
              value: freshnessLoading ? "…" : (missingSurface != null ? missingSurface.toLocaleString() : "—"),
              warn: (missingSurface ?? 0) > 50,
            },
          ].map(({ label, value, warn }) => (
            <div key={label} className="space-y-1">
              <div className="text-[9px] font-mono font-bold text-primary/75 tracking-widest uppercase">{label}</div>
              <div className={`text-sm font-mono font-bold ${warn ? "text-warning" : "text-foreground"}`}>{value}</div>
            </div>
          ))}
        </div>

        {/* Date gaps */}
        {gaps.length > 0 && (
          <div className="p-3 rounded-lg border border-warning/40 bg-warning/10 space-y-2">
            <div className="text-[9px] font-mono font-bold text-warning tracking-widest uppercase flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" />
              {gaps.length} Coverage Gap{gaps.length > 1 ? "s" : ""} &gt; 30 Days
            </div>
            <div className="space-y-1.5">
              {gaps.slice(0, 5).map((g, i) => {
                const gapKey = `${g.fromDate}|${g.toDate}`
                const isFilling = fillingGap === gapKey
                return (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {g.fromDate} → {g.toDate} <span className="text-warning">({g.dayCount}d)</span>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 font-mono text-[9px] tracking-widest border-warning/50 text-warning hover:bg-warning/10 shrink-0"
                      disabled={isFilling || backfillRange.isPending}
                      onClick={() => handleFillGap(g.fromDate, g.toDate)}
                    >
                      {isFilling ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5" />}
                      <span className="ml-1">FILL GAP</span>
                    </Button>
                  </div>
                )
              })}
              {gaps.length > 5 && (
                <div className="text-[10px] font-mono text-muted-foreground">…and {gaps.length - 5} more</div>
              )}
            </div>
          </div>
        )}

        {gaps.length === 0 && !freshnessLoading && freshness && (
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-primary">
            <CheckCircle2 className="w-3 h-3" />
            No gaps &gt; 30 days detected
          </div>
        )}

        {/* Task #64: live status when a range backfill is running */}
        {backfillTriggeredAt && liveProgress.data?.isRunning && (
          <div className="flex items-start gap-2 p-2 bg-primary/10 border border-primary/35 rounded text-[10px] font-mono text-primary">
            <Loader2 className="w-3 h-3 mt-0.5 animate-spin shrink-0" />
            <div className="space-y-0.5">
              <div className="font-bold tracking-widest uppercase">BACKFILL RUNNING</div>
              {liveProgress.data.activeDateRange && (
                <div className="text-muted-foreground">
                  Range: {liveProgress.data.activeDateRange.dateStart} → {liveProgress.data.activeDateRange.dateStop}
                </div>
              )}
              {liveProgress.data.activeStartedAt && (
                <div className="text-muted-foreground">
                  Started: {new Date(liveProgress.data.activeStartedAt).toLocaleTimeString()} — polling every 5 s
                </div>
              )}
            </div>
          </div>
        )}
        {backfillTriggeredAt && !liveProgress.data?.isRunning && liveProgress.data !== undefined && (
          <div className="flex items-center gap-2 p-2 bg-primary/10 border border-primary/35 rounded text-[10px] font-mono text-primary">
            <CheckCircle2 className="w-3 h-3 shrink-0" />
            <span>
              Backfill complete (status: {liveProgress.data.lastCompletedStatus ?? "—"}
              {liveProgress.data.lastCompletedAt
                ? ` at ${new Date(liveProgress.data.lastCompletedAt).toLocaleTimeString()}`
                : ""}
              ). Refresh freshness to see the updated coverage.
            </span>
          </div>
        )}

        {/* Backfill status message */}
        {backfillMessage && (
          <div className="text-[10px] font-mono text-muted-foreground p-2 bg-secondary/20 rounded border border-border/40">
            {backfillMessage}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-border/30">
          <Button
            size="sm"
            variant="outline"
            className="font-mono text-[10px] tracking-widest h-7 px-3"
            onClick={handleBackfillCycle}
            disabled={backfillCycle.isPending}
          >
            {backfillCycle.isPending ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1.5" />}
            RUN BACKFILL CYCLE
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="font-mono text-[10px] tracking-widest h-7 px-3"
            onClick={handleVerify}
            disabled={rankVerify.isPending}
          >
            {rankVerify.isPending ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1.5" />}
            VERIFY RANKINGS
          </Button>
          {verifyResult && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {verifyResult.discrepancies.length === 0
                ? <span className="text-primary">✓ All rankings match (checked {verifyResult.totalProviderRankings} players)</span>
                : (
                  <button
                    className="text-warning underline underline-offset-2 cursor-pointer"
                    onClick={() => setShowDiscrepancies((p) => !p)}
                  >
                    {verifyResult.discrepancies.length} discrepan{verifyResult.discrepancies.length === 1 ? "cy" : "cies"} &gt;10 places
                  </button>
                )
              }
            </span>
          )}
          {rankVerify.isError && (
            <span className="text-[10px] font-mono text-destructive">Verification failed</span>
          )}
        </div>

        {/* Discrepancy detail */}
        {showDiscrepancies && verifyResult && verifyResult.discrepancies.length > 0 && (
          <div className="space-y-1">
            {verifyResult.discrepancies.slice(0, 10).map((d) => (
              <div key={d.playerId} className="flex items-center justify-between text-[10px] font-mono py-0.5 border-b border-border/20">
                <span className="text-foreground truncate max-w-[60%]">{d.playerName}</span>
                <span className="text-muted-foreground shrink-0">
                  stored <span className={d.storedRank == null ? "text-destructive" : ""}>{d.storedRank ?? "—"}</span>
                  {" → "}
                  live <span className="text-foreground">{d.providerRank}</span>
                  {" "}
                  <span className="text-warning">({d.gapPlaces > 0 ? "+" : ""}{(d.providerRank - (d.storedRank ?? 0))})</span>
                </span>
              </div>
            ))}
            {verifyResult.discrepancies.length > 10 && (
              <div className="text-[10px] font-mono text-muted-foreground">…and {verifyResult.discrepancies.length - 10} more</div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

type Tab = "runs" | "candidates"

export default function BacktestingPortalPage() {
  const [showForm, setShowForm] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>("runs")
  const [, navigate] = useLocation()
  const queryClient = useQueryClient()

  const { data: runs, isLoading, isError } = useListBacktests()

  const activeRuns = runs?.filter((r) => isActive(r.status)) ?? []
  const completedRuns = runs?.filter((r) => !isActive(r.status)) ?? []

  function handleRefresh() {
    queryClient.invalidateQueries({ queryKey: getListBacktestsQueryKey() })
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-4xl">

      {/* Page header */}
      <div className="flex items-start justify-between gap-4 border-b border-border/50 pb-6">
        <div>
          <h1 className="text-3xl sm:text-4xl font-display font-bold tracking-tight flex items-center gap-3 flex-wrap">
            <FlaskConical className="w-8 h-8 text-primary" />
            Backtesting Portal
          </h1>
          <p className="text-muted-foreground mt-2 text-base leading-relaxed max-w-2xl">
            Score historical matches against the current frozen model, review accuracy by segment, and compare run configurations.
            Runs execute in the background — leave the page and come back.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          className="font-mono text-[10px] tracking-widest shrink-0 mt-1"
        >
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
          REFRESH
        </Button>
      </div>

      {/* Safety banner */}
      <div className="flex items-start gap-3 p-4 border border-primary/20 bg-card rounded-xl border-l-[3px]">
        <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
        <div className="text-xs font-mono text-muted-foreground leading-relaxed space-y-1">
          <p><strong className="text-foreground">Evaluation-only runs</strong> — no production changes, ever. The frozen model and current calibration are applied; nothing is refit.</p>
          <p><strong className="text-foreground">Original prediction records</strong> (evaluation_predictions, paper trades) are never touched by any backtest operation, including delete.</p>
        </div>
      </div>

      {/* Data health */}
      <DataHealthPanel />

      {/* Active runs */}
      {activeRuns.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-mono font-bold text-muted-foreground tracking-widest uppercase">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            Active Runs ({activeRuns.length})
          </div>
          {activeRuns.map((r) => <RunCard key={r.id} run={r} />)}
        </section>
      )}

      {/* New backtest form / trigger */}
      {showForm ? (
        <NewBacktestForm
          onCancel={() => setShowForm(false)}
          onCreated={(id) => {
            setShowForm(false)
            queryClient.invalidateQueries({ queryKey: getListBacktestsQueryKey() })
          }}
        />
      ) : (
        <Button
          className="w-full font-mono text-sm tracking-widest uppercase h-12"
          onClick={() => setShowForm(true)}
        >
          <Plus className="w-4 h-4 mr-2" />
          Run New Backtest
        </Button>
      )}

      {/* Tabs */}
      <div>
        <div className="flex border-b border-border/50">
          {(["runs", "candidates"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-xs font-mono font-bold tracking-widest uppercase transition-colors border-b-2 -mb-px rounded-t-md ${
                activeTab === tab ? "border-primary bg-primary text-primary-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "runs" ? `Completed Runs (${completedRuns.length})` : "Candidate Configs"}
            </button>
          ))}
        </div>

        <div className="pt-5">
          {activeTab === "runs" && (
            <>
              {isLoading && (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
                </div>
              )}
              {isError && (
                <div className="py-10 text-center border border-dashed rounded-xl text-muted-foreground font-mono text-sm">
                  Failed to load backtest runs.
                </div>
              )}
              {!isLoading && !isError && completedRuns.length === 0 && (
                <div className="py-16 text-center border border-dashed rounded-xl text-muted-foreground font-mono text-xs tracking-widest uppercase">
                  No completed runs yet — run your first backtest above
                </div>
              )}
              {!isLoading && completedRuns.length > 0 && (
                <div className="space-y-3">
                  {completedRuns.map((r) => <RunCard key={r.id} run={r} />)}
                </div>
              )}
            </>
          )}

          {activeTab === "candidates" && <CandidateConfigsSection />}
        </div>
      </div>
    </div>
  )
}
