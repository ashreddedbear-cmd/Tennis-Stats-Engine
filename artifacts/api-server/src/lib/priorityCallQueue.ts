/**
 * Two-tier priority call queue for API providers.
 *
 * Live calls (fixture fetches, player lookups for active predictions) always
 * execute before bulk/backfill calls (player match history, walk-forward) when
 * both are waiting for an available concurrency slot. This prevents a heavy
 * backfill run from delaying the live paper-trading loop.
 *
 * The queue allows up to `maxConcurrent` simultaneous in-flight calls. Slots are
 * allocated strictly in priority order: all queued LIVE calls are dequeued before
 * any queued BULK call is started.
 *
 * Bulk jobs degrade gracefully under this: they slow down (wait behind live work)
 * rather than fail outright.
 */

export type CallPriority = "live" | "bulk";

export class PriorityCallQueue {
  private readonly maxConcurrent: number;
  private inFlight = 0;
  private readonly liveQueue: Array<() => void> = [];
  private readonly bulkQueue: Array<() => void> = [];

  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
  }

  get pendingLive(): number { return this.liveQueue.length; }
  get pendingBulk(): number { return this.bulkQueue.length; }
  get currentInFlight(): number { return this.inFlight; }

  /**
   * Enqueue a call at the given priority tier.
   * Returns a Promise that resolves/rejects with the call's own result.
   * Live-priority calls are always dispatched ahead of bulk-priority calls.
   */
  async enqueue<T>(priority: CallPriority, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.inFlight++;
        // Use void-wrapped .then to avoid the unhandled-rejection linter warning;
        // errors still propagate via the outer Promise's reject.
        fn().then(
          (value) => { resolve(value); this.inFlight--; this.dispatch(); },
          (err)   => { reject(err);   this.inFlight--; this.dispatch(); },
        );
      };

      if (priority === "live") {
        this.liveQueue.push(run);
      } else {
        this.bulkQueue.push(run);
      }
      this.dispatch();
    });
  }

  /**
   * Snapshot for monitoring / health endpoints.
   */
  status(): { inFlight: number; pendingLive: number; pendingBulk: number; maxConcurrent: number } {
    return {
      inFlight: this.inFlight,
      pendingLive: this.liveQueue.length,
      pendingBulk: this.bulkQueue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private dispatch(): void {
    while (this.inFlight < this.maxConcurrent) {
      // Live calls always win over bulk calls.
      const next = this.liveQueue.shift() ?? this.bulkQueue.shift();
      if (next === undefined) break;
      next();
    }
  }
}
