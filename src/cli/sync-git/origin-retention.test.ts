import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composeStateSavePacket } from "../sync-state.js";
import { LocalBlobStore, buildIgnoreMatcher, type GitSection } from "../../engine/index.ts";
import { applyGitSections } from "./apply.js";

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

test("203.2: unchanged cross-scope apply advances base and emits explicit sidecar clears", async () => {
  delete process.env.RBOX_GIT_APPLY_LAZY; // pin the lazy default against ambient kill-switch runs
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-origin-203-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    const remote = { ...section, refScope: "scoped" as const, generatedAt: "new" };
    const rels = ["r", "pending", "removed", "resolution"] as const;
    for (const rel of rels.slice(1)) {
      await fs.mkdir(path.join(root, rel, ".git"), { recursive: true });
      await fs.writeFile(path.join(root, rel, ".git", "index.lock"), "");
    }
    const priorDeferral = {
      lane: "apply", reason: "artifact",
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
    };
    const applyState = {
      ...state,
      lastSyncedManifest: {
        generatedAt: "old", files: [], manifestSchema: 2,
        gitRepos: Object.fromEntries(rels.map((rel) => [rel, section])),
      },
      gitPendingRemote: { pending: remote },
      gitReposRemoved: { removed: "removed-key" },
      gitNeedsResolution: { resolution: "resolution-key" },
      repoRecords: Object.fromEntries(rels.map((rel) => [rel, rel === "r"
        ? {
          ...state.repoRecords.r,
          base: section,
          deferrals: { apply: priorDeferral },
          partial: {
            incomingKey: "old", checkoutPending: false,
            appliedRefs: {}, heldRefs: {}, configApplied: true,
          },
          attempt: { incomingKey: "old" },
        }
        : { repoGen: 1, sourceSeq: 1, base: section }])),
    } as any;
    const outcome = await applyGitSections(
      root,
      {
        remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
        rootPath: root, remoteUrl: "https://api.test", token: "",
        syncGit: true, encrypted: true, kek: Buffer.alloc(32, 2),
      },
      applyState,
      {
        generatedAt: "new", files: [], manifestSchema: 2,
        gitRepos: Object.fromEntries(rels.map((rel) => [rel, remote])),
      },
      new LocalBlobStore(path.join(root, ".rbox", "blobs")),
      buildIgnoreMatcher(root),
      () => {},
      { disableConfigLane: true },
    );

    expect(outcome.gitRepos?.r).toEqual(remote);
    expect(outcome.gitPendingRemote).toMatchObject({
      pending: remote,
      removed: remote,
      resolution: remote,
    });
    expect(outcome.gitReposRemoved).toEqual({ removed: "removed-key" });
    expect(outcome.gitNeedsResolution).toEqual({ resolution: "resolution-key" });
    expect(outcome.attempt?.r).toBeNull();
    expect(outcome.partial?.r).toBeNull();
    expect(outcome.deferrals?.r?.apply).toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
