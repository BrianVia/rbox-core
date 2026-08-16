import fs from "node:fs";
import path from "node:path";
import type { StateSavePacket, SyncState } from "../../sync-state-model.js";
import type { CasResult, LineageSnapshot, ManifestHeader } from "../ports.js";
import { beginGeneration, type GenerationBuilder } from "../store/generations.js";
import type { OwnedLockCasToken } from "../store/owner-token.js";
import { openReadSnapshot } from "../store/read-snapshot.js";
import { MAX_FILE_BATCH, type SealedStageRef } from "../store/sealed-stages.js";
import {
  StageLock,
  deleteSealedArtifact,
  sealedStagePath,
  type SealedArtifactRef,
} from "../store/stage-artifacts.js";
import {
  beginRepoTransitionStage,
  type RepoTransitionStageBuilder,
  type SealedRepoTransitionRef,
} from "../store/transition-stages.js";
import { applyCasPacket, type CasPacket } from "../store/write-packet.js";
import { stateStoreDatabase, type StateStoreHandle } from "../store/open.js";
import { selectRow } from "../store/statements.js";


function deleteStage(directory: string, ref: SealedArtifactRef): void {
  if (!fs.existsSync(sealedStagePath(directory, ref.stageId, ref.logicalDigest))) return;
  const lock = StageLock.acquire(directory, ref.stageId);
  try {
    deleteSealedArtifact(directory, ref, lock);
  } finally {
    lock.release();
  }
}

function deleteStages(directory: string, refs: Array<SealedArtifactRef | undefined>): unknown {
  let failure: unknown;
  for (const ref of refs) {
    if (!ref) continue;
    try {
      deleteStage(directory, ref);
    } catch (error) {
      failure ??= error;
    }
  }
  return failure;
}

function manifestHeader(packet: StateSavePacket): ManifestHeader {
  const { files: _files, gitRepos: _gitRepos, ...header } = packet.global!.manifest;
  return { ...header, complete: true };
}

export interface ReplacementLineage { stream: string; stateNonce: string; stateRevision: number; lastSyncedSequence: number }

export function readReplacementLineage(store: StateStoreHandle): ReplacementLineage {
  const row = selectRow<{
    stream: string;
    stateNonce: string | null;
    stateRevision: number | null;
    lastSyncedSequence: number;
  }>(stateStoreDatabase(store), `SELECT stream,state_nonce AS stateNonce,
    state_revision AS stateRevision,last_synced_sequence AS lastSyncedSequence
    FROM state_lineage WHERE lineage_id=(SELECT active_lineage_id FROM store_meta WHERE singleton=1)`);
  if (!row?.stateNonce || row.stateRevision === null) throw new Error("SQLite replacement lineage is incomplete");
  return { ...row, stateNonce: row.stateNonce, stateRevision: row.stateRevision };
}

/** Add store-generated identity to the caller's already-composed projection: the
 * six lineage-token fields a read-back would have carried, and nothing else. */
export function projectAcceptedSavePacket(projection: SyncState, token: LineageSnapshot): SyncState {
  // Extras FIRST, exactly as the read-back layers them (read-only.ts): an
  // unrecognized lineage column may not shadow lastSyncedManifest, manifestMeta,
  // or repoRecords, which the projection is authoritative for.
  const result: SyncState = {
    ...token.lineageExtras,
    ...projection,
    stream: token.stream,
    lastSyncedSequence: token.lastSyncedSequence,
  };
  if (token.nonce === undefined) delete result.stateNonce; else result.stateNonce = token.nonce;
  if (token.stateRevision === undefined) delete result.stateRevision; else result.stateRevision = token.stateRevision;
  if (token.telemetryBindingId === undefined) delete result.telemetryBindingId; else result.telemetryBindingId = token.telemetryBindingId;
  return result;
}

export async function applySavePacketToStore(
  store: StateStoreHandle,
  packet: StateSavePacket,
  ownerToken: OwnedLockCasToken,
): Promise<CasResult> {
  return translateSavePacket(store, packet, ownerToken);
}

