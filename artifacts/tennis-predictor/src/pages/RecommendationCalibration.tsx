import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RefreshCw, Play, AlertTriangle, CheckCircle } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? ''
const getApiUrl = (path: string) => `${BASE}/${path}`
import { getRecommendationLabel } from '@/lib/recommendationLabels'

interface CategoryStat {
  category: string
  total: number
  graded: number
  wins: number
  avg_dq: number | null
  avg_prob: number | null
}

interface MatrixRow {
  old_category: string
  new_category: string
  count: number
  wins: number
  graded: number
}

interface AuditData {
  ok: boolean
  summary: {
    total: number
    graded: number
    v2_computed: number
    changed: number
    last_recomputed_at: string | null
  }
  oldStats: CategoryStat[]
  v2Stats: CategoryStat[]
  matrix: MatrixRow[]
}

interface RecomputeResult {
  ok: boolean
  processed: number
  skipped: number
  changed: number
}

const CONFIDENCE_RANK: Record<string, number> = {
  HIGHEST_CONFIDENCE: 5,
  HIGH_CONFIDENCE: 4,
  MODERATE_CONFIDENCE: 3,
  LOW_CONFIDENCE: 2,
  INSUFFICIENT_EDGE: 1,
  // Legacy
  STRONG_RECOMMENDATION: 4,
  MODERATE_LEAN: 3,
  HIGH_RISK: 2,
  NO_STRONG_SIGNAL: 1,
  DO_NOT_RECOMMEND: 1,
}

const TIER_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline' | 'destructive'> = {
  HIGHEST_CONFIDENCE: 'success',
  HIGH_CONFIDENCE: 'success',
  MODERATE_CONFIDENCE: 'secondary',
  LOW_CONFIDENCE: 'warning',
  INSUFFICIENT_EDGE: 'outline',
  STRONG_RECOMMENDATION: 'success',
  MODERATE_LEAN: 'secondary',
  HIGH_RISK: 'warning',
  NO_STRONG_SIGNAL: 'outline',
  DO_NOT_RECOMMEND: 'destructive',
}

function pct(wins: number, graded: number): string {
  if (!graded) return '—'
  return `${((wins / graded) * 100).toFixed(1)}%`
}

function isMonotone(stats: CategoryStat[]): boolean {
  const sorted = [...stats].sort((a, b) => (CONFIDENCE_RANK[b.category] ?? 0) - (CONFIDENCE_RANK[a.category] ?? 0))
  for (let i = 0; i < sorted.length - 1; i++) {
    const higher = sorted[i]
    const lower = sorted[i + 1]
    if (higher.graded < 5 || lower.graded < 5) continue // skip low-N tiers
    const higherAcc = higher.wins / higher.graded
    const lowerAcc = lower.wins / lower.graded
    if (higherAcc < lowerAcc - 0.02) return false // allow 2pt tolerance for small N
  }
  return true
}

