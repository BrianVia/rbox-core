import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, RBOX_TMP_PREFIX } from "../engine/fsutil.js";

export const RESET_STREAM_BYTE_LIMIT = 2 * 1024 * 1024 * 1024;
export const RESET_MATERIALIZED_BYTE_LIMIT = 512 * 1024 * 1024;
export const RESET_PARSE_BUDGET_FLOOR_BYTES = 4 * 1024 * 1024 * 1024;
export const RESET_PARSE_BUDGET_CEILING_BYTES = 32 * 1024 * 1024 * 1024;

/** Default parse budget scales with the machine: a quarter of physical memory,
 * floored at 4 GiB (small machines keep the original fail-closed behavior) and
 * capped at 32 GiB. A fixed 4 GiB starved legitimate ~59 MB states on a 96 GB
 * host (2026-07-19 field incident): required = size×multiplier outgrew
 * budget−RSS whenever the daemon carried a warm multi-GB heap. */
export function defaultResetParseBudgetBytes(
  totalMemoryBytes = os.totalmem(),
  cgroupLimitBytes: number | undefined = linuxCgroupMemoryLimitBytes(),
): number {
  const effectiveTotal = cgroupLimitBytes !== undefined ? Math.min(totalMemoryBytes, cgroupLimitBytes) : totalMemoryBytes;
  const scaled = Math.floor(effectiveTotal / 4);
  const budget = Math.max(RESET_PARSE_BUDGET_FLOOR_BYTES, Math.min(scaled, RESET_PARSE_BUDGET_CEILING_BYTES));
  // A known hard limit BELOW the floor must win — refusing cleanly beats the
  // kernel OOM-killing a parse the floor would have admitted.
  return cgroupLimitBytes !== undefined ? Math.min(budget, cgroupLimitBytes) : budget;
}

/** Linux-only: the cgroup (v2 then v1) memory hard limit, if one applies.
 * `os.totalmem()` reports HOST physical memory inside containers; budgeting
 * against it would let admission approve parses the kernel will kill. This is
 * a policy budget, not an allocatability proof — concurrent host pressure can
 * still fail an admitted parse; the guard only promises we never PLAN past a
 * known hard bound. Any read/parse failure falls back to host-total scaling
 * (pre-fix behavior). */
