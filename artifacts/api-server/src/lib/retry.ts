/**
 * Retry with exponential backoff + jitter.
 *
 * Retries on network errors and optionally on specific HTTP-like errors via `retryOn`.
 * Does NOT retry on 4xx client errors by default (caller must opt-in).
 *
 * Usage:
 *   const result = await withRetry(() => fetch(...), { attempts: 3, baseDelayMs: 300 });
 */

export interface RetryOptions {
  /** Total number of attempts including the first. Default 3. */
  attempts?: number;
  /** Base delay in ms before first retry. Doubles each attempt. Default 300. */
  baseDelayMs?: number;
  /** Max delay cap in ms. Default 10_000. */
  maxDelayMs?: number;
  /** Return true to retry on this error; false to rethrow immediately. Default: always retry. */
  retryOn?: (err: unknown, attempt: number) => boolean;
  /** Called before each retry with the attempt number (1 = first retry). */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(base: number): number {
  // Full jitter: random in [0, base] — prevents thundering herd
  return Math.random() * base;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 300,
    maxDelayMs = 10_000,
    retryOn,
    onRetry,
  } = options;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const isLastAttempt = attempt === attempts;
      if (isLastAttempt) break;

      // Check if this error type is retryable
      if (retryOn && !retryOn(err, attempt)) {
        throw err;
      }

      // Exponential backoff with full jitter
      const exponential = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const delay = jitter(exponential);

      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * Returns true for errors that are likely transient and worth retrying:
 * - Network timeouts / aborts (DOMException TimeoutError, AbortError)
 * - ECONNRESET / ECONNREFUSED / ETIMEDOUT (node fetch)
 * - HTTP 429, 502, 503, 504
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'TimeoutError' || err.name === 'AbortError';
  }
  if (err instanceof TypeError && err.message.includes('fetch')) {
    return true; // network-level fetch failure
  }
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(code)) return true;
  }
  // HTTP status-based errors wrapped with a `status` property
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status;
    return status === 429 || status === 502 || status === 503 || status === 504;
  }
  return false;
}
