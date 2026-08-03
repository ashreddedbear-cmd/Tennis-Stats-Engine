import { useState, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Legend,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Monitor, Activity, CheckCircle2, AlertTriangle, Clock, AlertCircle,
  TrendingUp, TrendingDown, Minus, Info, ChevronDown, ChevronUp,
  BarChart3, Shield, Zap, Layers, BookOpen, Lock, Crown, RefreshCw,
  ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react"

/** Minimum graded predictions required to display a metric as reliable. */
const MINIMUM_SAMPLE = 350

// ─── Types ────────────────────────────────────────────────────────────────────
interface StatusInfo {
  label: string
  explanation: string
  modelVersion: string | null
  lastUpdated: string | null
  lastValidation: string | null
  dataCoverageStart: string | null
  dataCoverageEnd: string | null
}
interface PerformanceMetrics {
  overallAccuracy: number | null
  predictionsEvaluated: number
  logLoss: number | null
  brierScore: number | null
  ece: number | null
  avgConfidence: number | null
  accuracy7d: number | null; count7d: number
  accuracy30d: number | null; count30d: number
  accuracy90d: number | null; count90d: number
}
interface CalibrationBucket {
  label: string; min: number; max: number; n: number
  avgPredicted: number | null; observedAccuracy: number | null
  calibrationError: number | null
}
interface SurfaceRow { surface: string; accuracy: number | null; n: number; avgConfidence: number | null }
interface LevelRow { level: string; accuracy: number | null; n: number }
interface AgreementRow { tier: string; n: number; accuracy: number | null; errorRate: number | null }
interface UpsetRiskRow { tier: string; n: number; favoriteLossRate: number | null }
interface RecommendationRow { recommendation: string; n: number; accuracy: number | null }
interface DataQuality { avgScore: number | null; highCount: number; medCount: number; lowCount: number; total: number }
interface ModelImprovement { title: string; date: string; area: string; explanation: string; monitoringStatus: string }
interface ModelVersion { version: string; status: string; deployedDate: string; validationStatus: string; notes: string }
interface MonitoringDashboard {
  status: StatusInfo; performance: PerformanceMetrics
  calibration: CalibrationBucket[]
  bySurface: SurfaceRow[]; byLevel: LevelRow[]
  byAgreement: AgreementRow[]; byUpsetRisk: UpsetRiskRow[]; byRecommendation: RecommendationRow[]
  dataQuality: DataQuality
  improvements: ModelImprovement[]; versionHistory: ModelVersion[]
  tier?: "free" | "pro" | "pro_annual" | "elite" | "elite_annual" | "team"
}
interface TrendPoint { date: string; count: number; accuracy: number | null }

// ─── Fetch helpers ────────────────────────────────────────────────────────────
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
function apiFetch<T>(path: string): Promise<T> {
  return fetch(`${BASE}${path}`, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json() as Promise<T>
  })
}
function useDashboard() {
  return useQuery<MonitoringDashboard, Error>({
    queryKey: ["monitoring-dashboard"],
    queryFn: () => apiFetch("/api/monitoring/dashboard"),
    staleTime: 30 * 60 * 1000,          // consider fresh for 30 min
    refetchInterval: 12 * 60 * 60 * 1000, // auto-refresh every 12 hours
    retry: 1,
  })
}
function useTrend(period: string) {
  return useQuery<{ points: TrendPoint[] }, Error>({
    queryKey: ["monitoring-trend", period],
    queryFn: () => apiFetch(`/api/monitoring/accuracy-trend?period=${period}`),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })
}

// ─── Shared helpers ───────────────────────────────────────────────────────────
function fmt(v: number | null | undefined, suffix = "%"): string {
  if (v === null || v === undefined) return "—"
  return `${v}${suffix}`
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}
function accuracyColor(acc: number | null): string {
  if (acc === null) return "text-muted-foreground"
  if (acc >= 68) return "text-success"
  if (acc >= 60) return "text-primary"
  if (acc >= 55) return "text-warning"
  return "text-destructive"
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; variant: "success" | "warning" | "destructive" | "outline" }> = {
  "Operating Normally": { icon: <CheckCircle2 className="w-4 h-4" />, variant: "success" },
  "Monitoring Required": { icon: <Activity className="w-4 h-4" />, variant: "outline" },
  "Performance Degraded": { icon: <AlertCircle className="w-4 h-4" />, variant: "destructive" },
  "Data Delay": { icon: <Clock className="w-4 h-4" />, variant: "warning" },
  "Validation Required": { icon: <Info className="w-4 h-4" />, variant: "outline" },
}

const REC_LABEL: Record<string, string> = {
  STRONG_RECOMMENDATION: "High Confidence",
  MODERATE_LEAN: "Moderate Lean",
  HIGH_RISK: "High Risk",
  NO_STRONG_SIGNAL: "No Strong Signal",
  CLOSE_CALL: "Too Close to Call",
  COIN_FLIP: "Too Close to Call",
}

const AGREEMENT_LABEL: Record<string, string> = {
  Strong: "Strong Agreement",
  Moderate: "Moderate Agreement",
  Mixed: "Mixed Agreement",
  HighDisagreement: "High Disagreement",
}

