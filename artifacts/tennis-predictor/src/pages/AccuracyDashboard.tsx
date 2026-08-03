import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import {
  useGetEvaluationDashboard,
  useListEvaluationRuns,
  useGetLatestPatternAnalysis,
  useGetLatestThresholdEvaluation,
  useRunPaperTradingCycle,
  useGetEvaluationSettings,
  useUpdateEvaluationSettings,
  useRunShadowReplay,
  useGetShadowReplayDashboard,
  useGetOptimizerAccuracySummary,
  useGetCandidateConfigs,
  getGetLatestPatternAnalysisQueryKey,
  getGetLatestThresholdEvaluationQueryKey,
  getGetOptimizerAccuracySummaryQueryKey,
  getCandidateConfigsQueryKey,
  type EvaluationDashboardSegment,
  type SpecialistSegmentSummary,
  type EliteTierBacktest,
  type SegmentMetrics,
  type MarketEdgeSummary,
  type UpsetRiskTierMetrics,
  type DisagreementTierMetrics,
  type ShadowReplayDashboard,
  type LatestPatternAnalysis,
  type PatternSegmentItem,
  type LatestThresholdEvaluation,
  type ThresholdEvalEntryItem,
  type OptimizerStrategyPick,
  type CandidateConfigRecord,
  type OptimizerAccuracySummaryResponse,
} from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { UPSET_RISK_DOT_CLASS, UPSET_RISK_SHORT } from "@/lib/upsetRiskColors"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/hooks/use-toast"
import { formatDate } from "@/lib/utils"
import { useQueryClient } from "@tanstack/react-query"
import { getGetEvaluationDashboardQueryKey, getListEvaluationRunsQueryKey, getGetEvaluationSettingsQueryKey, getGetShadowReplayDashboardQueryKey } from "@workspace/api-client-react"
import { Loader2, PlayCircle, Radio, Flame, Snowflake, Layers, Crown, LineChart, ShieldAlert, Swords, FlaskConical, ChevronDown, ChevronUp, Beaker, TrendingUp, AlertTriangle } from "lucide-react"

// ── Stage A2: Async job polling for walk-forward and optimizer ────────────────────────────────────

type AsyncJobState<T> =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; startedAt: string; detail?: string; matchesScored?: number }
  | { phase: "done"; result: T }
  | { phase: "error"; message: string }

function getBaseUrl(): string {
  return import.meta.env.BASE_URL?.replace(/\/$/, "") ?? ""
}

/**
 * Generic hook for fire-and-poll jobs.
 * POST the start endpoint, then poll the status endpoint every 5 s until done.
 * Calls `onDone` when the job finishes successfully so callers can invalidate queries.
 */
function useAsyncJob<T>(opts: {
  startPath: string
  statusPath: string
  onDone?: (result: T) => void
}) {
  const [state, setState] = useState<AsyncJobState<T>>({ phase: "idle" })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`${getBaseUrl()}${opts.statusPath}`)
      if (!res.ok) return
      const data = await res.json() as { state: string; result?: T; error?: string; startedAt?: string; phase?: string; matchesScored?: number }
      if (data.state === "done") {
        stopPolling()
        setState({ phase: "done", result: data.result as T })
        opts.onDone?.(data.result as T)
      } else if (data.state === "error") {
        stopPolling()
        setState({ phase: "error", message: data.error ?? "Unknown error" })
      } else if (data.state === "running") {
        setState({ phase: "running", startedAt: data.startedAt ?? "", detail: data.phase ?? undefined, matchesScored: data.matchesScored ?? undefined })
      }
    } catch {
      // Network error — keep polling, don't surface until repeated
    }
  }, [opts, stopPolling])

  const start = useCallback(async (body: Record<string, unknown> = {}) => {
    if (state.phase === "starting" || state.phase === "running") return
    setState({ phase: "starting" })
    try {
      const res = await fetch(`${getBaseUrl()}${opts.startPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json() as { started: boolean; reason?: string }
      if (!res.ok || !data.started) {
        setState({ phase: "error", message: data.reason ?? `HTTP ${res.status}` })
        return
      }
      setState({ phase: "running", startedAt: new Date().toISOString() })
      // Start polling immediately, then every 5 s
      void poll()
      pollRef.current = setInterval(() => { void poll() }, 5000)
    } catch (err) {
      setState({ phase: "error", message: err instanceof Error ? err.message : "Network error" })
    }
  }, [state.phase, opts.startPath, poll])

  // On mount, check if a job is already running (e.g. after page refresh)
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${getBaseUrl()}${opts.statusPath}`)
        if (!res.ok) return
        const data = await res.json() as { state: string; startedAt?: string; phase?: string; matchesScored?: number }
        if (data.state === "running") {
          setState({ phase: "running", startedAt: data.startedAt ?? "", detail: data.phase ?? undefined, matchesScored: data.matchesScored ?? undefined })
          void poll()
          pollRef.current = setInterval(() => { void poll() }, 5000)
        }
      } catch { /* ignore */ }
    })()
    return stopPolling
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const reset = useCallback(() => {
    stopPolling()
    setState({ phase: "idle" })
  }, [stopPolling])

  return { state, start, reset }
}

/** Below this many graded rows, a tier's own numbers are too noisy to trust at face value --
 * mirrors the n<30 minimum-sample convention this dashboard already uses for the Elite tier
 * backtest (`EliteTierGroupStats`'s `minSampleSize`). */
const LOW_CONFIDENCE_TIER_SAMPLE = 30

function MetricStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5 p-4 bg-background rounded-xl border border-border/50 shadow-sm text-center matrix-stat-card">
      <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">{label}</div>
      <div className="text-3xl font-display font-bold tracking-tight matrix-number tabular-nums">{value}</div>
    </div>
  )
}

function toRunStatus(phase: "idle" | "starting" | "running" | "done" | "error", hasWarnings = false): string {
  if (phase === "idle") return "Idle"
  if (phase === "starting") return "Queued"
  if (phase === "running") return "Running"
  if (phase === "done") return hasWarnings ? "Completed with warnings" : "Completed"
  return "Failed"
}

