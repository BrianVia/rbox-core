import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import type { JsonObject } from "../json.js";

export const ADOPT_VERSION = 1 as const;
export const LINKED_WORKTREE_REFUSAL = "linked worktree not adopted — its history travels with its main clone";

export type AdoptPhase =
  | "retaining"
  | "baseline"
  | "git"
  | "overlay"
  | "invalidating"
  | "aborting"
  | "paused"
  | "complete"
  | "aborted";

export type AdoptEntryKind = "file" | "directory" | "symlink" | "fifo" | "socket" | "device" | "other";

export interface AdoptIdentity {
  kind: AdoptEntryKind;
  dev: string;
  ino: string;
  mode: string;
  size: string;
  mtimeNs: string;
  birthtimeNs: string | "unavailable";
  sha256?: string;
  linkText?: string;
}

export interface AdoptInventoryEntry {
  path: string;
  identity: AdoptIdentity;
}

export interface AdoptSourceRepo {
  path: string;
  sourceKind: "dir";
  worktreeReal: string;
  gitDirReal: string;
  commonDirReal: string;
  objectStoreReal: string;
}

export interface AdoptRetainMove {
  path: string;
  source: string;
  destination: string;
  before: AdoptIdentity;
  after?: AdoptIdentity;
  state: "intent" | "complete";
}

export type AdoptOverlayDisposition = "landed" | "displaced" | "unplaced" | "special";

export interface AdoptOverlayMove {
  path: string;
  source: string;
  destination: string;
  disposition: AdoptOverlayDisposition;
  displaced?: string;
  unplaced?: string;
  sourceBefore: AdoptIdentity;
  baselineBefore?: AdoptIdentity;
  sourceAfter?: AdoptIdentity;
  baselineAfter?: AdoptIdentity;
  state: "intent" | "baseline-displaced" | "complete" | "aborted" | "paused";
  reason?: string;
}

export interface AdoptRepoIdentity {
  kind: "dir" | "pointer";
  worktreeId: string;
  gitDirReal: string;
  commonDirReal: string;
  dev: string;
  ino: string;
  birthtime: string;
  worktreeDev: string;
  worktreeIno: string;
  worktreeBirthtime: string;
  gitDirDev: string;
  gitDirIno: string;
  gitDirBirthtime: string;
  configHash: string;
  checkoutJournalHash: string;
}

export type AdoptGitBranchState =
  | "equal"
  | "parked"
  | "proved"
  | "fetched"
  | "cas-intent"
  | "cas-complete"
  | "index-complete"
  | "paused"
  | "aborted";

export interface AdoptIndexRecord {
  present: boolean;
  savedPath: string;
  preparedPath?: string;
  lockPath?: string;
  lockIdentity?: AdoptIdentity;
  preparedIdentity?: AdoptIdentity;
  before?: AdoptIdentity;
  beforeHash?: string;
  after?: AdoptIdentity;
  afterHash?: string;
  readTreeState: "none" | "intent" | "complete";
}

export interface AdoptGitBranch {
  ref: string;
  expectedOld: string;
  incomingOid: string;
  provedSourceOid: string;
  checkedOut: boolean;
  initialIndexTree?: string;
  initialHeadTree?: string;
  initialNoOperationState?: boolean;
  boundaryIndexTree?: string;
  boundaryHeadTree?: string;
  boundaryNoOperationState?: boolean;
  targetHead: string;
  siblingOwnership: Record<string, string>;
  reflogBefore: string;
  reflogAfter?: string;
  state: AdoptGitBranchState;
  reason?: string;
  index?: AdoptIndexRecord;
}

export interface AdoptGitRepo {
  path: string;
  source: AdoptSourceRepo;
  target?: AdoptRepoIdentity;
  branches: AdoptGitBranch[];
  retainedRefs: string[];
  detachedHead?: string;
  state: "pending" | "complete" | "parked" | "paused" | "unplaced";
  reason?: string;
}

/** Catalog policy pinned before adoption begins its first sync. Optional so
 * journals written by older binaries remain resumable. */
