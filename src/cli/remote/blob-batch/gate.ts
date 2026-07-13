let downloadDisabledForProcess = false;
let uploadDisabledForProcess = false;
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

export function resetBatchBlobStateForTests(): void {
  downloadDisabledForProcess = false;
  uploadDisabledForProcess = false;
  batchRecordsCeilingValue = Number.POSITIVE_INFINITY;
}

export function downloadDisabled(): boolean { return downloadDisabledForProcess; }
export function disableDownloadForProcess(): void { downloadDisabledForProcess = true; }
export function uploadDisabled(): boolean { return uploadDisabledForProcess; }
export function disableUploadForProcess(): void { uploadDisabledForProcess = true; }
export function batchRecordsCeiling(): number { return batchRecordsCeilingValue; }
export function latchBatchRecordsCeiling(n: number): void { batchRecordsCeilingValue = Math.min(batchRecordsCeilingValue, n); }
export function incrementDispatchCount(): void { dispatchCount++; }
