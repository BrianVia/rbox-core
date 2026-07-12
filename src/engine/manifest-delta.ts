import { zstdCompress, zstdDecompressCapped } from "./crypto.js";
import { KNOWN_MANIFEST_SCHEMA, validateManifest } from "./manifest-validate.js";
import type { FileEntry, GitSection, Manifest } from "./types.js";
import { parseStrict } from "./e2ee/jcs.js";
import { sha256Hex, utf8 } from "./e2ee/primitives.js";
import { hashBytes } from "./hash.js";
export { MAX_MANIFEST_DELTA_CHAIN } from "./manifest-chain.js";

export const MANIFEST_ENVELOPE_MAGIC = "rbox-mde1\n";
export const MANIFEST_ENVELOPE_PREFIX = "rbox-mde";
export const MAX_ENVELOPE_HEADER = 64 * 1024;
export const MAX_MANIFEST_PLAINTEXT = 512 * 1024 * 1024;

const SHA_RE = /^[0-9a-f]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Float-tolerant canonical JSON used only for manifest integrity hashes and
 * delta bodies. The signed-object JCS serializer intentionally rejects
 * fractional numbers, but real manifests contain fractional `mtimeMs` values.
 * ECMAScript's specified shortest-round-trip number rendering is deterministic
 * for these finite doubles; keys use the same UTF-16 ordering as Array#sort.
 * NOTE(84): §3.2 calls this JCS, while the Layer-1 build resolution and measured
 * fractional mtimes require this float-tolerant JCS-compatible variant.
 */
/** True iff the string has no lone UTF-16 surrogate (String#isWellFormed semantics). */
function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c > 0xdbff) return false; // low surrogate with no preceding high
    const next = s.charCodeAt(i + 1);
    if (!(next >= 0xdc00 && next <= 0xdfff)) return false; // high surrogate not followed by low
    i++;
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return JSON.stringify(value);
    case "string":
      // RFC 8785 requires canonicalization to FAIL on invalid Unicode; a lone
      // surrogate would otherwise hash as its escaped form here while a
      // conforming JCS implementation rejects it — a cross-implementation
      // divergence at a protocol boundary. Fail closed instead. (Manual scan:
      // String#isWellFormed needs lib es2024 and the repo pins ES2022.)
      if (!isWellFormedUtf16(value)) throw new Error("manifest canonicalization requires well-formed Unicode strings");
      return JSON.stringify(value);
    case "number": {
      if (!Number.isFinite(value)) throw new Error("manifest canonicalization requires finite numbers");
      return JSON.stringify(value);
    }
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      const object = value as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(object).sort()) {
        // Member NAMES need the same RFC 8785 well-formedness gate as values —
        // a lone-surrogate gitRepos key would otherwise hash here while a
        // conforming implementation rejects it.
        if (!isWellFormedUtf16(key)) throw new Error("manifest canonicalization requires well-formed Unicode strings");
        if (object[key] !== undefined) members.push(`${JSON.stringify(key)}:${canonicalJson(object[key])}`);
      }
      return `{${members.join(",")}}`;
    }
    default:
      throw new Error(`manifest canonicalization does not support ${typeof value}`);
  }
}

export function canonicalManifestBytes(manifest: Manifest): Uint8Array {
  return utf8(canonicalJson(manifest));
}

export function canonicalManifestHash(manifest: Manifest): Promise<string> {
  return sha256Hex(canonicalManifestBytes(manifest));
}

export type ManifestDeltaOp =
  | { op: "set"; entry: FileEntry }
  | { op: "del"; path: string }
  | { op: "git-set"; repo: string; section: GitSection }
  | { op: "git-del"; repo: string };

export interface ManifestDeltaHeader {
  kind: "delta";
  comp?: "zstd";
  bodyBytes: number;
  baseEncSha: string;
  baseManifestHash: string;
  generatedAt: string;
  manifestSchema?: number;
  resultHash: string;
}

export interface ManifestSnapshotHeader {
  kind: "snapshot";
  comp?: "zstd";
  bodyBytes: number;
  manifestHash: string;
}

export type DecodedManifestEnvelope =
  | { kind: "raw"; manifest: Manifest }
  | { kind: "snapshot"; manifest: Manifest; header: ManifestSnapshotHeader }
  | { kind: "delta"; header: ManifestDeltaHeader; ops: ManifestDeltaOp[] };

export class ManifestChainError extends Error {
  readonly failingLink?: string;
  readonly head?: { seq: number; hash: string };
  readonly reason: string;

