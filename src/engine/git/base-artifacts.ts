import { canonicalize, verifyRoundTrip } from "../e2ee/jcs.js";
import { hashBytes } from "../hash.js";
import { refNameOk } from "./config-sync.js";
import { gitRaw } from "./shared.js";
import type { ArtifactBinding } from "./repo-lineage.js";
import { withProtocolLockClass, withRepoOperationLock } from "./protocol-locks.js";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const BASE_ABSENT_PREFIX = "refs/rbox-local/base-absent/v2";
export const BASE_PRESENT_PREFIX = "refs/rbox-local/base-present/v2";
export const BASE_PRESENT_KEEP_PREFIX = "refs/rbox-local/base-present-keep/v2";
export const SETTLED_ABSENCE_PREFIX = "refs/rbox-local/base-absent-settled/v1";
export const MAX_UNSETTLED_BASE_ABSENT = 4_096;
export const MAX_BASE_PRESENT = 256;
export const MAX_BASE_PRESENT_KEEP = 512;

export interface BaseAbsentPayload extends ArtifactBinding {
  v: 2;
  priorOid: string;
  ref: string;
}

export interface BasePresentPayload extends ArtifactBinding {
  v: 2;
  episode: string;
  nextOid: string;
  priorOid: string | null;
  ref: string;
}

export interface SettledAbsenceMeta extends ArtifactBinding {
  v: 1;
  count: number;
}

export interface PreparedProtocolRef<T> {
  ref: string;
  targetOid: string;
  payload: T;
  payloadBytes: Uint8Array;
}

export interface PreparedBasePresent extends PreparedProtocolRef<BasePresentPayload> {
  keepRefs: Array<{ ref: string; targetOid: string; slot: "prior" | "next" }>;
  transactionLines: string[];
}

export type ArtifactInvalidReason =
  | "bad-namespace" | "indirect-ref" | "wrong-object-type" | "unreadable-object"
  | "non-canonical-payload" | "bad-schema" | "binding-mismatch" | "ref-hash-mismatch"
  | "ref-mismatch" | "missing-keep" | "wrong-keep-target" | "orphan-keep"
  | "bad-tree" | "collision" | "capacity";

export type ArtifactReadResult<T> =
  | { status: "absent" }
  | { status: "valid"; artifact: PreparedProtocolRef<T> }
  | { status: "invalid"; ref: string; targetOid?: string; reason: ArtifactInvalidReason; detail: string };

export interface SettledAbsenceLedger {
  ref: string;
  targetOid: string;
  meta: SettledAbsenceMeta;
  entries: Map<string, BaseAbsentPayload>;
  entryOids: Map<string, string>;
}

export type SettledAbsenceReadResult =
  | { status: "absent" }
  | { status: "valid"; ledger: SettledAbsenceLedger }
  | { status: "invalid"; ref: string; targetOid?: string; reason: ArtifactInvalidReason; detail: string };

export interface PreparedSettledAbsence {
  ref: string;
  targetOid: string;
  meta: SettledAbsenceMeta;
  entries: Map<string, BaseAbsentPayload>;
}

export interface PreparedSettledAbsenceRetirement {
  ref: string;
  priorTargetOid: string;
  nextTargetOid: string | null;
  payload: BaseAbsentPayload;
  transactionLines: string[];
  next?: PreparedSettledAbsence;
}

function validBranchRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") && refNameOk(ref.slice("refs/heads/".length));
}

export const branchRefHash = (ref: string): string => {
  if (!validBranchRef(ref)) throw new Error(`invalid branch ref: ${ref}`);
  return hashBytes(Buffer.from(ref, "utf8"));
};

function requireBinding(binding: ArtifactBinding): void {
  if (!HEX64.test(binding.lineageHash) || !HEX64.test(binding.repositoryIdentityHash)) throw new Error("invalid artifact binding");
}

export function baseAbsentArtifactRef(binding: ArtifactBinding, ref: string): string {
  requireBinding(binding);
  return `${BASE_ABSENT_PREFIX}/${binding.lineageHash}/${branchRefHash(ref)}`;
}

