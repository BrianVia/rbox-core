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
import { acquireLock, type OwnedLock } from "../../../engine/lockfile.js";
import { assertProtocolLockHeld } from "../../../cli/sync-git/protocol-locks.js";
import { workspaceSyncMutexDegraded, type WorkspaceSyncMutex } from "../../sync-mutex.js";
import {
  repoRecordsForState,
  type StateSaveOptions,
  type StateSavePacket,
  type StateSaveResult,
  type SyncState,
} from "../../sync-state-model.js";
import {
  StateAuthorityCorruptError, StateStoreOpenError, StateWriteRefusedError, StreamMismatchError,
} from "../errors.js";
import { sqliteResetPaths, stateLockPath, statePath } from "../paths.js";
import { stableDbHash } from "../reset/artifacts.js";
import type { CasRejectionReason, CasResult } from "../ports.js";
import type { StateStoreHandle } from "../store/open.js";
import { casOwnerTokenFromLock } from "../store/owner-token.js";
import { markResetLineageProvenance, recoverStandingResetJournal, stateWasStreamMismatch } from "../reset-lineage.js";
import { inventoryResetNamespace } from "../../reset-namespace-inventory.js";
import {
  applyLegacyJsonSavePacket,
  ensureJsonTelemetryId,
  loadLegacyJsonState,
  loadRawLegacyJsonState,
  saveStateUnsafeLegacyOrTest,
  stateLockBusyDetail,
} from "./legacy-json-store.js";

/** `.rbox/state.json` carries `Q`, and this is the database it names. */
interface SqliteAuthority { authorityId: string; file: string }

type StoreFacade = typeof import("../store-facade.js");

const sqliteAuthority = (
  root: string,
  selection: { readonly authorityId: string },
): SqliteAuthority => ({ authorityId: selection.authorityId, file: sqliteResetPaths.active(root) });

function translateStoreOpenError<T>(file: string, read: () => T): T {
  try { return read(); } catch (error) {
    if (error instanceof StateStoreOpenError) throw new StateAuthorityCorruptError(file, `${error.reason}: ${error.message}`);
    throw error;
  }
}

async function selectAuthority(root: string, heldMutex?: WorkspaceSyncMutex) {
  const coordinator = await import("../authority-bootstrap.js");
  return heldMutex && !workspaceSyncMutexDegraded(heldMutex)
    ? coordinator.admitGenesisAuthority(root, heldMutex)
    : coordinator.selectStateAuthority(root);
}

async function openAuthorityStore(authority: SqliteAuthority, readonly: boolean): Promise<{ store: StateStoreHandle; facade: StoreFacade }> {
  const facade = await import("../store-facade.js");
  // Absent, foreign, malformed, or the wrong schema are all zero-write
  // authority contradictions rather than backend-specific open failures.
  const store = translateStoreOpenError(authority.file, () => facade.openStateStore(authority.file, { readonly }));
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
  const selection = await selectAuthority(root);
  if (selection.kind === "legacy-json-store") return loadRawLegacyJsonState(root);
  const authority = sqliteAuthority(root, selection);
  const { store, facade } = await openAuthorityStore(authority, true);
  try {
    return facade.loadRawStateFromStore(store);
  } finally {
    store.close();
  }
}

