import { createHash } from "node:crypto";
import { zstdCompress, zstdDecompressCapped } from "./crypto.js";
import { KNOWN_MANIFEST_SCHEMA, validateManifest } from "./manifest-validate.js";
import type { FileEntry, GitSection, Manifest } from "./types.js";
import { parseStrict } from "./e2ee/jcs.js";
import { utf8 } from "./e2ee/primitives.js";
export { MAX_MANIFEST_DELTA_CHAIN } from "./manifest-chain.js";

export const MANIFEST_ENVELOPE_MAGIC = "rbox-mde1\n";
export const MANIFEST_ENVELOPE_PREFIX = "rbox-mde";
export const MAX_ENVELOPE_HEADER = 64 * 1024;
export const MAX_MANIFEST_PLAINTEXT = 512 * 1024 * 1024;

const SHA_RE = /^[0-9a-f]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

type CanonicalManifestValue = null | boolean | number | string | undefined | CanonicalManifestValue[] | CanonicalManifestObject;
interface CanonicalManifestObject { [key: string]: CanonicalManifestValue; }

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

/** Everything this codec canonicalizes: the manifest domain records it writes,
 *  and the decoded JSON it reads back for the byte-for-byte round trip. */
type CanonicalInput =
  | CanonicalManifestValue
  | Manifest
  | FileEntry
  | GitSection
  | ManifestDeltaOp
  | ManifestDeltaOp[]
  | ManifestDeltaHeader
  | ManifestSnapshotHeader;

function canonicalJson(value: CanonicalInput): string {
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
      const object = value as CanonicalManifestObject;
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

const PREFIX_BYTES = utf8(MANIFEST_ENVELOPE_PREFIX);
const MAGIC_BYTES = utf8(MANIFEST_ENVELOPE_MAGIC);

const startsWithBytes = (haystack: Uint8Array, needle: Uint8Array): boolean =>
  haystack.length >= needle.length && needle.every((byte, index) => haystack[index] === byte);

/** Does this decrypted plaintext claim the rbox-mde envelope FAMILY (any
 *  version), vs raw-v0 JSON? The codec's own discrimination step 1-2; exported
 *  so error-classification at the read boundary shares the same notion. */
export function hasEnvelopePrefix(plaintext: Uint8Array): boolean {
  return startsWithBytes(plaintext, PREFIX_BYTES);
}

export function canonicalManifestBytes(manifest: Manifest): Uint8Array {
  return utf8(canonicalJson(manifest));
}

/** JSON.stringify's two-character escape spellings (the reference serializer
 *  delegates to JSON.stringify; the streaming emitter must match them). */
type JsonEscapeTable = Record<number, string>;
const STRING_ESCAPES: JsonEscapeTable = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r", 34: '\\"', 92: "\\\\" };

/** SHA-256 the canonical manifest token stream without materializing it. */
export function canonicalManifestHashStreaming(manifest: Manifest): string {
  const hash = createHash("sha256");
  const chunkChars = 64 * 1024;
  let pending = "";
  const flush = (): void => {
    if (pending.length > 0) {
      hash.update(pending, "utf8");
      pending = "";
    }
  };
  const write = (text: string): void => {
    let offset = 0;
    while (offset < text.length) {
      let take = Math.min(chunkChars - pending.length, text.length - offset);
      // Hash.update encodes each string independently. Never split a valid UTF-16
      // surrogate pair across updates or UTF-8 replacement bytes would differ.
      if (take > 0 && offset + take < text.length) {
        const last = text.charCodeAt(offset + take - 1);
        if (last >= 0xd800 && last <= 0xdbff) take--;
      }
      if (take === 0) {
        flush();
        continue;
      }
      pending += text.slice(offset, offset + take);
      offset += take;
      if (pending.length >= chunkChars) flush();
    }
  };
  const writeJsonString = (value: string): void => {
    if (!isWellFormedUtf16(value)) throw new Error("manifest canonicalization requires well-formed Unicode strings");
    write('"');
    let runStart = 0;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      const escaped = STRING_ESCAPES[code] ?? (code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : undefined);
      if (escaped === undefined) continue;
      if (runStart < index) write(value.slice(runStart, index));
      write(escaped);
      runStart = index + 1;
    }
    if (runStart < value.length) write(value.slice(runStart));
    write('"');
  };
  const emit = (value: CanonicalInput): void => {
    if (value === null) return write("null");
    switch (typeof value) {
      case "boolean":
        return write(JSON.stringify(value));
      case "string":
        return writeJsonString(value);
      case "number":
        if (!Number.isFinite(value)) throw new Error("manifest canonicalization requires finite numbers");
        return write(JSON.stringify(value));
      case "object": {
        if (Array.isArray(value)) {
          write("[");
          value.forEach((item, index) => {
            if (index > 0) write(",");
            emit(item);
          });
          return write("]");
        }
        const object = value as CanonicalManifestObject;
        write("{");
        let first = true;
        for (const key of Object.keys(object).sort()) {
          // The reference canonicalizer validates member names before omitting
          // undefined values, so an invalid hidden key must still fail closed.
          if (!isWellFormedUtf16(key)) throw new Error("manifest canonicalization requires well-formed Unicode strings");
          if (object[key] === undefined) continue;
          if (!first) write(",");
          first = false;
          writeJsonString(key);
          write(":");
          // The only unbounded member is the top-level `files` array; per-entry
          // reference serialization keeps the streaming bound (each entry is
          // small) while staying byte-identical for ANY entry shape —
          // `canonicalJson` IS the reference, so this special case cannot drift.
          if (value === manifest && key === "files" && Array.isArray(object[key])) {
            write("[");
            (object[key] as CanonicalManifestValue[]).forEach((entry, index) => {
              if (index > 0) write(",");
              write(canonicalJson(entry));
            });
            write("]");
          } else emit(object[key]);
        }
        return write("}");
      }
      default:
        throw new Error(`manifest canonicalization does not support ${typeof value}`);
    }
  };
  emit(manifest);
  flush();
  return hash.digest("hex");
}

