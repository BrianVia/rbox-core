/** The design's CAS operation table, row by row, plus the retry protocol, the
 * bounded-window rules, and the LOCAL-plane transactions. */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry, GitSection } from "../../../engine/index.js";
import { carryRepoBaseProof } from "../../sync-git/base-composer.js";
import type { GlobalManifestMeta, RepoRecordInput } from "../../sync-state-model.js";
import { loadRawStateFromStore } from "../adapters/read-only.js";
import { CursorWindowError, RepoRecordOversizeError, TransitionRowOversizeError } from "../errors.js";
import type { CasRejectionReason, CasResult, LineageSnapshot, ManifestHeader } from "../ports.js";
import { beginGeneration, type SealedStageRef } from "./generations.js";
import { applyLocalScan, invalidateLocalPlane } from "./local-plane.js";
import { createStateStore, openStateStore, stateStoreDatabase, type StateStoreHandle } from "./open.js";
import { openReadSnapshot } from "./read-snapshot.js";
import { beginRepoTransitionStage, type SealedRepoTransitionRef } from "./transition-stages.js";
import { applyCasPacket, ensureTelemetryBindingId, type CasExpectation, type CasPacket } from "./write-packet.js";

const roots: string[] = [];
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const STREAM = "workspace/163";
const OWNER = { isOwner: () => true };
const HEADER: ManifestHeader = { generatedAt: "2026-07-28T10:00:00.000Z", manifestSchema: 2, complete: true };

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

