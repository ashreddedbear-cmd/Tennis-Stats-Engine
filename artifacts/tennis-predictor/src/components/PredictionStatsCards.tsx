import { AlertTriangle, Clock, Target, TrendingUp } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { getShortRecommendationLabel } from "@/lib/recommendationLabels"

export interface PredictionStatsSummary {
  totalPredictions: number
  resolvedPredictions: number
  correctPredictions: number
  accuracy: number | null
  byRecommendation?: Array<{ recommendation: string; count: number }>
}

export function PredictionStatCard({ title, value, subtext, icon: Icon }: { title: string; value: string | number; subtext?: string; icon: LucideIcon }) {
  return (
    <Card className="bg-card shadow-sm glass-panel hover-lift">
      <CardContent className="p-4">
        <div className="flex justify-between items-start">
          <div className="space-y-1.5">
            <p className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-widest">{title}</p>
            <p className="text-2xl font-display font-bold tracking-tight text-primary tabular-nums">{value}</p>
            {subtext && <p className="text-[11px] text-muted-foreground/80 font-medium leading-snug">{subtext}</p>}
          </div>
          <div className="p-2 bg-secondary/50 rounded-lg border border-border/50 shrink-0">
            <Icon className="w-4 h-4 text-primary" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function PredictionStatsCards({ stats, isLoading }: { stats?: PredictionStatsSummary | null; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}
      </div>
    )
  }

  if (!stats) return null

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <PredictionStatCard title="TOTAL RUNS" value={stats.totalPredictions} icon={Target} />
      <PredictionStatCard title="RESOLVED" value={stats.resolvedPredictions} icon={Clock} />
      <PredictionStatCard title="ACCURACY" value={stats.accuracy !== null ? `${stats.accuracy.toFixed(1)}%` : "--"} subtext={`${stats.correctPredictions} correct`} icon={TrendingUp} />
      <PredictionStatCard
        title={getShortRecommendationLabel("HIGHEST_CONFIDENCE")}
        value={
          (stats.byRecommendation?.find((r) => r.recommendation === "HIGHEST_CONFIDENCE")?.count || 0) +
          (stats.byRecommendation?.find((r) => r.recommendation === "STRONG_RECOMMENDATION")?.count || 0)
        }
        subtext="Highest-confidence tier -- not yet proven better than other tiers"
        icon={AlertTriangle}
      />
    </div>
  )
}