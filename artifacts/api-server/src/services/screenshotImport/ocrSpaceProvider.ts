/**
 * OCR.Space fallback provider.
 *
 * Uses the OCR.Space free REST API (https://ocr.space/ocrapi) to extract text from
 * an image when all vision-AI providers are unavailable. Quality is lower than vision
 * AI (no semantic understanding of "find tennis matchups"), but it can reliably extract
 * player name text that rawTextParser() then turns into matchup pairs.
 *
 * API key: uses OCR_SPACE_API_KEY env var if set; falls back to the public "helloworld"
 * free demo key (limited to ~500 requests/month, adequate for fallback use).
 *
 * Provider label: "OCR.Space"
 */

import type { RawMatchupEntry } from "../tennisData/screenshotRecognition.js";
import { parseOcrText } from "./rawTextParser.js";

const OCR_SPACE_URL = "https://api.ocr.space/parse/image";
const DEMO_KEY = "helloworld";
const TIMEOUT_MS = 20_000;

interface OcrSpaceResponse {
  ParsedResults?: Array<{
    ParsedText?: string;
    ErrorMessage?: string;
    FileParseExitCode?: number;
  }>;
  IsErroredOnProcessing?: boolean;
  ErrorMessage?: string | string[];
  OCRExitCode?: number;
}

export interface OcrSpaceResult {
  matchups: RawMatchupEntry[];
  rawText: string;
  durationMs: number;
}

export async function callOcrSpace(imageBase64: string): Promise<OcrSpaceResult> {
  const apiKey = process.env.OCR_SPACE_API_KEY ?? DEMO_KEY;

  // Ensure the data URL prefix is present (OCR.Space requires it)
  const dataUrl = imageBase64.startsWith("data:")
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const body = new URLSearchParams();
  body.set("apikey", apiKey);
  body.set("base64Image", dataUrl);
  body.set("language", "eng");
  body.set("isOverlayRequired", "false");
  body.set("detectOrientation", "true");
  body.set("scale", "true");
  body.set("OCREngine", "2"); // engine 2 handles rotated/overlapping text better

  const t0 = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(OCR_SPACE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err: any = new Error(`OCR.Space HTTP ${res.status}: ${msg.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const json = await res.json() as OcrSpaceResponse;
  const durationMs = Date.now() - t0;

  if (json.IsErroredOnProcessing) {
    const errMsg = Array.isArray(json.ErrorMessage)
      ? json.ErrorMessage.join("; ")
      : (json.ErrorMessage ?? "Unknown OCR.Space error");
    throw new Error(`OCR.Space processing error: ${errMsg}`);
  }

  const rawText = (json.ParsedResults ?? [])
    .map((r) => r.ParsedText ?? "")
    .join("\n")
    .trim();

  const matchups = parseOcrText(rawText);

  return { matchups, rawText, durationMs };
}
