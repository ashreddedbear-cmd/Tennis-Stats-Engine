import { Link } from "wouter"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ShieldCheck } from "lucide-react"

export default function PrivacyPolicyPage() {
  const effectiveDate = "2026-07-24"

  return (
    <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8 animate-in fade-in duration-500">
      <section className="rounded-2xl border border-border/60 bg-card/70 backdrop-blur p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
            <ShieldCheck className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold tracking-tight">Privacy Policy</h1>
          <Badge variant="outline" className="font-mono text-[10px] tracking-widest border-primary/40 text-primary">
            EFFECTIVE {effectiveDate}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          This policy explains what data we process, why we process it, and how we safeguard it.
        </p>
      </section>

      <Card className="glass-panel border-border">
        <CardHeader>
          <CardTitle className="text-lg">Data We Process</CardTitle>
          <CardDescription>Operational data is used to deliver predictions and core features.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>We may process the following data categories:</p>
          <p>• Name, email, and account profile information.</p>
          <p>• Authentication/session information and security logs.</p>
          <p>• Subscription, trial status, and billing status metadata.</p>
          <p>• Stripe customer and subscription identifiers.</p>
          <p>• Prediction usage, prediction history, and interaction events.</p>
          <p>• Notification preferences and support messages.</p>
          <p>• Device/browser information, IP address, and cookie-related data.</p>
          <p>• Legal acceptance records for terms and privacy acknowledgments.</p>
        </CardContent>
      </Card>

      <Card className="glass-panel border-border">
        <CardHeader>
          <CardTitle className="text-lg">How Data Is Used</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>Data is used to operate, monitor, and improve model and application performance.</p>
          <p>
            We do not sell personal data. Data handling is limited to product operation,
            troubleshooting, security, and lawful compliance obligations.
          </p>
          <p>
            We may use data for abuse prevention, duplicate-account protection, fraud checks,
            account recovery, and service auditability.
          </p>
        </CardContent>
      </Card>

      <Card className="glass-panel border-border">
        <CardHeader>
          <CardTitle className="text-lg">Retention and Security</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>
            We retain data only as long as necessary for legitimate operational and compliance
            purposes.
          </p>
          <p>
            Reasonable technical and organizational safeguards are used to protect stored and
            transmitted data.
          </p>
          <p>
            No internet service can be guaranteed 100% secure, but we continuously improve
            protective controls and monitoring.
          </p>
          <p>
            Payment-card details are processed by Stripe. Tennis Matrix AI does not store full
            payment-card numbers, CVC values, or full card track data directly.
          </p>
        </CardContent>
      </Card>

      <Card className="glass-panel border-border">
        <CardHeader>
          <CardTitle className="text-lg">Policy Updates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>
            We may update this policy periodically. Material updates are reflected by a revised
            effective date on this page.
          </p>
          <p>
            Continued use of the service after updates are posted indicates acceptance of the
            revised policy.
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Review our <Link href="/terms" className="text-primary hover:underline">Terms of Service</Link>, <Link href="/cookies" className="text-primary hover:underline">Cookie Policy</Link>, and <Link href="/responsible-gambling" className="text-primary hover:underline">Responsible Gambling / Disclaimer</Link>.
      </p>
    </div>
  )
}