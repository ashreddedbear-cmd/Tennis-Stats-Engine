/**
 * Simple per-provider circuit breaker.
 *
 * States:
 *   CLOSED  — normal operation; failures accumulate
 *   OPEN    — fast-fail for openDurationMs; no calls reach the provider
 *   HALF_OPEN — one probe allowed; success closes, failure re-opens
 *
 * All instances are registered in a module-level map so middleware/health
 * routes can inspect every breaker's state without passing references around.
 */

import { logger } from './logger';

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Number of failures in the rolling window before opening. Default 5. */
  failureThreshold?: number;
  /** How long (ms) the circuit stays open before trying half-open. Default 30_000. */
  openDurationMs?: number;
  /** Rolling window duration for counting failures (ms). Default 60_000. */
  windowMs?: number;
}

export class CircuitBreaker {
  private readonly name: string;
  private state: BreakerState = 'CLOSED';
  private failures: number[] = []; // timestamps of recent failures
  private openedAt: number | null = null;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly windowMs: number;

  constructor(name: string, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.openDurationMs = options.openDurationMs ?? 30_000;
    this.windowMs = options.windowMs ?? 60_000;
    registry.set(name, this);
  }

  get currentState(): BreakerState {
    this.tick();
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.tick();

    if (this.state === 'OPEN') {
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Snapshot suitable for health endpoint responses. */
  status() {
    this.tick();
    return {
      name: this.name,
      state: this.state,
      recentFailures: this.failures.length,
      failureThreshold: this.failureThreshold,
      openedAt: this.openedAt,
    };
  }

  private tick(): void {
    const now = Date.now();
    // Evict failures outside the rolling window
    this.failures = this.failures.filter((ts) => now - ts < this.windowMs);

    if (this.state === 'OPEN' && this.openedAt !== null) {
      if (now - this.openedAt >= this.openDurationMs) {
        this.state = 'HALF_OPEN';
        logger.info({ breaker: this.name }, 'Circuit breaker → HALF_OPEN (probing)');
      }
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      logger.info({ breaker: this.name }, 'Circuit breaker → CLOSED (probe succeeded)');
    }
    this.state = 'CLOSED';
    this.failures = [];
    this.openedAt = null;
  }

  private onFailure(): void {
    const now = Date.now();
    this.failures.push(now);
    this.failures = this.failures.filter((ts) => now - ts < this.windowMs);

    if (this.state === 'HALF_OPEN' || this.failures.length >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = now;
      logger.warn(
        { breaker: this.name, failures: this.failures.length },
        'Circuit breaker → OPEN',
      );
    }
  }
}

export class CircuitOpenError extends Error {
  readonly breakerName: string;
  constructor(name: string) {
    super(`Circuit breaker OPEN for provider: ${name}`);
    this.name = 'CircuitOpenError';
    this.breakerName = name;
  }
}

/** Module-level registry — use for health endpoints. */
const registry = new Map<string, CircuitBreaker>();

export function getAllBreakerStatuses() {
  return Array.from(registry.values()).map((b) => b.status());
}
