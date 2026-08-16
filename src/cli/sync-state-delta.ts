/**
 * Relative global composition (design 269). One owner for the question "may this
 * save carry ops instead of a whole manifest, and what are they?".
 *
 * The ops and the whole manifest come from the SAME walk in the composer, so no
 * backend has to diff and no consumer has to trust that two independent
 * derivations agree.
 */
import type { FileEntry } from "../engine/index.js";
import { isDeepStrictEqual } from "node:util";

/** An accepted CAS of any kind bumps `stateRevision`, so revision equality
 * proves no writer interleaved since the composer's load. */
export interface DeltaBinding { nonce: string; stateRevision: number }

/** One file-level change against the predecessor manifest. */
export type DeltaOp =
  | { kind: "upsert"; entry: FileEntry }
  | { kind: "delete"; path: string };

/** Ops are strictly ascending by path; no path appears twice across kinds. */
export interface GlobalDelta {
  binding: DeltaBinding;
  ops: readonly DeltaOp[];
}


/** Kill switch, default ON; deletion condition is one clean fleet soak plus the
 * Mac field close-out. */
export const saveDeltaEnabled = (): boolean => process.env.RBOX_SAVE_DELTA !== "0";

/** Keyed by stream: one process may hold several workspaces, and drift in one
 * is no reason to make another rewrite its manifest (§2.4). */
const driftedStreams = new Set<string>();

export const observeGlobalContentDrift = (stream: string): void => { driftedStreams.add(stream); };

/** An accepted complete save IS the heal, whatever composed it. */
export const noteCompleteSaveAccepted = (stream: string): void => { driftedStreams.delete(stream); };

/** Test seam: process-local drift would otherwise leak across cases. */
export const resetObservedDriftForTests = (): void => { driftedStreams.clear(); };

/** The only part of a loaded state a binding is derived from. */
export interface BindableSnapshot {
  stream: string;
  stateNonce?: string;
  stateRevision?: number;
}

/** What a source must establish for its base to be delta-eligible. */
export interface DeltaEligibility {
  baseIsUnscopedRemote?: boolean;
  /** A reset-provenance replacement rewrites the lineage's stream in the same
   * CAS, so its predecessor is not the base this delta would bind to. */
  replacesStream?: boolean;
}

/** Undefined means this save must carry a whole manifest: genesis, first save,
 * reset, repair, migration, scoped bases, a standing heal, the kill switch. */
export function deltaBindingFor(
  snapshot: BindableSnapshot,
  source: DeltaEligibility,
): DeltaBinding | undefined {
  if (!saveDeltaEnabled()) return undefined;
  if (source.baseIsUnscopedRemote !== true) return undefined;
  if (source.replacesStream === true) return undefined;
  if (driftedStreams.has(snapshot.stream)) return undefined;
  const nonce = snapshot.stateNonce;
  if (nonce === undefined || !/^[0-9a-f]{32}$/.test(nonce)) return undefined;
  if (snapshot.stateRevision === undefined) return undefined;
  return { nonce, stateRevision: snapshot.stateRevision };
}

const strictlyAscending = (files: readonly FileEntry[]): boolean => {
  for (let index = 1; index < files.length; index++) {
    if (files[index - 1]!.path >= files[index]!.path) return false;
  }
  return true;
};

/** Undefined when either side is not strictly ascending: the grammar's ordering
 * rule is a property of the inputs, never repaired silently here. */
export function composeGlobalDelta(
  previous: readonly FileEntry[],
  next: readonly FileEntry[],
  binding: DeltaBinding,
): GlobalDelta | undefined {
  if (!strictlyAscending(previous) || !strictlyAscending(next)) return undefined;
  const ops: DeltaOp[] = [];
  let left = 0;
  let right = 0;
  while (left < previous.length && right < next.length) {
    const before = previous[left]!;
    const after = next[right]!;
    if (before.path === after.path) {
      if (!isDeepStrictEqual(before, after)) ops.push({ kind: "upsert", entry: after });
      left++;
      right++;
    } else if (before.path < after.path) {
      ops.push({ kind: "delete", path: before.path });
      left++;
    } else {
      ops.push({ kind: "upsert", entry: after });
      right++;
    }
  }
  for (; left < previous.length; left++) ops.push({ kind: "delete", path: previous[left]!.path });
  for (; right < next.length; right++) ops.push({ kind: "upsert", entry: next[right]! });
  return { binding, ops };
}

/** The store's semantic, in one place: only named paths move, and a delete of
 * an absent path is a refusal rather than a silent no-op. */
export function applyDeltaOps(previous: readonly FileEntry[], ops: readonly DeltaOp[]): FileEntry[] {
  const result: FileEntry[] = [];
  let index = 0;
  let lastPath: string | undefined;
  for (const op of ops) {
    const path = op.kind === "upsert" ? op.entry.path : op.path;
    if (lastPath !== undefined && lastPath >= path) throw new TypeError(`delta op ${path} is not strictly after ${lastPath}`);
    lastPath = path;
    while (index < previous.length && previous[index]!.path < path) result.push(previous[index++]!);
    const matched = index < previous.length && previous[index]!.path === path;
    if (matched) index++;
    if (op.kind === "upsert") result.push(op.entry);
    else if (!matched) throw new TypeError(`delta deletes ${path}, which the predecessor does not hold`);
  }
  for (; index < previous.length; index++) result.push(previous[index]!);
  return result;
}
