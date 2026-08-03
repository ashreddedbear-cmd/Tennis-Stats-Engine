import { useState, useRef, useCallback, useEffect } from "react"
import { useUser } from "@clerk/react"
import { useLocation } from "wouter"
import { ArrowLeft, MessageSquare, Send, Paperclip, X, ChevronRight, Clock, CheckCircle2, AlertCircle, RefreshCw, Inbox, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import { useGetMyPaymentsStatus, getMyPaymentsStatusQueryKey } from "@workspace/api-client-react"
import { isPaymentsV2Enabled } from "@/lib/paymentsFeatureFlag"

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
const api = (path: string) => `${BASE}${path}`

// ── Types ─────────────────────────────────────────────────────────────────────

type TicketStatus = "open" | "waiting_for_support" | "waiting_for_user" | "resolved" | "closed"

interface TicketSummary {
  id: number
  ticketNumber: string
  category: string
  subject: string
  status: TicketStatus
  priority: string
  createdAt: string
  updatedAt: string
  latestMessageAt: string
  latestMessagePreview: string | null
  latestMessageFrom: string | null
  unreadCount: number
}

interface AttachmentPreview {
  file: File
  dataUri: string
  fileName: string
  fileType: string
  fileSizeBytes: number
}

const CATEGORIES = [
  "Technical Problem",
  "Prediction Issue",
  "Subscription or Billing",
  "Account Problem",
  "Feature Request",
  "Recommendation",
  "Data Problem",
  "Other",
]

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  waiting_for_support: "Waiting for Support",
  waiting_for_user: "Waiting for User",
  resolved: "Resolved",
  closed: "Closed",
}

const STATUS_VARIANTS: Record<TicketStatus, "default" | "secondary" | "success" | "warning" | "outline"> = {
  open: "default",
  waiting_for_support: "warning",
  waiting_for_user: "secondary",
  resolved: "success",
  closed: "outline",
}

// ── Image compression ─────────────────────────────────────────────────────────

async function compressImage(file: File): Promise<{ dataUri: string; fileSizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const maxW = 1200
      const scale = img.width > maxW ? maxW / img.width : 1
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext("2d")!
      ctx.drawImage(img, 0, 0, w, h)
      const dataUri = canvas.toDataURL("image/jpeg", 0.72)
      URL.revokeObjectURL(url)
      resolve({ dataUri, fileSizeBytes: Math.round((dataUri.length * 3) / 4) })
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")) }
    img.src = url
  })
}

// ── Ticket row ────────────────────────────────────────────────────────────────

