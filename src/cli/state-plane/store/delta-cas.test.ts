/** Design 269 §2.5/§2.6: the relative-global save shape, its structural refusals,
 * and the negative controls that keep it isolated from the complete path. */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry } from "../../../engine/index.js";
import type { GlobalManifestMeta } from "../../sync-state-model.js";
import type { DeltaBinding, DeltaOp } from "../../sync-state-delta.js";
import { loadRawStateFromStore } from "../adapters/read-only.js";
import { StageChangedError } from "../errors.js";
import type { CasResult, LineageSnapshot, ManifestHeader } from "../ports.js";
import { beginDeltaStage, canonicalBinding, type SealedDeltaStageRef } from "./delta-stages.js";
import { beginGeneration } from "./generations.js";
import { createStateStore, stateStoreDatabase, type StateStoreHandle } from "./open.js";
import { openReadSnapshot } from "./read-snapshot.js";
import type { SealedStageRef } from "./sealed-stages.js";
import { sealedStagePath } from "./stage-artifacts.js";
import { selectRows } from "./statements.js";
import { beginRepoTransitionStage, type SealedRepoTransitionRef } from "./transition-stages.js";
import { applyCasPacket, type CasExpectation, type CasPacket } from "./write-packet.js";
import { casOwnerTokenForTest } from "./owner-token-testkit.js";

const roots: string[] = [];
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const STREAM = "workspace/269";
const OWNER = casOwnerTokenForTest(() => true);
const HEADER: ManifestHeader = { generatedAt: "2026-08-16T10:00:00.000Z", manifestSchema: 2, complete: true };

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

interface Workspace {
  stages: string;
  handle: StateStoreHandle;
}

