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
