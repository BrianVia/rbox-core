/** Fault injection at every stage boundary the design names: build, seal,
 * publication, verification, consumption, and CAS admission. Each injection must
 * fail closed and leave the authority exactly as it was. */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry } from "../../../engine/index.js";
import { StageChangedError, StageLockError } from "../errors.js";
import type { LineageSnapshot, ManifestHeader } from "../ports.js";
import { beginGeneration, openSealedStage, verifySourceStageBinding, type SealedStageRef } from "./generations.js";
import { createStateStore, stateStoreDatabase, type StateStoreHandle } from "./open.js";
import { openReadSnapshot } from "./read-snapshot.js";
import { StageLock, buildingStagePath, sealedStagePath, stageLockPath } from "./stage-artifacts.js";
import { beginRepoTransitionStage, openSealedRepoTransitionStage } from "./transition-stages.js";
import { applyCasPacket, type CasPacket } from "./write-packet.js";

const roots: string[] = [];
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const HEADER: ManifestHeader = { generatedAt: "2026-07-28T10:00:00.000Z", complete: true };
const OWNER = { isOwner: () => true };

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

function workspace(prefix: string): { stages: string; handle: StateStoreHandle } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const handle = createStateStore(path.join(root, "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: "stream",
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  });
  return { stages: path.join(root, "stages"), handle };
}

function entry(name: string, seed: number): FileEntry {
  return { path: name, sha256: hex(64, seed), size: seed, mode: 0o644, mtimeMs: seed, type: "file" } as FileEntry;
}

function seal(stages: string, stageId?: string): SealedStageRef {
  const builder = beginGeneration(stages, "base", HEADER, stageId);
  builder.putEntries([entry("one.txt", 1), entry("two.txt", 2)]);
  return builder.finishGeneration({ files: 2, gitSections: 0 });
}

function casPacket(stages: string, handle: StateStoreHandle, stage: SealedStageRef): CasPacket {
  const token: LineageSnapshot = openReadSnapshot(handle).token;
  const binding = { stageId: stage.stageId, logicalDigest: stage.logicalDigest, physicalSha256: stage.physicalSha256 };
  const builder = beginRepoTransitionStage(stages, token, [binding]);
  return {
    expected: {
      lineageId: token.lineageId, stream: token.stream, nonce: token.nonce ?? "legacy",
      stateRevision: token.stateRevision ?? 0, baseGeneration: token.baseGeneration,
      localRevision: token.localRevision,
    },
    sourceGlobalSeq: 1,
    global: { stage, fileHeader: HEADER },
    repoTransitions: builder.finishRepoTransitionStage(),
    ownerToken: OWNER,
  };
}

