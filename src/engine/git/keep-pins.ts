import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { writeFileAtomic, fsyncDirectory } from "../fsutil.js";
import type { GitSection } from "../types.js";
import { cleanGitEnv, enumerateRefReflogOids, HEX40, git, repoCtx } from "./shared.js";
import { tipOwnedByIncoming } from "./reachability.js";
import {
  withProtocolLockClass,
  withRepoOperationLock,
  withRepoProtocolLocks,
} from "./protocol-locks.js";

const execFileAsync = promisify(execFile);
const sweptPreparedTxnDirs = new Set<string>();
const PREPARED_TXN_SWEEP_LIMIT = 256;

/** Best-effort boot/use-time cleanup for FIFOs left by hard-killed prepared
 * transactions. Exact names, dead PIDs, FIFO type, and a directory bound keep
 * this cleanup disjoint from refs/state and from live transactions. */
export async function sweepStalePreparedTransactionFifos(commonDir: string): Promise<void> {
  const resolved = path.resolve(commonDir);
  if (sweptPreparedTxnDirs.has(resolved)) return;
  sweptPreparedTxnDirs.add(resolved);
  const entries = await fs.readdir(resolved, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.slice(0, PREPARED_TXN_SWEEP_LIMIT)) {
    const match = /^\.rbox-prepared-txn-(\d+)-[0-9a-f]{12}$/.exec(entry.name);
    if (!match || !entry.isFIFO()) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") continue;
    }
    await fs.rm(path.join(resolved, entry.name), { force: true }).catch(() => {});
  }
}

export { enumerateRefReflogOids } from "./shared.js";

export interface KeepPinOrigin {
  ref: string;
  episode: string;
  time: string;
  class: "human" | "tombstone" | "tracking";
}

export type KeepPinOrigins = Record<string, KeepPinOrigin[]>;

export interface PreparedKeepPins {
  oids: string[];
  transactionLines: string[];
  sidecarPath: string;
}

export type PrepareDisplacedPinsResult =
  | ({ status: "prepared"; reflogFingerprint: string } & PreparedKeepPins)
  | { status: "indeterminate"; oid: string; marker: string };

export const keepPinRef = (oid: string) => `refs/rbox-local/keep/${oid}`;
const pinRef = keepPinRef;
export const TOMBSTONE_PIN_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_ORIGIN_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ORIGIN_OIDS = 32_768;
const MAX_ORIGINS_PER_OID = 32;
const MAX_ORIGIN_STRING_BYTES = 2_048;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

export function parseKeepPinOrigins(raw: string): KeepPinOrigins {
  if (Buffer.byteLength(raw, "utf8") > MAX_ORIGIN_FILE_BYTES) throw new Error("keep-pin origin sidecar exceeds byte cap");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("malformed keep-pin origin sidecar"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("keep-pin origin sidecar is not an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ORIGIN_OIDS) throw new Error("keep-pin origin sidecar exceeds OID cap");
  const parsed: KeepPinOrigins = {};
  for (const [oid, origins] of entries) {
    if (!HEX40.test(oid) || !Array.isArray(origins) || origins.length > MAX_ORIGINS_PER_OID) {
      throw new Error(`invalid keep-pin origin entry for ${oid}`);
    }
    const seen = new Set<string>();
    parsed[oid] = origins.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`invalid keep-pin origin for ${oid}`);
      const record = candidate as Record<string, unknown>;
      if (Object.keys(record).sort().join("\0") !== ["class", "episode", "ref", "time"].join("\0")) {
        throw new Error(`unknown keep-pin origin field for ${oid}`);
      }
      if (typeof record.ref !== "string" || typeof record.episode !== "string" || typeof record.time !== "string") {
        throw new Error(`invalid keep-pin origin strings for ${oid}`);
      }
      if ([record.ref, record.episode, record.time].some((field) => field.includes("\0") || utf8Bytes(field) > MAX_ORIGIN_STRING_BYTES)) {
        throw new Error(`over-bounds keep-pin origin for ${oid}`);
      }
      if (record.class !== "human" && record.class !== "tombstone" && record.class !== "tracking") {
        throw new Error(`invalid keep-pin origin class for ${oid}`);
      }
      if (!Number.isFinite(Date.parse(record.time)) || new Date(record.time).toISOString() !== record.time) {
        throw new Error(`invalid keep-pin origin time for ${oid}`);
      }
      const identity = `${record.ref}\0${record.episode}`;
      if (seen.has(identity)) throw new Error(`duplicate keep-pin origin for ${oid}`);
      seen.add(identity);
      return { ref: record.ref, episode: record.episode, time: record.time, class: record.class };
    });
  }
  return parsed;
}

