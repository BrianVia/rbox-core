/**
 * The O(1) lineage reads (design 277). Both answer a question about the state
 * the store holds WITHOUT materializing every file and repository behind it:
 * the boundary fence compares two identity tokens, and the freshness probe asks
 * whether a state a caller already holds is still the state the store holds.
 *
 * Legacy JSON has no header to read cheaply, so identity falls back to its
 * ordinary raw read and freshness declines to answer at all — the probe is a
 * SQLite lineage row, and parity for a dying path is not worth a JSON token
 * scheme.
 */
import type { WorkspaceSyncMutex } from "../../sync-mutex.js";
import type { SyncState } from "../../sync-state-model.js";
import { recoverStandingResetJournal } from "../reset-lineage.js";
import { openAuthorityStore, selectAuthority, sqliteAuthority } from "./authority-open.js";
import type { StateFreshnessToken } from "./read-only.js";
import { loadRawLegacyJsonState } from "./legacy-json-store.js";

/** The lineage identity a boundary fence compares. `undefined` means no
 * authority is selected, exactly as a raw whole-state read reports it. */
export async function loadRawStateIdentity(root: string): Promise<Pick<SyncState, "stream" | "stateNonce"> | undefined> {
  const selection = await selectAuthority(root);
  if (selection.kind === "uninitialized") return undefined;
  if (selection.kind === "legacy-json-store") return loadRawLegacyJsonState(root);
  const { store, facade } = await openAuthorityStore(sqliteAuthority(root, selection), true);
  try {
    const token = facade.readStateFreshnessFromStore(store);
    return token.stateNonce === undefined ? { stream: token.stream } : { stream: token.stream, stateNonce: token.stateNonce };
  } finally {
    store.close();
  }
}

/**
 * Design 277 §A2: read the lineage tokens a caller compares against the state it
 * already holds. `undefined` means "no reuse is admissible" — an absent or
 * legacy authority, a stream this workspace no longer carries, or a reset
 * journal this call just recovered.
 *
 * Authority selection, genesis admission under a held mutex, and reset-journal
 * recovery run exactly as they do on the full load path.
 */
export async function probeStateFreshness(
  root: string,
  stream: string,
  heldMutex?: WorkspaceSyncMutex,
): Promise<StateFreshnessToken | undefined> {
  const selection = await selectAuthority(root, heldMutex);
  if (selection.kind !== "sqlite-store") return undefined;
  if (await recoverStandingResetJournal(root, stream, heldMutex)) return undefined;
  const { store, facade } = await openAuthorityStore(sqliteAuthority(root, selection), true);
  try {
    const token = facade.readStateFreshnessFromStore(store);
    return token.stream === stream ? token : undefined;
  } finally {
    store.close();
  }
}

/** Whether a held state still carries the store's probed tokens. */
export function stateMatchesFreshness(state: SyncState, token: StateFreshnessToken): boolean {
  return state.stream === token.stream
    && state.stateNonce === token.stateNonce
    && state.stateRevision === token.stateRevision
    && state.telemetryBindingId === token.telemetryBindingId;
}
