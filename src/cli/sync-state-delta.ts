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
import type { DeltaBinding, DeltaOp, GlobalDelta, SyncState } from "./sync-state-model.js";

/** Kill switch, default ON; deletion condition is one clean fleet soak plus the
 * Mac field close-out. */
export const saveDeltaEnabled = (): boolean => process.env.RBOX_SAVE_DELTA !== "0";

/** Process-local heal flag (§2.4). The idle-cycle audit is the only detector of
 * base drift, so a save composed while drift is standing must be a COMPLETE
 * save — the sole repair authority. Lost on restart and re-derived by the next
 * audit, exactly like the observation that set it. */
let forceCompleteSave = false;

export const observeGlobalContentDrift = (): void => { forceCompleteSave = true; };

export const forceCompleteSaveStanding = (): boolean => forceCompleteSave;

/** An accepted complete save IS the heal, whatever composed it. */
export const noteCompleteSaveAccepted = (): void => { forceCompleteSave = false; };

/** Test seam: a process-local flag would otherwise leak across cases. */
export const resetForceCompleteSaveForTests = (): void => { forceCompleteSave = false; };

/**
 * The predecessor a delta may bind to, or `undefined` when this save must carry
 * a whole manifest. Genesis, first save, reset, repair, migration, scoped bases,
 * a standing drift heal, and the kill switch all land here.
 */
export function deltaBindingFor(
  snapshot: SyncState,
  source: { baseIsUnscopedRemote?: boolean; forceCompleteSave?: true },
): DeltaBinding | undefined {
  if (!saveDeltaEnabled()) return undefined;
  if (source.baseIsUnscopedRemote !== true) return undefined;
  if (source.forceCompleteSave === true || forceCompleteSaveStanding()) return undefined;
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

/**
 * The one merge walk. Returns `undefined` when either side is not strictly
 * ascending by path — the delta grammar's ordering rule is a property of the
 * inputs, never something this composer repairs silently.
 */
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

/**
 * The reference semantic of `stage-delta-v1`'s ops, in the same shape the store
 * applies them: only named paths move, and a delete of an absent path is a
 * refusal rather than a silent no-op.
 */
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
