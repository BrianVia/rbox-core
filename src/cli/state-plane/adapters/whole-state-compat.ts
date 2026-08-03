/**
 * The whole-state compatibility adapter — A-2 (design 222 §1.2, design 163 U3).
 *
 * One selector sits between every whole-state caller and the two backends. It
 * decides which one is authority from the bytes at `.rbox/state.json`, keeps
 * every caller signature, and translates the store's raw `CasResult` into the
 * `StateSaveResult` the JSON CAS has always returned. Reads stay whole; writes
 * go native once `Q` is authority.
 *
 * It is INERT until M6 renames `Q` over the state document: with legacy JSON at
 * that path every call delegates to the JSON store unchanged, and the SQLite
 * half is not even loaded. That is also why the store is reached through a
 * dynamic import: the CLI's eager static graph must stay free of `bun:sqlite`
 * (`schema/inventory.test.ts`), and the same lazy-dispatch shape reset uses
 * (`reset-journal.ts`) is what keeps it that way.
 *
 * NOTHING HERE OPENS A DATABASE IT HAS NOT PROVEN IT OWNS (163 v13). Selection
 * and every refusal are decided from file-level facts — the marker's exact
 * bytes and the SQLite header `store/open.ts` reads before connecting — so a
 * workspace this adapter refuses is byte-identical afterwards, sidecars
 * included.
 */
import path from "node:path";
import { acquireLock, type OwnedLock } from "../../../engine/git/lockfile.js";
import { assertProtocolLockHeld } from "../../../engine/git/protocol-locks.js";
import type { WorkspaceSyncMutex } from "../../sync-mutex.js";
import type {
  StateSaveOptions, StateSavePacket, StateSaveResult, SyncState,
} from "../../sync-state-model.js";
import { classifyStateFormat, readAuthorityMarkerId } from "../authority-marker.js";
import {
  StateAuthorityCorruptError, StateStoreOpenError, StreamMismatchError,
} from "../errors.js";
import { sqliteResetPaths, stateLockPath, statePath } from "../paths.js";
import type { CasRejectionReason, CasResult } from "../ports.js";
import type { StateStoreHandle } from "../store/open.js";
import { casOwnerTokenFromLock } from "../store/owner-token.js";
import { markResetLineageProvenance, recoverStandingResetJournal } from "../reset-lineage.js";
import {
  applyLegacyJsonSavePacket,
  loadLegacyJsonState,
  loadRawLegacyJsonState,
  stateLockBusyDetail,
} from "./legacy-json-store.js";

/** `.rbox/state.json` carries `Q`, and this is the database it names. */
interface SqliteAuthority {
  authorityId: string;
  file: string;
}

type StoreFacade = typeof import("../store-facade.js");

/**
 * The one selection, from the state document's bytes. `undefined` means the
 * legacy JSON store is authority — which includes `absent` and `foreign`, whose
 * meanings the JSON store already owns.
 */
async function selectSqliteAuthority(root: string): Promise<SqliteAuthority | undefined> {
  if (await classifyStateFormat(statePath(root)) !== "authority-marker") return undefined;
  const authorityId = await readAuthorityMarkerId(statePath(root));
  if (authorityId === undefined) {
    throw new StateAuthorityCorruptError(statePath(root), "the authority marker changed while it was being read");
  }
  return { authorityId, file: sqliteResetPaths.active(root) };
}

async function openAuthorityStore(
  authority: SqliteAuthority,
  readonly: boolean,
): Promise<{ store: StateStoreHandle; facade: StoreFacade }> {
  const facade = await import("../store-facade.js");
  let store: StateStoreHandle;
  try {
    store = facade.openStateStore(authority.file, { readonly });
  } catch (error) {
    // Absent, not a database, foreign, or the wrong schema — all decided from
    // the header bytes before any connection, so this refusal wrote nothing.
    if (error instanceof StateStoreOpenError) {
      throw new StateAuthorityCorruptError(authority.file, `${error.reason}: ${error.message}`);
    }
    throw error;
  }
  if (store.header.authority_id !== authority.authorityId) {
    store.close();
    throw new StateAuthorityCorruptError(
      authority.file,
      `the database carries authority ${store.header.authority_id}, the marker names ${authority.authorityId}`,
    );
  }
  return { store, facade };
}

/** Raw state load for the transactional writer. Never manufactures a baseline
 * on either backend: under `Q` an unreadable authority is corruption, not a
 * first run. */
export async function loadRawState(root: string): Promise<SyncState | undefined> {
  const authority = await selectSqliteAuthority(root);
  if (!authority) return loadRawLegacyJsonState(root);
  const { store, facade } = await openAuthorityStore(authority, true);
  try {
    return facade.loadRawStateFromStore(store);
  } finally {
    store.close();
  }
}

/**
 * Load the sync state (the reconcile base). Both backends recover a standing
 * reset journal first, refuse a different stream with the same typed
 * `StreamMismatchError`, and carry the same reset-lineage provenance.
 *
 * `warningSink` is consumed by the JSON backend's own read path; the store has
 * no lenient decode to warn about.
 */