export function basePresentArtifactRef(binding: ArtifactBinding, ref: string): string {
  requireBinding(binding);
  return `${BASE_PRESENT_PREFIX}/${binding.lineageHash}/${branchRefHash(ref)}`;
}

export function basePresentKeepRef(binding: ArtifactBinding, ref: string, episode: string, slot: "prior" | "next"): string {
  requireBinding(binding);
  if (!HEX32.test(episode)) throw new Error("invalid P episode");
  return `${BASE_PRESENT_KEEP_PREFIX}/${binding.lineageHash}/${branchRefHash(ref)}/${episode}/${slot}`;
}

export function settledAbsenceRef(binding: ArtifactBinding): string {
  requireBinding(binding);
  return `${SETTLED_ABSENCE_PREFIX}/${binding.lineageHash}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function canonicalPayload<T>(payload: T): Uint8Array { return canonicalize(payload); }

function parseCanonical(bytes: Uint8Array): Record<string, unknown> {
  const text = Buffer.from(bytes).toString("utf8");
  const parsed = verifyRoundTrip(text);
  const object = record(parsed);
  if (!object) throw new Error("payload is not an object");
  return object;
}

export function baseAbsentPayload(binding: ArtifactBinding, ref: string, priorOid: string): BaseAbsentPayload {
  requireBinding(binding);
  if (!validBranchRef(ref) || !HEX40.test(priorOid)) throw new Error("invalid A payload input");
  return { lineageHash: binding.lineageHash, priorOid, ref, repositoryIdentityHash: binding.repositoryIdentityHash, v: 2 };
}

export function basePresentPayload(binding: ArtifactBinding, ref: string, episode: string, priorOid: string | null, nextOid: string): BasePresentPayload {
  requireBinding(binding);
  if (!validBranchRef(ref) || !HEX32.test(episode) || !HEX40.test(nextOid) || (priorOid !== null && !HEX40.test(priorOid))) {
    throw new Error("invalid P payload input");
  }
  if (priorOid === nextOid) throw new Error("P transition is a no-op");
  return { episode, lineageHash: binding.lineageHash, nextOid, priorOid, ref, repositoryIdentityHash: binding.repositoryIdentityHash, v: 2 };
}

function parseAbsentPayload(bytes: Uint8Array): BaseAbsentPayload {
  const value = parseCanonical(bytes);
  if (!exactKeys(value, ["lineageHash", "priorOid", "ref", "repositoryIdentityHash", "v"]) || value.v !== 2
    || typeof value.lineageHash !== "string" || !HEX64.test(value.lineageHash)
    || typeof value.repositoryIdentityHash !== "string" || !HEX64.test(value.repositoryIdentityHash)
    || typeof value.priorOid !== "string" || !HEX40.test(value.priorOid)
    || typeof value.ref !== "string" || !validBranchRef(value.ref)) throw new Error("invalid A schema");
  return value as unknown as BaseAbsentPayload;
}

function parsePresentPayload(bytes: Uint8Array): BasePresentPayload {
  const value = parseCanonical(bytes);
  if (!exactKeys(value, ["episode", "lineageHash", "nextOid", "priorOid", "ref", "repositoryIdentityHash", "v"]) || value.v !== 2
    || typeof value.lineageHash !== "string" || !HEX64.test(value.lineageHash)
    || typeof value.repositoryIdentityHash !== "string" || !HEX64.test(value.repositoryIdentityHash)
    || typeof value.episode !== "string" || !HEX32.test(value.episode)
    || typeof value.nextOid !== "string" || !HEX40.test(value.nextOid)
    || !(value.priorOid === null || (typeof value.priorOid === "string" && HEX40.test(value.priorOid)))
    || value.priorOid === value.nextOid || typeof value.ref !== "string" || !validBranchRef(value.ref)) throw new Error("invalid P schema");
  return value as unknown as BasePresentPayload;
}

async function writeBlob(repoDir: string, bytes: Uint8Array): Promise<string> {
  const oid = (await gitRaw(repoDir, ["hash-object", "-w", "--stdin"], { stdin: Buffer.from(bytes).toString("utf8") })).trim();
  if (!HEX40.test(oid)) throw new Error("Git returned an invalid object id");
  return oid;
}

interface DirectRef { ref: string; targetOid: string; objectType: string; symref: string }

async function directRef(repoDir: string, ref: string): Promise<DirectRef | undefined> {
  const raw = await gitRaw(repoDir, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)%00", ref]);
  if (!raw) return undefined;
  const fields = raw.split("\0");
  if (fields[0] !== ref || !fields[1] || !fields[2] || fields.slice(4).some((field) => field !== "" && field !== "\n")) {
    throw new Error("ambiguous protocol ref read");
  }
  return { ref, targetOid: fields[1], objectType: fields[2], symref: fields[3] ?? "" };
}

async function readBlob(repoDir: string, oid: string): Promise<Uint8Array> {
  return Buffer.from(await gitRaw(repoDir, ["cat-file", "blob", oid]));
}

async function countRefs(repoDir: string, prefix: string): Promise<number> {
  const raw = await gitRaw(repoDir, ["for-each-ref", "--format=%(refname)", prefix]);
  return raw.split("\n").filter(Boolean).length;
}

export async function assertBaseArtifactCapacity(repoDir: string, additions: { absent?: number; present?: number; keep?: number }): Promise<void> {
  const [absent, present, keep] = await Promise.all([
    countRefs(repoDir, BASE_ABSENT_PREFIX), countRefs(repoDir, BASE_PRESENT_PREFIX), countRefs(repoDir, BASE_PRESENT_KEEP_PREFIX),
  ]);
  if (absent + (additions.absent ?? 0) > MAX_UNSETTLED_BASE_ABSENT
    || present + (additions.present ?? 0) > MAX_BASE_PRESENT
    || keep + (additions.keep ?? 0) > MAX_BASE_PRESENT_KEEP) throw new Error("base artifact capacity exceeded");
}

async function prepareBaseAbsentArtifactUnlocked(repoDir: string, binding: ArtifactBinding, ref: string, priorOid: string): Promise<PreparedProtocolRef<BaseAbsentPayload> & { transactionLines: string[] }> {
  await assertBaseArtifactCapacity(repoDir, { absent: 1 });
  const payload = baseAbsentPayload(binding, ref, priorOid);
  const payloadBytes = canonicalPayload(payload);
  const artifact = { ref: baseAbsentArtifactRef(binding, ref), targetOid: await writeBlob(repoDir, payloadBytes), payload, payloadBytes };
  return { ...artifact, transactionLines: [`create ${artifact.ref} ${artifact.targetOid}`] };
}

export function prepareBaseAbsentArtifact(repoDir: string, binding: ArtifactBinding, ref: string, priorOid: string): Promise<PreparedProtocolRef<BaseAbsentPayload> & { transactionLines: string[] }> {
  return withRepoOperationLock(repoDir, () => prepareBaseAbsentArtifactUnlocked(repoDir, binding, ref, priorOid));
}

async function prepareBasePresentArtifactUnlocked(repoDir: string, binding: ArtifactBinding, ref: string, episode: string, priorOid: string | null, nextOid: string): Promise<PreparedBasePresent> {
  const keepCount = priorOid === null ? 1 : 2;
  await assertBaseArtifactCapacity(repoDir, { present: 1, keep: keepCount });
  const payload = basePresentPayload(binding, ref, episode, priorOid, nextOid);
  const payloadBytes = canonicalPayload(payload);
  const artifactRef = basePresentArtifactRef(binding, ref);
  const targetOid = await writeBlob(repoDir, payloadBytes);
  const keepRefs = [
    ...(priorOid === null ? [] : [{ ref: basePresentKeepRef(binding, ref, episode, "prior"), targetOid: priorOid, slot: "prior" as const }]),
    { ref: basePresentKeepRef(binding, ref, episode, "next"), targetOid: nextOid, slot: "next" as const },
  ];
  const transactionLines = [
    `create ${artifactRef} ${targetOid}`,
    ...keepRefs.map((keep) => `create ${keep.ref} ${keep.targetOid}`),
  ].sort((a, b) => Buffer.compare(Buffer.from(a.split(" ")[1]!), Buffer.from(b.split(" ")[1]!)));
  return { ref: artifactRef, targetOid, payload, payloadBytes, keepRefs, transactionLines };
}

export function prepareBasePresentArtifact(repoDir: string, binding: ArtifactBinding, ref: string, episode: string, priorOid: string | null, nextOid: string): Promise<PreparedBasePresent> {
  return withRepoOperationLock(repoDir, () => prepareBasePresentArtifactUnlocked(repoDir, binding, ref, episode, priorOid, nextOid));
}

async function readPayloadArtifact<T>(repoDir: string, artifactRef: string, expectedBinding: ArtifactBinding, expectedRef: string | undefined, parser: (bytes: Uint8Array) => T): Promise<ArtifactReadResult<T>> {
  let direct: DirectRef | undefined;
  try { direct = await directRef(repoDir, artifactRef); } catch (error) {
    return { status: "invalid", ref: artifactRef, reason: "bad-namespace", detail: String(error) };
  }
  if (!direct) return { status: "absent" };
  if (direct.symref) return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "indirect-ref", detail: "protocol artifact is symbolic" };
  if (!HEX40.test(direct.targetOid) || direct.objectType !== "blob") return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "wrong-object-type", detail: "protocol artifact must target a blob" };
  try {
    const payloadBytes = await readBlob(repoDir, direct.targetOid);
    const payload = parser(payloadBytes) as T & ArtifactBinding & { ref: string };
    if (payload.lineageHash !== expectedBinding.lineageHash || payload.repositoryIdentityHash !== expectedBinding.repositoryIdentityHash) {
      return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "binding-mismatch", detail: "artifact binding is not current" };
    }
    if (expectedRef !== undefined && payload.ref !== expectedRef) return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "ref-mismatch", detail: "artifact payload names another ref" };
    if (!artifactRef.endsWith(`/${branchRefHash(payload.ref)}`)) return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "ref-hash-mismatch", detail: "artifact namespace does not hash its payload ref" };
    return { status: "valid", artifact: { ref: artifactRef, targetOid: direct.targetOid, payload, payloadBytes } };
  } catch (error) {
    return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "non-canonical-payload", detail: String(error) };
  }
}

export function readBaseAbsentArtifact(repoDir: string, binding: ArtifactBinding, ref: string): Promise<ArtifactReadResult<BaseAbsentPayload>> {
  return readPayloadArtifact(repoDir, baseAbsentArtifactRef(binding, ref), binding, ref, parseAbsentPayload);
}

export function readBaseAbsentArtifactRef(repoDir: string, binding: ArtifactBinding, artifactRef: string): Promise<ArtifactReadResult<BaseAbsentPayload>> {
  return readPayloadArtifact(repoDir, artifactRef, binding, undefined, parseAbsentPayload);
}

async function inspectPayloadArtifact<T extends ArtifactBinding & { ref: string }>(
  repoDir: string,
  artifactRef: string,
  prefix: string,
  parser: (bytes: Uint8Array) => T,
): Promise<ArtifactReadResult<T>> {
  const namespace = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([0-9a-f]{64})/([0-9a-f]{64})$`).exec(artifactRef);
  if (!namespace) return { status: "invalid", ref: artifactRef, reason: "bad-namespace", detail: "artifact ref namespace is malformed" };
  let direct: DirectRef | undefined;
  try { direct = await directRef(repoDir, artifactRef); } catch (error) {
    return { status: "invalid", ref: artifactRef, reason: "bad-namespace", detail: String(error) };
  }
  if (!direct) return { status: "absent" };
  if (direct.symref) return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "indirect-ref", detail: "protocol artifact is symbolic" };
  if (!HEX40.test(direct.targetOid) || direct.objectType !== "blob") return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "wrong-object-type", detail: "protocol artifact must target a blob" };
  try {
    const payloadBytes = await readBlob(repoDir, direct.targetOid);
    const payload = parser(payloadBytes);
    if (payload.lineageHash !== namespace[1]) return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "binding-mismatch", detail: "payload lineage differs from namespace" };
    if (branchRefHash(payload.ref) !== namespace[2]) return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "ref-hash-mismatch", detail: "payload branch differs from namespace suffix" };
    return { status: "valid", artifact: { ref: artifactRef, targetOid: direct.targetOid, payload, payloadBytes } };
  } catch (error) {
    return { status: "invalid", ref: artifactRef, targetOid: direct.targetOid, reason: "non-canonical-payload", detail: String(error) };
  }
}

