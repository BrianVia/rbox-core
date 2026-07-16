import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitSection } from "../../engine/index.js";
import { ensureCapableStateLineage, loadRawState, saveState, type RepoRecord, type SyncState } from "../config.js";
import { composeStateSavePacket } from "../sync-state.js";
import type { BranchTransitionWitness, RepoBaseProof } from "./base-composer.js";

const L = "1".repeat(40);
const N = "2".repeat(40);
const LIN = "a".repeat(64);
const REPO = "b".repeat(64);
const ref = "refs/heads/topic";
const section = (value: string, generatedAt: string): GitSection => ({
  bundleSha: generatedAt.padEnd(64, "0").slice(0, 64),
  bundleEncSha: generatedAt.padEnd(64, "1").slice(0, 64),
  bundleCipherSize: 1,
  head: "ref: refs/heads/topic",
  refs: { [ref]: value },
  refScope: "all",
  generatedAt,
});

function state(record: RepoRecord): SyncState {
  return {
    stream: "stream", stateNonce: "0".repeat(32), stateRevision: 1,
    lastSyncedSequence: 1, lastSyncedManifest: { generatedAt: "old", files: [] },
    repoRecords: { repo: record },
  };
}

test("StateSource repoProofs carries exact per-repo P authority into the CAS packet", () => {
  const witness: Extract<BranchTransitionWitness, { kind: "present" }> = {
    kind: "present", ref, priorOid: L, nextOid: N, lineageHash: LIN, repositoryIdentityHash: REPO,
    artifactRef: `refs/rbox-local/base-present/v2/${LIN}/hash`, artifactOid: "c".repeat(40), episode: "d".repeat(32),
  };
  const proof: RepoBaseProof = {
    authority: {
      kind: "pull-ref-transaction", lineageHash: LIN, repositoryIdentityHash: REPO, incomingKey: "incoming",
      branchWitnesses: { [ref]: witness }, safeRefWitnesses: {},
    },
    lockedProof: {
      repoKind: "dir", effectiveRefScope: "all", checkoutComplete: true, incomingKey: "incoming", safeRefs: {},
      branches: { [ref]: {
        liveOid: N, witness, reflogEpisode: witness.episode, artifactsClear: true,
        ownershipStable: true, reflogStable: true, currentRef: false, siblingOwned: false,
      } },
    },
  };
  const previous = section(L, "old");
  const candidate = section(N, "new");
  const packet = composeStateSavePacket(state({ repoGen: 4, sourceSeq: 1, base: previous }), {
    expectedStream: "stream", sourceGlobalSeq: 2, observedRepos: ["repo"],
    values: { bases: { repo: candidate } }, repoProofs: { repo: proof },
  });
  expect(packet.repos).toHaveLength(1);
  expect(packet.repos[0]?.baseProof).toEqual(proof);
  expect(packet.repos[0]?.newRecord.base?.refs[ref]).toBe(N);
  expect(packet.repos[0]?.newRecord.branchBaseOrigins?.[ref]).toEqual({
    v: 1, oid: N, lineageHash: LIN, kind: "pull-p", episode: witness.episode,
  });
  expect(packet.repos[0]?.newRecord.pending).toBeUndefined();
});

test("a source without branch authority keeps prior BASE and marks the exact candidate pending", () => {
  const previous = section(L, "old");
  const candidate = { ...section(N, "new"), refs: {} };
  const packet = composeStateSavePacket(state({ repoGen: 4, sourceSeq: 1, base: previous }), {
    expectedStream: "stream", sourceGlobalSeq: 2, observedRepos: ["repo"], values: { bases: { repo: candidate } },
    repoProofs: { repo: {
      authority: { kind: "pull-carry", lineageHash: LIN, incomingKey: "incoming" },
      lockedProof: { repoKind: "dir", effectiveRefScope: "all", checkoutComplete: true, branches: {}, safeRefs: {} },
    } },
  });
  expect(packet.repos[0]?.newRecord.base).toEqual(previous);
  expect(packet.repos[0]?.newRecord.pending).toEqual(candidate);
});

test("true genesis is durably fenced before Git mutation while an existing legacy baseline is not upgraded", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-lineage-genesis-"));
  const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-lineage-legacy-"));
  try {
    const genesis: SyncState = { stream: "stream", lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] } };
    const capable = await ensureCapableStateLineage(root, genesis);
    expect(capable.stateNonce).toMatch(/^[0-9a-f]{32}$/);
    expect((await loadRawState(root))?.stateNonce).toBe(capable.stateNonce);

    const legacy: SyncState = { stream: "stream", lastSyncedSequence: 1, lastSyncedManifest: { generatedAt: "old", files: [] } };
    await saveState(legacyRoot, legacy);
    const held = await ensureCapableStateLineage(legacyRoot, legacy);
    expect(held.stateNonce).toBeUndefined();
    expect((await loadRawState(legacyRoot))?.stateNonce).toBeUndefined();
  } finally {
    await Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(legacyRoot, { recursive: true, force: true }),
    ]);
  }
});