export async function selectedStateForResetConsent(root: string): Promise<Pick<SyncState, "stream" | "stateNonce" | "stateRevision"> | undefined> {
  const selection = await selectAuthority(root);
  if (selection.kind === "legacy-json-store") return loadRawLegacyJsonState(root);
  const facade = await import("../store-facade.js");
  const file = sqliteResetPaths.active(root);
  const lineage = translateStoreOpenError(file, () => facade.readImmutableStoreLineage(file));
  if (lineage.authorityId !== selection.authorityId) throw new StateAuthorityCorruptError(statePath(root),
    "the immutable reset-consent snapshot has the wrong authority");
  return lineage;
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
  const selection = await selectAuthority(root, heldMutex);
  if (selection.kind === "legacy-json-store") return loadLegacyJsonState(root, stream, warningSink, heldMutex);
  const authority = sqliteAuthority(root, selection);
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

/** Establish the first durable state nonce through the selected backend's
 * ordinary CAS. Existing JSON remains legacy-untrusted; a genesis SQLite store
 * is already authoritative and may initialize its empty global record. */
export async function ensureCapableStateLineage(root: string, state: SyncState): Promise<SyncState> {
  if (/^[0-9a-f]{32}$/.test(state.stateNonce ?? "")) return state;
  const selection = await selectAuthority(root);
  if (selection.kind === "legacy-json-store" && await loadRawLegacyJsonState(root)) return state;
  const records = repoRecordsForState(state);
  const manifestGit = state.lastSyncedManifest.gitRepos;
  if (state.lastSyncedSequence !== 0 || state.lastSyncedManifest.files.length !== 0
    || Object.keys(records).length !== 0 || Object.keys(manifestGit ?? {}).length !== 0
    || Object.keys(state.gitPendingRemote ?? {}).length !== 0
    || Object.keys(state.gitReposRemoved ?? {}).length !== 0) {
    throw new Error("refusing to manufacture a capable lineage over non-genesis sync state");
  }
  const result = await applyStateSavePacket(root, {
    expectedStream: state.stream ?? "",
    expectedNonce: "legacy",
    sourceGlobalSeq: 0,
    repos: [],
  });
  if (result.status === "accepted") return result.state;
  if (result.status === "rejected" && (result.reason === "nonce" || result.reason === "repo-generation")) {
    const raced = await loadRawState(root);
    if (raced && raced.stream === state.stream && /^[0-9a-f]{32}$/.test(raced.stateNonce ?? "")) return raced;
  }
  throw new Error(`capable state-lineage initialization failed (${result.status}${"reason" in result ? `:${result.reason}` : ""})`);
}

/** Mint or reuse the telemetry identity through the authority selected from the
 * state marker. SQLite uses the same state lock and owner capability as its CAS
 * writer; JSON keeps its existing physical implementation byte-for-byte. */
export async function ensureTelemetryBindingId(
  root: string,
  expectedStream: string,
  randomBytes?: (size: number) => Buffer,
): Promise<{ state: SyncState; bindingId: string }> {
  if ((await selectAuthority(root)).kind === "legacy-json-store") {
    return ensureJsonTelemetryId(root, expectedStream, randomBytes);
  }

  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") {
    throw new Error(`sync state telemetry lock unavailable (${stateLockBusyDetail(acquired)})`);
  }
  try {
    if (!acquired.lock.isOwnerSync()) throw new Error("sync state telemetry lock ownership was lost");
    const coordinator = await import("../authority-bootstrap.js");
    coordinator.assertAuthorityWritable(root);
    const selection = await coordinator.selectStateAuthority(root);
    if (selection.kind === "legacy-json-store") {
      throw new StateAuthorityCorruptError(statePath(root), "the authority marker disappeared under the held state lock");
    }
    const authority = sqliteAuthority(root, selection);
    const { store, facade } = await openAuthorityStore(authority, false);
    try {
      const bindingId = facade.ensureStoreTelemetryBindingId(
        store,
        expectedStream,
        casOwnerTokenFromLock(acquired.lock),
        randomBytes,
      );
      return { state: facade.loadRawStateFromStore(store), bindingId };
    } finally {
      store.close();
    }
  } finally {
    await acquired.lock.release();
  }
}

/** Apply one generation-CAS packet under `<state>.lock`. Rejection is
 * whole-packet on both backends. */
