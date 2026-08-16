import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessIncarnation } from "../../engine/lockfile.js";
import {
  StateCasAcquisitionBatch,
  StateCasReleaseBatch,
} from "./state-cas-lock-batch.js";
import {
  acquirePreparedStateCasLocks,
  prepareStateCasLocks,
  recoverStateCasLocks,
} from "./state-cas-locks.js";

const OWNER: ProcessIncarnation = { hostId: "a".repeat(32), bootId: "b".repeat(32), pid: 41, startTime: "1" };
const identity = (status: "alive" | "dead") => ({
  current: async () => OWNER,
  probe: async () => status === "alive"
    ? { status: "alive" as const, startTime: OWNER.startTime }
    : { status: "dead" as const },
});
let root = "";

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-state-cas-batch-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function bareCommon(): Promise<string> {
  const common = path.join(root, "common.git");
  const child = Bun.spawn(["git", "init", "--bare", common], { stdout: "ignore", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
  return common;
}

async function fixture(paths: readonly string[]) {
  const common = await bareCommon();
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, paths.map((relative) => ({
    commonDir: common,
    lockPath: path.join(common, relative),
    proofs: [],
  })), { identity: identity("alive") });
  return { common, prepared: prepared! };
}

test("acquisition batch proves a complete flush and is single-use", async () => {
  const lockPath = path.join(root, "refs", "heads", "one.lock");
  const batch = new StateCasAcquisitionBatch([lockPath], async () => {});
  batch.deferPublication(lockPath, async () => {});
  batch.record(lockPath, "acquired");
  expect(() => batch.assertFlushed()).toThrow("not flushed");
  await batch.flushAll();
  expect(() => batch.assertFlushed()).not.toThrow();
  await expect(batch.flushAll()).rejects.toThrow("already used");
});

test("acquisition flush failure attempts every parent, releases all links, and retains journal", async () => {
  const { prepared } = await fixture(["refs/heads/one.lock", "refs/tags/two.lock"]);
  const parents: string[] = [];
  await expect(acquirePreparedStateCasLocks(prepared, {
    syncDirectory: async (directory) => {
      parents.push(directory);
      if (directory.endsWith(path.join("refs", "heads"))) throw new Error("injected acquisition flush failure");
    },
  })).rejects.toThrow("injected acquisition flush failure");
  expect(new Set(parents.filter((parent) => parent.includes(`${path.sep}refs${path.sep}`))).size).toBe(2);
  for (const lock of prepared.journal.commonDirs[0]!.locks) {
    expect(await fs.lstat(lock.path).then(() => true, () => false)).toBe(false);
  }
  expect(await fs.lstat(prepared.journalPath).then(() => true)).toBe(true);
});

test("release maps durability by actual parent and refuses journal retirement on one failed flush", async () => {
  const { prepared } = await fixture(["refs/heads/one.lock", "refs/tags/two.lock"]);
  const acquired = await acquirePreparedStateCasLocks(prepared);
  const released = await acquired.release({
    syncDirectory: async (directory) => {
      if (directory.endsWith(path.join("refs", "tags"))) throw new Error("injected release flush failure");
    },
  });
  expect(released).toBe(false);
  await expect(acquired.release()).rejects.toThrow("already released");
  expect(await fs.lstat(prepared.journalPath).then(() => true)).toBe(true);
  for (const lock of prepared.journal.commonDirs[0]!.locks) expect(await fs.lstat(lock.path).then(() => true, () => false)).toBe(false);

  const mapping = new StateCasReleaseBatch(async (directory) => {
    if (directory.endsWith("tags")) throw new Error("failed parent");
  });
  const head = path.join(root, "refs", "heads", "a.lock");
  const tag = path.join(root, "refs", "tags", "b.lock");
  mapping.deferRelease(head);
  mapping.deferRelease(tag);
  await mapping.flushAll();
  expect(mapping.durable(head)).toBe(true);
  expect(mapping.durable(tag)).toBe(false);
});

test("recovery re-fsyncs each absent acquired parent before retirement", async () => {
  const { prepared } = await fixture(["refs/heads/one.lock", "refs/heads/two.lock"]);
  await acquirePreparedStateCasLocks(prepared);
  for (const lock of prepared.journal.commonDirs[0]!.locks) await fs.unlink(lock.path);
  const synced: string[] = [];
  const result = await recoverStateCasLocks(root, {
    identity: identity("dead"),
    syncDirectory: async (directory) => { synced.push(directory); },
  });
  expect(result.indeterminate).toBe(0);
  expect(synced).toEqual([path.dirname(prepared.journal.commonDirs[0]!.locks[0]!.path)]);
  expect(await fs.lstat(prepared.journalPath).then(() => true, () => false)).toBe(false);
});

test("recovery refuses retirement when absent-entry parent re-fsync fails", async () => {
  const { prepared } = await fixture(["refs/heads/one.lock"]);
  await acquirePreparedStateCasLocks(prepared);
  await fs.unlink(prepared.journal.commonDirs[0]!.locks[0]!.path);
  const result = await recoverStateCasLocks(root, {
    identity: identity("dead"),
    syncDirectory: async () => { throw new Error("injected recovery flush failure"); },
  });
  expect(result.indeterminate).toBeGreaterThan(0);
  expect(await fs.lstat(prepared.journalPath).then(() => true)).toBe(true);
});

test("recovery fsyncs the nearest existing ancestor when a lock parent was pruned", async () => {
  const relative = "refs/remotes/origin/feature/team/topic.lock";
  const { common, prepared } = await fixture([relative]);
  await acquirePreparedStateCasLocks(prepared);
  const lockPath = prepared.journal.commonDirs[0]!.locks[0]!.path;
  await fs.unlink(lockPath);
  await fs.rm(path.join(common, "refs", "remotes", "origin"), { recursive: true });
  const synced: string[] = [];
  const result = await recoverStateCasLocks(root, {
    identity: identity("dead"),
    syncDirectory: async (directory) => { synced.push(directory); },
  });
  expect(result).toMatchObject({ recovered: 0, indeterminate: 0 });
  expect(synced).toEqual([path.join(common, "refs", "remotes")]);
  expect(await fs.lstat(prepared.journalPath).then(() => true, () => false)).toBe(false);
});

test("multi-directory acquisition flushes each exact parent once", async () => {
  const { prepared } = await fixture(["refs/heads/one.lock", "refs/heads/two.lock", "refs/tags/three.lock"]);
  const parents: string[] = [];
  const acquired = await acquirePreparedStateCasLocks(prepared, { syncDirectory: async (directory) => { parents.push(directory); } });
  expect(parents).toEqual([
    path.dirname(prepared.journal.commonDirs[0]!.locks[0]!.path),
    path.dirname(prepared.journal.commonDirs[0]!.locks[2]!.path),
  ]);
  await acquired.release();
});

test("post-link readback mismatch is a publication error, never blocked", async () => {
  const { prepared } = await fixture(["refs/heads/a-first.lock", "refs/heads/z-mismatch.lock"]);
  const mismatch = prepared.journal.commonDirs[0]!.locks[1]!.path;
  await expect(acquirePreparedStateCasLocks(prepared, {
    hooks: { link: async (source, destination) => {
      await fs.link(source, destination);
      if (destination === mismatch) {
        await fs.unlink(destination);
        await fs.writeFile(destination, await fs.readFile(source));
      }
    } },
  })).rejects.toThrow("changed before finalization");
  expect(await fs.lstat(prepared.journal.commonDirs[0]!.locks[0]!.path).then(() => true, () => false)).toBe(false);
  expect(await fs.readFile(mismatch, "utf8")).toBe(prepared.journal.commonDirs[0]!.locks[1]!.marker);
  expect(prepared.journal.commonDirs[0]!.locks[1]!.acquisition).toBeUndefined();
  expect(await fs.lstat(prepared.journalPath).then(() => true)).toBe(true);
});
