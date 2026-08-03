import { Link } from "wouter"
import { ArrowRight, BarChart3, ShieldCheck, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function PortalHomePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-8 sm:space-y-10 animate-in fade-in duration-500">
      <section className="relative overflow-hidden rounded-3xl border border-primary/20 bg-[linear-gradient(145deg,#060A07_0%,#0C1A10_60%,#102214_100%)] p-6 sm:p-10 text-foreground">
        <div className="absolute -top-28 -right-24 h-72 w-72 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative z-10 max-w-3xl space-y-5">
          <p className="text-xs sm:text-sm font-mono font-bold tracking-[0.22em] uppercase text-emerald-100">Tennis Matrix AI</p>
          <h1 className="text-3xl sm:text-5xl font-display font-bold leading-tight">Predict with data. Decide with discipline.</h1>
          <p className="text-sm sm:text-lg text-emerald-50/90 max-w-2xl">
            Tennis Matrix AI provides informational tennis analysis, model probabilities, and decision support across ATP and WTA fixtures.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link href="/signup"><Button className="gap-2">Get Started <ArrowRight className="h-4 w-4" /></Button></Link>
            <Link href="/pricing"><Button variant="outline" className="gap-2 border-border/50 bg-background/20">View Pricing</Button></Link>
            <Link href="/predict"><Button variant="secondary" className="gap-2">Open Main App</Button></Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Card className="glass-panel">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="h-4 w-4" /> Data-Driven Engine</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">Surface Elo, form, fatigue, matchup context, and consistency checks power each probability output.</CardContent>
        </Card>
        <Card className="glass-panel">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" /> Transparent Risk</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">Predictions are informational, not guaranteed. Always review legal and responsible-use guidance before acting.</CardContent>
        </Card>
        <Card className="glass-panel">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" /> Upgrade Paths</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">Start free, trial Elite once for 24 hours, then select the plan that matches your analysis depth and workflow.</CardContent>
        </Card>
      </section>
    </div>
  )
}