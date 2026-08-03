import { useState, useEffect, useRef, useCallback } from "react"
import { useUser } from "@clerk/react"
import { useLocation, useParams } from "wouter"
import { ArrowLeft, Send, Paperclip, X, RefreshCw, CheckCircle2, AlertCircle, Clock, Expand } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
const api = (path: string) => `${BASE}${path}`

// ── Types ─────────────────────────────────────────────────────────────────────

type TicketStatus = "open" | "waiting_for_support" | "waiting_for_user" | "resolved" | "closed"
type SenderRole = "user" | "admin"

interface Message {
  id: number
  senderRole: SenderRole
  senderName: string | null
  message: string
  isInternalNote: boolean
  isReadByUser: boolean
  createdAt: string
}

interface Attachment {
  id: number
  ticketId: number
  messageId: number | null
  fileName: string
  fileType: string
  dataUri: string
}

interface Ticket {
  id: number
  ticketNumber: string
  category: string
  subject: string
  status: TicketStatus
  priority: string
  userName: string | null
  userEmail: string | null
  createdAt: string
  updatedAt: string
}

interface TicketDetail {
  ticket: Ticket
  messages: Message[]
  attachments: Attachment[]
}

interface AttachmentPreview {
  file: File
  dataUri: string
  fileName: string
  fileType: string
  fileSizeBytes: number
}

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
      const canvas = document.createElement("canvas")
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height)
      const dataUri = canvas.toDataURL("image/jpeg", 0.72)
      URL.revokeObjectURL(url)
      resolve({ dataUri, fileSizeBytes: Math.round((dataUri.length * 3) / 4) })
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load")) }
    img.src = url
  })
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/70 hover:text-white"
      >
        <X className="w-6 h-6" />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-w-full max-h-full object-contain rounded-lg"
        onClick={e => e.stopPropagation()}
      />
    </div>
  )
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({
  message,
  attachments,
  isUser,
}: {
  message: Message
  attachments: Attachment[]
  isUser: boolean
}) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const msgAttachments = attachments.filter(a => a.messageId === message.id)
  const time = new Date(message.createdAt).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  })

  return (
    <>
      {lightboxSrc && (
        <Lightbox src={lightboxSrc} alt="Screenshot" onClose={() => setLightboxSrc(null)} />
      )}
      <div className={`flex ${isUser ? "justify-end" : "justify-start"} gap-2`}>
        <div className={`max-w-[85%] space-y-2 ${isUser ? "items-end" : "items-start"} flex flex-col`}>
          <div className={`flex items-center gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
            <span className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
              {isUser ? "You" : (message.senderName ?? "Support")}
            </span>
            <span className="text-[10px] text-muted-foreground/50 font-mono">{time}</span>
          </div>
          <div
            className={`rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words ${
              isUser
                ? "bg-primary text-primary-foreground rounded-tr-sm"
                : "bg-secondary/60 border border-border/40 text-foreground rounded-tl-sm"
            }`}
          >
            {message.message}
          </div>
          {msgAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {msgAttachments.map(att => (
                <button
                  key={att.id}
                  onClick={() => setLightboxSrc(att.dataUri)}
                  className="relative group"
                >
                  <img
                    src={att.dataUri}
                    alt={att.fileName}
                    className="w-24 h-24 object-cover rounded-xl border border-border/40 hover:border-primary/60 transition-colors"
                  />
                  <div className="absolute inset-0 rounded-xl bg-black/0 group-hover:bg-black/20 flex items-center justify-center transition-all">
                    <Expand className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ── Reply form ────────────────────────────────────────────────────────────────

function ReplyForm({
  ticketId,
  onSent,
}: {
  ticketId: number
  onSent: () => void
}) {
  const { toast } = useToast()
  const [message, setMessage] = useState("")
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([])
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files) return
    const remaining = 5 - attachments.length
    const toProcess = Array.from(files).slice(0, remaining)
    const next = [...attachments]
    for (const file of toProcess) {
      if (file.size > 10 * 1024 * 1024) { toast({ title: "File too large", variant: "destructive" }); continue }
      try {
        const { dataUri, fileSizeBytes } = await compressImage(file)
        next.push({ file, dataUri, fileName: file.name, fileType: file.type || "image/jpeg", fileSizeBytes })
      } catch { /* ignore */ }
    }
    setAttachments(next)
  }, [attachments, toast])

  const handleSend = async () => {
    if (!message.trim() || sending) return
    setSending(true)
    try {
      const res = await fetch(api(`/api/support/tickets/${ticketId}/messages`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          attachments: attachments.map(a => ({ fileName: a.fileName, fileType: a.fileType, fileSizeBytes: a.fileSizeBytes, dataUri: a.dataUri })),
        }),
        credentials: "include",
      })
      if (!res.ok) throw new Error("Failed")
      setMessage("")
      setAttachments([])
      onSent()
    } catch {
      toast({ title: "Failed to send message", variant: "destructive" })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-t border-border/40 bg-card/50 p-4 space-y-3">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((att, i) => (
            <div key={i} className="relative group">
              <img src={att.dataUri} alt={att.fileName} className="w-16 h-16 object-cover rounded-lg border border-border/50" />
              <button
                onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 items-end">
        <textarea
          value={message}
          onChange={e => setMessage(e.target.value.slice(0, 5000))}
          placeholder="Write your reply…"
          rows={3}
          className="flex-1 rounded-xl border border-input bg-background px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none"
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend() }}
        />
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            disabled={attachments.length >= 5}
            onClick={() => inputRef.current?.click()}
          >
            <Paperclip className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            className="h-9 w-9 shrink-0"
            disabled={!message.trim() || sending}
            onClick={handleSend}
          >
            {sending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        multiple
        accept=".png,.jpg,.jpeg,.heic,.webp,image/*"
        onChange={e => handleFiles(e.target.files)}
        onClick={e => { (e.target as HTMLInputElement).value = "" }}
      />
      <p className="text-[10px] text-muted-foreground/40 font-mono">⌘/Ctrl + Enter to send · Max 5 screenshots</p>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function SupportTicketPage() {
  const { user } = useUser()
  const [, setLocation] = useLocation()
  const params = useParams<{ id: string }>()
  const ticketId = parseInt(params.id ?? "0", 10)
  const { toast } = useToast()

  const [detail, setDetail] = useState<TicketDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(api(`/api/support/tickets/${ticketId}`), { credentials: "include" })
      if (res.status === 403 || res.status === 404) { setLocation("/support"); return }
      if (res.ok) setDetail(await res.json())
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [ticketId, setLocation])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (detail) setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100)
  }, [detail?.messages.length])

  const updateStatus = async (status: TicketStatus) => {
    if (!detail || updating) return
    setUpdating(true)
    try {
      const res = await fetch(api(`/api/support/tickets/${ticketId}/status`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
        credentials: "include",
      })
      if (res.ok) { await load(); toast({ title: status === "resolved" ? "Ticket marked resolved" : "Ticket reopened" }) }
    } catch { toast({ title: "Failed to update", variant: "destructive" }) }
    finally { setUpdating(false) }
  }

  if (loading) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  if (!detail) return null

  const { ticket, messages, attachments } = detail
  const status = ticket.status as TicketStatus
  const clerkId = user?.id

  return (
    <div className="flex flex-col max-w-2xl mx-auto space-y-0 animate-in fade-in duration-500">
      {/* Header */}
      <div className="border-b border-border/50 pb-4 mb-4 space-y-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => setLocation("/support")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs text-muted-foreground">{ticket.ticketNumber}</span>
              <Badge variant={STATUS_VARIANTS[status]} className="font-mono text-[10px] h-4 px-1.5">
                {STATUS_LABELS[status]}
              </Badge>
            </div>
            <h1 className="font-display font-bold text-lg truncate">{ticket.subject}</h1>
            <p className="text-xs font-mono text-muted-foreground">{ticket.category} · {new Date(ticket.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
          </div>
        </div>

        {/* Status actions */}
        <div className="flex gap-2 flex-wrap ml-12">
          {(status === "open" || status === "waiting_for_user" || status === "waiting_for_support") && (
            <Button
              variant="outline"
              size="sm"
              className="font-mono text-xs gap-1.5 h-7"
              disabled={updating}
              onClick={() => updateStatus("resolved")}
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              Mark Resolved
            </Button>
          )}
          {status === "resolved" && (
            <Button
              variant="outline"
              size="sm"
              className="font-mono text-xs gap-1.5 h-7"
              disabled={updating}
              onClick={() => updateStatus("open")}
            >
              <AlertCircle className="w-3.5 h-3.5 text-warning" />
              Reopen Ticket
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="space-y-4 pb-4 min-h-[300px]">
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            attachments={attachments}
            isUser={msg.senderRole === "user"}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Reply area */}
      {status !== "resolved" && status !== "closed" ? (
        <div className="sticky bottom-0 -mx-4 sm:-mx-6">
          <ReplyForm ticketId={ticketId} onSent={load} />
        </div>
      ) : (
        <div className="border-t border-border/40 p-4 text-center">
          <p className="text-sm text-muted-foreground font-mono">
            {status === "resolved" ? "This ticket is resolved." : "This ticket is closed."}
            {status === "resolved" && " Reopen it if you need further help."}
          </p>
        </div>
      )}
    </div>
  )
}
