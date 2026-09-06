/** Never: decide which candidate survives, mutate plan fields, grant proof authority, or publish a manifest. */
import fs from "node:fs/promises";
import type { BlobStore } from "../../engine/blobstore.js";
import { poolMap } from "../../engine/pool.js";
import { PACK_MIN_ACTIVATION_COUNT } from "../../engine/blob-pack.js";
import { flushGitArtifact, type GitArtifactReadStore, type PendingGitUpload } from "./git-state.js";
import { makeGitCaptureDir } from "./capture.js";
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
  const loud = (encSha: string, at: string, message: string): Error => {
    const line = `git-sync retained artifact unreadable: encSha ${encSha} at ${at}: ${message}`;
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
        throw loud(encSha, at, errMsg(error));
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
        throw loud(encSha, at, errMsg(error));
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
/** Design 317 (F6a): a capture's artifacts (bundle, index, one per op-state file per
 * worktree) were uploaded one round trip after another, and each large one waited its
 * own pack-fill window (PACK_FILL_ABSOLUTE_MS) alone. Enqueue them together so a whole
 * capture lands in ONE fill wave: the bound is the pack lane's own activation count,
 * so a capture with that many artifacts also qualifies for a pack instead of the
 * single-PUT fallback. One owner for the number: engine/blob-pack.ts. */
export const GIT_ARTIFACT_FLUSH_CONCURRENCY = PACK_MIN_ACTIVATION_COUNT;

export async function flushGitArtifacts(
  store: BlobStore,
  pending: readonly PendingGitUpload[],
  flushed: Set<string>,
): Promise<void> {
  const owed = new Map<string, PendingGitUpload>();
  for (const artifact of pending) {
    if (!flushed.has(artifact.encSha) && !owed.has(artifact.encSha)) owed.set(artifact.encSha, artifact);
  }
  // Latch the first failure and let the in-flight siblings drain (poolMap's
  // documented shape): the plan's finally-sweep deletes the retained ciphertext,
  // and an unwound plan with detached uploads still reading it would race that.
  // Artifacts not yet started are skipped once something failed.
  // (A thrown `undefined` is still a failure: the latch is a flag, not the value.)
  let failed = false;
  let failure: unknown;
  await poolMap([...owed.values()], GIT_ARTIFACT_FLUSH_CONCURRENCY, async (artifact) => {
    if (failed) return;
    try {
      await flushGitArtifact(store, artifact);
      flushed.add(artifact.encSha);
    } catch (error) {
      if (!failed) { failed = true; failure = error; }
    }
  });
  if (failed) throw failure;
}

/** Owns every plan-lifetime transition of captured ciphertext. A caller names the
 * repository whose artifacts survived; it never coordinates retained paths, remote
 * read-through, or flush identities itself. */
export class PlanArtifactLifecycle {
  private dir: string | undefined;
  private readonly retained = new Map<string, string>();
  private readonly pendingByRepo = new Map<string, readonly PendingGitUpload[]>();
  private readonly flushed = new Set<string>();
  private readThrough: GitArtifactReadStore | undefined;

  constructor(
    private readonly root: string,
    private readonly remoteStore: () => BlobStore,
    private readonly onLog: (line: string) => void,
  ) {}

  async startIfNeeded(needed: boolean): Promise<string | undefined> {
    if (needed && this.dir === undefined) this.dir = await makeGitCaptureDir(this.root);
    return this.dir;
  }

  retain(rel: string, uploads: readonly PendingGitUpload[]): void {
    this.pendingByRepo.set(rel, uploads);
    for (const artifact of uploads) this.retained.set(artifact.encSha, artifact.ciphertextPath);
  }

  store(): GitArtifactReadStore {
    this.readThrough ??= planReadThroughStore(this.remoteStore(), this.retained, this.onLog);
    return this.readThrough;
  }

  async flush(rels: readonly string[]): Promise<void> {
    const owed = rels.flatMap((rel) => this.pendingByRepo.get(rel) ?? []);
    if (owed.length > 0) await flushGitArtifacts(this.remoteStore(), owed, this.flushed);
  }

  async dispose(): Promise<void> {
    if (this.dir === undefined) return;
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
