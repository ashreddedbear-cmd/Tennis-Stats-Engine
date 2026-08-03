import { useState, useEffect, useCallback } from "react"
import { useLocation } from "wouter"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Bookmark, ExternalLink, Copy, Trash2, RefreshCw, BookmarkX, Layers } from "lucide-react"
import { getRecommendationLabel } from "@/lib/recommendationLabels"

const PARLAY_DRAFT_KEY = "parlayDraft.pending.v1"

interface ParlayDraftLeg {
  player1Name: string
  player1Id: number | null
  player2Name: string
  player2Id: number | null
  tournamentName: string | undefined
  surface: string | undefined
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
const api = (path: string) => `${BASE}${path}`

interface SavedCard {
  id: number
  predictionId: number
  note: string | null
  savedAt: string
  player1Name: string
  player2Name: string
  surface: string
  tournamentName: string | null
  tournamentLevel: string | null
  recommendation: string
  calibratedProbability: number
  predictedWinnerName: string
  predictedWinnerProbability: number
  createdAt: string
}

function recommendationBadgeClass(rec: string): string {
  if (rec === "HIGH_CONFIDENCE" || rec === "high_confidence") return "bg-success/15 text-success border-success/30"
  if (rec === "MODERATE" || rec === "moderate") return "bg-primary/10 text-primary border-primary/30"
  if (rec === "LOW_CONFIDENCE" || rec === "low_confidence") return "bg-warning/15 text-warning border-warning/30"
  return "bg-muted text-muted-foreground border-border"
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso))
  } catch {
    return iso
  }
}

export function SavedPredictionCards({ isAdmin }: { isAdmin?: boolean } = {}) {
  const [, setLocation] = useLocation()
  const { toast } = useToast()
  const [cards, setCards] = useState<SavedCard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const handleBuildParlay = () => {
    if (cards.length === 0) return
    const legs: ParlayDraftLeg[] = cards.map(card => ({
      player1Name: card.player1Name,
      player1Id: null,
      player2Name: card.player2Name,
      player2Id: null,
      tournamentName: card.tournamentName ?? undefined,
      surface: card.surface,
    }))
    try {
      sessionStorage.setItem(PARLAY_DRAFT_KEY, JSON.stringify(legs))
    } catch { /* sessionStorage unavailable — page will open empty */ }
    setLocation("/admin/parlay-builder?draft=1")
  }

  const fetchCards = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(api("/api/saved-cards"), { credentials: "include" })
      if (res.status === 401) {
        setError("Sign in to view your saved prediction cards.")
        return
      }
      if (!res.ok) {
        setError(`Could not load saved cards (server returned ${res.status}). Try again shortly.`)
        return
      }
      const text = await res.text()
      let data: { cards?: SavedCard[] }
      try { data = JSON.parse(text) } catch {
        setError("Unexpected response from server. Please refresh and try again.")
        return
      }
      setCards(data.cards ?? [])
    } catch {
      setError("Network error — check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchCards() }, [fetchCards])

  const handleDelete = async (card: SavedCard) => {
    setDeletingId(card.id)
    try {
      await fetch(api(`/api/saved-cards/${card.id}`), { method: "DELETE", credentials: "include" })
      setCards(prev => prev.filter(c => c.id !== card.id))
      toast({ title: "Card removed from saved" })
    } catch {
      toast({ title: "Failed to remove card", variant: "destructive" })
    } finally {
      setDeletingId(null)
    }
  }

  const handleCopy = (card: SavedCard) => {
    const recLabel = getRecommendationLabel(card.recommendation)
    const prob = card.predictedWinnerProbability.toFixed(1)
    const venue = card.tournamentName ?? card.surface
    const line = `${card.predictedWinnerName} to win — ${recLabel} (${prob}%) | ${card.player1Name} vs ${card.player2Name} | ${venue}`
    navigator.clipboard.writeText(line).then(
      () => toast({ title: "✅ Copied to clipboard" }),
      () => toast({ title: "Copy failed — try again", variant: "destructive" }),
    )
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
        <RefreshCw className="w-5 h-5 animate-spin" />
        <p className="text-xs font-mono">Loading saved cards…</p>
      </div>
    )
  }

  // ── Error / unauthenticated ────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-center px-4">
        <BookmarkX className="w-8 h-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground font-mono">{error}</p>
      </div>
    )
  }

  // ── Empty ──────────────────────────────────────────────────────────────────
  if (cards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-center px-4">
        <Bookmark className="w-8 h-8 text-muted-foreground/30" />
        <p className="text-sm font-bold font-mono text-muted-foreground">No saved cards yet</p>
        <p className="text-xs text-muted-foreground/70 font-mono max-w-[260px]">
          Open any prediction result and tap <strong>Save</strong> to bookmark it here.
        </p>
      </div>
    )
  }

  // ── Card list ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase">
          {cards.length} saved card{cards.length !== 1 ? "s" : ""}
        </p>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px] font-mono gap-1 border-amber-500/50 text-amber-400 hover:bg-amber-500/10 hover:border-amber-400"
              onClick={handleBuildParlay}
            >
              <Layers className="w-3 h-3" /> Build Parlay
            </Button>
          )}
          <button
            onClick={fetchCards}
            className="text-[10px] font-mono text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {cards.map(card => (
        <div
          key={card.id}
          className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2 hover:border-border transition-colors"
        >
          {/* Match line */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-bold font-display leading-tight truncate">
                {card.player1Name}
                <span className="text-muted-foreground font-normal text-xs mx-1.5">vs</span>
                {card.player2Name}
              </p>
              <p className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">
                {card.tournamentName ?? card.surface}
                {card.tournamentName && <span className="ml-1 opacity-60">· {card.surface}</span>}
              </p>
            </div>
            <Badge
              variant="outline"
              className={`text-[9px] font-mono font-bold shrink-0 px-1.5 py-0.5 ${recommendationBadgeClass(card.recommendation)}`}
            >
              {getRecommendationLabel(card.recommendation)}
            </Badge>
          </div>

          {/* Pick line */}
          <p className="text-[11px] font-mono text-foreground/80">
            Pick: <span className="font-bold">{card.predictedWinnerName}</span>
            <span className="text-muted-foreground ml-1">({card.predictedWinnerProbability.toFixed(1)}%)</span>
          </p>

          {/* Note */}
          {card.note && (
            <p className="text-[10px] font-mono text-muted-foreground italic border-l-2 border-border pl-2">
              {card.note}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-1 pt-0.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] font-mono gap-1 flex-1"
              onClick={() => setLocation(`/predictions/${card.predictionId}`)}
            >
              <ExternalLink className="w-3 h-3" /> View
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] font-mono gap-1 flex-1"
              onClick={() => handleCopy(card)}
            >
              <Copy className="w-3 h-3" /> Copy
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] font-mono gap-1 text-destructive border-destructive/30 hover:bg-destructive/10"
              onClick={() => handleDelete(card)}
              disabled={deletingId === card.id}
            >
              {deletingId === card.id
                ? <RefreshCw className="w-3 h-3 animate-spin" />
                : <Trash2 className="w-3 h-3" />}
            </Button>
          </div>

          <p className="text-[9px] font-mono text-muted-foreground/50">
            Saved {formatDate(card.savedAt)}
          </p>
        </div>
      ))}
    </div>
  )
}
