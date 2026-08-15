import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStateStore } from "../store/open.js";
import { sqliteResetPaths, stableDbHash } from "./artifacts.js";
import { sqliteResetFacade } from "./index.js";
import { acquireLock, type OwnedLock } from "../../../engine/lockfile.js";
import { stateLockPath } from "../paths.js";
import { statePath } from "../paths.js";
import { authorityMarkerBytes } from "../authority-marker.js";
import type { StateSavePacket } from "../../sync-state-model.js";
import type { ResetJournalAuthorization } from "../../reset-journal-codec.js";
import { createSqliteResetRecoveryFs, type SqliteResetFsTraceEvent, type SqliteResetHooks } from "./recovery.js";
import { createResetRecoveryRefs } from "../../reset-z-runtime.js";
import { readRepoIdentityV1, repositoryIdentityHash } from "../../sync-git/repo-lineage.js";
import { gitRaw, setGitSpawnObserver } from "../../../engine/git-spawn.js";
import type { ResetZEntry } from "../../reset-z.js";

const beginSqliteResetUnderLock = sqliteResetFacade.begin;
const inspectSqliteReset = sqliteResetFacade.inspect;
const recoverSqliteResetUnderLock = sqliteResetFacade.recover;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-recovery-"));
  roots.push(root);
  const authorityId = crypto.randomBytes(16).toString("hex");
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await fs.writeFile(sqliteResetPaths.authorityMarker(root), `RBOX-SQLITE-AUTHORITY-v1\n${authorityId}\n`);
  const store = createStateStore(sqliteResetPaths.active(root), {
    stream: "old",
    authorityId,
    lineageId: "1".repeat(32),
    stateNonce: "1".repeat(32),
    stateRevision: 4,
    createdBy: "test",
  });
  store.close();
  return root;
}

async function withStateLock<T>(root: string, fn: (lock: OwnedLock) => Promise<T>): Promise<T> {
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error(`test state lock unavailable: ${acquired.status}`);
  try { return await fn(acquired.lock); } finally { await acquired.lock.release(); }
}

async function beginSqliteReset(
  root: string,
  nextStream: string,
  z: [],
  authorization: ResetJournalAuthorization,
  hooks: SqliteResetHooks = {},
) {
  return withStateLock(root, (lock) => beginSqliteResetUnderLock(
    root, nextStream, { stream: "old", stateNonce: "1".repeat(32) }, z, authorization, lock, hooks,
  ));
}

async function recoverSqliteReset(root: string, stream: string, hooks: SqliteResetHooks = {}) {
  return withStateLock(root, (lock) => recoverSqliteResetUnderLock(root, stream, lock, hooks));
}

test("SQLite P0 through Z0 recovery swaps exact DB artifacts", async () => {
  const root = await fixture();
  const oldHash = (await stableDbHash(sqliteResetPaths.active(root))).sha256;
  const journal = await beginSqliteReset(root, "next", [], {
    version: 2,
    authorizedNextStream: "next",
    consentKind: "setup-rebind",
    mintedAtRevision: 4,
  }, {
    now: () => new Date("2026-07-28T12:00:00.000Z"),
    randomBytes: (size) => Buffer.alloc(size, size === 16 ? 2 : 3),
  });
  expect(await inspectSqliteReset(root, "old")).toMatchObject({
    status: "recoverable",
    row: { ids: ["P0"] },
  });
  expect(await recoverSqliteReset(root, "old")).toBe("complete");
  expect((await stableDbHash(sqliteResetPaths.active(root))).sha256).toBe(journal.next.stateSha256);
  expect((await stableDbHash(sqliteResetPaths.archive(root, "1".repeat(32), oldHash))).sha256).toBe(oldHash);
  expect(await fs.lstat(sqliteResetPaths.journal(root)).catch(() => undefined)).toBeUndefined();
  expect(await inspectSqliteReset(root, "next")).toEqual({ status: "steady" });
});