export function inspectBaseAbsentArtifactRef(repoDir: string, artifactRef: string): Promise<ArtifactReadResult<BaseAbsentPayload>> {
  return inspectPayloadArtifact(repoDir, artifactRef, BASE_ABSENT_PREFIX, parseAbsentPayload);
}

async function validatePresentKeeps(repoDir: string, result: Extract<ArtifactReadResult<BasePresentPayload>, { status: "valid" }>): Promise<ArtifactReadResult<BasePresentPayload>> {
  const payload = result.artifact.payload;
  const binding = { lineageHash: payload.lineageHash, repositoryIdentityHash: payload.repositoryIdentityHash };
  for (const [slot, oid] of [["prior", payload.priorOid], ["next", payload.nextOid]] as const) {
    if (oid === null) continue;
    const keepRef = basePresentKeepRef(binding, payload.ref, payload.episode, slot);
    const keep = await directRef(repoDir, keepRef).catch(() => undefined);
    if (!keep) return { status: "invalid", ref: result.artifact.ref, targetOid: result.artifact.targetOid, reason: "missing-keep", detail: `missing ${slot} K` };
    if (keep.symref || keep.targetOid !== oid) return { status: "invalid", ref: result.artifact.ref, targetOid: result.artifact.targetOid, reason: "wrong-keep-target", detail: `invalid ${slot} K` };
  }
  return result;
}

