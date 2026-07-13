/**
 * Redeems upload receipts DURING upload instead of once at commit (design 98
 * §3.3): single-flight, generation-safe, error-latched. Owns the durable
 * `needsUpload` accumulator — a 422-fenced address is only forgotten once a
 * replacement receipt for it REDEEMS; `flush()` returns the
 * residue, which blocks the commit into the existing reupload recovery.
 */
import type { ReceiptRedeemResult } from "../remote/commits.js";

/** Shared by the design-98 pipeline and design-111 serialized upload drainer. */
export const DEFAULT_REDEEM_THRESHOLD = 5_000;

export interface ReceiptPort {
  receiptCount(): number;
  redeem(): Promise<ReceiptRedeemResult[]>;
}

export interface ReceiptDrainerOptions {
  threshold: number;
  backlogMax: number;
  onError(error: Error): void;
}

export class ReceiptDrainer {
  readonly backlogMax: number;
  private readonly threshold: number;
  private readonly onError: (error: Error) => void;
  private readonly needsUpload = new Set<string>();
  private drainGeneration = 0;
  private readonly drainWaiters = new Set<() => void>();
  private active: Promise<void> | undefined;
  private latchedError: Error | undefined;

  constructor(private readonly port: ReceiptPort, opts: ReceiptDrainerOptions) {
    this.threshold = Math.max(1, opts.threshold);
    this.backlogMax = Math.max(0, opts.backlogMax);
    this.onError = opts.onError;
  }

  get error(): Error | undefined { return this.latchedError; }

  capture(): void {
    if (this.port.receiptCount() >= this.threshold) this.maybeKick();
  }

  maybeKick(): void {
    if (!this.latchedError && !this.active && this.port.receiptCount() > 0) this.kick();
  }

  async flush(): Promise<{ needsUpload: string[] }> {
    for (;;) {
      if (this.latchedError) throw this.latchedError;
      if (this.active) await this.active;
      else if (this.port.receiptCount() > 0) this.maybeKick();
      else return { needsUpload: [...this.needsUpload] };
    }
  }

  /** Await the settlement of any in-flight drain generation(s) WITHOUT starting new
   *  work beyond the drainer's own threshold re-kick chain. The auto re-kick chain
   *  may run additional bounded generations while the backlog remains above threshold,
   *  which shrinks monotonically once captures stop. Never throws. */
  async settle(): Promise<void> {
    while (this.active) await this.active.catch(() => {});
  }

  /** Block while the pending-receipt backlog exceeds backlogMax. Wakes on each drain
   *  completion (success or error — the latched error is rethrown) and on an external
   *  abort wake. `aborted` is polled at each loop head, mirroring the pipeline's
   *  original scope-signal check; `abortWakeups` lets an abort scope wake a parked
   *  waiter immediately. */
  async waitForBacklog(opts: { aborted?: () => Error | undefined; abortWakeups?: Set<() => void> } = {}): Promise<void> {
    while (this.port.receiptCount() > this.backlogMax) {
      const abortError = opts.aborted?.();
      if (abortError) throw abortError;
      if (this.latchedError) throw this.latchedError;
      this.maybeKick();
      const before = this.drainGeneration;
      await new Promise<void>((resolve) => {
        const wake = () => { this.drainWaiters.delete(wake); opts.abortWakeups?.delete(wake); resolve(); };
        this.drainWaiters.add(wake);
        opts.abortWakeups?.add(wake);
        // The active drain may have completed between maybeKick() and registration.
        if (this.drainGeneration !== before || this.port.receiptCount() <= this.backlogMax) wake();
      });
      const post = opts.aborted?.();
      if (post) throw post;
    }
  }

  private kick(): void {
    if (this.active || this.latchedError) return;
    const generation = this.drain();
    this.active = generation;
    void generation.finally(() => {
      if (this.active === generation) this.active = undefined;
      this.drainGeneration++;
      for (const wake of this.drainWaiters) wake();
      this.drainWaiters.clear();
      if (!this.latchedError && this.port.receiptCount() >= this.threshold) this.kick();
    }).catch(() => {});
  }

  private async drain(): Promise<void> {
    try {
      const results = await this.port.redeem();
      this.applyResults(results);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (!this.latchedError) {
        this.latchedError = err;
        this.onError(err);
      }
      throw err;
    }
  }

  private applyResults(results: ReceiptRedeemResult[]): void {
    for (const result of results) {
      for (const sha of result.needsUpload ?? []) this.needsUpload.add(sha);
      for (const sha of result.settled ?? []) this.needsUpload.delete(sha);
    }
  }
}
