/** Never: mutate foreign or read-only observations, or redefine frozen schema compatibility. */
import { constants, Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StateStoreOpenError } from "../errors.js";
import {
  applySchemaV1, installGenesisLineage, maintainWriterSchema, STATE_STORE_SQLITE_APPLICATION_ID, STATE_STORE_SQLITE_USER_VERSION, type GenesisLineage,
} from "../schema/application.js";
import { validateOpen, type StoreHeader } from "../schema/validate-open.js";
import { selectRow } from "./statements.js";

export interface StorePragmas {
  pageSize: number;
  applicationId: number;
  userVersion: number;
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  walAutocheckpoint: number;
  cacheSize: number;
  journalSizeLimit: number;
  busyTimeout: number;
  tempStore: number;
  queryOnly: number;
  fullfsync?: number;
  checkpointFullfsync?: number;
}

export interface ClaimedInode {
  readonly dev: number;
  readonly ino: number;
}

function scalar(db: Database, pragma: string): number | string {
  const row = selectRow<Record<string, number | string>>(db, `PRAGMA ${pragma}`);
  if (!row) throw new Error(`PRAGMA ${pragma} returned no row`);
  return Object.values(row)[0]!;
}

function readPragmas(db: Database): StorePragmas {
  const values: StorePragmas = {
    pageSize: Number(scalar(db, "page_size")),
    applicationId: Number(scalar(db, "application_id")),
    userVersion: Number(scalar(db, "user_version")),
    journalMode: String(scalar(db, "journal_mode")).toLowerCase(),
    synchronous: Number(scalar(db, "synchronous")),
    foreignKeys: Number(scalar(db, "foreign_keys")),
    walAutocheckpoint: Number(scalar(db, "wal_autocheckpoint")),
    cacheSize: Number(scalar(db, "cache_size")),
    journalSizeLimit: Number(scalar(db, "journal_size_limit")),
    busyTimeout: Number(scalar(db, "busy_timeout")),
    tempStore: Number(scalar(db, "temp_store")),
    queryOnly: Number(scalar(db, "query_only")),
  };
  if (process.platform === "darwin") {
    values.fullfsync = Number(scalar(db, "fullfsync"));
    values.checkpointFullfsync = Number(scalar(db, "checkpoint_fullfsync"));
  }
  return values;
}

function assertPragmas(values: StorePragmas, readonly: boolean, file: string): void {
  const expected: Partial<StorePragmas> = {
    pageSize: 4096,
    applicationId: STATE_STORE_SQLITE_APPLICATION_ID,
    userVersion: STATE_STORE_SQLITE_USER_VERSION,
    journalMode: "wal",
    synchronous: 2,
    foreignKeys: 1,
    walAutocheckpoint: 1000,
    cacheSize: readonly ? -8192 : -32768,
    busyTimeout: readonly ? 250 : 5000,
    tempStore: 1,
    queryOnly: 0,
  };
  if (process.platform === "darwin") {
    expected.fullfsync = 1;
    expected.checkpointFullfsync = 1;
  }
  if (!readonly) expected.journalSizeLimit = 67108864;
  for (const [key, wanted] of Object.entries(expected)) {
    if (values[key as keyof StorePragmas] !== wanted) {
      throw new StateStoreOpenError("structural-invariant", file, `PRAGMA ${key} read back ${values[key as keyof StorePragmas]}, expected ${wanted}`);
    }
  }
}

