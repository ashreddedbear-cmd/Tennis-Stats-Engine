/**
 * Pipeline-quiet detector for paper trading (Task #110).
 * Extracted as a pure function so it is independently testable without DB access.
 */

export const PAPER_TRADE_QUIET_WINDOW_HOURS = 36;

/**
 * Returns true when the paper-trading pipeline should be considered "quiet" —
 * i.e. no successful cycle has completed within the configured window.
 *
 * A null `lastRunAt` (pipeline has never run) is always considered quiet.
 */
export function isPipelineQuiet(lastRunAt: Date | null, quietWindowHours: number = PAPER_TRADE_QUIET_WINDOW_HOURS): boolean {
  if (!lastRunAt) return true;
  const hoursSince = (Date.now() - lastRunAt.getTime()) / (1000 * 60 * 60);
  return hoursSince > quietWindowHours;
}

// ── Operator alert (#116) ──────────────────────────────────────────────────
//
// When the pipeline goes quiet, POST a structured JSON payload to
// QUIET_PIPELINE_ALERT_WEBHOOK_URL (works with Slack incoming webhooks,
// Discord webhooks, Make/Zapier webhook triggers, and any HTTP endpoint
// that accepts JSON).
//
// A simple in-memory cooldown prevents re-firing on every status poll —
// the alert fires at most once every ALERT_COOLDOWN_HOURS hours.
//
// To test: set QUIET_PIPELINE_ALERT_WEBHOOK_URL to a webhook URL and
// call POST /api/evaluation/paper-trading/test-quiet-alert (admin-only).

const ALERT_COOLDOWN_HOURS = 4;
let lastAlertFiredAt: Date | null = null;

/** Returns true if the cooldown has elapsed (or this is the first alert). */
function isCooldownElapsed(): boolean {
  if (!lastAlertFiredAt) return true;
  const hoursSince = (Date.now() - lastAlertFiredAt.getTime()) / (1000 * 60 * 60);
  return hoursSince >= ALERT_COOLDOWN_HOURS;
}

/**
 * Fires the pipeline-quiet operator alert to QUIET_PIPELINE_ALERT_WEBHOOK_URL.
 *
 * @param lastRunAt  The last time a paper-trading cycle completed (or null if never).
 * @param force      Skip the cooldown check — use for live alert tests only.
 * @returns          "fired" | "cooldown" | "no-webhook" | "error:<message>"
 */
export async function sendPipelineQuietAlert(
  lastRunAt: Date | null,
  force = false,
): Promise<"fired" | "cooldown" | "no-webhook" | `error:${string}`> {
  const webhookUrl = process.env.QUIET_PIPELINE_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) return "no-webhook";

  if (!force && !isCooldownElapsed()) return "cooldown";

  const hoursSince = lastRunAt
    ? Math.round(((Date.now() - lastRunAt.getTime()) / (1000 * 60 * 60)) * 10) / 10
    : null;

  const text = lastRunAt
    ? `⚠️ *Tennis Matrix — Paper Trading Pipeline Quiet Alert*\nNo paper-trading cycle has completed in the last ${hoursSince}h (threshold: ${PAPER_TRADE_QUIET_WINDOW_HOURS}h). Last run: ${lastRunAt.toISOString()}`
    : `⚠️ *Tennis Matrix — Paper Trading Pipeline Quiet Alert*\nThe paper-trading pipeline has *never run* — no successful cycle found.`;

  const payload = {
    text,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    hoursSinceLastRun: hoursSince,
    quietWindowHours: PAPER_TRADE_QUIET_WINDOW_HOURS,
    firedAt: new Date().toISOString(),
  };

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return `error:webhook returned ${resp.status}${body ? ` — ${body.slice(0, 120)}` : ""}`;
    }

    lastAlertFiredAt = new Date();
    return "fired";
  } catch (err) {
    return `error:${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Resets the in-memory cooldown — used only by tests and the live-test endpoint.
 */
export function resetAlertCooldown(): void {
  lastAlertFiredAt = null;
}
