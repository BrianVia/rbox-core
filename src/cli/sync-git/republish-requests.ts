import fs from "node:fs/promises";
import path from "node:path";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../../engine/fsutil.js";
import type { GitSection } from "../../engine/types.js";
import { boundedJsonRead } from "../reset-io.js";
import { assertHealthyOwnedSyncMutex, assertSyncMutex, type WorkspaceSyncMutex } from "../sync-mutex.js";

/** #526: a republish request asks the next publish of ONE repo to emit a
 *  chain-free full bundle, abandoning a pack chain fresh receivers cannot
 *  replay. Local-only bookkeeping — never synced, never on the wire. */
export interface RepublishRequest {
  relPath: string;
  requestedAt: string;
  /** The BASE section identity observed when the request was recorded. A
   *  published section that differs in either field is causal proof of a new
   *  capture; one that matches both is the same BASE carried forward. Neither
   *  comparison involves a clock, so no clock drift can settle or strand a
   *  request. */
  baseBundleSha: string;
  baseGeneratedAt: string;
}

/** The BASE identity a request supersedes. */
export interface RepublishBase {
  bundleSha: string;
  generatedAt: string;
}

export interface RepublishRequestsV1 {
  v: 1;
  /** Binding identity. A store written under another stream belongs to a
   *  workspace this state no longer is, and must never force or settle here. */
  stream: string;
  requests: RepublishRequest[];
}

export type RepublishStoreRead =
  | { status: "absent" }
  | { status: "corrupt" }
  | { status: "valid"; record: RepublishRequestsV1 };

export class RepublishMutexOwnershipError extends Error {
  constructor(message = "republish mutation requires a held workspace sync mutex") {
    super(message);
    this.name = "RepublishMutexOwnershipError";
  }
}

export class RepublishStoreChangedError extends Error {
  constructor() {
    super("the republish request file changed while the workspace sync mutex was held");
    this.name = "RepublishStoreChangedError";
  }
}

export const REPUBLISH_REQUESTS_MAX = 256;
export const REPUBLISH_REQUESTS_MAX_BYTES = 64 * 1024;

export const republishRequestsPath = (root: string): string =>
  path.join(root, ".rbox", "state", "git-republish.json");

const HEX64 = /^[0-9a-f]{64}$/;

const validRelPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024
  && !value.startsWith("/") && !value.includes("\0")
  && (value === "." || (!value.startsWith("./") && value !== ".." && !value.startsWith("../") && !value.includes("/../") && !value.endsWith("/..")));

const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

const sorted = (requests: readonly RepublishRequest[]): RepublishRequest[] =>
  [...requests].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

function validate(value: unknown): RepublishRequestsV1 | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<RepublishRequestsV1>;
  if (record.v !== 1 || typeof record.stream !== "string" || record.stream.length === 0) return undefined;
  if (!Array.isArray(record.requests) || record.requests.length === 0 || record.requests.length > REPUBLISH_REQUESTS_MAX) return undefined;
  const seen = new Set<string>();
  const requests: RepublishRequest[] = [];
  for (const raw of record.requests) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entry = raw as Partial<RepublishRequest>;
    if (!validRelPath(entry.relPath) || !validTimestamp(entry.requestedAt)) return undefined;
    if (typeof entry.baseBundleSha !== "string" || !HEX64.test(entry.baseBundleSha)) return undefined;
    if (!validTimestamp(entry.baseGeneratedAt)) return undefined;
    if (seen.has(entry.relPath)) return undefined;
    seen.add(entry.relPath);
    requests.push({
      relPath: entry.relPath,
      requestedAt: entry.requestedAt,
      baseBundleSha: entry.baseBundleSha,
      baseGeneratedAt: entry.baseGeneratedAt,
    });
  }
  return { v: 1, stream: record.stream, requests: sorted(requests) };
}

/** Classify the store. `corrupt` is distinct from `absent` so a writer refuses
 *  to overwrite bytes an operator may still recover intent from, while a
 *  read-only planner can safely carry on with no requests. A store written
 *  under another `stream` reads as `absent`: it belongs to a workspace this
 *  state no longer is, so it carries no authority to force or settle anything
 *  here and is replaced rather than merged. */
async function readStoreFile(root: string): Promise<RepublishStoreRead> {
  let raw: unknown;
  try {
    raw = await boundedJsonRead(republishRequestsPath(root), REPUBLISH_REQUESTS_MAX_BYTES);
  } catch {
    return { status: "corrupt" };
  }
  if (raw === undefined) return { status: "absent" };
  const record = validate(raw);
  if (!record) return { status: "corrupt" };
  return { status: "valid", record };
}

export async function readRepublishStore(root: string, stream: string): Promise<RepublishStoreRead> {
  const read = await readStoreFile(root);
  if (read.status !== "valid") return read;
  const { record } = read;
  if (record.stream !== stream) return { status: "absent" };
  return { status: "valid", record };
}

/** The repositories whose next capture must restart the pack chain, plus a
 *  warning when the store could not be read. Never throws: a local file must
 *  not fail a push. */
export async function republishPlanInput(root: string, stream: string): Promise<{ repos: ReadonlySet<string>; warning?: string }> {
  const read = await readRepublishStore(root, stream).catch((): RepublishStoreRead => ({ status: "corrupt" }));
  if (read.status === "corrupt") {
    return { repos: new Set<string>(), warning: `git-sync republish store unreadable at ${republishRequestsPath(root)} — no chain restart runs until it is removed` };
  }
  if (read.status !== "valid") return { repos: new Set<string>() };
  return { repos: new Set(read.record.requests.map((request) => request.relPath)) };
}

