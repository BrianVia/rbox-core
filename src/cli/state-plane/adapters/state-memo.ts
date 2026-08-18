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
 * skip rule for the projection, never a second source of truth. Callers share
 * the returned object; nothing in the CLI mutates a loaded `SyncState` in place
 * (proved by the freeze sweep in `state-memo.test.ts`).
 *
 * Kill switch: `RBOX_STATE_LOAD_CACHE=0` restores a materialization per load.
 */
import type { SyncState } from "../../sync-state-model.js";
import { stateWasStreamMismatch } from "../reset-lineage.js";
import type { StateFreshnessToken } from "./read-only.js";

interface MemoEntry { token: StateFreshnessToken; state: SyncState }

const MEMO = new Map<string, MemoEntry>();

export const stateMemoEnabled = (): boolean => process.env.RBOX_STATE_LOAD_CACHE !== "0";

function sameToken(left: StateFreshnessToken, right: StateFreshnessToken): boolean {
  return left.authorityId === right.authorityId
    && left.lineageId === right.lineageId
    && left.stream === right.stream
    && left.stateNonce === right.stateNonce
    && left.stateRevision === right.stateRevision
    && left.telemetryBindingId === right.telemetryBindingId;
}

/** The state this root last materialized, if the store still carries its token. */
export function memoizedState(root: string, token: StateFreshnessToken): SyncState | undefined {
  if (!stateMemoEnabled()) return undefined;
  const entry = MEMO.get(root);
  if (!entry || !sameToken(entry.token, token)) return undefined;
  return entry.state;
}

/** Retain a state the store just returned or accepted, under its own token. A
 * rebind/freshening state is never retained: its provenance is carried by
 * object identity (`stateWasStreamMismatch`), which a later reader must
 * re-derive from durable evidence rather than inherit from a memo. */
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
 * `RBOX_STATE_FREEZE=1` turns every retained state immutable so a sweep of the
 * suites proves that rather than assuming it. Never on in production — freezing
 * is O(state) and the invariant it checks is a code property, not a runtime one.
 */
function freezeForSweep(state: SyncState): void {
  if (process.env.RBOX_STATE_FREEZE !== "1") return;
  const manifest = state.lastSyncedManifest;
  for (const entry of manifest.files) Object.freeze(entry);
  Object.freeze(manifest.files);
  for (const section of Object.values(manifest.gitRepos ?? {})) Object.freeze(section);
  Object.freeze(manifest.gitRepos);
  Object.freeze(manifest);
  for (const record of Object.values(state.repoRecords ?? {})) Object.freeze(record);
  Object.freeze(state.repoRecords);
  if (state.manifestMeta) {
    Object.freeze(state.manifestMeta.chain);
    Object.freeze(state.manifestMeta);
  }
  Object.freeze(state);
}

/** Drop this root's retention — used where the lineage itself is replaced. */
export function forgetState(root: string): void {
  MEMO.delete(root);
}
