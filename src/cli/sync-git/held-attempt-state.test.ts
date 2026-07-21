import { expect, test } from "bun:test";
import type { GitHeldAttempt, RepoRecord, SyncState } from "../config.js";
import { stateFromRepoRecords } from "../config.js";
import { composeStateSavePacket } from "../sync-state.js";

const section = {
  bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
  head: "ref: refs/heads/main", refs: { "refs/heads/main": "3".repeat(40) }, refScope: "all" as const,
};
const attempt: GitHeldAttempt = {
  incomingKey: "incoming", localFingerprint: "fingerprint", fingerprintVersion: "version",
  effectiveBaseIndexProjection: null, effectiveIncomingIndexProjection: null,
  incomingIndexArtifactDescriptor: "null",
  reflogs: [{ path: "logs/refs/stash", digest: "digest" }],
  blockers: [{ provenance: "checkout", reason: "local-commits" }],
  repoIdentity: "identity", stateNonce: "nonce", baseOriginsHash: "base", partialDisposition: "partial",
  at: "2026-07-21T12:00:00.000Z",
};

function state(record: RepoRecord): SyncState {
  return stateFromRepoRecords({
    version: 1, stream: "stream", stateNonce: "a".repeat(32), stateRevision: 1,
    lastSyncedSequence: 1, lastSyncedManifest: { generatedAt: "one", files: [] },
  }, { repo: record });
}

test("attempt omission preserves and explicit null clears through the generation-CAS packet", () => {
  const snapshot = state({ repoGen: 4, sourceSeq: 1, base: section, pending: section, attempt });
  const preserved = composeStateSavePacket(snapshot, {
    expectedStream: "stream", sourceGlobalSeq: 2, observedRepos: ["repo"],
    values: { bases: { repo: section }, pending: { repo: section } },
  });
  expect(preserved.repos[0]!.newRecord.attempt).toEqual(attempt);
  const cleared = composeStateSavePacket(snapshot, {
    expectedStream: "stream", sourceGlobalSeq: 2, observedRepos: ["repo"],
    values: { bases: { repo: section }, pending: {}, attempt: { repo: null }, partial: { repo: null } },
  });
  expect(cleared.repos[0]!.newRecord.attempt).toBeUndefined();
  expect(cleared.repos[0]!.newRecord.pending).toBeUndefined();
});
