/** Provenance-bound 1 MiB reserve maintained by live legacy JSON publication. */
import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fsyncDirectory, moveNoClobber, RBOX_TMP_PREFIX } from "../../engine/fsutil.js";
import { parseSemver } from "../semver.js";
import { RBOX_VERSION } from "../version.js";
import { RBOX_DIR } from "../workspace-config.js";

export const RESERVE_MAGIC = "RBOX-STATE-RESERVE-v1";
export const RESERVE_HEADER_BYTES = 128;
export const RESERVE_TOTAL_BYTES = 1_048_576;
export const RESERVE_FILL_BYTES = RESERVE_TOTAL_BYTES - RESERVE_HEADER_BYTES; // 1,048,448
/** 128 − (magic + 2 separators + 64-hex digest + LF). */
export const RESERVE_MAX_VERSION_BYTES = RESERVE_HEADER_BYTES - (RESERVE_MAGIC.length + 1 + 1 + 64 + 1);

export const stateReservePath = (root: string): string =>
  path.join(root, RBOX_DIR, "state", "reserve-1mib.bin");

export interface ReserveHeader {
  creatingVersion: string;
  streamSha256: string;
}

export interface ReserveIdentity extends ReserveHeader {
  dev: number;
  ino: number;
  size: number;
  /** The verbatim 128 header bytes. A later claim/delete compares all 128, not
   * the parsed fields, so the two can never drift into "matching fields". */
  headerBytes: Buffer;
}

export type ReserveOutcome =
  | { status: "created"; identity: ReserveIdentity }
  | { status: "adopted"; identity: ReserveIdentity }
  /** The path holds something this workspace's barrier did not create. It is
   * never adopted, claimed, truncated, or deleted — only reported. */
  | { status: "reserve-foreign"; detail: ReserveForeignDetail }
  /** The reserve could not be established for an ordinary environmental reason.
   * Never fatal to the CLI: a later publication can try again. */
  | { status: "unavailable"; detail: string };

export type ReserveForeignDetail =
  | "not-a-regular-file"
  | "wrong-size"
  | "unreadable"
  | "header-malformed"
  | "foreign-workspace";

export type StateReserveCreationStep =
  | "header-written"
  | "fill-written"
  | "temp-synced"
  | "before-final-claim";

export interface StateReserveCreationHooks {
  /** Internal fault-observation seam for persistence tests. */
  onStep?: (step: StateReserveCreationStep) => void | Promise<void>;
}

export const streamDigest = (stream: string): string =>
  crypto.createHash("sha256").update(Buffer.from(stream, "utf8")).digest("hex");

/** The version field is a fixed-width ASCII semver, validated by the same parser
 * the upgrade gate uses — "short enough" is not well-formed. */
function wellFormedVersionField(value: string): boolean {
  if (value.length === 0 || value.length > RESERVE_MAX_VERSION_BYTES) return false;
  if (!/^[\x21-\x7e]+$/.test(value)) return false;
  try {
    parseSemver(value);
    return true;
  } catch {
    return false;
  }
}

export function buildReserveHeader(creatingVersion: string, streamSha256: string): Buffer {
  if (!wellFormedVersionField(creatingVersion)) {
    throw new Error(`reserve header version field is not a semver of at most ${RESERVE_MAX_VERSION_BYTES} bytes`);
  }
  if (!/^[0-9a-f]{64}$/.test(streamSha256)) throw new Error("reserve header digest must be 64 lowercase hex characters");
  const header = Buffer.alloc(RESERVE_HEADER_BYTES); // NUL padding
  header.write(`${RESERVE_MAGIC} ${creatingVersion} ${streamSha256}\n`, 0, "utf8");
  return header;
}

/** Strict inverse of {@link buildReserveHeader}: magic exact, version field
 * well-formed and within bounds, digest exactly 64 lowercase hex, LF present,
 * and every byte from the LF through offset 127 a NUL. */
export function parseReserveHeader(bytes: Uint8Array): ReserveHeader | undefined {
  if (bytes.byteLength !== RESERVE_HEADER_BYTES) return undefined;
  const buffer = Buffer.from(bytes);
  const lf = buffer.indexOf(0x0a);
  if (lf < 0) return undefined;
  for (let i = lf + 1; i < RESERVE_HEADER_BYTES; i++) {
    if (buffer[i] !== 0x00) return undefined;
  }
  const line = buffer.subarray(0, lf).toString("latin1");
  const parts = line.split(" ");
  if (parts.length !== 3) return undefined;
  const [magic, creatingVersion, streamSha256] = parts as [string, string, string];
  if (magic !== RESERVE_MAGIC) return undefined;
  if (!wellFormedVersionField(creatingVersion)) return undefined;
  if (!/^[0-9a-f]{64}$/.test(streamSha256)) return undefined;
  return { creatingVersion, streamSha256 };
}