export async function readBasePresentArtifact(repoDir: string, binding: ArtifactBinding, ref: string): Promise<ArtifactReadResult<BasePresentPayload>> {
  const result = await readPayloadArtifact(repoDir, basePresentArtifactRef(binding, ref), binding, ref, parsePresentPayload);
  if (result.status !== "valid") return result;
  return validatePresentKeeps(repoDir, result);
}

export async function readBasePresentArtifactRef(repoDir: string, binding: ArtifactBinding, artifactRef: string): Promise<ArtifactReadResult<BasePresentPayload>> {
  const initial = await readPayloadArtifact(repoDir, artifactRef, binding, undefined, parsePresentPayload);
  if (initial.status !== "valid") return initial;
  return readBasePresentArtifact(repoDir, binding, initial.artifact.payload.ref);
}

export async function inspectBasePresentArtifactRef(repoDir: string, artifactRef: string): Promise<ArtifactReadResult<BasePresentPayload>> {
  const result = await inspectPayloadArtifact(repoDir, artifactRef, BASE_PRESENT_PREFIX, parsePresentPayload);
  return result.status === "valid" ? validatePresentKeeps(repoDir, result) : result;
}

interface TreeEntry { mode: string; type: string; oid: string; name: string }

async function readTree(repoDir: string, oid: string): Promise<TreeEntry[]> {
  const raw = await gitRaw(repoDir, ["ls-tree", "-z", oid]);
  return raw.split("\0").filter(Boolean).map((line) => {
    const match = /^(\d+) ([a-z]+) ([0-9a-f]{40})\t([^\0]+)$/.exec(line);
    if (!match) throw new Error("malformed tree entry");
    return { mode: match[1]!, type: match[2]!, oid: match[3]!, name: match[4]! };
  });
}

