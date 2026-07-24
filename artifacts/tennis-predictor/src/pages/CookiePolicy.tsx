import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function CookiePolicyPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 animate-in fade-in duration-500">
      <section className="space-y-2">
        <p className="text-xs font-mono font-bold tracking-[0.2em] uppercase text-muted-foreground">Legal</p>
        <h1 className="text-3xl sm:text-5xl font-display font-bold">Cookie Policy</h1>
      </section>

      <Card className="glass-panel">
        <CardHeader><CardTitle className="text-lg">How cookies are used</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>We use essential cookies for authentication flow continuity, session integrity, and security controls.</p>
          <p>We may use preference cookies to remember interface settings such as theme and notification options.</p>
          <p>We may use analytics or diagnostic storage for reliability and abuse detection.</p>
          <p>You can control browser cookie settings, but disabling required cookies may affect account and billing functionality.</p>
        </CardContent>
      </Card>
    </div>
  )
}
