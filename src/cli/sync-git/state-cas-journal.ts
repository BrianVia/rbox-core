import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../../engine/fsutil.js";
import {
  deserializeMarkerObservation,
  parseLockMarker,
  serializeMarkerObservation,
  validProcessIncarnation,
  type CommonDirIdentity,
  type ProcessIncarnation,
  type SerializedMarkerObservation,
} from "../../engine/lockfile.js";
import type { JsonObject, JsonValue } from "../../json.js";

const JOURNAL_DIR = path.join(".rbox", "state", "git-lock-transactions", "v1");
const HEX_32 = /^[0-9a-f]{32}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const MAX_V1_JOURNAL_BYTES = 1024 * 1024;
export const MAX_V2_LINE_BYTES = 8 * 1024 * 1024;
export const MAX_V2_JOURNAL_BYTES = 16 * 1024 * 1024;
export const MAX_V2_LOCKS = 4096;
const MAX_V2_RECORDS = MAX_V2_LOCKS + 3;
const MAX_HOLDER_MARKER_BYTES = 1024;

export interface StateCasLockProof {
  repo: string;
  ref: string;
  expectedOid: string | null;
}

export interface JournalLock {
  path: string;
  marker: string;
  proofs: StateCasLockProof[];
  acquisition?: "acquired" | "blocked";
  observation?: SerializedMarkerObservation;
  holderMarker?: string;
}

export interface JournalCommonDir extends CommonDirIdentity {
  locks: JournalLock[];
}

export interface StateCasLockJournal {
  version: 1 | 2;
  txnId: string;
  phase: "prepared" | "locked" | "committed";
  stream: string;
  stateNonce: string;
  owner: ProcessIncarnation;
  commonDirs: JournalCommonDir[];
  createdAt: string;
}

export interface PreparedStateCasLocks {
  journalPath: string;
  journal: StateCasLockJournal & { version: 2 };
  writer: StateCasJournalWriter;
}

export interface StateCasJournalHooks {
  afterDatasync?: (journalPath: string) => void | Promise<void>;
}

type AcquisitionRecord =
  | { type: "acquisition"; ordinal: number; observation: SerializedMarkerObservation }
  | { type: "acquisition"; ordinal: number; blocked: true; holderMarker: string };

export const stateCasJournalDir = (root: string): string => path.join(root, JOURNAL_DIR);

export function boundedLockPath(commonDir: string, lockPath: string): string {
  const common = path.resolve(commonDir);
  const lock = path.resolve(lockPath);
  if (!lock.startsWith(`${common}${path.sep}`)) throw new Error(`Git lock escaped common directory: ${lock}`);
  return lock;
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

const jsonString = (value: JsonValue | undefined): value is string => Object.prototype.toString.call(value) === "[object String]";
const jsonObject = (value: JsonValue | undefined): JsonObject | undefined =>
  value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]" ? value as JsonObject : undefined;

function decodeOwner(value: JsonValue | undefined): ProcessIncarnation | undefined {
  const owner = jsonObject(value);
  if (!owner || !validProcessIncarnation(owner)) return undefined;
  return { hostId: String(owner.hostId), bootId: String(owner.bootId), pid: Number(owner.pid), startTime: String(owner.startTime) };
}

function decodeProof(value: JsonValue, strict: boolean): StateCasLockProof | undefined {
  const proof = jsonObject(value);
  if (!proof || (strict && !exactKeys(proof, ["repo", "ref", "expectedOid"]))
    || !jsonString(proof.repo) || proof.repo.length === 0 || !jsonString(proof.ref) || !proof.ref.startsWith("refs/")
    || (proof.expectedOid !== null && (!jsonString(proof.expectedOid) || !GIT_OID.test(proof.expectedOid)))) return undefined;
  return { repo: proof.repo, ref: proof.ref, expectedOid: proof.expectedOid };
}

