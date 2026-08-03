import { type ReactElement, useState, useCallback } from "react"
import { useLocation } from "wouter"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
const api = (path: string) => `${BASE}${path}`

import {
  Users, Search, Download, RefreshCw, ChevronLeft, ChevronRight,
  Crown, AlertTriangle, Ban, ShieldOff, ShieldCheck, XCircle,
  RotateCcw, Gift, Clock, Zap, FileText, ExternalLink,
  DollarSign, MessageSquare, Activity, ArrowUpDown, ChevronDown
} from "lucide-react"

// ── Types ─────────────────────────────────────────────────────────────────────

interface UserRow {
  id: number
  clerk_user_id: string
  clerkName: string
  clerkEmail: string
  clerkCreatedAt: number | null
  lastSignInAt: number | null
  lastActiveAt: number | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan_key: string | null
  subscription_status: string | null
  account_status: string
  cancel_at_period_end: boolean
  canceled_at: string | null
  current_period_start_at: string | null
  current_period_end_at: string | null
  trial_start_at: string | null
  trial_end_at: string | null
  failed_payment_count: number
  last_payment_at: string | null
  last_payment_amount: number | null
  last_payment_status: string | null
  admin_note: string
  complimentary_plan: string | null
  complimentary_expires_at: string | null
  total_predictions: number
  predictions_today: number
  open_tickets: number
  created_at: string
}

interface UserDetail {
  clerkUserId: string
  clerkName: string
  clerkEmail: string
  clerkCreatedAt: number | null
  lastSignInAt: number | null
  lastActiveAt: number | null
  account: Record<string, unknown> | null
  notes: Record<string, unknown> | null
  totalPredictions: number
  predictionsToday: number
  supportTickets: Array<Record<string, unknown>>
  auditLog: Array<Record<string, unknown>>
  paymentEvents: Array<Record<string, unknown>>
}

interface Stats {
  total: number; free: number; pro: number; elite: number; team: number
  monthly: number; annual: number; trialing: number; paying: number
  pastDue: number; failedPayments: number; scheduledCancellations: number
  activeAccounts: number; mrr: number; arr: number
}

