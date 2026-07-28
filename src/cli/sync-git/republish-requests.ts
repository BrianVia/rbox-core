import fs from "node:fs/promises";
import path from "node:path";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../../engine/fsutil.js";
import type { GitSection } from "../../engine/types.js";
import { boundedJsonRead } from "../reset-io.js";

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
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.stream !== "string" || record.stream.length === 0) return undefined;
  if (!Array.isArray(record.requests) || record.requests.length === 0 || record.requests.length > REPUBLISH_REQUESTS_MAX) return undefined;
  const seen = new Set<string>();
  const requests: RepublishRequest[] = [];
  for (const raw of record.requests) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entry = raw as Record<string, unknown>;
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
export async function readRepublishStore(root: string, stream: string): Promise<RepublishStoreRead> {
  let raw: unknown;
  try {
    raw = await boundedJsonRead(republishRequestsPath(root), REPUBLISH_REQUESTS_MAX_BYTES);
  } catch {
    return { status: "corrupt" };
  }
  if (raw === undefined) return { status: "absent" };
  const record = validate(raw);
  if (!record) return { status: "corrupt" };
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

async function writeStore(root: string, stream: string, requests: readonly RepublishRequest[]): Promise<void> {
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
): Promise<RecordRepublishResult> {
  if (!validRelPath(relPath)) throw new Error("invalid repository path");
  if (!HEX64.test(base.bundleSha) || !validTimestamp(base.generatedAt)) {
    throw new Error("this repository has no published Git bundle to supersede");
  }
  const read = await readRepublishStore(root, stream);
  if (read.status === "corrupt") {
    throw new Error(`the republish request file is unreadable — inspect and remove ${republishRequestsPath(root)}, then run this again`);
  }
  const current = read.status === "valid" ? read.record.requests : [];
  const existing = current.find((request) => request.relPath === relPath);
  if (existing) return { status: "already-pending", requestedAt: existing.requestedAt, pending: current.length };
  if (current.length >= REPUBLISH_REQUESTS_MAX) {
    throw new Error(`${REPUBLISH_REQUESTS_MAX} chain restarts are already pending — let them publish before requesting another`);
  }
  const requestedAt = now.toISOString();
  const next = [...current, { relPath, requestedAt, baseBundleSha: base.bundleSha, baseGeneratedAt: base.generatedAt }];
  await writeStore(root, stream, next);
  // The store is advisory and unlocked: a concurrent settle can land between
  // the read and the rename. Confirm the request survived rather than reporting
  // a success the next push will not act on.
  const confirmed = await readRepublishStore(root, stream);
  if (confirmed.status !== "valid" || !confirmed.record.requests.some((request) => request.relPath === relPath)) {
    throw new Error("a concurrent sync replaced the request file — run this command again");
  }
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
): Promise<string[]> {
  const read = await readRepublishStore(root, stream);
  if (read.status !== "valid") return [];
  const settled = new Map<string, string>();
  for (const request of read.record.requests) {
    if (republishSatisfiedBy(gitRepos?.[request.relPath], request)) settled.set(request.relPath, request.requestedAt);
  }
  if (settled.size === 0) return [];
  // Re-read before writing and drop ONLY the exact (relPath, requestedAt) pairs
  // proven satisfied, so a request installed for another repository while this
  // push was committing is not written away.
  const fresh = await readRepublishStore(root, stream);
  const remaining = (fresh.status === "valid" ? fresh.record.requests : [])
    .filter((request) => settled.get(request.relPath) !== request.requestedAt);
  await writeStore(root, stream, remaining);
  return [...settled.keys()].sort();
}