export function expireTombstonePinOrigins(origins: KeepPinOrigins, nowMs: number): KeepPinOrigins {
  const result: KeepPinOrigins = {};
  for (const [oid, entries] of Object.entries(origins)) {
    const retained = entries.filter((entry) => entry.class !== "tombstone"
      || nowMs - Date.parse(entry.time) < TOMBSTONE_PIN_RETENTION_MS);
    if (retained.length) result[oid] = retained;
  }
  return result;
}

export async function readRefReflogFingerprint(repoDir: string, ref: string): Promise<{ bytes: Buffer; sha256: string }> {
  if (!ref.startsWith("refs/") || ref.includes("..") || ref.includes("\0")) throw new Error("invalid reflog ref");
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while fingerprinting reflog");
  const reflogPath = path.join(ctx.commonDir, "logs", ...ref.split("/"));
  let handle: fs.FileHandle | undefined;
  let bytes = Buffer.alloc(0);
  try {
    handle = await fs.open(reflogPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("invalid reflog file");
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== after.size) throw new Error("reflog changed while fingerprinting");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  return { bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

export function humanDisplacementOrigin(ref: string, section: Pick<GitSection, "generatedAt">): KeepPinOrigin {
  return {
    ref,
    episode: section.generatedAt || String(Date.now()),
    time: new Date().toISOString(),
    class: "human",
  };
}

/** Commit caller-prepared recovery-pin lines together with their destructive ref
 * mutation.  Keeping this public prevents apply paths from accidentally splitting
 * the fsynced-origin -> pin+displacement transaction discipline. */
async function runUpdateRefTransactionUnlocked(repoDir: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while committing recovery pins");
  const inputPath = path.join(ctx.commonDir, `.rbox-pin-txn-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  await fs.writeFile(inputPath, ["start", ...lines, "prepare", "commit", ""].join("\n"));
  const input = await fs.open(inputPath, "r");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["-C", repoDir, "update-ref", "--stdin"], { env: cleanGitEnv(), stdio: [input.fd, "ignore", "pipe"] });
      let stderr = "";
      child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 && !/\bfatal:/i.test(stderr) ? resolve() : reject(new Error(`git update-ref failed (${code}): ${stderr.trim()}`)));
    });
  } finally {
    await input.close();
    await fs.rm(inputPath, { force: true });
  }
}

export function runUpdateRefTransaction(repoDir: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return Promise.resolve();
  return withRepoOperationLock(repoDir, () => withProtocolLockClass("git", `${repoDir}:${lines.join(",")}`, () =>
    runUpdateRefTransactionUnlocked(repoDir, lines)));
}

/**
 * Prepared update-ref boundary used when evidence must be re-read after Git has
 * acquired the affected ref/reflog locks. The callback runs after `prepare: ok`
 * and before `commit`; throwing sends `abort` and leaves every command unapplied.
 */
async function runPreparedUpdateRefTransactionUnlocked(
  repoDir: string,
  lines: readonly string[],
  afterPrepare: () => Promise<void>,
  options: { reflogMessage?: string } = {},
): Promise<void> {
  if (lines.length === 0) return;
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while preparing ref transaction");
  await sweepStalePreparedTransactionFifos(ctx.commonDir);
  const fifoPath = path.join(ctx.commonDir, `.rbox-prepared-txn-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  await execFileAsync("mkfifo", [fifoPath]);
  // Bun does not incrementally deliver a child-process stdin pipe to
  // update-ref. Pairing a read-only FIFO descriptor with a distinct writer
  // supplies the streaming protocol and still lets commit observe EOF.
  const readerPromise = fs.open(fifoPath, constants.O_RDONLY);
  const fifo = await fs.open(fifoPath, constants.O_WRONLY);
  const reader = await readerPromise;
  if (options.reflogMessage?.includes("\0") || options.reflogMessage?.includes("\n")) throw new Error("invalid ref transaction reflog message");
  const child = spawn("git", ["-C", repoDir, "update-ref", ...(options.reflogMessage ? ["-m", options.reflogMessage] : []), "--stdin"], {
    env: cleanGitEnv(), stdio: [reader.fd, "pipe", "pipe"],
  });
  await reader.close();
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let closed: { code: number | null } | undefined;
  let closeError: Error | undefined;
  const waiters = new Set<() => void>();
  const notify = () => { for (const waiter of [...waiters]) waiter(); };
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; notify(); });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; notify(); });
  child.once("error", (error) => { closeError = error; notify(); });
  child.once("close", (code) => { closed = { code }; notify(); });
  const waitFor = async (marker: string): Promise<void> => {
    for (;;) {
      if (stdout.includes(marker)) return;
      if (closeError) throw closeError;
      if (closed) throw new Error(`git update-ref closed before ${marker.trim()} (${closed.code}): ${stderr.trim()}`);
      await new Promise<void>((resolve) => {
        const waiter = () => { waiters.delete(waiter); resolve(); };
        waiters.add(waiter);
      });
    }
  };
  const waitClose = async (): Promise<number | null> => {
    while (!closed && !closeError) await new Promise<void>((resolve) => {
      const waiter = () => { waiters.delete(waiter); resolve(); };
      waiters.add(waiter);
    });
    if (closeError) throw closeError;
    return closed!.code;
  };
  try {
    await fifo.write(["start", "option no-deref", ...lines, "prepare", ""].join("\n"));
    try {
      await waitFor("prepare: ok");
    } catch (error) {
      throw new PreparedRefTransactionPrepareError(String((error as Error)?.message ?? error));
    }
    try {
      await afterPrepare();
    } catch (error) {
      await fifo.write("abort\n");
      await fifo.close();
      await waitClose().catch(() => {});
      throw error;
    }
    await fifo.write("commit\n");
    await fifo.close();
    const code = await waitClose();
    if (code !== 0 || !stdout.includes("commit: ok") || /\bfatal:/i.test(stderr)) {
      throw new Error(`git update-ref failed (${code}): ${stderr.trim()}`);
    }
  } finally {
    await fifo.close().catch(() => {});
    await fs.rm(fifoPath, { force: true }).catch(() => {});
  }
}