function assertUntouched(handle: StateStoreHandle): void {
  const db = stateStoreDatabase(handle);
  expect(db.query("SELECT count(*) AS n FROM plane_entries").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM entry_values").get()).toEqual({ n: 0 });
  expect(openReadSnapshot(handle).token.stateRevision).toBe(0);
}

test("a discarded generation leaves neither an artifact nor a lock behind", () => {
  const { stages } = workspace("rbox-stage-discard-");
  const stageId = "1".repeat(32);
  const builder = beginGeneration(stages, "base", HEADER, stageId);
  builder.putEntries([entry("one.txt", 1)]);
  expect(fs.existsSync(buildingStagePath(stages, stageId))).toBe(true);
  builder.discardGeneration();
  expect(fs.existsSync(buildingStagePath(stages, stageId))).toBe(false);
  expect(fs.existsSync(stageLockPath(stages, stageId))).toBe(false);
  expect(fs.readdirSync(stages)).toEqual([]);
});

test("a stage id admits exactly one owner at a time", () => {
  const { stages } = workspace("rbox-stage-lock-");
  const stageId = "2".repeat(32);
  const builder = beginGeneration(stages, "base", HEADER, stageId);
  try {
    expect(() => beginGeneration(stages, "base", HEADER, stageId)).toThrow(StageLockError);
    expect(() => StageLock.acquire(stages, stageId)).toThrow(StageLockError);
  } finally {
    builder.discardGeneration();
  }
  StageLock.acquire(stages, stageId).release();
});

test("publication is no-clobber: an occupied sealed name is refused, not replaced", () => {
  const { stages } = workspace("rbox-stage-noclobber-");
  const stageId = "3".repeat(32);
  const first = seal(stages, stageId);
  const occupied = sealedStagePath(stages, stageId, first.logicalDigest);
  const before = fs.readFileSync(occupied);

  const builder = beginGeneration(stages, "base", HEADER, stageId);
  builder.putEntries([entry("one.txt", 1), entry("two.txt", 2)]);
  expect(() => builder.finishGeneration({ files: 2, gitSections: 0 })).toThrow(StageChangedError);
  expect(fs.readFileSync(occupied)).toEqual(before);
});

test("a sealed stage that no longer is the exact file its ref names is refused", () => {
  const { stages, handle } = workspace("rbox-stage-identity-");
  const cases: Array<[string, (file: string) => void]> = [
    ["replaced with different bytes", (file) => {
      const bytes = fs.readFileSync(file);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
      fs.writeFileSync(file, bytes);
    }],
    ["replaced with a symlink to a valid stage", (file) => {
      const copy = `${file}.copy`;
      fs.copyFileSync(file, copy);
      fs.rmSync(file);
      fs.symlinkSync(copy, file);
    }],
    ["replaced with a directory", (file) => {
      fs.rmSync(file);
      fs.mkdirSync(file);
    }],
    ["given a WAL sidecar", (file) => fs.writeFileSync(`${file}-wal`, "sidecar")],
    ["deleted outright", (file) => fs.rmSync(file)],
    ["reopened writable and flipped back to building", (file) => {
      const db = new Database(file, { create: false, readwrite: true });
      db.exec("PRAGMA journal_mode=DELETE");
      db.query("UPDATE stage_meta SET state='building'").run();
      db.close();
    }],
    ["rewritten with a forged extra row", (file) => {
      const db = new Database(file, { create: false, readwrite: true });
      db.exec("PRAGMA journal_mode=DELETE");
      db.query("INSERT INTO stage_entries(stage_id,path,path_order,entry_cjson) VALUES ((SELECT stage_id FROM stage_meta),'x',x'0078','{}')").run();
      db.close();
    }],
  ];
  for (const [name, injure] of cases) {
    const stage = seal(stages);
    const packet = casPacket(stages, handle, stage);
    injure(sealedStagePath(stages, stage.stageId, stage.logicalDigest));
    expect(() => applyCasPacket(handle, stages, packet), name).toThrow(StageChangedError);
    assertUntouched(handle);
  }
  handle.close();
});

test("a ref whose digest or hash does not name this artifact is refused", () => {
  const { stages, handle } = workspace("rbox-stage-ref-");
  const stage = seal(stages);
  const lock = () => StageLock.acquire(stages, stage.stageId);

  const wrongHash = lock();
  try {
    expect(() => openSealedStage(stages, { ...stage, physicalSha256: hex(64, 7) }, wrongHash)).toThrow(StageChangedError);
  } finally { wrongHash.release(); }

  const wrongDigest = lock();
  try {
    expect(() => openSealedStage(stages, { ...stage, logicalDigest: hex(64, 8) as typeof stage.logicalDigest }, wrongDigest))
      .toThrow(StageChangedError);
  } finally { wrongDigest.release(); }

  const wrongCounts = lock();
  try {
    expect(() => openSealedStage(stages, { ...stage, counts: { files: 1, gitSections: 0 } }, wrongCounts)).toThrow();
  } finally { wrongCounts.release(); }

  expect(() => verifySourceStageBinding(stages, { ...stage, physicalSha256: hex(64, 9) })).toThrow(StageChangedError);
  expect(verifySourceStageBinding(stages, stage).logicalDigest).toBe(stage.logicalDigest);
  handle.close();
});

test("a sealed artifact has exactly one active accessor and fails closed on mid-read mutation", () => {
  const { stages, handle } = workspace("rbox-stage-accessor-");
  const stage = seal(stages);
  const file = sealedStagePath(stages, stage.stageId, stage.logicalDigest);
  const lock = StageLock.acquire(stages, stage.stageId);
  const reader = openSealedStage(stages, stage, lock);
  try {
    expect(() => openSealedStage(stages, stage, lock)).toThrow(StageChangedError);
    // Mutation between the opening proof and the closing proof is caught by the
    // second half of the identity bracket, after the rows were already streamed.
    expect(reader.files(undefined, 512).rows).toHaveLength(2);
    fs.appendFileSync(file, "tamper");
    expect(() => reader.close()).toThrow(StageChangedError);
  } finally {
    lock.release();
  }
  handle.close();
});

test("a tampered transition stage never reaches the authority transaction", () => {
  const { stages, handle } = workspace("rbox-stage-transition-");
  const token = openReadSnapshot(handle).token;
  const builder = beginRepoTransitionStage(stages, token, []);
  builder.putTransition({
    relPath: "repo", expectedRepoGen: 0, newRecord: { sourceSeq: 1, removedKey: "gone" },
    evidenceBindings: { sourceStages: [] },
  });
  const ref = builder.finishRepoTransitionStage();
  const file = sealedStagePath(stages, ref.stageId, ref.logicalDigest);
  const db = new Database(file, { create: false, readwrite: true });
  db.exec("PRAGMA journal_mode=DELETE");
  db.query("UPDATE transition_rows SET record_cjson=? WHERE rel_path='repo'").run('{"removedKey":"forged","sourceSeq":1}');
  db.close();

  const lock = StageLock.acquire(stages, ref.stageId);
  try {
    expect(() => openSealedRepoTransitionStage(stages, ref, lock)).toThrow(StageChangedError);
  } finally {
    lock.release();
  }
  expect(() => applyCasPacket(handle, stages, {
    expected: {
      lineageId: token.lineageId, stream: token.stream, nonce: token.nonce ?? "legacy",
      stateRevision: 0, baseGeneration: 0, localRevision: 0,
    },
    sourceGlobalSeq: 1,
    repoTransitions: ref,
    ownerToken: OWNER,
  })).toThrow(StageChangedError);
  expect(stateStoreDatabase(handle).query("SELECT count(*) AS n FROM repo_records").get()).toEqual({ n: 0 });
  assertUntouched(handle);
  handle.close();
});

test("a global stage and its transition stage must come from the same input", () => {
  const { stages, handle } = workspace("rbox-stage-pairing-");
  const token = openReadSnapshot(handle).token;
  const stage = seal(stages);
  const other = seal(stages);
  const foreign = beginRepoTransitionStage(stages, token, [{
    stageId: other.stageId, logicalDigest: other.logicalDigest, physicalSha256: other.physicalSha256,
  }]);
  const expected = {
    lineageId: token.lineageId, stream: token.stream, nonce: token.nonce ?? "legacy",
    stateRevision: 0, baseGeneration: 0, localRevision: 0,
  };
  expect(() => applyCasPacket(handle, stages, {
    expected, sourceGlobalSeq: 1,
    global: { stage, fileHeader: HEADER },
    repoTransitions: foreign.finishRepoTransitionStage(),
    ownerToken: OWNER,
  })).toThrow(StageChangedError);

  // A repo-only packet must declare an explicitly empty source-stage list.
  const bound = beginRepoTransitionStage(stages, token, [{
    stageId: stage.stageId, logicalDigest: stage.logicalDigest, physicalSha256: stage.physicalSha256,
  }]);
  expect(() => applyCasPacket(handle, stages, {
    expected, sourceGlobalSeq: 1,
    repoTransitions: bound.finishRepoTransitionStage(),
    ownerToken: OWNER,
  })).toThrow(StageChangedError);
  assertUntouched(handle);
  handle.close();
});
