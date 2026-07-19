import fs from "node:fs";
import path from "node:path";
import { dlopen, FFIType, ptr, read } from "bun:ffi";

const ATTR_CMN_NAME = 0x1;
const ATTR_CMN_DEVID = 0x2;
const ATTR_CMN_OBJTYPE = 0x8;
const ATTR_CMN_MODIFYTIME = 0x400;
const ATTR_CMN_CHGTIME = 0x800;
const ATTR_CMN_ACCESSMASK = 0x20000;
const ATTR_CMN_FILEID = 0x2000000;
const ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const ATTR_FILE_DATALENGTH = 0x200;
const COMMON_PAYLOAD = ATTR_CMN_NAME | ATTR_CMN_DEVID | ATTR_CMN_OBJTYPE |
  ATTR_CMN_MODIFYTIME | ATTR_CMN_CHGTIME | ATTR_CMN_ACCESSMASK | ATTR_CMN_FILEID;
const COMMON_REQUEST = (ATTR_CMN_RETURNED_ATTRS | COMMON_PAYLOAD) >>> 0;
const FSOPT_PACK_INVAL_ATTRS = 0x8;
const BUFFER_SIZE = 256 * 1024;
// Bytes of packed fixed attributes before the variable-length name data, by
// object type. The common group (through ATTR_CMN_FILEID at 76) is 84 bytes and
// present for EVERY object; ATTR_FILE_DATALENGTH is a file-group attr that the
// kernel packs ONLY for regular files (not dirs/symlinks) even under
// FSOPT_PACK_INVAL_ATTRS — so a directory record is a full 8 bytes shorter. The
// record-length floor must therefore be the common size, not the file size, or
// every dir/symlink entry is wrongly rejected and the whole directory falls back.
const COMMON_FIXED_SIZE = 84;
const FILE_FIXED_SIZE = 92;

type ChildType = BulkChild["type"];
type BulkFn = (fd: number, attrs: number, buffer: number, size: number, options: bigint) => number | bigint;
type ErrorFn = () => number | bigint;

interface Binding {
  bulk: BulkFn;
  error: ErrorFn;
}

type BulkWalkOverride = (absDir: string, warningSink: (line: string) => void) => BulkChild[] | null;