/** Git rejected a prepared transaction before the locked proof callback ran.
 * Callers may treat this closed phase as expected ref movement without parsing
 * Git's platform/version-dependent diagnostics. */
export class PreparedRefTransactionPrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedRefTransactionPrepareError";
  }
}

export function runPreparedUpdateRefTransaction(
  repoDir: string,
  lines: readonly string[],
  afterPrepare: () => Promise<void>,
  options: { reflogMessage?: string } = {},
): Promise<void> {
  if (lines.length === 0) return Promise.resolve();
  return withRepoOperationLock(repoDir, () => withProtocolLockClass("git", `${repoDir}:${lines.join(",")}`, () =>
    runPreparedUpdateRefTransactionUnlocked(repoDir, lines, afterPrepare, options)));
}

function mergeOrigin(existing: KeepPinOrigin[], incoming: KeepPinOrigin): KeepPinOrigin[] {
  const next = existing.map((entry) => ({ ...entry }));
  const same = next.find((entry) => entry.ref === incoming.ref && entry.episode === incoming.episode);
  if (!same) next.push({ ...incoming });
  else {
    const rank: Record<KeepPinOrigin["class"], number> = { tracking: 0, tombstone: 1, human: 2 };
    if (rank[incoming.class] > rank[same.class]) same.class = incoming.class;
  }
  return next.sort((a, b) => `${a.ref}\0${a.episode}\0${a.time}`.localeCompare(`${b.ref}\0${b.episode}\0${b.time}`));
}

async function originSidecar(repoDir: string): Promise<{ commonDir: string; path: string; origins: KeepPinOrigins }> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while reading recovery-pin origins");
  const sidecarPath = path.join(ctx.commonDir, "rbox-keep-origins.json");
  let handle: fs.FileHandle | undefined;
  let raw = "{}";
  try {
    handle = await fs.open(sidecarPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ORIGIN_FILE_BYTES) throw new Error("invalid keep-pin origin sidecar file");
    raw = await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  return { commonDir: ctx.commonDir, path: sidecarPath, origins: parseKeepPinOrigins(raw) };
}

async function persistOrigins(sidecar: { commonDir: string; path: string }, origins: KeepPinOrigins): Promise<void> {
  const serialized = `${JSON.stringify(origins, null, 2)}\n`;
  parseKeepPinOrigins(serialized);
  await writeFileAtomic(sidecar.path, serialized);
  await fsyncDirectory(sidecar.commonDir);
}

