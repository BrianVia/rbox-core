import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { GitSection, Manifest } from "../../../engine/index.js";
import { fsyncDirectory, writeFileAtomic } from "../../../engine/fsutil.js";
import { acquireLock, type OwnedLock } from "../../../engine/git/lockfile.js";
import { assertProtocolLockHeld } from "../../../engine/git/protocol-locks.js";
import { sanitizeGitSectionForPersistence } from "../../../engine/git/config-sync.js";
import { composeRepoBase } from "../../sync-git/base-composer.js";
import { requireRepoBaseProof } from "../../sync-git/base-proof-selection.js";
import { isLegacyBaseAdoption } from "../migration/base-proof.js";
import {
  acquireWorkspaceSyncMutex,
  assertSyncMutex,
  releaseWorkspaceSyncMutex,
  workspaceSyncMutexDegraded,
  type WorkspaceSyncMutex,
} from "../../sync-mutex.js";
import { BINDING_ID_RE } from "../../telemetry/contract.js";
import { readResetJournal, recoverResetJournal } from "../../reset-journal.js";
import { boundedJsonRead } from "../../reset-io.js";
import {
  afterStatePublication,
  assertStatePublishable,
  assertStateReadable,
  publishWholeState,
  StreamMismatchError,
  StateWriteRefusedError,
} from "../index.js";
import { RBOX_DIR } from "../../workspace-config.js";
import { statePath, stateLockPath, stateIncarnationPath } from "../paths.js";
import {
  expectedStateNonce,
  normalizeStateCounter,
  repoRecordsForState,
  stateFromRepoRecords,
  stripObsoleteResolutionIntents,
  type RepoRecord,
  type StateSaveOptions,
  type StateSavePacket,
  type StateSaveResult,
  type SyncState,
} from "../../sync-state-model.js";

