/**
 * Containment and lifecycle.
 *
 * The properties under test are the two the withdrawn attempt and the first review
 * round both missed: (a) no pathname an attacker can name is reopened after
 * verification, so swapping the shared name cannot change what a consumer reads;
 * and (b) every owned interval ends with no lock, no private directory, and no
 * orphaned artifact — on success, on refusal, and on adoption.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry } from "../../../engine/index.js";
import { StageChangedError } from "../errors.js";
import type { LineageSnapshot, ManifestHeader } from "../ports.js";
import { beginGeneration } from "./generations.js";
import { applyLocalScan } from "./local-plane.js";
import { createStateStore, stateStoreDatabase, type StateStoreHandle } from "./open.js";
import { openReadSnapshot } from "./read-snapshot.js";
import { openSealedStage, type SealedStageRef } from "./sealed-stages.js";
import {
  StageLock, deleteSealedArtifact, openSealedArtifact, privateDirectoryPath, sealedStagePath,
  stageLockPath,
} from "./stage-artifacts.js";
import { beginRepoTransitionStage } from "./transition-stages.js";
import { applyCasPacket, type CasPacket } from "./write-packet.js";
import { casOwnerTokenForTest } from "./owner-token-testkit.js";

const roots: string[] = [];
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const HEADER: ManifestHeader = { generatedAt: "2026-07-28T10:00:00.000Z", complete: true };
const OWNER = casOwnerTokenForTest(() => true);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

function workspace(prefix: string): { root: string; stages: string; handle: StateStoreHandle } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const handle = createStateStore(path.join(root, "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: "stream",
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  });
  return { root, stages: path.join(root, "stages"), handle };
}

const entry = (name: string, seed: number): FileEntry =>
  ({ path: name, sha256: hex(64, seed), size: seed, mode: 0o644, mtimeMs: seed, type: "file" } as FileEntry);

function seal(stages: string, files: FileEntry[], header: ManifestHeader = HEADER, plane: "base" | "local" = "base"): SealedStageRef {
  const builder = beginGeneration(stages, plane, header);
  builder.putEntries(files);
  return builder.finishGeneration({ files: files.length, gitSections: 0 });
}

/** `staleRevision` moves the packet's expectation AND the token its transition
 * stage is planned against, exactly as a caller holding a stale snapshot would. */
function casPacket(
  stages: string,
  handle: StateStoreHandle,
  stage: SealedStageRef,
  staleRevision?: number,
): CasPacket {
  const live: LineageSnapshot = openReadSnapshot(handle).token;
  const token: LineageSnapshot = staleRevision === undefined ? live : { ...live, stateRevision: staleRevision };
  const binding = { stageId: stage.stageId, logicalDigest: stage.logicalDigest, physicalSha256: stage.physicalSha256 };
  const builder = beginRepoTransitionStage(stages, token, [binding], { globalBinding: binding });
  builder.putTransition({
    relPath: "repo", expectedRepoGen: 0, newRecord: { sourceSeq: 1, removedKey: "gone" },
    evidenceBindings: { sourceStages: [binding] },
  });
  return {
    expected: {
      lineageId: token.lineageId, stream: token.stream, nonce: token.nonce ?? "legacy",
      stateRevision: token.stateRevision ?? 0, baseGeneration: token.baseGeneration,
      localRevision: token.localRevision,
    },
    sourceGlobalSeq: 1,
    global: { stage, fileHeader: stage.header },
    repoTransitions: builder.finishRepoTransitionStage(),
    ownerToken: OWNER,
  };
}

/** Everything except the sealed artifacts this test still expects to exist. */
function residue(stages: string): string[] {
  return fs.readdirSync(stages).filter((name) => !name.endsWith(".sealed")).sort();
}