/** Read the bounded sidecar while the caller holds the class-5 origin lock. */
export async function readKeepPinOrigins(repoDir: string): Promise<KeepPinOrigins> {
  return withRepoProtocolLocks(repoDir, { origins: true }, async () => (await originSidecar(repoDir)).origins);
}

export async function rewriteKeepPinOrigins(
  repoDir: string,
  rewrite: (origins: KeepPinOrigins) => KeepPinOrigins | void,
): Promise<KeepPinOrigins> {
  return withRepoProtocolLocks(repoDir, { origins: true }, async () => {
    const sidecar = await originSidecar(repoDir);
    const draft = structuredClone(sidecar.origins);
    const candidate = rewrite(draft) ?? draft;
    await persistOrigins(sidecar, candidate);
    return candidate;
  });
}

export function filterKeepPinOrigins(
  repoDir: string,
  retain: (origin: KeepPinOrigin, oid: string) => boolean,
): Promise<KeepPinOrigins> {
  return rewriteKeepPinOrigins(repoDir, (origins) => {
    const filtered: KeepPinOrigins = {};
    for (const [oid, entries] of Object.entries(origins)) {
      const kept = entries.filter((entry) => retain(entry, oid));
      if (kept.length) filtered[oid] = kept;
    }
    return filtered;
  });
}

/** Age only tombstone provenance. The sidecar is fsynced before compare-deleting
 * now-originless content pins, so every crash point leaves over-protection rather
 * than an origin naming an unreachable object. Shared human/tracking origins win. */
export function expireTombstoneKeepPins(
  repoDir: string,
  nowMs: number,
): Promise<{ removedOrigins: number; deletedPins: number }> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return Promise.reject(new Error("invalid keep-pin expiry time"));
  return withRepoProtocolLocks(repoDir, { origins: true }, async () => {
    const sidecar = await originSidecar(repoDir);
    const expired = expireTombstonePinOrigins(sidecar.origins, nowMs);
    let removedOrigins = 0;
    for (const [oid, entries] of Object.entries(sidecar.origins)) {
      removedOrigins += entries.length - (expired[oid]?.length ?? 0);
    }
    if (removedOrigins === 0) return { removedOrigins: 0, deletedPins: 0 };
    await persistOrigins(sidecar, expired);
    const listed = await git(repoDir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/rbox-local/keep"]);
    const lines = listed.split("\n").filter(Boolean).flatMap((line) => {
      const match = /^(refs\/rbox-local\/keep\/([0-9a-f]{40})) ([0-9a-f]{40})$/.exec(line);
      if (!match || match[2] !== match[3] || expired[match[2]!]?.length) return [];
      return [`delete ${match[1]} ${match[3]}`];
    }).sort();
    await runUpdateRefTransaction(repoDir, lines);
    return { removedOrigins, deletedPins: lines.length };
  });
}

export function repairOriginOids(origins: KeepPinOrigins, qRef: string, episode: string): string[] {
  return Object.entries(origins)
    .filter(([, entries]) => entries.some((entry) => entry.ref === qRef && entry.episode === episode
      && entry.class === "human"))
    .map(([oid]) => oid)
    .sort();
}

/** Repair-only ordering: verify objects and commit content pins before recording
 * provenance. The caller holds classes 1-5 and this function takes class 6. */
async function pinRepairObjectsFirstUnlocked(repoDir: string, oids: readonly string[]): Promise<PreparedKeepPins> {
  const unique = [...new Set(oids)].sort();
  if (unique.some((oid) => !HEX40.test(oid))) throw new Error("invalid P-repair Skeep OID");
  for (const oid of unique) await git(repoDir, ["cat-file", "-e", `${oid}^{object}`]);
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while pinning P-repair objects");
  const sidecarPath = path.join(ctx.commonDir, "rbox-keep-origins.json");
  const transactionLines = (await prepareCreateOnlyKeepPins(repoDir, unique)).transactionLines;
  try {
    await runUpdateRefTransaction(repoDir, transactionLines);
  } catch (error) {
    if (!(await verifyRepairKeepRefs(repoDir, unique))) throw error;
  }
  return { oids: unique, transactionLines, sidecarPath };
}

export function pinRepairObjectsFirst(repoDir: string, oids: readonly string[]): Promise<PreparedKeepPins> {
  return withRepoOperationLock(repoDir, () => pinRepairObjectsFirstUnlocked(repoDir, oids));
}