export interface JournalPinnedFolderPolicy {
  generation: string;
  syncGit: boolean;
  git: { incremental: boolean };
  respectGitignore: boolean;
  noDrift: boolean;
  trash: { days: number; maxBytes: number };
}

export interface AdoptJournal {
  version: typeof ADOPT_VERSION;
  journalId: string;
  createdAt: string;
  workspace: {
    root: string;
    rootReal: string;
    stream: string;
    workspaceId: string;
    projectId: string;
    remoteUrl: string;
    deviceId: string;
    syncGit: boolean;
    respectGitignore: boolean;
    name?: string;
  };
  pinnedFolderPolicy?: JournalPinnedFolderPolicy;
  phase: AdoptPhase;
  resumePhase?: Exclude<AdoptPhase, "paused" | "complete" | "aborted">;
  pauseReasons: string[];
  inventory: AdoptInventoryEntry[];
  sourceRepos: AdoptSourceRepo[];
  retainedBytes: string;
  retainMoves: AdoptRetainMove[];
  baseline: {
    started: boolean;
    complete: boolean;
    continuationNonce: string;
    consumed: boolean;
    mutexIncarnation: string;
  };
  gitRepos: AdoptGitRepo[];
  overlayMoves: AdoptOverlayMove[];
  createdDirectories: Array<{ path: string; identity: AdoptIdentity }>;
  cache: {
    invalidated: boolean;
    generationBefore?: number;
    generationAfter?: number;
  };
  finishSync: { attempted: boolean; complete: boolean; error?: string };
}

export const adoptDir = (root: string): string => path.join(root, ".rbox", "adopt");
export const adoptJournalPath = (root: string): string => path.join(adoptDir(root), "journal.json");
export const adoptStashDir = (root: string): string => path.join(adoptDir(root), "stash");
export const adoptDisplacedDir = (root: string): string => path.join(adoptDir(root), "displaced");
export const adoptUnplacedDir = (root: string): string => path.join(adoptDir(root), "unplaced");

function entryKind(stat: Awaited<ReturnType<typeof fs.lstat>>): AdoptEntryKind {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  if (stat.isCharacterDevice() || stat.isBlockDevice()) return "device";
  return "other";
}

function statFields(stat: Awaited<ReturnType<typeof fs.lstat>> & { dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; birthtimeNs: bigint }): Omit<AdoptIdentity, "kind"> {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    birthtimeNs: stat.birthtimeNs > 0n ? stat.birthtimeNs.toString() : "unavailable",
  };
}

function sameStat(a: AdoptIdentity, b: AdoptIdentity): boolean {
  return a.kind === b.kind && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.birthtimeNs === b.birthtimeNs;
}

async function hashHandle(handle: fs.FileHandle): Promise<string> {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

/** Full, no-follow identity. Regular files are bracketed around a streamed hash. */
export async function readAdoptIdentity(abs: string, withContent = false): Promise<AdoptIdentity> {
  const first = await fs.lstat(abs, { bigint: true });
  const kind = entryKind(first as never);
  const base: AdoptIdentity = { kind, ...statFields(first as never) };
  if (kind === "symlink") {
    const linkText = await fs.readlink(abs);
    const after = await fs.lstat(abs, { bigint: true });
    const afterIdentity: AdoptIdentity = { kind: entryKind(after as never), ...statFields(after as never) };
    if (!sameStat(base, afterIdentity)) throw new Error(`symlink changed while reading: ${abs}`);
    return { ...base, linkText };
  }
  if (kind !== "file" || !withContent) return base;
  const handle = await fs.open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const openedIdentity: AdoptIdentity = { kind: "file", ...statFields(opened as never) };
    if (!sameStat(base, openedIdentity)) throw new Error(`file changed while opening: ${abs}`);
    const sha256 = await hashHandle(handle);
    const afterOpen = await handle.stat({ bigint: true });
    const afterPath = await fs.lstat(abs, { bigint: true });
    const afterOpenIdentity: AdoptIdentity = { kind: "file", ...statFields(afterOpen as never) };
    const afterPathIdentity: AdoptIdentity = { kind: entryKind(afterPath as never), ...statFields(afterPath as never) };
    if (!sameStat(base, afterOpenIdentity) || !sameStat(base, afterPathIdentity)) throw new Error(`file changed while hashing: ${abs}`);
    return { ...base, sha256 };
  } finally {
    await handle.close();
  }
}