test("stage builders run in WAL and seal only with zero sidecars", () => {
  const { root, stages } = workspace("rbox-contain-wal-");
  const stage = seal(stages, [entry("one.txt", 1)]);
  const sealed = sealedStagePath(stages, stage.stageId, stage.logicalDigest);
  // S0 is a checked precondition of publication, not an assumption.
  for (const suffix of ["-wal", "-shm", "-journal"]) expect(fs.existsSync(`${sealed}${suffix}`)).toBe(false);
  // The artifact really is a WAL database; DELETE journaling would make S0 a
  // structural side effect rather than the normative checkpoint-then-check.
  const scratch = path.join(root, "scratch.db");
  fs.copyFileSync(sealed, scratch);
  const probe = new Database(scratch, { create: false, readonly: true });
  expect(String((probe.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase()).toBe("wal");
  probe.close();
});

test("swapping the shared pathname cannot change what a contained consumer reads", () => {
  const { stages, handle } = workspace("rbox-contain-swap-");
  const original = seal(stages, [entry("original.txt", 1)]);
  const impostor = seal(stages, [entry("impostor.txt", 2), entry("impostor2.txt", 3)]);
  const originalPath = sealedStagePath(stages, original.stageId, original.logicalDigest);
  const impostorPath = sealedStagePath(stages, impostor.stageId, impostor.logicalDigest);

  const proof = StageLock.acquire(stages, original.stageId);
  try {
    // The consumer's connection is bound to an ANONYMOUS inode: the private copy
    // and its WAL sidecars are unlinked once the priming read has materialized the
    // WAL index, so after this point no pathname at all reaches the bytes SQLite
    // reads — not the shared name, and not the private one either.
    const accessor = openSealedArtifact(stages, original, proof);
    try {
      const attached = accessor.db.query("PRAGMA database_list").get() as { file: string };
      expect(attached.file.startsWith(privateDirectoryPath(stages, original.stageId))).toBe(true);
      expect(attached.file).not.toBe(originalPath);
      expect(fs.existsSync(attached.file)).toBe(false);
      expect(fs.readdirSync(privateDirectoryPath(stages, original.stageId))).toEqual([]);
    } finally {
      accessor.close();
    }
  } finally {
    proof.release();
  }

  // Consumption leaves no private directory and no sidecar beside the artifact.
  expect(fs.existsSync(privateDirectoryPath(stages, original.stageId))).toBe(false);
  for (const suffix of ["-wal", "-shm", "-journal"]) expect(fs.existsSync(`${originalPath}${suffix}`)).toBe(false);
  expect(fs.existsSync(impostorPath)).toBe(true);
  handle.close();
});

/** Two stages built to the same shape so their artifacts are the same length: the
 * impostor differs only in the leading character of each path, so an in-place
 * overwrite is byte-for-byte substitutable and cannot be detected by size alone. */
function pagedStage(stages: string, marker: string, rows: number): SealedStageRef {
  const builder = beginGeneration(stages, "base", HEADER);
  for (let offset = 0; offset < rows; offset += 128) {
    builder.putEntries(Array.from({ length: Math.min(128, rows - offset) }, (_, index) => ({
      path: `${marker}/${String(offset + index).padStart(5, "0")}.txt`,
      sha256: hex(64, 1), size: 1, mode: 0o644, mtimeMs: 1, type: "file",
      padding: marker.repeat(512),
    } as unknown as FileEntry)));
  }
  return builder.finishGeneration({ files: rows, gitSections: 0 });
}

test("an in-place overwrite of an UNREAD page cannot reach a contained consumer", () => {
  const { stages, handle } = workspace("rbox-contain-unread-page-");
  const rows = 600;
  const original = pagedStage(stages, "aaaa", rows);
  const impostor = pagedStage(stages, "bbbb", rows);
  const originalPath = sealedStagePath(stages, original.stageId, original.logicalDigest);
  const impostorPath = sealedStagePath(stages, impostor.stageId, impostor.logicalDigest);
  const originalBytes = fs.readFileSync(originalPath);
  const impostorBytes = fs.readFileSync(impostorPath);
  // Many pages, and the two artifacts are interchangeable in length.
  expect(originalBytes.length).toBe(impostorBytes.length);
  expect(originalBytes.length).toBeGreaterThan(64 * 4096);

  const lock = StageLock.acquire(stages, original.stageId);
  const reader = openSealedStage(stages, original, lock);
  const seen: string[] = [];
  try {
    // Read ONE small window, so the overwhelming majority of leaf pages have not
    // been touched — nothing can be served from a page cache that never saw them.
    const first = reader.files(undefined, 16);
    seen.push(...first.rows.map((file) => file.path));
    expect(first.done).toBe(false);

    // Now overwrite the shared inode in place, between cursor windows. This is the
    // same inode a hard-link containment scheme would have handed to SQLite.
    const shared = fs.openSync(originalPath, "r+");
    try {
      fs.writeSync(shared, impostorBytes, 0, impostorBytes.length, 0);
      fs.fsyncSync(shared);
      expect(fs.readFileSync(originalPath).equals(impostorBytes)).toBe(true);

      // Page the REST of the stage while the shared bytes are the impostor's.
      let after = first.after;
      for (;;) {
        const page = reader.files(after, 16);
        seen.push(...page.rows.map((file) => file.path));
        if (page.done) break;
        after = page.after;
      }
      // Restore, exactly as an attacker would before any closing hash.
      fs.writeSync(shared, originalBytes, 0, originalBytes.length, 0);
      fs.fsyncSync(shared);
    } finally {
      fs.closeSync(shared);
      reader.close();
    }
  } finally {
    lock.release();
  }
  expect(seen).toHaveLength(rows);
  expect(seen.every((path) => path.startsWith("aaaa/"))).toBe(true);
  expect(seen.some((path) => path.startsWith("bbbb/"))).toBe(false);
  handle.close();
});

test("the id-scoped delete refuses a shared name that is no longer the proven inode", () => {
  const { stages } = workspace("rbox-lifecycle-delete-race-");
  const stage = seal(stages, [entry("one.txt", 1)]);
  const sealed = sealedStagePath(stages, stage.stageId, stage.logicalDigest);
  const originalLink = fs.linkSync;
  // Swap the shared name for a BYTE-IDENTICAL copy the instant after the inode is
  // pinned. The content proof still passes; only the dev/ino confirmation catches
  // it — which is why the delete confirms identity rather than trusting the hash.
  const link = spyOn(fs, "linkSync").mockImplementation((source, target) => {
    originalLink(source as string, target as string);
    const bytes = fs.readFileSync(sealed);
    fs.rmSync(sealed);
    fs.writeFileSync(sealed, bytes);
  });
  const lock = StageLock.acquire(stages, stage.stageId);
  try {
    expect(() => deleteSealedArtifact(stages, stage, lock))
      .toThrow("the shared name is no longer the inode this ref proves");
  } finally {
    link.mockRestore();
    lock.release();
  }
  // Refused, so the impostor is still there rather than silently removed.
  expect(fs.existsSync(sealed)).toBe(true);
  expect(fs.existsSync(privateDirectoryPath(stages, stage.stageId))).toBe(false);
});

test("artifact cleanup never unlinks the lock that authorizes it", () => {
  const { stages } = workspace("rbox-lifecycle-lock-");
  const stageId = "4".repeat(32);
  const lock = StageLock.acquire(stages, stageId);
  try {
    expect(fs.existsSync(stageLockPath(stages, stageId))).toBe(true);
    lock.sweepOwnedArtifacts();
    // Exclusivity must outlive the sweep: unlinking it here would let a second
    // owner start inside this interval, which is the whole point of the lock.
    expect(fs.existsSync(stageLockPath(stages, stageId))).toBe(true);
    lock.assertHeld();
    expect(() => StageLock.acquire(stages, stageId)).toThrow();
  } finally {
    lock.release();
  }
  expect(fs.existsSync(stageLockPath(stages, stageId))).toBe(false);
});

test("a sealing failure leaves no lock, no private directory, and no partial artifact", () => {
  const { stages } = workspace("rbox-lifecycle-seal-fail-");
  const stageId = "3".repeat(32);
  const first = seal(stages, [entry("one.txt", 1)], HEADER);
  expect(first.stageId).not.toBe(stageId);

  const reuseId = first.stageId;
  const builder = beginGeneration(stages, "base", HEADER, reuseId);
  builder.putEntries([entry("one.txt", 1)]);
  // The no-clobber refusal happens after commit, inside the seal sequence.
  expect(() => builder.finishGeneration({ files: 1, gitSections: 0 })).toThrow(StageChangedError);
  expect(fs.existsSync(stageLockPath(stages, reuseId))).toBe(false);
  expect(fs.existsSync(privateDirectoryPath(stages, reuseId))).toBe(false);
  expect(residue(stages)).toEqual([]);
  // The artifact that was already there is untouched and still consumable.
  const lock = StageLock.acquire(stages, first.stageId);
  try {
    const reader = openSealedStage(stages, first, lock);
    expect(reader.files(undefined, 512).rows).toHaveLength(1);
    reader.close();
  } finally {
    lock.release();
  }
});

test("a destination never survives a failed seal, even after a successful link", () => {
  const { stages } = workspace("rbox-lifecycle-fsync-");
  const originalFsync = fs.fsyncSync;
  const originalLink = fs.linkSync;
  const originalRm = fs.rmSync;
  // A trace seam, so the ORDER of the recovery steps is observable.
  const trace: string[] = [];
  let linked: string | undefined;
  let failed = false;
  const link = spyOn(fs, "linkSync").mockImplementation((source, target) => {
    originalLink(source as string, target as string);
    linked = target as string;
    trace.push("link");
  });
  const rm = spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (target === linked) trace.push("unlink");
    originalRm(target, options);
  });
  // Fail only the FIRST parent-directory flush after a successful publication;
  // the flush that follows the recovery unlink must still be attempted.
  const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
    if (linked !== undefined && !failed) {
      failed = true;
      throw new Error("simulated directory fsync failure");
    }
    if (linked !== undefined) trace.push("fsync-dir");
    originalFsync(fd);
  });
  try {
    const builder = beginGeneration(stages, "base", HEADER);
    builder.putEntries([entry("one.txt", 1)]);
    expect(() => builder.finishGeneration({ files: 1, gitSections: 0 })).toThrow("simulated directory fsync failure");
  } finally {
    fsync.mockRestore();
    rm.mockRestore();
    link.mockRestore();
  }
  expect(linked).toBeDefined();
  expect(fs.existsSync(linked!)).toBe(false);
  expect(fs.readdirSync(stages)).toEqual([]);
  // The removal is made durable: a crash after the unlink must not resurrect a
  // destination this seal already disowned.
  expect(trace.indexOf("unlink")).toBeGreaterThan(trace.indexOf("link"));
  expect(trace.slice(trace.indexOf("unlink"))).toContain("fsync-dir");
});

