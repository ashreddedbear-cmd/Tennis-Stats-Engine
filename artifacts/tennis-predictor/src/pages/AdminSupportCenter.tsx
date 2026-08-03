import { useState, useEffect, useCallback, useRef } from "react"
import { useLocation } from "wouter"
import { ArrowLeft, Send, Paperclip, X, RefreshCw, CheckCircle2, AlertCircle, Clock, Search, Filter, Expand, Lock, Unlock, Trash2, MoreVertical } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
const api = (path: string) => `${BASE}${path}`

// ── Types ─────────────────────────────────────────────────────────────────────

type TicketStatus = "open" | "waiting_for_support" | "waiting_for_user" | "resolved" | "closed"
type Priority = "low" | "normal" | "high" | "urgent"

interface TicketRow {
  id: number
  ticketNumber: string
  category: string
  subject: string
  status: TicketStatus
  priority: Priority
  userName: string | null
  userEmail: string | null
  subscriptionPlan: string | null
  createdAt: string
  updatedAt: string
  latestMessageAt: string
  latestMessagePreview: string | null
  latestMessageFrom: string | null
  unreadCount: number
  attachmentCount: number
}

interface Message {
  id: number
  senderRole: "user" | "admin"
  senderName: string | null
  message: string
  isInternalNote: boolean
  createdAt: string
}

interface Attachment {
  id: number
  messageId: number | null
  fileName: string
  dataUri: string
}

interface TicketDetail {
  ticket: TicketRow
  messages: Message[]
  attachments: Attachment[]
}

interface DashboardStats {
  total: number; open: number; waitingForSupport: number; waitingForUser: number
  resolved: number; closed: number; resolvedToday: number; high: number; unreadMessages: number
}

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open", waiting_for_support: "Waiting for Support",
  waiting_for_user: "Waiting for User", resolved: "Resolved", closed: "Closed",
}
const STATUS_VARIANTS: Record<TicketStatus, "default" | "secondary" | "success" | "warning" | "outline"> = {
  open: "default", waiting_for_support: "warning", waiting_for_user: "secondary",
  resolved: "success", closed: "outline",
}
const PRIORITY_COLORS: Record<Priority, string> = {
  low: "text-muted-foreground", normal: "text-foreground",
  high: "text-warning", urgent: "text-destructive",
}

async function compressImage(file: File): Promise<{ dataUri: string; fileSizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const maxW = 1200; const scale = img.width > maxW ? maxW / img.width : 1
      const canvas = document.createElement("canvas")
      canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale)
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height)
      const dataUri = canvas.toDataURL("image/jpeg", 0.72)
      URL.revokeObjectURL(url)
      resolve({ dataUri, fileSizeBytes: Math.round((dataUri.length * 3) / 4) })
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed")) }
    img.src = url
  })
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={onClose}>
      <button onClick={onClose} className="absolute top-4 right-4 text-white/70 hover:text-white"><X className="w-6 h-6" /></button>
      <img src={src} alt="Screenshot" className="max-w-full max-h-full object-contain rounded-lg" onClick={e => e.stopPropagation()} />
    </div>
  )
}

