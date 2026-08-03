import { useMemo, useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import {
  AlertCircle, BadgeDollarSign, CalendarDays, Check, CheckCircle2,
  CreditCard, Crown, ExternalLink, Lock, RefreshCw, ShieldCheck,
  Sparkles, Users, X, Zap,
} from "lucide-react";
import { useGetAdminAuthStatus } from "@/hooks/useGetAdminAuthStatus";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useGetPaymentsStatus,
  useGetMyPaymentsStatus,
  useCreatePaymentsCheckoutSession,
  useCreateBillingPortalSession,
  getMyPaymentsStatusQueryKey,
  getPaymentsStatusQueryKey,
} from "@workspace/api-client-react";
import type { SubscriptionTier } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

// ── Types ─────────────────────────────────────────────────────────────────────

type PlanId = "pro" | "pro_annual" | "elite" | "elite_annual" | "team";
type BillingInterval = "monthly" | "annual";

// ── Feature definitions ───────────────────────────────────────────────────────

interface Feature {
  label: string;
  pro: boolean;
  elite: boolean;
  team: boolean;
}

const FEATURES: Feature[] = [
  { label: "Unlimited predictions",                     pro: true,  elite: true,  team: true  },
  { label: "Full prediction history & ledger",          pro: true,  elite: true,  team: true  },
  { label: "Complete 10-signal match breakdown",        pro: true,  elite: true,  team: true  },
  { label: "Data quality score per prediction",         pro: true,  elite: true,  team: true  },
  { label: "Upset risk analysis",                       pro: true,  elite: true,  team: true  },
  { label: "Model agreement scoring",                   pro: true,  elite: true,  team: true  },
  { label: "Surface & competition-level accuracy",      pro: true,  elite: true,  team: true  },
  { label: "Plain-language pick explanation",           pro: true,  elite: true,  team: true  },
  { label: "Full model monitoring dashboard",           pro: false, elite: true,  team: true  },
  { label: "Confidence calibration analysis",           pro: false, elite: true,  team: true  },
  { label: "Recommendation performance tracking",       pro: false, elite: true,  team: true  },
  { label: "Historical model trends & version history", pro: false, elite: true,  team: true  },
  { label: "20,000-run Monte Carlo simulation",         pro: false, elite: true,  team: true  },
  { label: "Elite Tier badge on top predictions",       pro: false, elite: true,  team: true  },
  { label: "Team workspace (shared predictions)",       pro: false, elite: false, team: true  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(value: string | Date | null | undefined, fallback = "Not applicable"): string {
  if (!value) return fallback;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function maskCustomerId(id: string | null | undefined): string {
  if (!id) return "NONE";
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}••••${id.slice(-4)}`;
}

function statusLabel(status: string | null | undefined): string {
  if (!status) return "Inactive";
  const MAP: Record<string, string> = {
    active: "Active",
    trialing: "Trialing",
    past_due: "Past Due",
    unpaid: "Unpaid",
    canceled: "Canceled",
    incomplete: "Incomplete",
    incomplete_expired: "Expired",
  };
  return MAP[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

function statusVariant(status: string | null | undefined): "success" | "warning" | "destructive" | "outline" {
  if (status === "active" || status === "trialing") return "success";
  if (status === "past_due" || status === "unpaid") return "warning";
  if (status === "canceled" || status === "incomplete" || status === "incomplete_expired") return "destructive";
  return "outline";
}

function tierDisplayName(tier: SubscriptionTier, planKey?: string | null): string {
  switch (tier) {
    case "team":         return "Team";
    case "elite_annual": return "Elite Annual";
    case "elite":        return "Elite";
    case "pro_annual":   return "Pro Annual";
    case "pro":          return "Pro";
    default:             return planKey ?? "Free";
  }
}

// ── Annual savings badge ──────────────────────────────────────────────────────

function SavingsBadge({ monthlyCents, annualCents }: { monthlyCents: number; annualCents: number }) {
  const annualEquivalent = monthlyCents * 12;
  const savingsPct = Math.round((1 - annualCents / annualEquivalent) * 100);
  return (
    <Badge className="text-[10px] font-mono tracking-widest bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/15">
      SAVE {savingsPct}%
    </Badge>
  );
}

// ── Feature row ───────────────────────────────────────────────────────────────

function FeatureRow({ feature, tier }: { feature: Feature; tier: "pro" | "elite" | "team" }) {
  const included = tier === "team" ? feature.team : tier === "elite" ? feature.elite : feature.pro;
  return (
    <div className={`flex items-center gap-3 py-2 text-sm ${!included ? "text-muted-foreground/40" : "text-foreground/90"}`}>
      {included ? (
        <Check className="w-4 h-4 text-primary shrink-0" />
      ) : (
        <X className="w-4 h-4 text-muted-foreground/25 shrink-0" />
      )}
      <span className={!included ? "line-through decoration-muted-foreground/20" : ""}>{feature.label}</span>
    </div>
  );
}

// ── Plan card ─────────────────────────────────────────────────────────────────

interface PlanConfig {
  id: PlanId;
  tier: "pro" | "elite" | "team";
  label: string;
  monthlyPrice: string;
  annualPrice: string | null;
  annualPriceId: PlanId | null;
  monthlyCents: number;
  annualCents: number | null;
  tagline: string;
  icon: React.ReactNode;
  accent: boolean;
}

const PLANS: PlanConfig[] = [
  {
    id: "pro",
    tier: "pro",
    label: "Pro",
    monthlyPrice: "$19.99",
    annualPrice: "$179",
    annualPriceId: "pro_annual",
    monthlyCents: 1999,
    annualCents: 17900,
    tagline: "Unlimited predictions with full match breakdowns, model signals, and performance insights. Answers: who wins and why?",
    icon: <Zap className="w-5 h-5 text-primary" />,
    accent: false,
  },
  {
    id: "elite",
    tier: "elite",
    label: "Elite",
    monthlyPrice: "$49.99",
    annualPrice: "$450",
    annualPriceId: "elite_annual",
    monthlyCents: 4999,
    annualCents: 45000,
    tagline: "Everything in Pro plus deep model analytics — calibration, monitoring, and confidence tracking. Answers: how trustworthy is the AI?",
    icon: <Crown className="w-5 h-5 text-primary" />,
    accent: true,
  },
  {
    id: "team",
    tier: "team",
    label: "Team",
    monthlyPrice: "$249",
    annualPrice: null,
    annualPriceId: null,
    monthlyCents: 24900,
    annualCents: null,
    tagline: "Everything in Elite for your whole team — shared workspace, collaborative prediction tracking, and team performance analytics.",
    icon: <Users className="w-5 h-5 text-primary" />,
    accent: false,
  },
];

function PlanCard({
  plan,
  interval,
  currentTier,
  isPending,
  onSubscribe,
  onPortal,
}: {
  plan: PlanConfig;
  interval: BillingInterval;
  currentTier: SubscriptionTier;
  isPending: boolean;
  onSubscribe: (planId: PlanId) => void;
  onPortal: () => void;
}) {
  const isAnnual = interval === "annual" && plan.annualPriceId !== null;
  const checkoutPlanId: PlanId = isAnnual ? plan.annualPriceId! : plan.id;

  // Determine which tiers count as "current" for this plan
  const isCurrent =
    currentTier === plan.id ||
    (plan.tier === "pro"   && currentTier === "pro_annual") ||
    (plan.tier === "elite" && currentTier === "elite_annual");

  const isUpgradeFromPro = (currentTier === "pro" || currentTier === "pro_annual") && (plan.tier === "elite" || plan.tier === "team");
  const isUpgradeFromElite = (currentTier === "elite" || currentTier === "elite_annual") && plan.tier === "team";
  const isFree = currentTier === "free";

  return (
    <Card className={`relative flex flex-col overflow-hidden transition-all duration-300 ${
      plan.accent
        ? "border-primary/40 shadow-lg shadow-primary/10 bg-gradient-to-b from-primary/5 to-background"
        : "border-border/60"
    } ${isCurrent ? "ring-2 ring-primary/40" : ""}`}>
      {plan.accent && (
        <div className="absolute top-0 inset-x-0 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent" />
      )}
      {isCurrent && (
        <div className="absolute top-3 right-3">
          <Badge variant="success" className="font-mono text-[9px] tracking-widest gap-1">
            <CheckCircle2 className="w-2.5 h-2.5" /> CURRENT
          </Badge>
        </div>
      )}

      <CardHeader className="pb-4 pt-6 px-6">
        <div className="flex items-center gap-2 mb-1">
          {plan.icon}
          <CardTitle className="text-2xl font-display font-bold">{plan.label}</CardTitle>
          {isAnnual && plan.annualCents !== null && (
            <SavingsBadge monthlyCents={plan.monthlyCents} annualCents={plan.annualCents} />
          )}
        </div>

        <div className="flex items-baseline gap-1 mt-2">
          <span className="text-4xl font-display font-bold tracking-tight">
            {isAnnual ? plan.annualPrice : plan.monthlyPrice}
          </span>
          <span className="text-sm text-muted-foreground font-mono">
            {isAnnual ? "/yr" : plan.tier === "team" ? "/mo" : "/mo"}
          </span>
        </div>

        {isAnnual && plan.monthlyCents !== null && plan.annualCents !== null && (
          <p className="text-xs text-muted-foreground mt-0.5">
            ≈ ${(plan.annualCents / 12 / 100).toFixed(2)}/mo — saves ${((plan.monthlyCents * 12 - plan.annualCents) / 100).toFixed(0)}/yr
          </p>
        )}

        <CardDescription className="mt-2 text-sm leading-relaxed">{plan.tagline}</CardDescription>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-6 px-6 pb-6">
        <div className="space-y-1 divide-y divide-border/30">
          {FEATURES.map((f) => (
            <FeatureRow key={f.label} feature={f} tier={plan.tier} />
          ))}
        </div>

        <div className="mt-auto pt-2">
          {isFree && (
            <Button
              className="w-full font-mono"
              variant={plan.accent ? "default" : "outline"}
              onClick={() => onSubscribe(checkoutPlanId)}
              disabled={isPending}
            >
              <CreditCard className="w-4 h-4 mr-2" />
              Subscribe to {plan.label}
            </Button>
          )}
          {isCurrent && (
            <Button className="w-full font-mono" variant="outline" onClick={onPortal} disabled={isPending}>
              <ExternalLink className="w-4 h-4 mr-2" />
              Manage Billing
            </Button>
          )}
          {!isFree && !isCurrent && (isUpgradeFromPro || isUpgradeFromElite) && (
            <Button className="w-full font-mono" variant={plan.accent ? "default" : "outline"} onClick={() => onSubscribe(checkoutPlanId)} disabled={isPending}>
              {plan.tier === "team" ? <Users className="w-4 h-4 mr-2" /> : <Crown className="w-4 h-4 mr-2" />}
              Upgrade to {plan.label}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Billing interval toggle ───────────────────────────────────────────────────

function IntervalToggle({ value, onChange }: { value: BillingInterval; onChange: (v: BillingInterval) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-border/60 bg-muted/40 p-1">
      <button
        onClick={() => onChange("monthly")}
        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono transition-all ${
          value === "monthly"
            ? "bg-background text-foreground shadow-sm border border-border/60"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        Monthly
      </button>
      <button
        onClick={() => onChange("annual")}
        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono transition-all ${
          value === "annual"
            ? "bg-background text-foreground shadow-sm border border-border/60"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <CalendarDays className="w-3 h-3" />
        Annual
        <span className="text-emerald-400">Save 25%</span>
      </button>
    </div>
  );
}

// ── Billing card ──────────────────────────────────────────────────────────────

function BillingCard({
  data,
  isLoading,
  isPending,
  onPortal,
  onRefresh,
}: {
  data: { tier: SubscriptionTier; active: boolean; account: { stripeCustomerId: string | null; stripeSubscriptionId: string | null; subscriptionStatus: string | null; planKey: string | null; accessGrantedAt: string | Date | null; currentPeriodEndAt: string | Date | null; trialEndAt: string | Date | null; cancelAtPeriodEnd: boolean; canceledAt: string | Date | null } | null } | undefined;
  isLoading: boolean;
  isPending: boolean;
  onPortal: () => void;
  onRefresh: () => void;
}) {
  const account = data?.account ?? null;
  const status = account?.subscriptionStatus ?? null;
  const hasCustomer = Boolean(account?.stripeCustomerId);

  const renewalLabel =
    account?.cancelAtPeriodEnd ? "Access Ends" :
    status === "trialing" ? "Trial Ends" :
    "Renewal End";

  const renewalDate =
    account?.cancelAtPeriodEnd ? formatDate(account.currentPeriodEndAt) :
    status === "trialing" ? formatDate(account?.trialEndAt) :
    formatDate(account?.currentPeriodEndAt);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5" /> Account Billing</CardTitle>
          <CardDescription>Customer, subscription, renewal, and billing portal controls.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-9 w-40" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5" /> Account Billing</CardTitle>
        <CardDescription>Customer, subscription, renewal, and billing portal controls.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            CUSTOMER: {maskCustomerId(account?.stripeCustomerId)}
          </Badge>
          <Badge variant="outline" className="font-mono text-xs">
            SUB: {account?.stripeSubscriptionId ? account.stripeSubscriptionId.slice(0, 8) + "••••" : "NONE"}
          </Badge>
          <Badge variant={statusVariant(status)} className="font-mono text-xs uppercase">
            {statusLabel(status)}
          </Badge>
          {data?.tier && data.tier !== "free" && (
            <Badge variant="success" className="font-mono text-xs uppercase">
              {tierDisplayName(data.tier, account?.planKey)}
            </Badge>
          )}
        </div>

        <div className="rounded-xl border border-dashed p-4 text-muted-foreground">
          <div className="flex items-center gap-2 font-medium text-foreground text-sm">
            <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
            Webhook-confirmed access
          </div>
          <p className="mt-2 text-xs leading-relaxed">
            Access is granted once Stripe's webhook confirms your payment — usually within seconds of checkout. If your plan hasn't activated after a minute, try refreshing.
          </p>
        </div>

        <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
          <div className="rounded-lg border p-3">
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-mono mb-1">Access Granted</div>
            <div className="font-semibold">{formatDate(account?.accessGrantedAt, data?.active ? "Active" : "Free")}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-mono mb-1">{renewalLabel}</div>
            <div className="font-semibold">{renewalDate}</div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          {hasCustomer ? (
            <Button variant="secondary" onClick={onPortal} disabled={isPending} className="gap-2 text-sm">
              <ExternalLink className="h-4 w-4" /> Open Billing Portal
            </Button>
          ) : (
            <Button variant="outline" disabled className="gap-2 text-sm text-muted-foreground">
              <CreditCard className="h-4 w-4" /> Choose a Plan
            </Button>
          )}
          <Button variant="outline" onClick={onRefresh} disabled={isLoading} className="gap-2 text-sm">
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            Refresh Status
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const queryClient = useQueryClient();
  const [interval, setInterval] = useState<BillingInterval>("monthly");

  const {
    data: myData,
    isLoading: myLoading,
    refetch: myRefetch,
  } = useGetMyPaymentsStatus({
    query: { queryKey: getMyPaymentsStatusQueryKey() },
  });

  const { data: adminData, isLoading: adminLoading } = useGetPaymentsStatus({
    query: { queryKey: getPaymentsStatusQueryKey() },
  });

  const createCheckout = useCreatePaymentsCheckoutSession();
  const createPortal = useCreateBillingPortalSession();
  const [location, setLocation] = useLocation();
  const { data: adminAuth } = useGetAdminAuthStatus();
  const isAdmin = adminAuth?.authenticated === true;
  const { toast } = useToast();

  const view = useMemo<"pricing" | "billing" | "admin">(() => {
    if (location.startsWith("/payments/billing")) return "billing";
    if (location.startsWith("/payments/admin") && isAdmin) return "admin";
    return "pricing";
  }, [location, isAdmin]);

  const data = view === "admin" ? adminData : myData;
  const isLoading = view === "admin" ? adminLoading : myLoading;
  const currentTier: SubscriptionTier = data?.tier ?? "free";

  const startCheckout = useCallback(async (planId: PlanId) => {
    try {
      const result = await createCheckout.mutateAsync({ data: { returnPath: "/payments", plan: planId } });
      if (result.url) window.location.assign(result.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to start checkout. Please try again.";
      toast({ title: "Checkout unavailable", description: message, variant: "destructive" });
    }
  }, [createCheckout, toast]);

  const openPortal = useCallback(async () => {
    try {
      const result = await createPortal.mutateAsync({ data: { returnPath: "/payments" } });
      window.location.assign(result.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to open billing portal. Please try again.";
      toast({ title: "Billing portal unavailable", description: message, variant: "destructive" });
    }
  }, [createPortal, toast]);

  async function handleRefresh() {
    await myRefetch();
    if (isAdmin) await queryClient.invalidateQueries({ queryKey: getPaymentsStatusQueryKey() });
  }

  const isPending = createCheckout.isPending || createPortal.isPending;

  return (
    <div className="mx-auto max-w-7xl space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col gap-3 border-b border-border/50 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.25em] text-muted-foreground mb-1">
            <ShieldCheck className="h-4 w-4" />
            Subscription
          </div>
          <h1 className="text-3xl font-display font-bold tracking-tight">Plans & Billing</h1>
          <p className="max-w-2xl text-muted-foreground mt-1">
            Choose the plan that matches how you use Tennis Matrix AI.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant={view === "pricing" ? "default" : "outline"} size="sm" onClick={() => setLocation("/payments")} className="font-mono text-xs gap-1.5">
            <BadgeDollarSign className="h-3.5 w-3.5" /> Plans
          </Button>
          <Button variant={view === "billing" ? "default" : "outline"} size="sm" onClick={() => setLocation("/payments/billing")} className="font-mono text-xs gap-1.5">
            <CreditCard className="h-3.5 w-3.5" /> Billing
          </Button>
          {isAdmin && (
            <Button variant={view === "admin" ? "default" : "outline"} size="sm" onClick={() => setLocation("/payments/admin")} className="font-mono text-xs gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> Admin
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={isLoading} className="font-mono text-xs gap-1.5">
            <Sparkles className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Active plan banner */}
      {!isLoading && myData?.active && (
        <div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
          <span className="font-medium">
            You are on the <strong className="text-primary">{tierDisplayName(myData.tier, myData.account?.planKey)}</strong> plan.
            {myData.account?.currentPeriodEndAt && (
              <span className="text-muted-foreground font-normal ml-1">
                Renews {new Date(myData.account.currentPeriodEndAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.
              </span>
            )}
          </span>
        </div>
      )}

      {/* Pricing view */}
      {view === "pricing" && (
        <>
          {/* Billing interval toggle */}
          <div className="flex justify-center">
            <IntervalToggle value={interval} onChange={setInterval} />
          </div>

          {myLoading ? (
            <div className="grid gap-6 md:grid-cols-3">
              <Skeleton className="h-[760px] rounded-xl" />
              <Skeleton className="h-[760px] rounded-xl" />
              <Skeleton className="h-[760px] rounded-xl" />
            </div>
          ) : (
            <div className="grid gap-6 md:grid-cols-3 items-start">
              {PLANS.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  interval={interval}
                  currentTier={currentTier}
                  isPending={isPending}
                  onSubscribe={startCheckout}
                  onPortal={openPortal}
                />
              ))}
            </div>
          )}

          {/* Team note — always monthly */}
          <p className="text-center text-xs text-muted-foreground">
            Team plan is billed monthly only · Pro and Elite available monthly or annually
          </p>

          {/* Upgrade teaser for Pro users */}
          {!myLoading && (currentTier === "pro" || currentTier === "pro_annual") && (
            <Card className="border-primary/20 bg-primary/5">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-display flex items-center gap-2">
                  <Lock className="w-4 h-4 text-primary" />
                  Unlock Elite analytics
                </CardTitle>
                <CardDescription>
                  Upgrade to Elite to see how well-calibrated the AI is, track recommendation tier accuracy, and review the full model monitoring dashboard.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="default" className="font-mono" onClick={() => void startCheckout(interval === "annual" ? "elite_annual" : "elite")} disabled={isPending}>
                  <Crown className="w-4 h-4 mr-2" />
                  Upgrade to Elite — {interval === "annual" ? "$475/yr" : "$49.99/mo"}
                </Button>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Billing view */}
      {view === "billing" && (
        <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <BillingCard
            data={myData}
            isLoading={myLoading}
            isPending={isPending}
            onPortal={openPortal}
            onRefresh={handleRefresh}
          />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5" /> Active Entitlements</CardTitle>
              <CardDescription>Features currently unlocked on your account.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {myLoading && <Skeleton className="h-32 w-full" />}
              {!myLoading && myData?.entitlements && Object.entries(myData.entitlements).filter(([, v]) => v).map(([key]) => (
                <div key={key} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                  <span className="font-mono text-xs">{key}</span>
                  <Badge variant="success">Enabled</Badge>
                </div>
              ))}
              {!myLoading && myData?.entitlements && Object.entries(myData.entitlements).filter(([, v]) => !v).length > 0 && (
                <p className="text-xs text-muted-foreground pt-1">
                  {Object.entries(myData.entitlements).filter(([, v]) => !v).length} features locked on current plan.
                </p>
              )}
              {!myLoading && !myData?.active && (
                <p className="text-sm text-muted-foreground py-2">Subscribe to a plan to unlock features.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Admin view */}
      {view === "admin" && (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Feature flag</CardTitle></CardHeader><CardContent><div className="text-xl font-semibold">{adminData?.featureFlagEnabled ? "Enabled" : "Disabled"}</div></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Webhook events</CardTitle></CardHeader><CardContent><div className="text-xl font-semibold">{adminData?.recentWebhookEvents.length ?? 0}</div></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Workspace tier</CardTitle></CardHeader><CardContent><div className="text-xl font-semibold">{adminData?.active ? tierDisplayName(adminData.tier, adminData.account?.planKey) : "Inactive"}</div></CardContent></Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Webhook Audit Log</CardTitle>
              <CardDescription>Raw event history for admin troubleshooting.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {adminData?.recentWebhookEvents.length ? adminData.recentWebhookEvents.map((event) => (
                <div key={event.stripeEventId} className="flex flex-col gap-1 rounded-lg border p-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="font-medium">{event.eventType}</div>
                    <div className="text-sm text-muted-foreground">{event.stripeEventId} · {event.processingStatus}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">{formatDate(event.receivedAt)}</div>
                </div>
              )) : (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No webhook events have been processed yet.</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> Stripe Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground font-mono">
              <p>Secret key: {adminData?.stripe.secretKeyConfigured ? "✓ configured" : "✗ missing"}</p>
              <p>Webhook secret: {adminData?.stripe.webhookSecretConfigured ? "✓ configured" : "✗ missing"}</p>
              <p>Pro Monthly price: {adminData?.stripe.priceId ?? "not configured"}</p>
              <p>Elite Monthly price: {adminData?.stripe.elitePriceId ?? "not configured"}</p>
              <p>Pro Annual price: {process.env.STRIPE_PRO_ANNUAL_PRICE_ID ? "configured" : "not configured"}</p>
              <p>Elite Annual price: {process.env.STRIPE_ELITE_ANNUAL_PRICE_ID ? "configured" : "not configured"}</p>
              <p>Team price: {process.env.STRIPE_TEAM_PRICE_ID ? "configured" : "not configured"}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