export function identitiesEqual(a: AdoptIdentity | undefined, b: AdoptIdentity | undefined): boolean {
  if (!a || !b || !sameStat(a, b)) return false;
  if (a.kind === "file") return a.sha256 !== undefined && b.sha256 !== undefined && a.sha256 === b.sha256;
  if (a.kind === "symlink") return a.linkText === b.linkText;
  return true;
}

export function isTerminalAdoptPhase(phase: AdoptPhase): boolean {
  return phase === "complete" || phase === "aborted";
}

function validJournal(value: unknown): value is AdoptJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const j = value as Partial<AdoptJournal>;
  const object = (candidate: unknown): candidate is JsonObject => !!candidate && typeof candidate === "object" && !Array.isArray(candidate);
  const string = (candidate: unknown): candidate is string => typeof candidate === "string" && !candidate.includes("\0");
  const decimal = (candidate: unknown): candidate is string => string(candidate) && /^\d+$/.test(candidate);
  const hex = (candidate: unknown, length: number): candidate is string => string(candidate) && new RegExp(`^[0-9a-f]{${length}}$`).test(candidate);
  const rel = (candidate: unknown, dot = false): candidate is string => string(candidate)
    && (dot && candidate === "." || candidate.length > 0 && !path.isAbsolute(candidate)
      && !candidate.includes("\\") && candidate.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
  const identity = (candidate: unknown): candidate is AdoptIdentity => {
    if (!object(candidate) || !["file", "directory", "symlink", "fifo", "socket", "device", "other"].includes(String(candidate.kind))) return false;
    if (![candidate.dev, candidate.ino, candidate.mode, candidate.size, candidate.mtimeNs].every(decimal)) return false;
    if (!(candidate.birthtimeNs === "unavailable" || decimal(candidate.birthtimeNs))) return false;
    if (candidate.kind === "file" && candidate.sha256 !== undefined && !hex(candidate.sha256, 64)) return false;
    if (candidate.kind === "symlink" && !string(candidate.linkText)) return false;
    return true;
  };
  const workspace = j.workspace;
  const pinned = j.pinnedFolderPolicy;
  const baseline = j.baseline;
  const cache = j.cache;
  const finish = j.finishSync;
  return j.version === ADOPT_VERSION
    && typeof j.journalId === "string" && /^[0-9a-f]{32}$/.test(j.journalId)
    && string(j.createdAt) && Number.isFinite(Date.parse(j.createdAt))
    && object(workspace) && string(workspace.root) && path.isAbsolute(workspace.root)
    && string(workspace.rootReal) && path.isAbsolute(workspace.rootReal)
    && string(workspace.stream) && workspace.stream.length > 0 && string(workspace.workspaceId) && workspace.workspaceId.length > 0
    && string(workspace.projectId) && string(workspace.remoteUrl) && string(workspace.deviceId)
    && typeof workspace.syncGit === "boolean" && typeof workspace.respectGitignore === "boolean"
    && (workspace.name === undefined || string(workspace.name))
    && (pinned === undefined || object(pinned)
      && Object.keys(pinned).length === 6
      && ["generation", "syncGit", "git", "respectGitignore", "noDrift", "trash"].every((key) => Object.hasOwn(pinned, key))
      && hex(pinned.generation, 64)
      && typeof pinned.syncGit === "boolean"
      && object(pinned.git) && Object.keys(pinned.git).length === 1 && typeof pinned.git.incremental === "boolean"
      && typeof pinned.respectGitignore === "boolean" && typeof pinned.noDrift === "boolean"
      && object(pinned.trash) && Object.keys(pinned.trash).length === 2
      && Number.isSafeInteger(pinned.trash.days) && pinned.trash.days >= 0 && pinned.trash.days <= 365
      && Number.isSafeInteger(pinned.trash.maxBytes) && pinned.trash.maxBytes >= 0 && pinned.trash.maxBytes <= 1099511627776)
    && ["retaining", "baseline", "git", "overlay", "invalidating", "aborting", "paused", "complete", "aborted"].includes(j.phase ?? "")
    && (j.resumePhase === undefined || ["retaining", "baseline", "git", "overlay", "invalidating", "aborting"].includes(j.resumePhase))
    && Array.isArray(j.pauseReasons) && j.pauseReasons.every(string)
    && Array.isArray(j.inventory) && j.inventory.every((entry) => object(entry) && rel(entry.path) && identity(entry.identity))
    && Array.isArray(j.sourceRepos) && j.sourceRepos.every((repo) => object(repo) && rel(repo.path, true) && repo.sourceKind === "dir"
      && [repo.worktreeReal, repo.gitDirReal, repo.commonDirReal, repo.objectStoreReal].every((candidate) => string(candidate) && path.isAbsolute(candidate)))
    && decimal(j.retainedBytes)
    && Array.isArray(j.retainMoves) && j.retainMoves.every((move) => object(move) && rel(move.path)
      && string(move.source) && path.isAbsolute(move.source) && string(move.destination) && path.isAbsolute(move.destination)
      && path.resolve(move.source) === path.join(path.resolve(workspace.root), ...move.path.split("/"))
      && path.resolve(move.destination) === path.join(adoptStashDir(path.resolve(workspace.root)), ...move.path.split("/"))
      && identity(move.before) && (move.after === undefined || identity(move.after)) && ["intent", "complete"].includes(String(move.state)))
    && object(baseline) && typeof baseline.started === "boolean" && typeof baseline.complete === "boolean"
      && hex(baseline.continuationNonce, 32) && typeof baseline.consumed === "boolean" && string(baseline.mutexIncarnation)
    && Array.isArray(j.gitRepos) && j.gitRepos.every((repo) => object(repo) && rel(repo.path, true) && object(repo.source)
      && Array.isArray(repo.branches) && Array.isArray(repo.retainedRefs) && repo.retainedRefs.every(string)
      && ["pending", "complete", "parked", "paused", "unplaced"].includes(String(repo.state)))
    && Array.isArray(j.overlayMoves) && j.overlayMoves.every((move) => object(move) && rel(move.path) && rel(move.source) && rel(move.destination)
      && ["landed", "displaced", "unplaced", "special"].includes(String(move.disposition))
      && (move.displaced === undefined || rel(move.displaced)) && (move.unplaced === undefined || rel(move.unplaced))
      && identity(move.sourceBefore) && (move.baselineBefore === undefined || identity(move.baselineBefore))
      && (move.sourceAfter === undefined || identity(move.sourceAfter)) && (move.baselineAfter === undefined || identity(move.baselineAfter))
      && ["intent", "baseline-displaced", "complete", "aborted", "paused"].includes(String(move.state)))
    && Array.isArray(j.createdDirectories) && j.createdDirectories.every((entry) => object(entry) && rel(entry.path) && identity(entry.identity) && entry.identity.kind === "directory")
    && object(cache) && typeof cache.invalidated === "boolean"
      && (cache.generationBefore === undefined || Number.isSafeInteger(cache.generationBefore) && cache.generationBefore >= 0)
      && (cache.generationAfter === undefined || Number.isSafeInteger(cache.generationAfter) && cache.generationAfter >= 1)
    && object(finish) && typeof finish.attempted === "boolean" && typeof finish.complete === "boolean"
      && (finish.error === undefined || string(finish.error));
}