test("invalid authorization is rejected before any DB or namespace mutation", async () => {
  const root = await fixture();
  const before = await fs.readFile(sqliteResetPaths.active(root));
  await expect(beginSqliteReset(root, "next", [], {
    version: 2,
    authorizedNextStream: "other",
    consentKind: "setup-rebind",
    mintedAtRevision: 4,
  })).rejects.toThrow("authorization");
  expect(await fs.readFile(sqliteResetPaths.active(root))).toEqual(before);
  expect(await fs.readdir(sqliteResetPaths.stateRoot(root))).toEqual(["state.db"]);
});

test("recovery crash hooks resume every empty-Z publication boundary", async () => {
  for (const point of [
    "after-candidate-create",
    "after-archive-create",
    "after-ready",
    "after-destination-parent-fsync",
    "after-source-parent-fsync",
    "after-installed",
    "after-state-check",
    "after-marker-write",
    "after-z-retired",
    "after-journal-unlink",
  ]) {
    const root = await fixture();
    await beginSqliteReset(root, "next", [], {
      version: 2,
      authorizedNextStream: "next",
      consentKind: "setup-rebind",
      mintedAtRevision: 4,
    });
    await expect(recoverSqliteReset(root, "old", {
      crashAt: (seen) => {
        if (seen === point) throw new Error(point);
      },
    })).rejects.toThrow(point);
    const inspection = await inspectSqliteReset(root, "old");
    if (point === "after-journal-unlink") expect(inspection.status).toBe("steady");
    else expect(inspection.status).toBe("recoverable");
    expect(await recoverSqliteReset(root, "old")).toBe(point === "after-journal-unlink" ? "none" : "complete");
  }
});

const X_TIMINGS = ["stale-entry", "syscall-adjacent"] as const;

function steal(lock: OwnedLock): void {
  fsSync.writeFileSync(lock.path, "foreign lease\n");
}

const xCompetingPacket = (): StateSavePacket => ({
  expectedStream: "old", expectedNonce: "1".repeat(32), sourceGlobalSeq: 1,
  global: { manifest: { generatedAt: "competing-accepted-save", files: [] } }, repos: [],
});