function CompactRunnerErrorCard({ feature, message }: { feature: string; message: string }) {
  const [showTechnical, setShowTechnical] = useState(false)
  const refId = useMemo(() => `ERR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, [])
  const simpleMessage = message.toLowerCase().includes("column") || message.toLowerCase().includes("relation")
    ? "Evaluation database schema appears out of sync. No production settings were changed."
    : "Runner failed before completion. No production settings were changed."

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-destructive mt-0.5" />
        <div>
          <div className="font-mono font-bold text-destructive">{feature} failed</div>
          <div className="text-muted-foreground">{simpleMessage}</div>
          <div className="text-muted-foreground/80 font-mono mt-1">Ref: {refId} • {new Date().toLocaleTimeString()}</div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="h-7 text-[10px] font-mono" onClick={() => window.location.reload()}>Retry</Button>
        <Button size="sm" variant="ghost" className="h-7 text-[10px] font-mono" onClick={() => setShowTechnical((v) => !v)}>
          {showTechnical ? "Hide Technical Details" : "View Technical Details"}
        </Button>
      </div>
      {showTechnical && (
        <pre className="max-h-40 overflow-auto rounded bg-background p-2 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap">{message}</pre>
      )}
    </div>
  )
}

function eceRead(ece: number | null | undefined): { label: string; variant: "success" | "warning" | "destructive" | "outline" } {
  if (ece === null || ece === undefined) return { label: "NO DATA", variant: "outline" }
  if (ece < 0.03) return { label: "WELL-CALIBRATED", variant: "success" }
  if (ece <= 0.05) return { label: "BORDERLINE", variant: "warning" }
  return { label: "MISCALIBRATED", variant: "destructive" }
}

function ECEStat({ label, ece }: { label: string; ece: number | null | undefined }) {
  const read = eceRead(ece)
  return (
    <div className="space-y-1.5 p-4 bg-background rounded-xl border border-border/50 shadow-sm flex flex-col items-center justify-center">
      <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">{label}</div>
      <div className="flex items-center gap-3 mt-1">
        <div className="text-3xl font-display font-bold tracking-tight text-foreground tabular-nums">{ece !== null && ece !== undefined ? ece.toFixed(3) : "—"}</div>
        <Badge variant={read.variant} className="font-mono text-[10px] tracking-widest shadow-sm">{read.label}</Badge>
      </div>
    </div>
  )
}

function SegmentCard({ segment }: { segment: EvaluationDashboardSegment }) {
  const m = segment.metrics
  const dateRange =
    m.dateRangeStart && m.dateRangeEnd
      ? `${formatDate(m.dateRangeStart)} – ${formatDate(m.dateRangeEnd)}`
      : "No data yet"

  return (
    <Card className="glass-panel">
      <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-border/50 bg-secondary/20">
        <div>
          <CardTitle className="text-xl font-display">{segment.label}</CardTitle>
          <p className="text-sm font-mono text-muted-foreground mt-1 tracking-wider">{dateRange}</p>
        </div>
        <Badge variant={segment.isGenuinelyUnseen ? "success" : "secondary"} className="font-mono text-[10px] tracking-widest px-3 py-1 shadow-sm">
          {segment.isGenuinelyUnseen ? "GENUINELY UNSEEN" : "USED FOR CALIBRATION"}
        </Badge>
      </CardHeader>
      <CardContent className="p-6 md:p-8 space-y-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <MetricStat label={`ACCURACY (n=${m.n})`} value={m.accuracy !== null ? `${m.accuracy}%` : "—"} />
          <MetricStat label="LOG LOSS" value={m.logLoss !== null ? m.logLoss.toFixed(3) : "—"} />
          <MetricStat label="BRIER SCORE" value={m.brier !== null ? m.brier.toFixed(3) : "—"} />
          <MetricStat
            label={`RETIREMENTS (n=${m.retiredCount})`}
            value={m.retiredAccuracy !== null ? `${m.retiredAccuracy}%` : "excluded"}
          />
        </div>

        <div className="flex flex-wrap gap-4 text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">
          <span className="bg-secondary/30 px-3 py-1.5 rounded-md border border-border/50">VOID (walkover/cancelled): <span className="text-foreground">{m.voidCount}</span></span>
          <span className="bg-secondary/30 px-3 py-1.5 rounded-md border border-border/50">MISSED CUTOFF: <span className="text-foreground">{m.missedCount}</span></span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <ECEStat label="ECE (RAW)" ece={m.eceRaw} />
          <ECEStat label="ECE (CALIBRATED)" ece={m.eceCalibrated} />
        </div>

        <div className="space-y-3 bg-secondary/20 p-5 rounded-2xl border border-border/50">
          <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">CALIBRATION BUCKETS (confidence vs. observed accuracy)</div>
          <div className="grid grid-cols-3 md:grid-cols-7 gap-3">
            {segment.calibrationBuckets.map((b) => (
              <div key={b.label} className="border border-border/50 bg-background rounded-xl p-3 text-center shadow-sm">
                <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest">{b.label}</div>
                <div className="text-lg font-display font-bold mt-1 text-primary tabular-nums">{b.observedAccuracy !== null ? `${b.observedAccuracy}%` : "—"}</div>
                <div className="text-[10px] text-muted-foreground/80 font-mono mt-0.5">n={b.n}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-6 text-sm bg-background p-4 rounded-xl border border-border/50 shadow-sm">
          <div className="flex items-center gap-2.5">
            {segment.streaks.currentStreakType === "win" ? (
              <Flame className="w-5 h-5 text-success" />
            ) : segment.streaks.currentStreakType === "loss" ? (
              <Snowflake className="w-5 h-5 text-destructive" />
            ) : <span className="w-5 h-5"></span>}
            <span className="font-mono font-bold text-foreground uppercase tracking-widest text-[11px]">
              CURRENT: <span className={segment.streaks.currentStreakType === "win" ? "text-success" : segment.streaks.currentStreakType === "loss" ? "text-destructive" : ""}>{segment.streaks.currentStreakType ? `${segment.streaks.currentStreakLength} ${segment.streaks.currentStreakType}${segment.streaks.currentStreakLength === 1 ? "" : "s"}` : "—"}</span>
            </span>
          </div>
          <span className="w-px h-4 bg-border/50 hidden sm:block"></span>
          <span className="font-mono font-bold text-muted-foreground uppercase tracking-widest text-[11px]">LONGEST WIN: <span className="text-foreground">{segment.streaks.longestWinStreak}</span></span>
          <span className="w-px h-4 bg-border/50 hidden sm:block"></span>
          <span className="font-mono font-bold text-muted-foreground uppercase tracking-widest text-[11px]">LONGEST LOSS: <span className="text-foreground">{segment.streaks.longestLossStreak}</span></span>
        </div>
      </CardContent>
    </Card>
  )
}

function SpecialistSegmentTable({ segments }: { segments: SpecialistSegmentSummary[] }) {
  const activeCount = segments.filter((s) => s.meetsThreshold).length
  const mostRecentRefit = segments.reduce<string | null>((latest, s) => {
    if (!s.computedAt) return latest
    if (!latest || new Date(s.computedAt).getTime() > new Date(latest).getTime()) return s.computedAt
    return latest
  }, null)

  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-6 md:p-8">
        <CardTitle className="text-xl font-display flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Layers className="w-5 h-5 text-primary" />
          </div>
          Self-Learning Report: Specialist Segments (Phase 6)
        </CardTitle>
        <p className="text-sm text-muted-foreground/80 leading-relaxed mt-4 max-w-4xl">
          This is the engine's real self-learning signal: each tour/surface segment's trust (blend weight) is re-derived
          from its own measured log loss and accuracy vs. the general model on the SAME validation points, every
          calibration refit -- not a fixed rule. Sample sizes are always shown alongside accuracy so a small sample is
          never presented as a strong result.
        </p>
        <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase mt-4">
          <span className="text-foreground">{activeCount}</span> of {segments.length} segments actively trusted this cycle
          {mostRecentRefit && <span className="ml-2 text-border">•</span>} {mostRecentRefit && <span className="ml-2">last recomputed {formatDate(mostRecentRefit)}</span>}
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/10">
              <tr className="text-left text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase border-b border-border/50">
                <th className="py-4 px-6 font-bold whitespace-nowrap">Segment</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap">Status</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Matches</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Val N</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Spec Acc.</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Gen Acc.</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Spec Loss</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Gen Loss</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Weight</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {segments.map((s) => (
                <tr key={s.segmentKey} className="hover:bg-secondary/30 transition-colors">
                  <td className="py-3 px-6 font-mono font-bold text-foreground whitespace-nowrap">{s.label}</td>
                  <td className="py-3 px-6 whitespace-nowrap">
                    <Badge variant={s.meetsThreshold ? "success" : "outline"} className="font-mono text-[10px] tracking-widest shadow-sm">
                      {s.meetsThreshold ? "ACTIVE" : "INSUFFICIENT"}
                    </Badge>
                  </td>
                  <td className="py-3 px-6 font-mono tabular-nums text-right">{s.historicalMatchCount}</td>
                  <td className="py-3 px-6 font-mono tabular-nums text-right">{s.validationSampleSize}</td>
                  <td className="py-3 px-6 font-mono font-bold tabular-nums text-right text-primary">{s.accuracy !== null && s.accuracy !== undefined ? `${s.accuracy}%` : "—"}</td>
                  <td className="py-3 px-6 font-mono tabular-nums text-right text-muted-foreground">{s.generalAccuracy !== null && s.generalAccuracy !== undefined ? `${s.generalAccuracy}%` : "—"}</td>
                  <td className="py-3 px-6 font-mono tabular-nums text-right text-primary">{s.logLoss !== null && s.logLoss !== undefined ? s.logLoss.toFixed(3) : "—"}</td>
                  <td className="py-3 px-6 font-mono tabular-nums text-right text-muted-foreground">{s.generalLogLoss !== null && s.generalLogLoss !== undefined ? s.generalLogLoss.toFixed(3) : "—"}</td>
                  <td className="py-3 px-6 font-mono font-bold tabular-nums text-right whitespace-nowrap">
                    {s.meetsThreshold ? (
                      <span className="text-success">{s.weight.toFixed(2)}</span>
                    ) : (
                      <span className="text-muted-foreground/60">0.00 <span className="text-[9px] font-normal uppercase ml-1 block mt-0.5">(fallback)</span></span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function EliteTierGroupStats({ label, description, metrics, minSampleSize, meetsMinSample }: { label: string; description: string; metrics: SegmentMetrics; minSampleSize: number; meetsMinSample: boolean }) {
  return (
    <div className="space-y-6 border border-border/50 bg-background rounded-xl p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="text-lg font-display font-bold text-foreground">{label}</div>
          <p className="text-sm text-muted-foreground/80 mt-1 max-w-2xl leading-relaxed">{description}</p>
        </div>
        <Badge variant={meetsMinSample ? "success" : "outline"} className="font-mono text-[10px] tracking-widest uppercase shadow-sm self-start sm:self-auto shrink-0">
          {meetsMinSample ? "SAMPLE SUFFICIENT" : `n < ${minSampleSize}`}
        </Badge>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <MetricStat label={`ACCURACY (n=${metrics.n})`} value={metrics.accuracy !== null ? `${metrics.accuracy}%` : "—"} />
        <MetricStat label="LOG LOSS" value={metrics.logLoss !== null ? metrics.logLoss.toFixed(3) : "—"} />
        <MetricStat label="BRIER SCORE" value={metrics.brier !== null ? metrics.brier.toFixed(3) : "—"} />
        <ECEStat label="ECE (CALIBRATED)" ece={metrics.eceCalibrated} />
      </div>
      {!meetsMinSample && (
        <p className="text-xs text-muted-foreground font-mono bg-secondary/30 p-3 rounded-lg border border-border/50 text-center">
          Fewer than {minSampleSize} graded matches so far -- these numbers will keep firming up as more real outcomes are graded.
        </p>
      )}
    </div>
  )
}

function EliteTierBacktestCard({ backtest }: { backtest: EliteTierBacktest }) {
  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-6 md:p-8">
        <CardTitle className="text-xl font-display flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Crown className="w-5 h-5 text-primary" />
          </div>
          Elite Tier Backtest
        </CardTitle>
        <p className="text-sm text-muted-foreground/80 leading-relaxed mt-4 max-w-4xl">
          The "Elite Prediction" tier requires high data quality, Surface Elo/Serve &amp; Return/Recent Form all agreeing,
          a validated segment specialist backing the call, and a calibrated pick that agrees with the raw evidence (no
          model conflict, no High Disagreement, no High/Extreme upset risk). Scored against genuinely-unseen graded
          outcomes only (historical test-segment + paper trading), with the same accuracy/logLoss/Brier/ECE methodology
          used everywhere else on this dashboard. Elite is the engine's most selective bar, not a proven track record --
          the accuracy gap below is directionally positive but not yet statistically significant at current sample
          sizes, so read the numbers rather than assuming superiority from the label alone.
        </p>
      </CardHeader>
      <CardContent className="p-6 md:p-8 space-y-6 bg-secondary/10">
        <EliteTierGroupStats
          label="Real Elite Tier"
          description="Every gate genuinely met, including a real segment specialist."
          metrics={backtest.elite}
          minSampleSize={backtest.minSampleSize}
          meetsMinSample={backtest.eliteMeetsMinSample}
        />
        <EliteTierGroupStats
          label="Near-Elite (backtest-only comparison group)"
          description={'Every Elite gate met except segment-specialist support -- unobservable in historical backtests, since specialist segments are themselves fit FROM this same data. Never shown as "Elite" anywhere in the live app.'}
          metrics={backtest.nearElite}
          minSampleSize={backtest.minSampleSize}
          meetsMinSample={backtest.nearEliteMeetsMinSample}
        />
      </CardContent>
    </Card>
  )
}

const UPSET_RISK_TIER_LABEL = UPSET_RISK_SHORT
const DISAGREEMENT_TIER_LABEL: Record<string, string> = { Strong: "Strong", Moderate: "Moderate", Mixed: "Mixed", HighDisagreement: "High Disagreement" }

function UpsetRiskTierCard({ tiers }: { tiers: UpsetRiskTierMetrics[] }) {
  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-6 md:p-8">
        <CardTitle className="text-xl font-display flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <ShieldAlert className="w-5 h-5 text-primary" />
          </div>
          Upset-Risk Track Record (Task 56)
        </CardTitle>
        <p className="text-sm text-muted-foreground/80 leading-relaxed mt-4 max-w-4xl">
          Upset risk is a pure downstream classifier of the already-calibrated probability -- it never changes the
          probability itself, so its validation is whether the model's own favorite actually loses more often as the
          tier climbs. A tier is doing real work only if favorite-loss rate rises LOW → MODERATE → HIGH → EXTREME.
          Scoped to genuinely-unseen graded rows only (historical test-segment + paper trading).
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/10">
              <tr className="text-left text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase border-b border-border/50">
                <th className="py-4 px-6 font-bold whitespace-nowrap">Tier</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Sample</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Favorite-Loss Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {tiers.map((t) => {
                const lowConfidence = t.n < LOW_CONFIDENCE_TIER_SAMPLE
                return (
                  <tr key={t.tier} className="hover:bg-secondary/30 transition-colors">
                    <td className="py-4 px-6 font-mono font-bold text-foreground whitespace-nowrap text-base">
                      <span className="flex items-center gap-2">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${UPSET_RISK_DOT_CLASS[t.tier] ?? "bg-muted-foreground"}`} />
                        {UPSET_RISK_TIER_LABEL[t.tier] ?? t.tier}
                      </span>
                    </td>
                    <td className="py-4 px-6 font-mono tabular-nums text-right text-muted-foreground">n={t.n}</td>
                    <td className="py-4 px-6 font-mono font-bold tabular-nums text-right">
                      <div className="flex items-center justify-end gap-3">
                        {lowConfidence && (
                          <Badge variant="outline" className="font-mono text-[9px] tracking-widest shadow-sm">
                            LOW CONFIDENCE (n&lt;{LOW_CONFIDENCE_TIER_SAMPLE})
                          </Badge>
                        )}
                        <span className="matrix-number text-lg">{t.favoriteLossRate !== null ? `${t.favoriteLossRate}%` : "—"}</span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function DisagreementTierCard({ tiers }: { tiers: DisagreementTierMetrics[] }) {
  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-6 md:p-8">
        <CardTitle className="text-xl font-display flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Swords className="w-5 h-5 text-primary" />
          </div>
          Model-Disagreement Track Record (Task 56)
        </CardTitle>
        <p className="text-sm text-muted-foreground/80 leading-relaxed mt-4 max-w-4xl">
          Model agreement is also a pure downstream classifier -- it never changes the calibrated probability. The
          tier that matters most is High Disagreement, which should show the lowest accuracy of the four: those are
          the genuinely hardest matchups, where the engine's own core models point in different directions. Strong/
          Moderate/Mixed aren't expected to fall in a perfectly straight line -- only High Disagreement being worst
          is the load-bearing claim. Scoped to the same genuinely-unseen rows as the upset-risk table above.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/10">
              <tr className="text-left text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase border-b border-border/50">
                <th className="py-4 px-6 font-bold whitespace-nowrap">Tier</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Sample</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Accuracy</th>
                <th className="py-4 px-6 font-bold whitespace-nowrap text-right">Error Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {tiers.map((t) => {
                const lowConfidence = t.n < LOW_CONFIDENCE_TIER_SAMPLE
                return (
                  <tr key={t.tier} className="hover:bg-secondary/30 transition-colors">
                    <td className="py-4 px-6 font-mono font-bold text-foreground whitespace-nowrap text-base">
                      <div className="flex items-center gap-3">
                        {DISAGREEMENT_TIER_LABEL[t.tier] ?? t.tier}
                        {t.tier === "HighDisagreement" && (
                          <Badge variant="secondary" className="font-mono text-[9px] tracking-widest shadow-sm">
                            HARDEST TIER
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-4 px-6 font-mono tabular-nums text-right text-muted-foreground">n={t.n}</td>
                    <td className="py-4 px-6 font-mono font-bold tabular-nums text-right">
                      <div className="flex items-center justify-end gap-3">
                        {lowConfidence && (
                          <Badge variant="outline" className="font-mono text-[9px] tracking-widest shadow-sm">
                            LOW CONFIDENCE (n&lt;{LOW_CONFIDENCE_TIER_SAMPLE})
                          </Badge>
                        )}
                        <span className="matrix-number text-lg">{t.accuracy !== null ? `${t.accuracy}%` : "—"}</span>
                      </div>
                    </td>
                    <td className="py-4 px-6 font-mono font-bold tabular-nums text-right text-muted-foreground">{t.errorRate !== null ? `${t.errorRate}%` : "—"}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function MarketEdgeCard({ marketEdge }: { marketEdge: MarketEdgeSummary }) {
  const hasData = marketEdge.n > 0 && marketEdge.averageEdge !== null
  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-6 md:p-8">
        <CardTitle className="text-xl font-display flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <LineChart className="w-5 h-5 text-primary" />
          </div>
          Market Edge (Task 47)
        </CardTitle>
        <p className="text-sm text-muted-foreground/80 leading-relaxed mt-4 max-w-4xl">
          Compares the model's calibrated probability against real, vig-adjusted implied probability from live
          bookmaker odds (The Odds API, falling back to Odds-API.io), captured at the moment each paper-trade
          prediction was locked. This is a distinct metric from accuracy/ECE above -- it measures agreement with the
          market, not with the eventual real-world outcome. Predictions with no odds available at lock time are left
          out entirely, never counted as zero edge.
        </p>
      </CardHeader>
      <CardContent className="p-6 md:p-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
          <MetricStat label={`AVERAGE EDGE (n=${marketEdge.n})`} value={hasData ? `${marketEdge.averageEdge! > 0 ? "+" : ""}${marketEdge.averageEdge}pp` : "—"} />
          <div className="space-y-2 p-5 bg-background rounded-xl border border-border/50 shadow-sm">
            <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">READING</div>
            <div className="text-sm text-foreground/80 leading-relaxed font-medium">
              {hasData
                ? marketEdge.averageEdge! > 0
                  ? "Model is finding more value in its picks than the market prices in, on average."
                  : marketEdge.averageEdge! < 0
                    ? "Market has been pricing the model's picks more favorably than the model itself, on average."
                    : "Model and market agree on average."
                : "No graded paper-trade predictions with odds available yet."}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ShadowReplayCard({ shadowDashboard }: { shadowDashboard: ShadowReplayDashboard | undefined }) {
  const queryClient = useQueryClient()
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [batchLabel, setBatchLabel] = useState("")
  const [overwrite, setOverwrite] = useState(false)

  const runShadowReplay = useRunShadowReplay({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetShadowReplayDashboardQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetOptimizerAccuracySummaryQueryKey() })
        queryClient.invalidateQueries({ queryKey: getCandidateConfigsQueryKey() })
      },
    },
  })

  const canSubmit = startDate.trim() !== "" && endDate.trim() !== "" && batchLabel.trim() !== "" && !runShadowReplay.isPending

  const m = shadowDashboard?.overall

  return (
    <Card className="glass-panel border-accent/40">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-6 md:p-8">
        <CardTitle className="text-xl font-display flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <FlaskConical className="w-5 h-5 text-primary" />
          </div>
          Shadow / Simulated Replay
          <Badge variant="outline" className="font-mono text-[10px] tracking-widest uppercase border-primary/50 text-primary">
            SIMULATED — NOT LIVE EVIDENCE
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground/80 leading-relaxed mt-4 max-w-4xl">
          A fast, leakage-safe replay of held-out historical dates through the same point-in-time scoring path as
          walk-forward, so you don't have to wait for real paper trading to slowly accumulate one graded fixture at a
          time. Each replayed match is graded using{" "}
          <span className="font-semibold text-foreground">whichever calibration mapping was actually active on that match's own date</span>
          , reconstructed from the calibration-refit history — not today's mapping applied uniformly across the whole
          range. Treat this as directional, simulated evidence only: it still reruns today's engine version and can't
          reconstruct segment-specialist fits that didn't exist yet on those dates. It is never merged into the
          segments, Elite tier, upset-risk, disagreement, or market-edge numbers above, and it never touches real
          paper-trade or walk-forward rows.
        </p>
      </CardHeader>
      <CardContent className="p-6 md:p-8 space-y-8">
        <form
          className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4 items-end bg-background p-5 rounded-xl border border-border/50 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault()
            if (!canSubmit) return
            runShadowReplay.mutate({ data: { startDate, endDate, batchLabel, overwrite } })
          }}
        >
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Start Date</Label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">End Date</Label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">Batch Label</Label>
            <Input type="text" placeholder="e.g. shadow-2024-q1" value={batchLabel} onChange={(e) => setBatchLabel(e.target.value)} required />
          </div>
          <div className="flex items-center gap-2 pb-2.5">
            <Checkbox id="shadow-overwrite" checked={overwrite} onCheckedChange={(c) => setOverwrite(c === true)} />
            <Label htmlFor="shadow-overwrite" className="text-xs font-mono text-muted-foreground leading-tight cursor-pointer">
              Overwrite this exact batch label if it already exists
            </Label>
          </div>
          <div className="md:col-span-5">
            <Button type="submit" variant="accent" disabled={!canSubmit} className="gap-2 shadow-md font-mono h-10">
              {runShadowReplay.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
              RUN SHADOW REPLAY
            </Button>
          </div>
        </form>

        {runShadowReplay.data && (
          <div className="flex flex-wrap gap-3 text-[11px] font-mono font-bold text-muted-foreground tracking-widest uppercase bg-secondary/20 p-4 rounded-xl border border-border/50">
            <span>INSERTED: <span className="text-foreground">{runShadowReplay.data.inserted}</span></span>
            <span className="text-border">•</span>
            <span>ALREADY CLAIMED: <span className="text-foreground">{runShadowReplay.data.skippedAlreadyClaimed}</span></span>
            <span className="text-border">•</span>
            <span>INSUFFICIENT DATA: <span className="text-foreground">{runShadowReplay.data.skippedInsufficientData}</span></span>
            <span className="text-border">•</span>
            <span>DAYS SIMULATED: <span className="text-foreground">{runShadowReplay.data.daysSimulated}</span></span>
            {runShadowReplay.data.overwrite && (
              <>
                <span className="text-border">•</span>
                <span>DELETED (OVERWRITE): <span className="text-foreground">{runShadowReplay.data.deletedExistingBatchRows}</span></span>
              </>
            )}
          </div>
        )}

        {runShadowReplay.isError && (
          <div className="text-sm font-medium text-destructive bg-destructive/5 border border-destructive rounded-xl p-4">
            {runShadowReplay.error instanceof Error ? runShadowReplay.error.message : "Shadow replay failed."}
          </div>
        )}

        {m && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <MetricStat label={`ACCURACY (n=${m.n})`} value={m.accuracy !== null ? `${m.accuracy}%` : "—"} />
            <MetricStat label="LOG LOSS" value={m.logLoss !== null ? m.logLoss.toFixed(3) : "—"} />
            <MetricStat label="BRIER SCORE" value={m.brier !== null ? m.brier.toFixed(3) : "—"} />
            <ECEStat label="ECE (CALIBRATED)" ece={m.eceCalibrated} />
          </div>
        )}

        {shadowDashboard && shadowDashboard.batches.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border/50">
            <table className="w-full text-sm">
              <thead className="bg-secondary/10">
                <tr className="text-left text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase border-b border-border/50">
                  <th className="py-3 px-5 font-bold whitespace-nowrap">Batch</th>
                  <th className="py-3 px-5 font-bold whitespace-nowrap text-right">N</th>
                  <th className="py-3 px-5 font-bold whitespace-nowrap">Date Range</th>
                  <th className="py-3 px-5 font-bold whitespace-nowrap">Last Run</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {shadowDashboard.batches.map((b) => (
                  <tr key={b.batchLabel} className="hover:bg-secondary/30 transition-colors">
                    <td className="py-3 px-5 font-mono font-bold text-foreground whitespace-nowrap">{b.batchLabel}</td>
                    <td className="py-3 px-5 font-mono tabular-nums text-right">{b.n}</td>
                    <td className="py-3 px-5 font-mono text-muted-foreground whitespace-nowrap">
                      {b.dateRangeStart && b.dateRangeEnd ? `${formatDate(b.dateRangeStart)} – ${formatDate(b.dateRangeEnd)}` : "—"}
                    </td>
                    <td className="py-3 px-5 font-mono text-muted-foreground whitespace-nowrap">{b.latestLockedAt ? formatDate(b.latestLockedAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {shadowDashboard && shadowDashboard.batches.length === 0 && (
          <p className="text-xs text-muted-foreground font-mono bg-secondary/30 p-3 rounded-lg border border-border/50 text-center">
            No shadow-replay batches have been run yet.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ── Task #12: Correct vs Incorrect Patterns Panel ───────────────────────────────────────────────

const EVIDENCE_BADGE: Record<PatternSegmentItem["evidenceStrength"], { label: string; variant: "success" | "warning" | "destructive" | "outline" | "secondary" }> = {
  Strong:      { label: "STRONG",       variant: "success" },
  Moderate:    { label: "MODERATE",     variant: "warning" },
  Weak:        { label: "WEAK",         variant: "outline" },
  Insufficient:{ label: "INSUFF.",      variant: "secondary" },
}

const DIMENSION_LABELS: Record<string, string> = {
  surface: "Surface",
  tournamentLevel: "Tour Level",
  probabilityBand: "Confidence Band",
  upsetRiskTier: "Upset-Risk Tier",
  modelAgreement: "Model Agreement",
  closeMatch: "Close vs Clear",
  dataQualityTier: "Data Quality",
  runKind: "Run Kind",
}

function CorrectVsIncorrectPanel({ data }: { data: LatestPatternAnalysis | null | undefined }) {
  const [expanded, setExpanded] = useState(false)
  if (!data) {
    return (
      <Card className="glass-panel">
        <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 flex flex-row items-center gap-3">
          <TrendingUp className="w-5 h-5 text-primary shrink-0" />
          <CardTitle className="text-lg font-display">Correct vs Incorrect Patterns</CardTitle>
        </CardHeader>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No pattern analysis has run yet. Run a walk-forward to generate this report.
        </CardContent>
      </Card>
    )
  }

  // Sort segments by |accuracy - 50| desc (most divergent first), then filter to those with sampleSize≥5
  const diverging = [...data.segments]
    .filter(s => s.sampleSize >= 5 && s.accuracy !== null)
    .sort((a, b) => Math.abs((b.accuracy ?? 50) - 50) - Math.abs((a.accuracy ?? 50) - 50))
    .slice(0, expanded ? 60 : 12)

  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 flex flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <TrendingUp className="w-5 h-5 text-primary shrink-0" />
          <div>
            <CardTitle className="text-lg font-display">Correct vs Incorrect Patterns</CardTitle>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              {data.totalAnalyzed.toLocaleString()} genuinely-unseen graded rows · computed {new Date(data.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <button onClick={() => setExpanded(e => !e)} className="text-muted-foreground hover:text-foreground transition-colors">
          {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
        </button>
      </CardHeader>
      <CardContent className="p-5 space-y-3">
        <p className="text-xs text-muted-foreground/80 leading-relaxed">
          Segments ranked by divergence from 50% accuracy. <span className="font-mono font-bold">Evidence strength</span> is based on sample size and CI width — only Strong/Moderate segments warrant action.
          Validation-segment and shadow rows are excluded; these are test+paper-trade rows only.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {diverging.map((seg, i) => {
            const badge = EVIDENCE_BADGE[seg.evidenceStrength]
            // segmentKey is "dimension:value" (e.g. "surface:Hard"); label is the human-readable display
            const [dimensionKey, ...valueParts] = seg.segmentKey.split(":")
            const dimLabel = DIMENSION_LABELS[dimensionKey] ?? dimensionKey
            const segValue = valueParts.length > 0 ? valueParts.join(":") : seg.label
            const isPositive = (seg.accuracy ?? 50) > 50
            return (
              <div key={i} className="bg-background rounded-xl border border-border/50 p-4 space-y-2 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">{dimLabel}</div>
                    <div className="font-bold text-sm mt-0.5 truncate">{segValue}</div>
                  </div>
                  <Badge variant={badge.variant} className="font-mono text-[9px] tracking-widest shrink-0">{badge.label}</Badge>
                </div>
                <div className="flex items-center gap-3">
                  <div className={`text-2xl font-display font-bold tabular-nums ${isPositive ? "text-success" : "text-destructive"}`}>
                    {seg.accuracy !== null ? `${seg.accuracy}%` : "—"}
                  </div>
                  <div className="text-xs text-muted-foreground/80 font-mono space-y-0.5">
                    <div>n={seg.sampleSize}</div>
                    {seg.ciLow !== null && seg.ciHigh !== null && (
                      <div>CI [{seg.ciLow.toFixed(0)}–{seg.ciHigh.toFixed(0)}]</div>
                    )}
                  </div>
                </div>
                {seg.lift !== null && (
                  <div className="text-[11px] font-mono text-muted-foreground/70">
                    Lift {seg.lift.toFixed(2)} vs baseline {seg.baselineAccuracy}%
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {data.segments.filter((s: PatternSegmentItem) => s.sampleSize >= 5).length > 12 && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2 mt-2"
          >
            {expanded ? "Show fewer" : `Show all ${data.segments.filter((s: PatternSegmentItem) => s.sampleSize >= 5).length} segments`}
          </button>
        )}
      </CardContent>
    </Card>
  )
}

// ── Task #12: Threshold Recommendations Panel ─────────────────────────────────────────────────────

const CLASSIFICATION_BADGE: Record<ThresholdEvalEntryItem["classification"], { variant: "success" | "warning" | "destructive" | "outline" | "secondary" }> = {
  "Deploy":           { variant: "success" },
  "Continue shadow":  { variant: "warning" },
  "Needs more data":  { variant: "outline" },
  "Reject":           { variant: "destructive" },
  "Investigate":      { variant: "secondary" },
}

function ThresholdRecommendationsPanel({ data }: { data: LatestThresholdEvaluation | null | undefined }) {
  const [expanded, setExpanded] = useState(false)
  if (!data) {
    return (
      <Card className="glass-panel">
        <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 flex flex-row items-center gap-3">
          <Beaker className="w-5 h-5 text-primary shrink-0" />
          <CardTitle className="text-lg font-display">Threshold Recommendations</CardTitle>
        </CardHeader>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No threshold evaluation has run yet. Use "Run Optimizer" to generate this report.
        </CardContent>
      </Card>
    )
  }

  const shown = expanded ? data.thresholds : data.thresholds.slice(0, 6)

  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 flex flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Beaker className="w-5 h-5 text-primary shrink-0" />
          <div>
            <CardTitle className="text-lg font-display">Threshold Recommendations</CardTitle>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              {data.totalGraded.toLocaleString()} graded rows · computed {new Date(data.createdAt).toLocaleDateString()} · read-only
            </p>
          </div>
        </div>
        <button onClick={() => setExpanded(e => !e)} className="text-muted-foreground hover:text-foreground transition-colors">
          {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
        </button>
      </CardHeader>
      <CardContent className="p-5 space-y-3">
        <p className="text-xs text-muted-foreground/80 leading-relaxed">
          Candidate threshold values scored against the held-out graded cohort. <span className="font-mono font-bold text-foreground">Nothing is auto-deployed</span> — all changes require a separate manual acceptance step.
          Widening a gate (admitting more predictions) requires genuine holdout log-loss improvement to avoid Reject.
        </p>
        <div className="space-y-3">
          {shown.map((entry: ThresholdEvalEntryItem, i: number) => {
            const badge = CLASSIFICATION_BADGE[entry.classification]
            const logLossImproved = entry.logLossDelta !== null && entry.logLossDelta > 0
            const accImproved = entry.accuracyDelta !== null && entry.accuracyDelta > 0
            return (
              <div key={i} className="bg-background rounded-xl border border-border/50 p-4 space-y-2 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">{entry.tierId}</div>
                    <div className="font-bold text-sm mt-0.5">{entry.tierLabel}</div>
                  </div>
                  <Badge variant={badge.variant} className="font-mono text-[9px] tracking-widest shrink-0">{entry.classification.toUpperCase()}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                  <div className="bg-secondary/30 rounded-lg p-2">
                    <div className="text-[10px] text-muted-foreground tracking-wider uppercase mb-1">CURRENT</div>
                    <div className="font-bold">{String(entry.currentValue)}</div>
                    {entry.currentAccuracy !== null && <div className="text-muted-foreground/70">acc {entry.currentAccuracy}%</div>}
                  </div>
                  <div className={`rounded-lg p-2 ${entry.isWidening ? "bg-warning/10 border border-warning/20" : "bg-secondary/30"}`}>
                    <div className="text-[10px] text-muted-foreground tracking-wider uppercase mb-1">
                      CANDIDATE{entry.isWidening && <span className="text-warning ml-1">↕ WIDER</span>}
                    </div>
                    <div className="font-bold">{String(entry.candidateValue)}</div>
                    {entry.candidateAccuracy !== null && (
                      <div className={`${accImproved ? "text-success" : "text-muted-foreground/70"}`}>
                        acc {entry.candidateAccuracy}%{entry.accuracyDelta !== null && entry.accuracyDelta !== 0 && ` (${entry.accuracyDelta > 0 ? "+" : ""}${entry.accuracyDelta})`}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 text-[11px] font-mono">
                  <span className="text-muted-foreground/70">n={entry.affectedN}</span>
                  {entry.logLossDelta !== null && (
                    <span className={logLossImproved ? "text-success font-bold" : "text-muted-foreground/70"}>
                      LL Δ{entry.logLossDelta > 0 ? "+" : ""}{entry.logLossDelta.toFixed(4)}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground/70 leading-relaxed">{entry.note}</p>
              </div>
            )
          })}
        </div>
        {data.thresholds.length > 6 && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
          >
            {expanded ? "Show fewer" : `Show all ${data.thresholds.length} threshold entries`}
          </button>
        )}
      </CardContent>
    </Card>
  )
}

function metricPct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value}%`
}

function metricNum(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? "—" : value.toFixed(digits)
}

type StrategySortKey =
  | "accuracy"
  | "brier"
  | "logLoss"
  | "ece"
  | "coverage"
  | "surface"
  | "tour"
  | "competitiveBalance"
  | "evidenceReliability"
  | "recommendation"
  | "elite"
  | "family"
  | "lastTested"
  | "version"

function numMetric(record: CandidateConfigRecord, key: string): number | null {
  const source = record.holdoutMetrics ?? record.validationMetrics ?? {}
  const value = source[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function recordCoverage(record: CandidateConfigRecord): number | null {
  const source = record.validationMetrics ?? record.holdoutMetrics ?? {}
  const coverage = source.coverage
  if (typeof coverage === "number" && Number.isFinite(coverage)) return coverage
  const total = source.totalPredictions
  const graded = source.totalGradedPredictions
  if (typeof total === "number" && typeof graded === "number" && total > 0) return Math.round((graded / total) * 1000) / 10
  return null
}

function recordSortValue(record: CandidateConfigRecord, sortBy: StrategySortKey): number | string {
  switch (sortBy) {
    case "accuracy": return numMetric(record, "accuracy") ?? -Infinity
    case "brier": return -(numMetric(record, "brier") ?? Infinity)
    case "logLoss": return -(numMetric(record, "logLoss") ?? Infinity)
    case "ece": return -(numMetric(record, "ece") ?? Infinity)
    case "coverage": return recordCoverage(record) ?? -Infinity
    case "surface": return (record.strategyFamily ?? "") + (record.specialistRouting ?? "")
    case "tour": return (record.proposedConfig?.tour ?? record.specialistRouting ?? "") as string
    case "competitiveBalance": return (record.competitiveBalanceBehavior?.useCompetitiveBalanceShrink ? 1 : 0)
    case "evidenceReliability": return (record.evidenceReliabilityBehavior?.useReliabilityGates ? 1 : 0)
    case "recommendation": return (record.recommendationGates ? 1 : 0)
    case "elite": return (record.validationStatus === "passed" ? 1 : 0)
    case "family": return record.strategyFamily ?? record.creationMethod ?? ""
    case "lastTested": return record.lastTestedAt ?? record.updatedAt ?? record.createdAt
    case "version": return record.strategyVersion ?? ""
  }
}

function sortDirectionFor(sortBy: StrategySortKey): 1 | -1 {
  return sortBy === "brier" || sortBy === "logLoss" || sortBy === "ece" ? -1 : 1
}

function StrategyMiniCard({ label, pick }: { label: string; pick: OptimizerStrategyPick }) {
  return (
    <div className="bg-background border border-border/50 rounded-xl p-4 space-y-2 shadow-sm">
      <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">{label}</div>
      <div className="font-display font-bold text-base text-foreground truncate">{pick.name ?? "—"}</div>
      <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">{pick.status ?? "unknown"}</div>
      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div>Acc: <span className="text-foreground font-bold">{metricPct(pick.accuracy)}</span></div>
        <div>Brier: <span className="text-foreground font-bold">{metricNum(pick.brier)}</span></div>
        <div>LL: <span className="text-foreground font-bold">{metricNum(pick.logLoss)}</span></div>
        <div>ECE: <span className="text-foreground font-bold">{metricNum(pick.calibrationError)}</span></div>
      </div>
    </div>
  )
}

function ProductionPerformanceCard({ data }: {
  data: {
    strategyName: string | null
    strategyVersion: string | null
    dateImplemented: string | null
    lastValidationDate: string | null
    overallAccuracy: number | null
    walkForwardAccuracy: number | null
    shadowReplayAccuracy: number | null
    paperTradingAccuracy: number | null
    liveGradedAccuracy: number | null
    brierScore: number | null
    logLoss: number | null
    ece: number | null
    calibrationError: number | null
    coverage: number | null
    abstentionRate: number | null
    totalPredictions: number
    totalGradedPredictions: number
  }
}) {
  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 md:p-6">
        <CardTitle className="text-lg font-display flex items-center gap-3">
          <ShieldAlert className="w-5 h-5 text-primary" />
          Current Production Performance
        </CardTitle>
        <p className="text-xs text-muted-foreground font-mono mt-2">
          Strict scope: metrics only include rows locked after the currently deployed strategy implementation timestamp.
        </p>
      </CardHeader>
      <CardContent className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm font-mono">
          <div className="bg-background p-4 rounded-xl border border-border/50">Strategy: <span className="text-foreground font-bold">{data.strategyName ?? "—"}</span></div>
          <div className="bg-background p-4 rounded-xl border border-border/50">Version: <span className="text-foreground font-bold">{data.strategyVersion ?? "—"}</span></div>
          <div className="bg-background p-4 rounded-xl border border-border/50">Implemented: <span className="text-foreground font-bold">{data.dateImplemented ? formatDate(data.dateImplemented) : "—"}</span></div>
          <div className="bg-background p-4 rounded-xl border border-border/50">Last Validation: <span className="text-foreground font-bold">{data.lastValidationDate ? formatDate(data.lastValidationDate) : "—"}</span></div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricStat label="OVERALL ACC" value={metricPct(data.overallAccuracy)} />
          <MetricStat label="WALK-FWD ACC" value={metricPct(data.walkForwardAccuracy)} />
          <MetricStat label="SHADOW ACC" value={metricPct(data.shadowReplayAccuracy)} />
          <MetricStat label="PAPER ACC" value={metricPct(data.paperTradingAccuracy)} />
          <MetricStat label="LIVE ACC" value={metricPct(data.liveGradedAccuracy)} />
          <MetricStat label="COVERAGE" value={metricPct(data.coverage)} />
          <MetricStat label="ABSTENTION" value={metricPct(data.abstentionRate)} />
          <MetricStat label="GRADED N" value={data.totalGradedPredictions.toLocaleString()} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <MetricStat label="BRIER" value={metricNum(data.brierScore)} />
          <MetricStat label="LOG LOSS" value={metricNum(data.logLoss)} />
          <ECEStat label="ECE" ece={data.ece ?? data.calibrationError} />
        </div>
      </CardContent>
    </Card>
  )
}

function OptimizerSummaryCard({ data }: {
  data: {
    status: "idle" | "running" | "completed"
    lastRunAt: string | null
    currentStage: string | null
    strategiesGenerated: number
    strategiesTested: number
    uniqueStrategies: number
    duplicateStrategiesRejected: number
    strategiesAwaitingValidation: number
    strategiesInShadowMode: number
    challengers: number
    archivedStrategies: number
    failedStrategies: number
    largestAccuracyImprovement: number | null
    largestBrierImprovement: number | null
    largestLogLossImprovement: number | null
  }
}) {
  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 md:p-6">
        <CardTitle className="text-lg font-display flex items-center gap-3">
          <FlaskConical className="w-5 h-5 text-primary" />
          Optimizer Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <div className="flex flex-wrap gap-3 text-xs font-mono uppercase tracking-widest">
          <Badge variant={data.status === "completed" ? "success" : data.status === "running" ? "warning" : "secondary"}>{data.status}</Badge>
          {data.currentStage && <Badge variant="outline">{data.currentStage}</Badge>}
          {data.lastRunAt && <span className="text-muted-foreground">last run {formatDate(data.lastRunAt)}</span>}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <MetricStat label="GENERATED" value={String(data.strategiesGenerated)} />
          <MetricStat label="TESTED" value={String(data.strategiesTested)} />
          <MetricStat label="UNIQUE" value={String(data.uniqueStrategies)} />
          <MetricStat label="DUP REJECT" value={String(data.duplicateStrategiesRejected)} />
          <MetricStat label="AWAITING" value={String(data.strategiesAwaitingValidation)} />
          <MetricStat label="SHADOW" value={String(data.strategiesInShadowMode)} />
          <MetricStat label="CHALLENGERS" value={String(data.challengers)} />
          <MetricStat label="ARCHIVED" value={String(data.archivedStrategies)} />
          <MetricStat label="FAILED" value={String(data.failedStrategies)} />
          <MetricStat label="Δ ACC BEST" value={data.largestAccuracyImprovement === null ? "—" : `${data.largestAccuracyImprovement > 0 ? "+" : ""}${data.largestAccuracyImprovement}%`} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono text-muted-foreground">
          <div>Best Brier improvement: <span className="text-foreground font-bold">{data.largestBrierImprovement === null ? "—" : data.largestBrierImprovement.toFixed(3)}</span></div>
          <div>Best LogLoss improvement: <span className="text-foreground font-bold">{data.largestLogLossImprovement === null ? "—" : data.largestLogLossImprovement.toFixed(3)}</span></div>
        </div>
      </CardContent>
    </Card>
  )
}

function StrategyLeaderboard({ strategies, onPromote, onArchive }: { strategies: CandidateConfigRecord[]; onPromote?: (strategy: CandidateConfigRecord) => void; onArchive?: (strategy: CandidateConfigRecord) => void }) {
  const [sortBy, setSortBy] = useState<StrategySortKey>("accuracy")
  const sorted = useMemo(() => {
    const dir = sortDirectionFor(sortBy)
    return [...strategies].sort((a, b) => {
      const va = recordSortValue(a, sortBy)
      const vb = recordSortValue(b, sortBy)
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir
      return String(vb).localeCompare(String(va)) * dir
    })
  }, [strategies, sortBy])

  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 md:p-6">
        <CardTitle className="text-lg font-display flex items-center gap-3">
          <Crown className="w-5 h-5 text-primary" />
          Strategy Leaderboard
        </CardTitle>
        <div className="flex flex-wrap gap-2 mt-3 text-[10px] font-mono uppercase tracking-widest">
          {(["accuracy","brier","logLoss","ece","coverage","surface","tour","competitiveBalance","evidenceReliability","recommendation","elite","family","lastTested","version"] as StrategySortKey[]).map((key) => (
            <Button key={key} size="sm" variant={sortBy === key ? "accent" : "outline"} onClick={() => setSortBy(key)} className="h-8 px-3 text-[10px]">
              {key}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-secondary/10">
            <tr className="text-left text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase border-b border-border/50">
              <th className="py-4 px-5">Strategy</th>
              <th className="py-4 px-5">Identity</th>
              <th className="py-4 px-5">Last Tested</th>
              <th className="py-4 px-5 text-right">Acc</th>
              <th className="py-4 px-5 text-right">Brier</th>
              <th className="py-4 px-5 text-right">LL</th>
              <th className="py-4 px-5 text-right">ECE</th>
              <th className="py-4 px-5 text-right">Coverage</th>
              <th className="py-4 px-5">Family</th>
              <th className="py-4 px-5">Status</th>
              <th className="py-4 px-5">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {sorted.map((strategy) => (
              <tr key={strategy.id} className="hover:bg-secondary/20 transition-colors">
                <td className="py-3 px-5 font-display font-bold">{strategy.strategyName ?? strategy.name}</td>
                <td className="py-3 px-5 font-mono text-[11px] text-muted-foreground">
                  <div>{strategy.strategyId ?? "—"}</div>
                  <div>{strategy.strategyVersion ?? "—"}</div>
                </td>
                <td className="py-3 px-5 font-mono text-[11px] text-muted-foreground">{strategy.lastTestedAt ? formatDate(strategy.lastTestedAt) : "—"}</td>
                <td className="py-3 px-5 text-right font-mono">{metricPct(numMetric(strategy, "accuracy"))}</td>
                <td className="py-3 px-5 text-right font-mono">{metricNum(numMetric(strategy, "brier"))}</td>
                <td className="py-3 px-5 text-right font-mono">{metricNum(numMetric(strategy, "logLoss"))}</td>
                <td className="py-3 px-5 text-right font-mono">{metricNum(numMetric(strategy, "ece"))}</td>
                <td className="py-3 px-5 text-right font-mono">{metricPct(recordCoverage(strategy))}</td>
                <td className="py-3 px-5 font-mono text-[11px]">{strategy.strategyFamily ?? strategy.creationMethod ?? "—"}</td>
                <td className="py-3 px-5"><Badge variant={strategy.status === "promoted" ? "success" : strategy.status === "archived" ? "secondary" : "outline"}>{strategy.status}</Badge></td>
                <td className="py-3 px-5">
                  <div className="flex gap-2">
                    {onPromote && <Button size="sm" variant="outline" onClick={() => onPromote(strategy)} className="h-8">Promote</Button>}
                    {onArchive && <Button size="sm" variant="ghost" onClick={() => onArchive(strategy)} className="h-8">Archive</Button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function OptimizerRecommendationsPanel({ summary, strategies }: { summary: OptimizerAccuracySummaryResponse; strategies: CandidateConfigRecord[] }) {
  const recommended = strategies.filter((s) => s.acceptanceChecksPassed)
  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 md:p-6">
        <CardTitle className="text-lg font-display flex items-center gap-3">
          <Beaker className="w-5 h-5 text-primary" />
          Optimizer Recommendations
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <MetricStat label="PRODUCTION CANDIDATE" value={summary.comparison.production.name ?? "—"} />
          <MetricStat label="BEST NEW STRATEGY" value={summary.optimizer.bestNewStrategy.name ?? "—"} />
          <MetricStat label="READY TO PROMOTE" value={String(recommended.length)} />
        </div>
        <div className="text-xs font-mono text-muted-foreground">Uses acceptance checks, diversity floors, novelty, and current production/challenger comparisons to rank promotion candidates.</div>
      </CardContent>
    </Card>
  )
}

export default function AccuracyDashboardPage() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { data: dashboard, isLoading } = useGetEvaluationDashboard()
  const { data: runs } = useListEvaluationRuns()
  const { data: settings } = useGetEvaluationSettings()
  const { data: shadowDashboard } = useGetShadowReplayDashboard()
  const { data: optimizerSummary } = useGetOptimizerAccuracySummary({
    query: { queryKey: getGetOptimizerAccuracySummaryQueryKey(), refetchInterval: 10000 },
  })
  const { data: candidateConfigs } = useGetCandidateConfigs({
    query: { queryKey: getCandidateConfigsQueryKey(), refetchInterval: 10000 },
  })
  // Task #12: pattern analysis and threshold evaluation data
  const { data: patternAnalysis } = useGetLatestPatternAnalysis()
  const { data: thresholdEvaluation } = useGetLatestThresholdEvaluation()

  // Stage A2: async job hooks — respond immediately, poll for status
  const walkForwardJob = useAsyncJob<{ foldsRun: number; evaluationOnly: boolean; skippedNoEligibleMatches: boolean }>({
    startPath: "/api/evaluation/walk-forward/run",
    statusPath: "/api/evaluation/walk-forward/status",
    onDone: () => {
      queryClient.invalidateQueries({ queryKey: getGetEvaluationDashboardQueryKey() })
      queryClient.invalidateQueries({ queryKey: getListEvaluationRunsQueryKey() })
      queryClient.invalidateQueries({ queryKey: getGetLatestPatternAnalysisQueryKey() })
      queryClient.invalidateQueries({ queryKey: getGetOptimizerAccuracySummaryQueryKey() })
      queryClient.invalidateQueries({ queryKey: getCandidateConfigsQueryKey() })
    },
  })

  const optimizerJob = useAsyncJob<{ candidateConfigId: number; walkForward: { foldsRun: number } }>({
    startPath: "/api/evaluation/optimizer/run",
    statusPath: "/api/evaluation/optimizer/status",
    onDone: () => {
      queryClient.invalidateQueries({ queryKey: getGetEvaluationDashboardQueryKey() })
      queryClient.invalidateQueries({ queryKey: getListEvaluationRunsQueryKey() })
      queryClient.invalidateQueries({ queryKey: getGetLatestPatternAnalysisQueryKey() })
      queryClient.invalidateQueries({ queryKey: getGetLatestThresholdEvaluationQueryKey() })
      queryClient.invalidateQueries({ queryKey: getGetOptimizerAccuracySummaryQueryKey() })
      queryClient.invalidateQueries({ queryKey: getCandidateConfigsQueryKey() })
    },
  })

  const runPaperTrading = useRunPaperTradingCycle({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetEvaluationDashboardQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetOptimizerAccuracySummaryQueryKey() })
        queryClient.invalidateQueries({ queryKey: getCandidateConfigsQueryKey() })
      },
    },
  })
  const updateSettings = useUpdateEvaluationSettings({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetEvaluationSettingsQueryKey() }),
    },
  })

  const [pendingAction, setPendingAction] = useState<null | { kind: "promote" | "reject" | "archive" | "restore" | "delete"; strategy: CandidateConfigRecord }>(null)
  const [actionBusy, setActionBusy] = useState(false)

  async function runCandidateAction(kind: "promote" | "reject" | "archive" | "restore" | "delete", strategy: CandidateConfigRecord): Promise<void> {
    let response: Response
    if (kind === "promote") {
      response = await fetch(`${getBaseUrl()}/api/candidate-configs/${strategy.id}/promote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "Manual promotion from strategy library" }) })
    } else if (kind === "reject") {
      response = await fetch(`${getBaseUrl()}/api/candidate-configs/${strategy.id}/reject`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "Manual rejection" }) })
    } else if (kind === "archive") {
      response = await fetch(`${getBaseUrl()}/api/candidate-configs/${strategy.id}/archive`, { method: "POST" })
    } else if (kind === "restore") {
      response = await fetch(`${getBaseUrl()}/api/candidate-configs/${strategy.id}/restore`, { method: "POST" })
    } else {
      response = await fetch(`${getBaseUrl()}/api/candidate-configs/${strategy.id}`, { method: "DELETE" })
    }

    if (!response.ok) {
      let message = `Action failed (HTTP ${response.status})`
      try {
        const payload = await response.json() as { error?: string }
        if (typeof payload.error === "string" && payload.error.trim().length > 0) message = payload.error
      } catch {
        // keep fallback message
      }
      throw new Error(message)
    }

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetOptimizerAccuracySummaryQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getCandidateConfigsQueryKey() }),
    ])
  }

  const validation600 = optimizerSummary?.validation600 ?? null

  return (
    <div className="space-y-10 animate-in fade-in duration-500 w-full max-w-6xl mx-auto pb-12 overflow-x-hidden">
      <div className="flex flex-col gap-4 border-b border-border/50 pb-6">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-4xl font-display font-bold tracking-tight">Accuracy Dashboard</h1>
          <p className="text-muted-foreground mt-2 text-sm sm:text-base">
            Segmented, honestly-labeled results. Validation numbers were used to fit calibration — only test and paper-trade numbers are genuinely unseen.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 border border-border/50 rounded-xl p-4 bg-secondary/20 space-y-3">
            <div>
              <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-1">PAPER-TRADE CYCLE</div>
              <p className="text-xs text-muted-foreground/80 leading-relaxed">
                Locks predictions for upcoming fixtures within the lead window, then grades any pending matches that have finished. Run this regularly to keep your paper-trading record current.
              </p>
            </div>
            <Button variant="outline" onClick={() => runPaperTrading.mutate()} disabled={runPaperTrading.isPending} className="gap-2 shadow-sm font-mono h-10 w-full sm:w-auto">
              {runPaperTrading.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}
              RUN PAPER-TRADE
            </Button>
            <div className="text-[11px] font-mono text-muted-foreground">Status: <span className="text-foreground">{runPaperTrading.isPending ? "Running" : runPaperTrading.isError ? "Failed" : runPaperTrading.isSuccess ? "Completed" : "Idle"}</span></div>
            {runPaperTrading.data && (
              <div className="flex flex-wrap gap-3 text-[11px] font-mono font-bold text-muted-foreground tracking-widest uppercase bg-background p-3 rounded-lg border border-border/50">
                <span>LOCKED: <span className="text-foreground">{runPaperTrading.data.locked}</span></span>
                <span className="text-border">•</span>
                <span>GRADED: <span className="text-success">{runPaperTrading.data.graded}</span></span>
                <span className="text-border">•</span>
                <span>MISSED: <span className="text-muted-foreground">{runPaperTrading.data.missed}</span></span>
                {runPaperTrading.data.errors?.length > 0 && (
                  <>
                    <span className="text-border">•</span>
                    <span className="text-destructive">ERRORS: {runPaperTrading.data.errors.length}</span>
                  </>
                )}
              </div>
            )}
            {runPaperTrading.isError && (
              <CompactRunnerErrorCard feature="Paper-Trade" message={runPaperTrading.error instanceof Error ? runPaperTrading.error.message : "Paper-trade cycle failed"} />
            )}
          </div>

          <div className="flex-1 border border-border/50 rounded-xl p-4 bg-secondary/20 space-y-3">
            <div>
              <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-1">WALK-FORWARD BACKTEST</div>
              <p className="text-xs text-muted-foreground/80 leading-relaxed">
                Evaluation-only mode: scores all historical data against the <span className="font-bold text-foreground">frozen</span> production calibration — never updates any weights. Progress is shown live. Use "Run Optimizer" below to refit calibration and generate a candidate config.
              </p>
            </div>
            <Button
              variant="accent"
              onClick={() => { void walkForwardJob.start({ evaluationOnly: true }) }}
              disabled={walkForwardJob.state.phase === "starting" || walkForwardJob.state.phase === "running"}
              className="gap-2 shadow-md font-mono h-10 w-full sm:w-auto"
            >
              {(walkForwardJob.state.phase === "starting" || walkForwardJob.state.phase === "running")
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <PlayCircle className="w-4 h-4" />}
              {walkForwardJob.state.phase === "starting" ? "QUEUING…" : walkForwardJob.state.phase === "running" ? "RUNNING…" : "RUN WALK-FORWARD"}
            </Button>
            <div className="text-[11px] font-mono text-muted-foreground">Status: <span className="text-foreground">{toRunStatus(walkForwardJob.state.phase)}</span></div>
            {walkForwardJob.state.phase === "running" && (
              <p className="text-xs text-muted-foreground font-mono animate-pulse">
                Walk-forward in progress — typically 20–60 min depending on corpus size.{walkForwardJob.state.matchesScored ? ` ${walkForwardJob.state.matchesScored.toLocaleString()} matches scored so far.` : ""} Results appear automatically when done.
              </p>
            )}
            {walkForwardJob.state.phase === "done" && (
              <div className="flex flex-wrap gap-3 text-[11px] font-mono font-bold text-muted-foreground tracking-widest uppercase bg-background p-3 rounded-lg border border-border/50">
                <span>FOLDS: <span className="text-foreground">{walkForwardJob.state.result.foldsRun}</span></span>
                <span className="text-border">•</span>
                <span className="text-success">EVAL-ONLY (frozen)</span>
                <button onClick={() => walkForwardJob.reset()} className="text-muted-foreground hover:text-foreground underline underline-offset-2 text-[10px]">dismiss</button>
              </div>
            )}
            {walkForwardJob.state.phase === "error" && (
              <CompactRunnerErrorCard feature="Walk-Forward" message={walkForwardJob.state.message} />
            )}
          </div>

          <div className="flex-1 border border-border/50 rounded-xl p-4 bg-secondary/20 space-y-3">
            <div>
              <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-1">OPTIMIZER</div>
              <p className="text-xs text-muted-foreground/80 leading-relaxed">
                Runs the full training walk-forward (refits calibration + specialist weights), writes a versioned candidate config, and scores threshold candidates. Takes 8–12 min. <span className="font-bold text-foreground">Production config is never auto-promoted.</span>
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => { void optimizerJob.start({}) }}
              disabled={optimizerJob.state.phase === "starting" || optimizerJob.state.phase === "running"}
              className="gap-2 shadow-sm font-mono h-10 w-full sm:w-auto"
            >
              {(optimizerJob.state.phase === "starting" || optimizerJob.state.phase === "running")
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Beaker className="w-4 h-4" />}
              {optimizerJob.state.phase === "starting" ? "QUEUING…" : optimizerJob.state.phase === "running" ? "OPTIMIZING…" : "RUN OPTIMIZER"}
            </Button>
            <div className="text-[11px] font-mono text-muted-foreground">Status: <span className="text-foreground">{toRunStatus(optimizerJob.state.phase)}</span></div>
            {optimizerJob.state.phase === "running" && (
              <p className="text-xs text-muted-foreground font-mono animate-pulse">
                Optimizer running — refitting calibration + specialist weights. Takes 20–40 min.
              </p>
            )}
            {optimizerJob.state.phase === "done" && (
              <div className="flex flex-wrap gap-3 text-[11px] font-mono font-bold text-muted-foreground tracking-widest uppercase bg-background p-3 rounded-lg border border-border/50">
                <span>CANDIDATE: <span className="text-foreground">#{optimizerJob.state.result.candidateConfigId}</span></span>
                <span className="text-border">•</span>
                <span>FOLDS: <span className="text-foreground">{optimizerJob.state.result.walkForward.foldsRun}</span></span>
                <button onClick={() => optimizerJob.reset()} className="text-muted-foreground hover:text-foreground underline underline-offset-2 text-[10px]">dismiss</button>
              </div>
            )}
            {optimizerJob.state.phase === "error" && (
              <CompactRunnerErrorCard feature="Optimizer" message={optimizerJob.state.message} />
            )}
          </div>
        </div>
      </div>

      {walkForwardJob.state.phase === "done" && walkForwardJob.state.result.skippedNoEligibleMatches && (
        <Card className="border-warning bg-warning/5 shadow-sm">
          <CardContent className="p-5 text-sm font-medium text-warning-foreground flex items-center gap-3">
            <ShieldAlert className="w-5 h-5 text-warning shrink-0" />
            Not enough historical match data to run a meaningful walk-forward evaluation yet. Backfill more historical matches first.
          </CardContent>
        </Card>
      )}

      {settings && (
        <Card className="glass-panel">
          <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 md:p-6"><CardTitle className="text-lg font-display">Evaluation Settings</CardTitle></CardHeader>
          <CardContent className="flex flex-col md:flex-row md:items-center gap-6 p-6">
            <div className="flex items-start gap-4 p-4 bg-background rounded-xl border border-border/50 shadow-sm flex-1">
              <Switch
                className="mt-0.5"
                checked={settings.retirementRule === "included"}
                onCheckedChange={(checked) => updateSettings.mutate({ data: { retirementRule: checked ? "included" : "excluded" } })}
              />
              <div>
                <div className="text-sm font-bold font-display tracking-wide">Count retirements toward accuracy</div>
                <div className="text-xs text-muted-foreground/80 mt-1 leading-relaxed">Off (default): retirements are graded but reported separately, never in the headline number.</div>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <div className="text-[10px] text-muted-foreground font-mono font-bold tracking-widest uppercase bg-secondary/30 px-3 py-2 rounded-md border border-border/50">
                PAPER-TRADE LEAD: <span className="text-foreground">{settings.paperTradeLeadMinutes} min</span> before start
              </div>
              <div className="text-[10px] text-muted-foreground font-mono font-bold tracking-widest uppercase bg-secondary/30 px-3 py-2 rounded-md border border-border/50">
                CALIBRATION FIT: <span className="text-foreground">{dashboard?.activeCalibrationSampleSize ?? 0} val predictions</span>
                {dashboard?.activeCalibrationMethod && <span className="text-muted-foreground/50 mx-2">|</span>} {dashboard?.activeCalibrationMethod && <span>method: <span className="text-foreground">{dashboard.activeCalibrationMethod}</span></span>}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {optimizerSummary && (
        <section className="space-y-6">
          <ProductionPerformanceCard data={optimizerSummary.production} />
          <OptimizerSummaryCard data={optimizerSummary.optimizer} />

          <Card className="glass-panel">
            <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 md:p-6">
              <CardTitle className="text-lg font-display flex items-center gap-3">
                <Swords className="w-5 h-5 text-primary" />
                Production vs Challenger
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              <StrategyMiniCard label="Current Production" pick={optimizerSummary.comparison.production} />
              <StrategyMiniCard label="Current Challenger" pick={optimizerSummary.comparison.challenger} />
            </CardContent>
          </Card>

          <Card className="glass-panel">
            <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 md:p-6">
              <CardTitle className="text-lg font-display">Best Strategies By Segment / Objective</CardTitle>
            </CardHeader>
            <CardContent className="p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              <StrategyMiniCard label="Current Production Strategy" pick={optimizerSummary.bestByCategory.currentProductionStrategy} />
              <StrategyMiniCard label="Current Challenger Strategy" pick={optimizerSummary.bestByCategory.currentChallengerStrategy} />
              <StrategyMiniCard label="Best Historical Strategy" pick={optimizerSummary.bestByCategory.bestHistoricalStrategy} />
              <StrategyMiniCard label="Best Newly Generated Strategy" pick={optimizerSummary.bestByCategory.bestNewlyGeneratedStrategy} />
              <StrategyMiniCard label="Best By Surface" pick={optimizerSummary.bestByCategory.bestBySurface} />
              <StrategyMiniCard label="Best By Tour Level" pick={optimizerSummary.bestByCategory.bestByTourLevel} />
              <StrategyMiniCard label="Best Competitive Balance Tier" pick={optimizerSummary.bestByCategory.bestByCompetitiveBalanceTier} />
              <StrategyMiniCard label="Best Evidence Reliability Tier" pick={optimizerSummary.bestByCategory.bestByEvidenceReliabilityTier} />
              <StrategyMiniCard label="Best Recommendation Type" pick={optimizerSummary.bestByCategory.bestByRecommendationType} />
              <StrategyMiniCard label="Best Calibration Quality" pick={optimizerSummary.bestByCategory.bestByCalibrationQuality} />
              <StrategyMiniCard label="Best Raw Winner Accuracy" pick={optimizerSummary.bestByCategory.bestByRawWinnerAccuracy} />
            </CardContent>
          </Card>

          <Card className="glass-panel">
            <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 md:p-6">
              <CardTitle className="text-lg font-display">OPTIMIZER STRATEGY LIBRARY</CardTitle>
              <p className="text-xs text-muted-foreground font-mono">Versioned history of production, candidate, promoted, rejected, archived, and testing strategies.</p>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary/10">
                  <tr className="text-left text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase border-b border-border/50">
                    <th className="py-4 px-5">Strategy</th>
                    <th className="py-4 px-5">Version</th>
                    <th className="py-4 px-5">Status</th>
                    <th className="py-4 px-5 text-right">Accuracy</th>
                    <th className="py-4 px-5 text-right">Log Loss</th>
                    <th className="py-4 px-5 text-right">Brier</th>
                    <th className="py-4 px-5 text-right">ECE</th>
                    <th className="py-4 px-5">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {(candidateConfigs ?? []).map((strategy) => {
                    const holdout = strategy.holdoutMetrics ?? strategy.validationMetrics ?? {}
                    const canDeleteDraft = strategy.status !== "promoted" && strategy.productionStatus !== "production"
                    return (
                      <tr key={strategy.id} className="hover:bg-secondary/20 transition-colors">
                        <td className="py-3 px-5">
                          <div className="font-display font-bold">{strategy.strategyName ?? strategy.name}</div>
                          <div className="text-[11px] font-mono text-muted-foreground">ID: {strategy.strategyId ?? "—"}</div>
                        </td>
                        <td className="py-3 px-5 font-mono text-[11px] text-muted-foreground">{strategy.strategyVersion ?? "—"}</td>
                        <td className="py-3 px-5"><Badge variant={strategy.status === "promoted" ? "success" : strategy.status === "rejected" ? "destructive" : strategy.status === "archived" ? "secondary" : "outline"}>{strategy.status}</Badge></td>
                        <td className="py-3 px-5 text-right font-mono">{metricPct(typeof holdout.accuracy === "number" ? holdout.accuracy : null)}</td>
                        <td className="py-3 px-5 text-right font-mono">{metricNum(typeof holdout.logLoss === "number" ? holdout.logLoss : null)}</td>
                        <td className="py-3 px-5 text-right font-mono">{metricNum(typeof holdout.brier === "number" ? holdout.brier : null)}</td>
                        <td className="py-3 px-5 text-right font-mono">{metricNum(typeof holdout.ece === "number" ? holdout.ece : null)}</td>
                        <td className="py-3 px-5">
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" className="h-8" onClick={() => setPendingAction({ kind: "promote", strategy })}>Promote to Production</Button>
                            <Button size="sm" variant="outline" className="h-8" onClick={() => setPendingAction({ kind: "reject", strategy })}>Reject</Button>
                            <Button size="sm" variant="ghost" className="h-8" onClick={() => setPendingAction({ kind: "archive", strategy })}>Archive</Button>
                            <Button size="sm" variant="ghost" className="h-8" onClick={() => setPendingAction({ kind: "restore", strategy })}>Restore</Button>
                            {canDeleteDraft && <Button size="sm" variant="destructive" className="h-8" onClick={() => setPendingAction({ kind: "delete", strategy })}>Delete Draft</Button>}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <StrategyLeaderboard strategies={candidateConfigs ?? []} />
          <OptimizerRecommendationsPanel summary={optimizerSummary} strategies={candidateConfigs ?? []} />
        </section>
      )}

      <Card className="glass-panel">
        <CardHeader className="border-b border-border/50 bg-secondary/20 p-5 md:p-6">
          <CardTitle className="text-lg font-display">600-Match Strategy Validation</CardTitle>
          <p className="text-xs text-muted-foreground font-mono">Separate from live results, historical results, shadow replay, and paper trading.</p>
        </CardHeader>
        {validation600 ? (
          <CardContent className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Validation Status: <span className="text-foreground">{validation600.status}</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Dataset Size: <span className="text-foreground">{validation600.sampleSize.toLocaleString()} / {validation600.sampleTarget.toLocaleString()} rows</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Timestamp: <span className="text-foreground">{validation600.timestamp ? formatDate(validation600.timestamp) : "—"}</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Baseline Accuracy: <span className="text-foreground">{metricPct(validation600.baseline.accuracy)}</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Best Strategy Accuracy: <span className="text-foreground">{metricPct(validation600.candidate.accuracy)}</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Coverage / Abstention: <span className="text-foreground">{metricPct(validation600.baseline.coverage)} / {metricPct(validation600.baseline.abstentionRate)}</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Baseline LL / Brier / ECE: <span className="text-foreground">{metricNum(validation600.baseline.logLoss)} / {metricNum(validation600.baseline.brier)} / {metricNum(validation600.baseline.ece)}</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Candidate LL / Brier / ECE: <span className="text-foreground">{metricNum(validation600.candidate.logLoss)} / {metricNum(validation600.candidate.brier)} / {metricNum(validation600.candidate.ece)}</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Accuracy Change / Calibration Change: <span className="text-foreground">{validation600.deltas.accuracy === null ? "—" : `${validation600.deltas.accuracy > 0 ? "+" : ""}${validation600.deltas.accuracy.toFixed(2)}%`} / {validation600.deltas.ece === null ? "—" : `${validation600.deltas.ece > 0 ? "+" : ""}${validation600.deltas.ece.toFixed(3)}`}</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Trades Rejected / Losses Avoided: <span className="text-foreground">{validation600.tradesRejected === null || validation600.lossesAvoided === null ? "Unavailable" : `${validation600.tradesRejected} / ${validation600.lossesAvoided}${validation600.tradesRejectedEstimated || validation600.lossesAvoidedEstimated ? " (Estimated)" : ""}`}</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono md:col-span-2">Strategy Tested: <span className="text-foreground">{validation600.candidate.name ? `${validation600.candidate.name}${validation600.candidate.strategyVersion ? ` (${validation600.candidate.strategyVersion})` : ""}` : "No candidate with holdout metrics yet"}</span></div>
            <div className="bg-background p-4 rounded-xl border border-border/50 text-sm font-mono">Promotion Recommendation: <span className="text-foreground">{validation600.promotionRecommendation}</span></div>
            {validation600.limitation && (
              <div className="bg-secondary/20 p-4 rounded-xl border border-border/50 text-xs font-mono text-muted-foreground md:col-span-3">
                Note: {validation600.limitation}
              </div>
            )}
          </CardContent>
        ) : (
          <CardContent className="p-6 text-sm text-muted-foreground">Validation summary unavailable.</CardContent>
        )}
      </Card>

      {pendingAction && (
        <div className="fixed inset-0 z-[60] bg-background/70 backdrop-blur-sm flex items-center justify-center p-4">
          <Card className="w-full max-w-xl shadow-2xl">
            <CardHeader>
              <CardTitle className="text-lg font-display">Confirm {pendingAction.kind.toUpperCase()}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-sm text-muted-foreground">
                Strategy: <span className="text-foreground font-bold">{pendingAction.strategy.strategyName ?? pendingAction.strategy.name}</span>
              </div>
              <div className="text-xs font-mono text-muted-foreground bg-secondary/30 rounded p-3">
                Current production strategy remains unchanged until manual promotion succeeds.
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setPendingAction(null)}>Cancel</Button>
                <Button
                  variant={pendingAction.kind === "delete" ? "destructive" : "outline"}
                  disabled={actionBusy}
                  onClick={async () => {
                    setActionBusy(true)
                    try {
                      await runCandidateAction(pendingAction.kind, pendingAction.strategy)
                      toast({ title: `Strategy ${pendingAction.kind} action completed` })
                      setPendingAction(null)
                    } catch (error) {
                      const message = error instanceof Error ? error.message : "Action failed"
                      toast({ title: "Strategy action failed", description: message })
                    } finally {
                      setActionBusy(false)
                    }
                  }}
                >
                  {actionBusy ? "Working..." : "Confirm"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-6">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-72 w-full rounded-2xl" />)}
        </div>
      ) : dashboard ? (
        <div className="space-y-8">
          <EliteTierBacktestCard backtest={dashboard.eliteTierBacktest} />
          <UpsetRiskTierCard tiers={dashboard.upsetRiskTierMetrics} />
          <DisagreementTierCard tiers={dashboard.disagreementTierMetrics} />
          <MarketEdgeCard marketEdge={dashboard.marketEdge} />
          <div className="pt-4 border-t border-border/50 space-y-6">
            <h2 className="text-2xl font-bold font-display mb-6">Performance Segments</h2>
            {dashboard.segments.map((segment) => (
              <SegmentCard key={segment.key} segment={segment} />
            ))}
          </div>
          {dashboard.specialistSegments.length > 0 && <SpecialistSegmentTable segments={dashboard.specialistSegments} />}
        </div>
      ) : null}

      <ShadowReplayCard shadowDashboard={shadowDashboard} />

      {/* Task #12: Correct vs Incorrect Patterns & Threshold Recommendations */}
      <CorrectVsIncorrectPanel data={patternAnalysis} />
      <ThresholdRecommendationsPanel data={thresholdEvaluation} />

      {runs && runs.length > 0 && (
        <section className="space-y-6 pt-8 border-t border-border/50">
          <h2 className="text-2xl font-bold font-display">Walk-Forward Folds</h2>
          <div className="space-y-4">
            {runs.map((run) => (
              <Card key={run.id} className="shadow-sm glass-panel hover-lift">
                <CardContent className="p-5 sm:p-6 grid grid-cols-1 md:grid-cols-4 gap-6 text-sm">
                  <div className="bg-background p-4 rounded-xl border border-border/50 text-center">
                    <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">FOLD</div>
                    <div className="font-display font-bold text-3xl mt-1 text-primary">#{run.foldIndex}</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-1.5">VALIDATION WINDOW</div>
                    <div className="font-mono font-bold">{formatDate(run.validationStart)} – {formatDate(run.validationEnd)}</div>
                    <div className="text-xs text-muted-foreground/80 mt-1.5 font-mono">
                      acc <span className="font-bold text-foreground">{run.validationMetrics.accuracy !== null ? `${run.validationMetrics.accuracy}%` : "—"}</span> (n={run.validationMetrics.n})
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-1.5">TEST WINDOW <span className="opacity-50">(unseen)</span></div>
                    <div className="font-mono font-bold">{formatDate(run.testStart)} – {formatDate(run.testEnd)}</div>
                    <div className="text-xs text-muted-foreground/80 mt-1.5 font-mono">
                      acc <span className="font-bold text-foreground">{run.testMetrics.accuracy !== null ? `${run.testMetrics.accuracy}%` : "—"}</span> (n={run.testMetrics.n})
                    </div>
                  </div>
                  <div className="flex flex-col justify-center">
                    <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-1.5">MODEL VERSION</div>
                    <div className="font-mono font-bold bg-secondary/50 px-3 py-1.5 rounded-md inline-block self-start border border-border/50">{run.modelVersion}</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
