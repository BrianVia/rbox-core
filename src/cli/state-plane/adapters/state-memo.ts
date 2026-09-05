/**
 * Design 277 §A: the loaded-state memo.
 *
 * `loadState` materializes every file and repository the workspace holds — the
 * dominant cost of a zero-change sync cycle at fleet scale. The store answers
 * "has anything changed?" from one lineage row: every accepted CAS bumps
 * `state_revision`, a reset replaces the lineage, and the one deliberately
 * non-CAS writer moves `telemetry_binding_id` (store/write-packet.ts). So a
 * state whose probed token still matches the store IS the state the store
 * holds, and materializing it again buys nothing.
 *
 * The memo therefore holds exactly one entry per workspace root and is only
 * ever consulted UNDER a token comparison read from the live database — it is a
 * skip rule for the projection, never a second source of truth.
 *
 * Callers share the returned object, which is safe only because nothing mutates
 * a loaded `SyncState` in place. That is a property of the CODE, not something
 * this module can enforce: the evidence is a sweep — `RBOX_STATE_FREEZE=1`
 * deep-freezes every state this module hands out, and the whole CLI suite is
 * run under it (design 277 validation). `state-memo.test.ts` pins the freeze
 * mechanism and a representative nested member; it does not, by itself, prove
 * the fleet-wide property.
 *
 * Kill switch: `RBOX_STATE_LOAD_CACHE=0` restores a materialization per load.
 * Deletion condition: two clean fleet weeks (docs/diagnostics.md).
 */
import type { FileEntry } from "../../../engine/index.js";
import type { SyncState } from "../../sync-state-model.js";
import { stateWasStreamMismatch } from "../reset-lineage.js";
import type { StateFreshnessToken } from "./read-only.js";

interface MemoEntry { token: StateFreshnessToken; state: SyncState }

const MEMO = new Map<string, MemoEntry>();

const stateMemoEnabled = (): boolean => process.env.RBOX_STATE_LOAD_CACHE !== "0";

function sameToken(left: StateFreshnessToken, right: StateFreshnessToken): boolean {
  return left.authorityId === right.authorityId
    && left.lineageId === right.lineageId
    && left.stream === right.stream
    && left.stateNonce === right.stateNonce
    && left.stateRevision === right.stateRevision
    && left.baseGeneration === right.baseGeneration
    && left.telemetryBindingId === right.telemetryBindingId;
}

/** The state this root last materialized, if the store still carries its token. */
export function memoizedState(root: string, token: StateFreshnessToken): SyncState | undefined {
  if (!stateMemoEnabled()) return undefined;
  const entry = MEMO.get(root);
  if (!entry || !sameToken(entry.token, token)) return undefined;
  // Defence in depth: retention refuses marked states, so this can only fire if
  // a state acquired its mark after being retained.
  if (stateWasStreamMismatch(entry.state)) {
    MEMO.delete(root);
    return undefined;
  }
  freezeForSweep(entry.state);
  return entry.state;
}

/**
 * Retain a state the store just returned or accepted, under its own token.
 *
 * A rebind/freshening state is never retained: `stateWasStreamMismatch` marks
 * the OBJECT, permanently, and the durable evidence behind that mark (the
 * reset-lineage archive) can disappear. Retaining a marked object would let
 * the mark outlive its evidence, so callers re-derive it per load instead.
 */
export function rememberState(root: string, token: StateFreshnessToken, state: SyncState): SyncState {
  if (!stateMemoEnabled() || stateWasStreamMismatch(state)) {
    MEMO.delete(root);
    return state;
  }
  freezeForSweep(state);
  MEMO.set(root, { token, state });
  return state;
}

/**
 * Design 277's aliasing precondition, enforceable on demand: two callers may
 * share one loaded state only because nothing in the CLI mutates one in place.
 * `RBOX_STATE_FREEZE=1` makes every retained state deeply immutable so a sweep
 * of the suites PROVES that rather than assuming it — the mutations worth
 * catching live in nested members (design 43/273's git sections, repo-record
 * deferrals, partial applies, receipts), not in the top-level containers.
 *
 * Cycle-safe by the frozen check, and never on in production: freezing is
 * O(state) and the property it checks is a property of the code.
 */
function freezeForSweep(state: SyncState): void {
  if (process.env.RBOX_STATE_FREEZE !== "1") return;
  const pending: unknown[] = [state];
  while (pending.length > 0) {
    const node = pending.pop();
    // Buffers and typed arrays are values here, and freezing one breaks the
    // consumers that write into it.
    if (!(node instanceof Object) || Object.isFrozen(node) || ArrayBuffer.isView(node)) continue;
    Object.freeze(node);
    for (const member of Object.values(node)) pending.push(member);
  }
}

/**
 * Design 302: the retained state's base file rows, reusable while the store's
 * lineage and base generation still match even though `state_revision` moved.
 * Only a global section advances `active_base_generation` (write-packet.ts), so
 * after a global-free save (every unchanged-workspace push) the rows are the
 * ones the store still holds; the caller re-reads everything else. Same skip-
 * rule discipline as the state memo: keyed by a token read from the live
 * lineage row, never a second source of truth, same kill switch.
 */
export function memoizedBaseFiles(root: string, token: StateFreshnessToken): { baseFiles: readonly FileEntry[] } | undefined {
  if (!stateMemoEnabled()) return undefined;
  const entry = MEMO.get(root);
  if (!entry || entry.token.lineageId !== token.lineageId || entry.token.stream !== token.stream
    || entry.token.baseGeneration !== token.baseGeneration) return undefined;
  return { baseFiles: entry.state.lastSyncedManifest.files };
}

/** Drop this root's retention — used where the lineage itself is replaced. */
export function forgetState(root: string): void {
  MEMO.delete(root);
}
