import fs from "node:fs/promises";
import type { BlobStore } from "../../engine/blobstore.js";
import { flushGitArtifact, type GitArtifactReadStore, type PendingGitUpload } from "../../engine/git/shared.js";
import { errMsg } from "./shared.js";

// ---- design 226: plan-lifetime git artifact retention ------------------------------
//
// The push planner ENCRYPTS a repo's git artifacts during capture and uploads them only
// after the plan has decided the section survives. Two things follow, and both live here:
//
//  1. Decisions that read the FRESH candidate's own bytes (`finalResolutionReport` →
//     `pendingIndexProjection`) must resolve them LOCALLY — a remote GET would 404 before
//     the flush and degrade the keep-mine lane to a silent indeterminate refusal.
//  2. The flush is an all-or-nothing barrier over the surviving sections.

/** Read-through over the plan's retained ciphertext, falling back to `remote` for
 *  pending / pack-chain artifacts that are genuinely committed. A retained entry whose
 *  file cannot be read THROWS a named error instead of falling back: the projection
 *  helpers cannot distinguish absent from unreadable and turn either into an
 *  unactionable keep-mine refusal. */
export function planReadThroughStore(
  remote: GitArtifactReadStore,
  retained: ReadonlyMap<string, string>,
  onLog: (line: string) => void,
): GitArtifactReadStore {
  const loud = (encSha: string, at: string, error: unknown): Error => {
    const line = `git-sync retained artifact unreadable: encSha ${encSha} at ${at}: ${errMsg(error)}`;
    onLog(line);
    return new Error(line);
  };
  const store: GitArtifactReadStore = {
    async get(encSha) {
      const at = retained.get(encSha);
      if (at === undefined) return remote.get(encSha);
      try {
        return await fs.readFile(at);
      } catch (error) {
        throw loud(encSha, at, error);
      }
    },
  };
  // `getToFile` is optional and feature-detected by every caller; defining it over a
  // store that lacks it would call `undefined(...)`.
  if (remote.getToFile) {
    const remoteGetToFile = remote.getToFile.bind(remote);
    store.getToFile = async (encSha, destPath, expectedSize) => {
      const at = retained.get(encSha);
      if (at === undefined) return remoteGetToFile(encSha, destPath, expectedSize);
      try {
        await fs.copyFile(at, destPath);
      } catch (error) {
        throw loud(encSha, at, error);
      }
    };
  }
  return store;
}

/** Upload every retained artifact of the surviving sections. An `encSha` enters
 *  `flushed` only after the store reports it satisfied or a PUT succeeds — never at
 *  retain time — so a `gitForceForMissingBlobs` recovery is never short-circuited.
 *  Any failure propagates: the flush is all-or-nothing and rejects the whole plan,
 *  because by this point irreversible ref mutations and keep-mine pins have already
 *  happened and no per-repo revert can undo them. Performs no cleanup; the plan's
 *  single `finally` sweep of the retention dir is the only reclamation. */
export async function flushGitArtifacts(
  store: BlobStore,
  pending: readonly PendingGitUpload[],
  flushed: Set<string>,
): Promise<void> {
  for (const artifact of pending) {
    if (flushed.has(artifact.encSha)) continue;
    await flushGitArtifact(store, artifact);
    flushed.add(artifact.encSha);
  }
}