export default function RecommendationCalibration() {
  const qc = useQueryClient()
  const [recomputeResult, setRecomputeResult] = useState<RecomputeResult | null>(null)

  const { data, isLoading, error, refetch } = useQuery<AuditData>({
    queryKey: ['recommendation-calibration-audit'],
    queryFn: async () => {
      const res = await fetch(getApiUrl('api/admin/recommendation-calibration/audit'))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    staleTime: 30_000,
  })

  const recompute = useMutation({
    mutationFn: async () => {
      const res = await fetch(getApiUrl('api/admin/recommendation-calibration/recompute'), { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<RecomputeResult>
    },
    onSuccess: (result) => {
      setRecomputeResult(result)
      qc.invalidateQueries({ queryKey: ['recommendation-calibration-audit'] })
    },
  })

  const monotone = data?.v2Stats && data.v2Stats.length > 0 ? isMonotone(data.v2Stats) : null

  if (isLoading) {
    return (
      <div className="p-8 text-center text-muted-foreground font-mono text-sm">Loading audit data…</div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-8 text-center text-destructive font-mono text-sm">
        Failed to load audit data. {String(error)}
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold">Recommendation Calibration</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-xl">
            Evidence Confidence Score (v2) shadow replay. Recomputes each stored prediction's
            recommendation under the new 5-tier logic and writes it to{' '}
            <code className="font-mono text-xs">recommendation_v2</code>. The live{' '}
            <code className="font-mono text-xs">recommendation</code> column is never changed here
            — new predictions use the v2 logic automatically.
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5 font-mono text-xs">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => recompute.mutate()}
            disabled={recompute.isPending}
            className="gap-1.5 font-mono text-xs"
          >
            <Play className="w-3.5 h-3.5" />
            {recompute.isPending ? 'Running…' : 'Run Shadow Replay'}
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { label: 'TOTAL', value: data.summary.total },
          { label: 'GRADED', value: data.summary.graded },
          { label: 'V2 COMPUTED', value: data.summary.v2_computed },
          { label: 'CHANGED', value: data.summary.changed },
          {
            label: 'LAST RUN',
            value: data.summary.last_recomputed_at
              ? new Date(data.summary.last_recomputed_at).toLocaleDateString()
              : '—',
          },
        ].map(({ label, value }) => (
          <Card key={label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase mb-1">
                {label}
              </p>
              <p className="text-2xl font-bold tabular-nums">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recompute result banner */}
      {recomputeResult && (
        <div className="flex items-center gap-3 p-4 rounded-lg border border-border bg-secondary/30 font-mono text-sm">
          <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
          <span>
            Replay complete — <strong>{recomputeResult.processed}</strong> processed,{' '}
            <strong>{recomputeResult.changed}</strong> changed, <strong>{recomputeResult.skipped}</strong>{' '}
            skipped (missing engine data).
          </span>
        </div>
      )}

      {/* Monotonicity check */}
      {monotone !== null && (
        <div
          className={`flex items-center gap-3 p-4 rounded-lg border font-mono text-sm ${
            monotone
              ? 'border-green-500/30 bg-green-500/5 text-green-600 dark:text-green-400'
              : 'border-destructive/30 bg-destructive/5 text-destructive'
          }`}
        >
          {monotone ? (
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          )}
          <span>
            {monotone
              ? 'Monotonicity check passed — accuracy increases with confidence tier (tiers with ≥5 graded rows checked).'
              : 'Monotonicity check FAILED — a lower tier shows higher accuracy than a higher tier. Review the v2 stats table.'}
          </span>
        </div>
      )}

      {/* v2 stats table */}
      {data.v2Stats.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono font-bold tracking-widest uppercase">
              V2 Stats (new 5-tier system)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Graded</TableHead>
                  <TableHead className="text-right">Wins</TableHead>
                  <TableHead className="text-right">Accuracy</TableHead>
                  <TableHead className="text-right">Avg DQ</TableHead>
                  <TableHead className="text-right">Avg Prob</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...data.v2Stats]
                  .sort((a, b) => (CONFIDENCE_RANK[b.category] ?? 0) - (CONFIDENCE_RANK[a.category] ?? 0))
                  .map((row) => (
                    <TableRow key={row.category}>
                      <TableCell>
                        <Badge variant={TIER_VARIANT[row.category] ?? 'outline'} className="font-mono text-xs">
                          {getRecommendationLabel(row.category)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.total}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.graded}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.wins}</TableCell>
                      <TableCell className="text-right font-mono text-sm font-bold">
                        {pct(row.wins, row.graded)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.avg_dq ?? '—'}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.avg_prob ?? '—'}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Old stats table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono font-bold tracking-widest uppercase">
            Original Stats (stored recommendation column)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Graded</TableHead>
                <TableHead className="text-right">Wins</TableHead>
                <TableHead className="text-right">Accuracy</TableHead>
                <TableHead className="text-right">Avg DQ</TableHead>
                <TableHead className="text-right">Avg Prob</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.oldStats.map((row) => (
                <TableRow key={row.category}>
                  <TableCell>
                    <Badge variant={TIER_VARIANT[row.category] ?? 'outline'} className="font-mono text-xs">
                      {getRecommendationLabel(row.category)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{row.total}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{row.graded}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{row.wins}</TableCell>
                  <TableCell className="text-right font-mono text-sm font-bold">
                    {pct(row.wins, row.graded)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{row.avg_dq ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{row.avg_prob ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Migration matrix */}
      {data.matrix.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono font-bold tracking-widest uppercase">
              Migration Matrix (Old → New)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Old Category</TableHead>
                  <TableHead>New Category</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">Graded</TableHead>
                  <TableHead className="text-right">Accuracy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.matrix.map((row) => (
                  <TableRow key={`${row.old_category}→${row.new_category}`}>
                    <TableCell>
                      <Badge variant={TIER_VARIANT[row.old_category] ?? 'outline'} className="font-mono text-xs">
                        {getRecommendationLabel(row.old_category)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={TIER_VARIANT[row.new_category] ?? 'outline'} className="font-mono text-xs">
                        {getRecommendationLabel(row.new_category)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{row.count}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{row.graded}</TableCell>
                    <TableCell className="text-right font-mono text-sm font-bold">
                      {pct(row.wins, row.graded)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {data.matrix.length === 0 && data.summary.v2_computed === 0 && (
        <div className="text-center text-muted-foreground font-mono text-sm py-8">
          No v2 data yet. Click "Run Shadow Replay" to compute{' '}
          <code>recommendation_v2</code> for all stored predictions.
        </div>
      )}
    </div>
  )
}
