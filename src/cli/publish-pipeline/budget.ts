type Waiter = { n: number; resolve: () => void; reject: (error: Error) => void };

/** FIFO reservation axis used by the publish pipeline's resource bounds. */
export class ResourceBudget {
  used = 0;
  highWater = 0;
  private readonly waiters: Waiter[] = [];
  private closedError: Error | undefined;

  constructor(readonly cap: number) {}

  reserve(n: number): Promise<void> {
    this.assertCharge(n);
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.cap <= 0) return Promise.resolve();
    if (this.waiters.length === 0 && (this.used + n <= this.cap || this.used === 0)) {
      this.admit(n);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => this.waiters.push({ n, resolve, reject }));
  }

  reconcile(from: number, to: number): void {
    this.assertCharge(from);
    this.assertCharge(to);
    if (this.cap <= 0) return;
    if (from > this.used) throw new Error("resource budget reconciled below zero");
    this.used += to - from;
    this.highWater = Math.max(this.highWater, this.used);
    this.wake();
  }

  release(n: number): void {
    this.assertCharge(n);
    if (this.cap <= 0) return;
    if (n > this.used) throw new Error("resource budget released below zero");
    this.used -= n;
    this.wake();
  }

  close(err: Error): void {
    if (this.closedError) return;
    this.closedError = err;
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
  }

  private wake(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]!;
      if (this.used + waiter.n > this.cap && this.used !== 0) return;
      this.waiters.shift();
      this.admit(waiter.n);
      waiter.resolve();
    }
  }

  private admit(n: number): void {
    this.used += n;
    this.highWater = Math.max(this.highWater, this.used);
  }

  private assertCharge(n: number): void {
    if (!Number.isFinite(n) || n < 0) throw new RangeError("resource charge must be a non-negative finite number");
  }
}