/** Second repair half. Existing exact origins retain their stored diagnostic
 * time; new origins use Q.repair.at. Must run under the class-5 lock. */
async function mergeRepairOriginsUnlocked(
  repoDir: string,
  oids: readonly string[],
  qRef: string,
  episode: string,
  repairAt: string,
): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(episode) || !Number.isFinite(Date.parse(repairAt))
    || new Date(repairAt).toISOString() !== repairAt) throw new Error("invalid P-repair origin");
  const sidecar = await originSidecar(repoDir);
  for (const oid of [...new Set(oids)]) {
    if (!HEX40.test(oid)) throw new Error("invalid P-repair origin OID");
    const entries = sidecar.origins[oid] ?? [];
    const stored = entries.find((entry) => entry.ref === qRef && entry.episode === episode);
    sidecar.origins[oid] = mergeOrigin(entries, {
      ref: qRef,
      episode,
      time: stored?.time ?? repairAt,
      class: "human",
    });
  }
  await persistOrigins(sidecar, sidecar.origins);
}

export function mergeRepairOrigins(
  repoDir: string,
  oids: readonly string[],
  qRef: string,
  episode: string,
  repairAt: string,
): Promise<void> {
  return withRepoProtocolLocks(repoDir, { origins: true }, () => mergeRepairOriginsUnlocked(repoDir, oids, qRef, episode, repairAt));
}

export async function verifyRepairKeepRefs(repoDir: string, oids: readonly string[]): Promise<boolean> {
  for (const oid of [...new Set(oids)]) {
    if (!HEX40.test(oid) || await git(repoDir, ["rev-parse", "--verify", "--quiet", pinRef(oid)]).catch(() => "") !== oid) return false;
  }
  return true;
}

/** Filter one retired lineage's exact Q-origin namespace. Content pins are
 * compare-deleted only when no origin of any class remains. The returned ref
 * lines are deliberately not committed here so callers can splice them into the
 * lineage-Q expected-target transaction. */
async function prepareRepairOriginCleanupUnlocked(
  repoDir: string,
  lineageHash: string,
): Promise<{ transactionLines: string[]; removedOrigins: number }> {
  if (!/^[0-9a-f]{64}$/.test(lineageHash)) throw new Error("invalid cleanup lineage");
  const prefix = `refs/rbox-recovery/base-present/v2/${lineageHash}/`;
  const qRef = new RegExp(`^${prefix}([0-9a-f]{64})/([0-9a-f]{32})$`);
  const sidecar = await originSidecar(repoDir);
  let removedOrigins = 0;
  const transactionLines: string[] = [];
  for (const [oid, entries] of Object.entries(sidecar.origins)) {
    const retained = entries.filter((entry) => {
      const match = qRef.exec(entry.ref);
      const remove = !!match && match[2] === entry.episode;
      if (remove) removedOrigins++;
      return !remove;
    });
    if (retained.length) sidecar.origins[oid] = retained;
    else {
      delete sidecar.origins[oid];
      if (await git(repoDir, ["rev-parse", "--verify", "--quiet", pinRef(oid)]).catch(() => "") === oid) {
        transactionLines.push(`delete ${pinRef(oid)} ${oid}`);
      }
    }
  }
  await persistOrigins(sidecar, sidecar.origins);
  return { transactionLines: transactionLines.sort(), removedOrigins };
}

export function prepareRepairOriginCleanup(
  repoDir: string,
  lineageHash: string,
): Promise<{ transactionLines: string[]; removedOrigins: number }> {
  return withRepoProtocolLocks(repoDir, { origins: true }, () => prepareRepairOriginCleanupUnlocked(repoDir, lineageHash));
}

/** Hold the operation/origin locks until the caller has committed the returned
 * compare-deletes. This is the safe boundary for lineage cleanup: a concurrent
 * shared origin cannot be added between the sidecar filter and pin deletion. */
export function withPreparedRepairOriginCleanup<T>(
  repoDir: string,
  lineageHash: string,
  commit: (prepared: { transactionLines: string[]; removedOrigins: number }) => Promise<T>,
): Promise<T> {
  return withRepoProtocolLocks(repoDir, { origins: true }, async () =>
    commit(await prepareRepairOriginCleanupUnlocked(repoDir, lineageHash)));
}