export function canonicalManifestHash(manifest: Manifest): Promise<string> {
  return Promise.resolve(canonicalManifestHashStreaming(manifest));
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

function deepEqual(a: CanonicalInput | undefined, b: CanonicalInput | undefined): boolean {
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

/** The full FileEntry key set. A structural compare over these flat fields is
 *  the delta-encode hot path (runs per entry per commit); entries carrying any
 *  OTHER key (a future schema) fall back to the canonical deep compare so a
 *  new field can never be silently dropped from a delta. */
const FILE_ENTRY_KEYS = ["path", "sha256", "size", "mode", "mtimeMs", "type", "symlinkTarget", "encSha", "comp", "payloadSha", "cipherSize"] as const;
const FILE_ENTRY_KEY_SET: ReadonlySet<string> = new Set(FILE_ENTRY_KEYS);

function fileEntryEqual(a: FileEntry | undefined, b: FileEntry): boolean {
  if (a === undefined) return false;
  const known = (e: FileEntry): boolean => Object.keys(e).every((k) => FILE_ENTRY_KEY_SET.has(k));
  if (!known(a) || !known(b)) return deepEqual(a, b);
  return FILE_ENTRY_KEYS.every((k) => a[k] === b[k]);
}

export function diffToOps(base: Manifest, target: Manifest): ManifestDeltaOp[] {
  const ops: ManifestDeltaOp[] = [];
  const baseFiles = new Map(base.files.map((entry) => [entry.path, entry]));
  const targetFiles = new Map(target.files.map((entry) => [entry.path, entry]));
  for (const [path, entry] of targetFiles) {
    if (!fileEntryEqual(baseFiles.get(path), entry)) ops.push({ op: "set", entry });
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

/** Returns the envelope bytes AND the canonical hash it stamped — the O(N)
 *  canonicalize+hash over a large manifest is the dominant CPU of a snapshot
 *  commit, so callers building GlobalManifestMeta reuse it instead of
 *  recomputing (mirrors encodeDeltaEnvelope's resultHash). */
export async function encodeSnapshotEnvelope(manifest: Manifest, options: { compress: boolean }): Promise<{ bytes: Uint8Array; manifestHash: string }> {
  assertManifest(manifest);
  const plaintext = utf8(JSON.stringify(manifest));
  assertBodyBound(plaintext);
  const manifestHash = canonicalManifestHashStreaming(manifest);
  const header: ManifestSnapshotHeader = {
    kind: "snapshot",
    ...(options.compress ? { comp: "zstd" as const } : {}),
    bodyBytes: plaintext.byteLength,
    manifestHash,
  };
  return { bytes: await frameEnvelope(header, options.compress ? await zstdCompress(plaintext) : plaintext), manifestHash };
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
  const resultHash = canonicalManifestHashStreaming(target);
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

function exactKeys(value: object, required: readonly string[], optional: readonly string[] = []): void {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (actual.some((key) => !allowed.has(key)) || required.some((key) => !actual.includes(key))) throw new Error("manifest envelope header has unknown or missing fields");
}

interface ManifestEnvelopeHeaderCandidate {
  kind?: string;
  comp?: string;
  bodyBytes?: number;
  manifestHash?: string;
  baseEncSha?: string;
  baseManifestHash?: string;
  generatedAt?: string;
  manifestSchema?: number;
  resultHash?: string;
}

function validateCommonHeader(record: ManifestEnvelopeHeaderCandidate): void {
  if (!Number.isSafeInteger(record.bodyBytes) || (record.bodyBytes as number) < 0 || (record.bodyBytes as number) > MAX_MANIFEST_PLAINTEXT) {
    throw new Error("manifest envelope bodyBytes invalid");
  }
  if (record.comp !== undefined && record.comp !== "zstd") throw new Error("manifest envelope compression invalid");
}

function parseHeader(value: CanonicalManifestValue): ManifestSnapshotHeader | ManifestDeltaHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest envelope header must be an object");
  const record = value as ManifestEnvelopeHeaderCandidate;
  validateCommonHeader(record);
  if (record.kind === "snapshot") {
    exactKeys(record, ["kind", "bodyBytes", "manifestHash"], ["comp"]);
    if ("comp" in record && record.comp === undefined) throw new Error("manifest envelope header has unknown or missing fields");
    if (typeof record.manifestHash !== "string" || !SHA_RE.test(record.manifestHash)) throw new Error("snapshot manifestHash malformed");
    return { kind: "snapshot", ...(record.comp === "zstd" ? { comp: record.comp } : {}), bodyBytes: record.bodyBytes!, manifestHash: record.manifestHash };
  }
  if (record.kind === "delta") {
    exactKeys(record, ["kind", "bodyBytes", "baseEncSha", "baseManifestHash", "generatedAt", "resultHash"], ["comp", "manifestSchema"]);
    if (("comp" in record && record.comp === undefined) || ("manifestSchema" in record && record.manifestSchema === undefined)) throw new Error("manifest envelope header has unknown or missing fields");
    for (const key of ["baseEncSha", "baseManifestHash", "resultHash"] as const) {
      if (typeof record[key] !== "string" || !SHA_RE.test(record[key])) throw new Error(`delta ${key} malformed`);
    }
    if (typeof record.generatedAt !== "string" || record.generatedAt.length === 0) throw new Error("delta generatedAt invalid");
    if (record.manifestSchema !== undefined && (!Number.isSafeInteger(record.manifestSchema) || (record.manifestSchema as number) < 1 || (record.manifestSchema as number) > KNOWN_MANIFEST_SCHEMA)) {
      throw new Error("manifest schema is newer than this rbox supports — upgrade rbox");
    }
    return {
      kind: "delta",
      ...(record.comp === "zstd" ? { comp: record.comp } : {}),
      bodyBytes: record.bodyBytes!,
      baseEncSha: record.baseEncSha!,
      baseManifestHash: record.baseManifestHash!,
      generatedAt: record.generatedAt,
      ...(record.manifestSchema === undefined ? {} : { manifestSchema: record.manifestSchema }),
      resultHash: record.resultHash!,
    };
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
    const record = item as { op?: string; entry?: Partial<FileEntry>; path?: string; repo?: string; section?: Partial<GitSection> };
    let op: ManifestDeltaOp;
    if (record.op === "set") {
      exactKeys(record, ["op", "entry"]);
      if (!record.entry || typeof record.entry !== "object" || Array.isArray(record.entry) || typeof record.entry.path !== "string") throw new Error("manifest delta set entry invalid");
      op = { op: "set", entry: record.entry as FileEntry };
    } else if (record.op === "del") {
      exactKeys(record, ["op", "path"]);
      if (typeof record.path !== "string") throw new Error("manifest delta del path invalid");
      op = { op: "del", path: record.path };
    } else if (record.op === "git-set") {
      exactKeys(record, ["op", "repo", "section"]);
      if (typeof record.repo !== "string" || !record.section || typeof record.section !== "object" || Array.isArray(record.section)) throw new Error("manifest delta git-set invalid");
      op = { op: "git-set", repo: record.repo, section: record.section as GitSection };
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
  if (!startsWithBytes(plaintext, MAGIC_BYTES)) {
    if (hasEnvelopePrefix(plaintext)) throw new Error("manifest envelope version not supported — upgrade rbox");
    return { kind: "raw", manifest: parseManifest(plaintext) };
  }
  const headerStart = MAGIC_BYTES.byteLength;
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
  const parsedHeader = parseStrict(headerText) as CanonicalManifestValue;
  if (canonicalJson(parsedHeader) !== headerText) throw new Error("manifest envelope header is not canonically encoded");
  const header = parseHeader(parsedHeader);
  const encodedBody = plaintext.subarray(newline + 1);
  const body = header.comp === "zstd" ? await zstdDecompressCapped(encodedBody, header.bodyBytes) : encodedBody;
  if (body.byteLength !== header.bodyBytes) throw new Error("manifest envelope body length does not match bodyBytes");
  if (header.kind === "snapshot") {
    const manifest = parseManifest(body);
    if (canonicalManifestHashStreaming(manifest) !== header.manifestHash) throw new Error("snapshot manifestHash mismatch");
    return { kind: "snapshot", manifest, header };
  }
  return { kind: "delta", header, ops: parseOps(body) };
}

export function foldDelta(base: Manifest, ops: readonly ManifestDeltaOp[], header: ManifestDeltaHeader, trustedBaseHash?: string): Manifest {
  if (trustedBaseHash !== header.baseManifestHash && canonicalManifestHashStreaming(base) !== header.baseManifestHash) {
    throw new Error("manifest delta baseManifestHash mismatch");
  }
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
  if (canonicalManifestHashStreaming(result) !== header.resultHash) throw new Error("manifest delta resultHash mismatch");
  assertManifest(result);
  return result;
}
