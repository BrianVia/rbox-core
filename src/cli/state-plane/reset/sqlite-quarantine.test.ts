import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStateStore } from "../store/open.js";
import {
  quarantineResetUnderFence,
  readResetQuarantineBundle,
  restoreResetQuarantineUnderFence,
} from "../../reset-quarantine.js";
import { sqliteResetFacade } from "./index.js";
import { sqliteResetPaths, stableDbHash } from "./artifacts.js";
import { acquireLock, type OwnedLock } from "../../../engine/lockfile.js";
import { stateLockPath } from "../paths.js";
import type { ResetJournalAuthorization } from "../../reset-journal-codec.js";

const beginSqliteResetUnderLock = sqliteResetFacade.begin;
const recoverSqliteResetUnderLock = sqliteResetFacade.recover;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function withStateLock<T>(root: string, fn: (lock: OwnedLock) => Promise<T>): Promise<T> {
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error(`test state lock unavailable: ${acquired.status}`);
  try { return await fn(acquired.lock); } finally { await acquired.lock.release(); }
}

async function beginSqliteReset(root: string, nextStream: string, authorization: ResetJournalAuthorization) {
  return withStateLock(root, (lock) => beginSqliteResetUnderLock(
    root, nextStream, { stream: "old", stateNonce: "1".repeat(32) }, [], authorization, lock,
  ));
}

async function recoverSqliteReset(root: string, stream: string) {
  return withStateLock(root, (lock) => recoverSqliteResetUnderLock(root, stream, lock));
}

async function sqliteFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-sqlite-quarantine-"));
  roots.push(root);
  const authorityId = crypto.randomBytes(16).toString("hex");
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await fs.writeFile(sqliteResetPaths.authorityMarker(root), `RBOX-SQLITE-AUTHORITY-v1\n${authorityId}\n`);
  createStateStore(sqliteResetPaths.active(root), {
    stream: "old",
    authorityId,
    lineageId: "1".repeat(32),
    stateNonce: "1".repeat(32),
    stateRevision: 1,
    createdBy: "test",
  }).close();
  const journal = await beginSqliteReset(root, "next", {
    version: 2,
    authorizedNextStream: "next",
    consentKind: "setup-rebind",
    mintedAtRevision: 1,
  });
  return { root, journal };
}

test("SQLite quarantine records decoded candidate witness, copies opaque bytes, and restores journal last", async () => {
  const { root, journal } = await sqliteFixture();
  const journalBytes = await fs.readFile(sqliteResetPaths.journal(root));
  const activeHash = (await stableDbHash(sqliteResetPaths.active(root))).sha256;
  const bundle = await quarantineResetUnderFence(root, {
    scope: "transaction",
    phase: "prepared",
    activeStateSha256: activeHash,
    recoveredStateSha256: journal.next.stateSha256,
    markerPrecondition: "absent",
    refPreconditions: JSON.stringify({
      recovery: { kind: "prefix", count: 0, total: 0 },
      active: { kind: "prefix", count: 0, total: 0 },
    }),
    artifacts: [{
      kind: "journal",
      absolutePath: sqliteResetPaths.journal(root),
      cleanup: "remove-exact",
    }],
  });
  expect(await fs.lstat(sqliteResetPaths.journal(root)).catch(() => undefined)).toBeUndefined();
  const manifest = await readResetQuarantineBundle(root, bundle);
  expect(manifest).toMatchObject({
    stateFormat: "sqlite/v1",
    decodedCandidateSha256: journal.next.stateSha256,
    decodedCandidateBytes: journal.next.dbBytes.byteLength,
  });
  expect(await restoreResetQuarantineUnderFence(root, bundle, { configEligible: true })).toBe("restored");
  expect(await fs.readFile(sqliteResetPaths.journal(root))).toEqual(journalBytes);
  expect(await recoverSqliteReset(root, "old")).toBe("complete");
});

test("SQLite candidate and archive quarantine round-trip exact opaque DB bytes", async () => {
  const { root, journal } = await sqliteFixture();
  const candidate = sqliteResetPaths.candidate(root, journal.id);
  const archive = sqliteResetPaths.archive(root, journal.old.stateNonce, journal.old.stateSha256);
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(candidate, journal.next.dbBytes);
  await fs.copyFile(sqliteResetPaths.active(root), archive);
  const candidateBytes = await fs.readFile(candidate);
  const archiveBytes = await fs.readFile(archive);
  const bundle = await quarantineResetUnderFence(root, {
    scope: "transaction",
    phase: "prepared",
    activeStateSha256: journal.old.stateSha256,
    recoveredStateSha256: journal.next.stateSha256,
    markerPrecondition: "absent",
    refPreconditions: JSON.stringify({
      recovery: { kind: "prefix", count: 0, total: 0 },
      active: { kind: "prefix", count: 0, total: 0 },
    }),
    artifacts: [
      { kind: "journal", absolutePath: sqliteResetPaths.journal(root), cleanup: "remove-exact" },
      { kind: "candidate", absolutePath: candidate, cleanup: "remove-exact" },
      { kind: "archive", absolutePath: archive, cleanup: "preserve" },
    ],
  });
  expect(await fs.lstat(candidate).catch(() => undefined)).toBeUndefined();
  expect(await fs.readFile(archive)).toEqual(archiveBytes);
  await fs.rm(archive);
  expect(await restoreResetQuarantineUnderFence(root, bundle, { configEligible: true })).toBe("restored");
  expect(await fs.readFile(candidate)).toEqual(candidateBytes);
  expect(await fs.readFile(archive)).toEqual(archiveBytes);
});

for (const kind of ["candidate", "archive"] as const) {
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    test(`SQLite ${kind} quarantine refuses a standing ${suffix} sidecar`, async () => {
      const { root, journal } = await sqliteFixture();
      const artifact = kind === "candidate"
        ? sqliteResetPaths.candidate(root, journal.id)
        : sqliteResetPaths.archive(root, journal.old.stateNonce, journal.old.stateSha256);
      await fs.mkdir(path.dirname(artifact), { recursive: true });
      if (kind === "candidate") await fs.writeFile(artifact, journal.next.dbBytes);
      else await fs.copyFile(sqliteResetPaths.active(root), artifact);
      await fs.writeFile(`${artifact}${suffix}`, "standing");
      await expect(quarantineResetUnderFence(root, {
        scope: "transaction",
        phase: "prepared",
        markerPrecondition: "absent",
        refPreconditions: JSON.stringify({
          recovery: { kind: "prefix", count: 0, total: 0 },
          active: { kind: "prefix", count: 0, total: 0 },
        }),
        artifacts: [
          { kind: "journal", absolutePath: sqliteResetPaths.journal(root), cleanup: "remove-exact" },
          { kind, absolutePath: artifact, cleanup: kind === "archive" ? "preserve" : "remove-exact" },
        ],
      })).rejects.toThrow("requires an S0 DB artifact");
    });
  }
}
