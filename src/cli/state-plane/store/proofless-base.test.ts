/**
 * Regression: the proofless-BASE counterexample.
 *
 * The FIRST implementation of this seam was withdrawn because its transition
 * builder admitted a repository record that introduced `BASE` without a validated
 * `RepoBaseProof`. That is not substrate behavior, so no U1a test covers it. These
 * are the executable counterexamples: every BASE introduction, replacement, or
 * removal must be justified by an explicit, purpose-bound proof, and the proof must
 * be bound to the repository, its expected generation, the source evidence, and the
 * coherent snapshot token.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitSection } from "../../../engine/index.js";
import { carryRepoBaseProof } from "../../sync-git/base-composer.js";
import { migrationRepoBaseProof } from "../base-proof.js";
import type { RepoRecordInput } from "../../sync-state-model.js";
import { canonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import { loadRawStateFromStore } from "../adapters/read-only.js";
import { ProoflessBaseError, StageChangedError } from "../errors.js";
import type { LineageSnapshot, ManifestHeader } from "../ports.js";
import { createStateStore, stateStoreDatabase, type StateStoreHandle } from "./open.js";
import { openReadSnapshot } from "./read-snapshot.js";
import { sealedStagePath } from "./stage-artifacts.js";
import { beginRepoTransitionStage, type SealedRepoTransitionRef } from "./transition-stages.js";
import { applyCasPacket } from "./write-packet.js";
import { casOwnerTokenForTest } from "./owner-token-testkit.js";

const roots: string[] = [];
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const HEADER: ManifestHeader = { generatedAt: "", complete: true };
const OWNER = casOwnerTokenForTest(() => true);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

function workspace(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const handle = createStateStore(path.join(root, "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: "stream",
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  });
  return { stages: path.join(root, "stages"), handle };
}

function section(seed: number): GitSection {
  return {
    bundleSha: hex(64, seed + 1), bundleEncSha: hex(64, seed + 2), bundleCipherSize: 1,
    head: hex(40, seed + 3), refs: {}, config: {}, refScope: "all",
    generatedAt: "2026-07-28T00:00:00.000Z",
  } as GitSection;
}

function expectation(token: LineageSnapshot) {
  return {
    lineageId: token.lineageId, stream: token.stream, nonce: token.nonce ?? "legacy",
    stateRevision: token.stateRevision ?? 0, baseGeneration: token.baseGeneration,
    localRevision: token.localRevision,
  };
}

function sealOne(
  stages: string,
  token: LineageSnapshot,
  row: { relPath: string; expectedRepoGen: number; newRecord: RepoRecordInput; baseProof?: ReturnType<typeof carryRepoBaseProof> },
): SealedRepoTransitionRef {
  const builder = beginRepoTransitionStage(stages, token, []);
  const transition = {
    relPath: row.relPath,
    expectedRepoGen: row.expectedRepoGen,
    newRecord: row.newRecord,
    evidenceBindings: { sourceStages: [] },
  };
  builder.putTransition(row.baseProof === undefined
    ? transition
    : { ...transition, baseProof: row.baseProof });
  return builder.finishRepoTransitionStage();
}

function applyOne(stages: string, handle: StateStoreHandle, ref: SealedRepoTransitionRef) {
  return applyCasPacket(handle, stages, {
    expected: expectation(ref.snapshotToken),
    sourceGlobalSeq: 1,
    repoTransitions: ref,
    ownerToken: OWNER,
  });
}

test("the transition builder refuses a BASE introduction that carries no proof", () => {
  const { stages, handle } = workspace("rbox-proofless-builder-");
  const token = openReadSnapshot(handle).token;
  const builder = beginRepoTransitionStage(stages, token, []);
  try {
    expect(() => builder.putTransition({
      relPath: "repo",
      expectedRepoGen: 0,
      newRecord: { sourceSeq: 1, base: section(10) },
      evidenceBindings: { sourceStages: [] },
    })).toThrow(ProoflessBaseError);
    // Branch provenance is BASE authority too and is refused on the same rule.
    expect(() => builder.putTransition({
      relPath: "repo",
      expectedRepoGen: 0,
      newRecord: {
        sourceSeq: 1,
        branchBaseOrigins: { "refs/heads/main": { v: 1, oid: "a".repeat(40), lineageHash: "e".repeat(64), kind: "manual", episode: "1".repeat(32) } },
      },
      evidenceBindings: { sourceStages: [] },
    })).toThrow(ProoflessBaseError);
  } finally {
    builder.discard();
  }
  handle.close();
});

test("retired migration authority is refused by live transition stages", () => {
  const { stages, handle } = workspace("rbox-proofless-migration-");
  const token = openReadSnapshot(handle).token;
  expect(() => sealOne(stages, token, {
    relPath: "repo", expectedRepoGen: 0,
    newRecord: { sourceSeq: 1, base: section(10) },
    baseProof: migrationRepoBaseProof("lineage"),
  })).toThrow(ProoflessBaseError);

  handle.close();
});

test("the CAS refuses a proofless row that would move an existing BASE", () => {
  const { stages, handle } = workspace("rbox-proofless-cas-");
  const seeded = sealOne(stages, openReadSnapshot(handle).token, {
    relPath: "repo", expectedRepoGen: 0,
    newRecord: { sourceSeq: 1, base: section(10) },
    baseProof: carryRepoBaseProof("lineage"),
  });
  expect(applyOne(stages, handle, seeded).status).toBe("accepted");
  const withBase = loadRawStateFromStore(handle);
  expect(withBase.repoRecords!["repo"]!.base).toBeDefined();

  // A later transition with no proof cannot silently drop that BASE.
  const proofless = sealOne(stages, openReadSnapshot(handle).token, {
    relPath: "repo", expectedRepoGen: 1, newRecord: { sourceSeq: 2, removedKey: "gone" },
  });
  expect(() => applyOne(stages, handle, proofless)).toThrow(ProoflessBaseError);
  expect(loadRawStateFromStore(handle)).toStrictEqual(withBase);
  handle.close();
});

test("branch-origin-only provenance is BASE authority and is protected without a proof", () => {
  const { stages, handle } = workspace("rbox-proofless-origins-");
  const db = stateStoreDatabase(handle);
  // Branch origins can outlive their section (a migration import, a composer hold),
  // so the guard must hold for the authority row shape, not just for `base`.
  db.query(`INSERT INTO repo_records(lineage_id,rel_path,path_order,repo_gen,source_seq,
    branch_base_origins_cjson,extras_cjson,canonical_bytes,retained_estimate)
    VALUES (?,?,?,1,1,?,NULL,64,4096)`).run(
    LINEAGE, "repo", utf16beOrderKey("repo"),
    canonicalJson({ "refs/heads/main": { v: 1, oid: "a".repeat(40), lineageHash: "e".repeat(64), kind: "manual", episode: "1".repeat(32) } }),
  );
  const proofless = sealOne(stages, openReadSnapshot(handle).token, {
    relPath: "repo", expectedRepoGen: 1, newRecord: { sourceSeq: 2, removedKey: "gone" },
  });
  expect(() => applyOne(stages, handle, proofless)).toThrow(ProoflessBaseError);
  expect(db.query("SELECT branch_base_origins_cjson FROM repo_records WHERE rel_path='repo'").get())
    .not.toEqual({ branch_base_origins_cjson: null });
  handle.close();
});

test("a proof is bound to its repository, generation, evidence, and snapshot", () => {
  const { stages, handle } = workspace("rbox-proofless-binding-");
  const token = openReadSnapshot(handle).token;
  const ref = sealOne(stages, token, {
    relPath: "repo-a", expectedRepoGen: 0,
    newRecord: { sourceSeq: 1, base: section(10) },
    baseProof: carryRepoBaseProof("lineage"),
  });
  const file = sealedStagePath(stages, ref.stageId, ref.logicalDigest);
  const pristine = fs.readFileSync(file);

  // Each forgery re-seals the artifact so its PHYSICAL hash matches again. What
  // refuses them is therefore the transition digest itself: it covers the
  // repository, the expected generation, the proof, the evidence, and the snapshot.
  for (const mutation of [
    "UPDATE transition_rows SET rel_path='repo-b'",
    "UPDATE transition_rows SET expected_repo_gen=4",
    "UPDATE transition_meta SET snapshot_cjson=replace(snapshot_cjson,'\"stream\"','\"stre4m\"')",
    "UPDATE transition_rows SET base_proof_cjson=replace(base_proof_cjson,'lineage','forged')",
    "UPDATE transition_rows SET evidence_cjson='{\"sourceStages\":[\"forged\"]}'",
  ]) {
    fs.writeFileSync(file, pristine);
    const db = new Database(file, { create: false, readwrite: true });
    db.exec("PRAGMA journal_mode=DELETE");
    db.query(mutation).run();
    db.close();
    const forged = { ...ref, physicalSha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    expect(() => applyOne(stages, handle, forged), mutation).toThrow(StageChangedError);
    expect(stateStoreDatabase(handle).query("SELECT count(*) AS n FROM repo_records").get()).toEqual({ n: 0 });
  }

  fs.writeFileSync(file, pristine);
  expect(applyOne(stages, handle, ref).status).toBe("accepted");
  handle.close();
});
