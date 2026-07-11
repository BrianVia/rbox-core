import { bytes32ToHex, REFSET_HEADER, REFSET_REC } from "../../../src/engine/refset.js";

export const FENCE_SET_MAX = 50_000; // design 102 §7.1
export const DIVERGENCE_SAMPLE = 16; // design 102 §7.1
export const DELTA_MAX_REFS = 250_000; // design 102 §3.5A.3 (== FOLD_MAX_REFS)

export interface DeltaResult {
  added: string[];
  markedCarried: string[];
  intentCarriedHit: boolean;
  addedCount: number;
  removedCount: number;
  carriedCount: number;
}

/** Merge two ascending SHA lists into one ascending list without duplicates. */
export function mergeSortedUnique(a: string[], b: string[]): string[] {
  const merged: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const av = a[i];
    const bv = b[j];
    if (bv === undefined || (av !== undefined && av < bv)) { merged.push(av!); i++; }
    else if (av === undefined || bv < av) { merged.push(bv); j++; }
    else { merged.push(av); i++; j++; }
  }
  return merged;
}

export function compare32(a: Uint8Array, aOff: number, b: Uint8Array, bOff: number): number {
  for (let i = 0; i < 32; i++) {
    const d = a[aOff + i]! - b[bOff + i]!;
    if (d !== 0) return d;
  }
  return 0;
}

export function mergeAddedShas(parentBuf: Uint8Array, childBuf: Uint8Array, markedSet: Set<string>, intentSet: Set<string>): DeltaResult {
  const parentCount = new DataView(parentBuf.buffer, parentBuf.byteOffset, parentBuf.byteLength).getUint32(14, false);
  const childCount = new DataView(childBuf.buffer, childBuf.byteOffset, childBuf.byteLength).getUint32(14, false);
  const added: string[] = [];
  const markedCarried: string[] = [];
  let intentCarriedHit = false;
  let addedCount = 0;
  let removedCount = 0;
  let carriedCount = 0;
  let prevAddedHex = "";
  let prevChildHex = "";
  let i = 0;
  let j = 0;
  const readChild = (off: number): string => {
    const sha = bytes32ToHex(childBuf, off);
    if (j > 0 && sha <= prevChildHex) throw new Error("delta: child not strictly ascending");
    prevChildHex = sha;
    return sha;
  };
  const pushAdded = (off: number): void => {
    const sha = readChild(off);
    if (addedCount > 0 && sha <= prevAddedHex) throw new Error("delta: child not strictly ascending");
    prevAddedHex = sha;
    added.push(sha);
    addedCount++;
  };
  while (i < parentCount && j < childCount) {
    const pOff = REFSET_HEADER + REFSET_REC * i;
    const cOff = REFSET_HEADER + REFSET_REC * j;
    const cmp = compare32(parentBuf, pOff, childBuf, cOff);
    if (cmp === 0) {
      carriedCount++;
      const sha = readChild(cOff);
      if (intentSet.has(sha)) intentCarriedHit = true;
      if (markedSet.has(sha)) markedCarried.push(sha);
      i++;
      j++;
    } else if (cmp < 0) {
      removedCount++;
      i++;
    } else {
      pushAdded(cOff);
      j++;
    }
  }
  removedCount += parentCount - i;
  while (j < childCount) {
    pushAdded(REFSET_HEADER + REFSET_REC * j);
    j++;
  }
  return { added, markedCarried, intentCarriedHit, addedCount, removedCount, carriedCount };
}

export interface ShadowFlags {
  present: boolean;
  entitled: boolean;
  marked: boolean;
  activeIntent: boolean;
}

export interface ShadowInput {
  childShas: string[];
  carriers: string[];
  addedSet: Set<string>;
  markedCarriedSet: Set<string>;
  flags: Map<string, ShadowFlags>;
  receiptKeys: Set<string>;
}

export interface ShadowResult {
  harmful: string[];
  benign: string[];
  divergent: boolean;
}

export function classifyShadow(input: ShadowInput): ShadowResult {
  const haveFull = (sha: string): boolean => {
    const f = input.flags.get(sha);
    return !!f && f.present && f.entitled && !f.marked && !f.activeIntent;
  };
  const full = [...new Set([...input.carriers, ...input.childShas])];
  const admit = [...new Set([...input.carriers, ...input.childShas.filter((sha) => input.addedSet.has(sha) || input.markedCarriedSet.has(sha))])];
  const newFull = new Set(full.filter((sha) => !haveFull(sha) && input.receiptKeys.has(sha)));
  const newDelta = new Set(admit.filter((sha) => !haveFull(sha) && input.receiptKeys.has(sha)));
  let assertionFailed = newFull.size !== newDelta.size || [...newFull].some((sha) => !newDelta.has(sha));
  const harmful: string[] = [];
  const benign: string[] = [];
  for (const sha of input.childShas) {
    if (input.addedSet.has(sha) || haveFull(sha)) continue;
    const f = input.flags.get(sha) ?? { present: false, entitled: false, marked: false, activeIntent: false };
    if (f.present && f.entitled && f.marked && !f.activeIntent) benign.push(sha);
    else harmful.push(sha);
    if (!input.markedCarriedSet.has(sha)) assertionFailed = true;
  }
  return { harmful, benign, divergent: harmful.length > 0 || assertionFailed };
}

export function divergenceDigest(shas: string[]): { digest: string; sample: string[] } {
  const sorted = [...shas].sort();
  // Stable FNV-1a-64; non-cryptographic by design, fixed-width and telemetry-only.
  let hash = 0xcbf29ce484222325n;
  for (const ch of sorted.join("\n")) {
    hash ^= BigInt(ch.charCodeAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return { digest: hash.toString(16).padStart(16, "0"), sample: sorted.slice(0, DIVERGENCE_SAMPLE) };
}
