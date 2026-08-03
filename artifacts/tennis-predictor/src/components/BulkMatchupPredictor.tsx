import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import { useLocation } from "wouter"
import {
  recognizeMatchupScreenshot,
  type ScreenshotMatchupResult,
  type ScreenshotMatchupInput,
  type Surface,
  type TournamentLevel,
  type MatchFormat,
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { RecognizedChip } from "@/components/ScreenshotMatchupUpload"
import {
  Layers, RefreshCw, AlertTriangle, CheckCircle2, XCircle, Activity, History, Trash2, X,
  ChevronDown, Settings2, Copy, Bug, FileText, RotateCcw,
} from "lucide-react"
import { isGrandSlam } from "@/lib/grandSlam"
import { buildClientMatchId, createPredictionWithIntegrity } from "@/lib/predictionRequestIntegrity"
import { useGetAdminAuthStatus } from "@/hooks/useGetAdminAuthStatus"
import { useAuth } from "@clerk/react"

const MAX_FILES = 150

const STORAGE_KEY = "bulkMatchupPredictor.batch.v1"

// ---------------------------------------------------------------------------
// Parlay draft handoff — written here, read by AdminParlayBuilder on mount.
// Contains only neutral match identity: player names/IDs, tournament, surface.
// No prediction engine fields (calibratedProbability, grade, etc.) are included.
// ---------------------------------------------------------------------------
const PARLAY_DRAFT_KEY = "parlayDraft.pending.v1"

interface ParlayDraftLeg {
  player1Name: string
  player1Id: string | null
  player2Name: string
  player2Id: string | null
  tournamentName: string | null
  surface: string | null
}

// ---------------------------------------------------------------------------
// Extended result type — the backend returns these alongside the standard fields.
// from-text-names returns a bulk { matchups: [...] } wrapper; from-screenshot
// returns a single ScreenshotMatchupResult (no matchups array).
// ScreenshotMatchupEntry was renamed to ScreenshotMatchupInput in the generated
// schema; we keep a local alias here to represent one entry in a bulk response.
// ---------------------------------------------------------------------------
type ScreenshotMatchupEntry = ScreenshotMatchupInput & {
  player1: ScreenshotMatchupResult["player1"]
  player2: ScreenshotMatchupResult["player2"]
  event: ScreenshotMatchupResult["event"]
  warnings: ScreenshotMatchupResult["warnings"]
  resolved?: boolean
}
type ScreenshotResultExtended = ScreenshotMatchupResult & {
  debugLog?: string[]
  rawText?: string
  /** Present when the endpoint returns multiple matchups (e.g. from-text-names). */
  matchups?: ScreenshotMatchupEntry[]
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------
function readStoredBatch(): BatchItem[] | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    if (!parsed.every((it) => it && typeof it === "object" && typeof it.key === "string" && typeof it.fileName === "string")) {
      return null
    }
    return parsed as BatchItem[]
  } catch {
    return null
  }
}

function writeStoredBatch(items: BatchItem[]) {
  try {
    if (items.length === 0) {
      sessionStorage.removeItem(STORAGE_KEY)
    } else {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    }
  } catch {
    // Best-effort — if sessionStorage is unavailable the batch simply won't survive a refresh.
  }
}

function clearStoredBatch() {
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

function sanitizeResumedItems(items: BatchItem[]): BatchItem[] {
  return items.map((it) => {
    if (it.status === "resolving") {
      return {
        ...it,
        status: "read-error" as ItemStatus,
        errorMessage: "This screenshot's data was lost when the page refreshed. Re-upload it to include it in the batch.",
      }
    }
    if (it.predictStatus === "pending") return { ...it, predictStatus: "idle" as PredictStatus }
    return it
  })
}

const RESOLVE_CONCURRENCY = 4

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let nextIndex = 0
  async function runNext(): Promise<void> {
    const index = nextIndex++
    if (index >= items.length) return
    await worker(items[index], index)
    await runNext()
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext))
}

function fileToBase64DataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

type ItemStatus = "resolving" | "resolved" | "unresolved" | "read-error"
type PredictStatus = "idle" | "pending" | "success" | "error"

interface BatchItem {
  key: string
  fileName: string
  selected: boolean
  status: ItemStatus
  result: ScreenshotMatchupResult | null
  errorMessage: string | null
  // Match conditions sent to the engine — each is editable per-item inline
  surface: Surface
  level: TournamentLevel
  matchFormat: MatchFormat
  tournamentName: string | null
  // Whether each condition was detected from the screenshot (vs defaulted)
  surfaceDetected: boolean
  levelDetected: boolean
  tournamentDetected: boolean
  // Per-item conditions panel open/closed
  conditionsExpanded: boolean
  predictStatus: PredictStatus
  predictionId: number | null
  predictError: string | null
  // Debug diagnostics from the recognition pipeline
  debugLog?: string[]
  rawText?: string
  // Raw text editing fallback state
  rawTextEditing?: boolean
  rawTextDraft?: string
  rawTextParsing?: boolean
  rawTextError?: string | null
}

function isReady(item: BatchItem): boolean {
  return item.status === "resolved"
}

function needsPredicting(item: BatchItem): boolean {
  return isReady(item) && item.predictStatus !== "success"
}

function entryToResult(m: Pick<ScreenshotMatchupResult, "player1" | "player2" | "event" | "warnings">): ScreenshotMatchupResult {
  return { player1: m.player1, player2: m.player2, event: m.event, warnings: m.warnings }
}

function makeDefaultItem(key: string, fileName: string): BatchItem {
  return {
    key,
    fileName,
    selected: false,
    status: "resolving",
    result: null,
    errorMessage: null,
    surface: "Hard",
    level: "ATP250",
    matchFormat: "BestOf3",
    tournamentName: null,
    surfaceDetected: false,
    levelDetected: false,
    tournamentDetected: false,
    conditionsExpanded: false,
    predictStatus: "idle",
    predictionId: null,
    predictError: null,
  }
}

