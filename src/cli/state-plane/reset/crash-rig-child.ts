import fs from "node:fs/promises";
import path from "node:path";
import {
  quarantineResetUnderFence,
  type ResetQuarantinePlan,
} from "../../reset-quarantine.js";
import crypto from "node:crypto";
import { createStateStore, openStateStore, stateStoreDatabase } from "../store/open.js";
import { runStatement } from "../store/statements.js";
import { sqliteResetFacade } from "./index.js";
import { sqliteResetPaths } from "./artifacts.js";
import { stableDbHash } from "./artifacts.js";
import { readRepoIdentityV1, repositoryIdentityHash } from "../../../cli/sync-git/repo-lineage.js";
import type { ResetZEntry } from "../../reset-z.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createStateBackupPublisher } from "../backup/publish.js";
import { AUTHORITY_MARKER_MAGIC } from "../authority-marker.js";
import { acquireLock, type OwnedLock } from "../../../engine/lockfile.js";
import { stateLockPath } from "../paths.js";

const beginSqliteReset = sqliteResetFacade.begin;
const recoverSqliteReset = sqliteResetFacade.recover;

const [, , command, root, boundary] = process.argv;
if (!["quarantine", "reset-fixture", "reset-production", "reset-production-p0a", "w1-prepare", "w1-takeover", "backup-production"].includes(command ?? "") || !root || !boundary) {
  process.stderr.write("usage: crash-rig-child quarantine|reset-fixture|reset-production|reset-production-p0a|w1-prepare|w1-takeover|backup-production ROOT BOUNDARY\n");
  process.exit(64);
}

const state = path.join(root, ".rbox", "state");
const killAt = (seen: string): void => {
  if (seen === boundary) process.kill(process.pid, "SIGKILL");
};
const authorityMarker = (authorityId: string): string =>
  `${AUTHORITY_MARKER_MAGIC}\n${authorityId}\n`;

