import { useGetAdminAuthStatus, useGetPrediction, getGetPredictionQueryKey, useRecordPredictionOutcome } from "@workspace/api-client-react"
import { useParams, useSearch } from "wouter"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataWarning, EmptyDataState } from "@/components/DataWarning"
import { formatProbability } from "@/lib/utils"
import { asPercentage, asFraction, formatPercentage, fractionToPercentage, type Percentage } from "@/lib/percentage"
import { deriveMonteCarloHeadline } from "@/lib/monteCarloHeadline"
import { buildPredictionCopyText } from "@/lib/predictionCopyText"
import { getRecommendationLabel } from "@/lib/recommendationLabels"
import { Activity, ShieldAlert, CheckCircle2, XCircle, TrendingUp, AlertTriangle, ChevronRight, Dna, ActivitySquare, Database, Vote, Info, Dices, Crown, Scale, Zap, GitBranch, ChevronDown, Copy, Bookmark, BookmarkCheck, FolderOpen } from "lucide-react"
import { useState } from "react"
import { UPSET_RISK_LABEL, UPSET_RISK_SHORT, UPSET_RISK_TEXT_CLASS, upsetRiskBadgeClasses } from "@/lib/upsetRiskColors"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@clerk/react"

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
const api = (path: string) => `${BASE}${path}`

const UPSET_RISK_SHORT_LABEL = UPSET_RISK_SHORT
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts"

const AGREEMENT_STYLES: Record<string, string> = {
  Strong: "text-success",
  Moderate: "text-foreground",
  Mixed: "text-warning",
  HighDisagreement: "text-destructive",
}

const CLOSENESS_LABELS: Record<string, string> = {
  VeryClose: "Very close to a coin flip",
  Close: "Close matchup",
  Moderate: "Moderate lean",
  Clear: "Clear favorite",
}

const MODEL_NAME_LABELS: Record<string, string> = {
  "Surface Elo": "Surface Elo",
  "Serve & Return": "Serve & Return",
  "Recent Form": "Recent Form",
  "Fatigue Index": "Fatigue, Rest & Match Load",
  "Head-to-Head": "Head-to-Head",
  "Style Matchup": "Style Matchup",
  "Availability": "Availability / Injury",
  "Court Speed": "Court Speed",
  "Weather": "Weather",
  "Tour Adjustment": "Tour-Level Adjustment",
  "Segment Specialist": "Specialist Model",
  "Monte Carlo": "Monte Carlo",
  "Calibrated Ensemble": "Calibrated Ensemble",
}

function toVisibleModelName(name: string): string {
  const exact = MODEL_NAME_LABELS[name]
  if (exact) return exact
  if (name.includes("Surface Elo")) return "Surface Elo"
  if (name.includes("Serve") || name.includes("Return")) return "Serve & Return"
  if (name.includes("Recent Form")) return "Recent Form"
  if (name.includes("Fatigue") || name.includes("Match Load") || name.includes("Recovery")) return "Fatigue, Rest & Match Load"
  if (name.includes("Head")) return "Head-to-Head"
  if (name.includes("Style")) return "Style Matchup"
  if (name.includes("Availability") || name.includes("Injury")) return "Availability / Injury"
  if (name.includes("Weather")) return "Weather"
  if (name.includes("Specialist")) return "Specialist Model"
  if (name.includes("Monte")) return "Monte Carlo"
  if (name.includes("Ensemble") || name.includes("Calibrat")) return "Calibrated Ensemble"
  return name
}

const COMPANY_NAME = "Tennis Matrix Ai"

function EdgeBar({ p1Value, p2Value, p1Name, p2Name, label }: { p1Value: number, p2Value: number, p1Name: string, p2Name: string, label: string }) {
  const total = p1Value + p2Value;
  const p1Pct = total > 0 ? (p1Value / total) * 100 : 50;

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-[11px] font-mono font-bold tracking-widest uppercase">
        <span className="text-primary truncate max-w-[40%] flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block"></span>
          {p1Name} <span className="text-primary/70 tabular-nums ml-1">({p1Value.toFixed(0)})</span>
        </span>
        <span className="text-muted-foreground/60">{label}</span>
        <span className="text-foreground truncate max-w-[40%] text-right flex items-center justify-end gap-1.5">
          <span className="text-muted-foreground tabular-nums mr-1">({p2Value.toFixed(0)})</span> {p2Name}
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground inline-block"></span>
        </span>
      </div>
      <div className="h-4 w-full bg-background border border-border shadow-inner rounded-full overflow-hidden flex">
        <div className="h-full bg-primary transition-all duration-1000 ease-out relative" style={{ width: `${p1Pct}%` }}>
          <div className="absolute inset-0 bg-white/10 w-full h-full"></div>
        </div>
        <div className="h-full bg-muted-foreground/20 transition-all duration-1000 ease-out" style={{ width: `${100 - p1Pct}%` }} />
      </div>
    </div>
  )
}

function ModuleCard({ title, reliability, children, icon: Icon, reliabilityLabel = "REL" }: { title: string, reliability: Percentage, children: React.ReactNode, icon: any, reliabilityLabel?: string }) {
  return (
    <Card className="overflow-hidden flex flex-col h-full hover-lift">
      <div className="bg-secondary/40 p-4 border-b border-border/50 flex justify-between items-center">
        <div className="flex items-center gap-2.5 font-bold font-display text-sm tracking-wide">
          <div className="p-1.5 bg-background rounded-md shadow-sm border border-border/50">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          {title}
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono font-bold tracking-widest uppercase bg-background px-2.5 py-1 rounded-full border border-border/50 shadow-sm">
          <span className="text-muted-foreground">{reliabilityLabel}:</span>
          <span className={reliability < 50 ? "text-warning" : reliability >= 80 ? "text-success" : "text-foreground"}>
            {formatPercentage(reliability)}
          </span>
        </div>
      </div>
      <CardContent className="p-5 sm:p-6 flex-1 flex flex-col gap-5">
        {children}
      </CardContent>
    </Card>
  )
}

