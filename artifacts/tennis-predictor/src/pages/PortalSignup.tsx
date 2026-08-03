import { Link } from "wouter"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export default function PortalSignupPage() {
  const signupUrl = import.meta.env.VITE_CLERK_SIGN_UP_URL as string | undefined

  const continueSignup = async () => {
    try {
      await fetch("/api/public/legal-consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ context: "signup", agreedTerms: true, agreedPrivacy: true }),
      })
    } catch {
      // Non-blocking by design: consent tracking should not prevent sign-up navigation.
    }
    if (signupUrl) window.location.assign(signupUrl)
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 animate-in fade-in duration-500">
      <section className="space-y-2 text-center">
        <p className="text-xs font-mono font-bold tracking-[0.2em] uppercase text-muted-foreground">Get Started</p>
        <h1 className="text-3xl sm:text-4xl font-display font-bold">Create your account</h1>
      </section>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle>Start with Free or trial Elite</CardTitle>
          <CardDescription>One 24-hour Elite trial per user. You can manage billing from your account dashboard.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {signupUrl ? (
            <Button className="w-full" onClick={() => void continueSignup}>Continue to Sign Up</Button>
          ) : (
            <div className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
              Sign-up URL is not configured yet. Set VITE_CLERK_SIGN_UP_URL to connect this page.
            </div>
          )}
          <p className="text-xs text-muted-foreground text-center">
            By creating an account, you agree to the <Link href="/terms" className="text-primary hover:underline">Terms of Service</Link> and <Link href="/privacy" className="text-primary hover:underline">Privacy Policy</Link>.
          </p>
          <p className="text-xs text-muted-foreground text-center">
            Already have an account? <Link href="/login" className="text-primary hover:underline">Log in</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
