import { FormEvent, useEffect, useMemo, useState } from "react"
import { Link } from "wouter"
import { useCreateBillingPortalSession, useGetPaymentsStatus } from "@workspace/api-client-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"

type RequestKind = "delete-account" | "data-export"

function formatDate(value: string | null | undefined) {
  if (!value) return "Not available"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString()
}

export default function PortalAccountPage() {
  const { data, isLoading, isError } = useGetPaymentsStatus({})
  const billingPortal = useCreateBillingPortalSession()

  const [alerts, setAlerts] = useState({
    favoritePlayer: true,
    confidenceChange: true,
    matchStart: false,
    elitePrediction: true,
  })
  const [requestState, setRequestState] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [requestError, setRequestError] = useState("")
  const [billingError, setBillingError] = useState("")

  useEffect(() => {
    const raw = localStorage.getItem("portal2.notifications.v1")
    if (!raw) return
    try {
      setAlerts(JSON.parse(raw))
    } catch {
      localStorage.removeItem("portal2.notifications.v1")
    }
  }, [])

  const statusLabel = useMemo(() => {
    if (!data?.account?.subscriptionStatus) return "free"
    return data.account.subscriptionStatus
  }, [data])

  const saveNotifications = () => {
    localStorage.setItem("portal2.notifications.v1", JSON.stringify(alerts))
  }

  const openBillingPortal = async () => {
    setBillingError("")
    try {
      const session = await billingPortal.mutateAsync({ data: { returnPath: "/account" } })
      window.location.assign(session.url)
    } catch (err) {
      setBillingError(err instanceof Error ? err.message : "Unable to open billing portal")
    }
  }

  const submitRequest = async (kind: RequestKind, event: FormEvent) => {
    event.preventDefault()
    setRequestState("loading")
    setRequestError("")
    try {
      const res = await fetch("/api/public/account-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestType: kind }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? "Request failed")
      }
      setRequestState("success")
    } catch (err) {
      setRequestState("error")
      setRequestError(err instanceof Error ? err.message : "Request failed")
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 animate-in fade-in duration-500">
      <section className="space-y-2">
        <p className="text-xs font-mono font-bold tracking-[0.2em] uppercase text-muted-foreground">Account & Billing</p>
        <h1 className="text-3xl sm:text-5xl font-display font-bold">Dashboard</h1>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="glass-panel">
          <CardHeader><CardTitle className="text-base">Current plan</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            <p className="text-xl font-semibold text-foreground">{data?.stripe.planName ?? "Free"}</p>
            <p>Status: {statusLabel}</p>
          </CardContent>
        </Card>
        <Card className="glass-panel">
          <CardHeader><CardTitle className="text-base">Trial status</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            <p>Trial ends: {formatDate(data?.account?.trialEndAt)}</p>
            <p>Downgrade target: Free</p>
          </CardContent>
        </Card>
        <Card className="glass-panel">
          <CardHeader><CardTitle className="text-base">App access</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Link href="/predict"><Button className="w-full">Return to Main App</Button></Link>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="glass-panel">
          <CardHeader>
            <CardTitle className="text-lg">Plan actions</CardTitle>
            <CardDescription>Upgrades, downgrades, cancelation, invoices, and billing portal access.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <Link href="/pricing"><Button className="w-full">Upgrade</Button></Link>
              <Link href="/pricing"><Button variant="outline" className="w-full">Downgrade</Button></Link>
              <Button variant="outline" className="w-full" onClick={() => void openBillingPortal()} disabled={billingPortal.isPending}>Cancel Plan</Button>
              <Button variant="outline" className="w-full" onClick={() => void openBillingPortal()} disabled={billingPortal.isPending}>Open Billing Portal</Button>
              <Button variant="outline" className="w-full" onClick={() => void openBillingPortal()} disabled={billingPortal.isPending}>View Invoices</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Billing actions are enforced server-side. If your session is not authenticated yet, log in first.
            </p>
            {billingError && <p className="text-xs text-destructive">{billingError}</p>}
          </CardContent>
        </Card>

        <Card className="glass-panel">
          <CardHeader>
            <CardTitle className="text-lg">Notifications</CardTitle>
            <CardDescription>Manage smart alerts and preferred account notifications.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <label className="flex items-center gap-2"><Checkbox checked={alerts.favoritePlayer} onCheckedChange={(v) => setAlerts((p) => ({ ...p, favoritePlayer: Boolean(v) }))} /> Favorite player alerts</label>
            <label className="flex items-center gap-2"><Checkbox checked={alerts.confidenceChange} onCheckedChange={(v) => setAlerts((p) => ({ ...p, confidenceChange: Boolean(v) }))} /> Confidence-change alerts</label>
            <label className="flex items-center gap-2"><Checkbox checked={alerts.matchStart} onCheckedChange={(v) => setAlerts((p) => ({ ...p, matchStart: Boolean(v) }))} /> Match-start alerts</label>
            <label className="flex items-center gap-2"><Checkbox checked={alerts.elitePrediction} onCheckedChange={(v) => setAlerts((p) => ({ ...p, elitePrediction: Boolean(v) }))} /> Elite prediction alerts</label>
            <Button onClick={saveNotifications}>Save notifications</Button>
          </CardContent>
        </Card>
      </div>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="text-lg">Data and account requests</CardTitle>
          <CardDescription>Request account deletion or data export through support workflow.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <form onSubmit={(e) => void submitRequest("data-export", e)}><Button type="submit" variant="outline" disabled={requestState === "loading"}>Request data export</Button></form>
            <form onSubmit={(e) => void submitRequest("delete-account", e)}><Button type="submit" variant="destructive" disabled={requestState === "loading"}>Request account deletion</Button></form>
          </div>
          {requestState === "error" && <p className="text-sm text-destructive">{requestError}</p>}
          {requestState === "success" && <p className="text-sm text-primary">Request submitted.</p>}
          <p className="text-xs text-muted-foreground">
            Account settings also link to <Link href="/privacy" className="text-primary hover:underline">Privacy Policy</Link>, <Link href="/terms" className="text-primary hover:underline">Terms of Service</Link>, and <Link href="/cookies" className="text-primary hover:underline">Cookie Policy</Link>.
          </p>
        </CardContent>
      </Card>

      {isLoading && <p className="text-sm text-muted-foreground">Loading account state...</p>}
      {isError && <p className="text-sm text-muted-foreground">Unable to load account state. You can still access plan and legal pages.</p>}
    </div>
  )
}
