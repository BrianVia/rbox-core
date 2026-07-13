let downloadDisabledForProcess = false;
let uploadDisabledForProcess = false;
let packUploadDisabledForProcess = false;
const packUploadDisabledSubscribers = new Set<() => void>();
let batchRecordsCeilingValue = Number.POSITIVE_INFINITY;
let dispatchCount = 0;

export function uploaderDispatchCount(): number { return dispatchCount; }
export function resetUploaderDispatchCountForTests(): void { dispatchCount = 0; }

export class SingleGate {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/** One process-local upload budget shared by ordinary batch and pack PUTs. */
export class UploadSlotArbiter {
  private active = 0;
  private pumps: Array<() => void> = [];
  private nextPump = 0;
  private pumpQueued = false;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("upload slot limit must be a positive integer");
  }

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false;
    this.active++;
    return true;
  }

  release(): void {
    if (this.active < 1) throw new Error("upload slot released without a matching acquire");
    this.active--;
    if (this.pumpQueued || this.pumps.length === 0) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      if (this.pumps.length === 0) return;
      const start = this.nextPump % this.pumps.length;
      this.nextPump = (start + 1) % this.pumps.length;
      for (let i = 0; i < this.pumps.length; i++) this.pumps[(start + i) % this.pumps.length]!();
    });
  }

  get inFlight(): number { return this.active; }

  registerPump(fn: () => void): void {
    this.pumps.push(fn);
  }
}

export function resetBatchBlobStateForTests(): void {
  downloadDisabledForProcess = false;
  uploadDisabledForProcess = false;
  packUploadDisabledForProcess = false;
  packUploadDisabledSubscribers.clear();
  batchRecordsCeilingValue = Number.POSITIVE_INFINITY;
}

export function downloadDisabled(): boolean { return downloadDisabledForProcess; }
export function disableDownloadForProcess(): void { downloadDisabledForProcess = true; }
export function uploadDisabled(): boolean { return uploadDisabledForProcess; }
export function disableUploadForProcess(): void { uploadDisabledForProcess = true; }
export function packUploadDisabled(): boolean { return packUploadDisabledForProcess; }
export function onPackUploadDisabled(cb: () => void): () => void {
  packUploadDisabledSubscribers.add(cb);
  if (packUploadDisabledForProcess) {
    try { cb(); } catch {}
  }
  return () => packUploadDisabledSubscribers.delete(cb);
}
export function disablePackUploadForProcess(): void {
  if (packUploadDisabledForProcess) return;
  packUploadDisabledForProcess = true;
  for (const subscriber of [...packUploadDisabledSubscribers]) {
    try { subscriber(); } catch {}
  }
}
export function batchRecordsCeiling(): number { return batchRecordsCeilingValue; }
export function latchBatchRecordsCeiling(n: number): void { batchRecordsCeilingValue = Math.min(batchRecordsCeilingValue, n); }
export function incrementDispatchCount(): void { dispatchCount++; }