function configureWriter(db: Database): void {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
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

/**
 * A reader is an owning connection with reader-sized cache and busy timeout.
 * It is never a SQLite `readonly:true` connection: such a connection creates
 * `-wal`/`-shm` on its first read and cannot remove them at close, leaving the
 * database off `S0`. Read-only-ness is therefore a handle-level flag the
 * store's own write entry points honour, not a SQLite or OS lock.
 */
function configureReader(db: Database): void {
  if (process.platform === "darwin") db.exec("PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON");
  db.exec(`
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA wal_autocheckpoint=1000;
    PRAGMA cache_size=-8192;
    PRAGMA busy_timeout=250;
    PRAGMA temp_store=FILE;
  `);
  db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
}

export class StateStoreHandle {
  #closed = false;

  constructor(
    readonly file: string,
    /** Advisory: the store's write entry points refuse on it. The connection
     * underneath is always read-write, so `stateStoreDatabase` bypasses it. */
    readonly readonly: boolean,
    readonly header: StoreHeader,
    readonly pragmas: StorePragmas,
    connection: Database,
  ) {
    connections.set(this, connection);
    const reference = new WeakRef(this);
    liveStoreReferences.set(this, reference);
    liveStores.add(reference);
    liveStoreFinalizer.register(this, reference, this);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const connection = connections.get(this)!;
    connection.close();
    connections.delete(this);
    const reference = liveStoreReferences.get(this);
    if (reference) liveStores.delete(reference);
    liveStoreReferences.delete(this);
    liveStoreFinalizer.unregister(this);
  }
}

const connections = new WeakMap<StateStoreHandle, Database>();
const liveStoreReferences = new WeakMap<StateStoreHandle, WeakRef<StateStoreHandle>>();
const liveStores = new Set<WeakRef<StateStoreHandle>>();
const liveStoreFinalizer = new FinalizationRegistry<WeakRef<StateStoreHandle>>((reference) => {
  liveStores.delete(reference);
});

function liveStateStores(): StateStoreHandle[] {
  const stores: StateStoreHandle[] = [];
  for (const reference of liveStores) {
    const store = reference.deref();
    if (store) stores.push(store);
    else liveStores.delete(reference);
  }
  return stores;
}

export interface ResetCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

/**
 * Reset-only strict checkpoint boundary. Unlike ordinary close(), failure and
 * a busy reader are observable and therefore cannot be mistaken for an
 * at-rest file-swap witness.
 */
export function checkpointStateStoreForReset(store: StateStoreHandle): ResetCheckpointResult {
  if (store.readonly) throw new Error("reset checkpoint requires the owning writer");
  const db = stateStoreDatabase(store);
  const row = selectRow<{ busy?: unknown; log?: unknown; checkpointed?: unknown }>(
    db, "PRAGMA wal_checkpoint(TRUNCATE)");
  const values = row ? Object.values(row) : [];
  const result = {
    busy: Number(row?.busy ?? values[0]),
    log: Number(row?.log ?? values[1]),
    checkpointed: Number(row?.checkpointed ?? values[2]),
  };
  if (![result.busy, result.log, result.checkpointed].every(Number.isSafeInteger)) {
    throw new Error("reset checkpoint returned an invalid result");
  }
  if (result.busy !== 0) throw new Error(`reset checkpoint remained busy (${result.busy})`);
  return result;
}

export function closeOwnedStateStoreReadersForReset(file: string): void {
  // WeakRef discovery is best-effort; any missed live reader makes the strict
  // checkpoint fail loudly as busy, yielding a transient error rather than corruption.
  for (const store of liveStateStores()) {
    if (store.file === file && store.readonly) store.close();
  }
}

export function ownedStateStoreWriterForReset(file: string): StateStoreHandle | undefined {
  return liveStateStores().find((store) => store.file === file && !store.readonly);
}

/** @internal state-plane vertical only; deliberately omitted from the facade. */
export function stateStoreDatabase(store: StateStoreHandle): Database {
  const connection = connections.get(store);
  if (!connection) throw new Error("state store is closed");
  return connection;
}

type ClaimStateStore = () => ClaimedInode;

function namedInode(file: string): ClaimedInode | undefined {
  try {
    const stat = fs.lstatSync(file);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameClaim(left: ClaimedInode | undefined, right: ClaimedInode): boolean {
  return left?.dev === right.dev && left.ino === right.ino;
}

function initializeClaimedStateStore(
  file: string,
  claim: ClaimStateStore,
  install: (db: Database) => void,
): StateStoreHandle {
  let db: Database | undefined;
  let claimed: ClaimedInode | undefined;
  try {
    claimed = claim();
    db = new Database(file, { create: false, readwrite: true });
    if (!sameClaim(namedInode(file), claimed)) {
      throw new Error("claimed state store path changed while it was opened");
    }
    db.exec(`PRAGMA page_size=4096; PRAGMA application_id=${STATE_STORE_SQLITE_APPLICATION_ID}; PRAGMA user_version=${STATE_STORE_SQLITE_USER_VERSION}`);
    configureWriter(db);
    applySchemaV1(db);
    maintainWriterSchema(db);
    install(db);
    const header = validateOpen(db, file);
    const pragmas = readPragmas(db);
    assertPragmas(pragmas, false, file);
    return new StateStoreHandle(file, false, header, pragmas, db);
  } catch (error) {
    try { db?.close(); } catch {}
    if (claimed && sameClaim(namedInode(file), claimed)) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${file}${suffix}`, { force: true });
    }
    throw error;
  }
}

/** @internal state-plane vertical only; future installers own their transaction. */
export function initializeStateStore(
  file: string,
  install: (db: Database) => void,
): StateStoreHandle {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return initializeClaimedStateStore(file, () => {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      const stat = fs.fstatSync(fd);
      fs.closeSync(fd);
      return { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      try { fs.closeSync(fd); } catch {}
      fs.rmSync(file, { force: true });
      throw error;
    }
  }, install);
}

export function adoptClaimedStateStore(
  file: string,
  expected: ClaimedInode,
  install: (db: Database) => void,
): StateStoreHandle {
  return initializeClaimedStateStore(file, () => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      const named = fs.lstatSync(file);
      const exact = opened.isFile()
        && opened.size === 0
        && (opened.mode & 0o7777) === 0o600
        && opened.dev === expected.dev
        && opened.ino === expected.ino
        && named.dev === opened.dev
        && named.ino === opened.ino;
      if (!exact) throw new Error("claimed state store does not match its expected inode");
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        if (namedInode(`${file}${suffix}`)) throw new Error("claimed state store has a SQLite sidecar");
      }
    } finally {
      fs.closeSync(fd);
    }
    return expected;
  }, install);
}

export function createStateStore(file: string, genesis: GenesisLineage): StateStoreHandle {
  return initializeStateStore(file, (db) => installGenesisLineage(db, genesis));
}

const SQLITE_HEADER_BYTES = 100;
const SQLITE_HEADER_MAGIC = "SQLite format 3\0";

/**
 * Decide ownership from file bytes, before anything opens the file. Opening a
 * WAL database is a mutation — the first read creates `-wal`/`-shm` — so a
 * refusal that has already opened has already written to data rbox does not
 * own. The 100-byte SQLite header carries every fact this needs: the magic,
 * the page size, the read/write format versions (2 means WAL), and rbox's own
 * `application_id`/`user_version`.
 */
function requireOwnedStateStoreFile(file: string): void {
  const bytes = Buffer.alloc(SQLITE_HEADER_BYTES);
  let read: number;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      read = fs.readSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new StateStoreOpenError("not-a-database", file, String(error), error);
  }
  if (read !== SQLITE_HEADER_BYTES || bytes.subarray(0, 16).toString("latin1") !== SQLITE_HEADER_MAGIC) {
    throw new StateStoreOpenError("not-a-database", file, "file does not begin with a SQLite header");
  }
  const applicationId = bytes.readUInt32BE(68);
  const userVersion = bytes.readUInt32BE(60);
  if (applicationId !== STATE_STORE_SQLITE_APPLICATION_ID || userVersion !== STATE_STORE_SQLITE_USER_VERSION) {
    throw new StateStoreOpenError("wrong-application", file, `SQLite header identity is application=${applicationId}, user_version=${userVersion}`);
  }
  const pageSize = bytes.readUInt16BE(16);
  if (pageSize !== 4096) {
    throw new StateStoreOpenError("structural-invariant", file, `SQLite header page size is ${pageSize === 1 ? 65536 : pageSize}`);
  }
  if (bytes[18] !== 2 || bytes[19] !== 2) {
    throw new StateStoreOpenError("structural-invariant", file, `SQLite header format versions are ${bytes[18]}/${bytes[19]}, expected WAL (2/2)`);
  }
}

export function openStateStore(file: string, options: { readonly?: boolean } = {}): StateStoreHandle {
  const readonly = options.readonly === true;
  requireOwnedStateStoreFile(file);
  let db: Database | undefined;
  try {
    db = new Database(file, { create: false, readwrite: true });
    // Validate before configuring: `validateOpen` is what types a SQLite
    // failure as `corrupt`, so nothing may touch the database ahead of it.
    const header = validateOpen(db, file);
    if (readonly) configureReader(db);
    else { configureWriter(db); maintainWriterSchema(db); }
    const pragmas = readPragmas(db);
    assertPragmas(pragmas, readonly, file);
    return new StateStoreHandle(file, readonly, header, pragmas, db);
  } catch (error) {
    try { db?.close(); } catch {}
    throw error;
  }
}

export interface ImmutableStoreLineage {
  authorityId: string;
  stream: string;
  /** Absent until the lineage's first save mints one. Genesis is the default for
   * absent state (design 266), so a tracked-but-never-synced workspace has a
   * settled authority whose nonce and revision are legitimately unset — that is
   * pre-first-save state, not a structural fault. */
  stateNonce?: string;
  stateRevision?: number;
}

/** Read the main-file lineage without allowing SQLite to create or touch WAL/SHM. */
export function readImmutableStoreLineage(file: string): ImmutableStoreLineage {
  requireOwnedStateStoreFile(file);
  // SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_NOFOLLOW.
  const immutableReadFlags = 1 | 64 | 16_777_216;
  const db = new Database(`${pathToFileURL(file).href}?immutable=1`, immutableReadFlags);
  try {
    const header = validateOpen(db, file);
    const row = selectRow<{ stream: string; stateNonce: string | null; stateRevision: number | null }>(db,
      "SELECT stream,state_nonce AS stateNonce,state_revision AS stateRevision FROM state_lineage WHERE lineage_id=(SELECT active_lineage_id FROM store_meta WHERE singleton=1)");
    if (!row) throw new StateStoreOpenError("structural-invariant", file, "the store names no active lineage");
    const lineage: ImmutableStoreLineage = { authorityId: header.authority_id, stream: row.stream };
    if (row.stateNonce !== null) lineage.stateNonce = row.stateNonce;
    if (row.stateRevision !== null) lineage.stateRevision = row.stateRevision;
    return lineage;
  } finally { db.close(); }
}

/**
 * W1-only owning-writer open. It skips the header gate because W1 exists to
 * recover a database whose current page 1 may still be in the WAL; its caller
 * proves ownership from the authority marker and re-checks `authority_id`.
 */
export function openStateStoreForWalTakeover(file: string): StateStoreHandle {
  let db: Database | undefined;
  try {
    db = new Database(file, { create: false, readwrite: true });
    configureWriter(db);
    const header = validateOpen(db, file);
    maintainWriterSchema(db);
    const pragmas = readPragmas(db);
    assertPragmas(pragmas, false, file);
    return new StateStoreHandle(file, false, header, pragmas, db);
  } catch (error) {
    try { db?.close(); } catch {}
    throw error;
  }
}