const sameRequest = (left: RepublishRequest, right: RepublishRequest): boolean =>
  left.relPath === right.relPath
  && left.requestedAt === right.requestedAt
  && left.baseBundleSha === right.baseBundleSha
  && left.baseGeneratedAt === right.baseGeneratedAt;

function sameRead(left: RepublishStoreRead, right: RepublishStoreRead): boolean {
  if (left.status !== right.status) return false;
  if (left.status !== "valid" || right.status !== "valid") return true;
  return left.record.stream === right.record.stream
    && left.record.requests.length === right.record.requests.length
    && left.record.requests.every((request, index) => sameRequest(request, right.record.requests[index]!));
}

async function assertRepublishMutex(mutex: WorkspaceSyncMutex | undefined, root: string): Promise<void> {
  if (!mutex) throw new RepublishMutexOwnershipError();
  try {
    assertSyncMutex(mutex, root);
    await assertHealthyOwnedSyncMutex(mutex, root);
  } catch (error) {
    throw new RepublishMutexOwnershipError(error instanceof Error ? error.message : String(error));
  }
}

async function writeStore(
  root: string,
  stream: string,
  requests: readonly RepublishRequest[],
  expected: RepublishStoreRead,
): Promise<void> {
  if (!sameRead(await readStoreFile(root), expected)) throw new RepublishStoreChangedError();
  const file = republishRequestsPath(root);
  const parent = path.dirname(file);
  if (requests.length === 0) {
    try {
      await fs.rm(file);
      await fsyncDirectory(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  const record: RepublishRequestsV1 = { v: 1, stream, requests: sorted(requests) };
  const created = await ensureDirectoryChain(parent, "git republish request directory");
  await writeFileAtomic(file, `${JSON.stringify(record)}\n`, { mode: 0o600, exactMode: true });
  await fsyncDirectory(parent);
  await fsyncCreatedDirectoryAncestors(parent, created);
}

export interface RecordRepublishResult {
  status: "recorded" | "already-pending";
  requestedAt: string;
  pending: number;
}

export interface RepublishMutationTestHooks {
  afterRead?: () => Promise<void>;
}

/** Install (or observe) a pending request for one repository. Re-requesting a
 *  repository whose request has not settled keeps the ORIGINAL request: the
 *  intent is already recorded, and settlement is proven by a NEW bundle rather
 *  than by a fresh timestamp. */
export async function recordRepublishRequest(
  root: string,
  stream: string,
  relPath: string,
  base: RepublishBase,
  now: Date,
  mutex: WorkspaceSyncMutex,
  hooks: RepublishMutationTestHooks = {},
): Promise<RecordRepublishResult> {
  await assertRepublishMutex(mutex, root);
  if (!validRelPath(relPath)) throw new Error("invalid repository path");
  if (!HEX64.test(base.bundleSha) || !validTimestamp(base.generatedAt)) {
    throw new Error("this repository has no published Git bundle to supersede");
  }
  const read = await readStoreFile(root);
  await hooks.afterRead?.();
  if (read.status === "corrupt") {
    throw new Error(`the republish request file is unreadable — inspect and remove ${republishRequestsPath(root)}, then run this again`);
  }
  const current = read.status === "valid" && read.record.stream === stream ? read.record.requests : [];
  const existing = current.find((request) => request.relPath === relPath);
  if (existing) return { status: "already-pending", requestedAt: existing.requestedAt, pending: current.length };
  if (current.length >= REPUBLISH_REQUESTS_MAX) {
    throw new Error(`${REPUBLISH_REQUESTS_MAX} chain restarts are already pending — let them publish before requesting another`);
  }
  const requestedAt = now.toISOString();
  const next = [...current, { relPath, requestedAt, baseBundleSha: base.bundleSha, baseGeneratedAt: base.generatedAt }];
  await writeStore(root, stream, next, read);
  return { status: "recorded", requestedAt, pending: next.length };
}

/** A published section proves a request satisfied when it restarted the chain
 *  AND is not the BASE the request superseded. A deferred repo carries that
 *  exact BASE forward, so it can never settle its own request. */
export function republishSatisfiedBy(section: GitSection | undefined, request: RepublishRequest): boolean {
  if (!section) return false;
  if ((section.packChain?.length ?? 0) > 0) return false;
  return section.bundleSha !== request.baseBundleSha || section.generatedAt !== request.baseGeneratedAt;
}

/** Clear every request the landed manifest proves satisfied. Absence of a
 *  section is NEVER evidence: a files-first genesis commit carries no gitRepos
 *  at all, and clearing on absence would swallow every pending request. */
export async function settleRepublishRequests(
  root: string,
  stream: string,
  gitRepos: Record<string, GitSection> | undefined,
  mutex: WorkspaceSyncMutex,
  hooks: RepublishMutationTestHooks = {},
): Promise<string[]> {
  await assertRepublishMutex(mutex, root);
  const read = await readStoreFile(root);
  await hooks.afterRead?.();
  if (read.status !== "valid" || read.record.stream !== stream) return [];
  const settled = new Map<string, RepublishRequest>();
  for (const request of read.record.requests) {
    if (republishSatisfiedBy(gitRepos?.[request.relPath], request)) settled.set(request.relPath, request);
  }
  if (settled.size === 0) return [];
  const remaining = read.record.requests
    .filter((request) => {
      const satisfied = settled.get(request.relPath);
      return !satisfied || !sameRequest(request, satisfied);
    });
  await writeStore(root, stream, remaining, read);
  return [...settled.keys()].sort();
}