export default function PredictionResultPage() {
  const params = useParams()
  const id = parseInt(params.id || "0", 10)
  const searchString = useSearch()
  // forceSignal=true: show a directional pick even when tieBreakerApplied, because the user
  // explicitly requested a forced call (e.g. arrived via the Force Signal page).
  const forceSignal = new URLSearchParams(searchString).get("forceSignal") === "true"
  
  const { data: prediction, isLoading, isError } = useGetPrediction(id, {
    query: { queryKey: getGetPredictionQueryKey(id), enabled: !!id }
  })
  const { data: adminAuth } = useGetAdminAuthStatus()
  const { toast } = useToast()
  const { isSignedIn } = useAuth()
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const recordOutcome = useRecordPredictionOutcome()

  if (isLoading) {
    return (
      <div className="space-y-8 animate-pulse">
        <div className="h-32 bg-muted rounded-lg" />
        <div className="h-[600px] bg-muted rounded-lg" />
      </div>
    )
  }

  if (isError || !prediction) {
    return <EmptyDataState message="Prediction not found or provider unavailable." />
  }

  const engine = prediction.engine;

  // When tieBreakerApplied=true, the banner must display the RAW ensemble probability that
  // triggered the disclosure — not calibratedProbability, which can land at extreme values
  // (e.g. 100%/0%) after calibration, specialist-blending, and simulator-blending run *after*
  // the tie-breaker check. Showing calibratedProbability inside a "Too Close to Call" banner
  // directly contradicts the banner's own text ("The raw ensemble probability is shown").
  //
  // Semantic choice (Option b): tieBreakerApplied is anchored to the raw ensemble. If
  // calibration subsequently resolves the signal strongly, the UI still surfaces the raw
  // ensemble in the banner — the ensemble was genuinely a coin flip regardless of what
  // calibration did after. calibratedProbability remains the authoritative stored value and is
  // used everywhere outside the "Too Close to Call" hero.
  //
  // rawEnsembleProbability is a proper typed API field populated by the GET /predictions/:id
  // route from decisionTrace.pipeline.rawEnsemble. Null for legacy predictions that predate the
  // decisionTrace field — fallback to calibratedProbability in that case (banner still shows
  // something coherent, just not the ideal raw value).
  const rawEnsemble: number = prediction.rawEnsembleProbability ?? prediction.calibratedProbability;

  const isResolved = !!prediction.actualWinnerId;
  const isCorrect = prediction.actualWinnerId === prediction.predictedWinnerId;
  // Auth status represents the single owner session cookie, so this stays owner-only.
  const isOwnerSession = adminAuth?.authenticated === true
  const canCopy = isOwnerSession

  const handleSaveCard = async () => {
    if (!prediction || saving) return
    setSaving(true)
    try {
      const res = await fetch(api("/api/saved-cards"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ predictionId: prediction.id }),
      })
      if (res.ok) {
        const data = await res.json() as { alreadySaved?: boolean }
        setSaved(true)
        toast({ title: data.alreadySaved ? "Already in your Cards folder" : "✅ Saved to Cards folder" })
      } else {
        toast({ title: "Could not save — try again", variant: "destructive" })
      }
    } catch {
      toast({ title: "Network error — try again", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const handleCopyPrediction = async () => {
    const text = buildPredictionCopyText(prediction)
    try {
      await navigator.clipboard.writeText(text)
      toast({ title: "✅ Prediction copied!" })
      return
    } catch {
      // Fallback for older/blocked clipboard contexts.
      const textarea = document.createElement("textarea")
      textarea.value = text
      textarea.style.position = "fixed"
      textarea.style.left = "-9999px"
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      document.execCommand("copy")
      document.body.removeChild(textarea)
      toast({ title: "✅ Prediction copied!" })
    }
  }

  return (
    <div className="space-y-12 animate-in fade-in duration-500 max-w-6xl mx-auto pb-24">
      <div className="pt-2">
        <p className="text-center text-sm sm:text-base font-display font-bold tracking-[0.18em] uppercase text-primary">
          {COMPANY_NAME}
        </p>
      </div>

      {/* HEADER MATCHUP */}
      <div className="flex flex-col md:flex-row gap-6 items-center justify-between border-b border-border/50 pb-6">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm font-mono text-muted-foreground">
          <Badge variant="secondary" className="uppercase bg-secondary/50 border shadow-sm">{prediction.surface}</Badge>
          <span className="uppercase tracking-widest">{prediction.matchFormat}</span>
          {prediction.tournamentLevel && <Badge variant="outline" className="uppercase bg-background shadow-sm">{prediction.tournamentLevel}</Badge>}
        </div>
        {isResolved && (
          <Badge variant={isCorrect ? "success" : "destructive"} className="text-sm px-4 py-1.5 shadow-md">
            {isCorrect ? <><CheckCircle2 className="w-4 h-4 mr-1.5" /> PREDICTION CORRECT</> : <><XCircle className="w-4 h-4 mr-1.5" /> PREDICTION INCORRECT</>}
          </Badge>
        )}
      </div>

      {/* COMPACT SUMMARY HERO */}
      <Card className="border border-primary/20 overflow-hidden relative shadow-xl glass-panel">
        {/* Top-left: Save to Cards folder — shown for signed-in users and admin sessions */}
        {(isSignedIn || isOwnerSession) && (
          <div className="absolute top-3 left-3 z-20">
            <Button
              variant="outline"
              size="sm"
              className={`h-8 px-3 text-xs font-mono gap-1.5 bg-background/95 transition-all ${
                saved
                  ? "border-success/60 text-success bg-success/10"
                  : "border-primary/30 text-primary hover:border-primary hover:bg-primary/10"
              }`}
              onClick={handleSaveCard}
              disabled={saving}
              title="Save to your Cards folder"
            >
              {saving ? (
                <Bookmark className="w-3.5 h-3.5 animate-pulse" />
              ) : saved ? (
                <BookmarkCheck className="w-3.5 h-3.5" />
              ) : (
                <FolderOpen className="w-3.5 h-3.5" />
              )}
              {saved ? "SAVED" : "SAVE"}
            </Button>
          </div>
        )}
        {/* Top-right: admin copy button */}
        <div className="absolute top-3 right-3 z-20 flex gap-2">
          {canCopy && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2.5 text-xs font-mono gap-1.5 bg-background/95"
              onClick={handleCopyPrediction}
              title="Copy social summary"
            >
              <Copy className="w-3.5 h-3.5" />
              📋 Copy
            </Button>
          )}
        </div>
        <div className="absolute right-0 top-0 w-96 h-96 bg-primary/10 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />
        <div className="absolute left-0 bottom-0 w-64 h-64 bg-accent/5 rounded-full blur-3xl -ml-20 -mb-20 pointer-events-none" />
        
        <CardContent className="p-8 md:p-12 relative z-10">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
            
            <div className="space-y-8">
              {engine.tieBreakerApplied && !forceSignal ? (
                /* ── TOO CLOSE TO CALL hero ─────────────────────────────────── */
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Scale className="w-5 h-5 text-muted-foreground" />
                    <p className="text-xs font-mono font-bold text-muted-foreground tracking-widest uppercase">Too Close to Call</p>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-baseline gap-3">
                      <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight text-foreground break-words leading-tight">
                        {prediction.player1Name}
                      </h2>
                      <span className="text-lg font-mono text-muted-foreground tabular-nums">{rawEnsemble.toFixed(1)}%</span>
                    </div>
                    <div className="text-muted-foreground font-mono text-xs tracking-widest uppercase px-1">vs</div>
                    <div className="flex items-baseline gap-3">
                      <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight text-foreground break-words leading-tight">
                        {prediction.player2Name}
                      </h2>
                      <span className="text-lg font-mono text-muted-foreground tabular-nums">{(100 - rawEnsemble).toFixed(1)}%</span>
                    </div>
                  </div>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <Badge variant="outline" className="text-sm px-3 py-1.5 font-bold shadow-md gap-1.5">
                      <Scale className="w-3.5 h-3.5" /> NO STRONG SIGNAL
                    </Badge>
                    <Badge variant="outline" className="text-sm px-3 py-1.5 bg-background shadow-sm">
                      SET SCORE: {prediction.predictedSetScore}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-4 max-w-md leading-relaxed font-mono">
                    The core models are within {engine.tieBreakerApplied ? "3" : "—"}% of a coin flip. No validated signal provides a reliable directional edge in this probability range — previously, forcing a winner here performed at or below chance. The raw ensemble probability is shown for both players; no pick is made.
                  </p>
                  {/* Task #36: explicit opt-in for a directional pick with a clear disclaimer */}
                  <div className="mt-5 border-t border-border/40 pt-4">
                    <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-2">
                      REQUEST A DIRECTIONAL PICK
                    </p>
                    <p className="text-xs text-muted-foreground/80 mb-3 leading-relaxed">
                      You can ask the engine to name a side anyway. Backtesting shows these calls perform at or below chance — treat it as a coin-flip nudge, not a confident recommendation.
                    </p>
                    <a href={`/predictions/${id}?forceSignal=true`}>
                      <Button variant="outline" size="sm" className="font-mono text-xs shadow-sm gap-1.5">
                        <Zap className="w-3.5 h-3.5" />
                        FORCE A DIRECTIONAL PICK
                      </Button>
                    </a>
                  </div>
                </div>
              ) : (
                /* ── Normal predicted winner hero ───────────────────────────── */
                <div>
                  <p className="text-xs font-mono font-bold text-muted-foreground mb-3 tracking-widest uppercase">PREDICTED WINNER</p>
                  <h2 className="text-5xl md:text-7xl font-display font-bold tracking-tight text-primary break-words leading-[1.05]">
                    {prediction.predictedWinnerName}
                  </h2>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <Badge
                      variant={
                        // v2 tiers (current engine output)
                        prediction.recommendation === 'HIGHEST_CONFIDENCE' ? 'success' :
                        prediction.recommendation === 'HIGH_CONFIDENCE'    ? 'success' :
                        prediction.recommendation === 'MODERATE_CONFIDENCE' ? 'secondary' :
                        prediction.recommendation === 'LOW_CONFIDENCE'     ? 'warning' :
                        prediction.recommendation === 'INSUFFICIENT_EDGE'  ? 'outline' :
                        // Legacy tiers (stored in older prediction rows)
                        prediction.recommendation === 'STRONG_RECOMMENDATION' ? 'success' :
                        prediction.recommendation === 'MODERATE_LEAN'     ? 'secondary' :
                        prediction.recommendation === 'HIGH_RISK'          ? 'warning' :
                        prediction.recommendation === 'NO_STRONG_SIGNAL'  ? 'outline' :
                        prediction.recommendation === 'DO_NOT_RECOMMEND'  ? 'destructive' :
                        'outline' // safe fallback — unknown label stays neutral, not red
                      }
                      className={`text-sm px-3 py-1.5 font-bold shadow-md${
                        prediction.recommendation === 'INSUFFICIENT_EDGE'
                          ? ' text-muted-foreground border-muted-foreground/30'
                          : ''
                      }`}
                      title={
                        prediction.recommendation === 'HIGHEST_CONFIDENCE'
                          ? "All three core signals (Surface Elo, Serve & Return, Recent Form) agree on the same player."
                          : prediction.recommendation === 'HIGH_CONFIDENCE'
                          ? "Strong directional agreement across the core engine signals."
                          : prediction.recommendation === 'INSUFFICIENT_EDGE'
                          ? "The pick is within ±3% of a coin flip — not enough edge to recommend confidently."
                          : prediction.recommendation === 'STRONG_RECOMMENDATION'
                          ? "The engine's highest-confidence legacy tier — validate against more recent outputs."
                          : undefined
                      }
                    >
                      {getRecommendationLabel(prediction.recommendation)}
                    </Badge>
                    {engine.isEliteTier && (
                      <Badge
                        variant="success"
                        className="text-sm px-3 py-1.5 font-bold gap-1.5 shadow-md bg-primary/10 text-primary border-primary/30"
                        title="Meets every one of the engine's strictest gates at once. Still an early, small-sample tier -- not yet statistically proven to outperform non-Elite predictions."
                      >
                        <Crown className="w-4 h-4" /> ELITE TIER
                      </Badge>
                    )}
                    {/* Cross-Engine Agreement badge — always visible, never silently absent */}
                    {"crossEngineAgreement" in prediction && (
                      prediction.crossEngineAgreement === true ? (
                        <Badge
                          variant="outline"
                          className="text-sm px-3 py-1.5 font-bold gap-1.5 shadow-md border-success/40 bg-success/10 text-success"
                          title="The parlay builder independently validated this pick. Both the prediction engine and the builder's factor analysis support the same player."
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" /> MODEL AGREEMENT: YES
                        </Badge>
                      ) : prediction.crossEngineAgreement === false ? (
                        <Badge
                          variant="warning"
                          className="text-sm px-3 py-1.5 font-bold gap-1.5 shadow-md border-warning/50 bg-warning/10 text-warning"
                          title="The parlay builder found more evidence supporting the opponent. The underlying probability and grade are unchanged — this is an additional signal flag, not a correction."
                        >
                          <AlertTriangle className="w-3.5 h-3.5" /> MODEL AGREEMENT: NO
                        </Badge>
                      ) : prediction.crossEngineAgreement === null ? (
                        <Badge
                          variant="outline"
                          className="text-sm px-3 py-1.5 font-bold gap-1.5 shadow-sm text-muted-foreground border-muted/40"
                          title="The parlay builder did not have enough data to validate this pick. This is not a disagreement — it means coverage is insufficient for a builder decision."
                        >
                          MODEL AGREEMENT: UNKNOWN
                        </Badge>
                      ) : null
                    )}
                    <Badge variant="outline" className="text-sm px-3 py-1.5 bg-background shadow-sm">
                      SET SCORE: {prediction.predictedSetScore}
                    </Badge>
                    {engine.tieBreakerApplied && forceSignal && (
                      <Badge
                        variant="outline"
                        className="text-sm px-3 py-1.5 font-bold gap-1.5 shadow-md border-warning/40 bg-warning/10 text-warning"
                        title="This prediction was within 3% of a coin flip. Force Signal mode is active — the directional pick is shown at your request, but backtesting shows these calls perform at or below chance."
                      >
                        <Zap className="w-3.5 h-3.5" /> FORCED SIGNAL
                      </Badge>
                    )}
                  </div>
                  {engine.tieBreakerApplied && forceSignal && (
                    <p className="text-xs text-warning/80 mt-4 max-w-md leading-relaxed font-mono border border-warning/20 bg-warning/5 rounded-lg p-3">
                      Raw ensemble was within 3% of 50/50. Force Signal mode is active — this pick was forced at your request. Backtesting shows calls in this range perform at or below chance.
                    </p>
                  )}
                  {"crossEngineAgreement" in prediction && prediction.crossEngineAgreement === false && (
                    <p className="text-xs text-warning/80 mt-4 max-w-md leading-relaxed font-mono border border-warning/20 bg-warning/5 rounded-lg p-3">
                      <span className="font-bold">MODEL AGREEMENT: NO</span> — The parlay builder's factor analysis found more evidence supporting the opponent when validating this pick. The prediction engine's probability and grade are unchanged; this is a separate signal flag. Consider reducing position size or treating this as higher-risk.
                    </p>
                  )}
                  {prediction.recommendation === 'STRONG_RECOMMENDATION' && (
                    <p className="text-xs text-muted-foreground mt-4 max-w-md leading-relaxed font-mono">
                      "HIGH CONFIDENCE" marks the engine's own highest-confidence calls, based on today's thresholds --
                      validation on real outcomes is still early-stage, and this tier hasn't yet been shown to beat
                      other tiers. See the Accuracy Dashboard for current backtest sample counts.
                      Treat it as one input, not a proven edge.
                    </p>
                  )}
                  {engine.isEliteTier && (
                    <p className="text-xs text-muted-foreground mt-4 max-w-md leading-relaxed font-mono">
                      {engine.eliteTierReason ? `${engine.eliteTierReason} ` : ""}
                      Elite is an early, small-sample tier -- directionally promising but not yet statistically proven
                      to outperform non-Elite predictions. See the Accuracy Dashboard for current sample counts.
                    </p>
                  )}
                </div>
              )}

              {(!engine.tieBreakerApplied || forceSignal) && (
                <div className="space-y-3 bg-secondary/30 p-5 rounded-2xl border border-border/50">
                  <div className="flex justify-between font-mono text-sm items-center">
                    <span className="font-bold text-muted-foreground tracking-widest">WIN PROBABILITY</span>
                    <span className="font-bold text-xl tabular-nums">{formatProbability(asPercentage(prediction.predictedWinnerProbability))}</span>
                  </div>
                  <div className="h-4 w-full bg-background rounded-full overflow-hidden flex border border-border shadow-inner">
                    <div className="h-full bg-gradient-to-r from-primary to-accent transition-all duration-1000 ease-out" style={{ width: `${prediction.predictedWinnerProbability}%` }} />
                  </div>
                </div>
              )}

              {engine.tieBreakerApplied && !forceSignal && (
                <div className="space-y-3 bg-secondary/30 p-5 rounded-2xl border border-border/50">
                  <div className="flex justify-between font-mono text-sm items-center">
                    <span className="font-bold text-muted-foreground tracking-widest">RAW PROBABILITY SPLIT</span>
                    <span className="font-mono text-sm text-muted-foreground tabular-nums">{rawEnsemble.toFixed(1)} / {(100 - rawEnsemble).toFixed(1)}</span>
                  </div>
                  {/* Centred bar showing how close to 50/50 the split is — uses rawEnsemble,
                      the value that triggered the close-match disclosure, not calibratedProbability
                      (which can diverge significantly after calibration and blending). */}
                  <div className="h-4 w-full bg-background rounded-full overflow-hidden flex border border-border shadow-inner relative">
                    <div className="h-full bg-primary/40 transition-all duration-1000 ease-out" style={{ width: `${rawEnsemble}%` }} />
                    <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-border/80" />
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                    <span>{prediction.player1Name}</span>
                    <span>{prediction.player2Name}</span>
                  </div>
                </div>
              )}
            </div>{/* end left column */}

            <div className="space-y-6 md:pl-10 md:border-l border-border/50">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-5 bg-background rounded-2xl border border-border shadow-sm">
                  <p className="text-[10px] font-mono font-bold text-muted-foreground mb-2 tracking-widest uppercase">DATA QUALITY</p>
                  <p className="text-3xl font-display font-bold text-primary tabular-nums">{prediction.dataQuality}%</p>
                  <p className="text-xs mt-2 text-muted-foreground/80 leading-snug">{prediction.dataQualityLabel}</p>
                </div>
                <div className="p-5 bg-background rounded-2xl border border-border shadow-sm flex flex-col">
                  <p className="text-[10px] font-mono font-bold text-muted-foreground mb-2 tracking-widest uppercase">UPSET RISK</p>
                  <div className={`text-2xl font-display font-bold tabular-nums mb-2 ${UPSET_RISK_TEXT_CLASS[prediction.upsetRisk] ?? "text-accent"}`}>
                    {UPSET_RISK_SHORT_LABEL[prediction.upsetRisk] ?? prediction.upsetRisk}
                  </div>
                  <div className="mb-3 w-full box-border max-w-full">
                    <div className={upsetRiskBadgeClasses(prediction.upsetRisk)}>
                      {UPSET_RISK_LABEL[prediction.upsetRisk] ?? prediction.upsetRisk}
                    </div>
                  </div>
                  <p className="text-xs mt-auto text-muted-foreground/80 leading-snug">
                    {engine.upsetRiskBreakdown?.note ?? "Not available for predictions made before this breakdown existed."}
                  </p>
                </div>
              </div>

              {/* Task #35: plain-language pick explanation — show all engine reasons and risks */}
              {(engine.risks?.length || engine.reasons?.length || engine.disclosures?.length) ? (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">
                    WHY THIS PICK?
                  </p>
                  <div className="space-y-2.5 bg-secondary/30 p-4 rounded-xl border border-border/50">
                    {engine.reasons?.map((r, i) => (
                      <div key={i} className="flex gap-3 text-sm text-foreground/80">
                        <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
                        <span className="leading-snug">{r}</span>
                      </div>
                    ))}
                    {engine.risks?.map((r, i) => (
                      <div key={i} className="flex gap-3 text-sm text-foreground/80">
                        <ShieldAlert className="w-5 h-5 text-warning shrink-0 mt-0.5" />
                        <span className="leading-snug">{r}</span>
                      </div>
                    ))}
                    {engine.disclosures && engine.disclosures.length > 0 && (
                      <div className="border-t border-border/30 pt-2.5 mt-2 space-y-1.5">
                        {engine.disclosures.map((d, i) => (
                          <div key={i} className="flex gap-3 text-xs text-muted-foreground/80">
                            <Info className="w-4 h-4 text-muted-foreground/60 shrink-0 mt-0.5" />
                            <span className="leading-snug">{d}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {!isResolved && (
                <div className="pt-6 border-t border-border/50">
                  <p className="text-[10px] font-mono font-bold text-muted-foreground mb-3 tracking-widest uppercase">RECORD OUTCOME</p>
                  <div className="flex gap-3">
                    <Button 
                      variant="outline" 
                      className="flex-1 font-mono text-xs h-12 shadow-sm hover:border-primary hover:text-primary transition-colors"
                      disabled={recordOutcome.isPending}
                      onClick={() => recordOutcome.mutate({ predictionId: id, data: { actualWinnerId: prediction.player1Id } })}
                    >
                      {prediction.player1Name} WON
                    </Button>
                    <Button 
                      variant="outline" 
                      className="flex-1 font-mono text-xs h-12 shadow-sm hover:border-primary hover:text-primary transition-colors"
                      disabled={recordOutcome.isPending}
                      onClick={() => recordOutcome.mutate({ predictionId: id, data: { actualWinnerId: prediction.player2Id } })}
                    >
                      {prediction.player2Name} WON
                    </Button>
                  </div>
                </div>
              )}
            </div>

          </div>
        </CardContent>
      </Card>

      {/* MODEL VOTES & SEGMENT SPECIALIST (Phase 6) */}
      <div className="pt-8">
        <h3 className="text-2xl font-display font-bold flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Vote className="w-5 h-5 text-primary" />
          </div>
          Model Votes
        </h3>

        <div className="mb-6 p-5 border border-border/60 bg-secondary/40 rounded-2xl flex gap-4 text-sm shadow-sm backdrop-blur-sm">
          <Info className="w-5 h-5 shrink-0 mt-0.5 text-primary" />
          <div className="space-y-2">
            <div className="text-foreground/80 leading-relaxed">{engine.segmentNote ?? "This prediction predates Phase 6 segment specialists -- no segment data was recorded for it."}</div>
            {engine.segmentLabel && (
              <Badge variant={engine.specialistApplied ? "success" : "outline"} className="font-mono text-[10px] bg-background shadow-sm border-border/60">
                {engine.segmentLabel} {engine.specialistApplied ? "SPECIALIST APPLIED" : "SPECIALIST NOT AVAILABLE"}
              </Badge>
            )}
          </div>
        </div>

        {engine.modelConflict && (
          <div className="mb-6 p-5 border-2 border-warning/50 bg-warning/10 rounded-2xl flex gap-4 text-sm shadow-sm">
            <ShieldAlert className="w-6 h-6 shrink-0 text-warning" />
            <div className="space-y-1.5">
              <div className="font-bold font-mono text-[11px] text-warning tracking-widest uppercase">MODEL CONFLICT</div>
              <div className="text-foreground/80 leading-relaxed">{engine.modelConflictNote}</div>
            </div>
          </div>
        )}

        {engine.tieBreakerApplied && (
          <div className="mb-6 p-5 border border-border/60 bg-secondary/40 rounded-2xl flex gap-4 text-sm shadow-sm">
            <Scale className="w-6 h-6 shrink-0 text-primary" />
            <div className="space-y-1.5">
              <div className="font-bold font-mono text-[11px] tracking-widest uppercase">GENUINELY CLOSE MATCH — SIGNALS WITHIN 3% OF EVEN</div>
              <div className="text-foreground/80 leading-relaxed">{engine.tieBreakerNote}</div>
            </div>
          </div>
        )}

        <Card className="mb-10 shadow-md">
          <CardContent className="p-6 md:p-8 space-y-6">
            {/* Cross-Engine Agreement validation card */}
            {"crossEngineAgreement" in prediction && (
              <div className={`p-5 rounded-xl border ${
                prediction.crossEngineAgreement === true
                  ? "bg-success/5 border-success/30"
                  : prediction.crossEngineAgreement === false
                  ? "bg-warning/5 border-warning/30"
                  : "bg-secondary/30 border-border/40"
              }`}>
                <div className="flex items-center gap-3 mb-2">
                  {prediction.crossEngineAgreement === true && <CheckCircle2 className="w-5 h-5 text-success shrink-0" />}
                  {prediction.crossEngineAgreement === false && <AlertTriangle className="w-5 h-5 text-warning shrink-0" />}
                  {prediction.crossEngineAgreement === null && <Info className="w-5 h-5 text-muted-foreground shrink-0" />}
                  <span className="text-[11px] font-mono font-bold tracking-widest uppercase text-muted-foreground">
                    CROSS-ENGINE AGREEMENT
                  </span>
                  <span className={`ml-auto text-sm font-bold font-mono ${
                    prediction.crossEngineAgreement === true
                      ? "text-success"
                      : prediction.crossEngineAgreement === false
                      ? "text-warning"
                      : "text-muted-foreground"
                  }`}>
                    {prediction.crossEngineAgreement === true
                      ? "YES — VALIDATED"
                      : prediction.crossEngineAgreement === false
                      ? "NO — FLAGGED"
                      : "UNKNOWN — INSUFFICIENT DATA"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {prediction.crossEngineAgreement === true
                    ? `The parlay builder independently validated ${prediction.predictedWinnerName} as the correct side. Both the prediction engine and builder's factor analysis (surface Elo, recent form, serve/return, head-to-head, fatigue, availability) are aligned. This does not change the underlying probability.`
                    : prediction.crossEngineAgreement === false
                    ? `The parlay builder found more evidence supporting the opponent when the engine's pick (${prediction.predictedWinnerName}) was validated against the factor analysis. The prediction engine's probability and grade are unchanged — this is a separate signal flag only. Consider reducing position size or treating this as higher-risk.`
                    : "The parlay builder did not have enough data to validate this pick. This is not a disagreement — it means data coverage was insufficient for a builder decision. No adjustment to the probability or grade is made."}
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 bg-background rounded-xl p-5 border border-border/50 shadow-sm">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">MODEL AGREEMENT</span>
                <span className={`text-lg font-bold font-display ${(engine.modelAgreement && AGREEMENT_STYLES[engine.modelAgreement]) ?? "text-foreground"}`}>
                  {engine.modelAgreement ? engine.modelAgreement.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase() : "—"}
                </span>
              </div>
              {engine.matchupCloseness && (
                <div className="flex flex-col gap-1.5 sm:border-l border-border/50 sm:pl-6">
                  <span className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">MATCHUP CLOSENESS</span>
                  <span className="text-lg font-bold font-display text-foreground">
                    {CLOSENESS_LABELS[engine.matchupCloseness] ?? engine.matchupCloseness}
                  </span>
                </div>
              )}
            </div>
            
            {engine.disagreementNote && (
              <div className="p-4 bg-secondary/50 rounded-xl text-sm text-foreground/80 border border-border/50 border-l-4 border-l-warning">
                {engine.disagreementNote}
              </div>
            )}
            
            <div className="space-y-3 pt-2">
              <div className="hidden md:flex text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase px-4 pb-2 border-b border-border/50">
                <span className="flex-1" title="Model used in this prediction">Model Name</span>
                <span className="w-16 text-right" title="Player 1 raw probability from this model">Raw Prob</span>
                <span className="w-28 text-right" title="Final contribution weight used in the ensemble">Effective Weight</span>
                <span className="w-28 text-right" title="Raw probability multiplied by effective weight">Weighted Contribution</span>
                <span className="w-20 text-right" title="Reliability score (0-100)">Reliability</span>
                <span className="w-24 text-right" title="Whether this model materially influenced the final pick">Status</span>
              </div>
              {engine.models
                .filter((vote) => typeof vote.modelName === "string" && vote.modelName.trim().length > 0)
                .map((vote, i) => {
                  const modelName = toVisibleModelName(vote.modelName)
                  const effectiveWeightPct = vote.weightUsed * 100
                  const weightedContribution = (vote.player1Probability * vote.weightUsed)
                  const favored = vote.player1Probability >= 50 ? prediction.player1Name : prediction.player2Name
                  const status = vote.weightUsed < 0.01 ? "Excluded" : vote.reliability < 25 ? "Limited" : "Active"
                  const availability = vote.weightUsed < 0.01 ? "Unavailable" : "Available"
                  const sampleDepth = vote.reliability >= 75 ? "High" : vote.reliability >= 45 ? "Medium" : "Low"

                  return (
                    <div key={i} className="p-3 rounded-lg hover:bg-secondary/40 transition-colors border border-transparent hover:border-border/50 space-y-2">
                      <div className="md:flex md:items-center md:gap-3 md:text-sm">
                        <span className="md:flex-1 font-medium truncate">{modelName}</span>
                        <span className="md:w-16 md:text-right font-mono font-bold text-primary tabular-nums">{vote.player1Probability.toFixed(1)}%</span>
                        <span className="hidden md:block md:w-28 md:text-right font-mono text-xs text-muted-foreground tabular-nums">{effectiveWeightPct.toFixed(1)}%</span>
                        <span className="hidden md:block md:w-28 md:text-right font-mono text-xs text-muted-foreground tabular-nums">{weightedContribution.toFixed(1)}</span>
                        <span className="hidden md:block md:w-20 md:text-right font-mono text-xs text-muted-foreground tabular-nums">{vote.reliability.toFixed(0)}</span>
                        <span className="hidden md:block md:w-24 md:text-right text-xs font-mono">{status}</span>
                      </div>
                      <div className="grid grid-cols-2 md:hidden gap-2 text-[11px] font-mono text-muted-foreground">
                        <span>Favored: <span className="text-foreground">{favored}</span></span>
                        <span>Effective Weight: <span className="text-foreground">{effectiveWeightPct.toFixed(1)}%</span></span>
                        <span>Weighted Contribution: <span className="text-foreground">{weightedContribution.toFixed(1)}</span></span>
                        <span>Reliability: <span className="text-foreground">{vote.reliability.toFixed(0)}</span></span>
                        <span>Data Availability: <span className="text-foreground">{availability}</span></span>
                        <span>Sample Depth: <span className="text-foreground">{sampleDepth}</span></span>
                        <span>Status: <span className="text-foreground">{status}</span></span>
                        <span>Explanation: <span className="text-foreground">{status === "Excluded" ? "Near-zero effect in final ensemble." : "Contributed to final probability."}</span></span>
                      </div>
                    </div>
                  )
                })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* PHASE 7: MONTE CARLO MATCH SIMULATION */}
      {engine.simulation && (() => {
        // See lib/monteCarloHeadline.ts for the full rationale and regression-guard test: the
        // simulator only stores player1-relative figures, so the headline must be re-derived
        // for whichever player is actually the predicted winner.
        const { headlineWinnerName, headlineWinProbability, headlineRangeLow, headlineRangeHigh } = deriveMonteCarloHeadline({
          predictedWinnerId: prediction.predictedWinnerId,
          player1Id: prediction.player1Id,
          player1Name: prediction.player1Name,
          player2Name: prediction.player2Name,
          player1WinProbability: engine.simulation.player1WinProbability,
          rangeLow: engine.simulation.rangeLow,
          rangeHigh: engine.simulation.rangeHigh,
        });

        return (
          <div className="pt-8">
            <h3 className="text-2xl font-display font-bold flex items-center gap-3 mb-6">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Dices className="w-5 h-5 text-primary" />
              </div>
              Monte Carlo Simulation
            </h3>

            <div className="mb-6 p-5 border border-border/60 bg-secondary/40 rounded-2xl flex gap-4 text-sm shadow-sm backdrop-blur-sm">
              <Info className="w-5 h-5 shrink-0 mt-0.5 text-primary" />
              <div className="space-y-2">
                <div className="text-foreground/80 leading-relaxed">{engine.simulatorNote}</div>
                <Badge variant={engine.simulatorApplied ? "success" : "outline"} className="font-mono text-[10px] bg-background shadow-sm border-border/60">
                  {engine.simulatorApplied ? "VOTING IN FINAL PROBABILITY" : "DISPLAY-ONLY, NOT YET VOTING"}
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <Card className="shadow-md">
                <CardContent className="p-6 sm:p-8 space-y-8">
                  <div>
                    <p className="text-[10px] font-mono font-bold text-muted-foreground mb-2 tracking-widest uppercase">SIMULATED WIN PROBABILITY ({headlineWinnerName})</p>
                    <p className="text-5xl font-display font-bold tracking-tight text-primary tabular-nums">
                      {headlineWinProbability.toFixed(1)}%
                    </p>
                    <p className="text-sm text-muted-foreground mt-2 font-mono tabular-nums bg-secondary/50 inline-block px-3 py-1 rounded-md border border-border/50">
                      range {headlineRangeLow.toFixed(0)}–{headlineRangeHigh.toFixed(0)}%
                    </p>
                    <div className="relative h-4 w-full bg-background border border-border shadow-inner rounded-full overflow-hidden mt-6">
                      <div
                        className="absolute h-full bg-primary/20 backdrop-blur-sm"
                        style={{ left: `${headlineRangeLow}%`, width: `${Math.max(0, headlineRangeHigh - headlineRangeLow)}%` }}
                      />
                      <div className="absolute top-0 h-full w-1 bg-primary shadow-[0_0_8px_rgba(var(--primary),0.5)]" style={{ left: `${headlineWinProbability}%` }} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="p-4 bg-secondary/30 rounded-xl border border-border/50 shadow-sm text-center">
                      <p className="text-[10px] font-mono font-bold text-muted-foreground mb-1 tracking-widest uppercase">STRAIGHT SETS</p>
                      <p className="font-mono font-bold text-foreground mt-1 truncate px-2">{prediction.player1Name}</p>
                      <p className="text-2xl font-display font-bold mt-2 tabular-nums">{engine.simulation.straightSetsProbabilityPlayer1.toFixed(1)}%</p>
                    </div>
                    <div className="p-4 bg-secondary/30 rounded-xl border border-border/50 shadow-sm text-center">
                      <p className="text-[10px] font-mono font-bold text-muted-foreground mb-1 tracking-widest uppercase">STRAIGHT SETS</p>
                      <p className="font-mono font-bold text-foreground mt-1 truncate px-2">{prediction.player2Name}</p>
                      <p className="text-2xl font-display font-bold mt-2 tabular-nums">{engine.simulation.straightSetsProbabilityPlayer2.toFixed(1)}%</p>
                    </div>
                  </div>

                  <div className="text-xs text-muted-foreground space-y-2.5 font-mono border-t border-border/50 pt-6">
                    <div className="flex justify-between items-center bg-background/50 px-3 py-2 rounded-md">
                      <span>Expected games ({prediction.player1Name}):</span>
                      <span className="text-foreground font-bold tabular-nums">{engine.simulation.expectedGamesPlayer1.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between items-center bg-background/50 px-3 py-2 rounded-md">
                      <span>Expected games ({prediction.player2Name}):</span>
                      <span className="text-foreground font-bold tabular-nums">{engine.simulation.expectedGamesPlayer2.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between items-center bg-background/50 px-3 py-2 rounded-md">
                      <span>Simulations run:</span>
                      <span className="text-foreground font-bold tabular-nums">{engine.simulation.simulationsRun.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between items-center bg-background/50 px-3 py-2 rounded-md">
                      <span>Input completeness:</span>
                      <span className="text-foreground font-bold tabular-nums">{engine.simulation.inputReliability}%</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground/80 italic leading-relaxed">{engine.simulation.note}</p>
                </CardContent>
              </Card>

              <ModuleCard title="SET SCORE DISTRIBUTION" reliability={asPercentage(engine.simulation.inputReliability)} icon={Dices} reliabilityLabel="COMP">
                <div className="h-72 -ml-4 mt-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={engine.simulation.setScoreDistribution.slice(0, 8)} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border/40" />
                      <XAxis type="number" unit="%" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                      <YAxis type="category" dataKey="score" tick={{ fontSize: 11, fill: "hsl(var(--foreground))", fontWeight: "bold", fontFamily: "var(--font-mono)" }} width={45} tickLine={false} axisLine={false} />
                      <Tooltip
                        formatter={(value: number, _name: any, item: any) => [`${value.toFixed(1)}%`, item.payload.favors === "player1" ? prediction.player1Name : prediction.player2Name]}
                        contentStyle={{ fontSize: 12, borderRadius: '8px', border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--background))', color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono)' }}
                        cursor={{ fill: 'hsl(var(--secondary)/0.5)' }}
                      />
                      <Bar dataKey="probability" radius={[0, 6, 6, 0]} barSize={24}>
                        {engine.simulation.setScoreDistribution.slice(0, 8).map((entry, i) => (
                          <Cell key={i} fill={entry.favors === "player1" ? "hsl(var(--primary))" : "hsl(var(--muted-foreground)/0.5)"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase flex items-center justify-center gap-6 mt-2 pt-4 border-t border-border/50">
                  <span className="flex items-center gap-2"><span className="inline-block w-2.5 h-2.5 rounded-full bg-primary shadow-sm" /> {prediction.player1Name}</span>
                  <span className="flex items-center gap-2"><span className="inline-block w-2.5 h-2.5 rounded-full bg-muted-foreground/50 shadow-sm" /> {prediction.player2Name}</span>
                </div>
              </ModuleCard>
            </div>
          </div>
        );
      })()}

      {/* FULL ENGINE BREAKDOWN */}
      <div className="pt-8">
        <h3 className="text-2xl font-display font-bold flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Database className="w-5 h-5 text-primary" />
          </div>
          Full Engine Breakdown
        </h3>

        {engine.availabilityNote && (
          <div className="mb-4 p-5 border-2 border-warning/30 bg-warning/10 text-warning-foreground rounded-2xl flex gap-4 text-sm shadow-sm">
            <AlertTriangle className="w-6 h-6 shrink-0 text-warning" />
            <div className="leading-relaxed">{engine.availabilityNote}</div>
          </div>
        )}

        {engine.conditionsNote && (
          <div className="mb-4 p-5 border border-border/60 bg-secondary/40 rounded-2xl flex gap-4 text-sm text-foreground/80 shadow-sm backdrop-blur-sm">
            <Activity className="w-6 h-6 shrink-0 text-primary" />
            <div className="leading-relaxed">{engine.conditionsNote}</div>
          </div>
        )}

        {!!engine.warnings?.length && (
          <div className="mb-6 p-5 border-2 border-warning/30 bg-warning/5 rounded-2xl space-y-3 shadow-sm">
            {engine.warnings.map((w, i) => (
              <div key={i} className="flex gap-3 text-sm text-foreground/80">
                <AlertTriangle className="w-5 h-5 text-warning shrink-0" /> <span className="leading-snug">{w}</span>
              </div>
            ))}
          </div>
        )}

        {!!engine.disclosures?.length && (
          <div className="mb-8 p-5 border border-border/60 bg-secondary/40 rounded-2xl space-y-3 shadow-sm backdrop-blur-sm">
            {engine.disclosures.map((d, i) => (
              <div key={i} className="flex gap-3 text-sm text-foreground/80">
                <Info className="w-5 h-5 text-primary shrink-0" /> <span className="leading-snug">{d}</span>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
          
          <ModuleCard title="SURFACE ELO" reliability={asPercentage(engine.surfaceElo.reliability)} icon={ActivitySquare}>
            <EdgeBar 
              p1Name={prediction.player1Name} 
              p2Name={prediction.player2Name} 
              p1Value={engine.surfaceElo.player1SurfaceElo} 
              p2Value={engine.surfaceElo.player2SurfaceElo}
              label="RATING"
            />
            <div className="mt-2 text-sm text-muted-foreground flex justify-between font-mono bg-background p-2 rounded">
              <span>WIN PROB (ELO):</span>
              {/* eloWinProbabilityPlayer1 is already a Percentage (0-100) -- see the module doc
                  comment in predictionEngine/units.ts and surfaceElo.ts. asPercentage() asserts
                  that scale explicitly; never multiply this value by 100. */}
              <span className="font-bold text-foreground">{formatPercentage(asPercentage(engine.surfaceElo.eloWinProbabilityPlayer1), 1)}</span>
            </div>
            {engine.surfaceSampleDepth && (
              <div className="mt-2 flex items-center justify-between text-xs font-mono">
                <span className="text-muted-foreground">SURFACE SAMPLE DEPTH:</span>
                <Badge
                  variant={engine.surfaceSampleDepth.label === "Low" ? "destructive" : engine.surfaceSampleDepth.label === "Moderate" ? "outline" : "success"}
                  className="font-mono text-[10px]"
                >
                  {engine.surfaceSampleDepth.label.toUpperCase()} ({engine.surfaceSampleDepth.player1Sample}/{engine.surfaceSampleDepth.player2Sample})
                </Badge>
              </div>
            )}
            {typeof engine.surfaceElo.effectiveSampleSizePlayer1 === "number" && typeof engine.surfaceElo.effectiveSampleSizePlayer2 === "number" && (
              <div className="mt-1 flex items-center justify-between text-xs font-mono">
                <span className="text-muted-foreground" title="Recency- and level-weighted match count, not a raw tally">EFFECTIVE SAMPLE (WEIGHTED):</span>
                <span className="text-foreground">
                  {engine.surfaceElo.effectiveSampleSizePlayer1.toFixed(1)}/{engine.surfaceElo.effectiveSampleSizePlayer2.toFixed(1)}
                </span>
              </div>
            )}
            {typeof engine.surfaceElo.player1BlendWeight === "number" &&
              typeof engine.surfaceElo.player2BlendWeight === "number" &&
              Math.max(engine.surfaceElo.player1BlendWeight, engine.surfaceElo.player2BlendWeight) > 0.3 && (
                <div className="mt-1 text-xs font-mono text-warning">
                  {/* player1/2BlendWeight are Fractions (0-1) -- must go through fractionToPercentage before display, never displayed directly. */}
                  Blended toward overall Elo: {prediction.player1Name} {formatPercentage(fractionToPercentage(asFraction(engine.surfaceElo.player1BlendWeight)))}, {prediction.player2Name}{" "}
                  {formatPercentage(fractionToPercentage(asFraction(engine.surfaceElo.player2BlendWeight)))} (thin surface-specific sample)
                </div>
              )}
          </ModuleCard>

          <ModuleCard title="SERVE & RETURN" reliability={asPercentage(engine.serveReturn.reliability)} icon={TrendingUp}>
            <EdgeBar 
              p1Name={prediction.player1Name} 
              p2Name={prediction.player2Name} 
              p1Value={engine.serveReturn.player1ServeRating} 
              p2Value={engine.serveReturn.player2ServeRating}
              label="SERVE S.P."
            />
            <div className="my-2" />
            <EdgeBar 
              p1Name={prediction.player1Name} 
              p2Name={prediction.player2Name} 
              p1Value={engine.serveReturn.player1ReturnRating} 
              p2Value={engine.serveReturn.player2ReturnRating}
              label="RTN S.P."
            />
            {engine.serveReturn.note && (
               <p className="text-xs text-muted-foreground mt-2 italic">{engine.serveReturn.note}</p>
            )}
          </ModuleCard>

          <ModuleCard title="RECENT FORM" reliability={asPercentage(engine.recentForm.reliability)} icon={Activity}>
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center p-3 bg-background rounded-lg border">
                <p className="text-xs font-mono text-muted-foreground truncate">{prediction.player1Name}</p>
                <p className="text-2xl font-bold my-1">{engine.recentForm.player1Form.toFixed(1)}</p>
                <Badge variant="outline" className="text-[10px]">{engine.recentForm.player1Trend}</Badge>
              </div>
              <div className="text-center p-3 bg-background rounded-lg border">
                <p className="text-xs font-mono text-muted-foreground truncate">{prediction.player2Name}</p>
                <p className="text-2xl font-bold my-1">{engine.recentForm.player2Form.toFixed(1)}</p>
                <Badge variant="outline" className="text-[10px]">{engine.recentForm.player2Trend}</Badge>
              </div>
            </div>
            {typeof engine.recentForm.player1OpponentAdjustedCoverage === "number" && typeof engine.recentForm.player2OpponentAdjustedCoverage === "number" && (
              <div className="mt-2 flex items-center justify-between text-xs font-mono">
                <span className="text-muted-foreground" title="Share of recent matches with a real opponent-strength estimate">OPPONENT-ADJUSTED:</span>
                <span className="text-foreground">
                  {engine.recentForm.player1OpponentAdjustedCoverage}%/{engine.recentForm.player2OpponentAdjustedCoverage}%
                </span>
              </div>
            )}
            {typeof engine.recentForm.player1ServeReturnCoverage === "number" && typeof engine.recentForm.player2ServeReturnCoverage === "number" && (
              <div className="mt-1 flex items-center justify-between text-xs font-mono">
                <span className="text-muted-foreground" title="Share of recent matches with a real serve/return stat line factored in">SERVE/RETURN SIGNAL:</span>
                <span className="text-foreground">
                  {engine.recentForm.player1ServeReturnCoverage}%/{engine.recentForm.player2ServeReturnCoverage}%
                </span>
              </div>
            )}
          </ModuleCard>

          <ModuleCard title="FATIGUE INDEX" reliability={asPercentage(engine.fatigue.reliability)} icon={Activity}>
            <EdgeBar 
              p1Name={prediction.player1Name} 
              p2Name={prediction.player2Name} 
              p1Value={engine.fatigue.player1FatigueScore} 
              p2Value={engine.fatigue.player2FatigueScore}
              label="FATIGUE"
            />
            <div className="mt-2 text-xs text-muted-foreground space-y-1">
              <div className="flex justify-between">
                <span>{prediction.player1Name} matches (7d):</span>
                <span className="font-mono font-bold text-foreground">{engine.fatigue.player1MatchesLast7Days}</span>
              </div>
              <div className="flex justify-between">
                <span>{prediction.player2Name} matches (7d):</span>
                <span className="font-mono font-bold text-foreground">{engine.fatigue.player2MatchesLast7Days}</span>
              </div>
            </div>
          </ModuleCard>

          {engine.matchLoadRecovery && (
            <ModuleCard title="MATCH LOAD RECOVERY" reliability={asPercentage(engine.matchLoadRecovery.reliability)} icon={Activity}>
              <EdgeBar
                p1Name={prediction.player1Name}
                p2Name={prediction.player2Name}
                p1Value={engine.matchLoadRecovery.player1RecoveryRiskScore}
                p2Value={engine.matchLoadRecovery.player2RecoveryRiskScore}
                label="RECOVERY RISK"
              />
              <div className="mt-2 text-xs text-muted-foreground space-y-1">
                <div className="flex justify-between">
                  <span>{prediction.player1Name} last match went the distance:</span>
                  <span className="font-mono font-bold text-foreground">
                    {engine.matchLoadRecovery.player1RecentMatchWentDistance === null ? "—" : engine.matchLoadRecovery.player1RecentMatchWentDistance ? "Yes" : "No"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>{prediction.player2Name} last match went the distance:</span>
                  <span className="font-mono font-bold text-foreground">
                    {engine.matchLoadRecovery.player2RecentMatchWentDistance === null ? "—" : engine.matchLoadRecovery.player2RecentMatchWentDistance ? "Yes" : "No"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>{prediction.player1Name} rest days (informational only):</span>
                  <span className="font-mono font-bold text-foreground">{engine.matchLoadRecovery.player1RestDays ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span>{prediction.player2Name} rest days (informational only):</span>
                  <span className="font-mono font-bold text-foreground">{engine.matchLoadRecovery.player2RestDays ?? "—"}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2 italic">
                A new, thin single-bit signal: whether each player's single most recent match went the distance (not a recency-weighted match count). Rest days are shown for transparency but don't feed the score.
              </p>
            </ModuleCard>
          )}

          {engine.availability ? (
            <ModuleCard title="REST, TRAVEL & INJURY" reliability={asPercentage(engine.availability.reliability)} icon={Activity}>
              <div className="text-xs text-muted-foreground space-y-1">
                <div className="flex justify-between">
                  <span>{prediction.player1Name} rest days:</span>
                  <span className="font-mono font-bold text-foreground">
                    {engine.availability.player1.daysSinceLastMatch ?? "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>{prediction.player2Name} rest days:</span>
                  <span className="font-mono font-bold text-foreground">
                    {engine.availability.player2.daysSinceLastMatch ?? "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>{prediction.player1Name} travel since last match:</span>
                  <span className="font-mono font-bold text-foreground">
                    {engine.availability.player1.travelDistanceKm !== null ? `${engine.availability.player1.travelDistanceKm} km` : "n/a"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>{prediction.player2Name} travel since last match:</span>
                  <span className="font-mono font-bold text-foreground">
                    {engine.availability.player2.travelDistanceKm !== null ? `${engine.availability.player2.travelDistanceKm} km` : "n/a"}
                  </span>
                </div>
                {engine.availability.player1.recentRetirementOrWithdrawal && (
                  <p className="text-warning">
                    {prediction.player1Name} retired mid-match recently
                    {engine.availability.player1.recentRetirementTournament ? ` (${engine.availability.player1.recentRetirementTournament})` : ""}.
                  </p>
                )}
                {engine.availability.player2.recentRetirementOrWithdrawal && (
                  <p className="text-warning">
                    {prediction.player2Name} retired mid-match recently
                    {engine.availability.player2.recentRetirementTournament ? ` (${engine.availability.player2.recentRetirementTournament})` : ""}.
                  </p>
                )}
              </div>
              {engine.availability.note && (
                <p className="text-xs text-muted-foreground mt-2 italic">{engine.availability.note}</p>
              )}
            </ModuleCard>
          ) : (
            <ModuleCard title="REST, TRAVEL & INJURY" reliability={asPercentage(0)} icon={Activity}>
              <p className="text-xs text-muted-foreground italic">
                This prediction was made before rest/travel/injury tracking was added and doesn't carry this data.
              </p>
            </ModuleCard>
          )}

          <ModuleCard title="HEAD TO HEAD" reliability={asPercentage(engine.headToHead.reliability)} icon={Swords}>
             <div className="flex justify-center items-center gap-6 py-4">
                <div className="text-center">
                  <p className="text-4xl font-bold">{engine.headToHead.player1Wins}</p>
                  <p className="text-xs font-mono text-muted-foreground mt-1 truncate w-20">{prediction.player1Name}</p>
                </div>
                <div className="text-muted-foreground font-mono text-sm">VS</div>
                <div className="text-center">
                  <p className="text-4xl font-bold">{engine.headToHead.player2Wins}</p>
                  <p className="text-xs font-mono text-muted-foreground mt-1 truncate w-20">{prediction.player2Name}</p>
                </div>
             </div>
             <div className="text-xs text-center text-muted-foreground border-t pt-2">
                {engine.headToHead.surfaceMeetings} meetings on {prediction.surface}
             </div>
          </ModuleCard>
          
          <ModuleCard title="STYLE MATCHUP" reliability={asPercentage(engine.styleMatchup.reliability)} icon={Dna}>
             <div className="space-y-4 text-sm">
                <div>
                  <p className="text-xs font-mono font-bold mb-1 truncate text-primary">{prediction.player1Name}</p>
                  <div className="flex flex-wrap gap-1">
                    {engine.styleMatchup.player1Styles.length ? engine.styleMatchup.player1Styles.map(s => <Badge variant="secondary" key={s} className="text-[10px] font-normal">{s}</Badge>) : <span className="text-muted-foreground text-xs italic">Unknown</span>}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-mono font-bold mb-1 truncate text-foreground">{prediction.player2Name}</p>
                  <div className="flex flex-wrap gap-1">
                    {engine.styleMatchup.player2Styles.length ? engine.styleMatchup.player2Styles.map(s => <Badge variant="secondary" key={s} className="text-[10px] font-normal">{s}</Badge>) : <span className="text-muted-foreground text-xs italic">Unknown</span>}
                  </div>
                </div>
             </div>
          </ModuleCard>

        </div>
      </div>

      {/* DECISION TRACE (Task #32) */}
      {(prediction as any).decisionTrace && (
        <DecisionTracePanel
          trace={(prediction as any).decisionTrace}
          player1Name={prediction.player1Name}
          player2Name={prediction.player2Name}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Decision Trace Panel (Task #32) — full pipeline + decision chain audit view
// ---------------------------------------------------------------------------

interface PipelineStep {
  label: string;
  prob: number;
  note?: string;
}

function ProbabilityBar({ value, player1Name, player2Name }: { value: number; player1Name: string; player2Name: string }) {
  const p1Pct = Math.max(0, Math.min(100, value));
  const p2Pct = 100 - p1Pct;
  return (
    <div className="w-full">
      <div className="flex justify-between text-[10px] font-mono mb-1">
        <span className="text-primary truncate max-w-[40%]">{player1Name}: {value.toFixed(1)}%</span>
        <span className="text-muted-foreground truncate max-w-[40%] text-right">{player2Name}: {(100 - value).toFixed(1)}%</span>
      </div>
      <div className="h-3 w-full bg-muted/50 border border-border rounded-full overflow-hidden flex">
        <div className="h-full bg-primary/70" style={{ width: `${p1Pct}%` }} />
        <div className="h-full bg-muted-foreground/30" style={{ width: `${p2Pct}%` }} />
      </div>
    </div>
  );
}

function GateRow({ label, passed, detail }: { label: string; passed: boolean; detail?: string }) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-border/40 last:border-0">
      {passed
        ? <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
        : <XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />}
      <div className="text-sm">
        <span className={passed ? "text-foreground" : "text-destructive"}>{label}</span>
        {detail && <span className="text-xs text-muted-foreground ml-2">{detail}</span>}
      </div>
    </div>
  );
}

function CollapsibleSection({ title, icon: Icon, defaultOpen = false, children }: { title: string; icon: any; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border/60 rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-5 py-4 bg-secondary/40 hover:bg-secondary/60 transition-colors font-mono text-xs font-bold tracking-widest uppercase"
        onClick={() => setOpen(!open)}
      >
        <span className="flex items-center gap-2.5">
          <Icon className="w-4 h-4 text-primary" />
          {title}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="p-5 space-y-3 bg-background">{children}</div>}
    </div>
  );
}

function DecisionTracePanel({ trace, player1Name, player2Name }: { trace: any; player1Name: string; player2Name: string }) {
  const pipeline = trace.pipeline ?? {};
  const modules: any[] = trace.modules ?? [];
  const rec = trace.recommendation ?? {};
  const eliteTier = trace.eliteTier ?? {};
  const gates = eliteTier.gates ?? {};

  const pipelineSteps: PipelineStep[] = [
    { label: "Raw Ensemble", prob: pipeline.rawEnsemble, note: "Feature module weighted average" },
    ...(pipeline.tieBreakerApplied ? [{ label: "After Tie-Breaker", prob: pipeline.afterTieBreaker, note: "Close matchup (within 3%) — passed through unchanged" }] : []),
    { label: "After Calibration", prob: pipeline.afterCalibration, note: `${pipeline.calibrationMethod === "fitted" ? "Isotonic calibration" : "Fallback DQ-shrink"} (factor ${pipeline.fallbackShrinkFactor?.toFixed(2) ?? "fitted"})` },
    ...(pipeline.specialistWeight > 0 ? [{ label: "After Specialist Blend", prob: pipeline.afterSpecialist, note: `Specialist weight: ${(pipeline.specialistWeight * 100).toFixed(0)}%` }] : []),
    ...(pipeline.reliabilityDiscount < 0.999 ? [{ label: "After Reliability Discount", prob: pipeline.afterReliabilityDiscount, note: `Discount: ×${pipeline.reliabilityDiscount?.toFixed(3)}` }] : []),
    ...(pipeline.simulatorWeight > 0 ? [{ label: "After Simulator Blend", prob: pipeline.afterSimulator, note: `Simulator weight: ${(pipeline.simulatorWeight * 100).toFixed(0)}%, scope gap: ${pipeline.simulatorScopeGap?.toFixed(1)}` }] : []),
    { label: "Final Probability", prob: pipeline.afterSimulator ?? pipeline.afterReliabilityDiscount ?? pipeline.afterSpecialist ?? pipeline.afterCalibration, note: "Stored calibratedProbability" },
  ].filter((s) => s.prob !== undefined && !isNaN(s.prob));

  const ensembleModules = modules.filter((m) => !m.excludedFromEnsemble && !m.excludedByAblation && m.player1Probability !== null);
  const excludedModules = modules.filter((m) => m.excludedFromEnsemble || m.excludedByAblation);

  return (
    <div className="pt-8">
      <h3 className="text-2xl font-display font-bold flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded-lg">
          <GitBranch className="w-5 h-5 text-primary" />
        </div>
        Decision Trace
        <Badge variant="outline" className="font-mono text-[10px] ml-2">AUDIT</Badge>
      </h3>
      <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
        Full pipeline trace for this prediction — every intermediate probability stage, per-module raw edge, recommendation rule chain, and elite-tier gate. Captured at prediction time; unaffected by subsequent engine changes.
      </p>

      <div className="space-y-4">
        {/* Pipeline stages */}
        <CollapsibleSection title="Probability Pipeline" icon={TrendingUp} defaultOpen>
          <div className="space-y-5">
            {pipelineSteps.map((step, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold text-foreground">{step.label}</span>
                  {step.note && <span className="text-[10px] text-muted-foreground">{step.note}</span>}
                </div>
                <ProbabilityBar value={step.prob} player1Name={player1Name} player2Name={player2Name} />
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {/* Per-module edges */}
        {ensembleModules.length > 0 && (
          <CollapsibleSection title="Module Raw Edges (Ensemble)" icon={Database}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-2 pr-3">Module</th>
                    <th className="text-right py-2 px-3">Raw Edge</th>
                    <th className="text-right py-2 px-3">Reliability</th>
                    <th className="text-right py-2 px-3">Weight Prior</th>
                    <th className="text-right py-2 px-3">Eff. Weight</th>
                    <th className="text-right py-2 pl-3">P1 Prob</th>
                    <th className="text-left py-2 pl-3">Direction</th>
                  </tr>
                </thead>
                <tbody>
                  {ensembleModules.map((m: any, i: number) => (
                    <tr key={i} className="border-b border-border/40 hover:bg-secondary/30">
                      <td className="py-2 pr-3 font-medium text-foreground">{m.name}</td>
                      <td className={`py-2 px-3 text-right tabular-nums ${m.rawEdge > 0 ? "text-primary" : m.rawEdge < 0 ? "text-muted-foreground" : "text-foreground"}`}>
                        {m.rawEdge >= 0 ? "+" : ""}{m.rawEdge?.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{m.reliability}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{m.weightPrior}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{m.effectiveWeight?.toFixed(2) ?? "—"}</td>
                      <td className="py-2 pl-3 text-right tabular-nums font-bold text-primary">{m.player1Probability?.toFixed(1)}%</td>
                      <td className="py-2 pl-3">
                        <Badge variant={m.voteDirection === "player1" ? "success" : m.voteDirection === "player2" ? "destructive" : "outline"} className="text-[10px]">
                          {m.voteDirection === "player1" ? player1Name.split(" ")[0] : m.voteDirection === "player2" ? player2Name.split(" ")[0] : "tied"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {excludedModules.length > 0 && (
              <p className="text-[10px] text-muted-foreground mt-3">
                <span className="font-bold">Excluded from ensemble:</span> {excludedModules.map((m: any) => `${m.name}${m.excludedByAblation ? " (ablation)" : ""}`).join(", ")}
              </p>
            )}
          </CollapsibleSection>
        )}

        {/* Recommendation rule chain */}
        {rec.rulesChecked?.length > 0 && (
          <CollapsibleSection title={`Recommendation Chain → ${rec.result}`} icon={ChevronRight}>
            <div className="space-y-1">
              {(rec.rulesChecked as any[]).map((rule: any, i: number) => (
                <div key={i} className={`flex items-start gap-2 py-1.5 text-xs rounded-lg px-2 ${rule.decided ? "bg-primary/10 border border-primary/30" : ""}`}>
                  {rule.matched
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
                    : <XCircle className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0 mt-0.5" />}
                  <span className={rule.decided ? "text-foreground font-bold" : "text-muted-foreground"}>{rule.rule}</span>
                  {rule.decided && <Badge variant="outline" className="ml-auto text-[9px] shrink-0">DECIDED</Badge>}
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Elite tier gates */}
        {gates && Object.keys(gates).length > 0 && (
          <CollapsibleSection title={`Elite Tier Gates — ${eliteTier.isElite ? "✓ ELITE" : "✗ NOT ELITE"}`} icon={Crown}>
            <div className="space-y-0.5">
              {gates.dataQuality && (
                <GateRow label="Data Quality ≥ 55" passed={gates.dataQuality.passed} detail={`actual: ${gates.dataQuality.actual}`} />
              )}
              {gates.calibratedMargin && (
                <GateRow label="Calibrated Margin ≥ 5" passed={gates.calibratedMargin.passed} detail={`actual: ${gates.calibratedMargin.actual?.toFixed(1)}pt`} />
              )}
              {gates.allCoreModelsAgree && (
                <GateRow
                  label="All Core Models Agree Direction"
                  passed={gates.allCoreModelsAgree.passed}
                  detail={`Elo: ${gates.allCoreModelsAgree.surfaceEloFavorsP1 ? "P1" : "P2"}, S&R: ${gates.allCoreModelsAgree.serveReturnFavorsP1 ? "P1" : "P2"}, Form: ${gates.allCoreModelsAgree.recentFormFavorsP1 ? "P1" : "P2"}`}
                />
              )}
              {gates.specialistApplied !== undefined && (
                <GateRow label="Segment Specialist Applied" passed={gates.specialistApplied.passed} />
              )}
              {gates.noModelConflict !== undefined && (
                <GateRow label="No Model Conflict" passed={gates.noModelConflict.passed} />
              )}
              {gates.notHighDisagreement && (
                <GateRow label="Agreement ≠ High Disagreement" passed={gates.notHighDisagreement.passed} detail={gates.notHighDisagreement.actual} />
              )}
              {gates.upsetRiskAcceptable && (
                <GateRow label="Upset Risk LOW or MODERATE" passed={gates.upsetRiskAcceptable.passed} detail={gates.upsetRiskAcceptable.actual} />
              )}
              {gates.consistencyGuard && (
                <GateRow
                  label="Final Consistency Guard"
                  passed={gates.consistencyGuard.passed}
                  detail={gates.consistencyGuard.violations?.length > 0 ? gates.consistencyGuard.violations.join("; ") : undefined}
                />
              )}
            </div>
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}

function Swords(props: any) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/></svg>
}
