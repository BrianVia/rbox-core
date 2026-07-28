import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFilesWithin, sqliteErrorCode } from "./helpers";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-sqlite-contract-"));
  roots.push(root);
  return root;
}

function databasePath(): string {
  return path.join(tempRoot(), "contract.sqlite");
}

function caught(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to throw");
}

function expectSqliteCode(operation: () => unknown, code: string): unknown {
  const error = caught(operation);
  expect(sqliteErrorCode(error)).toBe(code);
  return error;
}

test("WAL and FULL synchronous mode survive set-and-readback", () => {
  const db = new Database(databasePath());
  try {
    const journal = db.query("PRAGMA journal_mode=WAL").get() as { journal_mode: string };
    db.exec("PRAGMA synchronous=FULL");
    const synchronous = db.query("PRAGMA synchronous").get() as { synchronous: number };

    expect(journal.journal_mode.toLowerCase()).toBe("wal");
    expect(synchronous.synchronous).toBe(2);
  } finally {
    db.close();
  }
});

test("NUMERIC and REAL readback preserve the state-store number contract", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE values_under_test(size NUMERIC NOT NULL, mtime_ms REAL NOT NULL)");
    const exactUnsafeInteger = 2 ** 53 + 2;
    const realAtInt64Boundary = 2 ** 63;
    const insert = db.query("INSERT INTO values_under_test VALUES (?,?)");
    insert.run(exactUnsafeInteger, 1.25);
    insert.run(realAtInt64Boundary, 1.25);

    const read = db.query("SELECT size,mtime_ms,typeof(size) AS storage FROM values_under_test ORDER BY rowid");
    expect(read.safeIntegers()).toBe(false);
    expect(read.all()).toEqual([
      { size: exactUnsafeInteger, mtime_ms: 1.25, storage: "integer" },
      { size: realAtInt64Boundary, mtime_ms: 1.25, storage: "real" },
    ]);
    expect(read.safeIntegers(true)).toBe(read);
    expect(read.all()).toEqual([
      { size: BigInt(exactUnsafeInteger), mtime_ms: 1.25, storage: "integer" },
      { size: realAtInt64Boundary, mtime_ms: 1.25, storage: "real" },
    ]);
  } finally {
    db.close();
  }
});

test("a competing writer waits for busy_timeout before surfacing SQLITE_BUSY", () => {
  const file = databasePath();
  const holder = new Database(file);
  const contender = new Database(file);
  try {
    holder.exec("CREATE TABLE t(value INTEGER); BEGIN IMMEDIATE; INSERT INTO t VALUES (1)");
    contender.exec("PRAGMA busy_timeout=150");

    const started = performance.now();
    expectSqliteCode(() => contender.exec("INSERT INTO t VALUES (2)"), "SQLITE_BUSY");
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(2_000);
  } finally {
    if (holder.inTransaction) holder.exec("ROLLBACK");
    holder.close();
    contender.close();
  }
});

