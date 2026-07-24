import { Link } from "wouter"
import { BadgeCheck, Crown, Rocket, Users } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

const plans = [
  {
    name: "Free",
    price: "$0",
    subtitle: "7 predictions per day",
    icon: BadgeCheck,
    features: ["Predicted winner", "Win probability", "Predicted set score", "Basic confidence", "No badges"],
  },
  {
    name: "Pro",
    price: "$19.99 monthly or $199 annually",
    subtitle: "Unlimited model workflow",
    icon: Rocket,
    features: [
      "Unlimited predictions",
      "Prediction history",
      "Tournament filters",
      "Data Quality, Upset Risk, Model Agreement",
      "Full Model Analysis",
      "Ad-free",
    ],
  },
  {
    name: "Elite",
    price: "$49.99 monthly or $499 annually",
    subtitle: "Everything in Pro + deep analytics",
    icon: Crown,
    features: [
      "Elite badges and strong recommendations",
      "AI insights + 20,000 Monte Carlo simulations",
      "Confidence trends and calibration",
      "Accuracy by surface + accuracy dashboard",
      "Shadow Replay, Walk-Forward testing, Backtesting",
      "Live tracking, developer analytics, smart alerts",
      "Priority support",
    ],
  },
  {
    name: "Team",
    price: "$249 monthly",
    subtitle: "5 total seats",
    icon: Users,
    features: ["Shared workspace", "Shared history", "Shared analytics", "Invitations", "Permissions", "Data export"],
  },
]

export default function PortalPricingPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-8 animate-in fade-in duration-500">
      <section className="space-y-3 text-center">
        <p className="text-xs font-mono font-bold tracking-[0.2em] uppercase text-muted-foreground">Pricing</p>
        <h1 className="text-3xl sm:text-5xl font-display font-bold">Choose your Tennis Matrix AI plan</h1>
        <p className="mx-auto max-w-3xl text-sm sm:text-base text-muted-foreground">
          One 24-hour Elite trial per user. Trial expiration, failed payments, and billing downgrades follow policy and automatically move users to Free when required.
        </p>
      </section>

      <section className="grid gap-4 xl:grid-cols-4 md:grid-cols-2">
        {plans.map((plan) => {
          const Icon = plan.icon
          const isElite = plan.name === "Elite"
          return (
            <Card key={plan.name} className={`glass-panel ${isElite ? "border-primary/40" : ""}`}>
              <CardHeader className="space-y-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-lg"><Icon className="h-4 w-4" />{plan.name}</CardTitle>
                  {isElite && <Badge variant="success">Popular</Badge>}
                </div>
                <CardDescription>{plan.subtitle}</CardDescription>
                <div className="text-base font-semibold">{plan.price}</div>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1.5 text-sm text-muted-foreground">
                  {plan.features.map((f) => <li key={f}>• {f}</li>)}
                </ul>
                <div className="pt-2">
                  <Link href="/signup"><Button className="w-full">Select {plan.name}</Button></Link>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </section>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="text-lg">Billing behavior</CardTitle>
          <CardDescription>Checkout and billing are managed by Stripe with Replit-managed configuration.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1.5">
          <p>• Upgrades take effect immediately.</p>
          <p>• Downgrades and cancellations take effect at the end of the billing period.</p>
          <p>• Failed payments and trial expiration immediately downgrade to Free.</p>
          <p>• User history is retained after downgrade.</p>
          <p className="pt-2">By starting checkout, you agree to the <Link href="/terms" className="text-primary hover:underline">Terms of Service</Link> and acknowledge the <Link href="/privacy" className="text-primary hover:underline">Privacy Policy</Link>.</p>
        </CardContent>
      </Card>
    </div>
  )
}