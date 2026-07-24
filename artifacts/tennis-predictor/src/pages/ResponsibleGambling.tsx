import { Link } from "wouter"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, HeartPulse } from "lucide-react"

export default function ResponsibleGamblingPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8 animate-in fade-in duration-500">
      <section className="rounded-2xl border border-warning/30 bg-warning/5 p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="p-2 rounded-lg bg-warning/10 border border-warning/30">
            <AlertTriangle className="w-5 h-5 text-warning" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold tracking-tight">Responsible Gambling / Disclaimer</h1>
          <Badge variant="outline" className="font-mono text-[10px] tracking-widest border-warning/40 text-warning">
            READ BEFORE USE
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Betting carries financial risk. Use this platform responsibly and never wager more than
          you can afford to lose.
        </p>
      </section>

      <Card className="glass-panel border-border">
        <CardHeader>
          <CardTitle className="text-lg">Core Disclaimer</CardTitle>
          <CardDescription>Predictions are informational, not guaranteed outcomes.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>
            TENNIS MATRIX AI provides probabilistic analysis based on historical and contextual
            inputs. Results can be wrong, including high-confidence outputs.
          </p>
          <p>
            Nothing on this platform is financial or betting advice. Any wagering decision is your
            sole responsibility.
          </p>
          <p>
            Past performance, historical model edge, and backtest results do not guarantee future
            performance.
          </p>
        </CardContent>
      </Card>

      <Card className="glass-panel border-border">
        <CardHeader>
          <CardTitle className="text-lg">Responsible Use Guidelines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>Set strict deposit and loss limits before placing any wager.</p>
          <p>Do not chase losses or increase stake size impulsively after losing outcomes.</p>
          <p>Take regular breaks and avoid wagering under stress, fatigue, or emotional pressure.</p>
          <p>If betting stops being fun or feels compulsive, stop immediately and seek support.</p>
        </CardContent>
      </Card>

      <Card className="glass-panel border-border">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <HeartPulse className="w-4 h-4 text-primary" />
            Support Resources
          </CardTitle>
          <CardDescription>
            If you think gambling is becoming harmful, contact a licensed support service in your
            country or region.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>
            You should use official local organizations, national helplines, or licensed clinical
            services for confidential assistance.
          </p>
          <p>
            If immediate safety is a concern, contact local emergency services in your jurisdiction.
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        See <Link href="/terms" className="text-primary hover:underline">Terms of Service</Link> and <Link href="/privacy" className="text-primary hover:underline">Privacy Policy</Link> for additional legal information.
      </p>
    </div>
  )
}