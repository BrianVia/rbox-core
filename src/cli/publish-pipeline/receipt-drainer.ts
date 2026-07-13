/**
 * Redeems upload receipts DURING upload instead of once at commit (design 98
 * §3.3): single-flight, generation-safe, error-latched. Owns the durable
 * `needsUpload` accumulator — a 422-fenced address is only forgotten once a
 * replacement receipt for it REDEEMS; `flush()` returns the
 * residue, which blocks the commit into the existing reupload recovery.
 */
import type { ReceiptRedeemResult } from "../remote/commits.js";

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
  private readonly drainCallbacks = new Set<() => void>();
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

  onDrainComplete(cb: () => void): void {
    this.drainCallbacks.add(cb);
  }

  async flush(): Promise<{ needsUpload: string[] }> {
    for (;;) {
      if (this.latchedError) throw this.latchedError;
      if (this.active) await this.active;
      else if (this.port.receiptCount() > 0) this.maybeKick();
      else return { needsUpload: [...this.needsUpload] };
    }
  }

  private kick(): void {
    if (this.active || this.latchedError) return;
    const generation = this.drain();
    this.active = generation;
    void generation.finally(() => {
      if (this.active === generation) this.active = undefined;
      for (const cb of this.drainCallbacks) cb();
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
