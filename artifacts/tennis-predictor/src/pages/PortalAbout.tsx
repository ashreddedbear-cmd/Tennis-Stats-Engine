import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function PortalAboutPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 animate-in fade-in duration-500">
      <section className="space-y-3">
        <p className="text-xs font-mono font-bold tracking-[0.2em] uppercase text-muted-foreground">About</p>
        <h1 className="text-3xl sm:text-5xl font-display font-bold">About Tennis Matrix AI</h1>
        <p className="max-w-3xl text-sm sm:text-base text-muted-foreground">
          Tennis Matrix AI is an informational analytics platform focused on transparent model probabilities for tennis matchups.
        </p>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="glass-panel">
          <CardHeader><CardTitle className="text-lg">What We Provide</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>Probability-based predictions and analysis across ATP and WTA fixtures.</p>
            <p>Historical testing tools including backtesting, shadow replay, and walk-forward evaluation.</p>
            <p>Decision-support context such as confidence, disagreement, and calibration views.</p>
          </CardContent>
        </Card>
        <Card className="glass-panel">
          <CardHeader><CardTitle className="text-lg">What We Do Not Do</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>We are not a sportsbook and do not place bets for users.</p>
            <p>We do not guarantee outcomes, profits, or performance.</p>
            <p>Users are fully responsible for their own decisions and risk management.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
