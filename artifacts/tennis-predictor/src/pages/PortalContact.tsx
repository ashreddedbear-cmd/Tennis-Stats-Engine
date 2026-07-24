import { FormEvent, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { AlertCircle, CheckCircle2 } from "lucide-react"

export default function PortalContactPage() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [message, setMessage] = useState("")
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [error, setError] = useState("")

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setState("loading")
    setError("")
    try {
      const res = await fetch("/api/public/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, message }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? "Unable to send message")
      }
      setState("success")
      setName("")
      setEmail("")
      setMessage("")
    } catch (err) {
      setState("error")
      setError(err instanceof Error ? err.message : "Submission failed")
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 animate-in fade-in duration-500">
      <section className="space-y-2">
        <p className="text-xs font-mono font-bold tracking-[0.2em] uppercase text-muted-foreground">Contact</p>
        <h1 className="text-3xl sm:text-5xl font-display font-bold">Contact and support</h1>
        <p className="text-sm sm:text-base text-muted-foreground">Need help with account, billing, or product usage? Send a message and our team will follow up.</p>
      </section>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle>Send a message</CardTitle>
          <CardDescription>Rate limited and validated for abuse protection.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="contact-name" className="text-xs font-mono font-bold tracking-widest uppercase text-muted-foreground">Name</label>
              <Input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="contact-email" className="text-xs font-mono font-bold tracking-widest uppercase text-muted-foreground">Email</label>
              <Input id="contact-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="contact-message" className="text-xs font-mono font-bold tracking-widest uppercase text-muted-foreground">Message</label>
              <Textarea id="contact-message" value={message} onChange={(e) => setMessage(e.target.value)} required minLength={10} maxLength={2000} className="min-h-32" />
            </div>
            {state === "error" && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive flex items-center gap-2">
                <AlertCircle className="h-4 w-4" /> {error}
              </div>
            )}
            {state === "success" && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" /> Message received. We will follow up by email.
              </div>
            )}
            <Button type="submit" disabled={state === "loading"} className="w-full sm:w-auto">
              {state === "loading" ? "Sending..." : "Send"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