/** Apply a reset-provenance stream replacement and its packet in one CAS. */
export async function replaceStreamAndApplySavePacketToStore(
  store: StateStoreHandle,
  packet: StateSavePacket,
  replacementOldStream: string,
  ownerToken: OwnedLockCasToken,
): Promise<CasResult> {
  return translateSavePacket(store, packet, ownerToken, replacementOldStream);
}

async function translateSavePacket(
  store: StateStoreHandle,
  packet: StateSavePacket,
  ownerToken: OwnedLockCasToken,
  replacementOldStream?: string,
): Promise<CasResult> {
  const directory = path.dirname(store.file);
  const token = openReadSnapshot(store).token;
  // The caller's claimed stream/nonce override the live ones on purpose: passing
  // the true token makes a mismatch throw StageChangedError out of
  // assertTransitionSnapshot instead of returning `rejected`, which is the
  // JSON-compat semantic 2C translates. A fabricated token only reaches a kept
  // artifact on the accepted path, where the claims provably matched.
  const { nonce: _nonce, ...tokenWithoutNonce } = token;
  // The legacy sentinel is the ABSENT nonce; it must not become a stored one.
  const expectedToken: LineageSnapshot = { ...tokenWithoutNonce, stream: packet.expectedStream };
  if (packet.expectedNonce !== "legacy") expectedToken.nonce = packet.expectedNonce;
  let globalBuilder: GenerationBuilder | undefined;
  let transitionBuilder: RepoTransitionStageBuilder | undefined;
  let global: SealedStageRef | undefined;
  let transitions: SealedRepoTransitionRef | undefined;
  let applied = false;
  let failure: unknown;
  try {
    if (packet.global) {
      const header = manifestHeader(packet);
      globalBuilder = beginGeneration(directory, "base", header);
      for (let offset = 0; offset < packet.global.manifest.files.length; offset += MAX_FILE_BATCH) {
        globalBuilder.putEntries(packet.global.manifest.files.slice(offset, offset + MAX_FILE_BATCH));
      }
      global = globalBuilder.finishGeneration({
        files: packet.global.manifest.files.length,
        gitSections: 0,
      });
    }

    const bindings = global
      ? [{
          stageId: global.stageId,
          logicalDigest: global.logicalDigest,
          physicalSha256: global.physicalSha256,
        }]
      : [];
    transitionBuilder = beginRepoTransitionStage(
      directory,
      expectedToken,
      bindings,
      global ? { globalBinding: bindings[0]! } : {},
    );
    for (const transition of packet.repos) {
      transitionBuilder.putTransition({
        ...transition,
        evidenceBindings: { sourceStages: bindings },
      });
    }
    transitions = transitionBuilder.finishRepoTransitionStage();

    const casPacket: CasPacket = {
      expected: {
        lineageId: token.lineageId,
        stream: packet.expectedStream,
        nonce: packet.expectedNonce,
        stateRevision: token.stateRevision ?? 0,
        baseGeneration: token.baseGeneration,
        localRevision: token.localRevision,
      },
      sourceGlobalSeq: packet.sourceGlobalSeq,
      repoTransitions: transitions,
      replacementOldStream,
      ownerToken,
    };
    if (global) {
      casPacket.global = { stage: global, fileHeader: global.header };
      const manifestMeta = packet.global?.manifestMeta;
      if (manifestMeta !== undefined) casPacket.global.manifestMeta = manifestMeta;
    }
    if (packet.elisionExpectation !== undefined) casPacket.elisionExpectation = packet.elisionExpectation;
    const result = applyCasPacket(store, directory, casPacket);
    applied = result.status === "accepted" || result.status === "rejected";
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    globalBuilder?.discardGeneration();
    transitionBuilder?.discard();
    if (!applied) {
      const cleanupFailure = deleteStages(directory, [transitions, global]);
      if (failure === undefined && cleanupFailure !== undefined) throw cleanupFailure;
    }
  }
}
