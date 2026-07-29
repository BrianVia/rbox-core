import fs from "node:fs";
import path from "node:path";
import type { StateSavePacket } from "../../sync-state-model.js";
import type { CasResult, ManifestHeader } from "../ports.js";
import { beginGeneration, type GenerationBuilder } from "../store/generations.js";
import type { OwnedLockCasToken } from "../store/owner-token.js";
import { openReadSnapshot } from "../store/read-snapshot.js";
import { MAX_MAX_FILE_BATCH, type SealedStageRef } from "../store/sealed-stages.js";
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
import { applyCasPacket } from "../store/write-packet.js";
import type { StateStoreHandle } from "../store/open.js";


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

export async function applySavePacketToStore(
  store: StateStoreHandle,
  packet: StateSavePacket,
  ownerToken: OwnedLockCasToken,
): Promise<CasResult> {
  const directory = path.dirname(store.file);
  const token = openReadSnapshot(store).token;
  // The caller's claimed stream/nonce override the live ones on purpose: passing
  // the true token makes a mismatch throw StageChangedError out of
  // assertTransitionSnapshot instead of returning `rejected`, which is the
  // JSON-compat semantic 2C translates. A fabricated token only reaches a kept
  // artifact on the accepted path, where the claims provably matched.
  const { nonce: _nonce, ...tokenWithoutNonce } = token;
  const expectedToken = {
    ...tokenWithoutNonce,
    stream: packet.expectedStream,
    ...(packet.expectedNonce === "legacy" ? {} : { nonce: packet.expectedNonce }),
  };
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

    const result = applyCasPacket(store, directory, {
      expected: {
        lineageId: token.lineageId,
        stream: packet.expectedStream,
        nonce: packet.expectedNonce,
        stateRevision: token.stateRevision ?? 0,
        baseGeneration: token.baseGeneration,
        localRevision: token.localRevision,
      },
      sourceGlobalSeq: packet.sourceGlobalSeq,
      ...(global
        ? {
            global: {
              stage: global,
              fileHeader: global.header,
              ...(packet.global?.manifestMeta === undefined
                ? {}
                : { manifestMeta: packet.global.manifestMeta }),
            },
          }
        : {}),
      repoTransitions: transitions,
      ownerToken,
    });
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
