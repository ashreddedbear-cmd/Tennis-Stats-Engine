import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { AlertCircle, BadgeDollarSign, CheckCircle2, CreditCard, ExternalLink, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetPaymentsStatus, useCreatePaymentsCheckoutSession, useCreateBillingPortalSession, getPaymentsStatusQueryKey } from "@workspace/api-client-react";
import { isPaymentsV2Enabled } from "@/lib/paymentsFeatureFlag";

const ENTITLEMENT_LABELS: Record<string, string> = {
  predictionHistory: "Prediction history",
  walkForward: "Walk-Forward",
  shadowReplay: "Shadow Replay",
  optimizer: "Optimizer",
  competitiveBalance: "Competitive Balance",
  evidenceReliability: "Evidence Reliability",
  developerAnalytics: "Developer Analytics",
  eliteRecommendations: "Elite Recommendations",
  alerts: "Alerts",
  teamWorkspace: "Team Workspace",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function PaymentsPage() {
  const paymentsEnabled = isPaymentsV2Enabled();
  const { data, isLoading, refetch } = useGetPaymentsStatus({ query: { queryKey: getPaymentsStatusQueryKey(), enabled: paymentsEnabled } });
  const createCheckout = useCreatePaymentsCheckoutSession();
  const createPortal = useCreateBillingPortalSession();
  const [location, setLocation] = useLocation();

  const view = useMemo<"pricing" | "billing" | "admin">(() => {
    if (location.startsWith("/payments/billing")) return "billing";
    if (location.startsWith("/payments/admin")) return "admin";
    return "pricing";
  }, [location]);

  const entitlements = useMemo(() => data?.entitlements ?? null, [data]);
  const enabledFeatures = useMemo(() => Object.entries(entitlements ?? {}).filter(([, allowed]) => allowed).length, [entitlements]);

  async function startCheckout() {
    const result = await createCheckout.mutateAsync({ data: { returnPath: "/payments" } });
    if (result.url) window.location.assign(result.url);
  }

  async function openPortal() {
    const result = await createPortal.mutateAsync({ data: { returnPath: "/payments" } });
    window.location.assign(result.url);
  }

  if (!paymentsEnabled) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center gap-3 border-b border-border/50 pb-4">
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
            <CreditCard className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-display font-bold tracking-tight">Payments</h1>
            <p className="text-muted-foreground">Payments V2 is currently disabled.</p>
          </div>
        </div>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            The payments module is present but hidden behind <span className="font-mono">VITE_PAYMENTS_V2_ENABLED=false</span>.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col gap-3 border-b border-border/50 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.25em] text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            Payments V2
          </div>
          <h1 className="text-3xl font-display font-bold tracking-tight">Billing & Entitlements</h1>
          <p className="max-w-2xl text-muted-foreground">
            Stripe test-mode checkout, webhook-confirmed activation, and centralized feature entitlements for the workspace.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant={view === "pricing" ? "default" : "outline"} onClick={() => setLocation("/payments/pricing")} className="gap-2">Pricing & Checkout</Button>
          <Button variant={view === "billing" ? "default" : "outline"} onClick={() => setLocation("/payments/billing")} className="gap-2">Account Billing</Button>
          <Button variant={view === "admin" ? "default" : "outline"} onClick={() => setLocation("/payments/admin")} className="gap-2">Admin Payments</Button>
          <Button variant="outline" onClick={() => void refetch()} disabled={isLoading} className="gap-2">
            <Sparkles className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Feature Flag</CardTitle></CardHeader>
              <CardContent className="space-y-1"><div className="text-2xl font-semibold">Enabled</div><p className="text-sm text-muted-foreground">PAYMENTS_V2_ENABLED is on.</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Subscription</CardTitle></CardHeader>
              <CardContent className="space-y-1"><div className="text-2xl font-semibold">{data?.account?.subscriptionStatus ?? "inactive"}</div><p className="text-sm text-muted-foreground">{data?.active ? "Webhook-confirmed access is active." : "Waiting for webhook confirmation."}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Plan</CardTitle></CardHeader>
              <CardContent className="space-y-1"><div className="text-2xl font-semibold">{data?.stripe.planName}</div><p className="text-sm text-muted-foreground">Price: {data?.stripe.priceId ?? "not configured"}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Webhook Health</CardTitle></CardHeader>
              <CardContent className="space-y-1"><div className="text-2xl font-semibold">{data?.recentWebhookEvents.length ?? 0}</div><p className="text-sm text-muted-foreground">Logged events for auditability.</p></CardContent>
            </Card>
          </div>

          {view === "pricing" && (
            <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><BadgeDollarSign className="h-5 w-5" /> Pricing & Checkout</CardTitle>
                  <CardDescription>Stripe test-mode pricing is available only when the feature flag is enabled.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Current plan</div>
                    <div className="mt-1 text-2xl font-semibold">{data?.stripe.planName}</div>
                    <div className="mt-1 text-muted-foreground">Price ID: {data?.stripe.priceId ?? "not configured"}</div>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <div className="rounded-lg border p-3"><div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Enabled features</div><div className="mt-1 font-semibold">{enabledFeatures} / {entitlements ? Object.keys(entitlements).length : 0}</div></div>
                    <div className="rounded-lg border p-3"><div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Webhook gate</div><div className="mt-1 font-semibold">Access changes only after Stripe confirms</div></div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void startCheckout()} disabled={createCheckout.isPending} className="gap-2">
                      <CreditCard className="h-4 w-4" /> Start Checkout
                    </Button>
                    <Button variant="outline" onClick={() => void refetch()} disabled={isLoading} className="gap-2">
                      <Sparkles className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} /> Refresh status
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    By continuing, you agree to the <Link href="/terms" className="text-primary hover:underline">Terms of Service</Link> and acknowledge the <Link href="/privacy" className="text-primary hover:underline">Privacy Policy</Link> and <Link href="/cookies" className="text-primary hover:underline">Cookie Policy</Link>.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5" /> Included Access</CardTitle>
                  <CardDescription>The centralized entitlement service decides what a paid account can use.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {entitlements && Object.entries(entitlements).map(([key, allowed]) => (
                    <div key={key} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                      <span>{ENTITLEMENT_LABELS[key] ?? key}</span>
                      <Badge variant={allowed ? "success" : "outline"}>{allowed ? "Enabled" : "Locked"}</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}

          {view === "billing" && (
            <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5" /> Account Billing</CardTitle>
                  <CardDescription>Customer, subscription, renewal, and billing portal controls.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">Customer: {data?.account?.stripeCustomerId ?? "none"}</Badge>
                    <Badge variant="outline">Subscription: {data?.account?.stripeSubscriptionId ?? "none"}</Badge>
                    <Badge variant="outline">Status: {data?.account?.subscriptionStatus ?? "inactive"}</Badge>
                  </div>
                  <div className="rounded-xl border border-dashed p-4 text-muted-foreground">
                    <div className="flex items-center gap-2 font-medium text-foreground"><AlertCircle className="h-4 w-4 text-amber-500" /> Webhook-confirmed only</div>
                    <p className="mt-2">
                      Checkout creates a Stripe session, but access is not granted until the webhook verifies the event and updates the entitlement record.
                    </p>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <div className="rounded-lg border p-3"><div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Access granted</div><div className="mt-1 font-semibold">{formatDate(data?.account?.accessGrantedAt)}</div></div>
                    <div className="rounded-lg border p-3"><div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Renewal end</div><div className="mt-1 font-semibold">{formatDate(data?.account?.currentPeriodEndAt)}</div></div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => void openPortal()} disabled={createPortal.isPending || !data?.account?.stripeCustomerId} className="gap-2">
                      <ExternalLink className="h-4 w-4" /> Open Billing Portal
                    </Button>
                    <Button variant="outline" onClick={() => void refetch()} disabled={isLoading} className="gap-2">
                      <Sparkles className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} /> Refresh status
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Billing and invoices are processed through Stripe. Review <Link href="/terms" className="text-primary hover:underline">Terms</Link> and <Link href="/privacy" className="text-primary hover:underline">Privacy</Link>.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5" /> Central Entitlements</CardTitle>
                  <CardDescription>Every future premium module should read from this state only.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {entitlements && Object.entries(entitlements).map(([key, allowed]) => (
                    <div key={key} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                      <span>{ENTITLEMENT_LABELS[key] ?? key}</span>
                      <Badge variant={allowed ? "success" : "outline"}>{allowed ? "Enabled" : "Locked"}</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}

          {view === "admin" && (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-3">
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Feature flag</CardTitle></CardHeader><CardContent className="text-sm"><div className="text-xl font-semibold">{data?.featureFlagEnabled ? "Enabled" : "Disabled"}</div><div className="text-muted-foreground">Admin view follows the same flag.</div></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Webhook events</CardTitle></CardHeader><CardContent className="text-sm"><div className="text-xl font-semibold">{data?.recentWebhookEvents.length ?? 0}</div><div className="text-muted-foreground">Idempotent by Stripe event id.</div></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Current access</CardTitle></CardHeader><CardContent className="text-sm"><div className="text-xl font-semibold">{data?.active ? "Granted" : "Locked"}</div><div className="text-muted-foreground">Only webhook updates can change this.</div></CardContent></Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Webhook Audit Log</CardTitle>
                  <CardDescription>Raw event history for admin troubleshooting and auditability.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {data?.recentWebhookEvents.length ? data.recentWebhookEvents.map((event) => (
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
                  <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> Admin diagnostics</CardTitle>
                  <CardDescription>Test mode keys only, no live-mode switchovers.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>Stripe secret configured: {data?.stripe.secretKeyConfigured ? "Yes" : "No"}</p>
                  <p>Webhook secret configured: {data?.stripe.webhookSecretConfigured ? "Yes" : "No"}</p>
                  <p>Account key: {data?.account?.accountKey ?? "workspace"}</p>
                  <p>Plan key: {data?.account?.planKey ?? data?.stripe.planKey}</p>
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}