// ---------------------------------------------------------------------------
// Surface colour helper
// ---------------------------------------------------------------------------
function surfaceColour(s: Surface) {
  if (s === "Clay") return "text-orange-500"
  if (s === "Grass") return "text-green-500"
  if (s === "IndoorHard") return "text-purple-400"
  return "text-blue-400"
}

// ---------------------------------------------------------------------------
// Missing-data summary
// ---------------------------------------------------------------------------
interface DataGap { label: string; count: number; tip: string }

function computeGaps(items: BatchItem[]): DataGap[] {
  const ready = items.filter(isReady)
  if (ready.length === 0) return []
  const gaps: DataGap[] = []
  const noSurface = ready.filter((i) => !i.surfaceDetected).length
  const noTournament = ready.filter((i) => !i.tournamentDetected).length
  const noLevel = ready.filter((i) => !i.levelDetected).length
  if (noSurface > 0) gaps.push({ label: `${noSurface} match${noSurface > 1 ? "es" : ""}: surface not detected`, tip: "Defaulting to Hard. Tap ▸ Edit Conditions on any row to correct it.", count: noSurface })
  if (noTournament > 0) gaps.push({ label: `${noTournament} match${noTournament > 1 ? "es" : ""}: no tournament name`, tip: "Venue weather and travel distance won't be available.", count: noTournament })
  if (noLevel > 0) gaps.push({ label: `${noLevel} match${noLevel > 1 ? "es" : ""}: level not detected`, tip: "Defaulting to ATP 250. Tap ▸ Edit Conditions on any row to correct it.", count: noLevel })
  return gaps
}

// ---------------------------------------------------------------------------
// Raw-text client-side parser
// Turns user-edited text into name pairs to send to /api/matchups/from-text-names
// ---------------------------------------------------------------------------
interface NamePair { player1Name: string; player2Name: string; eventName: string | null }

function parseRawTextMatchups(text: string): NamePair[] {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 1)
  const results: NamePair[] = []

  for (const line of lines) {
    // "Player A vs Player B" / "A v B" / "A - B" / "A – B"
    const vsMatch = line.match(/^(.+?)\s+(?:vs?\.?|[-–—])\s+(.+)$/i)
    if (vsMatch) {
      const p1 = vsMatch[1].trim().replace(/^\(\d+\)\s*/, "").replace(/\s*\(\d+\)$/, "")
      const p2 = vsMatch[2].trim().replace(/^\(\d+\)\s*/, "").replace(/\s*\(\d+\)$/, "")
      if (p1.length > 1 && p2.length > 1) {
        results.push({ player1Name: p1, player2Name: p2, eventName: null })
      }
    }
  }

  // Fallback: consecutive non-empty line pairs → one matchup
  if (results.length === 0 && lines.length >= 2) {
    for (let i = 0; i + 1 < lines.length; i += 2) {
      if (lines[i].length > 1 && lines[i + 1].length > 1) {
        results.push({ player1Name: lines[i], player2Name: lines[i + 1], eventName: null })
      }
    }
  }

  return results
}

async function resolveFromTextNames(pairs: NamePair[]): Promise<ScreenshotResultExtended> {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
  const res = await fetch(`${BASE}/api/matchups/from-text-names`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchups: pairs }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; detail?: string }
    throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<ScreenshotResultExtended>
}

