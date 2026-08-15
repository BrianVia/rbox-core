import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createStateStore } from "../store/open.js";
import { prepareEmptyResetDbSeed, quiesceActiveDbForReset } from "./lifecycle.js";
import {
  observeDbArtifact,
  RESET_SCHEMA_V1_EMPTY_SEED_BYTES,
  sqliteResetPaths,
} from "./artifacts.js";
import { acquireLock, type OwnedLock } from "../../../engine/lockfile.js";
import { stateLockPath } from "../paths.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; authorityId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-lifecycle-"));
  roots.push(root);
  const authorityId = crypto.randomBytes(16).toString("hex");
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await fs.writeFile(sqliteResetPaths.authorityMarker(root), `RBOX-SQLITE-AUTHORITY-v1\n${authorityId}\n`);
  const store = createStateStore(sqliteResetPaths.active(root), {
    stream: "old",
    authorityId,
    lineageId: "1".repeat(32),
    stateNonce: "1".repeat(32),
    stateRevision: 7,
    createdBy: "test",
  });
  store.close();
  return { root, authorityId };
}

async function withStateLock<T>(root: string, fn: (lock: OwnedLock) => Promise<T>): Promise<T> {
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error(`test state lock unavailable: ${acquired.status}`);
  try { return await fn(acquired.lock); } finally { await acquired.lock.release(); }
}

test("quiesce establishes an S0 active DB without changing lineage", async () => {
  const { root } = await fixture();
  expect(await withStateLock(root, (lock) => quiesceActiveDbForReset(root, lock))).toMatchObject({
    stream: "old",
    stateNonce: "1".repeat(32),
    stateRevision: 7,
  });
  expect(await observeDbArtifact(sqliteResetPaths.active(root))).toMatchObject({
    main: "regular",
    sidecars: "S0",
  });
});

test("private next DB seed is bounded, exact, and leaves no canonical candidate", async () => {
  const { root, authorityId } = await fixture();
  const next = {
    stream: "next",
    stateNonce: "2".repeat(32),
    stateRevision: 8,
  };
  const seed = await withStateLock(root, (lock) => prepareEmptyResetDbSeed(root, next, authorityId, lock));
  expect(seed.bytes.byteLength).toBe(RESET_SCHEMA_V1_EMPTY_SEED_BYTES);
  expect(seed.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
  expect(crypto.createHash("sha256").update(seed.bytes).digest("hex")).toBe(seed.sha256);
  expect(await fs.readdir(path.join(root, ".rbox", "state", "reset-candidates"))).toEqual([]);
});

test("active quiesce refuses a lost canonical owner before writable open", async () => {
  const { root } = await fixture();
  const before = await fs.readFile(sqliteResetPaths.active(root));
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error(`test state lock unavailable: ${acquired.status}`);
  fsSync.writeFileSync(acquired.lock.path, "foreign lease\n");
  await expect(quiesceActiveDbForReset(root, acquired.lock)).rejects.toMatchObject({ reason: "state-lock-lease-lost" });
  expect(await fs.readFile(sqliteResetPaths.active(root))).toEqual(before);
  expect(await observeDbArtifact(sqliteResetPaths.active(root))).toMatchObject({ sidecars: "S0" });
});

test("private seed writer refuses a lost canonical owner before create", async () => {
  const { root, authorityId } = await fixture();
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error(`test state lock unavailable: ${acquired.status}`);
  fsSync.writeFileSync(acquired.lock.path, "foreign lease\n");
  await expect(prepareEmptyResetDbSeed(root, {
    stream: "next", stateNonce: "2".repeat(32), stateRevision: 8,
  }, authorityId, acquired.lock)).rejects.toMatchObject({ reason: "state-lock-lease-lost" });
  expect(await fs.readdir(sqliteResetPaths.stateRoot(root))).toEqual(["state.db"]);
});
