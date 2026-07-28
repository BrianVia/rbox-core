/**
 * Leaf helpers shared by the legacy serialized upload path (`sync-recovery.ts`)
 * and the design-98 pipeline (`pipeline.ts`): cipher-descriptor mapping,
 * cache-hit classification, churn-defer detection, concurrency clamps, and the
 * design-99 lease materialization. Lives here (not in sync-recovery) so the
 * pipeline never imports sync-recovery — keeping the module graph acyclic.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  isSourceChangedError,
  withCipherDescriptor,
  type CipherDescriptor,
  type CoalescedBlob,
  type EncryptedBlob,
  type FileEntry,
} from "../../engine/index.js";

export { withCipherDescriptor, type CipherDescriptor };

export function descriptorFromEntry(file: FileEntry): CipherDescriptor | undefined {
  if (!file.encSha) return undefined;
  return file.comp ? { encSha: file.encSha, comp: file.comp, payloadSha: file.payloadSha, cipherSize: file.cipherSize } : { encSha: file.encSha };
}

export function descriptorFromEncryptedBlob(blob: EncryptedBlob): CipherDescriptor {
  return blob.comp ? { encSha: blob.encSha, comp: blob.comp, payloadSha: blob.payloadSha, cipherSize: blob.cipherSize } : { encSha: blob.encSha };
}

/**
 * Attaching a cipher descriptor REPLACES the entry now that `FileEntry` is
 * readonly (design 163 § "Early U0"). The publish path keeps the same entry in
 * several containers at once — the manifest's file array, the encrypt work
 * list, the upload work list — so a replacement is only visible if it lands in
 * every container holding that path. Registering a container here is what makes
 * `attach` equivalent to the old in-place mutation.
 */
export class CipherDescriptorWriter {
  private readonly slots = new Map<string, Array<{ list: FileEntry[]; index: number }>>();

  track(list: FileEntry[]): void {
    for (let index = 0; index < list.length; index++) {
      const entry = list[index]!;
      const existing = this.slots.get(entry.path);
      if (existing) existing.push({ list, index });
      else this.slots.set(entry.path, [{ list, index }]);
    }
  }

  attach(file: FileEntry, descriptor: CipherDescriptor): FileEntry {
    const next = withCipherDescriptor(file, descriptor);
    for (const slot of this.slots.get(file.path) ?? []) slot.list[slot.index] = next;
    return next;
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

let classifyCacheHitObserverForTest: ((path: string) => void) | undefined;

/** Narrow provenance-test seam shared by both publish implementations. */
export function setClassifyCacheHitObserverForTest(observer: ((path: string) => void) | undefined): void {
  classifyCacheHitObserverForTest = observer;
}

export async function classifyCacheHit(root: string, file: FileEntry): Promise<"accept" | "defer"> {
  classifyCacheHitObserverForTest?.(file.path);
  try {
    const stat = await fs.lstat(path.join(root, file.path));
    if (!stat.isFile()) return "defer";
    return stat.size === file.size && stat.mtimeMs === file.mtimeMs ? "accept" : "defer";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return "defer";
    throw error;
  }
}

export function isDeferrableChurn(error: unknown, relPath: string, warningSink: (line: string) => void = console.error): boolean {
  if (hasErrorCode(error, "ENOENT")) return true;
  if (!isSourceChangedError(error)) return false;
  warningSink(`rbox: ${relPath} changed during encryption — deferred`);
  return true;
}

export const clampConc = (value: string | undefined, fallback: number, max = 512): number => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
};

export const encryptConcurrency = (poolWorkers?: number): number =>
  clampConc(process.env.RBOX_ENCRYPT_CONCURRENCY, poolWorkers ? poolWorkers * 2 : 8);

export const uploadConcurrency = (): number =>
  clampConc(process.env.RBOX_UPLOAD_CONCURRENCY, process.env.RBOX_BATCH_BLOBS !== "0" ? 512 : 64);

export const MAX_SHAS_PER_CHECK = 50_000;
export const PER_FILE_UPLOAD_ATTEMPTS = 3;
export const FUSED_ENCRYPT_CONCURRENCY_CAP = 2048;

// Default ON (2026-07-27, issue #508): fused encrypt skips the per-blob
// temp-file lifecycles (5x wall on the fleet, 4.6x on APFS) and was proven
// address-identical over 1,000 blobs. RBOX_CRYPTO_FUSE=0 is the kill switch.
export const fuseEnabled = (): boolean => !/^(0|false|no|off)$/i.test(process.env.RBOX_CRYPTO_FUSE?.trim() ?? "");

// Default ON (founder call 2026-07-13, single-user fleet): upload-time receipt
// draining ships live; RBOX_REDEEM_DRAIN=off is the kill switch for both the
// serialized and pipeline paths (commit-enclosed final drain remains the
// catch-all either way).
export const redeemDrainUpload = () => process.env.RBOX_REDEEM_DRAIN?.trim() !== "off";

// Phase 1's legacy consumer materializes a memory lease into the existing encup
// temp flow and releases its charge there; the disk temp becomes the source of
// truth. Tier 2 activates by-reference framing and release at HTTP settlement.
export async function materializeLease(blob: CoalescedBlob, tmpDir: string): Promise<EncryptedBlob> {
  let ciphertextPath: string;
  if (blob.lease.location.kind === "file") {
    ciphertextPath = blob.lease.location.path;
    blob.lease.release();
  } else {
    ciphertextPath = path.join(tmpDir, `${blob.plaintextSha}.${randomBytes(8).toString("hex")}.ct`);
    try { await fs.writeFile(ciphertextPath, blob.lease.location.bytes); }
    finally { blob.lease.release(); }
  }
  return { plaintextSha: blob.plaintextSha, encSha: blob.encSha, ciphertextPath, cipherSize: blob.cipherSize, comp: blob.comp, payloadSha: blob.payloadSha };
}