async function writeTree(repoDir: string, entries: readonly TreeEntry[]): Promise<string> {
  const input = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    .map((entry) => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.name}\n`).join("");
  const oid = (await gitRaw(repoDir, ["mktree"], { stdin: input })).trim();
  if (!HEX40.test(oid)) throw new Error("Git returned an invalid tree id");
  return oid;
}

function parseSettledMeta(bytes: Uint8Array): SettledAbsenceMeta {
  const value = parseCanonical(bytes);
  if (!exactKeys(value, ["count", "lineageHash", "repositoryIdentityHash", "v"]) || value.v !== 1
    || !Number.isSafeInteger(value.count) || (value.count as number) < 0
    || typeof value.lineageHash !== "string" || !HEX64.test(value.lineageHash)
    || typeof value.repositoryIdentityHash !== "string" || !HEX64.test(value.repositoryIdentityHash)) throw new Error("invalid Z metadata schema");
  return value as unknown as SettledAbsenceMeta;
}

async function buildSettledAbsenceTreeUnlocked(repoDir: string, binding: ArtifactBinding, payloads: Iterable<BaseAbsentPayload>): Promise<PreparedSettledAbsence> {
  requireBinding(binding);
  const byHash = new Map<string, BaseAbsentPayload>();
  for (const payload of payloads) {
    const validated = parseAbsentPayload(canonicalPayload(payload));
    if (validated.lineageHash !== binding.lineageHash || validated.repositoryIdentityHash !== binding.repositoryIdentityHash) throw new Error("Z leaf binding mismatch");
    const refHash = branchRefHash(validated.ref);
    if (byHash.has(refHash)) throw new Error("duplicate or colliding Z leaf");
    byHash.set(refHash, validated);
  }
  const buckets = new Map<string, TreeEntry[]>();
  for (const [refHash, payload] of byHash) {
    const oid = await writeBlob(repoDir, canonicalPayload(payload));
    const bucket = refHash.slice(0, 2);
    const entries = buckets.get(bucket) ?? [];
    entries.push({ mode: "100644", type: "blob", oid, name: refHash.slice(2) });
    buckets.set(bucket, entries);
  }
  const entryTrees: TreeEntry[] = [];
  for (const [bucket, entries] of buckets) entryTrees.push({ mode: "040000", type: "tree", oid: await writeTree(repoDir, entries), name: bucket });
  const entriesTree = await writeTree(repoDir, entryTrees);
  const meta: SettledAbsenceMeta = { count: byHash.size, lineageHash: binding.lineageHash, repositoryIdentityHash: binding.repositoryIdentityHash, v: 1 };
  const metaOid = await writeBlob(repoDir, canonicalPayload(meta));
  const targetOid = await writeTree(repoDir, [
    { mode: "040000", type: "tree", oid: entriesTree, name: "entries" },
    { mode: "100644", type: "blob", oid: metaOid, name: "meta" },
  ]);
  return { ref: settledAbsenceRef(binding), targetOid, meta, entries: byHash };
}

export function buildSettledAbsenceTree(repoDir: string, binding: ArtifactBinding, payloads: Iterable<BaseAbsentPayload>): Promise<PreparedSettledAbsence> {
  return withRepoOperationLock(repoDir, () => buildSettledAbsenceTreeUnlocked(repoDir, binding, payloads));
}

export async function readSettledAbsence(repoDir: string, binding: ArtifactBinding): Promise<SettledAbsenceReadResult> {
  const ref = settledAbsenceRef(binding);
  let direct: DirectRef | undefined;
  try { direct = await directRef(repoDir, ref); } catch (error) {
    return { status: "invalid", ref, reason: "bad-tree", detail: String(error) };
  }
  if (!direct) return { status: "absent" };
  if (direct.symref || direct.objectType !== "tree" || !HEX40.test(direct.targetOid)) return { status: "invalid", ref, targetOid: direct.targetOid, reason: "wrong-object-type", detail: "Z must directly target a tree" };
  try {
    const root = await readTree(repoDir, direct.targetOid);
    if (root.length !== 2) throw new Error("Z root has extra or missing entries");
    const metaEntry = root.find((entry) => entry.name === "meta");
    const entriesEntry = root.find((entry) => entry.name === "entries");
    if (!metaEntry || metaEntry.mode !== "100644" || metaEntry.type !== "blob" || !entriesEntry || entriesEntry.mode !== "040000" || entriesEntry.type !== "tree") throw new Error("Z root shape is invalid");
    const meta = parseSettledMeta(await readBlob(repoDir, metaEntry.oid));
    if (meta.lineageHash !== binding.lineageHash || meta.repositoryIdentityHash !== binding.repositoryIdentityHash) throw new Error("Z metadata binding mismatch");
    const payloads = new Map<string, BaseAbsentPayload>();
    const entryOids = new Map<string, string>();
    for (const bucket of await readTree(repoDir, entriesEntry.oid)) {
      if (bucket.mode !== "040000" || bucket.type !== "tree" || !/^[0-9a-f]{2}$/.test(bucket.name)) throw new Error("invalid Z bucket");
      for (const leaf of await readTree(repoDir, bucket.oid)) {
        if (leaf.mode !== "100644" || leaf.type !== "blob" || !/^[0-9a-f]{62}$/.test(leaf.name)) throw new Error("invalid Z leaf");
        const refHash = `${bucket.name}${leaf.name}`;
        if (payloads.has(refHash)) throw new Error("duplicate Z leaf");
        const payload = parseAbsentPayload(await readBlob(repoDir, leaf.oid));
        if (payload.lineageHash !== binding.lineageHash || payload.repositoryIdentityHash !== binding.repositoryIdentityHash) throw new Error("Z leaf binding mismatch");
        if (branchRefHash(payload.ref) !== refHash) throw new Error("Z leaf hash collision");
        payloads.set(refHash, payload);
        entryOids.set(refHash, leaf.oid);
      }
    }
    if (payloads.size !== meta.count) throw new Error("Z metadata count mismatch");
    return { status: "valid", ledger: { ref, targetOid: direct.targetOid, meta, entries: payloads, entryOids } };
  } catch (error) {
    return { status: "invalid", ref, targetOid: direct.targetOid, reason: "bad-tree", detail: String(error) };
  }
}

export async function lookupSettledAbsence(repoDir: string, binding: ArtifactBinding, ref: string): Promise<BaseAbsentPayload | undefined> {
  const ledger = await readSettledAbsence(repoDir, binding);
  if (ledger.status === "invalid") throw new Error(`invalid settled-absence ledger: ${ledger.detail}`);
  return ledger.status === "valid" ? ledger.ledger.entries.get(branchRefHash(ref)) : undefined;
}

async function prepareSettleBaseAbsentUnlocked(repoDir: string, binding: ArtifactBinding, ref: string): Promise<{ transactionLines: string[]; next: PreparedSettledAbsence }> {
  const artifact = await readBaseAbsentArtifact(repoDir, binding, ref);
  if (artifact.status !== "valid") throw new Error(`cannot settle A: ${artifact.status === "invalid" ? artifact.detail : "artifact absent"}`);
  const current = await readSettledAbsence(repoDir, binding);
  if (current.status === "invalid") throw new Error(`cannot settle into invalid Z: ${current.detail}`);
  const payloads = current.status === "valid" ? [...current.ledger.entries.values()] : [];
  const refHash = branchRefHash(ref);
  if (current.status === "valid" && current.ledger.entries.has(refHash)) throw new Error("A and matching Z leaf coexist");
  const next = await buildSettledAbsenceTree(repoDir, binding, [...payloads, artifact.artifact.payload]);
  const zLine = current.status === "valid"
    ? `update ${next.ref} ${next.targetOid} ${current.ledger.targetOid}`
    : `create ${next.ref} ${next.targetOid}`;
  const transactionLines = [zLine, `delete ${artifact.artifact.ref} ${artifact.artifact.targetOid}`]
    .sort((a, b) => Buffer.compare(Buffer.from(a.split(" ")[1]!), Buffer.from(b.split(" ")[1]!)));
  return { transactionLines, next };
}

export function prepareSettleBaseAbsent(repoDir: string, binding: ArtifactBinding, ref: string): Promise<{ transactionLines: string[]; next: PreparedSettledAbsence }> {
  return withRepoOperationLock(repoDir, () => prepareSettleBaseAbsentUnlocked(repoDir, binding, ref));
}

/** Prepare only the exact Z-leaf retirement. The caller atomically splices these
 * sorted CAS lines with create R/P/K for an absent-to-present transition. */
async function prepareRetireSettledAbsenceUnlocked(repoDir: string, binding: ArtifactBinding, ref: string): Promise<PreparedSettledAbsenceRetirement> {
  const current = await readSettledAbsence(repoDir, binding);
  if (current.status !== "valid") throw new Error(`cannot retire Z absence: ${current.status === "invalid" ? current.detail : "ledger absent"}`);
  const hash = branchRefHash(ref);
  const payload = current.ledger.entries.get(hash);
  if (!payload) throw new Error("cannot retire Z absence: leaf absent");
  if (payload.ref !== ref) throw new Error("cannot retire Z absence: ref-hash collision");
  const remaining = [...current.ledger.entries.entries()].filter(([entryHash]) => entryHash !== hash).map(([, entry]) => entry);
  if (remaining.length === 0) {
    return {
      ref: current.ledger.ref,
      priorTargetOid: current.ledger.targetOid,
      nextTargetOid: null,
      payload,
      transactionLines: [`delete ${current.ledger.ref} ${current.ledger.targetOid}`],
    };
  }
  const next = await buildSettledAbsenceTree(repoDir, binding, remaining);
  return {
    ref: current.ledger.ref,
    priorTargetOid: current.ledger.targetOid,
    nextTargetOid: next.targetOid,
    payload,
    transactionLines: [`update ${current.ledger.ref} ${next.targetOid} ${current.ledger.targetOid}`],
    next,
  };
}

export function prepareRetireSettledAbsence(repoDir: string, binding: ArtifactBinding, ref: string): Promise<PreparedSettledAbsenceRetirement> {
  return withRepoOperationLock(repoDir, () => prepareRetireSettledAbsenceUnlocked(repoDir, binding, ref));
}

async function commitProtocolRefTransactionUnlocked(repoDir: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  const parsed = lines.map((line) => {
    const match = /^(?:create|update|delete|verify) (\S+)(?: |$)/.exec(line);
    if (!match) throw new Error("invalid protocol ref transaction line");
    return { line, ref: match[1]! };
  });
  const refs = new Set<string>();
  for (const entry of parsed) if (refs.has(entry.ref)) throw new Error(`duplicate protocol transaction ref: ${entry.ref}`); else refs.add(entry.ref);
  parsed.sort((a, b) => Buffer.compare(Buffer.from(a.ref), Buffer.from(b.ref)));
  await withProtocolLockClass("git", `${repoDir}:${parsed.map((entry) => entry.ref).join(",")}`, () =>
    gitRaw(repoDir, ["update-ref", "--stdin"], { stdin: ["start", ...parsed.map((entry) => entry.line), "prepare", "commit", ""].join("\n") }).then(() => undefined));
}

export function commitProtocolRefTransaction(repoDir: string, lines: readonly string[]): Promise<void> {
  return withRepoOperationLock(repoDir, () => commitProtocolRefTransactionUnlocked(repoDir, lines));
}

export async function settleBaseAbsentArtifact(repoDir: string, binding: ArtifactBinding, ref: string): Promise<PreparedSettledAbsence> {
  return withRepoOperationLock(repoDir, async () => {
    const prepared = await prepareSettleBaseAbsent(repoDir, binding, ref);
    await commitProtocolRefTransaction(repoDir, prepared.transactionLines);
    return prepared.next;
  });
}