interface ConfirmAction {
  title: string
  description: string
  variant?: "destructive" | "default"
  requireReason?: boolean
  requireInput?: { label: string; placeholder: string; field: string }
  onConfirm: (reason: string, extra?: Record<string, string>) => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (v: unknown) => v == null ? "—" : String(v)
const fmtDate = (v: string | number | null) => {
  if (!v) return "—"
  const d = typeof v === "number" ? new Date(v) : new Date(v)
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}
const fmtMoney = (cents: number | null) => cents == null ? "—" : `$${(cents / 100).toFixed(2)}`

function planBadge(plan: string | null) {
  if (!plan || plan === "free") return <Badge variant="outline" className="text-[10px]">FREE</Badge>
  if (plan.includes("elite")) return <Badge className="text-[10px] bg-primary/20 text-primary border-primary/30 gap-1"><Crown className="w-2.5 h-2.5" />ELITE</Badge>
  if (plan.includes("pro")) return <Badge className="text-[10px] bg-success/20 text-success border-success/30">PRO</Badge>
  if (plan === "team") return <Badge className="text-[10px] bg-accent/20 text-accent border-accent/30">TEAM</Badge>
  return <Badge variant="outline" className="text-[10px]">{plan?.toUpperCase()}</Badge>
}

function statusBadge(status: string | null, accountStatus: string) {
  if (accountStatus === "banned") return <Badge variant="destructive" className="text-[10px]">BANNED</Badge>
  if (accountStatus === "suspended") return <Badge className="text-[10px] bg-warning/20 text-warning border-warning/30">SUSPENDED</Badge>
  const s = status ?? "none"
  const map: Record<string, ReactElement> = {
    active: <Badge className="text-[10px] bg-success/20 text-success border-success/30">ACTIVE</Badge>,
    trialing: <Badge className="text-[10px] bg-primary/20 text-primary border-primary/30">TRIALING</Badge>,
    past_due: <Badge variant="destructive" className="text-[10px]">PAST DUE</Badge>,
    canceled: <Badge variant="outline" className="text-[10px] text-muted-foreground">CANCELED</Badge>,
    incomplete: <Badge variant="outline" className="text-[10px] text-muted-foreground">INCOMPLETE</Badge>,
  }
  return map[s] ?? <Badge variant="outline" className="text-[10px]">{s.toUpperCase()}</Badge>
}

function billingCycle(plan: string | null) {
  if (!plan || plan === "free") return "Free"
  return plan.includes("annual") ? "Annual" : "Monthly"
}

// ── Confirm Dialog ─────────────────────────────────────────────────────────────

function ConfirmDialog({ action, onClose }: { action: ConfirmAction | null; onClose: () => void }) {
  const [reason, setReason] = useState("")
  const [extra, setExtra] = useState<Record<string, string>>({})

  if (!action) return null

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{action.title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{action.description}</p>
        {action.requireInput && (
          <div className="space-y-1">
            <Label className="text-xs font-mono">{action.requireInput.label}</Label>
            <Input
              placeholder={action.requireInput.placeholder}
              value={extra[action.requireInput.field] ?? ""}
              onChange={e => setExtra(x => ({ ...x, [action.requireInput!.field]: e.target.value }))}
            />
          </div>
        )}
        {action.requireReason && (
          <div className="space-y-1">
            <Label className="text-xs font-mono">REASON (optional)</Label>
            <Textarea placeholder="Add a reason for the audit log…" value={reason} onChange={e => setReason(e.target.value)} rows={2} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant={action.variant ?? "default"} onClick={() => { action.onConfirm(reason, extra); onClose(); }}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Summary Stats ─────────────────────────────────────────────────────────────

function SummaryStats({ stats }: { stats: Stats | undefined }) {
  if (!stats) return null
  const cards = [
    { label: "TOTAL USERS", value: stats.total.toLocaleString() },
    { label: "ACTIVE", value: stats.activeAccounts.toLocaleString() },
    { label: "FREE", value: stats.free.toLocaleString() },
    { label: "PRO", value: stats.pro.toLocaleString() },
    { label: "ELITE", value: stats.elite.toLocaleString() },
    { label: "TEAM", value: stats.team.toLocaleString() },
    { label: "MONTHLY", value: stats.monthly.toLocaleString() },
    { label: "ANNUAL", value: stats.annual.toLocaleString() },
    { label: "TRIALING", value: stats.trialing.toLocaleString() },
    { label: "PAYING", value: stats.paying.toLocaleString() },
    { label: "MRR", value: `$${stats.mrr.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` },
    { label: "ARR", value: `$${stats.arr.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` },
    { label: "PAST DUE", value: stats.pastDue.toLocaleString(), warn: stats.pastDue > 0 },
    { label: "FAILED PMT", value: stats.failedPayments.toLocaleString(), warn: stats.failedPayments > 0 },
    { label: "CANCEL SCHED", value: stats.scheduledCancellations.toLocaleString() },
  ]
  return (
    <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-8 gap-2">
      {cards.map(c => (
        <Card key={c.label} className={`${c.warn ? "border-destructive/40 bg-destructive/5" : "bg-card"} shadow-sm`}>
          <CardContent className="p-3">
            <p className="text-[9px] font-mono font-bold text-muted-foreground tracking-widest truncate">{c.label}</p>
            <p className={`text-lg font-display font-bold tabular-nums ${c.warn ? "text-destructive" : "text-primary"}`}>{c.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── User Detail Panel ─────────────────────────────────────────────────────────

function UserDetailPanel({ userId, onClose }: { userId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const [noteText, setNoteText] = useState("")
  const [refundChargeId, setRefundChargeId] = useState("")

  const { data, isLoading } = useQuery<UserDetail>({
    queryKey: ["admin-user-detail", userId],
    queryFn: async () => {
      const r = await fetch(api(`/api/admin/users/${userId}`), { credentials: "include" })
      if (!r.ok) throw new Error(await r.text())
      return r.json()
    },
  })

  const doAction = async (path: string, body: unknown) => {
    const r = await fetch(api(`/api/admin/users/${userId}/${path}`), {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(await r.text())
    qc.invalidateQueries({ queryKey: ["admin-user-detail", userId] })
    qc.invalidateQueries({ queryKey: ["admin-users"] })
    toast({ title: "✅ Action completed" })
  }

  const confirm_ = (action: ConfirmAction) => setConfirm(action)

  if (isLoading) return (
    <Sheet open onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <div className="animate-pulse space-y-4 mt-8">
          <div className="h-8 bg-muted rounded" /><div className="h-32 bg-muted rounded" /><div className="h-32 bg-muted rounded" />
        </div>
      </SheetContent>
    </Sheet>
  )

  const u = data!
  const account = u?.account as Record<string, unknown> | null
  const notes = u?.notes as Record<string, unknown> | null

  return (
    <Sheet open onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto p-4 space-y-5">
        <SheetHeader>
          <SheetTitle className="font-display text-xl">{u?.clerkName ?? "—"}</SheetTitle>
          <p className="text-sm text-muted-foreground font-mono">{u?.clerkEmail}</p>
        </SheetHeader>

        {/* ── Account Info ── */}
        <Section title="Account Information">
          <Row label="Clerk User ID"><code className="text-xs break-all">{u?.clerkUserId}</code></Row>
          <Row label="Stripe Customer"><code className="text-xs">{fmt(account?.stripeCustomerId)}</code>
            {!!account?.stripeCustomerId && (
              <a href={`https://dashboard.stripe.com/customers/${account.stripeCustomerId}`} target="_blank" rel="noreferrer" className="ml-1 text-primary"><ExternalLink className="inline w-3 h-3" /></a>
            )}
          </Row>
          <Row label="Signup">{fmtDate(u?.clerkCreatedAt)}</Row>
          <Row label="Last Sign In">{fmtDate(u?.lastSignInAt)}</Row>
          <Row label="Last Active">{fmtDate(u?.lastActiveAt)}</Row>
          <Row label="Account Status">
            {statusBadge(account?.subscriptionStatus as string | null, (notes?.accountStatus as string) ?? "active")}
          </Row>
        </Section>

        {/* ── Subscription ── */}
        <Section title="Subscription">
          <Row label="Plan">{planBadge(account?.planKey as string | null)}</Row>
          <Row label="Billing Cycle">{billingCycle(account?.planKey as string | null)}</Row>
          <Row label="Status">{fmt(account?.subscriptionStatus)}</Row>
          <Row label="Price ID"><code className="text-xs">{fmt(account?.stripePriceId)}</code></Row>
          <Row label="Period Start">{fmtDate(account?.currentPeriodStartAt as string | null)}</Row>
          <Row label="Next Renewal">{fmtDate(account?.currentPeriodEndAt as string | null)}</Row>
          <Row label="Trial End">{fmtDate(account?.trialEndAt as string | null)}</Row>
          <Row label="Cancel Scheduled">{account?.cancelAtPeriodEnd ? <Badge variant="destructive" className="text-[10px]">YES</Badge> : "No"}</Row>
          <Row label="Canceled At">{fmtDate(account?.canceledAt as string | null)}</Row>
          <Row label="Comp Access">{notes?.complimentaryPlan ? `${String(notes.complimentaryPlan).toUpperCase()} until ${fmtDate(notes.complimentaryExpiresAt as string | null)}` : "—"}</Row>
        </Section>

        {/* ── Payments ── */}
        <Section title="Payment Information">
          <Row label="Last Payment">{fmtDate(account?.lastPaymentAt as string | null)}</Row>
          <Row label="Last Amount">{fmtMoney(account?.lastPaymentAmount as number | null)}</Row>
          <Row label="Last Status">{fmt(account?.lastPaymentStatus)}</Row>
          <Row label="Failed Count"><span className={(account?.failedPaymentCount as number) > 0 ? "text-destructive font-bold" : ""}>{fmt(account?.failedPaymentCount ?? 0)}</span></Row>
          {u?.paymentEvents?.length > 0 && (
            <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
              {u.paymentEvents.slice(0, 10).map((e, i) => (
                <div key={i} className="text-xs font-mono text-muted-foreground flex gap-2">
                  <span className="text-muted-foreground/60 shrink-0">{fmtDate(e.received_at as string)}</span>
                  <span>{fmt(e.event_type)}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ── Predictions ── */}
        <Section title="Prediction Usage">
          <Row label="Total Predictions">{u?.totalPredictions?.toLocaleString()}</Row>
          <Row label="Used Today">{u?.predictionsToday}</Row>
        </Section>

        {/* ── Support ── */}
        <Section title={`Support Tickets (${u?.supportTickets?.length ?? 0})`}>
          {u?.supportTickets?.length === 0 ? <p className="text-xs text-muted-foreground">No tickets</p> : null}
          {u?.supportTickets?.slice(0, 5).map((t, i) => (
            <div key={i} className="flex items-center justify-between text-xs gap-2 py-1 border-b border-border/30 last:border-0">
              <span className="truncate">{fmt(t.subject)}</span>
              <Badge variant="outline" className="text-[10px] shrink-0">{fmt(t.status)}</Badge>
            </div>
          ))}
        </Section>

        {/* ── Admin Notes ── */}
        <Section title="Private Admin Notes">
          <Textarea
            rows={4}
            value={noteText || (notes?.note as string) || ""}
            onChange={e => setNoteText(e.target.value)}
            placeholder="Private notes — only visible to admins…"
            className="text-sm font-mono"
          />
          <Button size="sm" className="mt-2 font-mono" onClick={() => confirm_({
            title: "Save Admin Note",
            description: "This note is private and only visible to admins.",
            onConfirm: async () => { try { await doAction("notes", { note: noteText }) } catch(e) { toast({ title: "Error", description: String(e), variant: "destructive" }) } },
          })}>
            <FileText className="w-3.5 h-3.5 mr-1.5" /> Save Note
          </Button>
        </Section>

        {/* ── Audit Log ── */}
        <Section title="Admin Action History">
          {u?.auditLog?.length === 0 ? <p className="text-xs text-muted-foreground">No admin actions yet</p> : null}
          {u?.auditLog?.slice(0, 10).map((e, i) => (
            <div key={i} className="text-xs font-mono py-1 border-b border-border/30 last:border-0">
              <span className="text-muted-foreground/60 mr-2">{fmtDate(e.created_at as string)}</span>
              <span className="font-bold">{fmt(e.action)}</span>
              {e.reason ? <span className="text-muted-foreground ml-2">— {fmt(e.reason)}</span> : null}
            </div>
          ))}
        </Section>

        {/* ── Admin Controls ── */}
        <Section title="Admin Controls">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="font-mono gap-1.5 text-xs"
              onClick={() => confirm_({
                title: "Grant Complimentary Access",
                description: "Override this user's plan with complimentary Pro or Elite access.",
                requireInput: { label: "PLAN (pro or elite)", placeholder: "pro", field: "plan" },
                requireReason: true,
                onConfirm: async (reason, extra) => {
                  try {
                    const expires = new Date(); expires.setDate(expires.getDate() + 30);
                    await doAction("complimentary", { plan: extra?.plan, expiresAt: expires.toISOString(), reason })
                  } catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) }
                },
              })}>
              <Gift className="w-3.5 h-3.5" /> Comp Access
            </Button>

            {account?.cancelAtPeriodEnd ? (
              <Button size="sm" variant="outline" className="font-mono gap-1.5 text-xs"
                onClick={() => confirm_({
                  title: "Restore Scheduled Cancellation",
                  description: "Remove the scheduled cancellation — subscription will auto-renew.",
                  requireReason: true,
                  onConfirm: async (reason) => { try { await doAction("restore", { reason }) } catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) } },
                })}>
                <RotateCcw className="w-3.5 h-3.5" /> Restore
              </Button>
            ) : account?.stripeSubscriptionId ? (
              <Button size="sm" variant="outline" className="font-mono gap-1.5 text-xs text-warning"
                onClick={() => confirm_({
                  title: "Schedule Cancellation",
                  description: "Subscription will be canceled at end of current billing period.",
                  variant: "destructive",
                  requireReason: true,
                  onConfirm: async (reason) => { try { await doAction("cancel", { immediate: false, reason }) } catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) } },
                })}>
                <XCircle className="w-3.5 h-3.5" /> Schedule Cancel
              </Button>
            ) : null}

            {!!account?.stripeSubscriptionId && (
              <Button size="sm" variant="destructive" className="font-mono gap-1.5 text-xs"
                onClick={() => confirm_({
                  title: "Cancel Immediately",
                  description: "Cancel this subscription right now. This cannot be undone.",
                  variant: "destructive",
                  requireReason: true,
                  onConfirm: async (reason) => { try { await doAction("cancel", { immediate: true, reason }) } catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) } },
                })}>
                <XCircle className="w-3.5 h-3.5" /> Cancel Now
              </Button>
            )}

            {account?.subscriptionStatus === "trialing" && (
              <Button size="sm" variant="outline" className="font-mono gap-1.5 text-xs"
                onClick={() => confirm_({
                  title: "Extend Trial",
                  description: "Set a new trial end date for this subscription.",
                  requireInput: { label: "NEW TRIAL END DATE", placeholder: "2026-09-01", field: "trialEndDate" },
                  requireReason: true,
                  onConfirm: async (reason, extra) => {
                    try { await doAction("extend-trial", { trialEndDate: extra?.trialEndDate, reason }) }
                    catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) }
                  },
                })}>
                <Clock className="w-3.5 h-3.5" /> Extend Trial
              </Button>
            )}

            <Button size="sm" variant="outline" className="font-mono gap-1.5 text-xs"
              onClick={() => confirm_({
                title: "Reset Daily Prediction Count",
                description: "Delete this user's predictions from today so they can make fresh predictions.",
                variant: "destructive",
                requireReason: true,
                onConfirm: async (reason) => { try { await doAction("reset-predictions", { reason }) } catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) } },
              })}>
              <Zap className="w-3.5 h-3.5" /> Reset Predictions
            </Button>

            {(notes?.accountStatus as string) !== "suspended" ? (
              <Button size="sm" variant="outline" className="font-mono gap-1.5 text-xs text-warning"
                onClick={() => confirm_({
                  title: "Suspend Account",
                  description: "This user will be locked out until you reactivate them.",
                  variant: "destructive",
                  requireReason: true,
                  onConfirm: async (reason) => { try { await doAction("status", { status: "suspended", reason }) } catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) } },
                })}>
                <ShieldOff className="w-3.5 h-3.5" /> Suspend
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="font-mono gap-1.5 text-xs text-success"
                onClick={() => confirm_({
                  title: "Reactivate Account",
                  description: "Restore access for this suspended user.",
                  requireReason: true,
                  onConfirm: async (reason) => { try { await doAction("status", { status: "active", reason }) } catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) } },
                })}>
                <ShieldCheck className="w-3.5 h-3.5" /> Reactivate
              </Button>
            )}

            {(notes?.accountStatus as string) !== "banned" ? (
              <Button size="sm" variant="destructive" className="font-mono gap-1.5 text-xs"
                onClick={() => confirm_({
                  title: "Ban Account",
                  description: "Permanently ban this user. They will lose all access immediately.",
                  variant: "destructive",
                  requireReason: true,
                  onConfirm: async (reason) => { try { await doAction("status", { status: "banned", reason }) } catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) } },
                })}>
                <Ban className="w-3.5 h-3.5" /> Ban
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="font-mono gap-1.5 text-xs"
                onClick={() => confirm_({
                  title: "Unban Account",
                  description: "Remove the ban and restore access.",
                  requireReason: true,
                  onConfirm: async (reason) => { try { await doAction("status", { status: "active", reason }) } catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) } },
                })}>
                <ShieldCheck className="w-3.5 h-3.5" /> Unban
              </Button>
            )}
          </div>

          {/* Refund */}
          {!!account?.stripeCustomerId && (
            <div className="mt-3 pt-3 border-t border-border/40">
              <p className="text-[10px] font-mono font-bold text-muted-foreground mb-2">INITIATE REFUND</p>
              <div className="flex gap-2 items-center">
                <Input className="font-mono text-xs h-8" placeholder="Charge ID (ch_…)" value={refundChargeId} onChange={e => setRefundChargeId(e.target.value)} />
                <Button size="sm" variant="destructive" className="font-mono text-xs shrink-0"
                  disabled={!refundChargeId}
                  onClick={() => confirm_({
                    title: "Issue Refund",
                    description: `Refund charge ${refundChargeId}. This cannot be undone.`,
                    variant: "destructive",
                    requireReason: true,
                    onConfirm: async (reason) => {
                      try { await doAction("refund", { chargeId: refundChargeId, reason }) }
                      catch (e) { toast({ title: "Error", description: String(e), variant: "destructive" }) }
                    },
                  })}>
                  <DollarSign className="w-3.5 h-3.5" /> Refund
                </Button>
              </div>
            </div>
          )}

          {!!account?.stripeCustomerId && (
            <div className="mt-3">
              <a href={`https://dashboard.stripe.com/customers/${account.stripeCustomerId}`} target="_blank" rel="noreferrer">
                <Button size="sm" variant="outline" className="font-mono gap-1.5 text-xs">
                  <ExternalLink className="w-3.5 h-3.5" /> Open in Stripe
                </Button>
              </a>
            </div>
          )}
        </Section>

        <ConfirmDialog action={confirm} onClose={() => setConfirm(null)} />
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-mono font-bold text-muted-foreground tracking-widest uppercase border-b border-border/40 pb-1">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 text-sm min-h-[22px]">
      <span className="text-muted-foreground text-xs font-mono shrink-0 mt-0.5">{label}</span>
      <span className="text-right text-xs break-all">{children}</span>
    </div>
  )
}

