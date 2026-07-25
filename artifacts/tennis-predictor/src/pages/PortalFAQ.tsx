import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const faqItems = [
  {
    q: "Are predictions guaranteed?",
    a: "No. Tennis Matrix AI provides informational model outputs only. Predictions and profits are never guaranteed.",
  },
  {
    q: "Does Tennis Matrix AI place bets for users?",
    a: "No. Tennis Matrix AI is not a sportsbook and never places bets on your behalf.",
  },
  {
    q: "What happens after the 24-hour Elite trial ends?",
    a: "Trial access automatically downgrades to Free when the trial expires. Your history is retained.",
  },
  {
    q: "How do upgrades and downgrades work?",
    a: "Upgrades take effect immediately. Downgrades and cancellations apply at the end of the current billing period.",
  },
  {
    q: "What if a payment fails?",
    a: "Failed payments downgrade access to Free immediately according to billing policy.",
  },
  {
    q: "What is the minimum age to use Tennis Matrix AI?",
    a: "You must be at least 18 years old to create and use an account.",
  },
  {
    q: "Are subscriptions refundable?",
    a: "No. Subscriptions are non-refundable. Standard cancellations do not receive refunds. Billing errors such as duplicate charges may be reviewed within 48 hours.",
  },
  {
    q: "Does Elite trial require a payment method?",
    a: "No. Elite trial starts automatically after sign-up and does not require a payment method.",
  },
  {
    q: "Can suspended users still cancel billing?",
    a: "Yes. Suspended users can still access billing cancellation to avoid being trapped in a paid subscription.",
  },
  {
    q: "Which law governs these terms?",
    a: "The service terms are governed by the laws of the State of Georgia.",
  },
  {
    q: "What analytics and tracking are used?",
    a: "Google Analytics is used. Meta Pixel, X tracking pixels, and session-replay trackers are not used.",
  },
  {
    q: "How do I contact support or privacy?",
    a: "Support requests currently go to TennisMatrixAi@hotmail.com. Privacy requests route to the same address until privacy@tennismatrixai.com is live.",
  },
]

export default function PortalFAQPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 animate-in fade-in duration-500">
      <section className="space-y-2">
        <p className="text-xs font-mono font-bold tracking-[0.2em] uppercase text-muted-foreground">FAQ</p>
        <h1 className="text-3xl sm:text-5xl font-display font-bold">Frequently Asked Questions</h1>
      </section>

      <Card className="glass-panel">
        <CardHeader><CardTitle className="text-lg">Common questions</CardTitle></CardHeader>
        <CardContent>
          <Accordion type="single" collapsible className="w-full">
            {faqItems.map((item) => (
              <AccordionItem key={item.q} value={item.q}>
                <AccordionTrigger>{item.q}</AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground">{item.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>
    </div>
  )
}