async function validateControlPath(root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  for (const component of [path.join(resolvedRoot, ".rbox"), adoptDir(resolvedRoot)]) {
    const stat = await fs.lstat(component);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe adoption control path: ${component}`);
  }
  const journal = adoptJournalPath(resolvedRoot);
  const stat = await fs.lstat(journal).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`unsafe adoption journal: ${journal}`);
}

export async function saveAdoptJournal(root: string, journal: AdoptJournal): Promise<void> {
  if (!validJournal(journal)) throw new Error("refusing to persist malformed adoption journal");
  if (path.resolve(root) !== path.resolve(journal.workspace.root)) throw new Error("adoption journal root binding mismatch");
  await validateControlPath(root);
  const parent = adoptDir(root);
  await writeFileAtomic(adoptJournalPath(root), `${JSON.stringify(journal)}\n`, { mode: 0o600, exactMode: true });
  await fsyncDirectory(parent);
}

/**
 * Persisting rewrites the whole journal, so one write per O(1) event costs
 * O(workspace) — a 372k-file adopt rewrote 120MB every few seconds. Batching
 * bounds the high-frequency phases to O(events / ADOPT_PERSIST_BATCH) writes.
 */
export const ADOPT_PERSIST_BATCH = 1000;
export const ADOPT_PERSIST_MAX_DELAY_MS = 2000;

export interface BatchedPersist {
  /** Journals a mutation, writing only at the batch-size or max-delay bound. */
  persist(): Promise<void>;
  /** Records that the in-memory journal changed without considering a write. */
  mark(): void;
  /** Writes now if anything is unpersisted. */
  flush(): Promise<void>;
}

export function createBatchedPersist(
  persist: () => Promise<void>,
  options: { batch?: number; maxDelayMs?: number; now?: () => number } = {},
): BatchedPersist {
  const batch = options.batch ?? ADOPT_PERSIST_BATCH;
  const maxDelayMs = options.maxDelayMs ?? ADOPT_PERSIST_MAX_DELAY_MS;
  const now = options.now ?? (() => Date.now());
  let unpersisted = 0;
  let lastWrite = now();
  const flush = async (): Promise<void> => {
    if (unpersisted === 0) return;
    unpersisted = 0;
    lastWrite = now();
    await persist();
  };
  return {
    mark: () => { unpersisted += 1; },
    flush,
    persist: async () => {
      unpersisted += 1;
      if (unpersisted >= batch || now() - lastWrite >= maxDelayMs) await flush();
    },
  };
}

export async function loadAdoptJournal(root: string): Promise<AdoptJournal | undefined> {
  const resolvedRoot = path.resolve(root);
  for (const component of [path.join(resolvedRoot, ".rbox"), adoptDir(resolvedRoot)]) {
    const componentStat = await fs.lstat(component).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!componentStat) return undefined;
    if (!componentStat.isDirectory() || componentStat.isSymbolicLink()) throw new Error(`unsafe adoption control path: ${component}`);
  }
  const journalPath = adoptJournalPath(resolvedRoot);
  const handle = await fs.open(journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!handle) return undefined;
  let raw: string;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 128n * 1024n * 1024n) throw new Error(before.isFile() ? "adoption journal exceeds size limit" : `unsafe adoption journal: ${journalPath}`);
    raw = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error("adoption journal changed while reading");
    }
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("malformed adoption journal"); }
  if (!validJournal(parsed)) throw new Error("invalid adoption journal schema");
  if (path.resolve(parsed.workspace.root) !== resolvedRoot) throw new Error("adoption journal root binding mismatch");
  if (await fs.realpath(resolvedRoot) !== parsed.workspace.rootReal) throw new Error("adoption journal real-root binding mismatch");
  return parsed;
}

export type AdoptFenceInspection =
  | { status: "none" }
  | { status: "terminal"; phase: "complete" | "aborted"; journalId: string }
  | { status: "active"; phase: AdoptPhase; journalId: string }
  | { status: "corrupt"; reason: string };

export async function inspectAdoptFence(root: string): Promise<AdoptFenceInspection> {
  try {
    const journal = await loadAdoptJournal(root);
    if (!journal) return { status: "none" };
    return isTerminalAdoptPhase(journal.phase)
      ? { status: "terminal", phase: journal.phase as "complete" | "aborted", journalId: journal.journalId }
      : { status: "active", phase: journal.phase, journalId: journal.journalId };
  } catch (error) {
    return { status: "corrupt", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function findAdoptRoot(start: string): Promise<string | undefined> {
  let probe = path.resolve(start);
  const stat = await fs.lstat(probe).catch(() => undefined);
  if (stat?.isFile()) probe = path.dirname(probe);
  for (;;) {
    const candidate = adoptJournalPath(probe);
    const found = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (found) return probe;
    const parent = path.dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
}

export function newJournalId(): string {
  return crypto.randomBytes(16).toString("hex");
}
