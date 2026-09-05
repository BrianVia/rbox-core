/** Never: journal decoding, row policy, or SQLite opens. */
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { boundedHash, boundedRead } from "../../reset-io.js";

export { sqliteResetPaths } from "../paths.js";

export const RESET_NEXT_DB_SEED_LIMIT = 256 * 1024;
export const RESET_SCHEMA_V1_EMPTY_SEED_BYTES = 131_072;
export const SQLITE_RESET_SIDECARS = ["-wal", "-shm", "-journal"] as const;
export type SqliteResetSidecar = typeof SQLITE_RESET_SIDECARS[number];
export type SidecarVector = "S0" | "SW" | "other";

export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

export interface DbArtifactObservation {
  main: "absent" | "regular" | "other";
  sidecars: SidecarVector;
  presentSidecars: readonly SqliteResetSidecar[];
  identity?: FileIdentity;
}

const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

async function regularIdentity(file: string): Promise<FileIdentity | "absent" | "other"> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    if (code === "ELOOP" || code === "EACCES" || code === "EPERM") return "other";
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return "other";
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
    };
  } finally {
    await handle.close();
  }
}

export async function observeDbArtifact(file: string): Promise<DbArtifactObservation> {
  const mainIdentity = await regularIdentity(file);
  const present: SqliteResetSidecar[] = [];
  let sidecarOther = false;
  for (const suffix of SQLITE_RESET_SIDECARS) {
    const disposition = await regularIdentity(`${file}${suffix}`);
    if (disposition === "other") sidecarOther = true;
    else if (disposition !== "absent") present.push(suffix);
  }
  if (mainIdentity === "absent" && present.length > 0) sidecarOther = true;
  const rollback = present.includes("-journal");
  const sidecars: SidecarVector = sidecarOther || rollback
    ? "other"
    : present.length === 0
      ? "S0"
      : "SW";
  return {
    main: mainIdentity === "absent" ? "absent" : mainIdentity === "other" ? "other" : "regular",
    sidecars,
    presentSidecars: present,
    ...(typeof mainIdentity === "object" ? { identity: mainIdentity } : {}),
  };
}

export async function requireDbArtifactS0(file: string): Promise<FileIdentity> {
  const observed = await observeDbArtifact(file);
  if (observed.main !== "regular" || observed.sidecars !== "S0" || !observed.identity) {
    throw new Error(`SQLite reset artifact is not a regular at-rest S0 file: ${file}`);
  }
  return observed.identity;
}

export async function stableDbHash(
  file: string,
  before?: FileIdentity,
): Promise<{ sha256: string; identity: FileIdentity }> {
  const first = before ?? await requireDbArtifactS0(file);
  const sha256 = await boundedHash(file);
  if (!sha256) throw new Error(`SQLite reset artifact disappeared while hashing: ${file}`);
  const second = await requireDbArtifactS0(file);
  if (!sameIdentity(first, second)) throw new Error(`SQLite reset artifact identity changed while hashing: ${file}`);
  return { sha256, identity: second };
}

export async function readExactDbSeed(file: string): Promise<Buffer> {
  const before = await requireDbArtifactS0(file);
  const bytes = await boundedRead(file, RESET_NEXT_DB_SEED_LIMIT);
  if (!bytes || bytes.byteLength === 0) throw new Error("reset next DB seed is absent or empty");
  const after = await requireDbArtifactS0(file);
  if (!sameIdentity(before, after)) throw new Error("reset next DB seed changed while reading");
  return bytes;
}

export async function fsyncDbAndParent(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  const parent = await fs.open(path.dirname(file), "r");
  try { await parent.sync(); } finally { await parent.close(); }
}