function decodeCommonDirs(value: JsonValue | undefined, owner: ProcessIncarnation, allowOutcomes: boolean, strict = false): JournalCommonDir[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const commonPaths = new Set<string>();
  const lockPaths = new Set<string>();
  const decoded: JournalCommonDir[] = [];
  for (const commonValue of value) {
    const common = jsonObject(commonValue);
    if (!common || (strict && !exactKeys(common, ["path", "realpath", "dev", "ino", "birthtimeNs", "locks"]))
      || !jsonString(common.path) || !jsonString(common.realpath) || !jsonString(common.dev)
      || !jsonString(common.ino) || !jsonString(common.birthtimeNs)
      || !Array.isArray(common.locks) || common.locks.length === 0
      || !path.isAbsolute(common.path) || path.resolve(common.path) !== common.path
      || !path.isAbsolute(common.realpath) || path.resolve(common.realpath) !== common.realpath
      || commonPaths.has(common.path)) return undefined;
    commonPaths.add(common.path);
    const locks: JournalLock[] = [];
    for (const lockValue of common.locks) {
      const lock = jsonObject(lockValue);
      if (!lock || (strict && !exactKeys(lock, ["path", "marker", "proofs"]))
        || !jsonString(lock.path) || !jsonString(lock.marker) || !Array.isArray(lock.proofs)) return undefined;
      const proofs: StateCasLockProof[] = [];
      for (const proofValue of lock.proofs) {
        const proof = decodeProof(proofValue, strict);
        if (!proof) return undefined;
        proofs.push(proof);
      }
      if ((!allowOutcomes && (lock.acquisition !== undefined || lock.observation !== undefined || lock.holderMarker !== undefined))
        || (allowOutcomes && lock.acquisition !== undefined && lock.acquisition !== "acquired" && lock.acquisition !== "blocked")) return undefined;
      let observation: SerializedMarkerObservation | undefined;
      if (lock.observation !== undefined) {
        const parsed = deserializeMarkerObservation(lock.observation);
        if (!parsed || parsed.raw !== lock.marker || lock.acquisition !== "acquired") return undefined;
        observation = serializeMarkerObservation(parsed);
      }
      if (lock.holderMarker !== undefined && (lock.acquisition !== "blocked" || !validHolderMarker(lock.holderMarker))) return undefined;
      if (!path.isAbsolute(lock.path) || path.resolve(lock.path) !== lock.path
        || !lock.path.endsWith(".lock") || lockPaths.has(lock.path)) return undefined;
      try { if (boundedLockPath(common.path, lock.path) !== lock.path) return undefined; } catch { return undefined; }
      lockPaths.add(lock.path);
      const marker = parseLockMarker(lock.marker);
      if (!marker || marker.hostId !== owner.hostId || marker.bootId !== owner.bootId
        || marker.pid !== owner.pid || marker.startTime !== owner.startTime) return undefined;
      const decodedLock: JournalLock = { path: lock.path, marker: lock.marker, proofs };
      if (lock.acquisition === "acquired" || lock.acquisition === "blocked") decodedLock.acquisition = lock.acquisition;
      if (observation) decodedLock.observation = observation;
      if (jsonString(lock.holderMarker)) decodedLock.holderMarker = lock.holderMarker;
      locks.push(decodedLock);
    }
    decoded.push({ path: common.path, realpath: common.realpath, dev: common.dev, ino: common.ino, birthtimeNs: common.birthtimeNs, locks });
  }
  return decoded;
}

function validHolderMarker(value: JsonValue | undefined): value is string {
  return jsonString(value) && value.length <= MAX_HOLDER_MARKER_BYTES;
}

