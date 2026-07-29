import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStoreOpenError } from "../errors.js";
import { installGenesisLineage } from "./application.js";
import {
  adoptClaimedStateStore,
  createStateStore,
  openStateStore,
} from "../store/open.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function file(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-store-open-"));
  roots.push(root);
  return path.join(root, "state.db");
}

const genesis = {
  authorityId: "a".repeat(32),
  lineageId: "b".repeat(32),
  stream: "workspace/project",
  createdBy: "test",
  stateNonce: "c".repeat(32),
  stateRevision: 0,
  telemetryBindingId: "d".repeat(16),
};

test("fresh create, writer reopen, and read-only reopen pin their own pragmas", () => {
  const target = file();
  const created = createStateStore(target, genesis);
  expect(created.pragmas).toMatchObject({
    pageSize: 4096, applicationId: 0x52424f58, userVersion: 1,
    journalMode: "wal", synchronous: 2, foreignKeys: 1,
    walAutocheckpoint: 1000, cacheSize: -32768,
    journalSizeLimit: 67108864, busyTimeout: 5000, tempStore: 1,
  });
  created.close();

  const writer = openStateStore(target);
  expect(writer.pragmas.cacheSize).toBe(-32768);
  writer.close();
  expect(fs.existsSync(`${target}-wal`)).toBe(false);
  const reader = openStateStore(target, { readonly: true });
  expect(reader.pragmas).toMatchObject({ cacheSize: -8192, busyTimeout: 250, queryOnly: 1 });
  if (process.platform === "darwin") {
    expect(reader.pragmas).toMatchObject({ fullfsync: 1, checkpointFullfsync: 1, walAutocheckpoint: 1000 });
  }
  reader.close();
});

test("foreign SQLite preflight refuses without changing journal mode", () => {
  const target = file();
  const foreign = new Database(target);
  foreign.exec("PRAGMA journal_mode=DELETE; CREATE TABLE foreign_table(value TEXT)");
  foreign.close();
  let error: unknown;
  try { openStateStore(target); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(StateStoreOpenError);
  expect((error as StateStoreOpenError).reason).toBe("foreign-by-absence");
  const check = new Database(target, { readonly: true });
  expect((check.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
  check.close();
});

test("wrong SQLite version, missing frozen object, and corrupt header are typed", () => {
  for (const mode of ["version", "schema", "header"] as const) {
    const target = file();
    createStateStore(target, genesis).close();
    if (mode === "header") {
      const bytes = fs.readFileSync(target);
      bytes.fill(0x58, 0, 16);
      fs.writeFileSync(target, bytes);
    } else {
      const db = new Database(target);
      if (mode === "version") db.exec("PRAGMA user_version=2");
      else db.exec("DROP INDEX repo_records_order");
      db.close();
    }
    let error: unknown;
    try { openStateStore(target); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(StateStoreOpenError);
    expect((error as StateStoreOpenError).reason).toBe(
      mode === "version" ? "wrong-application" : mode === "schema" ? "ddl-fingerprint" : "not-a-database",
    );
  }
});

test("genesis identifiers and counters reject outside their exact domains", () => {
  expect(() => createStateStore(file(), { ...genesis, authorityId: "no" })).toThrow("authorityId");
  expect(() => createStateStore(file(), { ...genesis, stateRevision: -1 })).toThrow("stateRevision");
  expect(() => createStateStore(file(), { ...genesis, telemetryBindingId: "x".repeat(16) })).toThrow("telemetryBindingId");
});

test("failed create removes only its own claim and every SQLite sidecar", () => {
  const target = file();
  expect(() => createStateStore(target, { ...genesis, authorityId: "invalid" })).toThrow("authorityId");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) expect(fs.existsSync(`${target}${suffix}`)).toBe(false);

  const existing = file();
  createStateStore(existing, genesis).close();
  const before = fs.readFileSync(existing);
  expect(() => createStateStore(existing, genesis)).toThrow();
  expect(fs.readFileSync(existing)).toEqual(before);
});

test("an exact zero-byte 0600 claim is adopted through the ordinary initializer", () => {
  const target = file();
  fs.closeSync(fs.openSync(target, "wx", 0o600));
  const stat = fs.lstatSync(target);
  const adopted = adoptClaimedStateStore(target, { dev: stat.dev, ino: stat.ino }, (db) => {
    installGenesisLineage(db, genesis);
  });
  expect(adopted.header).toMatchObject({
    authority_id: genesis.authorityId,
    active_lineage_id: genesis.lineageId,
  });
  adopted.close();
  openStateStore(target, { readonly: true }).close();
});

test("adoption refusals do not delete an unowned claim", () => {
  for (const shape of ["identity", "bytes", "mode", "sidecar"] as const) {
    const target = file();
    fs.closeSync(fs.openSync(target, "wx", 0o600));
    const stat = fs.lstatSync(target);
    if (shape === "bytes") fs.writeFileSync(target, "foreign");
    if (shape === "mode") fs.chmodSync(target, 0o640);
    if (shape === "sidecar") fs.writeFileSync(`${target}-wal`, "foreign");
    const expected = shape === "identity"
      ? { dev: stat.dev, ino: stat.ino + 1 }
      : { dev: stat.dev, ino: stat.ino };
    expect(() => adoptClaimedStateStore(target, expected, (db) => {
      installGenesisLineage(db, genesis);
    })).toThrow();
    expect(fs.existsSync(target)).toBe(true);
    if (shape === "sidecar") expect(fs.readFileSync(`${target}-wal`, "utf8")).toBe("foreign");
  }
});

test("a caught adopter installer failure removes its owned main and sidecars", () => {
  const target = file();
  fs.closeSync(fs.openSync(target, "wx", 0o600));
  const stat = fs.lstatSync(target);
  expect(() => adoptClaimedStateStore(target, { dev: stat.dev, ino: stat.ino }, () => {
    throw new Error("installer failed");
  })).toThrow("installer failed");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    expect(fs.existsSync(`${target}${suffix}`)).toBe(false);
  }
});

test("adopter cleanup never removes a replacement inode", () => {
  const target = file();
  const displaced = `${target}.owned`;
  fs.closeSync(fs.openSync(target, "wx", 0o600));
  const stat = fs.lstatSync(target);
  expect(() => adoptClaimedStateStore(target, { dev: stat.dev, ino: stat.ino }, () => {
    fs.renameSync(target, displaced);
    fs.writeFileSync(target, "replacement", { mode: 0o600 });
    throw new Error("after replacement");
  })).toThrow("after replacement");
  expect(fs.readFileSync(target, "utf8")).toBe("replacement");
  expect(fs.existsSync(displaced)).toBe(true);
});