test("containment initialization never leaks a SQLite handle", () => {
  const { stages } = workspace("rbox-contain-leak-");
  const stage = seal(stages, [entry("one.txt", 1)]);
  const openDescriptors = (): number => fs.readdirSync("/proc/self/fd").length;
  const before = openDescriptors();
  const originalRm = fs.rmSync;
  // Fail the unlink that follows the priming read: the handle is already open, so
  // this is exactly the window in which it could be stranded on an inode nothing
  // can reach.
  const rm = spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (String(target).endsWith("/artifact")) throw new Error("simulated unlink failure");
    originalRm(target, options);
  });
  const lock = StageLock.acquire(stages, stage.stageId);
  try {
    expect(() => openSealedArtifact(stages, stage, lock)).toThrow("simulated unlink failure");
  } finally {
    rm.mockRestore();
    lock.release();
  }
  // A leaked handle would keep both the database and its WAL sidecars open.
  expect(openDescriptors()).toBeLessThanOrEqual(before);
  // …and the accessor registry is clean, so the artifact is consumable again.
  const retry = StageLock.acquire(stages, stage.stageId);
  try {
    const reader = openSealedStage(stages, stage, retry);
    expect(reader.files(undefined, 512).rows).toHaveLength(1);
    reader.close();
  } finally {
    retry.release();
  }
});