async function syncDir(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function withCanonicalStateLock<T>(fn: (lock: OwnedLock) => Promise<T>): Promise<T> {
  const acquired = await acquireLock(stateLockPath(root!));
  if (acquired.status !== "acquired") throw new Error(`crash rig state lock unavailable: ${acquired.status}`);
  try {
    return await fn(acquired.lock);
  } finally {
    await acquired.lock.release();
  }
}

async function publish(file: string, bytes: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.rbox-tmp-${process.pid}-1-${path.basename(file)}`);
  const handle = await fs.open(temp, "wx");
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
  await syncDir(path.dirname(file));
}

async function git(repo: string, args: string[]): Promise<string> {
  const result = await promisify(execFile)("git", ["-C", repo, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return result.stdout.trim();
}

async function zFixture(name: string, lineageByte: string): Promise<ResetZEntry> {
  const repo = path.join(root!, name);
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ["init", "-q"]);
  const commonDir = await fs.realpath(path.join(repo, ".git"));
  const identity = await readRepoIdentityV1(name, "dir", {
    worktreeId: repo,
    gitDirReal: commonDir,
    commonDirReal: commonDir,
  });
  const targetOid = await git(repo, ["hash-object", "-w", "-t", "tree", "/dev/null"]);
  const lineageHash = lineageByte.repeat(64);
  const activeRef = `refs/rbox-local/base-absent-settled/v1/${lineageHash}`;
  await git(repo, ["update-ref", activeRef, targetOid]);
  return {
    lineageHash,
    repositoryIdentityHash: repositoryIdentityHash(identity),
    repositoryIdentity: identity,
    activeRef,
    targetOid,
    recoveryRef: `refs/rbox-recovery/base-absent/v1/${lineageHash}/${targetOid}`,
  };
}

if (command === "w1-prepare") {
  const authorityId = "c".repeat(32);
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await fs.writeFile(sqliteResetPaths.authorityMarker(root), authorityMarker(authorityId));
  createStateStore(sqliteResetPaths.active(root), {
    stream: "old",
    authorityId,
    lineageId: "1".repeat(32),
    stateNonce: "1".repeat(32),
    stateRevision: 1,
    createdBy: "crash-rig",
  }).close();
  const writer = openStateStore(sqliteResetPaths.active(root));
  runStatement(stateStoreDatabase(writer), "UPDATE state_lineage SET state_revision=2");
  process.kill(process.pid, "SIGKILL");
}

if (command === "w1-takeover") {
  await withCanonicalStateLock((lock) => recoverSqliteReset(root, "old", lock, { crashAt: killAt }));
  process.stderr.write(`boundary was not reached: ${boundary}\n`);
  process.exit(65);
}

if (command === "backup-production") {
  const source = createStateStore(sqliteResetPaths.active(root), {
    stream: "old",
    authorityId: "d".repeat(32),
    lineageId: "1".repeat(32),
    stateNonce: "1".repeat(32),
    stateRevision: 1,
    createdBy: "crash-rig",
  });
  const publishStateBackup = createStateBackupPublisher({ boundary: killAt });
  publishStateBackup({
    source,
    destination: path.join(root, ".rbox", "state", "backups", "snapshot.db"),
    backupId: "e".repeat(32),
  });
  process.stderr.write(`boundary was not reached: ${boundary}\n`);
  process.exit(65);
}

if (command === "reset-production-p0a") {
  const authorityId = "f".repeat(32);
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await fs.writeFile(sqliteResetPaths.authorityMarker(root), authorityMarker(authorityId));
  createStateStore(sqliteResetPaths.active(root), {
    stream: "old",
    authorityId,
    lineageId: "1".repeat(32),
    stateNonce: "1".repeat(32),
    stateRevision: 1,
    createdBy: "crash-rig",
  }).close();
  const activeHash = (await stableDbHash(sqliteResetPaths.active(root))).sha256;
  const archive = sqliteResetPaths.archive(root, "1".repeat(32), activeHash);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.copyFile(sqliteResetPaths.active(root), archive);
  await syncDir(path.dirname(archive));
  await withCanonicalStateLock((lock) => beginSqliteReset(root, "next", {
    stream: "old", stateNonce: "1".repeat(32),
  }, [], {
    version: 2,
    authorizedNextStream: "next",
    consentKind: "setup-rebind",
    mintedAtRevision: 1,
  }, lock, { crashAt: killAt }));
  process.stderr.write(`boundary was not reached: ${boundary}\n`);
  process.exit(65);
}

if (command === "reset-production") {
  const authorityId = crypto.randomBytes(16).toString("hex");
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await fs.writeFile(sqliteResetPaths.authorityMarker(root), authorityMarker(authorityId));
  const store = createStateStore(sqliteResetPaths.active(root), {
    stream: "old",
    authorityId,
    lineageId: "1".repeat(32),
    stateNonce: "1".repeat(32),
    stateRevision: 1,
    createdBy: "crash-rig",
  });
  store.close();
  const z = [await zFixture("repo-a", "a"), await zFixture("repo-b", "b")];
  await withCanonicalStateLock((lock) => beginSqliteReset(root, "next", {
    stream: "old", stateNonce: "1".repeat(32),
  }, z, {
    version: 2,
    authorizedNextStream: "next",
    consentKind: "setup-rebind",
    mintedAtRevision: 1,
  }, lock, { crashAt: killAt }));
  await withCanonicalStateLock((lock) => recoverSqliteReset(root, "old", lock, { crashAt: killAt }));
  process.stderr.write(`boundary was not reached: ${boundary}\n`);
  process.exit(65);
}

if (command === "reset-fixture") {
  const candidate = path.join(state, "reset-candidates", "id.db");
  const archive = path.join(state, "lineages", "nonce", "old.db");
  const refs = path.join(root, "refs");
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.mkdir(path.join(refs, "active"), { recursive: true });
  await fs.mkdir(path.join(refs, "recovery"), { recursive: true });
  await fs.mkdir(path.join(root, "meta"), { recursive: true });
  for (const [file, bytes] of [
    [path.join(state, "state.db"), "O"],
    [path.join(root, "meta", "z-count"), "2"],
    [path.join(root, "meta", "group-count"), "2"],
    [path.join(refs, "active", "1"), "target"],
    [path.join(refs, "active", "2"), "target"],
  ] as const) await publish(file, bytes);

  await publish(path.join(state, "reset-v1.json"), "prepared"); killAt("after-prepared");
  await publish(candidate, "N"); killAt("after-candidate-create");
  await publish(archive, "O"); killAt("after-archive-create");
  await publish(path.join(refs, "recovery", "1"), "target"); killAt("after-recovery-ref-1");
  await publish(path.join(refs, "recovery", "2"), "target"); killAt("after-recovery-ref-2");
  await publish(path.join(state, "reset-v1.json"), "ready"); killAt("after-ready");
  await fs.rename(candidate, path.join(state, "state.db"));
  await syncDir(state); killAt("after-destination-parent-fsync");
  await syncDir(path.dirname(candidate)); killAt("after-source-parent-fsync");
  await publish(path.join(state, "reset-v1.json"), "installed"); killAt("after-installed");
  killAt("after-state-check");
  await publish(path.join(state, "state-incarnation.json"), "MN"); killAt("after-marker-write");
  await fs.rm(path.join(refs, "active", "1")); await syncDir(path.join(refs, "active")); killAt("after-active-group-1");
  await fs.rm(path.join(refs, "active", "2")); await syncDir(path.join(refs, "active")); killAt("after-active-group-2");
  await publish(path.join(state, "reset-v1.json"), "z-retired"); killAt("after-z-retired");
  await fs.rm(path.join(state, "reset-v1.json")); await syncDir(state); killAt("after-journal-unlink");
  process.stderr.write(`boundary was not reached: ${boundary}\n`);
  process.exit(65);
}

const journal = path.join(state, "reset-v1.json");
const candidate = path.join(state, "reset-candidates", `${"1".repeat(32)}.db`);
const archive = path.join(state, "lineages", "a".repeat(32), `${"b".repeat(64)}.db`);
await fs.mkdir(path.dirname(candidate), { recursive: true });
await fs.mkdir(path.dirname(archive), { recursive: true });
await fs.writeFile(path.join(state, "state.db"), "ACTIVE-DB\n");
await fs.writeFile(journal, "JOURNAL\n");
await fs.writeFile(candidate, "CANDIDATE-DB\n");
await fs.writeFile(archive, "ARCHIVE-DB\n");

const plan: ResetQuarantinePlan = {
  scope: "transaction",
  phase: "prepared",
  activeStateSha256: "0".repeat(64),
  recoveredStateSha256: "1".repeat(64),
  markerPrecondition: "absent",
  refPreconditions: JSON.stringify({
    recovery: { kind: "prefix", count: 0, total: 0 },
    active: { kind: "prefix", count: 0, total: 0 },
  }),
  artifacts: [
    { kind: "journal", absolutePath: journal, cleanup: "remove-exact" },
    { kind: "candidate", absolutePath: candidate, cleanup: "remove-exact" },
    { kind: "archive", absolutePath: archive, cleanup: "preserve" },
  ],
};

await quarantineResetUnderFence(root, plan, {
  now: () => new Date("2026-07-28T12:00:00.000Z"),
  randomBytes: () => Buffer.from("0011223344556677", "hex"),
  crashAt: killAt,
});
process.stderr.write(`boundary was not reached: ${boundary}\n`);
process.exit(65);
