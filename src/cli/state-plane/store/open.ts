import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { StateStoreOpenError } from "../errors.js";
import { applySchemaV1, type GenesisLineage } from "../schema/application.js";
import { validateOpen, type StoreHeader } from "../schema/validate-open.js";

const SQLITE_APPLICATION_ID = 0x52424f58;
const SQLITE_USER_VERSION = 1;

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
    applicationId: SQLITE_APPLICATION_ID,
    userVersion: SQLITE_USER_VERSION,
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
  }
}

const connections = new WeakMap<StateStoreHandle, Database>();

/** @internal state-plane vertical only; deliberately omitted from the facade. */
export function stateStoreDatabase(store: StateStoreHandle): Database {
  const connection = connections.get(store);
  if (!connection) throw new Error("state store is closed");
  return connection;
}

export function createStateStore(file: string, genesis: GenesisLineage): StateStoreHandle {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db: Database | undefined;
  let claimed = false;
  try {
    const claim = fs.openSync(file, "wx", 0o600);
    claimed = true;
    try {
      fs.closeSync(claim);
    } catch (error) {
      fs.rmSync(file, { force: true });
      claimed = false;
      throw error;
    }
    db = new Database(file, { create: false, readwrite: true });
    db.exec(`PRAGMA page_size=4096; PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=${SQLITE_USER_VERSION}`);
    configureWriter(db);
    applySchemaV1(db, genesis);
    const header = validateOpen(db, file);
    const pragmas = readPragmas(db);
    assertPragmas(pragmas, false, file);
    return new StateStoreHandle(file, false, header, pragmas, db);
  } catch (error) {
    try { db?.close(); } catch {}
    if (claimed) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${file}${suffix}`, { force: true });
    }
    throw error;
  }
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
