import { useEffect, useMemo, useState } from "react"
import { Link, useLocation } from "wouter"
import { useTheme } from "next-themes"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/hooks/use-toast"
import { ProviderStatusIndicator } from "./ProviderStatusIndicator"
import { TennisMatrixLogo } from "./TennisMatrixLogo"
import { useGetAdminAuthStatus } from "@/hooks/useGetAdminAuthStatus"
import { MatrixRain } from "./MatrixRain"
import { History, PlaySquare, ClipboardList, LineChart, Menu, X, LayoutDashboard, Moon, Sun, FlaskConical, Zap, Ghost, ShieldCheck } from "lucide-react"

const NAV_LINKS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/predict", label: "Run Model", icon: PlaySquare, exact: false },
  { href: "/history", label: "History", icon: History, exact: false },
  { href: "/evaluation/log", label: "Prediction Log", icon: ClipboardList, exact: false },
  { href: "/evaluation/dashboard", label: "Accuracy", icon: LineChart, exact: false },
  { href: "/backtesting", label: "Backtesting", icon: FlaskConical, exact: false },
  { href: "/shadow-replay", label: "Paper Trading", icon: Ghost, exact: false },
  { href: "/launch-audit", label: "Launch Audit", icon: ShieldCheck, exact: false },
]

const MOBILE_PRIMARY_TABS = [
  { href: "/", label: "Home", icon: LayoutDashboard, exact: true },
  { href: "/predict", label: "Run Model", icon: PlaySquare, exact: false },
  { href: "/history", label: "History", icon: History, exact: false },
] as const

const MOBILE_MORE_LINKS = [
  { href: "/evaluation/log", label: "Log", icon: ClipboardList, exact: false },
  { href: "/evaluation/dashboard", label: "Accuracy", icon: LineChart, exact: false },
  { href: "/backtesting", label: "Backtest", icon: FlaskConical, exact: false },
  { href: "/shadow-replay", label: "Paper Trading", icon: Ghost, exact: false },
  { href: "/launch-audit", label: "Launch Audit", icon: ShieldCheck, exact: false },
  { href: "/terms", label: "Terms", icon: ShieldCheck, exact: false },
  { href: "/privacy", label: "Privacy", icon: ShieldCheck, exact: false },
  { href: "/responsible-gambling", label: "Disclaimer", icon: ShieldCheck, exact: false },
] as const

