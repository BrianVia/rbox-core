/**
 * Encrypt-address cache, SQLite backing (issue 822).
 *
 * The JSON backing rewrote and fsynced the whole ~127k-entry file for a one-entry
 * change, because one `record` dirtied the file and the flush re-sorted and
 * re-serialized everything. Here one recorded address is one row upsert.
 *
 * A row is a PATH, not a plaintext sha. "One path has exactly one owning sha" is then
 * a PRIMARY KEY the database keeps, instead of the reverse map plus the load-time
 * duplicate scrub the JSON backing had to carry. The body columns repeat per path,
 * which is free: convergent encryption makes the body a function of the plaintext sha
 * within one key epoch, and a changed epoch drops the whole table.
 *
 * Its own database rather than a table in `state.db`, because this is derived data.
 * Losing all of it costs a re-encrypt, so it may be `synchronous=NORMAL` (push writes
 * here far more often than it commits state, and a cache must never make the fleet pay
 * an fsync per encrypted file) and it may be deleted and rebuilt on corruption. The
 * authoritative store may do neither, and a cache write must not be able to fail a
 * state commit or hold its write lock.
 */
import { constants, Database } from "bun:sqlite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  ENCRYPT_ADDRESS_CACHE_DB_REL,
  ENCRYPT_ADDRESS_CACHE_MIGRATED_REL,
  ENCRYPT_ADDRESS_CACHE_REL,
  assertMigratableAddress,
  assertRecordableAddress,
  parseStoredEncryptAddressCache,
  type EncryptAddressCacheApi,
  type EncryptAddressCacheContext,
  type EncryptAddressCacheEntry,
  type StoredEncryptAddressCacheEntry,
} from "../../engine/encrypt-address-cache.js";
import { runStatement, selectRow, withStatement } from "./store/statements.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_epoch INTEGER NOT NULL,
  key_epoch INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS addresses(
  path TEXT PRIMARY KEY,
  plaintext_sha TEXT NOT NULL,
  enc_sha TEXT NOT NULL,
  cipher_size INTEGER NOT NULL CHECK(cipher_size>=0),
  comp TEXT CHECK(comp IS NULL OR comp='zstd'),
  payload_sha TEXT,
  CHECK((comp IS NULL)=(payload_sha IS NULL))
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS addresses_by_sha ON addresses(plaintext_sha);
`;

const UPSERT = `INSERT INTO addresses(path,plaintext_sha,enc_sha,cipher_size,comp,payload_sha)
  VALUES(?,?,?,?,?,?)
  ON CONFLICT(path) DO UPDATE SET
    plaintext_sha=excluded.plaintext_sha, enc_sha=excluded.enc_sha,
    cipher_size=excluded.cipher_size, comp=excluded.comp, payload_sha=excluded.payload_sha
  WHERE plaintext_sha IS NOT excluded.plaintext_sha OR enc_sha IS NOT excluded.enc_sha
     OR cipher_size IS NOT excluded.cipher_size OR comp IS NOT excluded.comp
     OR payload_sha IS NOT excluded.payload_sha`;

interface AddressRow {
  enc_sha: string;
  cipher_size: number;
  comp: string | null;
  payload_sha: string | null;
}

/** The state store's writer pragmas, with `synchronous=NORMAL` in place of `FULL`
 *  (see the module header) and no application id or user version: an unreadable cache
 *  is recreated rather than diagnosed, so it has nothing to identify itself for.
 *  `PERSIST_WAL=0` is what lets `close()` take the `-wal`/`-shm` sidecars with it. */
function configure(db: Database): void {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA wal_autocheckpoint=1000;
    PRAGMA cache_size=-32768;
    PRAGMA journal_size_limit=67108864;
    PRAGMA busy_timeout=5000;
    PRAGMA temp_store=FILE;
    PRAGMA query_only=OFF;
  `);
  if (process.platform === "darwin") db.exec("PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON");
  db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
}

function openDatabase(file: string): Database {
  const db = new Database(file, { create: true, readwrite: true });
  try {
    configure(db);
    db.exec(SCHEMA);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // The open failed; a close failure on the way out adds nothing to report.
    }
    throw error;
  }
}

/** A cache that will not open is discarded, not repaired: every row is recoverable by
 *  encrypting the file again, and refusing the push instead would be strictly worse. */