export function linuxCgroupMemoryLimitBytes(
  read: (file: string) => string | undefined = (file) => {
    if (process.platform !== "linux") return undefined;
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
): number | undefined {
  const v2 = read("/sys/fs/cgroup/memory.max");
  if (v2 !== undefined) {
    const text = v2.trim();
    if (text === "max") return undefined;
    const value = Number(text);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  const v1 = read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (v1 !== undefined) {
    const value = Number(v1.trim());
    // cgroup v1 reports "unlimited" as a page-rounded 2^63-ish sentinel.
    return Number.isSafeInteger(value) && value > 0 && value < 2 ** 62 ? value : undefined;
  }
  return undefined;
}

/** Pinned by reset-memory-benchmark.test.ts's JSON-grammar flood-family sweep.
 * CI reruns the same arrays/objects/strings/mixed corpus and fails if Bun's
 * parser expansion drifts above this measured maximum. */
// Current Bun 1.3 flood sweep: mixed-container flood peaks at ~25.6x RSS;
// round upward before applying the separate 2x safety factor.
export const RESET_PARSE_MEASURED_MULTIPLIER = 26;
export const RESET_PARSE_SAFETY_FACTOR = 2;
export const RESET_PARSE_EXPANSION_MULTIPLIER =
  RESET_PARSE_MEASURED_MULTIPLIER * RESET_PARSE_SAFETY_FACTOR;

export type ResetCorruptionKind = "corruption" | "identity-race";

export interface ResetCorruptionOptions extends ErrorOptions {
  kind?: ResetCorruptionKind;
}

export class ResetCorruptionError extends Error {
  readonly code = "RESET_CORRUPTION";
  readonly kind: ResetCorruptionKind;
  constructor(message: string, options?: ResetCorruptionOptions) {
    super(`reset-corruption: ${message}`, options);
    this.name = "ResetCorruptionError";
    this.kind = options?.kind ?? "corruption";
  }
}

export class ResetMemoryAdmissionError extends RangeError {
  readonly code = "RESET_MEMORY_ADMISSION";
  constructor(readonly fileSize: number, readonly requiredBytes: number, readonly availableBytes: number) {
    super(
      `reset state needs ${requiredBytes} bytes of parse headroom, but only ${availableBytes} bytes are available — ` +
        `set RBOX_RESET_PARSE_BUDGET_BYTES to raise the budget if this machine has memory to spare`
    );
    this.name = "ResetMemoryAdmissionError";
  }
}

export interface BoundedIdentity {
  dev: number;
  ino: number;
  size: number;
}

export interface BoundedStreamResult {
  identity: BoundedIdentity;
  bytesRead: number;
}

export interface BoundedStreamOptions {
  chunkBytes?: number;
  /** Whole-materialization callers may retry a bounded number of atomic
   * replacement races; streaming classifiers normally run under their fence. */
  identityRetries?: number;
  /** Test/instrumentation seam. Runs after the chunk has counted toward the cap. */
  onChunk?: (chunk: Uint8Array, bytesRead: number) => void | Promise<void>;
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function identity(stat: Awaited<ReturnType<typeof fs.lstat>>): BoundedIdentity {
  return { dev: Number(stat.dev), ino: Number(stat.ino), size: Number(stat.size) };
}

function sameIdentity(a: BoundedIdentity, b: BoundedIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function unsafe(file: string, detail: string, kind: ResetCorruptionKind = "corruption"): ResetCorruptionError {
  return new ResetCorruptionError(`${detail} ${file}`, { kind });
}

/**
 * Read through one O_NOFOLLOW handle with a hard byte counter. Path identity,
 * handle identity, and size are revalidated after EOF so rename replacement,
 * in-place growth, and truncation cannot be mistaken for a stable observation.
 */
export async function boundedStream(
  file: string,
  cap: number,
  consume: (chunk: Uint8Array) => void | Promise<void>,
  options: BoundedStreamOptions = {},
): Promise<BoundedStreamResult | undefined> {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError("bounded stream cap must be a non-negative safe integer");
  let beforeStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    beforeStat = await fs.lstat(file);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
  if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) throw unsafe(file, "unsafe non-regular reset file");
  if (beforeStat.size > cap) throw unsafe(file, "oversized reset file");
  const before = identity(beforeStat);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw unsafe(file, "unsafe symlink reset file");
    throw error;
  }
  try {
    const opened = identity(await handle.stat());
    if (!sameIdentity(before, opened) || before.size !== opened.size) throw unsafe(file, "reset file changed before read", "identity-race");
    const chunkBytes = options.chunkBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new RangeError("bounded stream chunk size must be a positive safe integer");
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, cap + 1)));
    let bytesRead = 0;
    for (;;) {
      const { bytesRead: count } = await handle.read(buffer, 0, buffer.byteLength, bytesRead);
      if (count === 0) break;
      bytesRead += count;
      if (bytesRead > cap) throw unsafe(file, "reset file exceeded its byte limit while reading");
      const chunk = buffer.subarray(0, count);
      await consume(chunk);
      await options.onChunk?.(chunk, bytesRead);
    }
    const afterHandle = identity(await handle.stat());
    let afterPathStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      afterPathStat = await fs.lstat(file);
    } catch (error) {
      if (absent(error)) throw unsafe(file, "reset file disappeared while reading", "identity-race");
      throw error;
    }
    const afterPath = identity(afterPathStat);
    if (!afterPathStat.isFile() || afterPathStat.isSymbolicLink()) {
      throw unsafe(file, "unsafe non-regular reset file after read");
    }
    if (!sameIdentity(opened, afterHandle) || !sameIdentity(opened, afterPath)
      || afterHandle.size !== opened.size || afterPath.size !== opened.size || bytesRead !== opened.size) {
      throw unsafe(file, "reset file changed while reading", "identity-race");
    }
    return { identity: opened, bytesRead };
  } finally {
    await handle.close();
  }
}

export async function boundedRead(file: string, cap: number, options: BoundedStreamOptions = {}): Promise<Buffer | undefined> {
  const retries = options.identityRetries ?? 2;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 8) throw new RangeError("bounded read retry count is invalid");
  for (let attempt = 0;; attempt++) {
    const chunks: Buffer[] = [];
    try {
      const result = await boundedStream(file, cap, (chunk) => { chunks.push(Buffer.from(chunk)); }, options);
      return result ? Buffer.concat(chunks, result.bytesRead) : undefined;
    } catch (error) {
      const changed = error instanceof ResetCorruptionError && error.kind === "identity-race";
      if (!changed || attempt >= retries) throw error;
    }
  }
}

export async function boundedHash(file: string, cap = RESET_STREAM_BYTE_LIMIT): Promise<string | undefined> {
  const hash = crypto.createHash("sha256");
  const result = await boundedStream(file, cap, (chunk) => { hash.update(chunk); });
  return result ? hash.digest("hex") : undefined;
}

export async function boundedEqualsBytes(file: string, expected: Uint8Array, cap = RESET_STREAM_BYTE_LIMIT): Promise<boolean | undefined> {
  if (expected.byteLength > cap) return false;
  let offset = 0;
  let equal = true;
  const result = await boundedStream(file, cap, (chunk) => {
    if (!equal || offset + chunk.byteLength > expected.byteLength) {
      equal = false;
    } else if (!Buffer.from(chunk).equals(Buffer.from(expected.buffer, expected.byteOffset + offset, chunk.byteLength))) {
      equal = false;
    }
    offset += chunk.byteLength;
  });
  return result ? equal && offset === expected.byteLength : undefined;
}

export async function boundedFilesEqual(left: string, right: string, cap = RESET_STREAM_BYTE_LIMIT): Promise<boolean | undefined> {
  const [leftHash, rightHash] = await Promise.all([boundedHash(left, cap), boundedHash(right, cap)]);
  if (leftHash === undefined || rightHash === undefined) return undefined;
  return crypto.timingSafeEqual(Buffer.from(leftHash, "hex"), Buffer.from(rightHash, "hex"));
}

