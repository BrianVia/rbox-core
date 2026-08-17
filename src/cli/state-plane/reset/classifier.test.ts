import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifySqliteResetPredecode,
  ResetOrphanArtifactHalt,
} from "./classifier.js";
import { sqliteResetFacade } from "./index.js";
import { sqliteResetPaths } from "./artifacts.js";
import { createStateStore, openStateStore } from "../store/open.js";

const recoverSqliteReset = sqliteResetFacade.recover;

const roots: string[] = [];
const ID = "1".repeat(32);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; state: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-classifier-"));
  roots.push(root);
  const state = path.join(root, ".rbox", "state");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "state.json"), `RBOX-SQLITE-AUTHORITY-v1\n${ID}\n`);
  await fs.writeFile(path.join(state, "state.db"), "SQLite format 3\0active");
  return { root, state };
}

async function snapshot(root: string): Promise<string> {
  const entries: string[] = [];
  async function walk(directory: string, prefix = ""): Promise<void> {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`);
      else entries.push(`${relative}:${(await fs.readFile(path.join(directory, entry.name))).toString("hex")}`);
    }
  }
  await walk(root);
  return entries.join("\n");
}

test("standing malformed journal plus non-derived candidate WAL is W2 before decode and zero-write", async () => {
  const { root, state } = await fixture();
  await fs.writeFile(path.join(state, "reset-v1.json"), "{not json");
  const candidates = path.join(state, "reset-candidates");
  await fs.mkdir(candidates);
  await fs.writeFile(path.join(candidates, `${"2".repeat(32)}.db`), "candidate");
  await fs.writeFile(path.join(candidates, `${"2".repeat(32)}.db-wal`), "");
  const before = await snapshot(root);
  expect((await classifySqliteResetPredecode(root)).kind).toBe("W2");
  expect(await snapshot(root)).toBe(before);
});

test("standing journal with S0 artifacts is the only decode admission", async () => {
  const { root, state } = await fixture();
  await fs.writeFile(path.join(state, "reset-v1.json"), "{}");
  expect((await classifySqliteResetPredecode(root)).kind).toBe("decode-journal");
});

test("no-journal active WAL is W1 while orphan candidate WAL is W3", async () => {
  const first = await fixture();
  await fs.writeFile(path.join(first.state, "state.db-wal"), "");
  expect((await classifySqliteResetPredecode(first.root)).kind).toBe("W1");

  const second = await fixture();
  const candidates = path.join(second.state, "reset-candidates");
  await fs.mkdir(candidates);
  await fs.writeFile(path.join(candidates, `${"3".repeat(32)}.db`), "candidate");
  await fs.writeFile(path.join(candidates, `${"3".repeat(32)}.db-shm`), "");
  expect((await classifySqliteResetPredecode(second.root)).kind).toBe("W3");
  await expect(recoverSqliteReset(second.root, "old")).rejects.toBeInstanceOf(ResetOrphanArtifactHalt);
});

/**
 * Design 276 F2.2. A daemon that holds its own store open publishes exactly the
 * `SW` signature a crashed writer leaves behind, so an lstat-only classifier
 * calls the daemon's own liveness a WAL crash (#765). The registry consult is
 * the ownership input that separates them, and the second half of this test is
 * the soundness control: a crashed-and-restarted process has an EMPTY registry,
 * so a genuine crash is never masked.
 */
test("a live in-process writer proves SW is a live store, and an empty registry still reads W1", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-live-store-"));
  roots.push(root);
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await fs.writeFile(sqliteResetPaths.authorityMarker(root), `RBOX-SQLITE-AUTHORITY-v1\n${ID}\n`);
  const active = sqliteResetPaths.active(root);
  createStateStore(active, {
    authorityId: ID, lineageId: "b".repeat(32), stream: "old",
    createdBy: "classifier-test", stateNonce: "1".repeat(32), stateRevision: 1,
  }).close();

  const writer = openStateStore(active);
  try {
    await fs.writeFile(`${active}-wal`, "");
    expect((await classifySqliteResetPredecode(root)).kind).toBe("steady");
  } finally {
    writer.close();
  }

  // Negative control: the consult admits an owned WRITER only. A reader handle
  // proves nothing about who owns the write-ahead log, so the same sidecar with
  // only a reader open still classifies as a crash.
  const reader = openStateStore(active, { readonly: true });
  try {
    await fs.writeFile(`${active}-wal`, "");
    expect((await classifySqliteResetPredecode(root)).kind).toBe("W1");
  } finally {
    reader.close();
  }

  await fs.writeFile(`${active}-wal`, "");
  expect((await classifySqliteResetPredecode(root)).kind).toBe("W1");
});

test("W2 sidecar precedence wins over legacy-other", async () => {
  const { root, state } = await fixture();
  await fs.writeFile(path.join(state, "reset-v1.json"), "{");
  const candidates = path.join(state, "reset-candidates");
  await fs.mkdir(candidates);
  await fs.mkdir(path.join(candidates, `${"4".repeat(32)}.json`));
  await fs.writeFile(path.join(state, "state.db-shm"), "");
  expect((await classifySqliteResetPredecode(root)).kind).toBe("W2");
});