function isENOENT(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

const EMPTY_MANIFEST: Manifest = { generatedAt: "", files: [] };

const freshState = (stream: string): SyncState => ({ stream, lastSyncedSequence: 0, lastSyncedManifest: EMPTY_MANIFEST });
const streamMismatchFreshStates = new WeakSet<SyncState>();
export const stateWasStreamMismatch = (state: SyncState): boolean => streamMismatchFreshStates.has(state);
export { StreamMismatchError };

/**
 * Read-path provenance is deliberately tolerant of unrelated legacy-directory
 * entries. Reset operations use the strict namespace inventory; ordinary
 * loadState has always ignored names it does not understand.
 */
async function hasResetLineageArchive(root: string): Promise<boolean> {
  const archiveRoot = path.join(root, RBOX_DIR, "state", "lineages");
  const lineages = await fs.readdir(archiveRoot, { withFileTypes: true }).catch((error) => {
    if (isENOENT(error)) return [];
    throw error;
  });
  for (const lineage of lineages) {
    if (!lineage.isDirectory() || !/^[0-9a-f]{32}$/.test(lineage.name)) continue;
    const archives = await fs.readdir(path.join(archiveRoot, lineage.name), { withFileTypes: true }).catch((error) => {
      if (isENOENT(error)) return [];
      throw error;
    });
    if (archives.some((entry) =>
      entry.isFile() && /^[0-9a-f]{64}\.(?:json|db)$/.test(entry.name)
    )) return true;
  }
  return false;
}

/** Raw state load for the transactional writer. Unlike loadState, this never
 * hides a stream mismatch by manufacturing a fresh baseline. */
export async function loadRawState(root: string): Promise<SyncState | undefined> {
  await assertStateReadable(statePath(root));
  const state = await boundedJsonRead<SyncState>(statePath(root));
  if (state) return stripObsoleteResolutionIntents(state);
  const marker = await boundedJsonRead<{
    stream?: unknown; stateNonce?: unknown; stateRevision?: unknown;
  }>(stateIncarnationPath(root), 512 * 1024);
  if (!marker) return undefined;
  if (typeof marker.stream === "string" && typeof marker.stateNonce === "string") {
    return {
      ...freshState(marker.stream),
      stateNonce: marker.stateNonce,
      stateRevision: normalizeStateCounter(marker.stateRevision),
      repoRecords: {},
    };
  }
  throw new Error(`Corrupt sync state incarnation at ${stateIncarnationPath(root)}`);
}

function packetNonceMatches(expected: string, actual: string | undefined): boolean {
  return expected === "legacy" ? actual === undefined : expected === actual;
}

export function stateLockBusyDetail(result: Exclude<Awaited<ReturnType<typeof acquireLock>>, { status: "acquired" }>): string {
  if (result.status !== "held") return result.status;
  const inspection = result.inspection;
  if (inspection.kind === "live" || inspection.kind === "dead") return `pid ${inspection.marker.pid}`;
  return inspection.reason;
}

/** Apply one generation-CAS packet under `<state>.lock`. Rejection is whole-packet:
 * no global or per-repo member lands unless every precondition succeeds. */
export async function applyStateSavePacket(root: string, packet: StateSavePacket, options: StateSaveOptions = {}): Promise<StateSaveResult> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
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
    const raw = await loadRawState(root);
    const loaded = raw ?? freshState(packet.expectedStream);
    // A pre-stream legacy state is adopted by its first transactional save, just
    // as loadState has always adopted it in memory. The legacy nonce sentinel and
    // state lock make this a one-time fenced migration; an explicitly different
    // stream still rejects the whole packet.
    if (loaded.stream !== undefined && loaded.stream !== packet.expectedStream) {
      return { status: "rejected", reason: "stream", state: loaded };
    }
    const current = loaded.stream === undefined ? { ...loaded, stream: packet.expectedStream } : loaded;
    if (!packetNonceMatches(packet.expectedNonce, current.stateNonce)) return { status: "rejected", reason: "nonce", state: current };
    if (packet.global && packet.sourceGlobalSeq < current.lastSyncedSequence) {
      return { status: "rejected", reason: "global-sequence", state: current };
    }

    const records = repoRecordsForState(current);
    // Only the confined legacy published-checkout recovery may install blanket
    // authority; everything else is refused by requireRepoBaseProof below.
    const permitBlanket = isLegacyBaseAdoption(options.legacyBaseAdoption);
    for (const transition of packet.repos) {
      if ((records[transition.relPath]?.repoGen ?? 0) !== transition.expectedRepoGen) {
        return { status: "rejected", reason: "repo-generation", state: current };
      }
    }
    for (const transition of packet.repos) {
      const previous = records[transition.relPath] ?? { repoGen: 0, sourceSeq: 0 };
      const sanitizedPreviousBase = previous.base === undefined ? undefined : sanitizeGitSectionForPersistence(previous.base);
      const sanitizedCandidateBase = transition.newRecord.base === undefined
        ? undefined
        : sanitizeGitSectionForPersistence(transition.newRecord.base);
      const previousValue = { base: sanitizedPreviousBase, branchBaseOrigins: previous.branchBaseOrigins };
      const candidateValue = { base: sanitizedCandidateBase, branchBaseOrigins: transition.newRecord.branchBaseOrigins };
      const proof = requireRepoBaseProof(transition.relPath, transition.baseProof, previousValue, candidateValue, permitBlanket);
      const composed = composeRepoBase(
        previousValue,
        candidateValue,
        proof.authority,
        proof.lockedProof,
      );
      const newRecord = {
        ...transition.newRecord,
        ...(transition.newRecord.pending === undefined
          ? {}
          : { pending: sanitizeGitSectionForPersistence(transition.newRecord.pending) }),
      };
      if (composed.base === undefined) delete newRecord.base; else newRecord.base = composed.base;
      if (composed.branchBaseOrigins === undefined) delete newRecord.branchBaseOrigins;
      else newRecord.branchBaseOrigins = composed.branchBaseOrigins;
      if (composed.disposition === "pending" && sanitizedCandidateBase && newRecord.pending === undefined) {
        newRecord.pending = sanitizedCandidateBase;
      }
      records[transition.relPath] = { ...newRecord, repoGen: transition.expectedRepoGen + 1 };
    }

    const global = packet.global?.manifest;
    const base: SyncState = global
      ? {
          ...current,
          lastSyncedSequence: packet.sourceGlobalSeq,
          lastSyncedManifest: { ...global, gitRepos: undefined },
          manifestMeta: packet.global?.manifestMeta,
        }
      : current;
    // A state save rewrites the complete record file, so sanitize every carried
    // P/BASE too—not only records named by this packet. This makes sanitation a
    // persistence invariant across collision, exception, recovery, and CAS-retry
    // paths instead of an apply-path tendency.
    for (const [relPath, record] of Object.entries(records)) {
      const base = record.base === undefined ? undefined : sanitizeGitSectionForPersistence(record.base);
      const pending = record.pending === undefined ? undefined : sanitizeGitSectionForPersistence(record.pending);
      if (base === record.base && pending === record.pending) continue;
      records[relPath] = {
        ...record,
        ...(base === undefined ? {} : { base }),
        ...(pending === undefined ? {} : { pending }),
      };
    }
    const next = stateFromRepoRecords({
      ...base,
      stateNonce: current.stateNonce ?? crypto.randomBytes(16).toString("hex"),
      stateRevision: normalizeStateCounter(current.stateRevision) + 1,
    }, records);
    let owner = true;
    const body = JSON.stringify(next, null, 2);
    await writeFileAtomic(statePath(root), body, {
      beforeRename: async () => {
        await assertStatePublishable(statePath(root), { locked: true });
        return (owner = await lock.isOwner());
      },
    });
    if (!owner) return { status: "rejected", reason: "owner-lost", state: current };
    // writeFileAtomic syncs the temp's BYTES, but the rename that publishes them
    // as state.json is only durable once state.json's OWN parent is flushed — a
    // different directory from the incarnation marker's. Flush it before retiring
    // the marker, so no crash window can leave the marker's removal durable while
    // the state it was superseded by is not: that loses both the new state and the
    // fallback baseline after an accepted save.
    await fsyncDirectory(path.dirname(statePath(root)));
    const markerExisted = await fs.lstat(stateIncarnationPath(root)).then(() => true, (error) => {
      if (isENOENT(error)) return false;
      throw error;
    });
    await fs.rm(stateIncarnationPath(root), { force: true });
    // …and this publishes that unlink in the marker's own parent.
    if (markerExisted) await fsyncDirectory(path.dirname(stateIncarnationPath(root)));
    // Last, so nothing about the witness sits inside the marker-retirement crash
    // window: the witness is diagnostic evidence, never durability ordering.
    await afterStatePublication(root, statePath(root), next.stream, body);
    return { status: "accepted", state: next };
  } finally {
    if (releaseLock) await lock.release();
  }
}

