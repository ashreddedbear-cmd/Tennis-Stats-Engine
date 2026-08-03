/**
 * ProviderHealthMonitor — tracks live health state for each OCR/vision provider.
 *
 * Providers transition through states:
 *   healthy → rate_limited → quota_exhausted | auth_failed | offline
 *
 * Health state is consulted before attempting a provider so already-dead providers
 * are skipped immediately without burning time on a network call that will fail.
 *
 * All state is in-process memory (no DB). Restarting the server resets health.
 */

export type ProviderStatus =
  | "healthy"
  | "rate_limited"
  | "quota_exhausted"
  | "auth_failed"
  | "offline";

export interface ProviderHealth {
  label: string;
  status: ProviderStatus;
  lastErrorAt: Date | null;
  /** Count of permanent failures (quota/auth) in the current process lifetime. */
  permanentFailures: number;
  /** Count of transient failures (rate-limit, timeout, 5xx) since last success. */
  transientFailures: number;
  lastSuccessAt: Date | null;
  lastUsedModel?: string;      // for Gemini — which model last succeeded
}

// How long a quota_exhausted mark suppresses the provider (1 hour).
const QUOTA_SUPPRESS_MS = 60 * 60 * 1000;
// How long a rate_limit mark suppresses before we try again (5 min).
const RATE_LIMIT_SUPPRESS_MS = 5 * 60 * 1000;

const _state = new Map<string, ProviderHealth>();

function getOrCreate(label: string): ProviderHealth {
  if (!_state.has(label)) {
    _state.set(label, {
      label,
      status: "healthy",
      lastErrorAt: null,
      permanentFailures: 0,
      transientFailures: 0,
      lastSuccessAt: null,
    });
  }
  return _state.get(label)!;
}

/** Returns true when this provider should be skipped without attempting. */
export function isProviderSkippable(label: string): boolean {
  const h = _state.get(label);
  if (!h) return false;

  if (h.status === "auth_failed") return true; // permanent until restart

  if (h.status === "quota_exhausted" && h.lastErrorAt) {
    const age = Date.now() - h.lastErrorAt.getTime();
    return age < QUOTA_SUPPRESS_MS; // skip for 1 hour
  }

  if (h.status === "rate_limited" && h.lastErrorAt) {
    const age = Date.now() - h.lastErrorAt.getTime();
    return age < RATE_LIMIT_SUPPRESS_MS; // skip for 5 min
  }

  return false;
}

/** Call when a provider succeeds. */
export function recordSuccess(label: string, model?: string): void {
  const h = getOrCreate(label);
  h.status = "healthy";
  h.transientFailures = 0;
  h.lastSuccessAt = new Date();
  if (model) h.lastUsedModel = model;
  _state.set(label, h);
}

/** Call when a provider fails with a permanent error (quota exhausted, auth failure). */
export function recordPermanentFailure(label: string, reason: "quota_exhausted" | "auth_failed"): void {
  const h = getOrCreate(label);
  h.status = reason;
  h.lastErrorAt = new Date();
  h.permanentFailures++;
  _state.set(label, h);
}

/** Call when a provider fails with a transient error (rate-limit, timeout, 5xx). */
export function recordTransientFailure(label: string): void {
  const h = getOrCreate(label);
  h.status = "rate_limited";
  h.lastErrorAt = new Date();
  h.transientFailures++;
  _state.set(label, h);
}

/** Call when a provider is not reachable at all (network error, DNS failure). */
export function recordOffline(label: string): void {
  const h = getOrCreate(label);
  h.status = "offline";
  h.lastErrorAt = new Date();
  _state.set(label, h);
}

/** Returns a snapshot of all known provider health records. */
export function getAllProviderHealth(): ProviderHealth[] {
  return Array.from(_state.values());
}

/** Reset a provider to healthy (e.g. after an admin manually refreshes a key). */
export function resetProviderHealth(label: string): void {
  if (_state.has(label)) {
    const h = _state.get(label)!;
    h.status = "healthy";
    h.lastErrorAt = null;
    h.transientFailures = 0;
    _state.set(label, h);
  }
}