test("TRUNCATE checkpoint reports a busy reader and succeeds after it leaves", () => {
  const file = databasePath();
  const writer = new Database(file);
  const reader = new Database(file);
  try {
    writer.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE t(value INTEGER);
      INSERT INTO t VALUES (1);
    `);
    reader.exec("BEGIN");
    expect(reader.query("SELECT value FROM t").all()).toHaveLength(1);
    writer.exec("INSERT INTO t VALUES (2)");

    const busy = writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    expect(Object.keys(busy).sort()).toEqual(["busy", "checkpointed", "log"]);
    expect(busy.busy).toBe(1);
    expect(Number.isInteger(busy.log)).toBe(true);
    expect(Number.isInteger(busy.checkpointed)).toBe(true);
    expect(busy.log).toBeGreaterThan(busy.checkpointed);

    reader.exec("ROLLBACK");
    const complete = writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    expect(complete.busy).toBe(0);
    expect(complete.log).toBe(0);
    expect(complete.checkpointed).toBe(0);
  } finally {
    if (reader.inTransaction) reader.exec("ROLLBACK");
    reader.close();
    writer.close();
  }
});

test("exhausting max_page_count surfaces SQLITE_FULL", () => {
  const db = new Database(databasePath());
  try {
    db.exec("PRAGMA page_size=512; PRAGMA journal_mode=DELETE; CREATE TABLE t(value BLOB)");
    const pageCount = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    db.exec(`PRAGMA max_page_count=${pageCount + 1}`);

    expectSqliteCode(
      () => db.query("INSERT INTO t VALUES (?)").run(Buffer.alloc(64 * 1024, 0xa5)),
      "SQLITE_FULL",
    );
    expect((db.query("SELECT count(*) AS count FROM t").get() as { count: number }).count).toBe(0);
  } finally {
    db.close();
  }
});

test("an invalid database header surfaces SQLITE_NOTADB", () => {
  const file = databasePath();
  const db = new Database(file);
  db.exec("CREATE TABLE t(value INTEGER)");
  db.close();

  const bytes = fs.readFileSync(file);
  bytes.fill(0x58, 0, 16);
  fs.writeFileSync(file, bytes);

  const invalid = new Database(file);
  try {
    expectSqliteCode(() => invalid.query("SELECT name FROM sqlite_schema").all(), "SQLITE_NOTADB");
  } finally {
    invalid.close();
  }
});

test("an invalid interior b-tree page is diagnosed and surfaces SQLITE_CORRUPT", () => {
  const file = databasePath();
  const db = new Database(file);
  db.exec("PRAGMA page_size=512; PRAGMA journal_mode=DELETE; CREATE TABLE t(value TEXT)");
  const insert = db.prepare("INSERT INTO t VALUES (?)");
  const populate = db.transaction(() => {
    for (let n = 0; n < 1_000; n++) insert.run(`${n}:`.padEnd(48, "x"));
  });
  populate();
  insert.finalize();
  const rootPage = (db.query("SELECT rootpage FROM sqlite_schema WHERE name='t'").get() as { rootpage: number }).rootpage;
  db.close();

  const bytes = fs.readFileSync(file);
  const pageOffset = (rootPage - 1) * 512;
  expect(bytes[pageOffset]).toBe(0x05);
  bytes[pageOffset] = 0x7f;
  fs.writeFileSync(file, bytes);

  const corrupt = new Database(file);
  try {
    const diagnostics = corrupt.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    expect(diagnostics.some((row) => row.integrity_check !== "ok")).toBe(true);
    expectSqliteCode(() => corrupt.query("SELECT count(*) FROM t").get(), "SQLITE_CORRUPT");
  } finally {
    corrupt.close();
  }
});

test("finalized statements reject reuse and close defers for outstanding statements", () => {
  const finalizedDb = new Database(":memory:");
  const finalized = finalizedDb.prepare("SELECT 1 AS value");
  expect(finalized.get()).toEqual({ value: 1 });
  finalized.finalize();
  expect(() => finalized.get()).toThrow();
  finalizedDb.close();

  const deferredDb = new Database(":memory:");
  const outstanding = deferredDb.prepare("SELECT 2 AS value");
  expect(deferredDb.close()).toBeUndefined();
  expect(outstanding.get()).toEqual({ value: 2 });
  expect(() => deferredDb.prepare("SELECT 3")).toThrow();
  outstanding.finalize();
  expect(() => outstanding.get()).toThrow();
});

test("transaction callbacks commit returns and roll back propagated throws", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE t(value TEXT)");
    const commit = db.transaction((value: string) => {
      db.query("INSERT INTO t VALUES (?)").run(value);
      return `committed:${value}`;
    });
    expect(commit("first")).toBe("committed:first");

    const sentinel = new Error("transaction sentinel");
    const rollback = db.transaction(() => {
      db.exec("INSERT INTO t VALUES ('rolled-back')");
      throw sentinel;
    });
    expect(caught(rollback)).toBe(sentinel);
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT value FROM t ORDER BY value").all()).toEqual([{ value: "first" }]);
  } finally {
    db.close();
  }
});

const observesOpenFiles = process.platform === "linux" || process.platform === "darwin";
const tempObservationTest = observesOpenFiles ? test : test.skip;
tempObservationTest(
  `FILE temp_store opens a file-backed temp database (${process.platform} open-file observation)`,
  () => {
    const scratch = tempRoot();
    const db = new Database(":memory:");
    try {
      db.exec(`
        PRAGMA temp_store=FILE;
        PRAGMA temp_store_directory=${JSON.stringify(scratch)};
        PRAGMA temp.cache_size=-64;
        CREATE TEMP TABLE spill(value BLOB);
      `);
      const insert = db.prepare("INSERT INTO spill VALUES (?)");
      db.transaction(() => {
        for (let n = 0; n < 200; n++) insert.run(Buffer.alloc(64 * 1024, n));
      })();
      insert.finalize();

      expect((db.query("PRAGMA temp_store").get() as { temp_store: number }).temp_store).toBe(1);
      const openFiles = openFilesWithin(scratch);
      expect(openFiles).toBeDefined();
      expect(openFiles!.some((file) => file.includes("etilqs_"))).toBe(true);
      // The empty directory proves the observed descriptor is SQLite's
      // delete-on-close temp file, not a persistent fixture artifact.
      expect(fs.readdirSync(scratch)).toEqual([]);
    } finally {
      db.close();
    }
  },
);

test(`${process.platform === "darwin" ? "Darwin" : "non-Darwin no-op"} full-fsync pragmas survive set-and-readback`, () => {
  const db = new Database(databasePath());
  try {
    db.exec("PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON");
    expect((db.query("PRAGMA fullfsync").get() as { fullfsync: number }).fullfsync).toBe(1);
    expect(
      (db.query("PRAGMA checkpoint_fullfsync").get() as { checkpoint_fullfsync: number }).checkpoint_fullfsync,
    ).toBe(1);
  } finally {
    db.close();
  }
});