/**
 * Establish the durable lineage boundary before a first Git mutation. Only a
 * physically absent, semantically empty state may be initialized here; an
 * existing legacy baseline remains legacy-untrusted and must be migrated by an
 * explicit confirmed workflow. The empty packet uses the ordinary state CAS,
 * so concurrent initialization chooses exactly one nonce.
 */
export async function ensureCapableStateLineage(root: string, state: SyncState): Promise<SyncState> {
  if (/^[0-9a-f]{32}$/.test(state.stateNonce ?? "")) return state;
  const existing = await loadRawState(root);
  if (existing) return state;
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

/**
 * Load the sync state (the reconcile base) for `workspaceId`. A MISSING file is
 * the expected first-run case → empty base. A CORRUPT file is NOT silently treated
 * as empty: resetting the base to empty would make the next reconcile see every
 * remote file as "new" and every local file as conflicting — a destructive
 * surprise. We refuse and surface it instead.
 *
 * A baseline stamped with a DIFFERENT stream (see {@link syncStreamId}) describes
 * another manifest stream and is never reset by this read API. Every caller gets
 * a typed refusal; only setup's confirmed reset path may replace the lineage. A
 * legacy state file with no stamp is adopted as-is (it predates the stamp; every
 * save since writes one).
 */
export async function loadState(
  root: string,
  stream: string,
  warningSink: (line: string) => void = console.error,
  heldMutex?: WorkspaceSyncMutex,
): Promise<SyncState> {
  if (await readResetJournal(root)) {
    let recoveryMutex = heldMutex;
    let releaseRecoveryMutex = false;
    if (!recoveryMutex) {
      recoveryMutex = await acquireWorkspaceSyncMutex(root, "cli");
      releaseRecoveryMutex = true;
    }
    assertSyncMutex(recoveryMutex, root);
    if (workspaceSyncMutexDegraded(recoveryMutex)) throw new Error("reset journal recovery requires a non-degraded workspace fence");
    try {
      await recoverResetJournal(root, stream);
    } finally {
      if (releaseRecoveryMutex) await releaseWorkspaceSyncMutex(recoveryMutex);
    }
  }
  const fresh = freshState(stream);
  const activePresent = await fs.lstat(statePath(root)).then(() => true, (error) => {
    if (isENOENT(error)) return false;
    throw error;
  });
  const loaded = await loadRawState(root);
  if (!loaded) return fresh;
  const state = loaded;
  if (state.stream === undefined) return { ...state, stream }; // pre-stamp legacy: adopt
  if (state.stream !== stream) {
    throw new StreamMismatchError(root, stream, state.stream, activePresent ? "state" : "incarnation-marker");
  }
  // reset-v1's hash-addressed old-lineage archive is durable evidence that a
  // seq-0 state came from rebind/freshening rather than true genesis. Re-mark
  // every load so daemon preflight and direct pushManifest callers cannot lose
  // the provenance merely by reloading the atomically installed next state.
  if (state.lastSyncedSequence === 0 && await hasResetLineageArchive(root)) {
    streamMismatchFreshStates.add(state);
  }
  return state;
}

function stateContainsGitPersistence(state: SyncState): boolean {
  return Object.keys(state.lastSyncedManifest.gitRepos ?? {}).length > 0
    || Object.keys(state.repoRecords ?? {}).length > 0
    || Object.keys(state.gitPendingRemote ?? {}).length > 0
    || Object.keys(state.gitReposRemoved ?? {}).length > 0
    || Object.keys(state.gitNeedsResolution ?? {}).length > 0
    || Object.keys(state.gitDeferrals ?? {}).length > 0
    || Object.keys(state.gitPartial ?? {}).length > 0;
}

async function writeWholeStateUnsafe(root: string, state: SyncState): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  const sanitizeSectionMap = (sections: Record<string, GitSection> | undefined) => sections === undefined
    ? undefined
    : Object.fromEntries(Object.entries(sections)
      .map(([relPath, section]) => [relPath, sanitizeGitSectionForPersistence(section)]));
  const sanitized = state.repoRecords === undefined
    ? {
        ...state,
        lastSyncedManifest: {
          ...state.lastSyncedManifest,
          ...(state.lastSyncedManifest.gitRepos === undefined ? {} : { gitRepos: sanitizeSectionMap(state.lastSyncedManifest.gitRepos) }),
        },
        ...(state.gitPendingRemote === undefined ? {} : { gitPendingRemote: sanitizeSectionMap(state.gitPendingRemote) }),
      }
    : (() => {
        // Route authoritative records through the universal sanitizer/composer,
        // while preserving this explicitly unsafe API's caller-supplied legacy
        // projections (tests and degraded compatibility intentionally exercise
        // mismatched snapshots).
        const projected = stateFromRepoRecords(state, repoRecordsForState(state));
        return {
          ...state,
          repoRecords: projected.repoRecords,
          lastSyncedManifest: {
            ...state.lastSyncedManifest,
            ...(state.lastSyncedManifest.gitRepos === undefined ? {} : { gitRepos: sanitizeSectionMap(state.lastSyncedManifest.gitRepos) }),
          },
          ...(state.gitPendingRemote === undefined ? {} : { gitPendingRemote: sanitizeSectionMap(state.gitPendingRemote) }),
        };
      })();
  const body = JSON.stringify(sanitized, null, 2);
  // The whole-state writer historically published with no lock at all, which is
  // what let a legacy save land on top of a newer format. It now takes the same
  // state lock every other writer holds; only a filesystem that offers no lock
  // primitive (`unsupported`) authorizes publishing without one. Contention, an
  // I/O failure, and a lost lease are refusals, not permission to write anyway.
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status === "held") {
    throw new StateWriteRefusedError("state-lock-unavailable", statePath(root), stateLockBusyDetail(acquired));
  }
  if (acquired.status === "error") {
    throw new StateWriteRefusedError("state-lock-error", statePath(root), String(acquired.error));
  }
  const lock = acquired.status === "acquired" ? acquired.lock : undefined;
  try {
    await publishWholeState(statePath(root), body, lock);
    await afterStatePublication(root, statePath(root), state.stream, body);
  } finally {
    await lock?.release();
  }
}