export async function loadState(
  root: string,
  stream: string,
  warningSink: (line: string) => void = console.error,
  heldMutex?: WorkspaceSyncMutex,
): Promise<SyncState> {
  const authority = await selectSqliteAuthority(root);
  if (!authority) return loadLegacyJsonState(root, stream, warningSink, heldMutex);
  // Recovery cannot change the answer above: a standing reset under `Q` is
  // recovered by the SQLite reset plane, which republishes `Q`.
  await recoverStandingResetJournal(root, stream, heldMutex);
  const { store, facade } = await openAuthorityStore(authority, true);
  let state: SyncState;
  try {
    state = facade.loadRawStateFromStore(store);
  } finally {
    store.close();
  }
  if (state.stream !== stream) throw new StreamMismatchError(root, stream, state.stream ?? "", "state");
  return markResetLineageProvenance(root, state);
}

/** Apply one generation-CAS packet under `<state>.lock`. Rejection is
 * whole-packet on both backends. */
export async function applyStateSavePacket(
  root: string,
  packet: StateSavePacket,
  options: StateSaveOptions = {},
): Promise<StateSaveResult> {
  if (!await selectSqliteAuthority(root)) return applyLegacyJsonSavePacket(root, packet, options);
  return saveThroughStore(root, packet, options);
}

async function saveThroughStore(
  root: string,
  packet: StateSavePacket,
  options: StateSaveOptions,
): Promise<StateSaveResult> {
  let lock: OwnedLock;
  let releaseLock = false;
  if (options.heldLock) {
    assertProtocolLockHeld("state", path.resolve(statePath(root)));
    if (path.resolve(options.heldLock.path) !== path.resolve(stateLockPath(root))) {
      throw new Error("held state lock does not match the workspace state path");
    }
    lock = options.heldLock;
  } else {
    const acquired = await acquireLock(stateLockPath(root), options.lock);
    if (acquired.status === "unsupported") return { status: "unsupported", error: acquired.error };
    if (acquired.status === "error") return { status: "busy", detail: String(acquired.error) };
    if (acquired.status === "held") return { status: "busy", detail: stateLockBusyDetail(acquired) };
    lock = acquired.lock;
    releaseLock = true;
  }
  try {
    // The state-plane write fence, once per save, under the held state lock.
    // A-2 holds no opinion about migration or genesis: the coordinator owns the
    // predicate and is the only module allowed to import both domains (§7.9).
    const { assertAuthorityWritable } = await import("../authority-bootstrap.js");
    assertAuthorityWritable(root);
    // Re-selected under the lock: the pre-lock selection only routed, and the
    // authority may have flipped while this save waited for the lock. This is
    // the SQLite analogue of the JSON path's pre-rename `assertStatePublishable`.
    const authority = await selectSqliteAuthority(root);
    if (!authority) {
      throw new StateAuthorityCorruptError(statePath(root), "the authority marker disappeared under the held state lock");
    }
    const { store, facade } = await openAuthorityStore(authority, false);
    try {
      return translateCasResult(await facade.applySavePacketToStore(store, packet, casOwnerTokenFromLock(lock)), store, facade);
    } finally {
      store.close();
    }
  } finally {
    if (releaseLock) await lock.release();
  }
}

type LegacyRejectionReason = Extract<StateSaveResult, { status: "rejected" }>["reason"];

/**
 * Exhaustive by construction: a new `CasRejectionReason` fails to compile here
 * rather than reaching a caller as an unhandled reason, and `StateSaveResult`
 * is not widened to carry the store's finer vocabulary.
 *
 * Only five of these are reachable from a caller's packet. A-1 binds
 * `lineageId`, `stateRevision`, `baseGeneration`, and `localRevision` from the
 * live token rather than from the packet, so their rejections describe a store
 * that moved under the held state lock — a stale snapshot, which is what the
 * JSON vocabulary calls a nonce (identity) or global-sequence (base plane)
 * mismatch. Exported so every row — including the four a test cannot reach
 * through the CAS — is pinned rather than merely compiled.
 */
export const LEGACY_REJECTION_REASON: Record<CasRejectionReason, LegacyRejectionReason> = {
  lineage: "nonce",
  stream: "stream",
  nonce: "nonce",
  "state-revision": "nonce",
  "base-generation": "global-sequence",
  "local-revision": "nonce",
  "repo-generation": "repo-generation",
  "global-sequence": "global-sequence",
  "owner-lost": "owner-lost",
};

function translateCasResult(result: CasResult, store: StateStoreHandle, facade: StoreFacade): StateSaveResult {
  switch (result.status) {
    case "accepted":
      return { status: "accepted", state: facade.loadRawStateFromStore(store) };
    case "rejected":
      try {
        // The state a caller recomputes against is the authority the rejection
        // was decided against: a rejected CAS wrote nothing, and this read runs
        // on the same connection under the same still-held state lock.
        return {
          status: "rejected",
          reason: LEGACY_REJECTION_REASON[result.reason],
          state: facade.loadRawStateFromStore(store),
        };
      } finally {
        result.retry.close();
      }
    case "busy":
      return result;
    case "unsupported":
      return result;
  }
}