function openOrRecreate(file: string): Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    return openDatabase(file);
  } catch {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${file}${suffix}`, { force: true });
    return openDatabase(file);
  }
}

function inTransaction(db: Database, body: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    body();
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** The cache is only ever valid for one (account, workspace, epoch pair); the JSON
 *  backing enforced that by discarding a header that did not match, and this is the
 *  same rule applied once per open. */
function reconcileContext(db: Database, context: EncryptAddressCacheContext): void {
  const row = selectRow<{ account_id: string; workspace_id: string; account_epoch: number; key_epoch: number }>(
    db, "SELECT account_id,workspace_id,account_epoch,key_epoch FROM meta WHERE singleton=1");
  if (row
    && row.account_id === context.accountId && row.workspace_id === context.workspaceId
    && row.account_epoch === context.accountEpoch && row.key_epoch === context.keyEpoch) return;
  inTransaction(db, () => {
    runStatement(db, "DELETE FROM addresses");
    runStatement(db, `INSERT INTO meta(singleton,account_id,workspace_id,account_epoch,key_epoch)
      VALUES(1,?,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET
        account_id=excluded.account_id, workspace_id=excluded.workspace_id,
        account_epoch=excluded.account_epoch, key_epoch=excluded.key_epoch`,
      context.accountId, context.workspaceId, context.accountEpoch, context.keyEpoch);
  });
}

function insertLegacyEntries(db: Database, entries: ReadonlyMap<string, StoredEncryptAddressCacheEntry>): void {
  inTransaction(db, () => {
    withStatement(db, `INSERT OR IGNORE INTO addresses(path,plaintext_sha,enc_sha,cipher_size,comp,payload_sha)
      VALUES(?,?,?,?,?,?)`, (insert) => {
      // Sorted sha order is what makes OR IGNORE reproduce the JSON backing's
      // duplicate-path rule: the first owner in that order keeps the path.
      for (const plaintextSha of [...entries.keys()].sort()) {
        const entry = entries.get(plaintextSha)!;
        for (const relPath of entry.paths) {
          insert.run(relPath, plaintextSha, entry.encSha, entry.cipherSize, entry.comp ?? null, entry.payloadSha ?? null);
        }
      }
    });
  });
}

/** One-way import of the JSON cache, then the file goes aside under `.migrated` so a
 *  second open has nothing to import. An unparseable or context-mismatched file is
 *  moved aside without importing — the JSON backing would have discarded it too. */
async function importLegacyCache(db: Database, root: string, context: EncryptAddressCacheContext): Promise<void> {
  const legacy = path.join(root, ENCRYPT_ADDRESS_CACHE_REL);
  const raw = await fsp.readFile(legacy, "utf8").catch(() => undefined);
  if (raw === undefined) return;
  let entries: ReadonlyMap<string, StoredEncryptAddressCacheEntry> | undefined;
  try {
    entries = parseStoredEncryptAddressCache(JSON.parse(raw), context);
  } catch {
    entries = undefined;
  }
  if (entries && entries.size > 0) insertLegacyEntries(db, entries);
  await fsp.rename(legacy, path.join(root, ENCRYPT_ADDRESS_CACHE_MIGRATED_REL));
}

class SqliteEncryptAddressCache implements EncryptAddressCacheApi {
  constructor(private readonly db: Database) {}

  /** Every `record` is already committed, so the writer that batches JSON flushes has
   *  nothing to do here and the final flush is a no-op rather than a multi-MB write. */
  get needsSave(): boolean {
    return false;
  }

  save(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.db.close();
  }

  lookup(plaintextSha: string): EncryptAddressCacheEntry | undefined {
    const row = selectRow<AddressRow>(this.db,
      "SELECT enc_sha,cipher_size,comp,payload_sha FROM addresses WHERE plaintext_sha=? LIMIT 1", plaintextSha);
    if (!row) return undefined;
    return row.comp === "zstd" && row.payload_sha !== null
      ? { encSha: row.enc_sha, cipherSize: row.cipher_size, comp: "zstd", payloadSha: row.payload_sha }
      : { encSha: row.enc_sha, cipherSize: row.cipher_size };
  }

  /** One upsert. Taking the path from another sha needs no separate eviction: the
   *  PRIMARY KEY means the conflicting row IS the old owner's row. The conflict clause
   *  writes no page when the row already says this, keeping the JSON backing's rule
   *  that re-recording an unchanged address is not a change. */
  record(plaintextSha: string, entry: EncryptAddressCacheEntry & { path: string }): void {
    assertRecordableAddress(plaintextSha, entry);
    runStatement(this.db, UPSERT,
      entry.path, plaintextSha, entry.encSha, entry.cipherSize, entry.comp ?? null, entry.payloadSha ?? null);
  }

  migratePath(plaintextSha: string, relPath: string): boolean {
    assertMigratableAddress(plaintextSha, relPath);
    const row = selectRow<{ plaintext_sha: string }>(this.db, "SELECT plaintext_sha FROM addresses WHERE path=?", relPath);
    if (!row || row.plaintext_sha === plaintextSha) return false;
    runStatement(this.db, "DELETE FROM addresses WHERE path=?", relPath);
    return true;
  }

  prune(livePaths: ReadonlySet<string>): void {
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS live_paths(path TEXT PRIMARY KEY) WITHOUT ROWID");
    try {
      inTransaction(this.db, () => {
        runStatement(this.db, "DELETE FROM temp.live_paths");
        withStatement(this.db, "INSERT OR IGNORE INTO temp.live_paths(path) VALUES(?)", (insert) => {
          for (const relPath of livePaths) insert.run(relPath);
        });
        runStatement(this.db, "DELETE FROM addresses WHERE path NOT IN (SELECT path FROM temp.live_paths)");
      });
    } finally {
      this.db.exec("DROP TABLE IF EXISTS temp.live_paths");
    }
  }
}

/** Open (creating on first use) this workspace's SQLite encrypt-address cache,
 *  importing the JSON cache once if one is still there. The caller owns `close`. */
export async function openEncryptAddressCacheStore(
  root: string,
  context: EncryptAddressCacheContext,
): Promise<EncryptAddressCacheApi> {
  const db = openOrRecreate(path.join(root, ENCRYPT_ADDRESS_CACHE_DB_REL));
  try {
    reconcileContext(db, context);
    await importLegacyCache(db, root, context);
    return new SqliteEncryptAddressCache(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