/** Fresh, non-Git initialization only. Git BASE and every repository sidecar are
 * generation-CAS state and must be persisted with applyStateSavePacket(). */
export async function saveState(root: string, state: SyncState): Promise<void> {
  if (stateContainsGitPersistence(state)) {
    throw new Error("saveState refuses Git BASE or repository records; use the transactional state composer");
  }
  await writeWholeStateUnsafe(root, state);
}

/** Explicit compatibility/test escape hatch. Production calls are restricted by
 * base-composer-structure.test.ts to the legacy fallback in sync-state.ts. */
export async function saveStateUnsafeLegacyOrTest(root: string, state: SyncState): Promise<void> {
  await writeWholeStateUnsafe(root, state);
}

/** Initialize the telemetry binding identity under the same lock as transactional state writes. */
export async function ensureTelemetryBindingId(
  root: string,
  stream: string,
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): Promise<{ state: SyncState; bindingId: string }> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error(`sync state telemetry lock unavailable (${stateLockBusyDetail(acquired)})`);
  try {
    const raw = await loadRawState(root);
    if (!raw) throw new Error("sync state is absent; refusing to manufacture a telemetry binding baseline");
    if (raw.stream !== undefined && raw.stream !== stream) {
      throw new Error(`sync state belongs to stream ${raw.stream}, not ${stream}; refusing to overwrite it`);
    }
    const current = stateFromRepoRecords(raw, repoRecordsForState(raw));
    if (typeof current.telemetryBindingId === "string" && BINDING_ID_RE.test(current.telemetryBindingId)) {
      return { state: current, bindingId: current.telemetryBindingId };
    }
    const bindingId = randomBytes(8).toString("hex");
    const next: SyncState = { ...current, telemetryBindingId: bindingId };
    let owner = true;
    const body = JSON.stringify(next, null, 2);
    await writeFileAtomic(statePath(root), body, {
      beforeRename: async () => {
        await assertStatePublishable(statePath(root), { locked: true });
        return (owner = await acquired.lock.isOwner());
      },
    });
    if (!owner) throw new Error("sync state telemetry lock ownership was lost");
    await fsyncDirectory(path.dirname(statePath(root)));
    await afterStatePublication(root, statePath(root), next.stream, body);
    return { state: next, bindingId };
  } finally {
    await acquired.lock.release();
  }
}