function workspace(prefix: string): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const handle = createStateStore(path.join(root, "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  });
  return { stages: path.join(root, "stages"), handle };
}

function entry(name: string, seed: number): FileEntry {
  return { path: name, sha256: hex(64, seed), size: seed, mode: 0o644, mtimeMs: seed + 0.5, type: "file" } as FileEntry;
}

function expectation(token: LineageSnapshot): CasExpectation {
  return {
    lineageId: token.lineageId, stream: token.stream, nonce: token.nonce ?? "legacy",
    stateRevision: token.stateRevision ?? 0, baseGeneration: token.baseGeneration,
    localRevision: token.localRevision,
  };
}

const liveBinding = (handle: StateStoreHandle): DeltaBinding => {
  const token = openReadSnapshot(handle).token;
  return { nonce: token.nonce!, stateRevision: token.stateRevision ?? 0 };
};

function sealDelta(
  stages: string,
  binding: DeltaBinding,
  ops: readonly DeltaOp[],
  resultFiles: number,
  header: ManifestHeader = HEADER,
): SealedDeltaStageRef {
  const builder = beginDeltaStage(stages, "base", header, binding);
  let upserts = 0;
  let deletes = 0;
  for (const op of ops) {
    if (op.kind === "upsert") {
      builder.putUpsert(op.entry);
      upserts++;
    } else {
      builder.putDelete(op.path);
      deletes++;
    }
  }
  return builder.finishDeltaStage({ upserts, deletes, resultFiles });
}

/** A complete stage dressed as a delta ref: its logical digest is the wrong grammar. */
type ForgedDeltaStageRef = Omit<SealedDeltaStageRef, "logicalDigest"> & Pick<SealedStageRef, "logicalDigest">;

function sealComplete(stages: string, files: readonly FileEntry[]): SealedStageRef {
  const builder = beginGeneration(stages, "base", HEADER);
  builder.putEntries([...files]);
  return builder.finishGeneration({ files: files.length, gitSections: 0 });
}

function sealTransitions(
  stages: string,
  token: LineageSnapshot,
  stage: { stageId: string; logicalDigest: string; physicalSha256: string },
): SealedRepoTransitionRef {
  const bindings = [{ stageId: stage.stageId, logicalDigest: stage.logicalDigest, physicalSha256: stage.physicalSha256 }];
  const builder = beginRepoTransitionStage(stages, token, bindings, { globalBinding: bindings[0]! });
  return builder.finishRepoTransitionStage();
}

interface DeltaSaveOptions {
  binding?: DeltaBinding;
  claimedBinding?: DeltaBinding;
  resultFiles?: number;
  sourceGlobalSeq?: number;
  manifestMeta?: GlobalManifestMeta;
}

function deltaPacket(
  workspaceUnderTest: Workspace,
  ops: readonly DeltaOp[],
  resultFiles: number,
  options: DeltaSaveOptions = {},
): CasPacket {
  const { stages, handle } = workspaceUnderTest;
  const token = openReadSnapshot(handle).token;
  const sealedBinding = options.binding ?? liveBinding(handle);
  const stage = sealDelta(stages, sealedBinding, ops, options.resultFiles ?? resultFiles);
  const globalDelta: CasPacket["globalDelta"] = {
    stage, fileHeader: stage.header, binding: options.claimedBinding ?? sealedBinding,
  };
  if (options.manifestMeta) globalDelta.manifestMeta = options.manifestMeta;
  return {
    expected: expectation(token),
    sourceGlobalSeq: options.sourceGlobalSeq ?? 5,
    globalDelta,
    repoTransitions: sealTransitions(stages, token, stage),
    ownerToken: OWNER,
  };
}

function completeSave(workspaceUnderTest: Workspace, files: readonly FileEntry[], sourceGlobalSeq = 5): CasResult {
  const { stages, handle } = workspaceUnderTest;
  const token = openReadSnapshot(handle).token;
  const stage = sealComplete(stages, files);
  return applyCasPacket(handle, stages, {
    expected: expectation(token),
    sourceGlobalSeq,
    global: { stage, fileHeader: stage.header },
    repoTransitions: sealTransitions(stages, token, stage),
    ownerToken: OWNER,
  });
}

interface PlaneRow {
  path: string;
  sha256: string;
  changed_generation: number;
}

function planeRows(handle: StateStoreHandle): PlaneRow[] {
  return selectRows<{ path: string; sha256: Uint8Array; changed_generation: number }>(
    stateStoreDatabase(handle),
    `SELECT p.path,e.sha256,p.changed_generation FROM plane_entries p
     JOIN entry_values e ON e.entry_id=p.entry_id
     WHERE p.lineage_id=? AND p.plane='base' ORDER BY p.path_order`, LINEAGE,
  ).map((row) => ({ path: row.path, sha256: Buffer.from(row.sha256).toString("hex"), changed_generation: row.changed_generation }));
}

const BASE = [entry("a.txt", 1), entry("b.txt", 2), entry("c.txt", 3)];

test("a delta applies only its named paths and leaves every other row untouched", () => {
  const under = workspace("rbox-delta-apply-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const before = planeRows(under.handle);
  expect(before.map((row) => row.changed_generation)).toEqual([1, 1, 1]);

  const changed = entry("b.txt", 9);
  const result = applyCasPacket(under.handle, under.stages, deltaPacket(under, [
    { kind: "upsert", entry: changed },
    { kind: "delete", path: "c.txt" },
  ], 2, { sourceGlobalSeq: 6 }));
  expect(result.status).toBe("accepted");

  expect(planeRows(under.handle)).toEqual([
    { path: "a.txt", sha256: hex(64, 1), changed_generation: 1 },
    { path: "b.txt", sha256: hex(64, 9), changed_generation: 2 },
  ]);
  const state = loadRawStateFromStore(under.handle);
  expect(state.lastSyncedManifest.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
  expect(state.lastSyncedSequence).toBe(6);
  under.handle.close();
});

test("a zero-op delta advances the head, the sequence, and the generation-keyed meta", () => {
  const under = workspace("rbox-delta-zero-op-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const meta: GlobalManifestMeta = {
    encManifestSha: hex(64, 11), manifestHash: hex(64, 12), accountEpoch: 1, keyEpoch: 1,
    chain: [], chainBytes: 0, snapshotBytes: 512, gitRepos: {},
  };
  const before = openReadSnapshot(under.handle).token;

  const result = applyCasPacket(under.handle, under.stages,
    deltaPacket(under, [], 3, { sourceGlobalSeq: 7, manifestMeta: meta }));
  expect(result.status).toBe("accepted");

  const after = openReadSnapshot(under.handle).token;
  expect(after.baseGeneration).toBe(before.baseGeneration + 1);
  expect(after.lastSyncedSequence).toBe(7);
  // The meta is keyed by the NEW generation, so a zero-op delta that skipped the
  // non-file writes would read back as no meta at all.
  expect(after.manifestMeta?.manifestHash).toBe(meta.manifestHash);
  expect(planeRows(under.handle).map((row) => row.changed_generation)).toEqual([1, 1, 1]);
  under.handle.close();
});

test("a delta whose predecessor moved is a retryable rejection, not a throw", () => {
  const under = workspace("rbox-delta-binding-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const stale: DeltaBinding = { ...liveBinding(under.handle), stateRevision: 0 };

  const result = applyCasPacket(under.handle, under.stages,
    deltaPacket(under, [{ kind: "upsert", entry: entry("d.txt", 4) }], 4, { binding: stale, sourceGlobalSeq: 6 }));
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") {
    expect(result.reason).toBe("delta-binding");
    result.retry.close();
  }
  expect(planeRows(under.handle).map((row) => row.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
  under.handle.close();
});

test("an equal-sequence second delta rejects on its spent binding", () => {
  const under = workspace("rbox-delta-double-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const binding = liveBinding(under.handle);
  const first = deltaPacket(under, [{ kind: "upsert", entry: entry("d.txt", 4) }], 4, { binding, sourceGlobalSeq: 6 });
  expect(applyCasPacket(under.handle, under.stages, first).status).toBe("accepted");

  // Everything else about the second packet is live — including the equal
  // sequence `cas-steps` deliberately admits. Only the binding is spent.
  const result = applyCasPacket(under.handle, under.stages,
    deltaPacket(under, [{ kind: "upsert", entry: entry("e.txt", 5) }], 5, { binding, sourceGlobalSeq: 6 }));
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") {
    expect(result.reason).toBe("delta-binding");
    result.retry.close();
  }
  under.handle.close();
});

test("a delete of a path the plane does not hold is refused, not silently absorbed", () => {
  const under = workspace("rbox-delta-delete-absent-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const packet = deltaPacket(under, [{ kind: "delete", path: "zz.txt" }], 3, { sourceGlobalSeq: 6 });

  expect(() => applyCasPacket(under.handle, under.stages, packet)).toThrow(StageChangedError);
  expect(planeRows(under.handle).map((row) => row.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
  expect(loadRawStateFromStore(under.handle).lastSyncedSequence).toBe(5);
  under.handle.close();
});

test("a forged resultFiles count fails the post-apply COUNT post-condition", () => {
  const under = workspace("rbox-delta-count-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const packet = deltaPacket(under, [{ kind: "upsert", entry: entry("d.txt", 4) }], 4, {
    resultFiles: 99, sourceGlobalSeq: 6,
  });

  expect(() => applyCasPacket(under.handle, under.stages, packet)).toThrow(StageChangedError);
  expect(planeRows(under.handle).map((row) => row.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
  under.handle.close();
});

test("a delta binding the packet and the artifact disagree on is never believed", () => {
  const under = workspace("rbox-delta-two-carrier-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const sealed = liveBinding(under.handle);
  const packet = deltaPacket(under, [], 3, {
    binding: sealed, claimedBinding: { ...sealed, stateRevision: sealed.stateRevision + 5 }, sourceGlobalSeq: 6,
  });

  expect(() => applyCasPacket(under.handle, under.stages, packet)).toThrow(StageChangedError);
  under.handle.close();
});

test("a delta artifact with no caller-minted binding is structurally inadmissible", () => {
  const under = workspace("rbox-delta-no-binding-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const packet = deltaPacket(under, [], 3, { sourceGlobalSeq: 6 });
  const { binding: _binding, ...withoutBinding } = packet.globalDelta!;

  expect(() => applyCasPacket(under.handle, under.stages, {
    ...packet,
    globalDelta: withoutBinding as typeof packet.globalDelta & object,
  })).toThrow(StageChangedError);
  under.handle.close();
});

test("a packet may not carry a complete global and a delta at once", () => {
  const under = workspace("rbox-delta-both-");
  const token = openReadSnapshot(under.handle).token;
  const delta = deltaPacket(under, [], 0, { sourceGlobalSeq: 5 });
  const complete = sealComplete(under.stages, BASE);

  expect(() => applyCasPacket(under.handle, under.stages, {
    ...delta, global: { stage: complete, fileHeader: complete.header },
    repoTransitions: sealTransitions(under.stages, token, complete),
  })).toThrow(StageChangedError);
  under.handle.close();
});

test("a sealed delta mutated after publication is refused by the fused verification", () => {
  const under = workspace("rbox-delta-tamper-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const packet = deltaPacket(under, [{ kind: "upsert", entry: entry("d.txt", 4) }], 4, { sourceGlobalSeq: 6 });
  const artifact = sealedStagePath(under.stages, packet.globalDelta!.stage.stageId, packet.globalDelta!.stage.logicalDigest);
  const bytes = fs.readFileSync(artifact);
  const offset = bytes.indexOf(Buffer.from("d.txt"));
  expect(offset).toBeGreaterThan(0);
  bytes.write("q.txt", offset);
  fs.writeFileSync(artifact, bytes);

  expect(() => applyCasPacket(under.handle, under.stages, packet)).toThrow(StageChangedError);
  expect(planeRows(under.handle).map((row) => row.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
  under.handle.close();
});

test("a sealed delta survives a post-seal kill: it reaches S0 and still verifies", () => {
  const under = workspace("rbox-delta-post-seal-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  // The packet is composed and sealed here; nothing else in this test touches
  // the builder, which is exactly what a kill after `sealAndPublish` leaves.
  const packet = deltaPacket(under, [{ kind: "upsert", entry: entry("d.txt", 4) }], 4, { sourceGlobalSeq: 6 });
  const artifact = sealedStagePath(under.stages, packet.globalDelta!.stage.stageId, packet.globalDelta!.stage.logicalDigest);
  expect(fs.existsSync(artifact)).toBeTrue();
  expect(fs.existsSync(`${artifact}-wal`)).toBeFalse();
  expect(fs.existsSync(`${artifact}-shm`)).toBeFalse();

  expect(applyCasPacket(under.handle, under.stages, packet).status).toBe("accepted");
  expect(fs.existsSync(artifact)).toBeFalse();
  under.handle.close();
});

test("a recomposed delta re-upserting an already-landed value leaves its generation alone", () => {
  const under = workspace("rbox-delta-changed-generation-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const changed = entry("b.txt", 9);
  expect(applyCasPacket(under.handle, under.stages,
    deltaPacket(under, [{ kind: "upsert", entry: changed }], 3, { sourceGlobalSeq: 6 })).status).toBe("accepted");
  const landed = planeRows(under.handle);
  expect(landed.find((row) => row.path === "b.txt")?.changed_generation).toBe(2);

  expect(applyCasPacket(under.handle, under.stages,
    deltaPacket(under, [{ kind: "upsert", entry: changed }], 3, { sourceGlobalSeq: 7 })).status).toBe("accepted");
  expect(planeRows(under.handle)).toEqual(landed);
  under.handle.close();
});

test("the delta builder refuses out-of-order and duplicated paths before any row exists", () => {
  const under = workspace("rbox-delta-order-");
  const binding = liveBinding(under.handle);

  const descending = beginDeltaStage(under.stages, "base", HEADER, binding);
  descending.putUpsert(entry("b.txt", 1));
  expect(() => descending.putUpsert(entry("a.txt", 2))).toThrow("strictly after");
  descending.discardDeltaStage();

  const duplicated = beginDeltaStage(under.stages, "base", HEADER, binding);
  duplicated.putUpsert(entry("a.txt", 1));
  expect(() => duplicated.putDelete("a.txt")).toThrow("strictly after");
  duplicated.discardDeltaStage();
  under.handle.close();
});

test("a delta and a forced-complete save of the same result produce identical plane rows", () => {
  const viaDelta = workspace("rbox-delta-differential-delta-");
  const viaComplete = workspace("rbox-delta-differential-complete-");
  expect(completeSave(viaDelta, BASE, 5).status).toBe("accepted");
  expect(completeSave(viaComplete, BASE, 5).status).toBe("accepted");
  const next = [entry("a.txt", 1), entry("b.txt", 9), entry("d.txt", 4)];

  expect(applyCasPacket(viaDelta.handle, viaDelta.stages, deltaPacket(viaDelta, [
    { kind: "upsert", entry: entry("b.txt", 9) },
    { kind: "delete", path: "c.txt" },
    { kind: "upsert", entry: entry("d.txt", 4) },
  ], next.length, { sourceGlobalSeq: 6 })).status).toBe("accepted");
  expect(completeSave(viaComplete, next, 6).status).toBe("accepted");

  expect(planeRows(viaDelta.handle)).toEqual(planeRows(viaComplete.handle));
  expect(loadRawStateFromStore(viaDelta.handle).lastSyncedManifest)
    .toEqual(loadRawStateFromStore(viaComplete.handle).lastSyncedManifest);
  viaDelta.handle.close();
  viaComplete.handle.close();
});

test("a complete stage offered as a delta is refused in this seam's own taxonomy", () => {
  const under = workspace("rbox-delta-wrong-kind-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const complete = sealComplete(under.stages, BASE);
  const token = openReadSnapshot(under.handle).token;
  // A `stage-semantic-v1` artifact has no delta_meta table at all.
  const offered: ForgedDeltaStageRef = {
    ...complete, binding: liveBinding(under.handle), counts: { upserts: 0, deletes: 0, resultFiles: 3 },
  };

  expect(() => applyCasPacket(under.handle, under.stages, {
    expected: expectation(token),
    sourceGlobalSeq: 6,
    globalDelta: {
      stage: offered as SealedDeltaStageRef,
      fileHeader: complete.header,
      binding: offered.binding,
    },
    repoTransitions: sealTransitions(under.stages, token, complete),
    ownerToken: OWNER,
  })).toThrow(StageChangedError);
  under.handle.close();
});

test("the sealed binding bytes are the authority, not the ref that names them", () => {
  const under = workspace("rbox-delta-sealed-binding-");
  expect(completeSave(under, BASE, 5).status).toBe("accepted");
  const sealed = liveBinding(under.handle);
  const packet = deltaPacket(under, [{ kind: "upsert", entry: entry("d.txt", 4) }], 4, { sourceGlobalSeq: 6 });
  const artifact = sealedStagePath(under.stages, packet.globalDelta!.stage.stageId, packet.globalDelta!.stage.logicalDigest);
  const forged = { nonce: sealed.nonce, stateRevision: sealed.stateRevision + 1 };
  const database = new Database(artifact, { readwrite: true });
  database.exec("PRAGMA journal_mode=DELETE");
  database.run("UPDATE delta_meta SET binding_cjson=?", canonicalBinding(forged));
  database.close();
  const physicalSha256 = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");

  // Ref still claims the original binding: the artifact's bytes disagree.
  expect(() => applyCasPacket(under.handle, under.stages, {
    ...packet,
    globalDelta: { ...packet.globalDelta!, stage: { ...packet.globalDelta!.stage, physicalSha256 } },
  })).toThrow(StageChangedError);
  // Ref updated to the forged binding: the digest covers it, so it still fails.
  expect(() => applyCasPacket(under.handle, under.stages, {
    ...packet,
    globalDelta: {
      ...packet.globalDelta!,
      stage: { ...packet.globalDelta!.stage, physicalSha256, binding: forged },
      binding: forged,
    },
  })).toThrow(StageChangedError);
  expect(planeRows(under.handle).map((row) => row.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
  under.handle.close();
});