/**
 * Classify whatever occupies the reserve path. Every property is decided from a
 * single no-follow descriptor: a second pathname lookup could be answered by a
 * symlink swapped in after the first, which would let a header read through the
 * attacker's file be adopted under the original file's identity. `undefined`
 * means the path is genuinely absent; an indeterminate lookup is foreign, never
 * "not reserved yet".
 */
async function classifyExisting(file: string, expectedDigest: string): Promise<ReserveOutcome | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    // ELOOP is O_NOFOLLOW refusing a symlink; EISDIR/EACCES/anything else is an
    // occupant we could not read. None of them may be adopted or replaced.
    return { status: "reserve-foreign", detail: code === "ELOOP" ? "not-a-regular-file" : "unreadable" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { status: "reserve-foreign", detail: "not-a-regular-file" };
    if (stat.size !== RESERVE_TOTAL_BYTES) return { status: "reserve-foreign", detail: "wrong-size" };
    const headerBytes = Buffer.alloc(RESERVE_HEADER_BYTES);
    const { bytesRead } = await handle.read(headerBytes, 0, RESERVE_HEADER_BYTES, 0);
    if (bytesRead !== RESERVE_HEADER_BYTES) return { status: "reserve-foreign", detail: "unreadable" };
    const header = parseReserveHeader(headerBytes);
    if (!header) return { status: "reserve-foreign", detail: "header-malformed" };
    if (header.streamSha256 !== expectedDigest) return { status: "reserve-foreign", detail: "foreign-workspace" };
    return {
      status: "adopted",
      identity: { ...header, dev: Number(stat.dev), ino: Number(stat.ino), size: stat.size, headerBytes },
    };
  } catch {
    return { status: "reserve-foreign", detail: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Read-only classification for diagnostics. Creates nothing. */
export async function inspectStateReserve(root: string, stream: string): Promise<ReserveOutcome> {
  return await classifyExisting(stateReservePath(root), streamDigest(stream))
    ?? { status: "unavailable", detail: "absent" };
}

/**
 * Adopt the existing reserve, or create it exclusively. Attempted once per
 * barrier-era publication path; failure is never fatal to the 1.x binary.
 */
export async function ensureStateReserve(
  root: string,
  stream: string,
  creatingVersion: string = RBOX_VERSION,
  hooks: StateReserveCreationHooks = {},
): Promise<ReserveOutcome> {
  const file = stateReservePath(root);
  const dir = path.dirname(file);
  const expectedDigest = streamDigest(stream);
  const existing = await classifyExisting(file, expectedDigest);
  if (existing) return existing;

  let headerBytes: Buffer;
  try {
    headerBytes = buildReserveHeader(creatingVersion, expectedDigest);
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
  const temp = path.join(
    dir,
    `${RBOX_TMP_PREFIX}${process.pid}-${crypto.randomBytes(8).toString("hex")}-${path.basename(file)}`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let ownsTemp = false;
  try {
    await fs.mkdir(dir, { recursive: true });
    handle = await fs.open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    ownsTemp = true;
    try {
      await handle.writeFile(headerBytes);
      await hooks.onStep?.("header-written");
      await handle.writeFile(Buffer.alloc(RESERVE_FILL_BYTES));
      await hooks.onStep?.("fill-written");
      await handle.sync();
      await hooks.onStep?.("temp-synced");
    } finally {
      await handle.close();
      handle = undefined;
    }
    const tempStat = await fs.lstat(temp);
    await hooks.onStep?.("before-final-claim");
    if (!await moveNoClobber(temp, file, tempStat)) {
      return await classifyExisting(file, expectedDigest) ?? { status: "unavailable", detail: "raced" };
    }
    await fsyncDirectory(dir);
    const published = await classifyExisting(file, expectedDigest);
    if (!published) return { status: "unavailable", detail: "vanished" };
    if (published.status !== "adopted") return published;
    return { status: "created", identity: published.identity };
  } catch (error) {
    return { status: "unavailable", detail: String((error as NodeJS.ErrnoException).code ?? error) };
  } finally {
    await handle?.close().catch(() => undefined);
    if (ownsTemp) await fs.unlink(temp).catch(() => undefined);
  }
}
