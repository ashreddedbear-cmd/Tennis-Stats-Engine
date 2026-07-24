import { Link } from "wouter"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export default function PortalLoginPage() {
  const loginUrl = import.meta.env.VITE_CLERK_SIGN_IN_URL as string | undefined

  return (
    <div className="mx-auto max-w-xl space-y-6 animate-in fade-in duration-500">
      <section className="space-y-2 text-center">
        <p className="text-xs font-mono font-bold tracking-[0.2em] uppercase text-muted-foreground">Account</p>
        <h1 className="text-3xl sm:text-4xl font-display font-bold">Log in</h1>
      </section>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle>Access your account</CardTitle>
          <CardDescription>Authentication integration is managed by Replit and Clerk.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loginUrl ? (
            <a href={loginUrl} className="block"><Button className="w-full">Continue to Log In</Button></a>
          ) : (
            <div className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
              Log in URL is not configured yet. Set VITE_CLERK_SIGN_IN_URL to connect this page.
            </div>
          )}
          <p className="text-xs text-muted-foreground text-center">
            New here? <Link href="/signup" className="text-primary hover:underline">Create an account</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
