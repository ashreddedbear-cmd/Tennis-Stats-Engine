export type FallbackSource = "serveReturn" | "recentForm" | "index";

export interface FallbackInstrumentation {
  usedFallback: boolean | null;
  fallbackSources: FallbackSource[] | null;
}

/**
 * Extracts instrumentation-only fallback metadata from already-computed engine artifacts.
 * This helper is read-only over existing outputs and never changes scoring behavior.
 */
export function extractFallbackInstrumentation(input: {
  engine?: unknown;
  decisionTrace?: unknown;
}): FallbackInstrumentation {
  const engine = (input.engine ?? null) as
    | {
        serveReturn?: { note?: string | null };
        recentForm?: {
          player1OpponentAdjustedCoverage?: number;
          player2OpponentAdjustedCoverage?: number;
        };
      }
    | null;

  const decisionTrace = (input.decisionTrace ?? null) as
    | {
        pipeline?: { calibrationMethod?: string };
      }
    | null;

  if (!engine && !decisionTrace) return { usedFallback: null, fallbackSources: null };

  const sources: FallbackSource[] = [];

  // serveReturn.ts proxy fallback path discloses itself via the module note string.
  const serveReturnNote = engine?.serveReturn?.note;
  if (typeof serveReturnNote === "string" && serveReturnNote.includes("ratings are derived from real set/game score margins")) {
    sources.push("serveReturn");
  }

  // recentForm.ts fallback behavior appears when opponent-adjusted coverage is not fully resolved.
  const p1Coverage = engine?.recentForm?.player1OpponentAdjustedCoverage;
  const p2Coverage = engine?.recentForm?.player2OpponentAdjustedCoverage;
  if (typeof p1Coverage === "number" && typeof p2Coverage === "number" && (p1Coverage < 100 || p2Coverage < 100)) {
    sources.push("recentForm");
  }

  // index.ts fallback path: no fitted calibration mapping, so DQ-shrink fallback is used.
  if (decisionTrace?.pipeline?.calibrationMethod === "fallback") {
    sources.push("index");
  }

  const uniqueSources = Array.from(new Set(sources));
  return {
    usedFallback: uniqueSources.length > 0,
    fallbackSources: uniqueSources,
  };
}