/**
 * First half of the r4 F3 protocol. Human provenance is fsynced before these
 * create-only lines are handed to a caller's destructive ref transaction. A
 * crash here leaves only harmless over-protection. The tracking-only retention
 * sweep intentionally lands with the deferred tracking lane, not this cycle.
 */
export async function prepareCreateOnlyKeepPins(repoDir: string, oids: readonly string[]): Promise<PreparedKeepPins> {
  return withRepoOperationLock(repoDir, async () => {
    const ctx = await repoCtx(repoDir);
    if (!ctx) throw new Error("repository unavailable while preparing recovery pins");
    const unique = [...new Set(oids)].sort();
    if (unique.some((oid) => !HEX40.test(oid))) throw new Error("invalid recovery-pin OID");
    const listed = await git(repoDir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/rbox-local/keep"]);
    const existingPins = new Map(listed.split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf(" ");
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    }));
    const transactionLines: string[] = [];
    for (const oid of unique) {
      const existing = existingPins.get(pinRef(oid)) ?? "";
      if (existing === oid) continue;
      if (existing) throw new Error(`recovery pin collision at ${pinRef(oid)}`);
      transactionLines.push(`create ${pinRef(oid)} ${oid}`);
    }
    return { oids: unique, transactionLines, sidecarPath: path.join(ctx.commonDir, "rbox-keep-origins.json") };
  });
}

async function prepareKeepPinsUnlocked(repoDir: string, oids: readonly string[], origin: KeepPinOrigin): Promise<PreparedKeepPins> {
  const unique = [...new Set(oids)];
  if (unique.some((oid) => !HEX40.test(oid))) throw new Error("invalid recovery-pin OID");
  const sidecar = await originSidecar(repoDir);
  for (const oid of unique) sidecar.origins[oid] = mergeOrigin(sidecar.origins[oid] ?? [], origin);
  await persistOrigins(sidecar, sidecar.origins);
  return prepareCreateOnlyKeepPins(repoDir, unique);
}

export function prepareKeepPins(repoDir: string, oids: readonly string[], origin: KeepPinOrigin): Promise<PreparedKeepPins> {
  return withRepoProtocolLocks(repoDir, { origins: true }, () => prepareKeepPinsUnlocked(repoDir, oids, origin));
}

export interface PreparedTombstonePins extends PreparedKeepPins {
  reflogFingerprint: string;
}

/**
 * §130 preservation split: only the exact live/BASE-authorized tip receives an
 * aging tombstone origin. Every other reflog OID is permanent human evidence.
 * The caller must compare reflogFingerprint again after its Git transaction is
 * prepared and before commit.
 */
async function prepareTombstonePrunePinsUnlocked(
  repoDir: string,
  ref: string,
  authorizedTip: string,
  episode: string,
  time: string,
): Promise<PreparedTombstonePins> {
  if (!HEX40.test(authorizedTip)) throw new Error("invalid tombstone-authorized tip");
  const fingerprint = await readRefReflogFingerprint(repoDir, ref);
  const reflogOids = await enumerateRefReflogOids(repoDir, ref);
  const humanOids = [...new Set(reflogOids)].filter((oid) => oid !== authorizedTip);
  const tombstone = await prepareKeepPins(repoDir, [authorizedTip], { ref, episode, time, class: "tombstone" });
  const human = humanOids.length === 0 ? undefined : await prepareKeepPins(repoDir, humanOids, { ref, episode, time, class: "human" });
  return {
    oids: [...tombstone.oids, ...(human?.oids ?? [])],
    transactionLines: [...tombstone.transactionLines, ...(human?.transactionLines ?? [])],
    sidecarPath: tombstone.sidecarPath,
    reflogFingerprint: fingerprint.sha256,
  };
}

/** Prepare tombstone/human origins while excluding every rbox reflog
 * maintenance writer for R. The returned fingerprint still has to be checked
 * after Git prepares R.lock, which detects direct hostile filesystem writes. */
export function prepareTombstonePrunePins(
  repoDir: string,
  ref: string,
  authorizedTip: string,
  episode: string,
  time: string,
): Promise<PreparedTombstonePins> {
  return withRepoProtocolLocks(repoDir, { reflogRefs: [ref], origins: true }, () =>
    prepareTombstonePrunePinsUnlocked(repoDir, ref, authorizedTip, episode, time));
}

