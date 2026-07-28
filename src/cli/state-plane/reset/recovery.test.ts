import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStateStore } from "../store/open.js";
import { sqliteResetPaths, stableDbHash } from "./artifacts.js";
import { sqliteResetFacade } from "./index.js";

const beginSqliteReset = sqliteResetFacade.begin;
const inspectSqliteReset = sqliteResetFacade.inspect;
const recoverSqliteReset = sqliteResetFacade.recover;

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
