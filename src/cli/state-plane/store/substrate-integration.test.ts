import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as storeFacade from "../store-facade.js";
import {
  loadRawStateFromStore,
  materializeManifestFromStore,
} from "../adapters/read-only.js";
import { publishStateBackup } from "../backup/publish.js";
import { stateSemanticDigest } from "../digest/state-semantic-v1.js";
import { createStateStore, stateStoreDatabase } from "./open.js";
import { openReadSnapshot } from "./read-snapshot.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("genesis read projections, state digest, and backup publication agree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-store-substrate-"));
  roots.push(root);
  const handle = createStateStore(path.join(root, "state.db"), {
    authorityId: "a".repeat(32),
    lineageId: "b".repeat(32),
    stream: "stream",
    createdBy: "test",
  });

  const snapshot = openReadSnapshot(handle);
  expect(snapshot.files("base", undefined, 512)).toEqual({ rows: [], done: true });
  expect(snapshot.repos(undefined, 16)).toEqual({ rows: [], done: true });
  snapshot.finishProjection();

  expect(materializeManifestFromStore(handle, {
    plane: "base",
    purpose: "wire-snapshot",
    projectionToken: snapshot.token,
  })).toEqual({ generatedAt: "", files: [] });
  expect(loadRawStateFromStore(handle)).toEqual({
    stream: "stream",
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
    repoRecords: {},
  });
  expect(stateSemanticDigest(stateStoreDatabase(handle)))
    .toBe("cf4c1f7481d725a468cf3679d4eb99eb14040df7dc2438a37887b424ef6b8700");

  const destination = path.join(root, "backups", "state.db");
  const result = publishStateBackup({
    source: handle,
    destination,
    backupId: "c".repeat(32),
  });
  expect(result.bytes).toBeGreaterThan(0);
  expect(result.physicalSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(fs.statSync(destination).size).toBe(result.bytes);
  expect(() => publishStateBackup({
    source: handle,
    destination,
    backupId: "d".repeat(32),
  })).toThrow("already exists");
  handle.close();
});

test("the SQLite facade exposes no expected-stream policy that can fabricate genesis", () => {
  expect(Object.keys(storeFacade)).not.toContain("loadStateFromStore");
  expect(Object.keys(storeFacade)).not.toContain("readOnlyAdapters");
});

test("backup publication removes owned staging when a foreign destination races the link", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-store-backup-race-"));
  roots.push(root);
  const handle = createStateStore(path.join(root, "state.db"), {
    authorityId: "a".repeat(32), lineageId: "b".repeat(32), stream: "stream", createdBy: "test",
  });
  const destination = path.join(root, "backups", "raced.db");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const backupId = "e".repeat(32);
  const staging = `${destination}.backup-${backupId}`;
  const link = spyOn(fs, "linkSync").mockImplementation((_source, target) => {
    fs.writeFileSync(target, "foreign-owner");
    const error = new Error("destination raced") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  });
  try {
    expect(() => publishStateBackup({ source: handle, destination, backupId })).toThrow("destination raced");
  } finally {
    link.mockRestore();
    handle.close();
  }
  expect(fs.readFileSync(destination, "utf8")).toBe("foreign-owner");
  expect(fs.existsSync(staging)).toBe(false);
});

test("backup publication never removes a foreign staging claim", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-store-backup-staging-race-"));
  roots.push(root);
  const handle = createStateStore(path.join(root, "state.db"), {
    authorityId: "a".repeat(32), lineageId: "b".repeat(32), stream: "stream", createdBy: "test",
  });
  const destination = path.join(root, "backups", "state.db");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const backupId = "f".repeat(32);
  const foreignStaging = `${destination}.backup-${backupId}`;
  fs.writeFileSync(foreignStaging, "foreign-staging-owner");
  expect(() => publishStateBackup({ source: handle, destination, backupId })).toThrow();
  expect(fs.readFileSync(foreignStaging, "utf8")).toBe("foreign-staging-owner");
  handle.close();
});

test("state semantic digest refuses a missing completion singleton", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-store-digest-completion-"));
  roots.push(root);
  const handle = createStateStore(path.join(root, "state.db"), {
    authorityId: "a".repeat(32), lineageId: "b".repeat(32), stream: "stream", createdBy: "test",
  });
  const db = stateStoreDatabase(handle);
  db.exec("DELETE FROM migration_completion");
  expect(() => stateSemanticDigest(db)).toThrow("requires migration_completion singleton");
  handle.close();
});
