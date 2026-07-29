import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { StateStoreOpenError } from "../errors.js";
import {
  applySchemaV1,
  installGenesisLineage,
  STATE_STORE_SQLITE_APPLICATION_ID,
  STATE_STORE_SQLITE_USER_VERSION,
  type GenesisLineage,
} from "../schema/application.js";
import { validateOpen, type StoreHeader } from "../schema/validate-open.js";

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
  const row = db.query(`PRAGMA ${pragma}`).get() as Record<string, number | string> | null;
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
    queryOnly: readonly ? 1 : 0,
    ...(process.platform === "darwin" ? { fullfsync: 1, checkpointFullfsync: 1 } : {}),
  };
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
}

function configureReader(db: Database): void {
  if (process.platform === "darwin") db.exec("PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON");
  db.exec(`
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA wal_autocheckpoint=1000;
    PRAGMA cache_size=-8192;
    PRAGMA busy_timeout=250;
    PRAGMA temp_store=FILE;
    PRAGMA query_only=ON;
  `);
}

export class StateStoreHandle {
  #closed = false;

  constructor(
    readonly file: string,
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
    if (!this.readonly) {
      try { connection.query("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch {}
    }
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
  const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as
    | { busy?: unknown; log?: unknown; checkpointed?: unknown }
    | null;
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

export function openStateStore(file: string, options: { readonly?: boolean } = {}): StateStoreHandle {
  const readonly = options.readonly === true;
  // Read-only preflight first: a foreign SQLite file must not be converted to
  // WAL or otherwise mutated merely because rbox refuses it.
  let preflight: Database;
  try {
    preflight = new Database(file, { create: false, readonly: true });
  } catch (error) {
    throw new StateStoreOpenError("not-a-database", file, String(error), error);
  }
  let opened: Database | undefined;
  try {
    const header = validateOpen(preflight, file);
    preflight.close();
    opened = new Database(file, { create: false, readonly, readwrite: !readonly });
    if (readonly) configureReader(opened); else configureWriter(opened);
    const pragmas = readPragmas(opened);
    assertPragmas(pragmas, readonly, file);
    return new StateStoreHandle(file, readonly, header, pragmas, opened);
  } catch (error) {
    try { preflight.close(); } catch {}
    try { opened?.close(); } catch {}
    throw error;
  }
}

/**
 * W1-only owning-writer open. A read-only preflight is forbidden here because
 * opening a WAL-mode database may itself participate in recovery.
 */
export function openStateStoreForWalTakeover(file: string): StateStoreHandle {
  let db: Database | undefined;
  try {
    db = new Database(file, { create: false, readwrite: true });
    configureWriter(db);
    const header = validateOpen(db, file);
    const pragmas = readPragmas(db);
    assertPragmas(pragmas, false, file);
    return new StateStoreHandle(file, false, header, pragmas, db);
  } catch (error) {
    try { db?.close(); } catch {}
    throw error;
  }
}
