---
name: Screenshot Import Service Architecture
description: Global ScreenshotImportService — unified OCR facade, provider health, caching, OCR.Space fallback, and the "no module calls OCR directly" rule.
---

## Rule
No module may call an OCR/vision provider directly. Every screenshot import must go through `screenshotImportService.importScreenshot()` exported from `services/screenshotImport/ScreenshotImportService.ts`.

## Provider chain (in priority order)
1. Vision AI providers from env (SCREENSHOT_AI_KEY → GEMINI_API_KEY → ANTHROPIC_API_KEY → AI_INTEGRATIONS_OPENAI) — handled by `recognizeMatchupScreenshot()` with `skipLabels` option
2. OCR.Space free REST fallback (`ocrSpaceProvider.ts`) — used when all vision AI providers fail
3. (Future) Tesseract local binary — no package needed, just `execFile("tesseract")`

## Architecture
- `providerHealthMonitor.ts` — in-memory per-provider status; quota_exhausted suppressed 1 hr, rate_limited 5 min, auth_failed until restart
- `imageHashCache.ts` — MD5 of raw base64, TTL 1 hr, max 200 entries (LRU)
- `rawTextParser.ts` — converts plain OCR text (OCR.Space/Tesseract output) to RawMatchupEntry[] using "X vs Y" inline + consecutive-name heuristics
- `ocrSpaceProvider.ts` — POST to api.ocr.space, free key = `helloworld` or `OCR_SPACE_API_KEY` env var
- `ScreenshotImportService.ts` — singleton; wraps recognition + resolution + cache + health

## Admin endpoints (all require admin auth)
- `GET  /api/admin/screenshot-import/health` — provider health + cache stats
- `POST /api/admin/screenshot-import/cache/clear` — clear image cache
- `POST /api/admin/screenshot-import/health/reset/:label` — reset a provider to healthy

## Health panel in frontend
In AdminParlayBuilder.tsx: server icon button in header toggles `ProviderHealthPanel` component. Shows status dot per provider, reset button for exhausted ones, cache entry count + clear button.

## `recognizeMatchupScreenshot` options
Added `options?: { skipLabels?: Set<string> }` — callers can pass pre-known unhealthy labels; function also now returns `providerUsed?: string` in result.

**Why:** When both OpenAI and Gemini are quota-exhausted, the app was failing hard. OCR.Space gives degraded-but-working extraction so screenshot imports survive provider outages.