// ─── Section skeleton ─────────────────────────────────────────────────────────
function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

function SectionError({ message }: { message: string }) {
  return (
    <p className="text-sm text-muted-foreground font-mono py-4 text-center">
      {message}
    </p>
  )
}

// ─── Elite locked section ─────────────────────────────────────────────────────
function EliteLockedSection({ title, description }: { title: string; description: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-primary/5 p-8 text-center space-y-4">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent to-background/60 pointer-events-none" />
      <div className="relative z-10 space-y-3">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 border border-primary/20">
          <Lock className="w-5 h-5 text-primary" />
        </div>
        <div>
          <p className="font-display font-bold text-lg">{title}</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto leading-relaxed">{description}</p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Crown className="w-4 h-4 text-primary" />
          <span className="text-sm font-bold text-primary font-mono tracking-widest uppercase">Elite Plan</span>
        </div>
        <a href="/payments">
          <Button variant="default" size="sm" className="font-mono gap-2">
            <Crown className="w-3.5 h-3.5" />
            Upgrade to Elite — $49.99/mo
          </Button>
        </a>
      </div>
    </div>
  )
}

// ─── Metric card ──────────────────────────────────────────────────────────────
function MetricCard({
  label, value, sub, tooltip, highlight, dim,
}: {
  label: string; value: string; sub?: string; tooltip?: string; highlight?: string; dim?: boolean
}) {
  const card = (
    <div className={`p-3 sm:p-4 bg-background rounded-xl border border-border/50 shadow-sm text-center space-y-1.5 transition-opacity ${dim ? "opacity-40" : ""}`}>
      <div className="text-[9px] sm:text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase leading-tight">{label}</div>
      <div className={`text-2xl sm:text-3xl font-display font-bold tracking-tight tabular-nums ${highlight ?? "text-foreground"}`}>{value}</div>
      {sub && <div className="text-[9px] sm:text-[10px] font-mono text-muted-foreground leading-tight">{sub}</div>}
    </div>
  )
  if (!tooltip) return card
  return (
    <Tooltip>
      <TooltipTrigger asChild>{card}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-xs font-mono">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

// ─── Status Card ──────────────────────────────────────────────────────────────
function StatusCard({ status }: { status: StatusInfo }) {
  const cfg = STATUS_CONFIG[status.label] ?? STATUS_CONFIG["Monitoring Required"]
  return (
    <Card className="border-primary/20 glass-panel">
      <CardContent className="p-6 md:p-8">
        <div className="flex flex-col sm:flex-row sm:items-start gap-6">
          <div className="flex-1 space-y-4">
            <div className="flex items-center gap-3">
              <Badge variant={cfg.variant} className="gap-1.5 px-3 py-1.5 text-sm font-bold font-mono shadow-md">
                {cfg.icon}
                {status.label}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">{status.explanation}</p>
          </div>
          <div className="shrink-0 grid grid-cols-2 sm:grid-cols-1 gap-2 text-[11px] font-mono">
            {[
              ["Model Version", status.modelVersion],
              ["Last Updated", fmtDate(status.lastUpdated)],
              ["Data From", status.dataCoverageStart ? fmtDate(status.dataCoverageStart) : null],
              ["Data To", status.dataCoverageEnd ? fmtDate(status.dataCoverageEnd) : null],
            ].map(([label, val]) => val ? (
              <div key={label} className="bg-secondary/30 px-3 py-1.5 rounded-lg border border-border/50">
                <span className="text-muted-foreground/70">{label}:</span>{" "}
                <span className="font-bold text-foreground">{val}</span>
              </div>
            ) : null)}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Performance Summary ─────────────────────────────────────────────────────
function PerformanceSummary({ p }: { p: PerformanceMetrics }) {
  const hasOverall = p.predictionsEvaluated >= MINIMUM_SAMPLE
  const has7d = p.count7d >= MINIMUM_SAMPLE
  const has30d = p.count30d >= MINIMUM_SAMPLE
  const has90d = p.count90d >= MINIMUM_SAMPLE
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard label="Overall Accuracy"
          value={hasOverall ? fmt(p.overallAccuracy) : "—"}
          highlight={hasOverall ? accuracyColor(p.overallAccuracy) : "text-muted-foreground/40"}
          sub={hasOverall ? `n = ${p.predictionsEvaluated.toLocaleString()}` : `n = ${p.predictionsEvaluated} (min ${MINIMUM_SAMPLE})`}
          dim={!hasOverall}
          tooltip="Percentage of graded live predictions where the model picked the correct winner." />
        <MetricCard label="Avg Confidence" value={fmt(p.avgConfidence)}
          tooltip="Average calibrated win probability stated for the predicted winner, across all graded predictions." />
        <MetricCard label="Log Loss" value={p.logLoss !== null ? p.logLoss.toFixed(3) : "—"}
          tooltip="Measures calibration quality — lower is better. Perfect calibration = 0.693 baseline." />
        <MetricCard label="Brier Score" value={p.brierScore !== null ? p.brierScore.toFixed(3) : "—"}
          tooltip="Average squared error between stated probability and actual outcome. Lower = more accurate and better calibrated." />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard label="ECE (Calibration Error)" value={p.ece !== null ? p.ece.toFixed(3) : "—"}
          highlight={p.ece !== null ? (p.ece < 0.03 ? "text-success" : p.ece < 0.05 ? "text-warning" : "text-destructive") : ""}
          tooltip="Expected Calibration Error — gap between stated confidence and real accuracy. Below 0.03 = well calibrated." />
        <MetricCard label="Last 7 Days"
          value={has7d ? fmt(p.accuracy7d) : "—"}
          sub={`n = ${p.count7d}${!has7d ? ` (min ${MINIMUM_SAMPLE})` : ""}`}
          highlight={has7d ? accuracyColor(p.accuracy7d) : "text-muted-foreground/40"}
          dim={!has7d}
          tooltip="Accuracy on predictions graded in the last 7 days." />
        <MetricCard label="Last 30 Days"
          value={has30d ? fmt(p.accuracy30d) : "—"}
          sub={`n = ${p.count30d}${!has30d ? ` (min ${MINIMUM_SAMPLE})` : ""}`}
          highlight={has30d ? accuracyColor(p.accuracy30d) : "text-muted-foreground/40"}
          dim={!has30d}
          tooltip="Accuracy on predictions graded in the last 30 days." />
        <MetricCard label="Last 90 Days"
          value={has90d ? fmt(p.accuracy90d) : "—"}
          sub={`n = ${p.count90d}${!has90d ? ` (min ${MINIMUM_SAMPLE})` : ""}`}
          highlight={has90d ? accuracyColor(p.accuracy90d) : "text-muted-foreground/40"}
          dim={!has90d}
          tooltip="Accuracy on predictions graded in the last 90 days." />
      </div>
    </div>
  )
}

// ─── Accuracy Trend Chart ─────────────────────────────────────────────────────
const PERIODS = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1yr", label: "1 year" },
]

function AccuracyTrendChart() {
  const [period, setPeriod] = useState("30d")
  const { data, isLoading, isError } = useTrend(period)

  const points = data?.points ?? []
  const hasData = points.some((p) => p.accuracy !== null && p.count >= 3)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {PERIODS.map((p) => (
          <Button
            key={p.value}
            variant={period === p.value ? "default" : "outline"}
            size="sm"
            className="font-mono text-xs h-7"
            onClick={() => setPeriod(p.value)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      {isLoading && <Skeleton className="h-48 w-full" />}
      {isError && <SectionError message="Could not load accuracy trend. Please refresh." />}
      {!isLoading && !isError && !hasData && (
        <div className="h-48 flex items-center justify-center text-sm text-muted-foreground font-mono">
          Not enough graded data in this period to show a trend.
        </div>
      )}
      {!isLoading && !isError && hasData && (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={points} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border)/0.4)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={(v: string) => v.slice(5)}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[40, 100]}
              tick={{ fontSize: 10, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={(v: number) => `${v}%`}
              width={38}
            />
            <RechartsTooltip
              contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontFamily: "monospace", fontSize: 11 }}
              formatter={(value: number, _name: string, item: { payload?: { count?: number } }) => [
                `${value}% (n=${item?.payload?.count ?? 0})`, "Accuracy"
              ]}
              labelFormatter={(label: string) => `Date: ${label}`}
            />
            <Line
              type="monotone"
              dataKey="accuracy"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ─── Calibration helpers ──────────────────────────────────────────────────────

/** Minimum sample a bucket needs to count toward "best tier" selection. */
const CALIBRATION_BEST_TIER_MIN = 30

type CalibrationRating = { emoji: string; label: string; variant: "success" | "warning" | "destructive" | "outline" }

function getCalibrationRating(error: number | null): CalibrationRating {
  if (error === null) return { emoji: "", label: "No Data", variant: "outline" }
  if (error < 2)  return { emoji: "⭐", label: "Excellent",     variant: "success" }
  if (error < 4)  return { emoji: "✅", label: "Very Good",     variant: "success" }
  if (error < 6)  return { emoji: "✓",  label: "Good",          variant: "outline" }
  if (error < 8)  return { emoji: "⚠",  label: "Fair",          variant: "warning" }
  return           { emoji: "⚠",  label: "Overconfident", variant: "destructive" }
}

type SortKey = "min" | "n" | "avgPredicted" | "observedAccuracy" | "calibrationError"

// ─── Calibration bar chart ────────────────────────────────────────────────────
function CalibrationChart({ buckets }: { buckets: CalibrationBucket[] }) {
  // Include all buckets that have at least some data — grey out low-sample ones
  const chartData = buckets
    .filter((b) => b.avgPredicted !== null || b.observedAccuracy !== null)
    .map((b) => ({
      label: b.label,
      predicted: b.avgPredicted,
      actual: b.observedAccuracy,
      n: b.n,
      lowSample: b.n < CALIBRATION_BEST_TIER_MIN,
    }))

  if (chartData.length === 0) {
    return <div className="h-48 flex items-center justify-center text-sm text-muted-foreground font-mono">Not enough graded data for chart.</div>
  }

  return (
    <div className="space-y-1">
      <ResponsiveContainer width="100%" height={210}>
        <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }} barCategoryGap="25%" barGap={2}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border)/0.4)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 9, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
            interval={0}
            tickLine={false}
            angle={-35}
            textAnchor="end"
            height={42}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 10, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
            tickFormatter={(v: number) => `${v}%`}
            width={38}
            tickLine={false}
          />
          <RechartsTooltip
            contentStyle={{
              background: "hsl(var(--background))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              fontFamily: "monospace",
              fontSize: 11,
            }}
            formatter={(value, name, item) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const n = (item as any)?.payload?.n ?? 0
              const v = typeof value === "number" ? value : null
              return v !== null ? [`${v.toFixed(1)}% (n=${n})`, name] : ["—", name]
            }}
            labelFormatter={(label: string) => `Band: ${label}`}
          />
          <Legend
            wrapperStyle={{ fontFamily: "monospace", fontSize: 10, paddingTop: 4 }}
            iconType="rect"
          />
          <Bar dataKey="predicted" name="Predicted Win %" fill="hsl(var(--primary))" opacity={0.85} radius={[3, 3, 0, 0]} />
          <Bar dataKey="actual"    name="Actual Win %"    fill="hsl(var(--chart-2, 220 70% 60%))" opacity={0.85} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <p className="text-[9px] font-mono text-muted-foreground/60 text-center">
        Closer bars = better calibration. Each pair shows stated confidence vs real win rate for that probability band.
      </p>
    </div>
  )
}

// ─── Calibration table ────────────────────────────────────────────────────────
function CalibrationTable({ buckets }: { buckets: CalibrationBucket[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("min")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else { setSortKey(key); setSortDir("asc") }
  }

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="inline w-3 h-3 ml-0.5 opacity-40" />
    return sortDir === "asc"
      ? <ArrowUp className="inline w-3 h-3 ml-0.5 text-primary" />
      : <ArrowDown className="inline w-3 h-3 ml-0.5 text-primary" />
  }

  // Best-tier: qualified bucket with lowest calibration error
  const bestLabel = useMemo(() => {
    const qualified = buckets.filter((b) => b.n >= CALIBRATION_BEST_TIER_MIN && b.calibrationError !== null)
    if (qualified.length === 0) return null
    return qualified.reduce((best, b) => (b.calibrationError! < best.calibrationError! ? b : best)).label
  }, [buckets])

  const sorted = useMemo(() => {
    return [...buckets].sort((a, b) => {
      const av = a[sortKey] ?? (sortDir === "asc" ? Infinity : -Infinity)
      const bv = b[sortKey] ?? (sortDir === "asc" ? Infinity : -Infinity)
      return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
  }, [buckets, sortKey, sortDir])

  if (buckets.length === 0) return <SectionError message="No calibration data yet." />

  const ThBtn = ({ col, label, right = false }: { col: SortKey; label: string; right?: boolean }) => (
    <th className={`px-3 sm:px-4 py-3 ${right ? "text-right" : ""}`}>
      <button
        onClick={() => handleSort(col)}
        className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors cursor-pointer"
      >
        {label}<SortIcon col={col} />
      </button>
    </th>
  )

  return (
    <div className="space-y-3">
      {/* Bar chart above the table */}
      <CalibrationChart buckets={buckets} />

      <div className="overflow-x-auto rounded-xl border border-border/50">
        <table className="w-full min-w-[580px] text-sm">
          <thead className="bg-secondary/20">
            <tr className="text-left text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase border-b border-border/50">
              <ThBtn col="min"              label="Prediction Range" />
              <ThBtn col="n"               label="Sample"           right />
              <ThBtn col="avgPredicted"    label="Predicted %"      right />
              <ThBtn col="observedAccuracy" label="Actual Win %"    right />
              <ThBtn col="calibrationError" label="Error"           right />
              <th className="px-3 sm:px-4 py-3">Rating</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {sorted.map((b) => {
              const isBest = b.label === bestLabel
              const lowSample = b.n < CALIBRATION_BEST_TIER_MIN
              const rating = getCalibrationRating(lowSample ? null : b.calibrationError)

              if (lowSample) {
                return (
                  <tr key={b.label} className="opacity-40">
                    <td className="px-3 sm:px-4 py-3 font-mono font-bold">{b.label}</td>
                    <td className="px-3 sm:px-4 py-3 font-mono text-right text-muted-foreground">n={b.n}</td>
                    <td colSpan={3} className="px-3 sm:px-4 py-3 text-center text-muted-foreground font-mono text-xs">—</td>
                    <td className="px-3 sm:px-4 py-3">
                      <Badge variant="outline" className="font-mono text-[9px]">Low Sample</Badge>
                    </td>
                  </tr>
                )
              }

              return (
                <tr
                  key={b.label}
                  className={`hover:bg-secondary/20 transition-colors ${isBest ? "ring-1 ring-inset ring-amber-400/40 bg-amber-400/5" : ""}`}
                >
                  <td className="px-3 sm:px-4 py-3 font-mono font-bold">
                    {b.label}
                    {isBest && (
                      <span className="ml-1.5 text-[9px] font-mono text-amber-500 font-bold">🏆 BEST</span>
                    )}
                  </td>
                  <td className="px-3 sm:px-4 py-3 font-mono text-right text-muted-foreground">
                    {b.n.toLocaleString()}
                  </td>
                  <td className="px-3 sm:px-4 py-3 font-mono text-right">
                    {b.avgPredicted !== null ? `${b.avgPredicted.toFixed(1)}%` : "—"}
                  </td>
                  <td className={`px-3 sm:px-4 py-3 font-mono font-bold text-right ${accuracyColor(b.observedAccuracy)}`}>
                    {b.observedAccuracy !== null ? `${b.observedAccuracy.toFixed(1)}%` : "—"}
                  </td>
                  <td className={`px-3 sm:px-4 py-3 font-mono text-right ${
                    b.calibrationError !== null && b.calibrationError < 2 ? "text-success"
                    : b.calibrationError !== null && b.calibrationError >= 8 ? "text-destructive"
                    : b.calibrationError !== null && b.calibrationError >= 4 ? "text-warning"
                    : "text-muted-foreground"
                  }`}>
                    {b.calibrationError !== null ? `${b.calibrationError.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-3 sm:px-4 py-3">
                    <Badge
                      variant={rating.variant}
                      className="font-mono text-[9px] tracking-wide whitespace-nowrap gap-1"
                    >
                      {rating.emoji} {rating.label}
                    </Badge>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] font-mono text-muted-foreground/60 leading-relaxed">
        Buckets use 5% bands (50–55%, 55–60%, …, 95–100%). Rows with n&lt;{CALIBRATION_BEST_TIER_MIN} are dimmed and excluded from Best Tier.
        Click column headers to sort. "Error" = |stated probability − actual win rate| — lower is better.
        A calibration refit (scheduled periodically) adjusts stated probabilities toward real outcomes without changing pick direction.
      </p>
    </div>
  )
}

// ─── Surface cards ────────────────────────────────────────────────────────────
function SurfaceCards({ rows }: { rows: SurfaceRow[] }) {
  if (rows.length === 0) return <SectionError message="No surface data yet." />
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4">
      {rows.map((r) => {
        const hasEnough = r.n >= MINIMUM_SAMPLE
        return (
          <div key={r.surface} className={`p-4 sm:p-5 bg-background rounded-2xl border border-border shadow-sm space-y-2 sm:space-y-3 transition-opacity ${!hasEnough ? "opacity-50" : ""}`}>
            <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">{r.surface}</p>
            <p className={`text-2xl sm:text-3xl font-display font-bold tabular-nums ${hasEnough ? accuracyColor(r.accuracy) : "text-muted-foreground"}`}>
              {hasEnough ? fmt(r.accuracy) : "—"}
            </p>
            <div className="space-y-1 text-[10px] sm:text-[11px] font-mono text-muted-foreground">
              <div>n = <span className={hasEnough ? "text-foreground" : ""}>{r.n}</span>{!hasEnough && <span className="ml-1 opacity-60">(min {MINIMUM_SAMPLE})</span>}</div>
              {hasEnough && r.avgConfidence !== null && <div>Avg conf: <span className="text-foreground">{r.avgConfidence}%</span></div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Generic breakdown table ─────────────────────────────────────────────────
function BreakdownTable({
  rows, columns, minSample = MINIMUM_SAMPLE,
}: {
  rows: Array<Record<string, unknown>>
  columns: Array<{ key: string; label: string; render?: (v: unknown, row: Record<string, unknown>) => React.ReactNode }>
  minSample?: number
}) {
  if (rows.length === 0) return <SectionError message="No data available yet." />

  const qualified = rows.filter((r) => {
    const n = r.n as number | undefined
    return typeof n !== "number" || n >= minSample
  })
  const lowSample = rows.filter((r) => {
    const n = r.n as number | undefined
    return typeof n === "number" && n < minSample
  })

  if (qualified.length === 0) {
    return <SectionError message={`No segments with ≥${minSample} graded samples yet. (${rows.length} segment${rows.length !== 1 ? "s" : ""} below threshold)`} />
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-border/50">
        <table className="w-full min-w-[320px] text-sm">
          <thead className="bg-secondary/20">
            <tr className="text-left text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase border-b border-border/50">
              {columns.map((c) => (
                <th key={c.key} className="px-3 sm:px-4 py-3">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {qualified.map((row, i) => (
              <tr key={i} className="hover:bg-secondary/20 transition-colors">
                {columns.map((c) => (
                  <td key={c.key} className="px-3 sm:px-4 py-3 font-mono">
                    {c.render ? c.render(row[c.key], row) : String(row[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lowSample.length > 0 && (
        <p className="text-[10px] font-mono text-muted-foreground/50">
          {lowSample.length} segment{lowSample.length !== 1 ? "s" : ""} hidden — fewer than {minSample} graded predictions.
        </p>
      )}
    </div>
  )
}

// ─── Expandable improvement card ─────────────────────────────────────────────
function ImprovementCard({ item }: { item: ModelImprovement }) {
  const [expanded, setExpanded] = useState(false)
  const statusVariant = item.monitoringStatus === "Validated" ? "success" : "warning"
  return (
    <div className="border border-border/50 bg-background rounded-xl p-4 shadow-sm space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <Badge variant="outline" className="font-mono text-[9px] tracking-widest">{item.area.toUpperCase()}</Badge>
            <Badge variant={statusVariant} className="font-mono text-[9px] tracking-widest">{item.monitoringStatus.toUpperCase()}</Badge>
          </div>
          <p className="font-bold text-sm text-foreground">{item.title}</p>
          <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{fmtDate(item.date)}</p>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-1"
        >
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>
      {expanded && (
        <p className="text-sm text-muted-foreground leading-relaxed border-t border-border/40 pt-3">{item.explanation}</p>
      )}
    </div>
  )
}

// ─── How to read card ─────────────────────────────────────────────────────────
function HowToReadCard() {
  const [expanded, setExpanded] = useState(false)
  return (
    <Card className="border-primary/20">
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <CardTitle className="text-base font-display flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary" />
            How to Read This Dashboard
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4 text-sm text-muted-foreground leading-relaxed">
          <p><strong className="text-foreground">Accuracy</strong> — the percentage of graded predictions where the model correctly identified the winner. A baseline coin-flip would be ~50%. Human experts typically land in the 60–70% range on tour-level tennis.</p>
          <p><strong className="text-foreground">Log Loss & Brier Score</strong> — these measure how well-calibrated the confidence levels are, not just whether picks are right or wrong. A model that says "60%" when the player wins 60% of the time scores better than one that always says "90%". Lower is better for both.</p>
          <p><strong className="text-foreground">ECE (Expected Calibration Error)</strong> — the average gap between stated confidence and actual win rate across confidence bands. Below 0.03 is well-calibrated; above 0.05 means stated probabilities are meaningfully off.</p>
          <p><strong className="text-foreground">Calibration table</strong> — each row shows a confidence range. "Well Calibrated" means the model's stated probability matches how often it actually won. "Overconfident" means the model stated higher confidence than its actual accuracy.</p>
          <p><strong className="text-foreground">Rolling windows (7d / 30d / 90d)</strong> — short windows reflect recent form but have small samples. Longer windows are more statistically reliable but slower to react to real changes.</p>
          <p><strong className="text-foreground">Recommendation Performance</strong> — "High Confidence" are the engine's most selective picks. More predictions reach lower tiers. Accuracy differences across tiers show whether the confidence system is adding real value.</p>
          <p><strong className="text-foreground">Upset Risk Performance</strong> — shows the rate at which the model's favorite actually lost, per risk tier. If the system is working, this rate should rise from Low → Moderate → High → Extreme.</p>
          <p><strong className="text-foreground">Model Agreement</strong> — when multiple internal signals point to the same player, accuracy tends to be higher. "High Disagreement" rows are where signals conflict, and accuracy typically drops.</p>
        </CardContent>
      )}
    </Card>
  )
}

// ─── Section wrapper ─────────────────────────────────────────────────────────
function Section({
  icon, title, subtitle, children,
}: {
  icon: React.ReactNode; title: string; subtitle?: string; children: React.ReactNode
}) {
  return (
    <Card className="glass-panel">
      <CardHeader className="border-b border-border/50 bg-secondary/20 p-6 md:p-8">
        <CardTitle className="text-xl font-display flex items-start gap-3">
          <div className="p-2 bg-primary/10 rounded-lg mt-0.5 shrink-0">{icon}</div>
          <div>
            {title}
            {subtitle && <p className="text-sm text-muted-foreground font-sans font-normal mt-1 leading-relaxed">{subtitle}</p>}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 md:p-8">{children}</CardContent>
    </Card>
  )
}

// ─── Elite gate wrapper ───────────────────────────────────────────────────────
function EliteSection({
  icon, title, subtitle, isElite, lockTitle, lockDescription, children,
}: {
  icon: React.ReactNode; title: string; subtitle?: string
  isElite: boolean; lockTitle: string; lockDescription: string
  children: React.ReactNode
}) {
  return (
    <Section icon={icon} title={title} subtitle={subtitle}>
      {isElite ? children : (
        <EliteLockedSection title={lockTitle} description={lockDescription} />
      )}
    </Section>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────
export default function ModelMonitoringPage() {
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useDashboard()

  // Derive tier from dashboard response (backend injects it from entitlement state)
  const tier = data?.tier ?? "free"
  const isElite = tier === "elite" || tier === "elite_annual"
  const isPro = tier === "pro" || isElite // pro sees pro-level sections

  const lastRefreshed = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null

  return (
    <div className="space-y-6 sm:space-y-8 animate-in fade-in duration-500 w-full overflow-x-hidden">
      {/* Page header */}
      <div className="border-b border-border/50 pb-5">
        <div className="flex items-start gap-2 sm:gap-3 mb-2">
          <div className="p-2 bg-primary/10 rounded-lg shrink-0 mt-0.5">
            <Monitor className="w-4 h-4 sm:w-5 sm:h-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center flex-wrap gap-2">
              <h1 className="text-2xl sm:text-4xl font-display font-bold tracking-tight">Model Monitoring</h1>
              {isElite && (
                <Badge variant="success" className="font-mono text-[10px] tracking-widest gap-1">
                  <Crown className="w-3 h-3" /> ELITE
                </Badge>
              )}
              {isPro && !isElite && (
                <Badge variant="outline" className="font-mono text-[10px] tracking-widest">PRO</Badge>
              )}
            </div>
          </div>
          {/* Refresh control */}
          <div className="shrink-0 flex flex-col items-end gap-1">
            <Button
              variant="outline" size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="h-8 px-3 gap-1.5 font-mono text-xs"
            >
              <RefreshCw className={`w-3 h-3 ${isFetching ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            {lastRefreshed && (
              <span className="text-[9px] font-mono text-muted-foreground/60">{lastRefreshed}</span>
            )}
          </div>
        </div>
        <p className="text-sm sm:text-base text-muted-foreground leading-relaxed pl-9 sm:pl-11">
          Live health, reliability, and accuracy of Tennis Matrix AI. Auto-refreshes every 12 hours.
        </p>
        {isPro && !isElite && (
          <p className="text-xs text-muted-foreground/70 mt-1.5 flex items-center gap-1.5 font-mono pl-9 sm:pl-11">
            <Lock className="w-3 h-3 shrink-0" />
            Upgrade to Elite to unlock calibration, recommendation performance &amp; model history.
          </p>
        )}
      </div>

      {/* Global error */}
      {isError && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-6 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0" />
            <div>
              <p className="font-bold text-destructive">Unable to load monitoring data</p>
              <p className="text-sm text-muted-foreground mt-1">{error?.message ?? "Please try refreshing the page."}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Overall Status — always visible */}
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data ? (
        <StatusCard status={data.status} />
      ) : null}

      {/* Confidence Calibration — front and centre, Elite only */}
      <Section
        icon={<Zap className="w-5 h-5 text-primary" />}
        title="Confidence Calibration"
        subtitle="Projected win % vs actual win rate per confidence band — shows exactly which probability ranges the model has earned the most trust in."
      >
        {!isElite ? (
          <EliteLockedSection title="Confidence Calibration" description="See how well the AI's stated probabilities match real outcomes across every confidence band. Available on Elite." />
        ) : isLoading ? <SectionSkeleton rows={6} /> : data ? <CalibrationTable buckets={data.calibration} /> : null}
      </Section>

      {/* Performance Summary — Pro + Elite */}
      <Section
        icon={<BarChart3 className="w-5 h-5 text-primary" />}
        title="Performance Summary"
        subtitle="Overall accuracy, calibration quality, and recent prediction windows. Scoped to live and paper-traded predictions only — never training data."
      >
        {isLoading ? <SectionSkeleton rows={2} /> : data ? <PerformanceSummary p={data.performance} /> : null}
      </Section>

      {/* Accuracy Trend — Pro + Elite */}
      <Section
        icon={<Activity className="w-5 h-5 text-primary" />}
        title="Accuracy Trend"
        subtitle="Day-by-day accuracy across graded live predictions. Days with fewer than 3 graded predictions are excluded to avoid single-match noise."
      >
        <AccuracyTrendChart />
      </Section>

      {/* Surface & Level — Pro + Elite */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
        <Section icon={<TrendingUp className="w-5 h-5 text-primary" />} title="Accuracy by Surface">
          {isLoading ? <SectionSkeleton rows={2} /> : data ? <SurfaceCards rows={data.bySurface} /> : null}
        </Section>
        <Section icon={<Layers className="w-5 h-5 text-primary" />} title="Accuracy by Competition Level">
          {isLoading ? <SectionSkeleton rows={4} /> : data ? (
            <BreakdownTable
              rows={data.byLevel as unknown as Array<Record<string, unknown>>}
              columns={[
                { key: "level", label: "Level" },
                {
                  key: "accuracy", label: "Accuracy",
                  render: (v) => <span className={`font-bold ${accuracyColor(v as number | null)}`}>{fmt(v as number | null)}</span>
                },
                { key: "n", label: "Sample", render: (v) => <span className="text-muted-foreground">n={String(v)}</span> },
              ]}
            />
          ) : null}
        </Section>
      </div>

      {/* Recommendation Performance — Elite only */}
      <Section
        icon={<Shield className="w-5 h-5 text-primary" />}
        title="Recommendation Performance"
        subtitle="Accuracy by confidence tier. High Confidence is the engine's most selective tier."
      >
        {!isElite ? (
          <EliteLockedSection title="Recommendation Performance" description="Track how well each confidence tier (High Confidence, Moderate Lean, etc.) performs over real graded predictions. Available on Elite." />
        ) : isLoading ? <SectionSkeleton rows={5} /> : data ? (
          <BreakdownTable
            rows={data.byRecommendation.map((r) => ({ ...r, label: REC_LABEL[r.recommendation] ?? r.recommendation })) as unknown as Array<Record<string, unknown>>}
            columns={[
              { key: "label", label: "Tier", render: (v) => <span className="font-bold">{String(v)}</span> },
              {
                key: "accuracy", label: "Accuracy",
                render: (v) => <span className={`font-bold ${accuracyColor(v as number | null)}`}>{fmt(v as number | null)}</span>
              },
              { key: "n", label: "Sample", render: (v) => <span className="text-muted-foreground">n={String(v)}</span> },
            ]}
          />
        ) : null}
      </Section>

      {/* Upset Risk & Model Agreement — Pro + Elite */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
        <Section
          icon={<AlertTriangle className="w-5 h-5 text-primary" />}
          title="Upset Risk Performance"
          subtitle="Rate at which the model's pick actually lost, per risk tier. Should rise Low → Extreme."
        >
          {isLoading ? <SectionSkeleton rows={4} /> : data ? (
            <BreakdownTable
              rows={data.byUpsetRisk as unknown as Array<Record<string, unknown>>}
              columns={[
                { key: "tier", label: "Risk Tier" },
                {
                  key: "favoriteLossRate", label: "Favorite Lost",
                  render: (v) => <span className={`font-bold ${v !== null && (v as number) > 30 ? "text-destructive" : "text-foreground"}`}>{fmt(v as number | null)}</span>
                },
                { key: "n", label: "Sample", render: (v) => <span className="text-muted-foreground">n={String(v)}</span> },
              ]}
            />
          ) : null}
        </Section>

        <Section
          icon={<Activity className="w-5 h-5 text-primary" />}
          title="Model Agreement"
          subtitle="When all internal signals agree, accuracy tends to be higher."
        >
          {isLoading ? <SectionSkeleton rows={4} /> : data ? (
            <BreakdownTable
              rows={data.byAgreement.map((r) => ({ ...r, label: AGREEMENT_LABEL[r.tier] ?? r.tier })) as unknown as Array<Record<string, unknown>>}
              columns={[
                { key: "label", label: "Agreement Level", render: (v) => <span className="font-bold">{String(v)}</span> },
                {
                  key: "accuracy", label: "Accuracy",
                  render: (v) => <span className={`font-bold ${accuracyColor(v as number | null)}`}>{fmt(v as number | null)}</span>
                },
                { key: "n", label: "Sample", render: (v) => <span className="text-muted-foreground">n={String(v)}</span> },
              ]}
            />
          ) : null}
        </Section>
      </div>

      {/* Data Quality — Pro + Elite */}
      <Section
        icon={<Shield className="w-5 h-5 text-primary" />}
        title="Data Quality"
        subtitle="Distribution of data quality scores across recent predictions."
      >
        {isLoading ? <SectionSkeleton rows={2} /> : data ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard label="Avg Quality Score" value={data.dataQuality.avgScore !== null ? `${data.dataQuality.avgScore}%` : "—"} />
              <MetricCard label="High Quality" value={data.dataQuality.total > 0 ? `${Math.round(data.dataQuality.highCount / data.dataQuality.total * 100)}%` : "—"}
                sub={`${data.dataQuality.highCount} predictions`} highlight="text-success" />
              <MetricCard label="Medium Quality" value={data.dataQuality.total > 0 ? `${Math.round(data.dataQuality.medCount / data.dataQuality.total * 100)}%` : "—"}
                sub={`${data.dataQuality.medCount} predictions`} highlight="text-warning" />
              <MetricCard label="Low Quality" value={data.dataQuality.total > 0 ? `${Math.round(data.dataQuality.lowCount / data.dataQuality.total * 100)}%` : "—"}
                sub={`${data.dataQuality.lowCount} predictions`} highlight="text-destructive" />
            </div>
            <p className="text-xs font-mono text-muted-foreground/70">
              High = ≥65% · Medium = 45–65% · Low = &lt;45%. Predictions with lower data quality carry wider uncertainty margins.
            </p>
          </div>
        ) : null}
      </Section>

      {/* Recent Model Improvements — Elite only */}
      <Section
        icon={<TrendingUp className="w-5 h-5 text-primary" />}
        title="Recent Model Improvements"
        subtitle="A log of validated changes made to improve accuracy and calibration."
      >
        {!isElite ? (
          <EliteLockedSection title="Model Improvements Log" description="Review every validated improvement made to the prediction engine — what changed, when, and whether it improved accuracy. Available on Elite." />
        ) : isLoading ? <SectionSkeleton rows={4} /> : data ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {data.improvements.map((item) => <ImprovementCard key={item.title} item={item} />)}
          </div>
        ) : null}
      </Section>

      {/* Model Version History — Elite only */}
      <Section
        icon={<Layers className="w-5 h-5 text-primary" />}
        title="Model Version History"
        subtitle="Current and previous versions of the prediction engine."
      >
        {!isElite ? (
          <EliteLockedSection title="Model Version History" description="See which model version is currently running and the full history of deployed engine versions. Available on Elite." />
        ) : isLoading ? <SectionSkeleton rows={2} /> : data ? (
          <div className="space-y-4">
            {data.versionHistory.map((v) => (
              <div key={v.version} className="border border-border/50 bg-background rounded-xl p-5 shadow-sm space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-display font-bold text-lg text-foreground">{v.version}</span>
                  <Badge variant={v.status === "Current" ? "success" : "secondary"} className="font-mono text-[9px] tracking-widest">{v.status.toUpperCase()}</Badge>
                  <Badge variant={v.validationStatus === "Validated" ? "success" : "outline"} className="font-mono text-[9px] tracking-widest">{v.validationStatus.toUpperCase()}</Badge>
                  <span className="text-xs font-mono text-muted-foreground ml-auto">Deployed {fmtDate(v.deployedDate)}</span>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{v.notes}</p>
              </div>
            ))}
          </div>
        ) : null}
      </Section>

      {/* How to Read */}
      <HowToReadCard />
    </div>
  )
}