export async function verifyPreparedTombstoneFingerprint(
  repoDir: string,
  ref: string,
  expectedSha256: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("invalid prepared reflog fingerprint");
  const locked = await readRefReflogFingerprint(repoDir, ref);
  if (locked.sha256 !== expectedSha256) throw new Error("branch reflog changed at prepared transaction boundary");
}

/** Callback form for destructive consumers. It preserves the complete
 * operation -> reflog-maintenance -> origin -> prepared-Git subsequence when
 * `commit` invokes the prepared transaction helper. */
export function withPreparedTombstonePrunePins<T>(
  repoDir: string,
  ref: string,
  authorizedTip: string,
  episode: string,
  time: string,
  commit: (prepared: PreparedTombstonePins) => Promise<T>,
): Promise<T> {
  return withRepoProtocolLocks(repoDir, { reflogRefs: [ref], origins: true }, async () =>
    commit(await prepareTombstonePrunePinsUnlocked(repoDir, ref, authorizedTip, episode, time)));
}

/** Convenience for a pin-only transaction; mutation planners use prepareKeepPins
 * and splice transactionLines into the SAME transaction as displacement. */
export async function pinDisplaced(repoDir: string, oids: readonly string[], origin: KeepPinOrigin): Promise<PreparedKeepPins> {
  return withRepoProtocolLocks(repoDir, { origins: true }, async () => {
    const prepared = await prepareKeepPinsUnlocked(repoDir, oids, origin);
    try {
      await runUpdateRefTransaction(repoDir, prepared.transactionLines);
    } catch (error) {
      // A concurrent/retried identical content-addressed create is idempotent.
      for (const oid of prepared.oids) if (await git(repoDir, ["rev-parse", "--verify", pinRef(oid)]).catch(() => "") !== oid) throw error;
    }
    return prepared;
  });
}

/** r1 F6: protect every reflog-only OID not in the caller's planned durable graph. */
async function prepareDisplacedRefPinsUnlocked(
  repoDir: string,
  ref: string,
  plannedGraphRoots: readonly string[],
  origin: KeepPinOrigin,
): Promise<PrepareDisplacedPinsResult> {
  const displaced: string[] = [];
  const reflogFingerprint = (await readRefReflogFingerprint(repoDir, ref)).sha256;
  // The live tip is a displacement candidate in its own right, not only the
  // reflog entries: with reflogs disabled or pruned (core.logAllRefUpdates=false,
  // fresh-materialized stores) the enumeration below is empty, and deleting the
  // ref would otherwise strand a unique tip with no refs/rbox-local/keep/* pin —
  // the quarantine bundle is defense in depth, never the protection (r1 F6).
  const liveTip = await git(repoDir, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
  const candidates = new Set([...(HEX40.test(liveTip) ? [liveTip] : []), ...(await enumerateRefReflogOids(repoDir, ref))]);
  for (const oid of candidates) {
    const proof = await tipOwnedByIncoming(repoDir, oid, plannedGraphRoots);
    if (proof.status === "indeterminate") return { status: "indeterminate", oid, marker: proof.marker };
    if (proof.status === "unowned") displaced.push(oid);
  }
  return { status: "prepared", reflogFingerprint, ...(await prepareKeepPins(repoDir, displaced, origin)) };
}

export function prepareDisplacedRefPins(
  repoDir: string,
  ref: string,
  plannedGraphRoots: readonly string[],
  origin: KeepPinOrigin,
): Promise<PrepareDisplacedPinsResult> {
  return withRepoProtocolLocks(repoDir, { reflogRefs: [ref], origins: true }, () =>
    prepareDisplacedRefPinsUnlocked(repoDir, ref, plannedGraphRoots, origin));
}

/** Include a displaced live tip even when it is absent from the ref's reflog. */
export async function prepareDisplacementPins(
  repoDir: string,
  ref: string,
  oldOid: string,
  plannedRoots: readonly string[],
  origin: KeepPinOrigin,
): Promise<PrepareDisplacedPinsResult> {
  return withRepoProtocolLocks(repoDir, { reflogRefs: [ref], origins: true }, async () => {
    const reflog = await prepareDisplacedRefPinsUnlocked(repoDir, ref, plannedRoots, origin);
    if (reflog.status === "indeterminate" || reflog.oids.includes(oldOid)) return reflog;
    const tip = await prepareKeepPinsUnlocked(repoDir, [oldOid], origin);
    return {
      ...reflog,
      oids: [...reflog.oids, oldOid],
      transactionLines: [...reflog.transactionLines, ...tip.transactionLines],
    };
  });
}
