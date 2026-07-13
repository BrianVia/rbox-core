import type { EncryptFileOptions } from "../crypto.js";

export type CiphertextLocation = { kind: "memory"; bytes: Uint8Array } | { kind: "file"; path: string };
export interface CiphertextLease {
  readonly encSha: string;
  readonly size: number;
  readonly location: CiphertextLocation;
  release(): void;
}
export type CoalescedBlob = {
  plaintextSha: string; encSha: string; cipherSize: number; comp?: "zstd"; payloadSha?: string;
  lease: CiphertextLease;
};

export class CiphertextBudget {
  used = 0;
  highWater = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(readonly cap: number) {}
  tryReserve(n: number): boolean {
    if (this.used + n > this.cap) return false;
    this.used += n;
    this.highWater = Math.max(this.highWater, this.used);
    return true;
  }
  wait(): Promise<void> { return new Promise((resolve) => this.waiters.push(resolve)); }
  convert(reserved: number, exactCharges: number[]): void {
    const exact = exactCharges.reduce((n, x) => n + x, 0);
    if (exact > reserved) throw new Error("fused ciphertext exceeds job reserve");
    this.used -= reserved - exact;
    this.wake();
  }
  release(n: number): void {
    this.used -= n;
    if (this.used < 0) throw new Error("ciphertext budget released below zero");
    this.wake();
  }
  wake(): void { for (const waiter of this.waiters.splice(0)) waiter(); }
}

export type PendingFile = {
  srcPath: string; size: number; tmpDir: string; opts: EncryptFileOptions;
  expected: { sha256: string; size: number }; attempts: number;
  deliver: (blob: CoalescedBlob) => void | Promise<void>; reject: (err: unknown) => void;
  owner?: symbol;
};
export type FusedJob = { files: PendingFile[]; reserved: boolean; posted: boolean };
export type ProducerResult = { file: PendingFile; blob: CoalescedBlob; bytes: Uint8Array; charge: number; delivered: boolean };