// ---------------------------------------------------------------------------
// Debug helpers
// ---------------------------------------------------------------------------
function buildDebugText(item: BatchItem): string {
  const lines: string[] = [
    `FILE: ${item.fileName}`,
    `STATUS: ${item.status}`,
    `ERROR: ${item.errorMessage ?? "none"}`,
    "",
  ]
  if (item.debugLog && item.debugLog.length > 0) {
    lines.push("=== PIPELINE LOG ===")
    lines.push(...item.debugLog)
    lines.push("")
  }
  if (item.rawText) {
    lines.push("=== RAW MODEL OUTPUT ===")
    lines.push(item.rawText)
  }
  return lines.join("\n")
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface BulkMatchupPredictorHandle {
  handleFiles: (files: File[]) => void
}

export const BulkMatchupPredictor = forwardRef<BulkMatchupPredictorHandle>(function BulkMatchupPredictor(_props, ref) {
  const [, setLocation] = useLocation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<BatchItem[]>([])
  const [selectionWarning, setSelectionWarning] = useState<string | null>(null)
  const [isPredicting, setIsPredicting] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [predictSummary, setPredictSummary] = useState<{ successIds: number[]; failedCount: number } | null>(null)
  const [resumableBatch, setResumableBatch] = useState<BatchItem[] | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const { data: adminAuth } = useGetAdminAuthStatus()
  const isAdmin = adminAuth?.authenticated === true
  const { isSignedIn } = useAuth()
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")

  useEffect(() => {
    const batch = readStoredBatch()
    if (!batch) return
    const sanitized = sanitizeResumedItems(batch)
    // If every resolved item has already been predicted, restore silently — no resume
    // banner needed when the user is just returning to view a completed batch.
    const allDone = sanitized.every(
      (it) => it.status !== "resolved" || it.predictStatus === "success",
    )
    if (allDone) {
      setItems(sanitized)
    } else {
      setResumableBatch(sanitized)
    }
  }, [])
  useEffect(() => { if (items.length > 0) writeStoredBatch(items) }, [items])

  const resolvedCount = items.filter(isReady).length
  const pendingPredictCount = items.filter(needsPredicting).length
  const alreadyPredictedCount = resolvedCount - pendingPredictCount
  const donePredictionIds = items
    .filter((i) => i.predictStatus === "success" && i.predictionId != null)
    .map((i) => i.predictionId as number)
  const hasItems = items.length > 0
  const anyResolving = items.some((i) => i.status === "resolving")
  const selectedItemCount = items.filter((i) => i.selected).length
  const gaps = computeGaps(items)

  // ---------------------------------------------------------------------------
  // Resume / discard
  // ---------------------------------------------------------------------------
  const handleResume = () => {
    if (!resumableBatch) return
    setBatchError(null); setSelectionWarning(null)
    setItems(sanitizeResumedItems(resumableBatch))
    setResumableBatch(null)
  }
  const handleDiscardResumable = () => { clearStoredBatch(); setResumableBatch(null) }
  const handleClearAll = () => {
    setItems([])
    setBatchError(null)
    setSelectionWarning(null)
    setResumableBatch(null)
    clearStoredBatch()
  }
  const handleRemoveSelected = () => {
    setItems((prev) => {
      const next = prev.filter((it) => !it.selected)
      if (next.length === 0) clearStoredBatch()
      return next
    })
  }
  const handleDeleteItem = (key: string) => {
    setItems((prev) => {
      const next = prev.filter((it) => it.key !== key)
      if (next.length === 0) clearStoredBatch()
      return next
    })
  }

  // ---------------------------------------------------------------------------
  // Per-item updates
  // ---------------------------------------------------------------------------
  function updateItem(key: string, patch: Partial<BatchItem>) {
    setItems((prev) => prev.map((it) => it.key === key ? { ...it, ...patch } : it))
  }
  function toggleConditions(key: string) {
    setItems((prev) => prev.map((it) => it.key === key ? { ...it, conditionsExpanded: !it.conditionsExpanded } : it))
  }
  function toggleSelected(key: string) {
    setItems((prev) => prev.map((it) => it.key === key ? { ...it, selected: !it.selected } : it))
  }

  // ---------------------------------------------------------------------------
  // File handling
  // ---------------------------------------------------------------------------
  useImperativeHandle(ref, () => ({ handleFiles: (files: File[]) => { void handleFiles(files) } }))

  const handleFiles = async (files: File[]) => {
    setBatchError(null); setSelectionWarning(null)
    clearStoredBatch(); setResumableBatch(null)

    let toProcess = files
    if (toProcess.length > MAX_FILES) {
      setSelectionWarning(`You selected ${files.length} screenshots — only the first ${MAX_FILES} were used.`)
      toProcess = toProcess.slice(0, MAX_FILES)
    }

    const initialItems: BatchItem[] = toProcess.map((file) =>
      makeDefaultItem(`${file.name}-${file.lastModified}-${crypto.randomUUID()}`, file.name)
    )
    setItems(initialItems)

    await runWithConcurrency(toProcess, RESOLVE_CONCURRENCY, async (file, index) => {
      const key = initialItems[index].key
      console.log(`[SCREENSHOT] [1/13] File received: ${file.name} type=${file.type} size=${file.size}B`)

      try {
        console.log(`[SCREENSHOT] [4/13] Converting to base64 data URL`)
        const imageBase64 = await fileToBase64DataUrl(file)
        console.log(`[SCREENSHOT] [5/13] Sending OCR request — base64 length=${imageBase64.length}`)

        const rawResult = await recognizeMatchupScreenshot({ imageBase64 }) as ScreenshotResultExtended
        const { debugLog, rawText } = rawResult
        // Use rawResult (which carries the extended matchups field) rather than re-casting.
        const result = rawResult

        console.log(`[SCREENSHOT] [8/13] OCR response received — matchups=${result.matchups?.length ?? 0} warnings=${result.warnings.length}`)
        if (debugLog) console.log(`[SCREENSHOT] Pipeline log:\n${debugLog.join("\n")}`)

        if (result.matchups && result.matchups.length > 1) {
          console.log(`[SCREENSHOT] [10/13] Expanding ${result.matchups.length} matchups into separate rows`)
          const expandedItems: BatchItem[] = result.matchups.map((m, mi) => {
            // Grand Slam ATP men's draws are Best-of-5; all others remain Best-of-3.
            const mTournament = m.event.recognizedName ?? null
            const mIsATP = m.player1.player?.tour === "ATP" || m.player2.player?.tour === "ATP"
            const mFormat: MatchFormat = isGrandSlam(mTournament) && mIsATP ? "BestOf5" : "BestOf3"
            return ({
              ...makeDefaultItem(`${key}-m${mi}`, mi === 0 ? file.name : `${file.name} (match ${mi + 1} of ${result.matchups!.length})`),
              status: (m.resolved ? "resolved" : "unresolved") as ItemStatus,
              result: entryToResult(m),
              errorMessage: m.resolved ? null : (m.warnings[0] ?? "Couldn't resolve this matchup from the screenshot."),
              surface: (m.event.surface ?? "Hard") as Surface,
              level: (m.event.level ?? "ATP250") as TournamentLevel,
              matchFormat: mFormat,
              tournamentName: mTournament,
              surfaceDetected: !!m.event.surface,
              levelDetected: !!m.event.level,
              tournamentDetected: !!m.event.recognizedName,
              debugLog,
              rawText,
            })
          })
          console.log(`[SCREENSHOT] [12/13] ${expandedItems.filter(e => e.status === "resolved").length}/${expandedItems.length} matchups resolved`)
          setItems((prev) => {
            const idx = prev.findIndex((it) => it.key === key)
            if (idx === -1) return prev
            return [...prev.slice(0, idx), ...expandedItems, ...prev.slice(idx + 1)]
          })
        } else {
          const ready = !!result.player1.player && !!result.player2.player
          const detectedSurface = result.event.surface as Surface | null
          const detectedLevel = result.event.level as TournamentLevel | null
          const detectedTournament = result.event.recognizedName ?? null
          // Grand Slam ATP men's draws are Best-of-5; all others remain Best-of-3.
          const singleIsATP = result.player1.player?.tour === "ATP" || result.player2.player?.tour === "ATP"
          const detectedFormat: MatchFormat = isGrandSlam(detectedTournament) && singleIsATP ? "BestOf5" : "BestOf3"
          console.log(`[SCREENSHOT] [10/13] Single match: resolved=${ready} surface=${detectedSurface} tournament=${detectedTournament} format=${detectedFormat}`)
          setItems((prev) =>
            prev.map((it) =>
              it.key === key
                ? {
                    ...it,
                    status: ready ? "resolved" : "unresolved",
                    result,
                    errorMessage: ready ? null : (result.warnings[0] ?? "Couldn't confidently resolve both players from this screenshot."),
                    surface: detectedSurface ?? it.surface,
                    level: detectedLevel ?? it.level,
                    matchFormat: detectedFormat,
                    tournamentName: detectedTournament,
                    surfaceDetected: !!detectedSurface,
                    levelDetected: !!detectedLevel,
                    tournamentDetected: !!detectedTournament,
                    debugLog,
                    rawText,
                  }
                : it,
            ),
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Extract debugLog from ApiError.data if available (502 responses include it)
        const errData = (err as { data?: { debugLog?: string[]; detail?: string } }).data
        const debugLog: string[] | undefined = errData?.debugLog
        const detail = errData?.detail ?? msg

        console.error(`[SCREENSHOT] [13/13] Error for ${file.name}: ${detail}`)
        if (debugLog) console.error(`[SCREENSHOT] Debug log:\n${debugLog.join("\n")}`)

        const isQuota = msg.toLowerCase().includes("quota") || msg.includes("502") || msg.includes("insufficient")
        const isAuth = msg.includes("401") || msg.includes("403") || msg.toLowerCase().includes("invalid_api_key")
        const isNoKey = msg.toLowerCase().includes("no vision ai key") || msg.toLowerCase().includes("no key")

        let friendlyError = "Couldn't read this screenshot. Try a clearer image."
        if (isNoKey) friendlyError = "Vision AI is not configured — no API key is set up."
        else if (isAuth) friendlyError = "Vision AI authentication failed — check your API key."
        else if (isQuota) friendlyError = "Vision AI quota exhausted — all configured providers are out of credits."

        setItems((prev) =>
          prev.map((it) =>
            it.key === key
              ? {
                  ...it,
                  status: "read-error",
                  errorMessage: friendlyError,
                  debugLog,
                }
              : it,
          ),
        )
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Raw text fallback: Parse & Retry
  // ---------------------------------------------------------------------------
  const handleParseRawText = async (key: string, draft: string) => {
    const pairs = parseRawTextMatchups(draft)
    if (pairs.length === 0) {
      updateItem(key, { rawTextError: "No matchups found in that text. Use 'Player A vs Player B' format." })
      return
    }
    updateItem(key, { rawTextParsing: true, rawTextError: null })
    try {
      const result = await resolveFromTextNames(pairs) as ScreenshotResultExtended

      if (result.matchups && result.matchups.length > 1) {
        const expandedItems: BatchItem[] = result.matchups.map((m, mi) => {
          const mTournament = m.event.recognizedName ?? null
          const mIsATP = m.player1.player?.tour === "ATP" || m.player2.player?.tour === "ATP"
          const mFormat: MatchFormat = isGrandSlam(mTournament) && mIsATP ? "BestOf5" : "BestOf3"
          return ({
            ...makeDefaultItem(`${key}-text-m${mi}`, mi === 0 ? "Text import" : `Text import (${mi + 1} of ${result.matchups!.length})`),
            status: (m.resolved ? "resolved" : "unresolved") as ItemStatus,
            result: entryToResult(m),
            errorMessage: m.resolved ? null : (m.warnings[0] ?? "Couldn't resolve this matchup."),
            surface: (m.event.surface ?? "Hard") as Surface,
            level: (m.event.level ?? "ATP250") as TournamentLevel,
            matchFormat: mFormat,
            tournamentName: mTournament,
            surfaceDetected: !!m.event.surface,
            levelDetected: !!m.event.level,
            tournamentDetected: !!m.event.recognizedName,
          })
        })
        setItems((prev) => {
          const idx = prev.findIndex((it) => it.key === key)
          if (idx === -1) return prev
          return [...prev.slice(0, idx), ...expandedItems, ...prev.slice(idx + 1)]
        })
      } else {
        const ready = !!result.player1.player && !!result.player2.player
        const txtTournament = result.event.recognizedName ?? null
        const txtIsATP = result.player1.player?.tour === "ATP" || result.player2.player?.tour === "ATP"
        const txtFormat: MatchFormat = isGrandSlam(txtTournament) && txtIsATP ? "BestOf5" : "BestOf3"
        updateItem(key, {
          status: ready ? "resolved" : "unresolved",
          result,
          rawTextEditing: false,
          rawTextParsing: false,
          errorMessage: ready ? null : (result.warnings[0] ?? "Couldn't match these names to known players."),
          surface: (result.event.surface as Surface | null) ?? "Hard",
          level: (result.event.level as TournamentLevel | null) ?? "ATP250",
          matchFormat: txtFormat,
          tournamentName: txtTournament,
          surfaceDetected: !!result.event.surface,
          levelDetected: !!result.event.level,
          tournamentDetected: !!result.event.recognizedName,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      updateItem(key, { rawTextParsing: false, rawTextError: `Failed to resolve names: ${msg}` })
    }
  }

  // ---------------------------------------------------------------------------
  // Copy debug details
  // ---------------------------------------------------------------------------
  const handleCopyDebug = async (item: BatchItem) => {
    const text = buildDebugText(item)
    const ok = await copyToClipboard(text)
    if (ok) {
      setCopiedKey(item.key)
      setTimeout(() => setCopiedKey((k) => k === item.key ? null : k), 2000)
    }
  }

  // ---------------------------------------------------------------------------
  // Predict
  // ---------------------------------------------------------------------------

  /**
   * Runs predictions for all ready, not-yet-predicted items.
   * Accepts an optional `snapshot` so callers (e.g. retry) can pass a pre-reset
   * items list without waiting for a React state flush.
   * Returns the IDs of successfully created predictions and the keys of failed ones.
   */
  const handlePredict = async (
    snapshot?: BatchItem[],
  ): Promise<{ successIds: number[]; failedKeys: string[] }> => {
    setBatchError(null)
    setIsPredicting(true)
    const workItems = snapshot ?? items
    const readyKeys = workItems.filter(needsPredicting).map((i) => i.key)
    setItems((prev) => prev.map((it) => (readyKeys.includes(it.key) ? { ...it, predictStatus: "pending" } : it)))

    const successIds: number[] = []
    const failedKeys: string[] = []

    for (const item of workItems) {
      if (!needsPredicting(item) || !item.result?.player1.player || !item.result?.player2.player) continue
      const makePredictionRequest = () => {
        const requestMatchId = buildClientMatchId({
          source: "bulk",
          player1Id: item.result!.player1.player!.id,
          player2Id: item.result!.player2.player!.id,
          tournamentName: item.tournamentName,
          surface: item.surface,
          matchFormat: item.matchFormat,
        })
        return createPredictionWithIntegrity(
          {
            player1Id: item.result!.player1.player!.id,
            player2Id: item.result!.player2.player!.id,
            surface: item.surface,
            matchFormat: item.matchFormat,
            tournamentLevel: item.level,
            tournamentName: item.tournamentName,
          },
          {
            requestMatchId,
            submittedPlayer1Name: item.result!.player1.player!.name,
            submittedPlayer2Name: item.result!.player2.player!.name,
          },
        )
      }

      const isRateLimitError = (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        return msg === "Too many requests" || msg.includes("429") || msg.toLowerCase().includes("rate limit")
      }

      try {
        let prediction
        try {
          prediction = await makePredictionRequest()
        } catch (firstErr) {
          // Auto-retry once on rate limit: wait 15 s then try again so the user
          // never sees a rate-limit failure for a transient burst.
          if (isRateLimitError(firstErr)) {
            setItems((prev) =>
              prev.map((it) =>
                it.key === item.key ? { ...it, predictError: "Rate limit — retrying in 15 s…" } : it,
              ),
            )
            await new Promise((r) => setTimeout(r, 15_000))
            prediction = await makePredictionRequest()
          } else {
            throw firstErr
          }
        }
        successIds.push(prediction.id)
        setItems((prev) =>
          prev.map((it) => (it.key === item.key ? { ...it, predictStatus: "success", predictionId: prediction!.id } : it)),
        )
      } catch (err) {
        // The server returns { error: 'Too many requests', detail: '...' } on 429;
        // createPredictionWithIntegrity throws using the `error` field as the message.
        failedKeys.push(item.key)
        setItems((prev) =>
          prev.map((it) =>
            it.key === item.key
              ? {
                  ...it,
                  predictStatus: "error",
                  predictError: isRateLimitError(err)
                    ? "Rate limit reached — this matchup could not be retried. Try again in a few minutes."
                    : err instanceof Error && err.message && !err.message.startsWith("Integrity check")
                    ? err.message
                    : "Prediction engine error — this matchup could not be predicted.",
                }
              : it,
          ),
        )
      }
      // 500 ms pause between requests: spreads a 40-screenshot batch over ~3 min
      // which keeps bursts well within the 100-req/5-min rate limit.
      await new Promise((r) => setTimeout(r, 500))
    }

    // Also collect the IDs of matchups that were already predicted before this run
    // started — they are skipped by the loop above but must be included in the
    // auto-save so the Saved Prediction Cards folder always reflects the full batch,
    // not just the newly-run slice.
    const alreadySuccessIds = workItems
      .filter((i) => !needsPredicting(i) && i.predictionId != null)
      .map((i) => i.predictionId as number)

    setIsPredicting(false)
    return { successIds: [...alreadySuccessIds, ...successIds], failedKeys }
  }

  // ── Auto-save helper ────────────────────────────────────────────────────────
  // Replaces the user's entire saved-cards list with the current batch IDs so
  // the saved folder always reflects the latest run. Fire-and-forget — called
  // before navigation AND on partial success so cards are never silently skipped.
  const autoSaveBatch = (allIds: number[]) => {
    if (!isSignedIn || allIds.length === 0) return
    void (async () => {
      try {
        // 1. Clear previous saved batch
        await fetch(`${BASE}/api/saved-cards`, { method: "DELETE", credentials: "include" })
        // 2. Save every prediction from this run (already-predicted + newly run)
        await Promise.all(
          allIds.map((id) =>
            fetch(`${BASE}/api/saved-cards`, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ predictionId: id }),
            }),
          ),
        )
      } catch {
        // best-effort — navigation and results are unaffected
      }
    })()
  }

  /** Navigate to the batch results page. */
  const navigateToResults = (successIds: number[]) => {
    if (successIds.length === 0) return

    autoSaveBatch(successIds)

    try {
      localStorage.setItem(
        "savedBulkPredictionBatch.v1",
        JSON.stringify({ ids: successIds, savedAt: Date.now() }),
      )
    } catch {
      // localStorage unavailable (private-browse quota) — continue silently
    }
    // Do NOT call clearStoredBatch() here — we want the completed batch to persist in
    // sessionStorage so that returning to Run Model shows the predictions with their
    // PREDICTED badges rather than an empty state. The batch is only cleared when the
    // user starts a new one (handleFiles calls clearStoredBatch on upload).
    setLocation(`/predictions/${successIds[0]}?batch=${successIds.join(",")}`)
  }

  /**
   * Shared post-predict handler: decides whether to navigate (all success),
   * show a partial-success summary, or show an all-failed error.
   */
  const handlePredictOutcome = (successIds: number[], failedKeys: string[]) => {
    if (failedKeys.length === 0) {
      // All succeeded — auto-navigate (autoSaveBatch is called inside navigateToResults)
      navigateToResults(successIds)
    } else if (successIds.length === 0) {
      // All failed — stay on page with a clear error
      setBatchError("None of the matchups in this batch could be predicted. Check the error badges below and try again.")
    } else {
      // Partial success — auto-save the succeeded cards even though we stay on the
      // page (previously these were silently dropped because navigateToResults
      // was never called in this path).
      autoSaveBatch(successIds)
      setPredictSummary({ successIds, failedCount: failedKeys.length })
    }
  }

  const handlePredictClick = async () => {
    setPredictSummary(null)
    const { successIds, failedKeys } = await handlePredict()
    handlePredictOutcome(successIds, failedKeys)
  }

  /** Resets failed items to idle and re-runs predictions for them. */
  const handleRetryFailed = async () => {
    setPredictSummary(null)
    setBatchError(null)
    // Reset failed items to idle; pass the reset snapshot directly so handlePredict
    // doesn't read stale state before the React flush.
    const resetItems = items.map((it) =>
      it.predictStatus === "error" ? { ...it, predictStatus: "idle" as PredictStatus, predictError: null } : it,
    )
    setItems(resetItems)
    const { successIds, failedKeys } = await handlePredict(resetItems)
    handlePredictOutcome(successIds, failedKeys)
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-xs text-muted-foreground font-mono">
          Drop up to {MAX_FILES} screenshots — each image is read by the vision AI independently.
          Long images with multiple match cards are expanded into separate matchup rows automatically.
        </p>
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          {hasItems && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="font-mono shrink-0"
                disabled={selectedItemCount === 0}
                onClick={handleRemoveSelected}
              >
                <Trash2 className="w-4 h-4 mr-2" /> REMOVE SELECTED ({selectedItemCount})
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="font-mono shrink-0"
                disabled={items.length === 0}
                onClick={handleClearAll}
              >
                <X className="w-4 h-4 mr-2" /> CLEAR ALL
              </Button>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              if (files.length > 0) void handleFiles(files)
              e.target.value = ""
            }}
          />
          <Button
            variant="outline" size="sm" className="font-mono shrink-0"
            disabled={anyResolving || isPredicting}
            onClick={() => inputRef.current?.click()}
          >
            {anyResolving
              ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> READING...</>
              : <><Layers className="w-4 h-4 mr-2" /> SELECT SCREENSHOTS</>}
          </Button>
        </div>
      </div>

      {/* Resume banner */}
      {resumableBatch && !hasItems && (
        <div className="p-3 border border-primary/30 bg-primary/5 text-sm rounded-md font-mono flex items-start gap-3 flex-wrap">
          <History className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
          <div className="flex-1 min-w-[220px]">
            <p>
              Found an unfinished batch from before the page refreshed —{" "}
              {resumableBatch.length} item{resumableBatch.length === 1 ? "" : "s"}, {resumableBatch.filter(isReady).length} resolved.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button size="sm" variant="accent" className="font-mono" onClick={handleResume}>RESUME BATCH</Button>
            <Button size="sm" variant="outline" className="font-mono" onClick={handleDiscardResumable}>
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> DISCARD
            </Button>
          </div>
        </div>
      )}

      {selectionWarning && (
        <div className="p-3 border border-warning/30 bg-warning/10 text-sm rounded-md font-mono flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
          <div>{selectionWarning}</div>
        </div>
      )}

      {/* Item list */}
      {hasItems && (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.key} className="border rounded-md bg-secondary/20 overflow-hidden">
              {/* Main row */}
              <div className="p-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <label className="flex items-center gap-2 text-xs font-mono text-muted-foreground truncate max-w-[200px] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={() => toggleSelected(item.key)}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer"
                    />
                    <span className="truncate">{item.fileName}</span>
                  </label>
                  <div className="flex items-center gap-2 ml-auto shrink-0">
                    <ItemStatusBadge item={item} />
                    <button
                      onClick={() => handleDeleteItem(item.key)}
                      disabled={item.status === "resolving" || item.predictStatus === "pending"}
                      className="p-1 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      aria-label={`Remove ${item.fileName}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {item.status === "resolving" && (
                  <div className="mt-2 text-xs text-muted-foreground font-mono flex items-center gap-2">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Reading screenshot...
                  </div>
                )}

                {item.result && (
                  <div className="mt-2 flex flex-wrap gap-2 items-center">
                    <RecognizedChip label="P1" name={item.result.player1.recognizedName} matched={!!item.result.player1.player} />
                    <RecognizedChip label="P2" name={item.result.player2.recognizedName} matched={!!item.result.player2.player} />
                    {item.result.event.recognizedName && (
                      <RecognizedChip label="EVENT" name={item.result.event.recognizedName} matched={!!item.result.event.surface} />
                    )}
                    <span className={`text-[0.6rem] font-bold uppercase px-1.5 py-0.5 rounded bg-secondary font-mono ${surfaceColour(item.surface)} ${!item.surfaceDetected ? "opacity-50" : ""}`} title={item.surfaceDetected ? "Detected from screenshot" : "Default — not detected"}>
                      {item.surface}
                    </span>
                    <span className={`text-[0.6rem] text-muted-foreground uppercase font-mono px-1 py-0.5 rounded bg-secondary/60 ${!item.levelDetected ? "opacity-50" : ""}`} title={item.levelDetected ? "Detected from screenshot" : "Default — not detected"}>
                      {item.level}
                    </span>
                    <span className="text-[0.6rem] text-muted-foreground/60 uppercase font-mono px-1 py-0.5">
                      {item.matchFormat === "BestOf5" ? "BO5" : "BO3"}
                    </span>
                  </div>
                )}

                {/* ── Error / unresolved panel ── */}
                {(item.status === "unresolved" || item.status === "read-error") && item.errorMessage && (
                  <div className="mt-2 space-y-2">
                    {/* Main error message */}
                    <div className="text-xs text-destructive font-mono flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>{item.errorMessage} This item will be skipped unless you fix it.</span>
                    </div>

                    {/* Action row: Copy debug + raw text fallback */}
                    <div className="flex flex-wrap gap-2 pl-5">
                      {(item.debugLog && item.debugLog.length > 0) && (
                        <button
                          type="button"
                          onClick={() => handleCopyDebug(item)}
                          className="flex items-center gap-1 text-[0.6rem] font-mono text-muted-foreground/70 hover:text-muted-foreground transition-colors bg-secondary/40 px-2 py-1 rounded border border-border/40"
                        >
                          {copiedKey === item.key
                            ? <><CheckCircle2 className="w-3 h-3 text-success" /> COPIED</>
                            : <><Copy className="w-3 h-3" /> COPY DEBUG DETAILS</>}
                        </button>
                      )}
                      {item.rawText && !item.rawTextEditing && (
                        <button
                          type="button"
                          onClick={() => updateItem(item.key, { rawTextEditing: true, rawTextDraft: item.rawText, rawTextError: null })}
                          className="flex items-center gap-1 text-[0.6rem] font-mono text-muted-foreground/70 hover:text-muted-foreground transition-colors bg-secondary/40 px-2 py-1 rounded border border-border/40"
                        >
                          <FileText className="w-3 h-3" /> EDIT & RETRY FROM RAW TEXT
                        </button>
                      )}
                    </div>

                    {/* Debug log accordion */}
                    {item.debugLog && item.debugLog.length > 0 && (
                      <details className="pl-5">
                        <summary className="text-[0.6rem] font-mono text-muted-foreground/50 hover:text-muted-foreground cursor-pointer flex items-center gap-1">
                          <Bug className="w-3 h-3" /> Show diagnostic log ({item.debugLog.length} lines)
                        </summary>
                        <pre className="mt-1 text-[0.55rem] font-mono text-muted-foreground/60 bg-background/50 border border-border/30 rounded p-2 overflow-x-auto leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto">
                          {item.debugLog.join("\n")}
                        </pre>
                      </details>
                    )}

                    {/* Raw text fallback editor */}
                    {item.rawTextEditing && (
                      <div className="pl-5 space-y-2">
                        <p className="text-[0.6rem] font-mono text-muted-foreground/70">
                          Edit the raw text below — one matchup per line in <code>Player A vs Player B</code> format, or two consecutive lines per player.
                        </p>
                        <textarea
                          className="w-full text-xs font-mono bg-background border border-border rounded p-2 min-h-[80px] resize-y leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/50"
                          value={item.rawTextDraft ?? ""}
                          onChange={(e) => updateItem(item.key, { rawTextDraft: e.target.value })}
                          placeholder={"Novak Djokovic vs Carlos Alcaraz\nJannik Sinner vs Daniil Medvedev"}
                        />
                        {item.rawTextError && (
                          <p className="text-[0.6rem] text-destructive font-mono">{item.rawTextError}</p>
                        )}
                        <div className="flex gap-2">
                          <Button
                            size="sm" variant="outline" className="font-mono text-[0.65rem] h-7 px-3"
                            disabled={item.rawTextParsing}
                            onClick={() => handleParseRawText(item.key, item.rawTextDraft ?? "")}
                          >
                            {item.rawTextParsing
                              ? <><RefreshCw className="w-3 h-3 mr-1.5 animate-spin" /> RESOLVING...</>
                              : <><RotateCcw className="w-3 h-3 mr-1.5" /> PARSE & MATCH</>}
                          </Button>
                          <Button
                            size="sm" variant="ghost" className="font-mono text-[0.65rem] h-7 px-3 text-muted-foreground"
                            onClick={() => updateItem(item.key, { rawTextEditing: false, rawTextError: null })}
                          >
                            CANCEL
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {item.predictStatus === "error" && (
                  <div className="mt-2 text-xs text-destructive font-mono flex items-start gap-2">
                    <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{item.predictError}</span>
                  </div>
                )}

                {/* Edit conditions toggle — only for resolved items not yet predicted */}
                {item.status === "resolved" && item.predictStatus !== "success" && (
                  <button
                    type="button"
                    onClick={() => toggleConditions(item.key)}
                    className="mt-2 flex items-center gap-1 text-[0.6rem] font-mono text-muted-foreground/70 hover:text-muted-foreground transition-colors uppercase tracking-wide"
                  >
                    <Settings2 className="w-3 h-3" />
                    Edit conditions
                    <ChevronDown className={`w-3 h-3 transition-transform ${item.conditionsExpanded ? "rotate-180" : ""}`} />
                  </button>
                )}
              </div>

              {/* Inline conditions editor */}
              {item.conditionsExpanded && item.status === "resolved" && (
                <div className="border-t border-border/50 bg-secondary/10 p-3 space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <label className="text-[0.55rem] font-mono font-bold text-muted-foreground uppercase tracking-widest">Surface</label>
                      <Select
                        value={item.surface}
                        onChange={(e) => updateItem(item.key, { surface: e.target.value as Surface, surfaceDetected: true })}
                        className="h-7 text-xs bg-background/50"
                      >
                        <option value="Hard">Hard</option>
                        <option value="Clay">Clay</option>
                        <option value="Grass">Grass</option>
                        <option value="IndoorHard">Indoor Hard</option>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[0.55rem] font-mono font-bold text-muted-foreground uppercase tracking-widest">Format</label>
                      <Select
                        value={item.matchFormat}
                        onChange={(e) => updateItem(item.key, { matchFormat: e.target.value as MatchFormat })}
                        className="h-7 text-xs bg-background/50"
                      >
                        <option value="BestOf3">Best of 3</option>
                        <option value="BestOf5">Best of 5</option>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[0.55rem] font-mono font-bold text-muted-foreground uppercase tracking-widest">Level</label>
                      <Select
                        value={item.level}
                        onChange={(e) => updateItem(item.key, { level: e.target.value as TournamentLevel, levelDetected: true })}
                        className="h-7 text-xs bg-background/50"
                      >
                        <option value="GrandSlam">Grand Slam</option>
                        <option value="Masters1000">Masters 1000</option>
                        <option value="WTA1000">WTA 1000</option>
                        <option value="ATP500">ATP 500</option>
                        <option value="WTA500">WTA 500</option>
                        <option value="ATP250">ATP 250</option>
                        <option value="WTA250">WTA 250</option>
                        <option value="Challenger">Challenger</option>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[0.55rem] font-mono font-bold text-muted-foreground uppercase tracking-widest">Tournament name</label>
                    <Input
                      value={item.tournamentName ?? ""}
                      onChange={(e) => updateItem(item.key, { tournamentName: e.target.value || null, tournamentDetected: !!e.target.value })}
                      placeholder="e.g. Cincinnati Open (for venue weather)"
                      className="h-7 text-xs bg-background/50"
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Missing-data warnings */}
      {gaps.length > 0 && !anyResolving && (
        <div className="p-3 border border-warning/20 bg-warning/5 rounded-md space-y-1.5">
          <p className="text-[0.6rem] font-mono font-bold text-warning uppercase tracking-widest flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> Missing data — predictions will still run
          </p>
          {gaps.map((gap) => (
            <p key={gap.label} className="text-xs text-muted-foreground font-mono">
              <span className="text-warning/90">▸ {gap.label}</span> — {gap.tip}
            </p>
          ))}
        </div>
      )}

      {batchError && (
        <div className="p-3 border border-destructive/30 bg-destructive/10 text-destructive text-sm rounded-md font-mono flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>{batchError}</div>
        </div>
      )}

      {/* Partial-success summary — shown when some predictions succeeded and some failed */}
      {predictSummary && (
        <div className="p-3 border border-warning/30 bg-warning/10 rounded-md font-mono space-y-2.5">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
            <span>
              <span className="font-bold text-foreground">{predictSummary.successIds.length}</span> of{" "}
              <span className="font-bold text-foreground">
                {predictSummary.successIds.length + predictSummary.failedCount}
              </span>{" "}
              predictions succeeded.{" "}
              <span className="text-destructive font-bold">{predictSummary.failedCount} failed</span> — see error
              badges below for details.
            </span>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              variant="accent"
              className="font-mono"
              onClick={() => navigateToResults(predictSummary.successIds)}
            >
              <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
              VIEW {predictSummary.successIds.length} RESULT{predictSummary.successIds.length === 1 ? "" : "S"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="font-mono"
              disabled={isPredicting}
              onClick={handleRetryFailed}
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              RETRY {predictSummary.failedCount} FAILED
            </Button>
          </div>
        </div>
      )}

      {/* Primary action button(s) */}
      {hasItems && (
        <div className={isAdmin && resolvedCount > 0 ? "grid grid-cols-2 gap-2" : ""}>
          <Button
            size="lg" className="w-full font-bold font-mono h-12" variant="accent"
            disabled={anyResolving || isPredicting || resolvedCount === 0}
            onClick={
              !isPredicting && pendingPredictCount === 0
                ? () => navigateToResults(donePredictionIds)
                : handlePredictClick
            }
          >
            {isPredicting ? (
              <><RefreshCw className="w-5 h-5 mr-2 animate-spin" /> RUNNING {pendingPredictCount} PREDICTION{pendingPredictCount === 1 ? "" : "S"}...</>
            ) : pendingPredictCount === 0 ? (
              <><CheckCircle2 className="w-5 h-5 mr-2" /> VIEW {alreadyPredictedCount} RESULT{alreadyPredictedCount === 1 ? "" : "S"}</>
            ) : (
              <><Activity className="w-5 h-5 mr-2" /> PREDICT {pendingPredictCount} MATCHUP{pendingPredictCount === 1 ? "" : "S"}</>
            )}
          </Button>

          {/* Admin-only: Build Parlay shortcut — shown as soon as screenshots resolve */}
          {isAdmin && resolvedCount > 0 && (
            <Button
              size="lg"
              className="w-full font-bold font-mono h-12 border-amber-500/50 text-amber-400 hover:bg-amber-500/10 hover:border-amber-400"
              variant="outline"
              disabled={isPredicting}
              onClick={() => {
                // Write neutral match data only — no prediction engine fields.
                // AdminParlayBuilder reads this on mount and populates legs as an idle draft.
                const draftLegs: ParlayDraftLeg[] = items
                  .filter(i => i.status === "resolved" && i.result !== null)
                  .map(i => {
                    const r = i.result!
                    return {
                      player1Name: r.player1.recognizedName ?? "",
                      player1Id: r.player1.player?.id ?? null,
                      player2Name: r.player2.recognizedName ?? "",
                      player2Id: r.player2.player?.id ?? null,
                      tournamentName: i.tournamentName,
                      surface: i.surface,
                    }
                  })
                  .filter(d => d.player1Name || d.player2Name) // skip fully-blank legs
                try {
                  sessionStorage.setItem(PARLAY_DRAFT_KEY, JSON.stringify(draftLegs))
                } catch { /* sessionStorage unavailable — page will open empty */ }
                setLocation("/admin/parlay-builder?draft=1")
              }}
            >
              <Layers className="w-5 h-5 mr-2" />
              BUILD PARLAY
            </Button>
          )}
        </div>
      )}
      {hasItems && alreadyPredictedCount > 0 && pendingPredictCount > 0 && !anyResolving && (
        <p className="text-xs text-muted-foreground font-mono text-center">
          {alreadyPredictedCount} matchup{alreadyPredictedCount === 1 ? "" : "s"} already predicted — only the remaining {pendingPredictCount} will run.
        </p>
      )}
      {hasItems && resolvedCount === 0 && !anyResolving && (
        <p className="text-xs text-muted-foreground font-mono text-center">
          No items in this batch resolved to a full matchup yet.
        </p>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------
function ItemStatusBadge({ item }: { item: BatchItem }) {
  if (item.predictStatus === "success") return <Badge variant="success" className="font-mono gap-1"><CheckCircle2 className="w-3 h-3" /> PREDICTED</Badge>
  if (item.predictStatus === "error") return <Badge variant="destructive" className="font-mono gap-1"><XCircle className="w-3 h-3" /> PREDICT FAILED</Badge>
  if (item.predictStatus === "pending") return <Badge variant="outline" className="font-mono gap-1"><RefreshCw className="w-3 h-3 animate-spin" /> PREDICTING</Badge>
  if (item.status === "resolving") return <Badge variant="outline" className="font-mono gap-1"><RefreshCw className="w-3 h-3 animate-spin" /> READING</Badge>
  if (item.status === "resolved") return <Badge variant="success" className="font-mono gap-1"><CheckCircle2 className="w-3 h-3" /> READY</Badge>
  return <Badge variant="destructive" className="font-mono gap-1"><XCircle className="w-3 h-3" /> SKIPPED</Badge>
}
