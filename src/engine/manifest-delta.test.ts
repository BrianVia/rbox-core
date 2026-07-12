import { describe, expect, test } from "bun:test";
import { canonicalString } from "./e2ee/jcs.js";
import { buildSignedCommit, parseCommit } from "./e2ee/commit.js";
import { generateSignKeyPair } from "./e2ee/asym.js";
import { KNOWN_MANIFEST_SCHEMA } from "./manifest-validate.js";
import type { FileEntry, Manifest } from "./types.js";
import {
  MANIFEST_ENVELOPE_MAGIC,
  MAX_MANIFEST_DELTA_CHAIN,
  canonicalManifestBytes,
  canonicalManifestHash,
  decodeEnvelope,
  diffToOps,
  encodeDeltaEnvelope,
  encodeSnapshotEnvelope,
  foldDelta,
  type ManifestDeltaHeader,
} from "./manifest-delta.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const utf8 = new TextEncoder();

function entry(path: string, n = 1): FileEntry {
  return { path, sha256: n.toString(16).padStart(64, "0"), size: n, mode: 0o644, mtimeMs: 1_700_000_000_000.9016, type: "file", encSha: SHA_A };
}

function manifest(generatedAt: string, files: FileEntry[]): Manifest {
  return { generatedAt, files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

function deltaHeader(baseHash: string, resultHash: string, generatedAt: string): ManifestDeltaHeader {
  return { kind: "delta", bodyBytes: 0, baseEncSha: SHA_A, baseManifestHash: baseHash, generatedAt, resultHash };
}

describe("manifest delta envelope", () => {
  test("raw-v0 and snapshot raw/zstd round-trip", async () => {
    const m = manifest("now", [entry("a")]);
    const raw = utf8.encode(JSON.stringify(m));
    expect(await decodeEnvelope(raw)).toEqual({ kind: "raw", manifest: m });
    for (const compress of [false, true]) {
      expect(await decodeEnvelope(await encodeSnapshotEnvelope(m, { compress }))).toMatchObject({ kind: "snapshot", manifest: m });
    }
  });

  test("delta round-trips byte-exact and folds to the target", async () => {
    const base = manifest("old", [entry("a"), entry("gone", 2)]);
    const target = manifest("new", [entry("a", 3), entry("new", 4)]);
    const baseManifestHash = await canonicalManifestHash(base);
    for (const compress of [false, true]) {
      const encoded = await encodeDeltaEnvelope(base, target, { baseEncSha: SHA_A, baseManifestHash, compress });
      const decoded = await decodeEnvelope(encoded.bytes);
      expect(decoded.kind).toBe("delta");
      if (decoded.kind !== "delta") throw new Error("expected delta");
      expect(foldDelta(base, decoded.ops, decoded.header)).toEqual(target);
      expect(await canonicalManifestHash(target)).toBe(encoded.resultHash);
      if (!compress) expect(encoded.bytes).toEqual(await encodeDeltaEnvelope(base, target, { baseEncSha: SHA_A, baseManifestHash, compress }).then((v) => v.bytes));
    }
  });

  test("fails closed on unknown version, truncation, and body mismatch", async () => {
    await expect(decodeEnvelope(utf8.encode("rbox-mde2\n{}\n"))).rejects.toThrow("manifest envelope version not supported — upgrade rbox");
    await expect(decodeEnvelope(utf8.encode(MANIFEST_ENVELOPE_MAGIC))).rejects.toThrow();
    const m = manifest("now", []);
    const encoded = await encodeSnapshotEnvelope(m, { compress: false });
    await expect(decodeEnvelope(encoded.subarray(0, encoded.length - 1))).rejects.toThrow("body length");
  });

  test("rejects a newer manifest schema in the header before folding", async () => {
    const header = JSON.stringify({ kind: "delta", bodyBytes: 2, baseEncSha: SHA_A, baseManifestHash: SHA_B, generatedAt: "x", manifestSchema: KNOWN_MANIFEST_SCHEMA + 1, resultHash: SHA_C });
    await expect(decodeEnvelope(utf8.encode(`${MANIFEST_ENVELOPE_MAGIC}${header}\n[]`))).rejects.toThrow("upgrade rbox");
  });
});

test("20k-entry snapshots compress below 25% of raw JSON", async () => {
  const files = Array.from({ length: 20_000 }, (_, i) => entry(`packages/pkg-${i % 137}/src/generated/file-${i.toString().padStart(5, "0")}.ts`, i + 1));
  const m = manifest("2026-07-12T00:00:00.000Z", files);
  const rawBytes = utf8.encode(JSON.stringify(m)).byteLength;
  const envelopeBytes = (await encodeSnapshotEnvelope(m, { compress: true })).byteLength;
  const ratio = envelopeBytes / rawBytes;
  console.log(`design 84 snapshot compression ratio: ${(ratio * 100).toFixed(2)}% (${envelopeBytes}/${rawBytes})`);
  expect(ratio).toBeLessThan(0.25);
});

describe("canonical form and pure folding", () => {
  test("fractional mtimes are stable and non-finite numbers fail closed", async () => {
    const m = manifest("now", [entry("fractional")]);
    expect(canonicalManifestBytes(JSON.parse(JSON.stringify(m)) as Manifest)).toEqual(canonicalManifestBytes(m));
    expect(await canonicalManifestHash(JSON.parse(JSON.stringify(m)) as Manifest)).toBe(await canonicalManifestHash(m));
    expect(() => canonicalManifestBytes({ ...m, files: [{ ...m.files[0]!, mtimeMs: Number.NaN }] })).toThrow("finite");
    expect(() => canonicalManifestBytes({ ...m, files: [{ ...m.files[0]!, mtimeMs: Number.POSITIVE_INFINITY }] })).toThrow("finite");
  });

  test("diff emits one sorted op per changed key", () => {
    const base = manifest("old", [entry("b"), entry("c")]);
    const target = manifest("new", [entry("a"), entry("b", 2)]);
    expect(diffToOps(base, target).map((op) => (op.op === "set" ? op.entry.path : op.op === "del" ? op.path : op.repo))).toEqual(["a", "b", "c"]);
  });

  test("decode/fold reject duplicate, unsorted, noncanonical, no-op, and absent-key ops", async () => {
    const base = manifest("old", [entry("a")]);
    const target = manifest("new", [entry("b")]);
    const header = deltaHeader(await canonicalManifestHash(base), await canonicalManifestHash(target), target.generatedAt);
    const envelope = (body: string): Uint8Array =>
      utf8.encode(`${MANIFEST_ENVELOPE_MAGIC}${JSON.stringify({ ...header, bodyBytes: utf8.encode(body).byteLength })}\n${body}`);
    const setA = JSON.stringify({ entry: entry("a"), op: "set" });
    await expect(decodeEnvelope(envelope(`[${setA},${setA}]`))).rejects.toThrow("duplicate");
    const setB = JSON.stringify({ entry: entry("b"), op: "set" });
    await expect(decodeEnvelope(envelope(`[${setB},${setA}]`))).rejects.toThrow("sorted");
    await expect(decodeEnvelope(envelope(`[ ${setB}]`))).rejects.toThrow("canonically serialized");
    expect(() => foldDelta(base, [{ op: "set", entry: entry("a") }], header)).toThrow("no-op");
    expect(() => foldDelta(base, [{ op: "git-del", repo: "missing" }], header)).toThrow("absent");
  });

  test("success and failure leave the base byte-identical", async () => {
    const base = manifest("old", [entry("a")]);
    const before = JSON.stringify(base);
    const target = manifest("new", [entry("b")]);
    const header = deltaHeader(await canonicalManifestHash(base), await canonicalManifestHash(target), target.generatedAt);
    expect(foldDelta(base, diffToOps(base, target), header)).toEqual(target);
    expect(JSON.stringify(base)).toBe(before);
    expect(() => foldDelta(base, [{ op: "del", path: "absent" }], header)).toThrow("absent");
    expect(JSON.stringify(base)).toBe(before);
    expect(() => foldDelta(base, diffToOps(base, target), { ...header, resultHash: SHA_C })).toThrow("resultHash");
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("signed manifestChain compatibility", () => {
  const fields = {
    accountId: "acct",
    accountEpoch: 1,
    workspaceId: "ws",
    seq: 1,
    parentSeq: 0,
    parentCommitHash: "0".repeat(64),
    rosterVersion: 1,
    keyEpoch: 1,
    deviceId: "dev",
    encManifestSha: SHA_A,
    blobRefs: [],
  } as const;

  test("empty/absent preserves the pre-84 canonical body exactly", async () => {
    const signed = await buildSignedCommit(fields, generateSignKeyPair());
    expect(signed.body).toBe(canonicalString({
      type: "rbox/commit/v1",
      accountId: "acct",
      accountEpoch: 1,
      workspaceId: "ws",
      seq: 1,
      parentSeq: 0,
      parentCommitHash: "0".repeat(64),
      rosterVersion: 1,
      keyEpoch: 1,
      deviceId: "dev",
      encManifestSha: SHA_A,
      blobRefs: [],
    }));
    expect(parseCommit(signed).manifestChain).toEqual([]);
  });

  test("chain-bearing Phase-B body parses and malformed chains fail", async () => {
    const key = generateSignKeyPair();
    expect(parseCommit(await buildSignedCommit({ ...fields, manifestChain: [SHA_B, SHA_C] }, key)).manifestChain).toEqual([SHA_B, SHA_C]);
    await expect(buildSignedCommit({ ...fields, manifestChain: [SHA_B, SHA_B] }, key)).rejects.toThrow("manifestChain malformed");
    await expect(buildSignedCommit({ ...fields, manifestChain: [SHA_A] }, key)).rejects.toThrow("manifestChain malformed");
    await expect(buildSignedCommit({ ...fields, manifestChain: ["x"] }, key)).rejects.toThrow("manifestChain malformed");
    await expect(buildSignedCommit({ ...fields, manifestChain: Array.from({ length: MAX_MANIFEST_DELTA_CHAIN + 1 }, (_, i) => i.toString(16).padStart(64, "0")) }, key)).rejects.toThrow("manifestChain malformed");
  });
});
