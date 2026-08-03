import type { PredictionSummary } from "@workspace/api-client-react"

/**
 * Hands paste-search results off across a page navigation (Run Model -> Prediction History). This is a
 * one-shot, same-session transfer -- NOT the durable "survive a mid-review refresh" persistence
 * tracked separately (see the Ledger paste-search refresh task); it exists purely so the resolved
 * matches picked in the "PASTE SEARCH" tab (now on Run Model) can be handed to the Prediction History
 * page, which is the only place that renders the focus/navigation UI for them.
 */
const STORAGE_KEY = "ledger-paste-search-handoff"

export function storePasteSearchHandoff(predictions: PredictionSummary[], startIndex: number) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ predictions, startIndex }))
  } catch {
    // sessionStorage can throw (private browsing quota, etc.) -- the Ledger just won't have
    // anything to focus on arrival, a safe and silent fallback rather than a crash.
  }
}

export function readAndClearPasteSearchHandoff(): { predictions: PredictionSummary[]; startIndex: number } | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    sessionStorage.removeItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.predictions) || parsed.predictions.length === 0) return null
    return {
      predictions: parsed.predictions as PredictionSummary[],
      startIndex: typeof parsed.startIndex === "number" ? parsed.startIndex : 0,
    }
  } catch {
    return null
  }
}