  constructor(reason: string, options: { failingLink?: string; head?: { seq: number; hash: string }; cause?: unknown } = {}) {
    super(`manifest chain integrity failure: ${reason}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ManifestChainError";
    this.reason = reason;
    this.failingLink = options.failingLink;
    this.head = options.head;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

function opKey(op: ManifestDeltaOp): string {
  return op.op === "set" ? op.entry.path : op.op === "del" ? op.path : op.repo;
}

function opFamily(op: ManifestDeltaOp): number {
  return op.op === "set" || op.op === "del" ? 0 : 1;
}

function compareOps(a: ManifestDeltaOp, b: ManifestDeltaOp): number {
  const family = opFamily(a) - opFamily(b);
  if (family !== 0) return family;
  const ak = opKey(a);
  const bk = opKey(b);
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

export function diffToOps(base: Manifest, target: Manifest): ManifestDeltaOp[] {
  const ops: ManifestDeltaOp[] = [];
  const baseFiles = new Map(base.files.map((entry) => [entry.path, entry]));
  const targetFiles = new Map(target.files.map((entry) => [entry.path, entry]));
  for (const [path, entry] of targetFiles) {
    if (!deepEqual(baseFiles.get(path), entry)) ops.push({ op: "set", entry });
  }
  for (const path of baseFiles.keys()) {
    if (!targetFiles.has(path)) ops.push({ op: "del", path });
  }
  const baseRepos = base.gitRepos ?? {};
  const targetRepos = target.gitRepos ?? {};
  for (const [repo, section] of Object.entries(targetRepos)) {
    if (!deepEqual(baseRepos[repo], section)) ops.push({ op: "git-set", repo, section });
  }
  for (const repo of Object.keys(baseRepos)) {
    if (!(repo in targetRepos)) ops.push({ op: "git-del", repo });
  }
  return ops.sort(compareOps);
}

function assertManifest(manifest: Manifest): void {
  const validation = validateManifest(manifest);
  // Same message surface as today's decode boundary (e2ee-remote decode threw
  // `validation.error` verbatim pre-84) — schema/shape reasons are load-bearing
  // for callers and tests. Chain contexts wrap this in ManifestChainError.
  if (!validation.ok) throw new Error(validation.error);
}

function assertBodyBound(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_MANIFEST_PLAINTEXT) throw new Error("manifest envelope body exceeds maximum plaintext size");
}

async function frameEnvelope(header: ManifestSnapshotHeader | ManifestDeltaHeader, body: Uint8Array): Promise<Uint8Array> {
  const headerBytes = utf8(canonicalJson(header));
  if (headerBytes.byteLength > MAX_ENVELOPE_HEADER) throw new Error("manifest envelope header exceeds maximum size");
  const prefix = utf8(`${MANIFEST_ENVELOPE_MAGIC}${decoder.decode(headerBytes)}\n`);
  const out = new Uint8Array(prefix.byteLength + body.byteLength);
  out.set(prefix);
  out.set(body, prefix.byteLength);
  return out;
}

export async function encodeSnapshotEnvelope(manifest: Manifest, options: { compress: boolean }): Promise<Uint8Array> {
  assertManifest(manifest);
  const plaintext = utf8(JSON.stringify(manifest));
  assertBodyBound(plaintext);
  const header: ManifestSnapshotHeader = {
    kind: "snapshot",
    ...(options.compress ? { comp: "zstd" as const } : {}),
    bodyBytes: plaintext.byteLength,
    manifestHash: await canonicalManifestHash(manifest),
  };
  return frameEnvelope(header, options.compress ? await zstdCompress(plaintext) : plaintext);
}

export async function encodeDeltaEnvelope(
  base: Manifest,
  target: Manifest,
  options: { baseEncSha: string; baseManifestHash: string; compress: boolean }
): Promise<{ bytes: Uint8Array; resultHash: string; opCount: number; uncompressedBodyBytes: number }> {
  if (!SHA_RE.test(options.baseEncSha) || !SHA_RE.test(options.baseManifestHash)) throw new Error("delta base hash malformed");
  assertManifest(base);
  assertManifest(target);
  const ops = diffToOps(base, target);
  const body = utf8(canonicalJson(ops));
  assertBodyBound(body);
  const resultHash = await canonicalManifestHash(target);
  const header: ManifestDeltaHeader = {
    kind: "delta",
    ...(options.compress ? { comp: "zstd" as const } : {}),
    bodyBytes: body.byteLength,
    baseEncSha: options.baseEncSha,
    baseManifestHash: options.baseManifestHash,
    generatedAt: target.generatedAt,
    ...(target.manifestSchema === undefined ? {} : { manifestSchema: target.manifestSchema }),
    resultHash,
  };
  return {
    bytes: await frameEnvelope(header, options.compress ? await zstdCompress(body) : body),
    resultHash,
    opCount: ops.length,
    uncompressedBodyBytes: body.byteLength,
  };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].filter((key) => value[key] !== undefined).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("manifest envelope header has unknown or missing fields");
}

function validateCommonHeader(record: Record<string, unknown>): void {
  if (!Number.isSafeInteger(record.bodyBytes) || (record.bodyBytes as number) < 0 || (record.bodyBytes as number) > MAX_MANIFEST_PLAINTEXT) {
    throw new Error("manifest envelope bodyBytes invalid");
  }
  if (record.comp !== undefined && record.comp !== "zstd") throw new Error("manifest envelope compression invalid");
}

function parseHeader(value: unknown): ManifestSnapshotHeader | ManifestDeltaHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest envelope header must be an object");
  const record = value as Record<string, unknown>;
  validateCommonHeader(record);
  if (record.kind === "snapshot") {
    exactKeys(record, ["kind", "comp", "bodyBytes", "manifestHash"]);
    if (typeof record.manifestHash !== "string" || !SHA_RE.test(record.manifestHash)) throw new Error("snapshot manifestHash malformed");
    return record as unknown as ManifestSnapshotHeader;
  }
  if (record.kind === "delta") {
    exactKeys(record, ["kind", "comp", "bodyBytes", "baseEncSha", "baseManifestHash", "generatedAt", "manifestSchema", "resultHash"]);
    for (const key of ["baseEncSha", "baseManifestHash", "resultHash"] as const) {
      if (typeof record[key] !== "string" || !SHA_RE.test(record[key])) throw new Error(`delta ${key} malformed`);
    }
    if (typeof record.generatedAt !== "string" || record.generatedAt.length === 0) throw new Error("delta generatedAt invalid");
    if (record.manifestSchema !== undefined && (!Number.isSafeInteger(record.manifestSchema) || (record.manifestSchema as number) < 1 || (record.manifestSchema as number) > KNOWN_MANIFEST_SCHEMA)) {
      throw new Error("manifest schema is newer than this rbox supports — upgrade rbox");
    }
    return record as unknown as ManifestDeltaHeader;
  }
  throw new Error("manifest envelope kind invalid");
}

function parseManifest(bytes: Uint8Array): Manifest {
  const parsed = JSON.parse(decoder.decode(bytes)) as Manifest;
  assertManifest(parsed);
  return parsed;
}

function parseOps(bytes: Uint8Array): ManifestDeltaOp[] {
  const text = decoder.decode(bytes);
  const value = JSON.parse(text) as unknown;
  if (!Array.isArray(value)) throw new Error("manifest delta body must be an array");
  const ops: ManifestDeltaOp[] = [];
  let previous: ManifestDeltaOp | undefined;
  const keys = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("manifest delta op must be an object");
    const record = item as Record<string, unknown>;
    let op: ManifestDeltaOp;
    if (record.op === "set") {
      exactKeys(record, ["op", "entry"]);
      if (!record.entry || typeof record.entry !== "object" || Array.isArray(record.entry) || typeof (record.entry as Record<string, unknown>).path !== "string") throw new Error("manifest delta set entry invalid");
      op = { op: "set", entry: record.entry as unknown as FileEntry };
    } else if (record.op === "del") {
      exactKeys(record, ["op", "path"]);
      if (typeof record.path !== "string") throw new Error("manifest delta del path invalid");
      op = { op: "del", path: record.path };
    } else if (record.op === "git-set") {
      exactKeys(record, ["op", "repo", "section"]);
      if (typeof record.repo !== "string" || !record.section || typeof record.section !== "object" || Array.isArray(record.section)) throw new Error("manifest delta git-set invalid");
      op = { op: "git-set", repo: record.repo, section: record.section as unknown as GitSection };
    } else if (record.op === "git-del") {
      exactKeys(record, ["op", "repo"]);
      if (typeof record.repo !== "string") throw new Error("manifest delta git-del repo invalid");
      op = { op: "git-del", repo: record.repo };
    } else {
      throw new Error("manifest delta op kind invalid");
    }
    const identity = `${opFamily(op)}:${opKey(op)}`;
    if (keys.has(identity)) throw new Error("manifest delta contains a duplicate key");
    if (previous && compareOps(previous, op) >= 0) throw new Error("manifest delta ops are not canonically sorted");
    keys.add(identity);
    ops.push(op);
    previous = op;
  }
  if (canonicalJson(value) !== text) throw new Error("manifest delta body is not canonically serialized");
  return ops;
}

export async function decodeEnvelope(plaintext: Uint8Array): Promise<DecodedManifestEnvelope> {
  const prefix = utf8(MANIFEST_ENVELOPE_PREFIX);
  const magic = utf8(MANIFEST_ENVELOPE_MAGIC);
  const startsWith = (needle: Uint8Array): boolean => plaintext.length >= needle.length && needle.every((byte, index) => plaintext[index] === byte);
  if (!startsWith(magic)) {
    if (startsWith(prefix)) throw new Error("manifest envelope version not supported — upgrade rbox");
    return { kind: "raw", manifest: parseManifest(plaintext) };
  }
  const headerStart = magic.byteLength;
  const maxEnd = Math.min(plaintext.byteLength, headerStart + MAX_ENVELOPE_HEADER + 1);
  let newline = -1;
  for (let i = headerStart; i < maxEnd; i++) {
    if (plaintext[i] === 0x0a) {
      newline = i;
      break;
    }
  }
  if (newline < 0 || newline - headerStart > MAX_ENVELOPE_HEADER) throw new Error("manifest envelope header exceeds maximum size or is unterminated");
  // Strict-header contract: parseStrict rejects duplicate raw member names and
  // out-of-range numbers, and the canonical round-trip closes what a raw-token
  // scan cannot see — escaped-equivalent duplicates ("bodyBytes" beside
  // "bodyBytes" collapse under JSON.parse) and any non-canonical encoding.
  // Exactly one wire encoding of any header exists (I6's ethos applied to the
  // frame itself); writers emit canonicalJson, so honest envelopes pass.
  const headerText = decoder.decode(plaintext.subarray(headerStart, newline));
  const parsedHeader = parseStrict(headerText);
  if (canonicalJson(parsedHeader) !== headerText) throw new Error("manifest envelope header is not canonically encoded");
  const header = parseHeader(parsedHeader);
  const encodedBody = plaintext.subarray(newline + 1);
  const body = header.comp === "zstd" ? await zstdDecompressCapped(encodedBody, header.bodyBytes) : encodedBody;
  if (body.byteLength !== header.bodyBytes) throw new Error("manifest envelope body length does not match bodyBytes");
  if (header.kind === "snapshot") {
    const manifest = parseManifest(body);
    if ((await canonicalManifestHash(manifest)) !== header.manifestHash) throw new Error("snapshot manifestHash mismatch");
    return { kind: "snapshot", manifest, header };
  }
  return { kind: "delta", header, ops: parseOps(body) };
}

export function foldDelta(base: Manifest, ops: readonly ManifestDeltaOp[], header: ManifestDeltaHeader): Manifest {
  if (hashBytes(canonicalManifestBytes(base)) !== header.baseManifestHash) throw new Error("manifest delta baseManifestHash mismatch");
  const files = new Map(base.files.map((entry) => [entry.path, entry]));
  const repos = new Map(Object.entries(base.gitRepos ?? {}));
  let previous: ManifestDeltaOp | undefined;
  const seen = new Set<string>();
  for (const op of ops) {
    const identity = `${opFamily(op)}:${opKey(op)}`;
    if (seen.has(identity) || (previous && compareOps(previous, op) >= 0)) throw new Error("manifest delta ops are not canonical");
    seen.add(identity);
    previous = op;
    if (op.op === "set") {
      if (deepEqual(files.get(op.entry.path), op.entry)) throw new Error("manifest delta contains a no-op set");
      files.set(op.entry.path, op.entry);
    } else if (op.op === "del") {
      if (!files.delete(op.path)) throw new Error("manifest delta deletes an absent file key");
    } else if (op.op === "git-set") {
      if (deepEqual(repos.get(op.repo), op.section)) throw new Error("manifest delta contains a no-op git-set");
      repos.set(op.repo, op.section);
    } else if (!repos.delete(op.repo)) {
      throw new Error("manifest delta deletes an absent git key");
    }
  }
  const gitRepos = Object.fromEntries([...repos.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const result: Manifest = {
    generatedAt: header.generatedAt,
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ...(header.manifestSchema === undefined ? {} : { manifestSchema: header.manifestSchema }),
    ...(Object.keys(gitRepos).length === 0 ? {} : { gitRepos }),
  };
  if (hashBytes(canonicalManifestBytes(result)) !== header.resultHash) throw new Error("manifest delta resultHash mismatch");
  assertManifest(result);
  return result;
}
