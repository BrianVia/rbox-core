/** Design 269 §3 riders: consumption verifies in the SAME pass it copies (R2',
 * both stage kinds), and interned identity is minted in SQL for new values only
 * (R3). Every refusal the two-pass consumption used to raise must still fire. */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { FileEntry } from "../../../engine/index.js";
import { StageChangedError } from "../errors.js";
import type { LineageSnapshot, ManifestHeader } from "../ports.js";
import { beginGeneration } from "./generations.js";
import { applyLocalScan } from "./local-plane.js";
import { createStateStore, stateStoreDatabase, type StateStoreHandle } from "./open.js";
import { openReadSnapshot } from "./read-snapshot.js";
import type { SealedStageRef } from "./sealed-stages.js";
import { sealedStagePath } from "./stage-artifacts.js";
import { selectRows } from "./statements.js";
import { beginRepoTransitionStage } from "./transition-stages.js";
import { applyCasPacket, type CasExpectation, type CasPacket } from "./write-packet.js";
import { casOwnerTokenForTest } from "./owner-token-testkit.js";

const roots: string[] = [];
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const STREAM = "workspace/269-riders";
const OWNER = casOwnerTokenForTest(() => true);
const HEADER: ManifestHeader = { generatedAt: "2026-08-16T10:00:00.000Z", manifestSchema: 2, complete: true };
const LOCAL_HEADER: ManifestHeader = { ...HEADER, trustEpoch: "epoch-269" };

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

function sealStage(stages: string, files: readonly FileEntry[], plane: "base" | "local" = "base"): SealedStageRef {
  const builder = beginGeneration(stages, plane, plane === "local" ? LOCAL_HEADER : HEADER);
  builder.putEntries([...files]);
  return builder.finishGeneration({ files: files.length, gitSections: 0 });
}

function globalPacket(stages: string, handle: StateStoreHandle, stage: SealedStageRef): CasPacket {
  const token = openReadSnapshot(handle).token;
  const bindings = [{ stageId: stage.stageId, logicalDigest: stage.logicalDigest, physicalSha256: stage.physicalSha256 }];
  const builder = beginRepoTransitionStage(stages, token, bindings, { globalBinding: bindings[0]! });
  return {
    expected: expectation(token),
    sourceGlobalSeq: 5,
    global: { stage, fileHeader: stage.header },
    repoTransitions: builder.finishRepoTransitionStage(),
    ownerToken: OWNER,
  };
}

/** Rewrite a published artifact in place and return its new physical hash, so a
 * ref can name the mutated bytes truthfully. The logical proof is then the ONLY
 * thing standing between the mutation and the authority. */
function mutateSealed(file: string, mutate: (db: Database) => void): string {
  const db = new Database(file, { readwrite: true });
  db.exec("PRAGMA journal_mode=DELETE");
  mutate(db);
  db.close();
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("a stale digest column on a BASE stage is refused before any row is consumed", () => {
  const { stages, handle } = workspace("rbox-fused-base-");
  const stage = sealStage(stages, [entry("a.txt", 1)]);
  const packet = globalPacket(stages, handle, stage);
  const artifact = sealedStagePath(stages, stage.stageId, stage.logicalDigest);
  const physicalSha256 = mutateSealed(artifact, (db) => {
    db.run("UPDATE stage_meta SET digest=?", hex(64, 0xbad));
  });

  expect(() => applyCasPacket(handle, stages, {
    ...packet, global: { ...packet.global!, stage: { ...stage, physicalSha256 } },
  })).toThrow(StageChangedError);
  expect(openReadSnapshot(handle).token.baseGeneration).toBe(0);
  handle.close();
});

test("a BASE stage whose rows changed under an intact digest column fails at end-of-stream", () => {
  const { stages, handle } = workspace("rbox-fused-rows-");
  const stage = sealStage(stages, [entry("a.txt", 1), entry("b.txt", 2)]);
  const packet = globalPacket(stages, handle, stage);
  const artifact = sealedStagePath(stages, stage.stageId, stage.logicalDigest);
  const physicalSha256 = mutateSealed(artifact, (db) => {
    db.run("UPDATE stage_entries SET entry_cjson=replace(entry_cjson,'\"size\":2','\"size\":3') WHERE path='b.txt'");
  });

  expect(() => applyCasPacket(handle, stages, {
    ...packet, global: { ...packet.global!, stage: { ...stage, physicalSha256 } },
  })).toThrow(StageChangedError);
  expect(openReadSnapshot(handle).token.baseGeneration).toBe(0);
  handle.close();
});

test("the LOCAL scan consumes through the same fused verification", () => {
  const { stages, handle } = workspace("rbox-fused-local-");
  const clean = sealStage(stages, [entry("a.txt", 1)], "local");
  const before = openReadSnapshot(handle).token;
  expect(applyLocalScan(handle, stages, clean, { lineageId: LINEAGE, localRevision: before.localRevision }).localRevision)
    .toBe(before.localRevision + 1);

  const tampered = sealStage(stages, [entry("a.txt", 1), entry("b.txt", 2)], "local");
  const artifact = sealedStagePath(stages, tampered.stageId, tampered.logicalDigest);
  const physicalSha256 = mutateSealed(artifact, (db) => {
    db.run("DELETE FROM stage_entries WHERE path='b.txt'");
  });
  expect(() => applyLocalScan(handle, stages, { ...tampered, physicalSha256 },
    { lineageId: LINEAGE, localRevision: before.localRevision + 1 })).toThrow(StageChangedError);
  expect(openReadSnapshot(handle).token.localRevision).toBe(before.localRevision + 1);
  handle.close();
});

test("interned ids are minted in SQL, unique, and reused for identical values", () => {
  const { stages, handle } = workspace("rbox-fused-intern-");
  expect(applyCasPacket(handle, stages, globalPacket(stages, handle,
    sealStage(stages, [entry("a.txt", 1), entry("b.txt", 2)]))).status).toBe("accepted");
  const first = selectRows<{ entry_id: string; path: string }>(stateStoreDatabase(handle),
    "SELECT entry_id,path FROM entry_values ORDER BY path");
  expect(first).toHaveLength(2);
  expect(new Set(first.map((row) => row.entry_id)).size).toBe(2);
  for (const row of first) expect(row.entry_id).toMatch(/^[0-9a-f]{32}$/);

  // The same two values plus one new one: interning is by value, so the two
  // existing ids must survive untouched.
  expect(applyCasPacket(handle, stages, globalPacket(stages, handle,
    sealStage(stages, [entry("a.txt", 1), entry("b.txt", 2), entry("c.txt", 3)]))).status).toBe("accepted");
  const second = selectRows<{ entry_id: string; path: string }>(stateStoreDatabase(handle),
    "SELECT entry_id,path FROM entry_values ORDER BY path");
  expect(second).toHaveLength(3);
  expect(second.slice(0, 2)).toEqual(first);
  handle.close();
});
