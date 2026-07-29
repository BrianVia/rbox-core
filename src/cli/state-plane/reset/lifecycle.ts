import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  checkpointStateStoreForReset,
  closeOwnedStateStoreReadersForReset,
  createStateStore,
  openStateStore,
  openStateStoreForWalTakeover,
  ownedStateStoreWriterForReset,
  stateStoreDatabase,
} from "../store-facade.js";
import { readAuthorityMarkerId } from "../authority-marker.js";
import { fsyncDirectory } from "../../../engine/fsutil.js";
import {
  fsyncDbAndParent,
  readExactDbSeed,
  requireDbArtifactS0,
  sqliteResetPaths,
} from "./artifacts.js";

export interface SqliteResetLineage {
  stream: string;
  stateNonce: string;
  stateRevision: number;
  telemetryBindingId?: string;
}

export interface PreparedResetDbSeed {
  bytes: Buffer;
  sha256: string;
  stateNonce: string;
  stateRevision: number;
}

export async function readSqliteAuthorityId(root: string): Promise<string> {
  const authorityId = await readAuthorityMarkerId(sqliteResetPaths.authorityMarker(root));
  if (authorityId === undefined) throw new Error("SQLite reset requires the exact authority marker");
  return authorityId;
}

export async function quiesceActiveDbForReset(root: string): Promise<SqliteResetLineage> {
  const authorityId = await readSqliteAuthorityId(root);
  const file = sqliteResetPaths.active(root);
  closeOwnedStateStoreReadersForReset(file);
  const store = ownedStateStoreWriterForReset(file) ?? openStateStore(file);
  let lineage: (SqliteResetLineage & { authorityId: string }) | undefined;
  try {
    const db = stateStoreDatabase(store);
    const row = db.query(`SELECT
      m.authority_id AS authorityId,l.stream,l.state_nonce AS stateNonce,
      l.state_revision AS stateRevision,l.telemetry_binding_id AS telemetryBindingId
      FROM store_meta m JOIN state_lineage l ON l.lineage_id=m.active_lineage_id
      WHERE m.singleton=1`).get() as {
        authorityId: string; stream: string; stateNonce: string | null;
        stateRevision: number | null; telemetryBindingId: string | null;
      } | null;
    if (!row || !row.stateNonce || row.stateRevision === null) throw new Error("SQLite reset active lineage is incomplete");
    lineage = {
      authorityId: row.authorityId,
      stream: row.stream,
      stateNonce: row.stateNonce,
      stateRevision: row.stateRevision,
      ...(row.telemetryBindingId === null ? {} : { telemetryBindingId: row.telemetryBindingId }),
    };
    checkpointStateStoreForReset(store);
  } finally {
    store.close();
  }
  if (!lineage || lineage.authorityId !== authorityId) throw new Error("SQLite reset authority/DB identity mismatch");
  await requireDbArtifactS0(file);
  await fsyncDbAndParent(file);
  await requireDbArtifactS0(file);
  return {
    stream: lineage.stream,
    stateNonce: lineage.stateNonce,
    stateRevision: lineage.stateRevision,
    ...(lineage.telemetryBindingId === undefined ? {} : { telemetryBindingId: lineage.telemetryBindingId }),
  };
}

/** W1 is the only path allowed to open an active DB carrying WAL/SHM. */
export async function recoverOrdinaryWalCrash(
  root: string,
  expected?: Partial<SqliteResetLineage>,
  hooks: { crashAt?: (point: string) => void | Promise<void> } = {},
): Promise<SqliteResetLineage> {
  const authorityId = await readSqliteAuthorityId(root);
  const file = sqliteResetPaths.active(root);
  closeOwnedStateStoreReadersForReset(file);
  const store = openStateStoreForWalTakeover(file);
  let observed: SqliteResetLineage & { authorityId: string };
  try {
    const db = stateStoreDatabase(store);
    const row = db.query(`SELECT
      m.authority_id AS authorityId,l.stream,l.state_nonce AS stateNonce,
      l.state_revision AS stateRevision,l.telemetry_binding_id AS telemetryBindingId
      FROM store_meta m JOIN state_lineage l ON l.lineage_id=m.active_lineage_id
      WHERE m.singleton=1`).get() as {
        authorityId: string; stream: string; stateNonce: string | null;
        stateRevision: number | null; telemetryBindingId: string | null;
      } | null;
    if (!row || !row.stateNonce || row.stateRevision === null) throw new Error("W1 active lineage is incomplete");
    observed = {
      authorityId: row.authorityId,
      stream: row.stream,
      stateNonce: row.stateNonce,
      stateRevision: row.stateRevision,
      ...(row.telemetryBindingId === null ? {} : { telemetryBindingId: row.telemetryBindingId }),
    };
    if (observed.authorityId !== authorityId) throw new Error("W1 authority mismatch");
    if (expected?.stream !== undefined && expected.stream !== observed.stream) throw new Error("W1 stream mismatch");
    if (expected?.stateNonce !== undefined && expected.stateNonce !== observed.stateNonce) throw new Error("W1 nonce mismatch");
    if (expected?.stateRevision !== undefined && expected.stateRevision !== observed.stateRevision) throw new Error("W1 revision mismatch");
    await hooks.crashAt?.("before-w1-checkpoint");
    checkpointStateStoreForReset(store);
    await hooks.crashAt?.("after-w1-checkpoint");
  } finally {
    store.close();
  }
  await requireDbArtifactS0(file);
  await fsyncDbAndParent(file);
  if (await readSqliteAuthorityId(root) !== authorityId) throw new Error("W1 authority changed after checkpoint");
  return {
    stream: observed.stream,
    stateNonce: observed.stateNonce,
    stateRevision: observed.stateRevision,
    ...(observed.telemetryBindingId === undefined ? {} : { telemetryBindingId: observed.telemetryBindingId }),
  };
}

export async function prepareEmptyResetDbSeed(
  root: string,
  next: SqliteResetLineage,
  authorityId: string,
): Promise<PreparedResetDbSeed> {
  const directory = path.join(sqliteResetPaths.stateRoot(root), "reset-candidates");
  await fs.mkdir(directory, { recursive: true });
  const basename = `seed-${next.stateNonce}.db`;
  const temp = path.join(
    directory,
    `.rbox-tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}-${basename}`,
  );
  let created = false;
  try {
    const store = createStateStore(temp, {
      stream: next.stream,
      authorityId,
      lineageId: next.stateNonce,
      stateNonce: next.stateNonce,
      stateRevision: next.stateRevision,
      ...(next.telemetryBindingId === undefined ? {} : { telemetryBindingId: next.telemetryBindingId }),
      createdBy: "reset-v1/sqlite",
    });
    created = true;
    try { checkpointStateStoreForReset(store); } finally { store.close(); }
    await requireDbArtifactS0(temp);
    await fsyncDbAndParent(temp);
    const bytes = await readExactDbSeed(temp);
    return {
      bytes,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      stateNonce: next.stateNonce,
      stateRevision: next.stateRevision,
    };
  } finally {
    if (created) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        await fs.rm(`${temp}${suffix}`, { force: true }).catch(() => undefined);
      }
      await fsyncDirectory(directory).catch(() => undefined);
    }
  }
}