function TicketRow({ ticket, onClick }: { ticket: TicketSummary; onClick: () => void }) {
  const status = ticket.status as TicketStatus
  const hasUnread = ticket.unreadCount > 0
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-xl border border-border/50 bg-card/60 hover:bg-card transition-colors p-4 flex items-start gap-3 group"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="font-mono text-xs text-muted-foreground">{ticket.ticketNumber}</span>
          <Badge variant={STATUS_VARIANTS[status]} className="font-mono text-[10px] h-4 px-1.5">
            {STATUS_LABELS[status]}
          </Badge>
          {hasUnread && (
            <Badge className="bg-primary text-primary-foreground font-mono text-[10px] h-4 px-1.5 gap-0.5">
              {ticket.unreadCount} new
            </Badge>
          )}
        </div>
        <p className={`font-display font-semibold text-sm truncate ${hasUnread ? "text-foreground" : "text-foreground/80"}`}>
          {ticket.subject}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[11px] font-mono text-muted-foreground">{ticket.category}</span>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-[11px] text-muted-foreground/60">
            {new Date(ticket.latestMessageAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        </div>
        {ticket.latestMessagePreview && (
          <p className="text-xs text-muted-foreground/60 mt-1 truncate">
            {ticket.latestMessageFrom === "admin" ? "Support: " : "You: "}{ticket.latestMessagePreview}
          </p>
        )}
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground shrink-0 mt-0.5 transition-colors" />
    </button>
  )
}

// ── Screenshot selector ───────────────────────────────────────────────────────

function ScreenshotPicker({
  attachments,
  onChange,
  maxFiles = 5,
}: {
  attachments: AttachmentPreview[]
  onChange: (next: AttachmentPreview[]) => void
  maxFiles?: number
}) {
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const ACCEPTED = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic"]

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files) return
    const remaining = maxFiles - attachments.length
    if (remaining <= 0) { toast({ title: "Maximum 5 screenshots reached" }); return }
    const toProcess = Array.from(files).slice(0, remaining)
    const next = [...attachments]
    for (const file of toProcess) {
      if (!ACCEPTED.includes(file.type) && !file.name.toLowerCase().endsWith(".heic")) {
        toast({ title: "Unsupported file type", description: `${file.name} is not a supported image.`, variant: "destructive" })
        continue
      }
      if (file.size > 10 * 1024 * 1024) {
        toast({ title: "File too large", description: `${file.name} exceeds 10 MB.`, variant: "destructive" })
        continue
      }
      try {
        const { dataUri, fileSizeBytes } = await compressImage(file)
        next.push({ file, dataUri, fileName: file.name, fileType: file.type || "image/jpeg", fileSizeBytes })
      } catch {
        toast({ title: "Could not process image", description: file.name, variant: "destructive" })
      }
    }
    onChange(next)
  }, [attachments, maxFiles, onChange, toast])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="font-mono text-xs gap-1.5 h-8"
          disabled={attachments.length >= maxFiles}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip className="w-3.5 h-3.5" />
          Add Screenshot
        </Button>
        <span className="text-xs text-muted-foreground font-mono">Maximum {maxFiles} screenshots</span>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          accept=".png,.jpg,.jpeg,.heic,.webp,image/*"
          onChange={e => handleFiles(e.target.files)}
          onClick={e => { (e.target as HTMLInputElement).value = "" }}
        />
      </div>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((att, i) => (
            <div key={i} className="relative group">
              <img
                src={att.dataUri}
                alt={att.fileName}
                className="w-20 h-20 object-cover rounded-lg border border-border/50"
              />
              <button
                type="button"
                onClick={() => onChange(attachments.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
              <div className="absolute bottom-0 left-0 right-0 bg-black/60 rounded-b-lg px-1 py-0.5">
                <p className="text-[9px] text-white truncate">{att.fileName}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── New Ticket Form ───────────────────────────────────────────────────────────

function NewTicketForm({
  onSuccess,
  onCancel,
  user,
  subscriptionPlan,
  currentRoute,
}: {
  onSuccess: (ticket: { id: number; ticketNumber: string }) => void
  onCancel: () => void
  user: { name?: string | null; email?: string | null }
  subscriptionPlan: string
  currentRoute: string
}) {
  const { toast } = useToast()
  const [category, setCategory] = useState("")
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  // Persist form in sessionStorage
  useEffect(() => {
    const saved = sessionStorage.getItem("support-form-draft")
    if (saved) {
      try {
        const d = JSON.parse(saved)
        if (d.category) setCategory(d.category)
        if (d.subject) setSubject(d.subject)
        if (d.message) setMessage(d.message)
      } catch { /* ignore */ }
    }
  }, [])

  useEffect(() => {
    sessionStorage.setItem("support-form-draft", JSON.stringify({ category, subject, message }))
  }, [category, subject, message])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!category || !subject.trim() || message.trim().length < 10) return
    if (submitting || submitted) return
    setSubmitting(true)
    try {
      const payload = {
        category,
        subject: subject.trim(),
        message: message.trim(),
        sourceRoute: currentRoute,
        appVersion: "1.0.0",
        deviceInfo: `${navigator.userAgent.slice(0, 200)}`,
        userName: user.name ?? undefined,
        userEmail: user.email ?? undefined,
        subscriptionPlan,
        accountRole: "user",
        attachments: attachments.map(a => ({
          fileName: a.fileName,
          fileType: a.fileType,
          fileSizeBytes: a.fileSizeBytes,
          dataUri: a.dataUri,
        })),
      }
      const res = await fetch(api("/api/support/tickets"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      })
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const ticket = await res.json()
      sessionStorage.removeItem("support-form-draft")
      setSubmitted(true)
      toast({ title: "Support request sent", description: `Ticket ${ticket.ticketNumber} created.` })
      onSuccess({ id: ticket.id, ticketNumber: ticket.ticketNumber })
    } catch (err) {
      toast({ title: "Failed to send", description: "Please try again.", variant: "destructive" })
    } finally {
      setSubmitting(false)
    }
  }

  const charCount = message.length
  const isValid = !!category && subject.trim().length > 0 && charCount >= 10 && charCount <= 5000

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Category */}
      <div className="space-y-1.5">
        <label className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-widest">
          Category <span className="text-destructive">*</span>
        </label>
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          required
          className="w-full rounded-lg border border-input bg-background px-3 h-10 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="">Select a category…</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Subject */}
      <div className="space-y-1.5">
        <label className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-widest">
          Subject <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={subject}
          onChange={e => setSubject(e.target.value.slice(0, 120))}
          placeholder="Briefly describe your issue"
          required
          maxLength={120}
          className="w-full rounded-lg border border-input bg-background px-3 h-10 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <p className="text-right text-xs font-mono text-muted-foreground/50">{subject.length}/120</p>
      </div>

      {/* Message */}
      <div className="space-y-1.5">
        <label className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-widest">
          Message <span className="text-destructive">*</span>
        </label>
        <textarea
          value={message}
          onChange={e => setMessage(e.target.value.slice(0, 5000))}
          placeholder="Describe the problem, recommendation, or question in detail…"
          required
          minLength={10}
          maxLength={5000}
          rows={8}
          className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40 resize-y min-h-[160px]"
        />
        <p className={`text-right text-xs font-mono ${charCount > 4800 ? "text-warning" : "text-muted-foreground/50"}`}>
          {charCount}/5,000
        </p>
      </div>

      {/* Screenshots */}
      <div className="space-y-1.5">
        <label className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-widest">Screenshots</label>
        <ScreenshotPicker attachments={attachments} onChange={setAttachments} />
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-1">
        <Button type="button" variant="outline" className="font-mono flex-1 sm:flex-none" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!isValid || submitting}
          className="font-mono flex-1 gap-2"
        >
          {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send Support Request
        </Button>
      </div>
    </form>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SupportPage() {
  const { user, isLoaded } = useUser()
  const [location, setLocation] = useLocation()
  const [view, setView] = useState<"inbox" | "new">("inbox")
  const [tickets, setTickets] = useState<TicketSummary[]>([])
  const [loadingTickets, setLoadingTickets] = useState(true)
  const paymentsEnabled = isPaymentsV2Enabled()
  const { data: billing } = useGetMyPaymentsStatus({
    query: { queryKey: getMyPaymentsStatusQueryKey(), enabled: paymentsEnabled },
  })

  const subscriptionPlan = (() => {
    const tier = billing?.tier ?? "free"
    const map: Record<string, string> = {
      team: "Team", elite_annual: "Elite Annual", elite: "Elite",
      pro_annual: "Pro Annual", pro: "Pro", free: "Free",
    }
    return map[tier] ?? tier
  })()

  // Track the previous route so Back can return there
  const prevRoute = useRef(document.referrer ? new URL(document.referrer, window.location.href).pathname : "/")

  const loadTickets = useCallback(async () => {
    setLoadingTickets(true)
    try {
      const res = await fetch(api("/api/support/tickets"), { credentials: "include" })
      if (res.ok) setTickets(await res.json())
    } catch { /* ignore */ } finally {
      setLoadingTickets(false)
    }
  }, [])

  useEffect(() => { loadTickets() }, [loadTickets])

  if (!isLoaded) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16">
        <p className="text-muted-foreground">Please sign in to access support.</p>
      </div>
    )
  }

  const email = user.emailAddresses?.[0]?.emailAddress ?? null
  const name = user.fullName ?? user.firstName ?? null

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border/50 pb-5">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => {
            // Return to previous route, not just /account
            const from = sessionStorage.getItem("support-from") ?? "/account"
            sessionStorage.removeItem("support-from")
            setLocation(from)
          }}
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-display font-bold tracking-tight">Contact Support</h1>
          <p className="text-sm text-muted-foreground">Report a problem, request a feature, or ask a question. Our support team will respond directly inside the app.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border border-border/40 rounded-lg p-1 bg-secondary/20">
        <button
          onClick={() => setView("inbox")}
          className={`flex-1 flex items-center justify-center gap-2 rounded-md h-9 text-sm font-mono font-semibold transition-colors ${view === "inbox" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          <Inbox className="w-4 h-4" />
          My Requests
          {tickets.some(t => t.unreadCount > 0) && (
            <span className="w-2 h-2 rounded-full bg-primary-foreground opacity-80" />
          )}
        </button>
        <button
          onClick={() => setView("new")}
          className={`flex-1 flex items-center justify-center gap-2 rounded-md h-9 text-sm font-mono font-semibold transition-colors ${view === "new" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          <Plus className="w-4 h-4" />
          New Request
        </button>
      </div>

      {/* Inbox */}
      {view === "inbox" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-mono font-bold text-muted-foreground uppercase tracking-widest">Your Support Requests</h2>
            <Button variant="ghost" size="sm" className="font-mono text-xs gap-1.5 h-7" onClick={loadTickets}>
              <RefreshCw className="w-3 h-3" /> Refresh
            </Button>
          </div>
          {loadingTickets ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
            </div>
          ) : tickets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/40 p-10 text-center">
              <MessageSquare className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-muted-foreground text-sm font-mono">No support requests yet.</p>
              <Button variant="outline" className="font-mono mt-4 gap-2" onClick={() => setView("new")}>
                <Plus className="w-4 h-4" /> New Request
              </Button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {tickets.map(t => (
                <TicketRow
                  key={t.id}
                  ticket={t}
                  onClick={() => setLocation(`/support/tickets/${t.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* New ticket form */}
      {view === "new" && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-mono">New Support Request</CardTitle>
          </CardHeader>
          <CardContent>
            <NewTicketForm
              user={{ name, email }}
              subscriptionPlan={subscriptionPlan}
              currentRoute={location}
              onCancel={() => setView("inbox")}
              onSuccess={(ticket) => {
                loadTickets()
                setView("inbox")
                setLocation(`/support/tickets/${ticket.id}`)
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