test("a destination that is not the proven inode is removed and sealing fails", () => {
  const { stages } = workspace("rbox-lifecycle-wrong-inode-");
  let published: string | undefined;
  // A "link" that produces a different inode is exactly what the post-link fstat
  // comparison exists to catch.
  const link = spyOn(fs, "linkSync").mockImplementation((source, target) => {
    fs.copyFileSync(source as string, target as string);
    published = target as string;
  });
  try {
    const builder = beginGeneration(stages, "base", HEADER);
    builder.putEntries([entry("one.txt", 1)]);
    expect(() => builder.finishGeneration({ files: 1, gitSections: 0 }))
      .toThrow("the published name is not the inode this builder proved");
  } finally {
    link.mockRestore();
  }
  expect(published).toBeDefined();
  expect(fs.existsSync(published!)).toBe(false);
  expect(fs.readdirSync(stages)).toEqual([]);
});

test("a discarded transition builder leaves no lock and no private directory", () => {
  const { stages, handle } = workspace("rbox-lifecycle-discard-");
  const token = openReadSnapshot(handle).token;
  const builder = beginRepoTransitionStage(stages, token, []);
  builder.putTransition({
    relPath: "repo", expectedRepoGen: 0, newRecord: { sourceSeq: 1 },
    evidenceBindings: { sourceStages: [] },
  });
  expect(fs.existsSync(privateDirectoryPath(stages, builder.stageId))).toBe(true);
  builder.discard();
  expect(fs.existsSync(stageLockPath(stages, builder.stageId))).toBe(false);
  expect(fs.existsSync(privateDirectoryPath(stages, builder.stageId))).toBe(false);
  expect(fs.readdirSync(stages)).toEqual([]);
  handle.close();
});