// ── Mobile User Card ──────────────────────────────────────────────────────────

function UserCard({ user, onSelect }: { user: UserRow; onSelect: () => void }) {
  return (
    <Card className="bg-card shadow-sm cursor-pointer hover:border-primary/30 transition-colors" onClick={onSelect}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium text-sm truncate">{user.clerkName}</p>
            <p className="text-xs text-muted-foreground truncate">{user.clerkEmail}</p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            {planBadge(user.plan_key)}
            {statusBadge(user.subscription_status, user.account_status)}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground font-mono">
          <span>Cycle: {billingCycle(user.plan_key)}</span>
          <span>Preds: {user.total_predictions}</span>
          {user.failed_payment_count > 0 && <span className="text-destructive">Failed: {user.failed_payment_count}</span>}
          {user.cancel_at_period_end && <span className="text-warning">Cancel Scheduled</span>}
          {user.open_tickets > 0 && <span className="text-primary">{user.open_tickets} ticket{user.open_tickets > 1 ? "s" : ""}</span>}
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground/60 font-mono">
          <span>Joined {fmtDate(user.created_at)}</span>
          <span>Renews {fmtDate(user.current_period_end_at)}</span>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  const [, navigate] = useLocation()
  const { toast } = useToast()
  const [search, setSearch] = useState("")
  const [plan, setPlan] = useState("all")
  const [status, setStatus] = useState("all")
  const [billing, setBilling] = useState("all")
  const [failedOnly, setFailedOnly] = useState(false)
  const [cancelOnly, setCancelOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState("created_at")
  const [order, setOrder] = useState<"asc" | "desc">("desc")
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)

  const params = new URLSearchParams({
    page: String(page), limit: "50", sort, order,
    ...(search ? { search } : {}),
    ...(plan !== "all" ? { plan } : {}),
    ...(status !== "all" ? { status } : {}),
    ...(billing !== "all" ? { billing } : {}),
    ...(failedOnly ? { failedPayments: "1" } : {}),
    ...(cancelOnly ? { scheduledCancel: "1" } : {}),
  })

  const { data: statsData } = useQuery<Stats>({
    queryKey: ["admin-user-stats"],
    queryFn: async () => {
      const r = await fetch(api("/api/admin/users/stats"), { credentials: "include" })
      if (!r.ok) throw new Error("Failed to load stats")
      return r.json()
    },
    staleTime: 60_000,
  })

  const { data, isLoading, refetch } = useQuery<{ users: UserRow[]; total: number; page: number; pages: number }>({
    queryKey: ["admin-users", params.toString()],
    queryFn: async () => {
      const r = await fetch(api(`/api/admin/users?${params}`), { credentials: "include" })
      if (!r.ok) throw new Error("Failed to load users")
      return r.json()
    },
    staleTime: 30_000,
  })

  const toggleSort = (col: string) => {
    if (sort === col) setOrder(o => o === "asc" ? "desc" : "asc")
    else { setSort(col); setOrder("desc") }
    setPage(1)
  }

  const SortBtn = ({ col, label }: { col: string; label: string }) => (
    <button onClick={() => toggleSort(col)} className="flex items-center gap-1 text-left hover:text-primary transition-colors">
      {label}{sort === col ? (order === "asc" ? " ↑" : " ↓") : <ArrowUpDown className="w-3 h-3 opacity-30" />}
    </button>
  )

  const users = data?.users ?? []

  return (
    <div className="space-y-5 pb-16">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => window.history.back()} className="font-mono gap-1.5 shrink-0">
          <ChevronLeft className="w-4 h-4" /> Back
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl md:text-3xl font-display font-bold tracking-tight flex items-center gap-2">
            <Users className="w-6 h-6 text-primary" /> Users & Subscriptions
          </h1>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">Admin only — never exposed to subscribers</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" variant="outline" className="font-mono gap-1.5" onClick={() => refetch()}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          <a href={api(`/api/admin/users/export.csv`)} download>
            <Button size="sm" variant="outline" className="font-mono gap-1.5">
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Export CSV</span>
            </Button>
          </a>
        </div>
      </div>

      {/* Stats */}
      <SummaryStats stats={statsData} />

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            className="pl-8 h-9 font-mono text-sm"
            placeholder="Search name or email…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
          />
        </div>
        <select
          value={plan}
          onChange={e => { setPlan(e.target.value); setPage(1) }}
          className="h-9 px-2 rounded-md border border-input bg-background font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="all">All Plans</option>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="elite">Elite</option>
          <option value="team">Team</option>
        </select>
        <select
          value={status}
          onChange={e => { setStatus(e.target.value); setPage(1) }}
          className="h-9 px-2 rounded-md border border-input bg-background font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="trialing">Trialing</option>
          <option value="past_due">Past Due</option>
          <option value="canceled">Canceled</option>
          <option value="suspended">Suspended</option>
          <option value="banned">Banned</option>
        </select>
        <select
          value={billing}
          onChange={e => { setBilling(e.target.value); setPage(1) }}
          className="h-9 px-2 rounded-md border border-input bg-background font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="all">All Billing</option>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
        </select>
        <Button
          size="sm"
          variant={failedOnly ? "destructive" : "outline"}
          className="font-mono text-xs gap-1.5 h-9"
          onClick={() => { setFailedOnly(f => !f); setPage(1) }}>
          <AlertTriangle className="w-3.5 h-3.5" /> Failed
        </Button>
        <Button
          size="sm"
          variant={cancelOnly ? "destructive" : "outline"}
          className="font-mono text-xs gap-1.5 h-9"
          onClick={() => { setCancelOnly(c => !c); setPage(1) }}>
          <XCircle className="w-3.5 h-3.5" /> Canceling
        </Button>
      </div>

      <p className="text-[11px] font-mono text-muted-foreground">
        {data?.total != null ? `${data.total.toLocaleString()} users` : ""}{isLoading ? " loading…" : ""}
      </p>

      {/* ── Mobile card list ── */}
      <div className="md:hidden space-y-3">
        {isLoading && [1,2,3].map(i => <div key={i} className="h-24 bg-muted rounded-xl animate-pulse" />)}
        {users.map(u => (
          <UserCard key={u.clerk_user_id} user={u} onSelect={() => setSelectedUserId(u.clerk_user_id)} />
        ))}
        {!isLoading && users.length === 0 && (
          <p className="text-center text-muted-foreground text-sm py-8">No users found</p>
        )}
      </div>

      {/* ── Desktop table ── */}
      <div className="hidden md:block overflow-x-auto rounded-xl border border-border/50">
        <table className="w-full text-xs font-mono">
          <thead className="bg-secondary/30">
            <tr>
              {[
                { col: null, label: "User" },
                { col: "plan_key", label: "Plan" },
                { col: "subscription_status", label: "Status" },
                { col: null, label: "Cycle" },
                { col: "current_period_end_at", label: "Renews" },
                { col: "failed_payment_count", label: "Failed" },
                { col: "last_payment_at", label: "Last Pmt" },
                { col: null, label: "Preds" },
                { col: null, label: "Tickets" },
                { col: "created_at", label: "Joined" },
              ].map(({ col, label }) => (
                <th key={label} className="px-3 py-2 text-left text-[10px] font-bold text-muted-foreground tracking-widest whitespace-nowrap">
                  {col ? <SortBtn col={col} label={label} /> : label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {isLoading && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {users.map(u => (
              <tr
                key={u.clerk_user_id}
                className="hover:bg-secondary/20 cursor-pointer transition-colors"
                onClick={() => setSelectedUserId(u.clerk_user_id)}
              >
                <td className="px-3 py-2.5 max-w-[200px]">
                  <p className="font-medium text-foreground truncate">{u.clerkName}</p>
                  <p className="text-muted-foreground truncate">{u.clerkEmail}</p>
                </td>
                <td className="px-3 py-2.5">{planBadge(u.plan_key)}</td>
                <td className="px-3 py-2.5">{statusBadge(u.subscription_status, u.account_status)}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{billingCycle(u.plan_key)}</td>
                <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{fmtDate(u.current_period_end_at)}</td>
                <td className="px-3 py-2.5">
                  {u.failed_payment_count > 0 ? <span className="text-destructive font-bold">{u.failed_payment_count}</span> : <span className="text-muted-foreground">0</span>}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{fmtDate(u.last_payment_at)}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{u.total_predictions.toLocaleString()}</td>
                <td className="px-3 py-2.5">
                  {u.open_tickets > 0 ? <span className="text-primary">{u.open_tickets}</span> : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{fmtDate(u.created_at)}</td>
              </tr>
            ))}
            {!isLoading && users.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">No users found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {(data?.pages ?? 1) > 1 && (
        <div className="flex items-center justify-between gap-4">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="font-mono gap-1.5">
            <ChevronLeft className="w-4 h-4" /> Prev
          </Button>
          <span className="text-xs font-mono text-muted-foreground">Page {page} of {data?.pages}</span>
          <Button size="sm" variant="outline" disabled={page >= (data?.pages ?? 1)} onClick={() => setPage(p => p + 1)} className="font-mono gap-1.5">
            Next <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}

      {/* User Detail Panel */}
      {selectedUserId && (
        <UserDetailPanel userId={selectedUserId} onClose={() => setSelectedUserId(null)} />
      )}
    </div>
  )
}