export interface BulkStat {
  ino: number;
  dev: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  /** Raw values are diagnostic-only, used by scripts/bulk-parity.ts. */
  rawTimes?: { mtimeSec: bigint; mtimeNsec: bigint; ctimeSec: bigint; ctimeNsec: bigint };
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface BulkChild {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  stat?: BulkStat;
}

let support: Binding | null | undefined;
let libraryHandle: ReturnType<typeof dlopen> | undefined;
const loggedErrnos = new Set<number>();
let bulkWalkOverride: BulkWalkOverride | undefined;

export function setBulkWalkOverrideForTests(override: BulkWalkOverride | undefined): void {
  bulkWalkOverride = override;
}

function binding(): Binding | null {
  if (support !== undefined) return support;
  if (process.platform !== "darwin") return support = null;
  try {
    const lib = dlopen("libSystem.B.dylib", {
      getattrlistbulk: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.usize, FFIType.u64], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    const bulk = lib.symbols.getattrlistbulk;
    const error = lib.symbols.__error;
    if (!bulk || !error) { lib.close(); return support = null; }
    libraryHandle = lib;
    return support = { bulk: bulk as BulkFn, error: error as ErrorFn };
  } catch {
    return support = null;
  }
}

export function bulkWalkSupported(): boolean {
  return bulkWalkOverride !== undefined || binding() !== null;
}

function logErrno(errno: number, warningSink: (line: string) => void): void {
  // Once per DISTINCT errno: a single boring EACCES on one protected dir must not
  // permanently mask a later, different failure this feature would need to debug.
  if (loggedErrnos.has(errno)) return;
  loggedErrnos.add(errno);
  warningSink(`getattrlistbulk errno=${errno}`);
}

function errorNumber(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const errno = (error as { errno?: unknown }).errno;
  return typeof errno === "number" ? errno : undefined;
}

function attrsBuffer(): Uint8Array {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 5, true);
  view.setUint32(4, COMMON_REQUEST, true);
  view.setUint32(16, ATTR_FILE_DATALENGTH, true);
  return bytes;
}

function objectType(value: number): ChildType {
  if (value === 1) return "file";
  if (value === 2) return "dir";
  if (value === 5) return "symlink";
  return "other";
}

function modeFor(type: ChildType, access: number): number {
  const bits = type === "file" ? 0o100000 : type === "dir" ? 0o040000 : 0o120000;
  return bits | (access & 0o7777);
}

function childFromLstat(absDir: string, name: string): BulkChild | undefined {
  const st = fs.lstatSync(path.join(absDir, name));
  const type: ChildType = st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "other";
  return type === "file" ? { name, type, stat: st } : { name, type };
}

function parseRecord(view: DataView, start: number, length: number, absDir: string): BulkChild | undefined {
  const returnedCommon = view.getUint32(start + 4, true);
  if ((returnedCommon & ATTR_CMN_NAME) === 0) throw new Error("missing name");
  const nameOffset = view.getInt32(start + 24, true);
  const nameLength = view.getUint32(start + 28, true);
  const nameStart = start + 24 + nameOffset;
  const nameEnd = nameStart + nameLength;
  if (nameLength < 2 || nameStart < start || nameEnd > start + length || view.getUint8(nameEnd - 1) !== 0) throw new Error("bad name");
  const nameBytes = new Uint8Array(view.buffer, view.byteOffset + nameStart, nameLength - 1);
  const name = new TextDecoder().decode(nameBytes);
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw new Error("bad name");

  const missingCommon = (returnedCommon & COMMON_PAYLOAD) !== COMMON_PAYLOAD;
  if (missingCommon) return childFromLstat(absDir, name);
  const type = objectType(view.getUint32(start + 36, true));
  const returnedFile = view.getUint32(start + 16, true);
  // Files carry the extra ATTR_FILE_DATALENGTH word (read at offset 84). If it
  // wasn't packed for this file, or the record is too short to hold it, take the
  // exact lstat rather than reading a neighboring record's bytes.
  if (type === "file" && ((returnedFile & ATTR_FILE_DATALENGTH) === 0 || length < FILE_FIXED_SIZE)) return childFromLstat(absDir, name);
  if (type !== "file") return { name, type };

  const inoRaw = view.getBigUint64(start + 76, true);
  if (inoRaw > BigInt(Number.MAX_SAFE_INTEGER)) return childFromLstat(absDir, name);
  // dev_t is int32 on darwin; libuv widens st_dev into a u64, so a negative
  // dev_t sign-extends to a large positive Number in fs.lstat. Rather than model
  // that widening, defer any negative dev to the exact lstat (vanishingly rare).
  const dev = view.getInt32(start + 32, true);
  if (dev < 0) return childFromLstat(absDir, name);
  const sizeRaw = view.getBigInt64(start + 84, true);
  if (sizeRaw < 0n || sizeRaw > BigInt(Number.MAX_SAFE_INTEGER)) return childFromLstat(absDir, name);
  const mtimeSec = view.getBigInt64(start + 40, true);
  const mtimeNsec = view.getBigInt64(start + 48, true);
  const ctimeSec = view.getBigInt64(start + 56, true);
  const ctimeNsec = view.getBigInt64(start + 64, true);
  const stat: BulkStat = {
    ino: Number(inoRaw),
    dev,
    size: Number(sizeRaw),
    mtimeMs: Number(mtimeSec) * 1000 + Number(mtimeNsec) / 1e6,
    ctimeMs: Number(ctimeSec) * 1000 + Number(ctimeNsec) / 1e6,
    mode: modeFor(type, view.getUint32(start + 72, true)),
    rawTimes: { mtimeSec, mtimeNsec, ctimeSec, ctimeNsec },
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
  return { name, type, stat };
}

export function bulkWalkDir(absDir: string, warningSink: (line: string) => void = console.warn): BulkChild[] | null {
  if (bulkWalkOverride) return bulkWalkOverride(absDir, warningSink);
  const native = binding();
  if (!native) return null;
  let fd: number;
  try {
    fd = fs.openSync(absDir, "r");
  } catch (error) {
    const errno = errorNumber(error);
    if (errno !== undefined) logErrno(errno, warningSink);
    return null;
  }
  let result: BulkChild[] | null = [];
  try {
    const attrs = attrsBuffer();
    const buffer = new Uint8Array(BUFFER_SIZE);
    // `attrs` and `buffer` MUST stay reachable across every blocking getattrlistbulk
    // call so JSC cannot collect the storage `ptr()` handed to native code. Liveness
    // is guaranteed by real uses on each loop iteration (`ptr(attrs)`, `ptr(buffer)`,
    // `new DataView(buffer.buffer …)`) plus the post-loop read below — do NOT hoist
    // the `ptr()` calls out of the loop, which would make `attrs` dead after the
    // first iteration and open a use-after-free window during the blocking syscall.
    for (;;) {
      const count = Number(native.bulk(fd, ptr(attrs), ptr(buffer), buffer.byteLength, BigInt(FSOPT_PACK_INVAL_ATTRS)));
      if (count === 0) break;
      if (count < 0) {
        logErrno(read.i32(Number(native.error()), 0), warningSink);
        result = null;
        break;
      }
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      let offset = 0;
      for (let i = 0; i < count; i++) {
        if (offset + 4 > buffer.byteLength) throw new Error("short record");
        const length = view.getUint32(offset, true);
        if (length < COMMON_FIXED_SIZE || length > buffer.byteLength - offset) throw new Error("bad record length");
        const child = parseRecord(view, offset, length, absDir);
        if (child) result!.push(child);
        offset += length;
      }
    }
    // Durable post-loop read: anchors both buffers' liveness to the end of the try
    // so their `ptr()` storage cannot be reclaimed mid-syscall (see loop comment).
    if (attrs.byteLength === 0 || buffer.byteLength === 0) result = null;
  } catch {
    result = null;
  } finally {
    try { fs.closeSync(fd); } catch { result = null; }
  }
  return result;
}