test("adopted and refused stages are deleted with an id-scoped, identity-proven delete", () => {
  const { stages, handle } = workspace("rbox-lifecycle-adopt-");
  const accepted = casPacket(stages, handle, seal(stages, [entry("one.txt", 1)]));
  expect(applyCasPacket(handle, stages, accepted).status).toBe("accepted");
  expect(fs.readdirSync(stages)).toEqual([]);

  const rejected = applyCasPacket(handle, stages, casPacket(stages, handle, seal(stages, [entry("two.txt", 2)]), 99));
  expect(rejected.status).toBe("rejected");
  if (rejected.status !== "rejected") return;
  // The consumed inputs are gone; the retry view is a live artifact of its own,
  // with its own lock, until the caller closes it.
  const live = fs.readdirSync(stages).sort();
  expect(live.filter((name) => name.endsWith(".sealed"))).toHaveLength(1);
  expect(live.filter((name) => name.endsWith(".lock"))).toHaveLength(1);
  expect(rejected.retry.touchedRepos(undefined, 16).rows.map((row) => row.relPath)).toEqual(["repo"]);
  rejected.retry.close();
  expect(fs.readdirSync(stages)).toEqual([]);
  handle.close();
});

test("two rejected packets hold independent retry views", () => {
  const { stages, handle } = workspace("rbox-lifecycle-two-views-");
  const reject = (marker: number) => {
    const stale = casPacket(stages, handle, seal(stages, [entry(`f${marker}.txt`, marker)]), 90 + marker);
    const result = applyCasPacket(handle, stages, stale);
    if (result.status !== "rejected") throw new Error(`expected a rejection, got ${result.status}`);
    return result.retry;
  };
  const first = reject(1);
  const second = reject(2);
  expect(first.touchedRepos(undefined, 16).rows).toHaveLength(1);
  second.close();
  // Closing the second view must not empty the first: they are separate artifacts.
  expect(first.touchedRepos(undefined, 16).rows).toHaveLength(1);
  first.close();
  expect(fs.readdirSync(stages)).toEqual([]);
  handle.close();
});

test("a LOCAL scan commits the sealed trust epoch and then deletes its stage", () => {
  const { stages, handle } = workspace("rbox-lifecycle-local-");
  const stage = seal(stages, [entry("scan.txt", 1)], { ...HEADER, trustEpoch: "epoch-sealed" }, "local");
  const scanned = applyLocalScan(handle, stages, stage, { lineageId: LINEAGE, localRevision: 0 });
  expect(scanned.token.localHeader.trustEpoch).toBe("epoch-sealed");
  expect(scanned.token.localHeader.complete).toBe(true);
  expect(fs.readdirSync(stages)).toEqual([]);

  // A LOCAL stage sealed without a trust epoch cannot claim a complete scan.
  const epochless = seal(stages, [entry("scan.txt", 1)], HEADER, "local");
  expect(() => applyLocalScan(handle, stages, epochless, { lineageId: LINEAGE, localRevision: 1 }))
    .toThrow(StageChangedError);
  expect(stateStoreDatabase(handle).query("SELECT complete FROM plane_heads WHERE plane='local'").get())
    .toEqual({ complete: 1 });
  handle.close();
});