export function parseV1(raw: string, journalPath?: string): StateCasLockJournal | undefined {
  if (Buffer.byteLength(raw) > MAX_V1_JOURNAL_BYTES) return undefined;
  try {
    const value = jsonObject(JSON.parse(raw) as JsonValue);
    const owner = decodeOwner(value?.owner);
    const commonDirs = owner ? decodeCommonDirs(value?.commonDirs, owner, true) : undefined;
    if (!value || value.version !== 1 || !jsonString(value.txnId) || !HEX_32.test(value.txnId)
      || (value.phase !== "prepared" && value.phase !== "locked" && value.phase !== "committed")
      || !jsonString(value.stream) || !jsonString(value.stateNonce) || !owner || !commonDirs
      || !jsonString(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
    if (journalPath !== undefined && path.basename(journalPath) !== `${value.txnId}.json`) return undefined;
    return { version: 1, txnId: value.txnId, phase: value.phase, stream: value.stream, stateNonce: value.stateNonce, owner, commonDirs, createdAt: value.createdAt };
  } catch { return undefined; }
}

function parseHeader(value: JsonValue | undefined, journalPath?: string): (StateCasLockJournal & { version: 2 }) | undefined {
  const header = jsonObject(value);
  const ownerValue = jsonObject(header?.owner);
  const owner = decodeOwner(ownerValue);
  const commonDirs = owner ? decodeCommonDirs(header?.commonDirs, owner, false, true) : undefined;
  if (!header || !exactKeys(header, ["type", "version", "txnId", "stream", "stateNonce", "owner", "commonDirs", "createdAt"])
    || header.type !== "header" || header.version !== 2 || !jsonString(header.txnId) || !HEX_32.test(header.txnId)
    || !jsonString(header.stream) || !jsonString(header.stateNonce) || !ownerValue
    || !exactKeys(ownerValue, ["hostId", "bootId", "pid", "startTime"]) || !owner || !commonDirs
    || !jsonString(header.createdAt) || !Number.isFinite(Date.parse(header.createdAt))) return undefined;
  if (journalPath !== undefined && path.basename(journalPath) !== `${header.txnId}.json`) return undefined;
  return { version: 2, txnId: header.txnId, phase: "prepared", stream: header.stream, stateNonce: header.stateNonce, owner, commonDirs, createdAt: header.createdAt };
}

function parseV2(raw: string, journalPath?: string): StateCasLockJournal | undefined {
  if (Buffer.byteLength(raw) > MAX_V2_JOURNAL_BYTES) return undefined;
  const lines = raw.split("\n");
  // Exactly one EOF suffix is discarded: empty when terminated, torn when not.
  lines.pop();
  if (lines.length === 0 || lines.length > MAX_V2_RECORDS) return undefined;
  const records: JsonValue[] = [];
  for (const line of lines) {
    if (line.length === 0 || Buffer.byteLength(line) > MAX_V2_LINE_BYTES) return undefined;
    try { records.push(JSON.parse(line) as JsonValue); } catch { return undefined; }
  }
  const journal = parseHeader(records[0], journalPath);
  if (!journal) return undefined;
  const locks = journal.commonDirs.flatMap((common) => common.locks);
  if (locks.length > MAX_V2_LOCKS) return undefined;
  let phase: StateCasLockJournal["phase"] = "prepared";
  for (const record of records.slice(1)) {
    const value = jsonObject(record);
    if (!value) return undefined;
    if (value.type === "acquisition") {
      if (phase !== "prepared" || !Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 0) return undefined;
      const lock = locks[Number(value.ordinal)];
      if (!lock || lock.acquisition !== undefined) return undefined;
      if (exactKeys(value, ["type", "ordinal", "observation"])) {
        const observation = deserializeMarkerObservation(value.observation);
        if (!observation || observation.raw !== lock.marker) return undefined;
        lock.acquisition = "acquired";
        lock.observation = serializeMarkerObservation(observation);
      } else if (value.blocked === true
        && exactKeys(value, ["type", "ordinal", "blocked", "holderMarker"])
        && validHolderMarker(value.holderMarker)) {
        lock.acquisition = "blocked";
        lock.holderMarker = value.holderMarker;
      } else return undefined;
    } else if (value.type === "locked" && exactKeys(value, ["type"])) {
      if (phase !== "prepared" || locks.some((lock) => lock.acquisition === undefined)) return undefined;
      phase = "locked";
    } else if (value.type === "committed" && exactKeys(value, ["type"])) {
      if (phase !== "locked") return undefined;
      phase = "committed";
    } else return undefined;
  }
  journal.phase = phase;
  return journal;
}

export function parseStateCasJournal(raw: string, journalPath?: string): StateCasLockJournal | undefined {
  if (Buffer.byteLength(raw) > MAX_V2_JOURNAL_BYTES) return undefined;
  const firstLine = raw.slice(0, raw.indexOf("\n") < 0 ? raw.length : raw.indexOf("\n"));
  if (Buffer.byteLength(firstLine) > MAX_V2_LINE_BYTES) return undefined;
  try {
    const first = jsonObject(JSON.parse(firstLine) as JsonValue);
    return first?.version === 2 ? parseV2(raw, journalPath) : parseV1(raw, journalPath);
  } catch { return parseV1(raw, journalPath); }
}

export class StateCasJournalWriter {
  readonly #path: string;
  readonly #rootReal: string;
  readonly #dirIdentity: { dev: bigint; ino: bigint };
  readonly #fileIdentity: { dev: bigint; ino: bigint };
  #handle: fs.FileHandle | undefined;
  #length: number;
  #records: number;

  private constructor(
    journalPath: string,
    rootReal: string,
    dirIdentity: { dev: bigint; ino: bigint },
    fileIdentity: { dev: bigint; ino: bigint },
    handle: fs.FileHandle,
    length: number,
  ) {
    this.#path = journalPath;
    this.#rootReal = rootReal;
    this.#dirIdentity = dirIdentity;
    this.#fileIdentity = fileIdentity;
    this.#handle = handle;
    this.#length = length;
    this.#records = 1;
  }

  static async create(root: string, journalPath: string, journal: StateCasLockJournal & { version: 2 }): Promise<StateCasJournalWriter> {
    const { phase: _phase, ...header } = journal;
    const line = `${JSON.stringify({ type: "header", ...header })}\n`;
    const lockCount = journal.commonDirs.reduce((count, common) => count + common.locks.length, 0);
    if (lockCount > MAX_V2_LOCKS || Buffer.byteLength(line) > MAX_V2_LINE_BYTES) throw new Error("state-CAS journal header is oversized");
    await writeFileAtomic(journalPath, line, { mode: 0o600, exactMode: true });
    await fsyncDirectory(path.dirname(journalPath));
    const rootReal = await fs.realpath(path.resolve(root));
    const dirStat = await fs.lstat(path.dirname(journalPath), { bigint: true });
    const handle = await fs.open(journalPath, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    const writer = new StateCasJournalWriter(
      journalPath,
      rootReal,
      { dev: dirStat.dev, ino: dirStat.ino },
      { dev: opened.dev, ino: opened.ino },
      handle,
      Buffer.byteLength(line),
    );
    try {
      await writer.#assertPathBinding();
      await writer.close();
      return writer;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async append(record: AcquisitionRecord | { type: "locked" } | { type: "committed" }, hooks: StateCasJournalHooks = {}): Promise<void> {
    const handle = await this.#ensureOpen();
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.length > MAX_V2_LINE_BYTES || this.#length + bytes.length > MAX_V2_JOURNAL_BYTES
      || this.#records + 1 > MAX_V2_RECORDS) throw new Error("state-CAS journal is oversized");
    let offset = 0;
    while (offset < bytes.length) {
      const written = await handle.write(bytes, offset, bytes.length - offset, null);
      if (written.bytesWritten <= 0) throw new Error("state-CAS journal append made no progress");
      offset += written.bytesWritten;
    }
    this.#length += bytes.length;
    this.#records++;
    await handle.datasync();
    await hooks.afterDatasync?.(this.#path);
    await this.#assertPathBinding();
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close();
  }

  async pathBound(): Promise<boolean> {
    try {
      await this.#ensureOpen();
      await this.#assertPathBinding();
      return true;
    } catch {
      return false;
    }
  }

  async #ensureOpen(): Promise<fs.FileHandle> {
    if (this.#handle) return this.#handle;
    this.#handle = await fs.open(this.#path, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
    try { await this.#assertPathBinding(); }
    catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
    return this.#handle;
  }

  async #assertPathBinding(): Promise<void> {
    const handle = this.#handle;
    if (!handle) throw new Error("state-CAS journal writer is closed");
    const directory = path.dirname(this.#path);
    const [dirStat, dirReal, named, opened] = await Promise.all([
      fs.lstat(directory, { bigint: true }),
      fs.realpath(directory),
      fs.lstat(this.#path, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.dev !== this.#dirIdentity.dev || dirStat.ino !== this.#dirIdentity.ino
      || (dirReal !== this.#rootReal && !dirReal.startsWith(`${this.#rootReal}${path.sep}`))
      || !named.isFile() || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino
      || opened.dev !== this.#fileIdentity.dev || opened.ino !== this.#fileIdentity.ino
      || opened.size < BigInt(this.#length) || named.size < BigInt(this.#length)) {
      throw new Error("state-CAS journal path binding changed");
    }
  }
}

export async function createStateCasJournal(
  root: string,
  journalPath: string,
  journal: StateCasLockJournal & { version: 2 },
): Promise<StateCasJournalWriter> {
  return StateCasJournalWriter.create(root, journalPath, journal);
}

export async function prepareStateCasJournalDirectory(root: string): Promise<string> {
  const dir = stateCasJournalDir(root);
  const created = await ensureDirectoryChain(dir, "state-CAS journal directory");
  await fsyncCreatedDirectoryAncestors(dir, created);
  return dir;
}