export async function assertResetIncarnationMarkerNormalized(root: string, state: SyncState): Promise<void> {
  if (!state.stream || !state.stateNonce) return; // legacy migration removes it
  const marker = await boundedJsonRead<Record<string, unknown>>(stateIncarnationPath(root), 512 * 1024);
  if (!marker) return;
  const keys = Object.keys(marker).sort().join("\0");
  if (keys !== ["stateNonce", "stateRevision", "stream"].sort().join("\0")
    || marker.stream !== state.stream || marker.stateNonce !== state.stateNonce
    || marker.stateRevision !== state.stateRevision) {
    throw new Error("reset refused: stale or foreign state incarnation marker");
  }
}

export async function installGenesisResetStateUnderHeldLock(
  root: string,
  nextStream: string,
  heldLock: OwnedLock,
): Promise<SyncState> {
  assertProtocolLockHeld("state", path.resolve(statePath(root)));
  if (path.resolve(heldLock.path) !== path.resolve(stateLockPath(root))) {
    throw new Error("held state lock does not match the workspace state path");
  }
  if (!(await heldLock.isOwner())) throw new Error("sync state reset lock ownership was lost");
  const genesis: SyncState = {
    stream: nextStream,
    stateNonce: crypto.randomBytes(16).toString("hex"),
    stateRevision: 0,
    lastSyncedSequence: 0,
    lastSyncedManifest: EMPTY_MANIFEST,
    repoRecords: {},
  };
  const body = JSON.stringify(genesis, null, 2);
  await publishWholeState(statePath(root), body, heldLock);
  await afterStatePublication(root, statePath(root), genesis.stream, body);
  await writeFileAtomic(stateIncarnationPath(root), JSON.stringify({
    stream: genesis.stream,
    stateNonce: genesis.stateNonce,
    stateRevision: 0,
  }, null, 2));
  await fsyncDirectory(path.dirname(stateIncarnationPath(root)));
  return genesis;
}
