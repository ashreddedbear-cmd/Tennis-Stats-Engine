import type { PlayerProfile } from "../services/tennisData";

interface PredictionIdentityRequestBody {
  player1Id: string;
  player2Id: string;
  surface: string;
  matchFormat: string;
  [key: string]: unknown;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PredictionRequestIntegrity {
  requestId: string;
  requestMatchId: string;
  submittedPlayer1Name: string | null;
  submittedPlayer2Name: string | null;
}

export interface PredictionIntegrityError {
  code: "BAD_REQUEST" | "INTEGRITY_MISMATCH";
  message: string;
}

export function getExternalFixtureIdFromRequestMatchId(requestMatchId: string): string | null {
  if (!requestMatchId.startsWith("fixture:")) return null;
  const id = requestMatchId.slice("fixture:".length).trim();
  return id.length > 0 ? id : null;
}

export function parsePredictionRequestIntegrityHeaders(headers: Record<string, unknown>): PredictionRequestIntegrity | PredictionIntegrityError {
  const requestIdRaw = getHeader(headers, "x-prediction-request-id");
  const requestMatchIdRaw = getHeader(headers, "x-prediction-match-id");

  if (!requestIdRaw) {
    return { code: "BAD_REQUEST", message: "Missing required header x-prediction-request-id" };
  }
  if (!UUID_V4_RE.test(requestIdRaw)) {
    return { code: "BAD_REQUEST", message: "x-prediction-request-id must be a valid UUID v4" };
  }
  if (!requestMatchIdRaw || requestMatchIdRaw.trim().length < 6) {
    return { code: "BAD_REQUEST", message: "x-prediction-match-id must be present and at least 6 characters" };
  }

  return {
    requestId: requestIdRaw,
    requestMatchId: requestMatchIdRaw.trim(),
    submittedPlayer1Name: sanitizeOptionalName(getHeader(headers, "x-submitted-player1-name")),
    submittedPlayer2Name: sanitizeOptionalName(getHeader(headers, "x-submitted-player2-name")),
  };
}

export function normalizePersonName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[''ʼ\u2019]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compares two player names with abbreviation tolerance.
 * "Tereza Valentova" matches "T. Valentova" / "t valentova" because providers often store
 * abbreviated names while fixture cards submit full names. normalizePersonName strips dots,
 * so "T." → "t", making both names have the same word count.
 */
function personNamesMatch(submitted: string, resolved: string): boolean {
  const a = normalizePersonName(submitted);
  const b = normalizePersonName(resolved);
  if (a === b) return true;

  const aWords = a.split(" ").filter(Boolean);
  const bWords = b.split(" ").filter(Boolean);

  // Both names must have the same number of words (abbreviated first name, same surname(s))
  if (aWords.length !== bWords.length || aWords.length < 2) return false;

  // Check surnames match exactly
  const aSurnames = aWords.slice(1);
  const bSurnames = bWords.slice(1);
  if (!aSurnames.every((w, i) => w === bSurnames[i])) return false;

  // First words: one must be a single-letter initial of the other ("t" vs "tereza")
  const aFirst = aWords[0]!;
  const bFirst = bWords[0]!;
  return (aFirst.length === 1 && bFirst.startsWith(aFirst)) ||
         (bFirst.length === 1 && aFirst.startsWith(bFirst));
}

export function assertPredictionIdentityIntegrity(
  body: PredictionIdentityRequestBody,
  integrity: PredictionRequestIntegrity,
  player1: PlayerProfile,
  player2: PlayerProfile,
): PredictionIntegrityError | null {
  if (body.player1Id !== player1.id) {
    return {
      code: "INTEGRITY_MISMATCH",
      message: `Integrity check failed: submitted player1Id (${body.player1Id}) did not match resolved player1Id (${player1.id})`,
    };
  }
  if (body.player2Id !== player2.id) {
    return {
      code: "INTEGRITY_MISMATCH",
      message: `Integrity check failed: submitted player2Id (${body.player2Id}) did not match resolved player2Id (${player2.id})`,
    };
  }

  if (isDoublesLikeName(player1.name) || isDoublesLikeName(player2.name)) {
    return {
      code: "INTEGRITY_MISMATCH",
      message: "Integrity check failed: doubles/team names are not allowed in singles prediction requests",
    };
  }

  if (integrity.submittedPlayer1Name) {
    if (!personNamesMatch(integrity.submittedPlayer1Name, player1.name)) {
      return {
        code: "INTEGRITY_MISMATCH",
        message: `Integrity check failed: submitted player1 name (${integrity.submittedPlayer1Name}) did not match resolved player1 name (${player1.name})`,
      };
    }
  }
  if (integrity.submittedPlayer2Name) {
    if (!personNamesMatch(integrity.submittedPlayer2Name, player2.name)) {
      return {
        code: "INTEGRITY_MISMATCH",
        message: `Integrity check failed: submitted player2 name (${integrity.submittedPlayer2Name}) did not match resolved player2 name (${player2.name})`,
      };
    }
  }

  if (body.surface !== "Hard" && body.surface !== "Clay" && body.surface !== "Grass" && body.surface !== "IndoorHard") {
    return {
      code: "INTEGRITY_MISMATCH",
      message: `Integrity check failed: invalid submitted surface (${body.surface})`,
    };
  }

  if (body.matchFormat !== "BestOf3" && body.matchFormat !== "BestOf5") {
    return {
      code: "INTEGRITY_MISMATCH",
      message: `Integrity check failed: invalid submitted matchFormat (${body.matchFormat})`,
    };
  }

  return null;
}

export function isDoublesLikeName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\s\/\s|\//.test(name);
}

function getHeader(headers: Record<string, unknown>, key: string): string | null {
  const value = headers[key] ?? headers[key.toLowerCase()];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

function sanitizeOptionalName(name: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}