function isActive(href: string, location: string, exact: boolean) {
  if (exact) return location === href
  if (href === "/history") return location.startsWith("/history") || location.startsWith("/predictions")
  if (href === "/predict") return location.startsWith("/predict") && !location.startsWith("/predictions")
  if (href === "/backtesting") return location.startsWith("/backtesting")
  if (href === "/shadow-replay") return location.startsWith("/shadow-replay")
  return location.startsWith(href)
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const activeTheme = resolvedTheme === "dark" || resolvedTheme === "light"
    ? resolvedTheme
    : "dark"

  const options: Array<{ value: "light" | "dark"; label: string; icon: React.ReactNode }> = [
    { value: "light", label: "Light", icon: <Sun className="w-3.5 h-3.5" /> },
    { value: "dark", label: "Dark", icon: <Moon className="w-3.5 h-3.5" /> },
  ]

  const cycleTheme = () => {
    if (activeTheme === "light") {
      setTheme("dark")
      return
    }
    setTheme("light")
  }

  return (
    <>
      <button
        className="sm:hidden p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
        onClick={cycleTheme}
        aria-label="Cycle theme"
      >
        {activeTheme === "light" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>
      <div
        className="hidden sm:inline-flex items-center rounded-lg border border-border/60 bg-secondary/50 p-0.5"
        role="group"
        aria-label="Theme selector"
      >
        {options.map((option) => {
          const active = activeTheme === option.value
          return (
            <button
              key={option.value}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-mono font-bold tracking-widest transition-colors ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
              onClick={() => setTheme(option.value)}
              aria-label={`Switch to ${option.label} mode`}
              aria-pressed={active}
            >
              {option.icon}
              <span>{option.label}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

function MatrixWordmark() {
  const target = "TENNIS Matrix AI"
  const [text, setText] = useState(target)

  const key = "matrix-wordmark-decoded.v1"

  useEffect(() => {
    const hasDecoded = sessionStorage.getItem(key) === "1"
    if (hasDecoded || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setText(target)
      return
    }

    const glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    const revealOrder = [...target].map((_, i) => i).filter((i) => target[i] !== " ")
    let frame = 0
    const totalFrames = 20
    const timer = window.setInterval(() => {
      frame += 1
      const progress = Math.min(1, frame / totalFrames)
      const revealCount = Math.floor(revealOrder.length * progress)
      const revealed = new Set(revealOrder.slice(0, revealCount))
      const next = [...target]
        .map((ch, i) => {
          if (ch === " ") return " "
          if (revealed.has(i)) return target[i]
          return glyphs[Math.floor(Math.random() * glyphs.length)]
        })
        .join("")
      setText(next)

      if (frame >= totalFrames) {
        window.clearInterval(timer)
        setText(target)
        sessionStorage.setItem(key, "1")
      }
    }, 70)

    return () => window.clearInterval(timer)
  }, [])

  return (
    <span className="matrix-wordmark font-mono font-extrabold tracking-tight">
      {text}
    </span>
  )
}

function AdminAuthButton() {
  const { data: adminAuth } = useGetAdminAuthStatus()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  
  const logoutMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/auth/logout", { method: "POST", credentials: "include" })
      if (!res.ok) throw new Error("Logout failed")
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adminAuthStatus"] })
      toast({ title: "Logged out", description: "Owner session cleared" })
    },
    onError: (error) => {
      toast({ title: "Error", description: (error as Error).message, variant: "destructive" })
    },
  })

  if (!adminAuth?.authenticated) {
    return (
      <Link
        href="/admin/login"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[0.7rem] font-mono font-bold uppercase tracking-widest transition-all border bg-primary/10 text-primary border-primary/20 hover:bg-primary/20 hover:text-primary hover:border-primary/40"
        title="Owner login"
      >
        <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
        <span className="hidden sm:inline">Login</span>
      </Link>
    )
  }

  return (
    <button
      onClick={() => logoutMutation.mutate()}
      disabled={logoutMutation.isPending}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[0.7rem] font-mono font-bold uppercase tracking-widest transition-all border bg-accent/10 text-accent border-accent/20 hover:bg-accent/20 hover:text-accent hover:border-accent/40 disabled:opacity-50"
      title="Owner logout"
    >
      <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
      <span className="hidden sm:inline">{logoutMutation.isPending ? "..." : "Logout"}</span>
    </button>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)

  useEffect(() => {
    setMobileOpen(false)
    setMobileMoreOpen(false)
  }, [location])

  const isForceSignalActive = location.startsWith("/force-signal")
  const dateTag = useMemo(() => {
    const now = new Date()
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, "0")
    const dd = String(now.getDate()).padStart(2, "0")
    return `${yyyy}-${mm}-${dd}`
  }, [])

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground font-sans overflow-x-hidden selection:bg-primary/20 selection:text-primary">
      <div className="fixed inset-0 pointer-events-none z-[-2] bg-[linear-gradient(180deg,_hsl(var(--background))_0%,_hsl(var(--background))_100%)]" />
      <div className="fixed inset-0 pointer-events-none z-[-1] bg-[radial-gradient(ellipse_70%_45%_at_top,_hsl(var(--primary)/0.08),_transparent_55%)]" />
      <div className={`fixed top-0 left-0 right-0 pointer-events-none z-[-1] overflow-hidden ${location === "/" ? "h-[28rem]" : "h-[7.5rem]"}`}>
        <MatrixRain />
      </div>

      {/* ─── Top header ─────────────────────────────────────── */}
      <header className="sticky top-0 z-50 w-full border-b border-border/70 bg-background/90 backdrop-blur-xl supports-[backdrop-filter]:bg-background/75 shadow-sm shadow-black/30">
        <div className="app-container min-h-[3.75rem] py-2.5 flex items-center justify-between gap-2">

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 font-display font-bold tracking-tight text-[1.05rem] hover:opacity-80 transition-opacity shrink-0">
            <div className="w-8 h-8 text-accent">
              <TennisMatrixLogo />
            </div>
            <span className="uppercase tracking-[0.16em] text-emerald-300">TENNIS MATRIX AI</span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-6 text-[0.8125rem] font-medium">
            {NAV_LINKS.map(({ href, label, icon: Icon, exact }) => {
              const active = isActive(href, location, exact)
              return (
                <Link
                  key={href}
                  href={href}
                  className={`relative py-1 flex items-center gap-1.5 transition-all hover:text-primary ${active ? "text-primary" : "text-muted-foreground"}`}
                >
                  {label}
                  {active && <span className="absolute -bottom-[0.65rem] left-0 w-full h-[2px] bg-primary rounded-t-full shadow-[0_0_10px_hsl(var(--primary)/0.8)]" />}
                </Link>
              )
            })}
          </nav>

          {/* Right side controls: FORCE SIGNAL → ONLINE SIGNAL → [gap] → ADMIN → THEME */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Force Signal — visually distinct (warning/amber) from Online Signal (primary) */}
            <Link
              href="/force-signal"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[0.7rem] font-mono font-bold uppercase tracking-widest transition-all border ${
                isForceSignalActive
                  ? "bg-warning/20 text-warning border-warning/40"
                  : "bg-warning/10 text-warning/80 border-warning/20 hover:bg-warning/20 hover:text-warning hover:border-warning/40"
              }`}
              title="Force Signal — show a directional pick even on close matches"
            >
              <Zap className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">FORCE</span>
              <span className="sm:hidden">FS</span>
            </Link>

            {/* Online Signal (existing) */}
            <ProviderStatusIndicator />

            <span className="hidden xl:inline-flex items-center rounded-md border border-border/60 bg-secondary/50 px-2 py-1 text-[10px] font-mono font-bold tracking-widest text-muted-foreground">
              {dateTag}
            </span>

            {/* Visual gap to keep theme toggle separate */}
            <div className="w-px h-5 bg-border/50 mx-1 hidden sm:block" />

            {/* Admin Login/Logout */}
            <AdminAuthButton />

            {/* Theme toggle */}
            <ThemeToggle />

            {/* Mobile menu toggle */}
            <button
              className="md:hidden p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
              onClick={() => setMobileOpen((o) => !o)}
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Mobile slide-down nav */}
        {mobileOpen && (
          <div className="md:hidden border-t border-border/50 bg-background/95 backdrop-blur-xl">
            <nav className="app-container py-3 flex flex-col gap-1">
              {/* Force Signal link in mobile nav */}
              <Link
                href="/force-signal"
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${isForceSignalActive ? "bg-warning/10 text-warning font-semibold" : "text-warning/70 hover:bg-warning/10 hover:text-warning"}`}
              >
                <Zap className="w-4 h-4 shrink-0" />
                Force Signal
              </Link>
              {NAV_LINKS.map(({ href, label, icon: Icon, exact }) => {
                const active = isActive(href, location, exact)
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${active ? "bg-primary/12 text-primary font-semibold" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {label}
                  </Link>
                )
              })}
              {/* Admin login in mobile nav */}
              <div className="border-t border-border/50 mt-2 pt-2">
                <AdminAuthButton />
              </div>
            </nav>
          </div>
        )}
      </header>

      {/* ─── Page content ───────────────────────────────────── */}
      <main className="flex-1 app-container py-8 md:py-10 flex flex-col pb-24 md:pb-10">
        {children}
      </main>

      {/* ─── Mobile bottom tab bar ───────────────────────────── */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-border/50 bg-background/90 backdrop-blur-xl mobile-nav-safe">
        <nav className="flex items-stretch">
          {MOBILE_PRIMARY_TABS.map(({ href, label, icon: Icon, exact }) => {
            const active = isActive(href, location, exact)
            return (
              <Link
                key={href}
                href={href}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[0.6rem] font-mono font-bold tracking-wider uppercase transition-colors min-h-[3.25rem] ${active ? "text-primary" : "text-muted-foreground"}`}
              >
                <Icon className={`w-4.5 h-4.5 ${active ? "text-primary" : "text-muted-foreground/70"}`} style={{ width: "1.125rem", height: "1.125rem" }} />
                <span className="leading-tight">{label}</span>
                {active && <span className="absolute top-0 w-full max-w-[2.5rem] h-[2px] bg-primary rounded-b-full" />}
              </Link>
            )
          })}
          <button
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[0.6rem] font-mono font-bold tracking-wider uppercase transition-colors min-h-[3.25rem] ${mobileMoreOpen ? "text-primary" : "text-muted-foreground"}`}
            onClick={() => setMobileMoreOpen((open) => !open)}
            aria-label="Open more navigation"
          >
            <Menu className={`w-4.5 h-4.5 ${mobileMoreOpen ? "text-primary" : "text-muted-foreground/70"}`} style={{ width: "1.125rem", height: "1.125rem" }} />
            <span className="leading-tight">More</span>
          </button>
        </nav>
      </div>

      {mobileMoreOpen && (
        <div className="md:hidden fixed bottom-[4.25rem] left-3 right-3 z-50 rounded-2xl border border-border/70 bg-background shadow-xl p-2">
          {MOBILE_MORE_LINKS.map(({ href, label, icon: Icon, exact }) => {
            const active = isActive(href, location, exact)
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileMoreOpen(false)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            )
          })}
        </div>
      )}

      {/* ─── Footer ─────────────────────────────────────────── */}
      <footer className="hidden md:block border-t border-border/40 py-6 bg-secondary/20">
        <div className="app-container text-center text-[0.6875rem] font-mono text-muted-foreground/60 flex flex-col items-center gap-1.5">
          <p className="font-bold tracking-[0.18em] text-muted-foreground/80">TENNIS MATRIX AI v1.0.0</p>
          <p className="max-w-md leading-relaxed">PROBABILITIES CALIBRATED DAILY. USE AT OWN RISK. DATA IS FOR ANALYTICAL PURPOSES ONLY.</p>
          <div className="pt-1.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[0.65rem]">
            <Link href="/terms" className="hover:text-primary transition-colors">TERMS OF SERVICE</Link>
            <Link href="/privacy" className="hover:text-primary transition-colors">PRIVACY POLICY</Link>
            <Link href="/responsible-gambling" className="hover:text-primary transition-colors">RESPONSIBLE GAMBLING / DISCLAIMER</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
