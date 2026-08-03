import { useState } from "react"
import { useLocation } from "wouter"
import { useAuth } from "@clerk/react"
import { Badge } from "@/components/ui/badge"
import { FixturesList } from "@/components/FixturesList"
import { ActivitySquare, LogIn, PlaySquare, Swords } from "lucide-react"

export default function Home() {
  const [, setLocation] = useLocation()
  const { isSignedIn, isLoaded } = useAuth()
  const [_dummy] = useState(null) // keep hook count stable

  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <section className="bg-[linear-gradient(145deg,#060A07_0%,#0C1A10_60%,#102214_100%)] text-foreground rounded-3xl p-8 md:p-12 relative overflow-hidden shadow-xl border border-primary/20">
        <div className="absolute top-0 right-0 w-[800px] h-[800px] bg-primary/8 rounded-full blur-3xl -mr-64 -mt-64 pointer-events-none" />
        <div className="absolute bottom-0 right-10 opacity-[0.03] pointer-events-none mix-blend-overlay">
          <ActivitySquare className="w-[400px] h-[400px]" />
        </div>
        <div className="relative z-10 max-w-3xl space-y-6">
          <p className="text-2xl md:text-3xl font-mono font-bold tracking-[0.2em] uppercase text-emerald-300">TENNIS MATRIX AI</p>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-display font-bold tracking-tight leading-[1.05] break-words">
            <span className="text-emerald-50 drop-shadow-[0_2px_12px_rgba(16,185,129,0.2)]">PROBABILITY</span>
            <br />
            <span className="text-emerald-100">NOT</span>
            <br />
            <span className="text-emerald-50 drop-shadow-[0_2px_12px_rgba(16,185,129,0.2)]">SENTIMENT.</span>
          </h1>
          <p className="text-emerald-100/95 text-lg md:text-xl font-medium max-w-2xl leading-relaxed">
            Multi-model prediction engine based on real ATP/WTA data. Surface Elo, serve/return strength, fatigue, and head-to-head.
          </p>
          <div className="pt-6 flex flex-wrap items-center gap-4">
            <button
              onClick={() => setLocation("/predict")}
              className="bg-primary text-primary-foreground px-8 py-4 rounded-xl font-bold font-mono text-sm hover:bg-primary/90 shadow-lg shadow-primary/20 transition-all flex items-center gap-2 hover:-translate-y-1"
            >
              <PlaySquare className="w-4 h-4" />
              RUN MODEL
            </button>
            {/* Show sign-in nudge only once Clerk has resolved and user is not signed in */}
            {isLoaded && !isSignedIn && (
              <button
                onClick={() => setLocation("/sign-in")}
                className="flex items-center gap-2 text-sm font-mono text-emerald-300/80 hover:text-emerald-300 transition-colors underline-offset-4 hover:underline"
              >
                <LogIn className="w-3.5 h-3.5" />
                Sign in to save predictions
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-6">
        <div className="flex items-center justify-between border-b border-border/50 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Swords className="w-5 h-5 text-primary" />
            </div>
            <h2 className="text-2xl font-bold font-display">Upcoming Fixtures</h2>
          </div>
          <Badge variant="outline" className="font-mono text-[10px] border-primary/50 text-primary bg-primary/10 gap-1.5">
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-70 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            LIVE DATA
          </Badge>
        </div>
        <FixturesList
          tourFilter="all"
          tournamentFilter="all"
        />
      </section>
    </div>
  )
}
