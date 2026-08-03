import { useRef } from "react"
import { useParams, useLocation, useSearch } from "wouter"
import { Button } from "@/components/ui/button"
import { ChevronLeft, ChevronRight } from "lucide-react"
import PredictionResultPage from "./PredictionResult"

const SWIPE_THRESHOLD_PX = 50

/**
 * Task #97: thin navigation wrapper around the unchanged single-prediction detail page. When a
 * prediction was created as part of a bulk-screenshot batch, its URL carries a `batch` query
 * param (an ordered, comma-separated list of prediction ids for that run) -- this wrapper reads
 * that list to show "Match X of N" plus prev/next controls and a horizontal swipe gesture, and
 * just re-navigates to the same route with the next id. A prediction opened without a `batch`
 * param (the normal single-prediction flow) renders PredictionResultPage with no wrapper chrome
 * at all, so nothing changes for that path.
 */
export default function PredictionResultView() {
  const params = useParams()
  const [, setLocation] = useLocation()
  const searchString = useSearch()
  const touchStartX = useRef<number | null>(null)

  const searchParams = new URLSearchParams(searchString)
  const batchParam = searchParams.get("batch")
  const fromParam = searchParams.get("from") ?? ""
  const fromLedger = fromParam === "ledger"
  const fromHome = fromParam === "home"

  const batchIds = batchParam
    ? batchParam
        .split(",")
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n))
    : null

  const currentId = parseInt(params.id || "0", 10)
  const currentIndex = batchIds ? batchIds.indexOf(currentId) : -1
  const showNav = !!batchIds && batchIds.length > 1 && currentIndex >= 0

  // Preserve origin context when stepping through a batch so Back always
  // returns to wherever this batch was started from, not just /predict.
  const fromSuffix = fromParam ? `&from=${fromParam}` : ""

  const goTo = (index: number) => {
    if (!batchIds) return
    const clamped = Math.max(0, Math.min(batchIds.length - 1, index))
    if (clamped === currentIndex) return
    setLocation(`/predictions/${batchIds[clamped]}?batch=${batchIds.join(",")}${fromSuffix}`)
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    const startX = touchStartX.current
    touchStartX.current = null
    if (startX === null) return
    const endX = e.changedTouches[0]?.clientX ?? startX
    const delta = endX - startX
    if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return
    if (delta < 0) goTo(currentIndex + 1)
    else goTo(currentIndex - 1)
  }

  return (
    <div onTouchStart={showNav ? handleTouchStart : undefined} onTouchEnd={showNav ? handleTouchEnd : undefined}>
      {/* Back button — returns to whichever page originated this prediction */}
      <div className="mb-4">
        <Button
          variant="ghost"
          size="sm"
          className="font-mono text-xs text-muted-foreground hover:text-foreground gap-1 -ml-2"
          onClick={() => setLocation(fromLedger ? "/history" : fromHome ? "/" : "/predict")}
        >
          <ChevronLeft className="w-4 h-4" />
          {fromLedger ? "BACK TO PREDICTION HISTORY" : fromHome ? "BACK TO HOME" : "BACK TO RUN MODEL"}
        </Button>
      </div>

      {showNav && (
        <div className="sticky top-[3.75rem] z-10 mb-6 flex items-center justify-between gap-3 rounded-lg border bg-background/95 backdrop-blur p-3 shadow-sm">
          <Button
            variant="outline"
            size="sm"
            className="font-mono"
            disabled={currentIndex <= 0}
            onClick={() => goTo(currentIndex - 1)}
          >
            <ChevronLeft className="w-4 h-4 mr-1" /> PREV
          </Button>
          <span className="text-sm font-bold font-mono text-muted-foreground">
            MATCH {currentIndex + 1} OF {batchIds!.length}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="font-mono"
            disabled={currentIndex >= batchIds!.length - 1}
            onClick={() => goTo(currentIndex + 1)}
          >
            NEXT <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      )}
      <PredictionResultPage />
    </div>
  )
}
