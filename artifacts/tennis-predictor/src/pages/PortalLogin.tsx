import { Link } from "wouter"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, ShieldCheck } from "lucide-react"

export default function PortalLoginPage() {
  const loginUrl = import.meta.env.VITE_CLERK_SIGN_IN_URL as string | undefined

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back()
      return
    }
    window.location.assign("/")
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 animate-in fade-in duration-500">
      <section className="space-y-2 text-center">
        <p className="text-xs font-mono font-bold tracking-[0.2em] uppercase text-muted-foreground">Account</p>
        <h1 className="text-3xl sm:text-4xl font-display font-bold">Log in</h1>
      </section>

      <Card className="glass-panel relative">
        <Link
          href="/admin/login"
          className="absolute right-4 top-4 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[0.7rem] font-mono font-bold uppercase tracking-widest transition-all border bg-primary/10 text-primary border-primary/20 hover:bg-primary/20 hover:text-primary hover:border-primary/40"
          title="Owner admin login"
        >
          <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
          <span>Admin</span>
        </Link>
        <CardHeader className="pr-28">
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
          <Button type="button" variant="outline" className="w-full" onClick={handleBack}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            New here? <Link href="/signup" className="text-primary hover:underline">Create an account</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