export interface BoundedCopyOptions {
  onStep?: (
    step:
      | "temp-opened"
      | "temp-written"
      | "temp-synced"
      | "temp-closed"
      | "before-rename"
      | "after-rename"
      | "parent-synced"
      | "created-ancestors-synced",
  ) => void | Promise<void>;
  /** Synchronous final assertion after all awaited preparation and immediately
   * before the destination rename. */
  beforeRenameSync?: () => void;
}

/** Stream-copy a stable source to an atomically published destination. */
export async function boundedCopy(
  source: string,
  destination: string,
  cap = RESET_STREAM_BYTE_LIMIT,
  options: BoundedCopyOptions = {},
): Promise<boolean> {
  const parent = path.dirname(destination);
  const created = await ensureDirectoryChain(parent, "bounded-copy destination");
  const tmp = path.join(parent, `${RBOX_TMP_PREFIX}${process.pid}-${crypto.randomBytes(8).toString("hex")}-${path.basename(destination)}`);
  let output: fs.FileHandle | undefined;
  let preserveTemp = false;
  try {
    output = await fs.open(tmp, "wx", 0o600);
    await options.onStep?.("temp-opened");
    const result = await boundedStream(source, cap, async (chunk) => {
      await output!.write(chunk);
      await options.onStep?.("temp-written");
    });
    if (!result) return false;
    await output.sync();
    await options.onStep?.("temp-synced");
    await output.close();
    output = undefined;
    await options.onStep?.("temp-closed");
    await options.onStep?.("before-rename");
    try {
      options.beforeRenameSync?.();
    } catch (error) {
      preserveTemp = true;
      throw error;
    }
    await fs.rename(tmp, destination);
    await options.onStep?.("after-rename");
    await fsyncDirectory(parent);
    await options.onStep?.("parent-synced");
    await fsyncCreatedDirectoryAncestors(parent, created);
    await options.onStep?.("created-ancestors-synced");
    return true;
  } finally {
    if (output) {
      await output.close().catch(() => {});
      await options.onStep?.("temp-closed");
    }
    if (!preserveTemp) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export interface ResetParseAdmissionOptions {
  processBudgetBytes?: number;
  currentRssBytes?: number;
  expansionMultiplier?: number;
}

/** The effective parse budget: the sanctioned `RBOX_RESET_PARSE_BUDGET_BYTES`
 * override (163:3309) when it is a positive safe integer, else the machine
 * default. Migration admission budgets against the same number. */
export function resetParseBudgetBytes(): number {
  const raw = process.env.RBOX_RESET_PARSE_BUDGET_BYTES;
  if (raw === undefined) return defaultResetParseBudgetBytes();
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : defaultResetParseBudgetBytes();
}

export function assertResetParseAdmission(fileSize: number, options: ResetParseAdmissionOptions = {}): void {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new RangeError("reset parse size must be a non-negative safe integer");
  if (fileSize > RESET_MATERIALIZED_BYTE_LIMIT) throw new ResetCorruptionError("materialized reset state exceeds the 512 MiB file limit");
  const budget = options.processBudgetBytes ?? resetParseBudgetBytes();
  const rss = options.currentRssBytes ?? process.memoryUsage.rss();
  const multiplier = options.expansionMultiplier ?? RESET_PARSE_EXPANSION_MULTIPLIER;
  const available = Math.max(0, budget - rss);
  const required = fileSize * multiplier;
  if (!Number.isSafeInteger(required) || required > available) throw new ResetMemoryAdmissionError(fileSize, required, available);
}

export function parseResetJsonBytes<T>(bytes: Uint8Array, file: string): T {
  try {
    const encoded = Buffer.isBuffer(bytes)
      ? bytes.toString("utf8")
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
    return JSON.parse(encoded) as T;
  } catch (error) {
    if (error instanceof RangeError) throw new ResetCorruptionError(`JSON nesting exceeded the parser limit in ${file}`, { cause: error });
    throw new ResetCorruptionError(`malformed JSON in ${file}`, { cause: error });
  }
}

export async function boundedJsonRead<T>(
  file: string,
  cap = RESET_MATERIALIZED_BYTE_LIMIT,
  admission: ResetParseAdmissionOptions = {},
): Promise<T | undefined> {
  let preflight: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    preflight = await fs.lstat(file);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
  if (!preflight.isFile() || preflight.isSymbolicLink()) throw unsafe(file, "unsafe non-regular reset file");
  const effectiveCap = Math.min(cap, RESET_MATERIALIZED_BYTE_LIMIT);
  if (preflight.size > effectiveCap) throw unsafe(file, "oversized reset file");
  // This first admission happens before allocating a file-sized buffer. The
  // second sample below is intentionally immediately before JSON.parse and
  // therefore includes the materialized bytes in currentRSS.
  assertResetParseAdmission(preflight.size, admission);
  const bytes = await boundedRead(file, effectiveCap);
  if (!bytes) return undefined;
  assertResetParseAdmission(bytes.byteLength, admission);
  return parseResetJsonBytes<T>(bytes, file);
}
