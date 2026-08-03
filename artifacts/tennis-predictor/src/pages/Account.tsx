import { useUser, useClerk } from "@clerk/react"
import { UserCircle, LogOut, Mail, CreditCard, Shield, Crown, Zap, Users, CheckCircle2, AlertCircle, MessageSquare } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useGetMyPaymentsStatus, getMyPaymentsStatusQueryKey } from "@workspace/api-client-react"
import type { SubscriptionTier } from "@workspace/api-client-react"
import { isPaymentsV2Enabled } from "@/lib/paymentsFeatureFlag"
import { useLocation } from "wouter"
import { useEffect, useState } from "react"

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")
const api = (path: string) => `${BASE}${path}`

function planIcon(tier: SubscriptionTier) {
  if (tier === "team")                             return <Users className="w-4 h-4 text-primary" />
  if (tier === "elite" || tier === "elite_annual") return <Crown className="w-4 h-4 text-primary" />
  if (tier === "pro"   || tier === "pro_annual")   return <Zap   className="w-4 h-4 text-primary" />
  return null
}

function planLabel(tier: SubscriptionTier, planKey?: string | null): string {
  switch (tier) {
    case "team":         return "Team"
    case "elite_annual": return "Elite Annual"
    case "elite":        return "Elite"
    case "pro_annual":   return "Pro Annual"
    case "pro":          return "Pro"
    default:             return planKey ?? "Free"
  }
}

type AccountRow = {
  cancelAtPeriodEnd: boolean
  subscriptionStatus: string | null
  currentPeriodEndAt: string | null
  trialEndAt: string | null
} | null

function getRenewalLabel(account: AccountRow): string {
  if (!account) return "Renewal"
  if (account.cancelAtPeriodEnd) return "Access ends"
  if (account.subscriptionStatus === "trialing") return "Trial ends"
  return "Renews"
}

function getRenewalDate(account: AccountRow): string {
  if (!account) return "—"
  const raw = account.subscriptionStatus === "trialing"
    ? account.trialEndAt
    : account.currentPeriodEndAt
  if (!raw) return "—"
  return new Date(raw).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export default function AccountPage() {
  const { user, isLoaded } = useUser()
  const { signOut } = useClerk()
  const [location, setLocation] = useLocation()
  const paymentsEnabled = isPaymentsV2Enabled()
  const [unreadCount, setUnreadCount] = useState(0)

  const { data: billing, isLoading: billingLoading } = useGetMyPaymentsStatus({
    query: { queryKey: getMyPaymentsStatusQueryKey(), enabled: paymentsEnabled },
  })

  // Fetch unread support message count for badge
  useEffect(() => {
    if (!isLoaded || !user) return
    fetch(api("/api/support/unread-count"), { credentials: "include" })
      .then(r => r.ok ? r.json() : { count: 0 })
      .then(d => setUnreadCount(d.count ?? 0))
      .catch(() => {})
  }, [isLoaded, user])

  if (!isLoaded) {
    return (
      <div className="space-y-6 max-w-2xl mx-auto">
        <Skeleton className="h-12 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  const email = user?.emailAddresses?.[0]?.emailAddress
  const displayName = user?.fullName ?? user?.firstName ?? email?.split("@")[0] ?? "Account"
  const createdAt = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" })
    : null

  const tier: SubscriptionTier = billing?.tier ?? "free"
  const isActive = billing?.active === true
  const account = billing?.account ?? null

  const handleSupportClick = () => {
    // Save current page so Support's Back button can return here
    sessionStorage.setItem("support-from", location)
    setLocation("/support")
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-2xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-primary/10 rounded-lg">
            <UserCircle className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-4xl font-display font-bold tracking-tight">Account</h1>
        </div>
        <p className="text-muted-foreground text-lg">Manage your profile and subscription.</p>
      </div>

      {/* Profile */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <h2 className="text-sm font-mono font-bold text-muted-foreground tracking-widest uppercase">Profile</h2>
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
              {user?.imageUrl ? (
                <img src={user.imageUrl} alt={displayName} className="w-14 h-14 rounded-full object-cover" />
              ) : (
                <UserCircle className="w-7 h-7 text-primary" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-display font-bold text-lg truncate">{displayName}</p>
              {email && (
                <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-0.5 truncate">
                  <Mail className="w-3.5 h-3.5 shrink-0" />
                  {email}
                </p>
              )}
              {createdAt && (
                <p className="text-xs font-mono text-muted-foreground/60 mt-1">Member since {createdAt}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Subscription */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <h2 className="text-sm font-mono font-bold text-muted-foreground tracking-widest uppercase">Subscription</h2>

          {billingLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-8 w-40" />
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <CreditCard className="w-5 h-5 text-muted-foreground shrink-0" />
                  <div>
                    {isActive ? (
                      <>
                        <div className="flex items-center gap-2">
                          {planIcon(tier)}
                          <p className="font-semibold">{planLabel(tier, account?.planKey)}</p>
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {getRenewalLabel(account)} {getRenewalDate(account)}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="font-medium">No active plan</p>
                        <p className="text-sm text-muted-foreground">Subscribe to unlock all features</p>
                      </>
                    )}
                  </div>
                </div>

                {isActive ? (
                  <Badge variant="success" className="font-mono text-xs gap-1 shrink-0">
                    <CheckCircle2 className="w-3 h-3" /> Active
                  </Badge>
                ) : (
                  <Badge variant="outline" className="font-mono text-xs gap-1 shrink-0 text-muted-foreground">
                    <AlertCircle className="w-3 h-3" /> Free
                  </Badge>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {isActive ? (
                  <Button variant="outline" size="sm" className="font-mono"
                    onClick={() => setLocation("/payments/billing")}>
                    <CreditCard className="w-4 h-4 mr-2" />
                    Manage Billing
                  </Button>
                ) : (
                  <Button variant="default" size="sm" className="font-mono"
                    onClick={() => setLocation("/payments")}>
                    <Zap className="w-4 h-4 mr-2" />
                    View Plans
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Support */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <h2 className="text-sm font-mono font-bold text-muted-foreground tracking-widest uppercase">Support</h2>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <MessageSquare className="w-5 h-5 text-muted-foreground shrink-0" />
              <div>
                <p className="font-medium text-sm">Contact Support</p>
                <p className="text-xs text-muted-foreground mt-0.5">Report a problem, request a feature, or ask a question.</p>
              </div>
            </div>
            {unreadCount > 0 && (
              <Badge className="bg-primary text-primary-foreground font-mono text-xs gap-1 shrink-0">
                {unreadCount} new
              </Badge>
            )}
          </div>
          <Button variant="outline" size="sm" className="font-mono gap-2" onClick={handleSupportClick}>
            <MessageSquare className="w-4 h-4" />
            Open Support
            {unreadCount > 0 && (
              <span className="ml-1 w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center font-bold">
                {unreadCount}
              </span>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <h2 className="text-sm font-mono font-bold text-muted-foreground tracking-widest uppercase">Security</h2>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Shield className="w-4 h-4 shrink-0" />
            <span>Authentication managed securely via Clerk.</span>
          </div>
        </CardContent>
      </Card>

      {/* Sign out */}
      <div className="pt-2">
        <Button
          variant="outline"
          className="font-mono text-destructive hover:text-destructive border-destructive/30 hover:bg-destructive/5 hover:border-destructive/50 w-full sm:w-auto"
          onClick={() => signOut({ redirectUrl: basePath || "/" })}
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sign Out
        </Button>
      </div>
    </div>
  )
}