// ── Dashboard stats ───────────────────────────────────────────────────────────
function StatsGrid({ stats }: { stats: DashboardStats }) {
  const items = [
    { label: "Open", value: stats.open, color: "text-primary" },
    { label: "Waiting for Support", value: stats.waitingForSupport, color: "text-warning" },
    { label: "Waiting for User", value: stats.waitingForUser, color: "text-secondary-foreground" },
    { label: "Resolved Today", value: stats.resolvedToday, color: "text-emerald-400" },
    { label: "Unread Messages", value: stats.unreadMessages, color: "text-destructive" },
    { label: "High Priority", value: stats.high, color: "text-orange-400" },
  ]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {items.map(it => (
        <Card key={it.label} className="border-border/40">
          <CardContent className="p-4">
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest">{it.label}</p>
            <p className={`text-3xl font-display font-bold mt-1 ${it.color}`}>{it.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── Ticket conversation view ──────────────────────────────────────────────────
function TicketConversation({ ticketId, onBack, onRefreshList }: { ticketId: number; onBack: () => void; onRefreshList: () => void }) {
  const { toast } = useToast()
  const [detail, setDetail] = useState<TicketDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [reply, setReply] = useState("")
  const [isNote, setIsNote] = useState(false)
  const [sending, setSending] = useState(false)
  const [attachments, setAttachments] = useState<{ file: File; dataUri: string; fileName: string; fileType: string; fileSizeBytes: number }[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(api(`/api/support/admin/tickets/${ticketId}`), { credentials: "include" })
      if (res.ok) setDetail(await res.json())
    } catch { } finally { setLoading(false) }
  }, [ticketId])

  useEffect(() => { load() }, [load])
  useEffect(() => { setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100) }, [detail?.messages.length])

  const handleFiles = async (files: FileList | null) => {
    if (!files) return
    const next = [...attachments]
    for (const file of Array.from(files).slice(0, 5 - attachments.length)) {
      try { const r = await compressImage(file); next.push({ file, ...r, fileName: file.name, fileType: file.type }) } catch { }
    }
    setAttachments(next)
  }

  const sendReply = async () => {
    if (!reply.trim() || sending) return
    setSending(true)
    try {
      const res = await fetch(api(`/api/support/admin/tickets/${ticketId}/messages`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: reply.trim(), isInternalNote: isNote,
          attachments: attachments.map(a => ({ fileName: a.fileName, fileType: a.fileType, fileSizeBytes: a.fileSizeBytes, dataUri: a.dataUri })),
        }),
        credentials: "include",
      })
      if (res.ok) { setReply(""); setAttachments([]); setIsNote(false); await load(); onRefreshList() }
      else throw new Error("Failed")
    } catch { toast({ title: "Failed to send", variant: "destructive" }) }
    finally { setSending(false) }
  }

  const updateTicket = async (updates: Record<string, unknown>) => {
    setUpdating(true)
    try {
      await fetch(api(`/api/support/admin/tickets/${ticketId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
        credentials: "include",
      })
      await load(); onRefreshList()
    } catch { } finally { setUpdating(false) }
  }

  const deleteTicket = async () => {
    if (!confirm("Delete this ticket permanently? This cannot be undone.")) return
    try {
      await fetch(api(`/api/support/admin/tickets/${ticketId}`), { method: "DELETE", credentials: "include" })
      onBack(); onRefreshList()
    } catch { toast({ title: "Failed to delete", variant: "destructive" }) }
  }

  if (loading) return <div className="space-y-4"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>
  if (!detail) return null

  const { ticket, messages, attachments: allAttachments } = detail
  const status = ticket.status as TicketStatus

  return (
    <div className="space-y-4">
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}

      {/* Header */}
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={onBack}><ArrowLeft className="w-5 h-5" /></Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-mono text-xs text-muted-foreground">{ticket.ticketNumber}</span>
            <Badge variant={STATUS_VARIANTS[status]} className="font-mono text-[10px]">{STATUS_LABELS[status]}</Badge>
            <Badge variant="outline" className={`font-mono text-[10px] capitalize ${PRIORITY_COLORS[ticket.priority as Priority]}`}>{ticket.priority}</Badge>
          </div>
          <h2 className="font-display font-bold text-lg truncate">{ticket.subject}</h2>
          <p className="text-xs font-mono text-muted-foreground">{ticket.category}</p>
        </div>
      </div>

      {/* User info */}
      <Card className="border-border/40">
        <CardContent className="p-4 grid grid-cols-2 gap-3 text-xs font-mono">
          <div><span className="text-muted-foreground">User</span><p className="font-semibold mt-0.5">{ticket.userName ?? "—"}</p></div>
          <div><span className="text-muted-foreground">Email</span><p className="font-semibold mt-0.5 truncate">{ticket.userEmail ?? "—"}</p></div>
          <div><span className="text-muted-foreground">Plan</span><p className="font-semibold mt-0.5">{ticket.subscriptionPlan ?? "Free"}</p></div>
          <div><span className="text-muted-foreground">Submitted</span><p className="font-semibold mt-0.5">{new Date(ticket.createdAt).toLocaleDateString()}</p></div>
        </CardContent>
      </Card>

      {/* Admin controls */}
      <div className="flex flex-wrap gap-2">
        <select
          value={status}
          disabled={updating}
          onChange={e => updateTicket({ status: e.target.value })}
          className="rounded-lg border border-input bg-background px-3 h-8 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          {(["open", "waiting_for_support", "waiting_for_user", "resolved", "closed"] as TicketStatus[]).map(s => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <select
          value={ticket.priority}
          disabled={updating}
          onChange={e => updateTicket({ priority: e.target.value })}
          className="rounded-lg border border-input bg-background px-3 h-8 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          {(["low", "normal", "high", "urgent"] as Priority[]).map(p => (
            <option key={p} value={p} className="capitalize">{p.charAt(0).toUpperCase() + p.slice(1)}</option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="sm"
          className="font-mono text-xs gap-1.5 h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={deleteTicket}
        >
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </Button>
      </div>

      {/* Messages */}
      <div className="space-y-3 border border-border/30 rounded-xl p-4 min-h-[300px] bg-secondary/10">
        {messages.map(msg => {
          const isUser = msg.senderRole === "user"
          const msgAttachments = allAttachments.filter(a => a.messageId === msg.id)
          return (
            <div key={msg.id} className={`flex ${isUser ? "justify-start" : "justify-end"} gap-2`}>
              <div className={`max-w-[85%] space-y-2 flex flex-col ${isUser ? "items-start" : "items-end"}`}>
                <div className={`flex items-center gap-2 ${isUser ? "" : "flex-row-reverse"}`}>
                  <span className="text-[10px] font-mono font-bold text-muted-foreground uppercase">{isUser ? (msg.senderName ?? "User") : "Support"}</span>
                  {msg.isInternalNote && <Badge variant="outline" className="text-[9px] h-3.5 px-1 font-mono text-muted-foreground">Internal</Badge>}
                  <span className="text-[10px] text-muted-foreground/50 font-mono">
                    {new Date(msg.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                </div>
                <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                  isUser
                    ? "bg-secondary/60 border border-border/40 rounded-tl-sm"
                    : msg.isInternalNote
                      ? "bg-yellow-500/10 border border-yellow-500/20 rounded-tr-sm text-muted-foreground italic"
                      : "bg-primary text-primary-foreground rounded-tr-sm"
                }`}>
                  {msg.message}
                </div>
                {msgAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {msgAttachments.map(att => (
                      <button key={att.id} onClick={() => setLightbox(att.dataUri)} className="relative group">
                        <img src={att.dataUri} alt={att.fileName} className="w-20 h-20 object-cover rounded-xl border border-border/40 hover:border-primary/60 transition-colors" />
                        <div className="absolute inset-0 rounded-xl bg-black/0 group-hover:bg-black/20 flex items-center justify-center transition-all">
                          <Expand className="w-4 h-4 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Reply form */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <button
            onClick={() => setIsNote(false)}
            className={`flex-1 rounded-lg h-8 text-xs font-mono font-semibold border transition-colors ${!isNote ? "bg-primary text-primary-foreground border-primary" : "bg-transparent border-border/50 text-muted-foreground hover:text-foreground"}`}
          >
            Reply to User
          </button>
          <button
            onClick={() => setIsNote(true)}
            className={`flex-1 rounded-lg h-8 text-xs font-mono font-semibold border transition-colors ${isNote ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" : "bg-transparent border-border/50 text-muted-foreground hover:text-foreground"}`}
          >
            Internal Note
          </button>
        </div>
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((att, i) => (
              <div key={i} className="relative group">
                <img src={att.dataUri} alt={att.fileName} className="w-16 h-16 object-cover rounded-lg border border-border/50" />
                <button onClick={() => setAttachments(attachments.filter((_, j) => j !== i))} className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            value={reply}
            onChange={e => setReply(e.target.value.slice(0, 5000))}
            placeholder={isNote ? "Add an internal note (only visible to admins)…" : "Write your reply to the user…"}
            rows={4}
            className={`flex-1 rounded-xl border bg-background px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 resize-none ${isNote ? "border-yellow-500/30 focus:ring-yellow-500/20" : "border-input focus:ring-primary/40"}`}
          />
          <div className="flex flex-col gap-2">
            <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" disabled={attachments.length >= 5} onClick={() => fileInputRef.current?.click()}>
              <Paperclip className="w-4 h-4" />
            </Button>
            <Button type="button" size="icon" className={`h-9 w-9 shrink-0 ${isNote ? "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30" : ""}`} disabled={!reply.trim() || sending} onClick={sendReply}>
              {sending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        <input ref={fileInputRef} type="file" className="hidden" multiple accept=".png,.jpg,.jpeg,.heic,.webp,image/*" onChange={e => handleFiles(e.target.files)} onClick={e => { (e.target as HTMLInputElement).value = "" }} />
      </div>
    </div>
  )
}

// ── Main Admin Support Center ─────────────────────────────────────────────────

export default function AdminSupportCenter() {
  const [, setLocation] = useLocation()
  const { toast } = useToast()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [tickets, setTickets] = useState<TicketRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [search, setSearch] = useState("")
  const [filterStatus, setFilterStatus] = useState("")
  const [filterCategory, setFilterCategory] = useState("")
  const [filterPriority, setFilterPriority] = useState("")

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filterStatus) params.set("status", filterStatus)
      if (filterCategory) params.set("category", filterCategory)
      if (filterPriority) params.set("priority", filterPriority)
      if (search) params.set("search", search)
      const [statsRes, ticketsRes] = await Promise.all([
        fetch(api("/api/support/admin/dashboard"), { credentials: "include" }),
        fetch(api(`/api/support/admin/tickets?${params}`), { credentials: "include" }),
      ])
      if (statsRes.ok) setStats(await statsRes.json())
      if (ticketsRes.ok) setTickets(await ticketsRes.json())
    } catch { } finally { setLoading(false) }
  }, [filterStatus, filterCategory, filterPriority, search])

  useEffect(() => { loadAll() }, [loadAll])

  if (selectedId !== null) {
    return (
      <div className="max-w-3xl mx-auto animate-in fade-in duration-300">
        <TicketConversation
          ticketId={selectedId}
          onBack={() => setSelectedId(null)}
          onRefreshList={loadAll}
        />
      </div>
    )
  }

  const CATEGORIES = ["Technical Problem", "Prediction Issue", "Subscription or Billing", "Account Problem", "Feature Request", "Recommendation", "Data Problem", "Other"]

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border/50 pb-5">
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => setLocation("/")}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-display font-bold tracking-tight">Support Center</h1>
          <p className="text-sm text-muted-foreground">Manage all user support requests.</p>
        </div>
        <Button variant="ghost" size="icon" className="ml-auto h-9 w-9" onClick={loadAll}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Stats */}
      {loading && !stats ? (
        <div className="grid grid-cols-3 gap-3">{[1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
      ) : stats ? (
        <StatsGrid stats={stats} />
      ) : null}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, email, subject…"
            className="w-full pl-8 pr-3 h-8 rounded-lg border border-input bg-background text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="h-8 rounded-lg border border-input bg-background px-2 text-xs font-mono focus:outline-none">
          <option value="">All Statuses</option>
          {(["open", "waiting_for_support", "waiting_for_user", "resolved", "closed"] as TicketStatus[]).map(s => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="h-8 rounded-lg border border-input bg-background px-2 text-xs font-mono focus:outline-none">
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)} className="h-8 rounded-lg border border-input bg-background px-2 text-xs font-mono focus:outline-none">
          <option value="">All Priorities</option>
          {["low", "normal", "high", "urgent"].map(p => <option key={p} value={p} className="capitalize">{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
        </select>
      </div>

      {/* Ticket list */}
      {loading ? (
        <div className="space-y-2">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
      ) : tickets.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground font-mono text-sm">No tickets found.</div>
      ) : (
        <div className="space-y-2">
          {tickets.map(t => (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className="w-full text-left rounded-xl border border-border/50 bg-card/60 hover:bg-card transition-colors p-4 group"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-mono text-xs text-muted-foreground">{t.ticketNumber}</span>
                    <Badge variant={STATUS_VARIANTS[t.status as TicketStatus]} className="font-mono text-[10px] h-4 px-1.5">{STATUS_LABELS[t.status as TicketStatus]}</Badge>
                    {(t.priority === "high" || t.priority === "urgent") && (
                      <Badge variant="outline" className={`font-mono text-[10px] h-4 px-1.5 capitalize ${PRIORITY_COLORS[t.priority as Priority]}`}>{t.priority}</Badge>
                    )}
                    {t.unreadCount > 0 && (
                      <Badge className="bg-primary text-primary-foreground font-mono text-[10px] h-4 px-1.5">{t.unreadCount} new</Badge>
                    )}
                  </div>
                  <p className="font-display font-semibold text-sm truncate">{t.subject}</p>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="text-xs font-mono text-muted-foreground">{t.userName ?? "—"}</span>
                    <span className="text-muted-foreground/30">·</span>
                    <span className="text-xs font-mono text-muted-foreground/70">{t.category}</span>
                    {t.subscriptionPlan && (
                      <>
                        <span className="text-muted-foreground/30">·</span>
                        <span className="text-xs font-mono text-primary/70">{t.subscriptionPlan}</span>
                      </>
                    )}
                    <span className="text-muted-foreground/30">·</span>
                    <span className="text-xs text-muted-foreground/50">
                      {new Date(t.latestMessageAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                    {t.attachmentCount > 0 && (
                      <>
                        <span className="text-muted-foreground/30">·</span>
                        <span className="text-xs font-mono text-muted-foreground/50 gap-1 flex items-center">
                          <Paperclip className="w-3 h-3" />{t.attachmentCount}
                        </span>
                      </>
                    )}
                  </div>
                  {t.latestMessagePreview && (
                    <p className="text-xs text-muted-foreground/50 mt-1 truncate">
                      {t.latestMessageFrom === "admin" ? "Support: " : "User: "}{t.latestMessagePreview}
                    </p>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