function workspace(prefix: string): { root: string; stages: string; handle: StateStoreHandle } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const handle = createStateStore(path.join(root, "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  });
  return { root, stages: path.join(root, "stages"), handle };
}

function entry(name: string, seed: number): FileEntry {
  return {
    path: name, sha256: hex(64, seed), size: seed, mode: 0o644,
    mtimeMs: seed + 0.5, type: "file",
  } as FileEntry;
}

function section(seed: number): GitSection {
  return {
    bundleSha: hex(64, seed + 1), bundleEncSha: hex(64, seed + 2), bundleCipherSize: seed + 10,
    head: hex(40, seed + 3), refs: {}, config: {}, refScope: "all",
    generatedAt: "2026-07-28T00:00:00.000Z",
  } as GitSection;
}

function expectation(token: LineageSnapshot): CasExpectation {
  return {
    lineageId: token.lineageId, stream: token.stream, nonce: token.nonce ?? "legacy",
    stateRevision: token.stateRevision ?? 0, baseGeneration: token.baseGeneration,
    localRevision: token.localRevision,
  };
}

function sealGlobal(stages: string, files: FileEntry[], plane: "base" | "local" = "base"): SealedStageRef {
  const builder = beginGeneration(stages, plane, HEADER);
  builder.putEntries(files);
  return builder.finishGeneration({ files: files.length, gitSections: 0 });
}

function sealTransitions(
  stages: string,
  token: LineageSnapshot,
  global: SealedStageRef | undefined,
  rows: Array<{ relPath: string; expectedRepoGen: number; newRecord: RepoRecordInput; proof?: boolean }>,
): SealedRepoTransitionRef {
  const bindings = global
    ? [{ stageId: global.stageId, logicalDigest: global.logicalDigest, physicalSha256: global.physicalSha256 }]
    : [];
  const builder = beginRepoTransitionStage(stages, token, bindings);
  for (const row of rows) {
    builder.putTransition({
      relPath: row.relPath,
      expectedRepoGen: row.expectedRepoGen,
      newRecord: row.newRecord,
      ...(row.proof ?? row.newRecord.base !== undefined ? { baseProof: carryRepoBaseProof("lineage") } : {}),
      evidenceBindings: { sourceStages: bindings },
    });
  }
  return builder.finishRepoTransitionStage();
}

function packet(
  stages: string,
  handle: StateStoreHandle,
  options: {
    expected?: Partial<CasExpectation>;
    files?: FileEntry[];
    sourceGlobalSeq?: number;
    manifestMeta?: GlobalManifestMeta;
    rows?: Array<{ relPath: string; expectedRepoGen: number; newRecord: RepoRecordInput; proof?: boolean }>;
    global?: boolean;
    owner?: { isOwner: () => boolean };
  } = {},
): CasPacket {
  const live = openReadSnapshot(handle).token;
  const expected = { ...expectation(live), ...options.expected };
  // A caller holding a stale expectation planned its transitions against that same
  // stale token, so the harness moves both together.
  const token: LineageSnapshot = {
    ...live,
    lineageId: expected.lineageId,
    stream: expected.stream,
    ...(expected.nonce === "legacy" ? { nonce: undefined } : { nonce: expected.nonce }),
    stateRevision: expected.stateRevision,
    baseGeneration: expected.baseGeneration,
    localRevision: expected.localRevision,
  };
  if (expected.nonce === "legacy") delete token.nonce;
  const withGlobal = options.global ?? true;
  const global = withGlobal ? sealGlobal(stages, options.files ?? [entry("one.txt", 1)]) : undefined;
  return {
    expected,
    sourceGlobalSeq: options.sourceGlobalSeq ?? 5,
    ...(global
      ? { global: { stage: global, fileHeader: HEADER, ...(options.manifestMeta ? { manifestMeta: options.manifestMeta } : {}) } }
      : {}),
    repoTransitions: sealTransitions(stages, token, global, options.rows ?? []),
    ownerToken: options.owner ?? OWNER,
  };
}

function expectRejected(result: CasResult, reason: CasRejectionReason): void {
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") return;
  expect(result.reason).toBe(reason);
  result.retry.close();
}

test("every rejection reason in the operation table is reachable and lands nothing", () => {
  const { stages, handle } = workspace("rbox-cas-table-");
  const before = loadRawStateFromStore(handle);

  expectRejected(applyCasPacket(handle, stages, packet(stages, handle, { expected: { lineageId: "f".repeat(32) } })), "lineage");
  expectRejected(applyCasPacket(handle, stages, packet(stages, handle, { expected: { stream: "other" } })), "stream");
  expectRejected(applyCasPacket(handle, stages, packet(stages, handle, { expected: { nonce: "legacy" } })), "nonce");
  expectRejected(applyCasPacket(handle, stages, packet(stages, handle, { expected: { stateRevision: 7 } })), "state-revision");
  expectRejected(applyCasPacket(handle, stages, packet(stages, handle, { expected: { baseGeneration: 3 } })), "base-generation");
  expectRejected(applyCasPacket(handle, stages, packet(stages, handle, { expected: { localRevision: 3 } })), "local-revision");
  expectRejected(applyCasPacket(handle, stages, packet(stages, handle, {
    rows: [{ relPath: "repo", expectedRepoGen: 4, newRecord: { sourceSeq: 5 } }],
  })), "repo-generation");
  expectRejected(applyCasPacket(handle, stages, packet(stages, handle, { owner: { isOwner: () => false } })), "owner-lost");

  expect(applyCasPacket(handle, stages, packet(stages, handle, { sourceGlobalSeq: 5 })).status).toBe("accepted");
  // sourceGlobalSeq equal to lastSyncedSequence is explicitly allowed; strictly
  // older is the only global-sequence rejection.
  expect(applyCasPacket(handle, stages, packet(stages, handle, { sourceGlobalSeq: 5 })).status).toBe("accepted");
  expectRejected(applyCasPacket(handle, stages, packet(stages, handle, { sourceGlobalSeq: 4 })), "global-sequence");

  const after = loadRawStateFromStore(handle);
  expect(after.lastSyncedSequence).toBe(5);
  expect(after.stateRevision).toBe(2);
  expect(before.stateRevision).toBe(0);
  handle.close();
});

test("a read-only store reports unsupported instead of attempting a write", () => {
  const { root, stages, handle } = workspace("rbox-cas-readonly-");
  const built = packet(stages, handle, {});
  handle.close();
  const readonly = openStateStore(path.join(root, "state.db"), { readonly: true });
  const result = applyCasPacket(readonly, stages, built);
  expect(result.status).toBe("unsupported");
  readonly.close();
});

test("a competing writer makes the CAS busy rather than blocking or half-applying", () => {
  const { root, stages, handle } = workspace("rbox-cas-busy-");
  const built = packet(stages, handle, {});
  const competitor = new Database(path.join(root, "state.db"), { create: false, readwrite: true });
  competitor.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  try {
    stateStoreDatabase(handle).exec("PRAGMA busy_timeout=50");
    const result = applyCasPacket(handle, stages, built);
    expect(result.status).toBe("busy");
  } finally {
    competitor.exec("ROLLBACK");
    competitor.close();
  }
  expect(loadRawStateFromStore(handle).stateRevision).toBe(0);
  handle.close();
});

test("a rejection returns only the touched repositories, frozen under one token", () => {
  const { stages, handle } = workspace("rbox-cas-retry-");
  expect(applyCasPacket(handle, stages, packet(stages, handle, {
    rows: [
      { relPath: "repo-a", expectedRepoGen: 0, newRecord: { sourceSeq: 5, base: section(20) } },
      { relPath: "repo-b", expectedRepoGen: 0, newRecord: { sourceSeq: 5, removedKey: "gone" } },
    ],
  })).status).toBe("accepted");

  const stale = applyCasPacket(handle, stages, packet(stages, handle, {
    rows: [
      { relPath: "repo-a", expectedRepoGen: 0, newRecord: { sourceSeq: 6 }, proof: true },
      { relPath: "repo-missing", expectedRepoGen: 0, newRecord: { sourceSeq: 6 } },
    ],
  }));
  expect(stale.status).toBe("rejected");
  if (stale.status !== "rejected") return;
  expect(stale.reason).toBe("repo-generation");
  const page = stale.retry.touchedRepos(undefined, 16);
  expect(page.done).toBe(true);
  expect(page.rows.map((row) => row.relPath)).toEqual(["repo-a", "repo-missing"]);
  expect(page.rows[0]!.record!.repoGen).toBe(1);
  // A path with no authority record is reported with no record at all — never as
  // a synthesized one, and never by rematerializing anything untouched.
  expect(page.rows[1]!.record).toBeUndefined();
  expect(() => stale.retry.touchedRepos(undefined, 17)).toThrow(CursorWindowError);

  // The view is frozen: a concurrent authority write cannot tear a page already
  // promised under the token the view reports.
  stateStoreDatabase(handle).query("UPDATE repo_records SET repo_gen=99 WHERE rel_path='repo-a'").run();
  expect(stale.retry.touchedRepos(undefined, 16).rows[0]!.record!.repoGen).toBe(1);
  expect(stale.retry.token.stateRevision).toBe(1);
  stale.retry.close();
  expect(() => stale.retry.touchedRepos(undefined, 16)).toThrow();

  // The design's at-most-three recompute loop: page the view into a new stage.
  stateStoreDatabase(handle).query("UPDATE repo_records SET repo_gen=1 WHERE rel_path='repo-a'").run();
  const token = openReadSnapshot(handle).token;
  const retried = applyCasPacket(handle, stages, {
    expected: expectation(token),
    sourceGlobalSeq: 6,
    repoTransitions: sealTransitions(stages, token, undefined, [
      { relPath: "repo-a", expectedRepoGen: 1, newRecord: { sourceSeq: 6 }, proof: true },
      { relPath: "repo-missing", expectedRepoGen: 0, newRecord: { sourceSeq: 6 } },
    ]),
    ownerToken: OWNER,
  });
  expect(retried.status).toBe("accepted");
  expect(loadRawStateFromStore(handle).repoRecords!["repo-a"]!.repoGen).toBe(2);
  handle.close();
});

test("manifest-chain closure is enforced at admission, not merely assumed by readers", () => {
  const { stages, handle } = workspace("rbox-cas-chain-");
  const base = {
    encManifestSha: hex(64, 900), manifestHash: hex(64, 901), accountEpoch: 1, keyEpoch: 2,
    chain: [] as string[], chainBytes: 0, snapshotBytes: 4096, gitRepos: {},
  } satisfies GlobalManifestMeta;
  const refuse = (meta: GlobalManifestMeta) =>
    expect(() => applyCasPacket(handle, stages, packet(stages, handle, { manifestMeta: meta })))
      .toThrow("not a valid GlobalManifestMeta");

  refuse({ ...base, chain: [hex(64, 902)], chainBytes: 0 });
  refuse({ ...base, chainBytes: 1 });
  // Self-exclusion: the chain may never contain the manifest it belongs to.
  refuse({ ...base, chain: [base.encManifestSha], chainBytes: 1 });
  refuse({ ...base, chain: [hex(64, 903), hex(64, 903)], chainBytes: 1 });
  refuse({ ...base, chain: Array.from({ length: 17 }, (_, index) => hex(64, 950 + index)), chainBytes: 1 });

  expect(applyCasPacket(handle, stages, packet(stages, handle, {
    manifestMeta: { ...base, chain: [hex(64, 902), hex(64, 903)], chainBytes: 8192 },
  })).status).toBe("accepted");
  expect(loadRawStateFromStore(handle).manifestMeta!.chain).toEqual([hex(64, 902), hex(64, 903)]);
  handle.close();
});

test("cursor and row windows are refused rather than clamped", () => {
  const { stages, handle } = workspace("rbox-cas-windows-");
  const builder = beginGeneration(stages, "base", HEADER);
  expect(() => builder.putEntries(Array.from({ length: 513 }, (_, index) => entry(`f${index}`, index + 1))))
    .toThrow(CursorWindowError);
  builder.discardGeneration();

  const token = openReadSnapshot(handle).token;
  const transitions = beginRepoTransitionStage(stages, token, []);
  // A record inside the 4 MiB record ceiling can still make an oversize row once
  // its proof is counted; the row scanner refuses it first.
  expect(() => transitions.putTransition({
    relPath: "huge-row",
    expectedRepoGen: 0,
    newRecord: { sourceSeq: 1, idxProj: "x".repeat(3 * 1024 * 1024) },
    baseProof: carryRepoBaseProof("y".repeat(6 * 1024 * 1024)),
    evidenceBindings: { sourceStages: [] },
  })).toThrow(TransitionRowOversizeError);
  expect(() => transitions.putTransition({
    relPath: "huge-record",
    expectedRepoGen: 0,
    newRecord: { sourceSeq: 1, idxProj: "x".repeat(5 * 1024 * 1024) },
    evidenceBindings: { sourceStages: [] },
  })).toThrow(RepoRecordOversizeError);
  transitions.discard();
  handle.close();
});

test("interning keeps unchanged paths untouched while the set-difference stamps the rest", () => {
  const { stages, handle } = workspace("rbox-cas-intern-");
  const db = stateStoreDatabase(handle);
  expect(applyCasPacket(handle, stages, packet(stages, handle, {
    files: [entry("keep.txt", 1), entry("drop.txt", 2), entry("edit.txt", 3)],
  })).status).toBe("accepted");
  const first = db.query("SELECT path,entry_id,changed_generation FROM plane_entries WHERE plane='base' ORDER BY path")
    .all() as Array<{ path: string; entry_id: string; changed_generation: number }>;
  expect(first.map((row) => row.path)).toEqual(["drop.txt", "edit.txt", "keep.txt"]);

  expect(applyCasPacket(handle, stages, packet(stages, handle, {
    files: [entry("keep.txt", 1), entry("edit.txt", 4), entry("new.txt", 5)],
  })).status).toBe("accepted");
  const second = db.query("SELECT path,entry_id,changed_generation FROM plane_entries WHERE plane='base' ORDER BY path")
    .all() as Array<{ path: string; entry_id: string; changed_generation: number }>;
  expect(second.map((row) => row.path)).toEqual(["edit.txt", "keep.txt", "new.txt"]);
  const keepBefore = first.find((row) => row.path === "keep.txt")!;
  const keepAfter = second.find((row) => row.path === "keep.txt")!;
  expect(keepAfter.entry_id).toBe(keepBefore.entry_id);
  expect(keepAfter.changed_generation).toBe(keepBefore.changed_generation);
  expect(second.find((row) => row.path === "edit.txt")!.changed_generation).toBe(2);
  handle.close();
});

test("promotion of a large stage does not scale heap with authority size", () => {
  const { stages, handle } = workspace("rbox-cas-bounded-");
  const total = 20_000;
  const builder = beginGeneration(stages, "base", HEADER);
  for (let offset = 0; offset < total; offset += 512) {
    builder.putEntries(Array.from({ length: Math.min(512, total - offset) }, (_, index) =>
      entry(`files/${String(offset + index).padStart(6, "0")}.txt`, offset + index + 1)));
  }
  const stage = builder.finishGeneration({ files: total, gitSections: 0 });
  const token = openReadSnapshot(handle).token;
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  const result = applyCasPacket(handle, stages, {
    expected: expectation(token),
    sourceGlobalSeq: 1,
    global: { stage, fileHeader: HEADER },
    repoTransitions: sealTransitions(stages, token, stage, []),
    ownerToken: OWNER,
  });
  Bun.gc(true);
  const growth = process.memoryUsage().heapUsed - before;
  expect(result.status).toBe("accepted");
  expect(stateStoreDatabase(handle).query("SELECT count(*) AS n FROM plane_entries").get())
    .toEqual({ n: total });
  // Materializing 20k decoded entries costs tens of MiB; a cursor-first promotion
  // holds one row at a time.
  expect(growth).toBeLessThan(16 * 1024 * 1024);
  handle.close();
});

test("LOCAL scans and watcher invalidation move the LOCAL head without touching BASE", () => {
  const { stages, handle } = workspace("rbox-cas-local-");
  expect(openReadSnapshot(handle).token.localHeader.complete).toBe(false);
  const stage = sealGlobal(stages, [entry("scan.txt", 1)], "local");
  const scanned = applyLocalScan(handle, stages, stage,
    { ...HEADER, trustEpoch: "epoch-1" }, { lineageId: LINEAGE, localRevision: 0 });
  expect(scanned.localRevision).toBe(1);
  expect(scanned.token.localHeader.complete).toBe(true);
  expect(scanned.token.localHeader.trustEpoch).toBe("epoch-1");
  expect(scanned.token.baseGeneration).toBe(0);
  expect(openReadSnapshot(handle).files("local", undefined, 512).rows.map((file) => file.path)).toEqual(["scan.txt"]);

  const invalidated = invalidateLocalPlane(handle, LINEAGE);
  expect(invalidated.localRevision).toBe(2);
  expect(invalidated.token.localHeader.complete).toBe(false);
  expect(invalidated.token.localHeader.trustEpoch).toBeUndefined();
  expect(openReadSnapshot(handle).files("base", undefined, 512).rows).toEqual([]);
  handle.close();
});

test("telemetry binding is a singleton transaction that preserves stateRevision", () => {
  const { stages, handle } = workspace("rbox-cas-telemetry-");
  expect(applyCasPacket(handle, stages, packet(stages, handle, {})).status).toBe("accepted");
  const before = openReadSnapshot(handle).token;
  const binding = ensureTelemetryBindingId(handle, STREAM);
  expect(binding).toMatch(/^[0-9a-f]{16}$/);
  expect(ensureTelemetryBindingId(handle, STREAM)).toBe(binding);
  const after = openReadSnapshot(handle).token;
  expect(after.stateRevision).toBe(before.stateRevision);
  expect(after.telemetryBindingId).toBe(binding);
  expect(() => ensureTelemetryBindingId(handle, "other")).toThrow();
  handle.close();
});