function commitAcceptedQSaveSync(root: string): Buffer {
  const moduleUrl = new URL("../adapters/whole-state-compat.ts", import.meta.url).href;
  const child = Bun.spawnSync({
    cmd: [process.execPath, "-e", `const {applyStateSavePacket}=await import(${JSON.stringify(moduleUrl)});const result=await applyStateSavePacket(process.env.RBOX_TEST_ROOT,JSON.parse(process.env.RBOX_TEST_PACKET));if(result.status!=="accepted")throw new Error("save was "+result.status);`],
    env: { ...process.env, RBOX_TEST_ROOT: root, RBOX_TEST_PACKET: JSON.stringify(xCompetingPacket()) },
    stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return fsSync.readFileSync(sqliteResetPaths.active(root));
}

async function xFixture(label: string): Promise<{ root: string; lock: OwnedLock }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-u2-x-${label}-`));
  roots.push(root);
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error(`test state lock unavailable: ${acquired.status}`);
  return { root, lock: acquired.lock };
}

function lossObserver(lock: OwnedLock, operation: "atomic-write" | "exact-write" | "copy-exact" | "rename" | "remove") {
  return (event: SqliteResetFsTraceEvent): void => {
    if (event.kind === "step" && event.operation === operation
      && (event.step === "before-rename" || event.step === "before-owner-check")) steal(lock);
  };
}

for (const timing of X_TIMINGS) {
  test(`X1 SQLite journal atomic rename refuses owner loss at ${timing}`, async () => {
    const { root, lock } = await xFixture(`x1-${timing}`);
    const target = path.join(sqliteResetPaths.stateRoot(root), "phase.json");
    await fs.writeFile(target, "old\n");
    if (timing === "stale-entry") steal(lock);
    const recoveryFs = createSqliteResetRecoveryFs(root, lock,
      timing === "syscall-adjacent" ? lossObserver(lock, "atomic-write") : undefined);
    await expect(recoveryFs.atomicWrite(target, Buffer.from("new\n"))).rejects.toMatchObject({ reason: "state-lock-lease-lost" });
    expect(await fs.readFile(target, "utf8")).toBe("old\n");
  });

  test(`X2 SQLite candidate/archive exact publication refuses owner loss at ${timing}`, async () => {
    for (const operation of ["exact-write", "copy-exact"] as const) {
      const { root, lock } = await xFixture(`x2-${operation}-${timing}`);
      const source = path.join(root, "source.db");
      const target = path.join(sqliteResetPaths.stateRoot(root), `${operation}.db`);
      await fs.writeFile(source, "new-db\n");
      await fs.writeFile(target, "old-db\n");
      if (timing === "stale-entry") steal(lock);
      const recoveryFs = createSqliteResetRecoveryFs(root, lock,
        timing === "syscall-adjacent" ? lossObserver(lock, operation) : undefined);
      const effect = operation === "exact-write"
        ? recoveryFs.exactWrite(target, Buffer.from("new-db\n"))
        : recoveryFs.copyExact(source, target);
      await expect(effect).rejects.toMatchObject({ reason: "state-lock-lease-lost" });
      expect(await fs.readFile(target, "utf8")).toBe("old-db\n");
    }
  });

  test(`X3 SQLite candidate-to-active rename preserves competing bytes at ${timing}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-u2-x-x3-${timing}-`));
    roots.push(root);
    const authorityId = "a".repeat(32);
    await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
    createStateStore(sqliteResetPaths.active(root), {
      authorityId, lineageId: "b".repeat(32), stream: "old", createdBy: "x3-test",
      stateNonce: "1".repeat(32), stateRevision: 0,
    }).close();
    await fs.writeFile(statePath(root), authorityMarkerBytes(authorityId));
    const acquired = await acquireLock(stateLockPath(root));
    if (acquired.status !== "acquired") throw new Error(`test state lock unavailable: ${acquired.status}`);
    const lock = acquired.lock;
    const source = path.join(sqliteResetPaths.stateRoot(root), "candidate.db");
    const target = sqliteResetPaths.active(root);
    await fs.writeFile(source, "candidate\n");
    let competing: Buffer;
    if (timing === "stale-entry") {
      fsSync.rmSync(lock.path, { force: true });
      competing = commitAcceptedQSaveSync(root);
    }
    const recoveryFs = createSqliteResetRecoveryFs(root, lock, timing === "syscall-adjacent"
      ? (event) => {
          if (event.kind === "step" && event.operation === "rename" && event.step === "before-owner-check") {
            fsSync.rmSync(lock.path, { force: true });
            competing = commitAcceptedQSaveSync(root);
          }
        }
      : undefined);
    await expect(recoveryFs.rename(source, target)).rejects.toMatchObject({ reason: "state-lock-lease-lost" });
    expect(await fs.readFile(target)).toEqual(competing!);
    expect(await fs.readFile(source, "utf8")).toBe("candidate\n");
  });

  test(`X4 SQLite recovery-ref spawn preserves the preceding prefix at ${timing}`, async () => {
    const { root, lock } = await xFixture(`x4-${timing}`);
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await gitRaw(repo, ["init", "-q"]);
    const commonDir = await fs.realpath(path.join(repo, ".git"));
    const identity = await readRepoIdentityV1("repo", "dir", {
      worktreeId: repo, gitDirReal: commonDir, commonDirReal: commonDir,
    });
    const targetOid = (await gitRaw(repo, ["hash-object", "-w", "-t", "tree", "/dev/null"])).trim();
    const lineageHash = "d".repeat(64);
    const entry: ResetZEntry = {
      lineageHash, repositoryIdentityHash: repositoryIdentityHash(identity), repositoryIdentity: identity,
      activeRef: `refs/rbox-local/base-absent-settled/v1/${lineageHash}`,
      recoveryRef: `refs/rbox-recovery/base-absent/v1/${lineageHash}/${targetOid}`,
      targetOid,
    };
    await gitRaw(repo, ["update-ref", entry.activeRef, targetOid]);
    if (timing === "stale-entry") steal(lock);
    if (timing === "syscall-adjacent") {
      setGitSpawnObserver((_repo, args) => {
        if (args[0] === "update-ref" && args[1] === entry.recoveryRef) steal(lock);
      });
    }
    try {
      await expect(createResetRecoveryRefs(root, [entry], 0, lock)).rejects.toMatchObject({ reason: "state-lock-lease-lost" });
    } finally {
      setGitSpawnObserver(undefined);
    }
    await expect(gitRaw(repo, ["rev-parse", "--verify", entry.recoveryRef])).rejects.toBeDefined();
  });

  test(`X5 SQLite journal/candidate remove retains the classified row at ${timing}`, async () => {
    const { root, lock } = await xFixture(`x5-${timing}`);
    const target = path.join(sqliteResetPaths.stateRoot(root), "reset-candidate.db");
    await fs.writeFile(target, "classified-row\n");
    if (timing === "stale-entry") steal(lock);
    const recoveryFs = createSqliteResetRecoveryFs(root, lock,
      timing === "syscall-adjacent" ? lossObserver(lock, "remove") : undefined);
    await expect(recoveryFs.remove(target)).rejects.toMatchObject({ reason: "state-lock-lease-lost" });
    expect(await fs.readFile(target, "utf8")).toBe("classified-row\n");
  });
}

for (const [row, timing, boundary] of [
  ["O1", "before-checkpoint", "before-w1-checkpoint"],
  ["O1", "after-checkpoint", "after-w1-checkpoint"],
  ["O2", "before-checkpoint", "before-w1-checkpoint"],
  ["O2", "after-checkpoint", "after-w1-checkpoint"],
] as const) {
  test(`${row} W1 owner/crash matrix at ${timing}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-u2-${row.toLowerCase()}-w1-`));
    roots.push(root);
    const child = Bun.spawn({
      cmd: [process.execPath, import.meta.dir + "/crash-rig-child.ts", "w1-prepare", root, "prepare"],
      stdout: "pipe", stderr: "pipe",
    });
    expect([9, 137]).toContain(await child.exited);
    await expect(recoverSqliteReset(root, "old", {
      crashAt(point) { if (point === boundary) throw new Error(boundary); },
    })).rejects.toThrow(boundary);
    const observed = await inspectSqliteReset(root, "old");
    expect(["w1", "steady"]).toContain(observed.status);
    expect(["none", "complete"]).toContain(await recoverSqliteReset(root, "old"));
    expect((await inspectSqliteReset(root, "old")).status).toBe("steady");
  });
}

const O_RESET_BOUNDARIES = [
  ["O3", "before", "after-prepared"], ["O3", "after", "after-candidate-create"],
  ["O4", "before", "after-prepared"], ["O4", "after", "after-archive-create"],
  ["O5", "before", "after-prepared"], ["O5", "after", "after-ready"],
  ["O6", "before", "after-prepared"], ["O6", "after", "after-ready"],
  ["O7", "before", "after-candidate-create"], ["O7", "after", "after-archive-create"],
  ["O8", "before", "after-candidate-rename"], ["O8", "after", "after-destination-parent-fsync"],
  ["O9", "before", "after-ready"], ["O9", "after", "after-candidate-rename"],
  ["O10", "before", "after-destination-parent-fsync"], ["O10", "after", "after-source-parent-fsync"],
  ["O11", "before", "after-state-check"], ["O11", "after", "after-marker-write"],
  ["O12", "before", "after-z-retired"], ["O12", "after", "after-journal-unlink"],
] as const;

for (const [row, timing, boundary] of O_RESET_BOUNDARIES) {
  test(`${row} SQLite durable prefix is classified and resumable ${timing} ${boundary}`, async () => {
    const root = await fixture();
    const authorization = {
      version: 2 as const, authorizedNextStream: "next" as const,
      consentKind: "setup-rebind" as const, mintedAtRevision: 4,
    };
    if (boundary === "after-prepared") {
      await expect(beginSqliteReset(root, "next", [], authorization, {
        crashAt(point) { if (point === boundary) throw new Error(boundary); },
      })).rejects.toThrow(boundary);
    } else {
      await beginSqliteReset(root, "next", [], authorization);
      await expect(recoverSqliteReset(root, "old", {
        crashAt(point) { if (point === boundary) throw new Error(boundary); },
      })).rejects.toThrow(boundary);
    }
    const observed = await inspectSqliteReset(root, "old");
    if (boundary === "after-journal-unlink") expect(observed.status).toBe("steady");
    else expect(observed.status).toBe("recoverable");
    expect(await recoverSqliteReset(root, "old")).toBe(boundary === "after-journal-unlink" ? "none" : "complete");
  });
}
