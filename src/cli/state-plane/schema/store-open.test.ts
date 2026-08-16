import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStoreOpenError } from "../errors.js";
import { installGenesisLineage } from "./application.js";
import {
  adoptClaimedStateStore,
  createStateStore,
  openStateStore,
  readImmutableStoreLineage,
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
  expect(reader.pragmas).toMatchObject({ cacheSize: -8192, busyTimeout: 250 });
  expect(reader.readonly).toBe(true);
  if (process.platform === "darwin") {
    expect(reader.pragmas).toMatchObject({ fullfsync: 1, checkpointFullfsync: 1, walAutocheckpoint: 1000 });
  }
  reader.close();
});

test("foreign SQLite refusal decides from header bytes and never converts the journal", () => {
  const target = file();
  const foreign = new Database(target);
  foreign.exec("PRAGMA journal_mode=DELETE; CREATE TABLE foreign_table(value TEXT)");
  foreign.close();
  let error: unknown;
  try { openStateStore(target); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(StateStoreOpenError);
  expect((error as StateStoreOpenError).reason).toBe("wrong-application");
  const check = new Database(target, { readonly: true });
  expect((check.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
  check.close();
});

function directorySnapshot(directory: string): string[] {
  return fs.readdirSync(directory).sort().map((name) => {
    const entry = path.join(directory, name);
    const stat = fs.lstatSync(entry);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
    return `${name} mode=${(stat.mode & 0o7777).toString(8)} size=${stat.size} ino=${stat.dev}:${stat.ino} sha256=${digest}`;
  });
}

function refusal(open: () => unknown): StateStoreOpenError {
  try {
    open();
  } catch (caught) {
    if (caught instanceof StateStoreOpenError) return caught;
    throw caught;
  }
  throw new Error("expected a StateStoreOpenError");
}

function patchHeader(target: string, edit: (bytes: Buffer) => void): void {
  const bytes = fs.readFileSync(target);
  edit(bytes);
  fs.writeFileSync(target, bytes);
}

function foreignWalDatabase(): string {
  const target = file();
  const foreign = new Database(target);
  foreign.exec("PRAGMA journal_mode=WAL; CREATE TABLE foreign_table(value TEXT); INSERT INTO foreign_table VALUES ('x')");
  foreign.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  foreign.close();
  return target;
}

test("a refused foreign WAL database is left byte-for-byte untouched", () => {
  const target = foreignWalDatabase();
  const directory = path.dirname(target);
  const before = directorySnapshot(directory);
  expect(before).toHaveLength(1);

  let error: unknown;
  try { openStateStore(target); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(StateStoreOpenError);
  expect(directorySnapshot(directory)).toEqual(before);

  try { openStateStore(target, { readonly: true }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(StateStoreOpenError);
  expect(directorySnapshot(directory)).toEqual(before);
});

test("negative control: a read-only open plus one read is visible in the snapshot", () => {
  const target = foreignWalDatabase();
  const directory = path.dirname(target);
  const before = directorySnapshot(directory);

  const probe = new Database(target, { create: false, readonly: true });
  probe.query("PRAGMA user_version").get();
  probe.close();

  const after = directorySnapshot(directory);
  expect(after).not.toEqual(before);
  expect(after.map((entry) => entry.split(" ")[0])).toEqual([
    "state.db", "state.db-shm", "state.db-wal",
  ]);
});

test("every open of an owned store leaves it at rest with no sidecar", () => {
  const target = file();
  const directory = path.dirname(target);
  createStateStore(target, genesis).close();
  expect(directorySnapshot(directory)).toHaveLength(1);

  openStateStore(target).close();
  expect(fs.readdirSync(directory)).toEqual(["state.db"]);

  const atRest = directorySnapshot(directory);
  openStateStore(target, { readonly: true }).close();
  expect(directorySnapshot(directory)).toEqual(atRest);
});

test("the header gate refuses a symlink, a foreign page size, and a non-WAL journal", () => {
  const owned = file();
  createStateStore(owned, genesis).close();

  const link = path.join(path.dirname(owned), "link.db");
  fs.symlinkSync(owned, link);
  expect(() => openStateStore(link)).toThrow(StateStoreOpenError);
  expect((refusal(() => openStateStore(link))).reason).toBe("not-a-database");

  const resized = file();
  createStateStore(resized, genesis).close();
  patchHeader(resized, (bytes) => bytes.writeUInt16BE(8192, 16));
  expect(refusal(() => openStateStore(resized)).reason).toBe("structural-invariant");

  const journalled = file();
  createStateStore(journalled, genesis).close();
  const flip = new Database(journalled);
  flip.exec("PRAGMA journal_mode=DELETE");
  flip.close();
  const before = directorySnapshot(path.dirname(journalled));
  expect(refusal(() => openStateStore(journalled)).reason).toBe("structural-invariant");
  expect(refusal(() => openStateStore(journalled, { readonly: true })).reason).toBe("structural-invariant");
  expect(directorySnapshot(path.dirname(journalled))).toEqual(before);
});

test("a corrupt body and a directory at the state path stay typed refusals", () => {
  // Each damage has an intact header, so the gate admits it and the refusal has
  // to come from `validateOpen` — which only types it if nothing touched the
  // database first.
  const damages = {
    "page 1 body": (target: string) => patchHeader(target, (bytes) => bytes.fill(0x58, 100, 4096)),
    "truncated mid-page": (target: string) => fs.truncateSync(target, 6000),
    "page count lie": (target: string) => patchHeader(target, (bytes) => bytes.writeUInt32BE(9999, 28)),
  };
  for (const damage of Object.values(damages)) {
    const corrupt = file();
    createStateStore(corrupt, genesis).close();
    damage(corrupt);
    expect(refusal(() => openStateStore(corrupt)).reason).toBe("corrupt");
  }

  const directory = file();
  fs.mkdirSync(directory);
  expect(refusal(() => openStateStore(directory)).reason).toBe("not-a-database");
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

test("the immutable lineage read carries a genesis lineage that has not yet minted a nonce", () => {
  // Genesis is the default for absent state (design 266), so a tracked but
  // never-synced workspace has a settled authority whose nonce and revision are
  // still unset. Reset/rebind consent reads this lineage before the first save,
  // and refusing it there strands `rbox setup` on every freshly tracked folder.
  const withNonce = file();
  createStateStore(withNonce, genesis).close();
  expect(readImmutableStoreLineage(withNonce)).toEqual({
    authorityId: genesis.authorityId,
    stream: genesis.stream,
    stateNonce: genesis.stateNonce,
    stateRevision: genesis.stateRevision,
  });

  const preFirstSave = file();
  const { stateNonce: _nonce, stateRevision: _revision, ...unsaved } = genesis;
  createStateStore(preFirstSave, unsaved).close();
  expect(readImmutableStoreLineage(preFirstSave)).toEqual({
    authorityId: genesis.authorityId,
    stream: genesis.stream,
  });
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
  for (const claim of ["identity", "bytes", "mode", "sidecar"] as const) {
    const target = file();
    fs.closeSync(fs.openSync(target, "wx", 0o600));
    const stat = fs.lstatSync(target);
    if (claim === "bytes") fs.writeFileSync(target, "foreign");
    if (claim === "mode") fs.chmodSync(target, 0o640);
    if (claim === "sidecar") fs.writeFileSync(`${target}-wal`, "foreign");
    const expected = claim === "identity"
      ? { dev: stat.dev, ino: stat.ino + 1 }
      : { dev: stat.dev, ino: stat.ino };
    expect(() => adoptClaimedStateStore(target, expected, (db) => {
      installGenesisLineage(db, genesis);
    })).toThrow();
    expect(fs.existsSync(target)).toBe(true);
    if (claim === "sidecar") expect(fs.readFileSync(`${target}-wal`, "utf8")).toBe("foreign");
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
