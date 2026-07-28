/**
 * Pure replacement for the mutating `applyCipherDescriptor` (design 163 § "Early
 * U0"): it returns a new `Readonly<FileEntry>` for one generation reference
 * instead of mutating an alias shared by several generations.
 *
 * It preserves ALL extension members and, when compression is absent, removes
 * `comp`, `payloadSha`, and `cipherSize` together.
 */
import type { FileEntry } from "../types.js";

export interface CipherDescriptor {
  encSha: string;
  cipherSize?: number;
  comp?: "zstd";
  payloadSha?: string;
}

export function withCipherDescriptor(file: Readonly<FileEntry>, descriptor: CipherDescriptor): Readonly<FileEntry> {
  const next: Record<string, unknown> = { ...file };
  next.encSha = descriptor.encSha;
  if (descriptor.comp) {
    next.comp = descriptor.comp;
    next.payloadSha = descriptor.payloadSha;
    next.cipherSize = descriptor.cipherSize;
  } else {
    delete next.comp;
    delete next.payloadSha;
    delete next.cipherSize;
  }
  return next as Readonly<FileEntry>;
}
