import { expect, test } from "bun:test";
import { composeStateSavePacket } from "../sync-state.js";
import type { GitSection } from "../../engine/index.ts";

const T = "1".repeat(40);
const LIN = "a".repeat(64);
const section: GitSection = {
  bundleSha: "0".repeat(64), bundleEncSha: "1".repeat(64), bundleCipherSize: 1,
  head: "ref: refs/heads/main", refs: { "refs/heads/main": T }, refScope: "all", generatedAt: "g",
};
const state = {
  stream: "s", stateNonce: "0".repeat(32), stateRevision: 1, lastSyncedSequence: 1,
  lastSyncedManifest: { generatedAt: "old", files: [] },
  repoRecords: { r: {
    repoGen: 3, sourceSeq: 1, base: section,
    branchBaseOrigins: { "refs/heads/main": { v: 1, oid: T, lineageHash: LIN, kind: "pull-p", episode: "e".repeat(32) } },
  } },
} as any;

test("unchanged pull without repoProofs retains pull-p origins", () => {
  const packet = composeStateSavePacket(state, {
    expectedStream: "s", sourceGlobalSeq: 2, observedRepos: ["r"],
    values: { bases: { r: section } }, // unchanged advance, no repoProofs (apply.ts shortcut)
  });
  expect(packet.repos[0]?.newRecord.branchBaseOrigins?.["refs/heads/main"]).toMatchObject({ kind: "pull-p" });
});

test("deferred repo (no bases entry) retains pull-p origins", () => {
  const packet = composeStateSavePacket(state, {
    expectedStream: "s", sourceGlobalSeq: 2, observedRepos: ["r"],
    values: {},
  });
  expect(packet.repos[0]?.newRecord.branchBaseOrigins?.["refs/heads/main"]).toMatchObject({ kind: "pull-p" });
});