export async function applyStateSavePacket(
  root: string,
  packet: StateSavePacket,
  options: StateSaveOptions = {},
): Promise<StateSaveResult> {
  if ((await selectAuthority(root)).kind === "legacy-json-store") {
    return applyLegacyJsonSavePacket(root, packet, options);
  }
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
    if (acquired.status === "unsupported") {
      return {
        status: "unsupported",
        error: new StateWriteRefusedError(
          "state-lock-unavailable",
          statePath(root),
          String(acquired.error),
        ),
      };
    }
    if (acquired.status === "error") return { status: "busy", detail: String(acquired.error) };
    if (acquired.status === "held") return { status: "busy", detail: stateLockBusyDetail(acquired) };
    lock = acquired.lock;
    releaseLock = true;
  }
  try {
    if (!lock.isOwnerSync()) return { status: "busy", detail: "state lock ownership was lost" };
    // The state-plane write fence, once per save, under the held state lock.
    // A-2 holds no opinion about migration or genesis: the coordinator owns the
    // predicate and is the only module allowed to import both domains (§7.9).
    const coordinator = await import("../authority-bootstrap.js");
    coordinator.assertAuthorityWritable(root);
    // Re-selected under the lock: the pre-lock selection only routed, and the
    // authority may have flipped while this save waited for the lock. This is
    // the SQLite analogue of the JSON path's pre-rename `assertStatePublishable`.
    const selection = await coordinator.selectStateAuthority(root);
    if (selection.kind === "legacy-json-store") {
      throw new StateAuthorityCorruptError(statePath(root), "the authority marker disappeared under the held state lock");
    }
    const authority = sqliteAuthority(root, selection);
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

/** Complete the already-authorized reset-lineage stream replacement through the
 * selected authority. JSON retains its historical whole-document projection;
 * SQLite changes the stream and applies the packet in one transaction. */
export async function replaceResetLineageStream(
  root: string,
  authorizedSnapshot: SyncState,
  rejectedState: SyncState,
  packet: StateSavePacket,
  acceptedProjection: SyncState,
  legacyReplacement: SyncState,
): Promise<SyncState> {
  if (!stateWasStreamMismatch(authorizedSnapshot) || authorizedSnapshot.lastSyncedSequence !== 0) {
    throw new Error("sync state stream replacement lacks reset provenance");
  }
  if (packet.expectedStream !== authorizedSnapshot.stream
    || packet.expectedNonce !== authorizedSnapshot.stateNonce) {
    throw new Error("sync state stream replacement packet is not bound to the authorized snapshot");
  }
  if ((await selectAuthority(root)).kind === "legacy-json-store") {
    await saveStateUnsafeLegacyOrTest(root, legacyReplacement);
    return legacyReplacement;
  }

  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") {
    throw new StateWriteRefusedError("state-lock-unavailable", statePath(root), acquired.status === "held" ? stateLockBusyDetail(acquired) : String(acquired.error));
  }
  try {
    if (!acquired.lock.isOwnerSync()) {
      throw new StateWriteRefusedError("state-lock-lease-lost", statePath(root));
    }
    const coordinator = await import("../authority-bootstrap.js");
    coordinator.assertAuthorityWritable(root);
    const selection = await coordinator.selectStateAuthority(root);
    if (selection.kind === "legacy-json-store") throw new StateAuthorityCorruptError(statePath(root), "the authority marker disappeared under the held state lock");
    const inventory = await inventoryResetNamespace(root);
    let exactResetArchive = false;
    for (const archive of inventory.archives) {
      if (archive.main !== "regular" || archive.sidecarVector !== "S0" || archive.stateSha256 === undefined) continue;
      if ((await stableDbHash(archive.path)).sha256 === archive.stateSha256) {
        exactResetArchive = true;
        break;
      }
    }
    if (!exactResetArchive) {
      throw new Error("sync state stream replacement lacks an exact SQLite reset archive");
    }
    const authority = sqliteAuthority(root, selection);
    const { store, facade } = await openAuthorityStore(authority, false);
    try {
      // Authorized-replacement L4 contract: the tuple must be re-read after the
      // canonical lock is held. The lineage table is sufficient; projecting all
      // files and repositories here would add no stronger mutation authority.
      const live = facade.readReplacementLineage(store);
      if (live.stream !== rejectedState.stream
        || live.stateNonce !== rejectedState.stateNonce
        || live.stateRevision !== rejectedState.stateRevision
        || live.lastSyncedSequence !== 0
        || live.stateNonce !== packet.expectedNonce) {
        throw new Error("sync state stream replacement lineage changed under the canonical lock");
      }
      const result = await facade.replaceStreamAndApplySavePacketToStore(
        store, packet, rejectedState.stream!, casOwnerTokenFromLock(acquired.lock),
      );
      if (result.status === "accepted") {
        // Accepted-result contract: combine the CAS token with the caller's
        // already-composed projection; do not walk the DB after mutation.
        return facade.projectAcceptedSavePacket(acceptedProjection, result.token);
      }
      if (result.status === "rejected") {
        try {
          throw new Error(`sync state changed during authorized replacement (${LEGACY_REJECTION_REASON[result.reason]})`);
        } finally {
          result.retry.close();
        }
      }
      if (result.status === "busy") throw new Error(`sync state busy (${result.detail})`);
      throw result.error;
    } finally {
      store.close();
    }
  } finally {
    await acquired.lock.release();
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
export const LEGACY_REJECTION_REASON = {
  lineage: "nonce", stream: "stream", nonce: "nonce",
  "state-revision": "nonce", "base-generation": "global-sequence", "local-revision": "nonce",
  "repo-generation": "repo-generation", "global-sequence": "global-sequence", "owner-lost": "owner-lost",
} satisfies Record<CasRejectionReason, LegacyRejectionReason>;

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
