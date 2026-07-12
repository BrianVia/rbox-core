import { describe, expect, test } from "bun:test";
import { canonicalString } from "./e2ee/jcs.js";
import { buildSignedCommit, parseCommit } from "./e2ee/commit.js";
import { generateSignKeyPair } from "./e2ee/asym.js";
import { KNOWN_MANIFEST_SCHEMA } from "./manifest-validate.js";
import type { FileEntry, GitSection, Manifest } from "./types.js";
import {
  MANIFEST_ENVELOPE_MAGIC,
  MAX_ENVELOPE_HEADER,
  MAX_MANIFEST_DELTA_CHAIN,
  canonicalManifestBytes,
  canonicalManifestHash,
  canonicalManifestHashStreaming,
  decodeEnvelope,
  diffToOps,
  encodeDeltaEnvelope,
  encodeSnapshotEnvelope,
  foldDelta,
  type ManifestDeltaHeader,
} from "./manifest-delta.js";
import { hashBytes } from "./hash.js";

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
      expect(await decodeEnvelope((await encodeSnapshotEnvelope(m, { compress })).bytes)).toMatchObject({ kind: "snapshot", manifest: m });
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
    const { bytes: encoded } = await encodeSnapshotEnvelope(m, { compress: false });
    await expect(decodeEnvelope(encoded.subarray(0, encoded.length - 1))).rejects.toThrow("body length");
  });

  test("enforces the envelope-header boundary exactly", async () => {
    const atLimit = utf8.encode(`${MANIFEST_ENVELOPE_MAGIC}${" ".repeat(MAX_ENVELOPE_HEADER)}\n`);
    await expect(decodeEnvelope(atLimit)).rejects.toThrow(/JSON|header/);
    await expect(decodeEnvelope(utf8.encode(`${MANIFEST_ENVELOPE_MAGIC}${" ".repeat(MAX_ENVELOPE_HEADER + 1)}\n`)))
      .rejects.toThrow("manifest envelope header exceeds maximum size");
  });

  test("zstd expansion must equal bodyBytes, including either one-byte mismatch", async () => {
    const { bytes: encoded } = await encodeSnapshotEnvelope(manifest("zstd", [entry("a")]), { compress: true });
    const newline = encoded.indexOf(0x0a, utf8.encode(MANIFEST_ENVELOPE_MAGIC).byteLength);
    const headerStart = utf8.encode(MANIFEST_ENVELOPE_MAGIC).byteLength;
    const header = JSON.parse(new TextDecoder().decode(encoded.subarray(headerStart, newline))) as Record<string, unknown>;
    const body = encoded.subarray(newline + 1);
    const assemble = (bodyBytes: number): Uint8Array => {
      const prefix = utf8.encode(`${MANIFEST_ENVELOPE_MAGIC}${JSON.stringify({ ...header, bodyBytes })}\n`);
      const out = new Uint8Array(prefix.byteLength + body.byteLength);
      out.set(prefix);
      out.set(body, prefix.byteLength);
      return out;
    };
    await expect(decodeEnvelope(assemble((header.bodyBytes as number) - 1))).rejects.toThrow();
    await expect(decodeEnvelope(assemble((header.bodyBytes as number) + 1))).rejects.toThrow("body length does not match bodyBytes");
  });

  test("rejects a newer manifest schema in the header before folding", async () => {
    // keys inserted in canonical (sorted) order — the header must pass the round-trip gate to reach the schema check
    const header = JSON.stringify({ baseEncSha: SHA_A, baseManifestHash: SHA_B, bodyBytes: 2, generatedAt: "x", kind: "delta", manifestSchema: KNOWN_MANIFEST_SCHEMA + 1, resultHash: SHA_C });
    await expect(decodeEnvelope(utf8.encode(`${MANIFEST_ENVELOPE_MAGIC}${header}\n[]`))).rejects.toThrow("upgrade rbox");
  });
});

test("20k-entry snapshots compress below 25% of raw JSON", async () => {
  const files = Array.from({ length: 20_000 }, (_, i) => entry(`packages/pkg-${i % 137}/src/generated/file-${i.toString().padStart(5, "0")}.ts`, i + 1));
  const m = manifest("2026-07-12T00:00:00.000Z", files);
  const rawBytes = utf8.encode(JSON.stringify(m)).byteLength;
  const envelopeBytes = (await encodeSnapshotEnvelope(m, { compress: true })).bytes.byteLength;
  const ratio = envelopeBytes / rawBytes;
  console.log(`design 84 snapshot compression ratio: ${(ratio * 100).toFixed(2)}% (${envelopeBytes}/${rawBytes})`);
  expect(ratio).toBeLessThan(0.25);
});

describe("canonical form and pure folding", () => {
  test("streaming canonical hashes equal reference bytes across fuzzed manifests", () => {
    let seed = 0x84d106;
    const next = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let iteration = 0; iteration < 100; iteration++) {
      const count = 1 + next() % 12;
      const files = Array.from({ length: count }, (_, index): FileEntry => ({
        ...entry(`unicode/${iteration}-${index}-${index % 3 === 0 ? "😀" : "é"}`, next()),
        mtimeMs: 1_700_000_000_000 + (next() % 10_000) / 7,
        ...(index % 4 === 0 ? { encSha: next().toString(16).padStart(64, "0"), comp: "zstd" as const,
          payloadSha: (next() + 1).toString(16).padStart(64, "0"), cipherSize: 17 + next() % 1000 } : {}),
      })).sort((a, b) => a.path.localeCompare(b.path));
      const gitSection: GitSection = {
        bundleSha: SHA_A, bundleEncSha: SHA_B, bundleCipherSize: 123,
        packChain: [{ sha: SHA_B, encSha: SHA_C, cipherSize: 45, tips: ["1".repeat(40), "2".repeat(40)] }],
        head: "ref: refs/heads/μ-main", refs: { "refs/heads/μ-main": "3".repeat(40) },
        opState: { "rebase-merge/onto": { sha: SHA_C, encSha: SHA_A, cipherSize: 12 } },
        config: { "remote.origin.fetch": ["+refs/heads/*:refs/remotes/origin/*"] },
        refScope: "all", generatedAt: `git-${iteration}-😀`,
      };
      const m: Manifest = {
        generatedAt: `fuzz-${iteration}-${iteration % 2 ? "λ" : "😀"}`,
        files,
        ...(iteration % 2 === 0 ? { manifestSchema: 4 } : {}),
        ...(iteration % 3 === 0 ? { gitRepos: { [`repo-${iteration}-é`]: gitSection } } : {}),
      };
      expect(canonicalManifestHashStreaming(m)).toBe(hashBytes(canonicalManifestBytes(m)));
    }
    const badValue = { generatedAt: "bad-\ud800", files: [] } as Manifest;
    const badKey = { generatedAt: "bad", files: [], gitRepos: { "bad-\udfff": {} } } as unknown as Manifest;
    const hiddenBadKey = { generatedAt: "bad", files: [], ["bad-\ud800"]: undefined } as unknown as Manifest;
    for (const bad of [badValue, badKey, hiddenBadKey]) {
      expect(() => canonicalManifestBytes(bad)).toThrow("well-formed Unicode");
      expect(() => canonicalManifestHashStreaming(bad)).toThrow("well-formed Unicode");
    }
  });

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
      utf8.encode(`${MANIFEST_ENVELOPE_MAGIC}${JSON.stringify(Object.fromEntries(Object.entries({ ...header, bodyBytes: utf8.encode(body).byteLength }).sort(([a], [b]) => (a < b ? -1 : 1))))}\n${body}`);
    const setA = JSON.stringify({ entry: entry("a"), op: "set" });
    await expect(decodeEnvelope(envelope(`[${setA},${setA}]`))).rejects.toThrow("duplicate");
    const setB = JSON.stringify({ entry: entry("b"), op: "set" });
    await expect(decodeEnvelope(envelope(`[${setB},${setA}]`))).rejects.toThrow("sorted");
    await expect(decodeEnvelope(envelope(`[ ${setB}]`))).rejects.toThrow("canonically serialized");
    const duplicateMember = `[{"entry":${JSON.stringify(entry("b"))},"op":"set","op":"set"}]`;
    await expect(decodeEnvelope(envelope(duplicateMember))).rejects.toThrow();
    expect(() => foldDelta(base, [{ op: "set", entry: entry("a") }], header)).toThrow("no-op");
    expect(() => foldDelta(base, [{ op: "git-del", repo: "missing" }], header)).toThrow("absent");
  });

  test("success and failure leave the base byte-identical", async () => {
    const base = manifest("old", [entry("a")]);
    const before = JSON.stringify(base);
    const target = manifest("new", [entry("b")]);
    const header = deltaHeader(await canonicalManifestHash(base), await canonicalManifestHash(target), target.generatedAt);
    expect(foldDelta(base, diffToOps(base, target), header)).toEqual(target);
    expect(foldDelta(base, diffToOps(base, target), header, header.baseManifestHash)).toEqual(target);
    expect(foldDelta(base, diffToOps(base, target), header, SHA_C)).toEqual(target);
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

describe("review round-2 protocol boundary hardening", () => {
  test("lone UTF-16 surrogates fail canonicalization closed (RFC 8785 posture)", async () => {
    const m = manifest("now", [{ ...entry("a"), path: "bad-\ud800-path" }]);
    expect(() => canonicalManifestHash(m)).toThrow("well-formed Unicode");
    await expect(encodeSnapshotEnvelope(m, { compress: false })).rejects.toThrow();
    // well-formed astral-plane strings still hash fine
    await expect(canonicalManifestHash(manifest("now", [{ ...entry("a"), path: "ok-\u{1F600}" }]))).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  test("duplicate envelope-header members are rejected, including __proto__", async () => {
    const m = manifest("dup", [entry("a")]);
    const { bytes: encoded } = await encodeSnapshotEnvelope(m, { compress: false });
    const magicLen = utf8.encode(MANIFEST_ENVELOPE_MAGIC).byteLength;
    const newline = encoded.indexOf(0x0a, magicLen);
    const header = new TextDecoder().decode(encoded.subarray(magicLen, newline));
    const body = encoded.subarray(newline + 1);
    const reframe = (headerText: string): Uint8Array => {
      const prefix = utf8.encode(`${MANIFEST_ENVELOPE_MAGIC}${headerText}\n`);
      const out = new Uint8Array(prefix.byteLength + body.byteLength);
      out.set(prefix);
      out.set(body, prefix.byteLength);
      return out;
    };
    // duplicate a real member (last-wins under JSON.parse would silently change bodyBytes)
    const dupBody = header.replace("{", `{"bodyBytes":1,`);
    await expect(decodeEnvelope(reframe(dupBody))).rejects.toThrow(/duplicate/);
    // __proto__ smuggling: rejected as an unknown header member
    const protoHeader = header.replace("{", `{"__proto__":{"comp":"zstd"},`);
    await expect(decodeEnvelope(reframe(protoHeader))).rejects.toThrow();
  });

  test("escaped-equivalent duplicate header members and non-canonical encodings are rejected", async () => {
    const m = manifest("esc", [entry("a")]);
    const { bytes: encoded } = await encodeSnapshotEnvelope(m, { compress: false });
    const magicLen = utf8.encode(MANIFEST_ENVELOPE_MAGIC).byteLength;
    const newline = encoded.indexOf(0x0a, magicLen);
    const header = new TextDecoder().decode(encoded.subarray(magicLen, newline));
    const body = encoded.subarray(newline + 1);
    const reframe = (headerText: string): Uint8Array => {
      const prefix = utf8.encode(`${MANIFEST_ENVELOPE_MAGIC}${headerText}\n`);
      const out = new Uint8Array(prefix.byteLength + body.byteLength);
      out.set(prefix);
      out.set(body, prefix.byteLength);
      return out;
    };
    // "\u0062odyBytes" decodes to "bodyBytes": raw-token duplicate scan can't see
    // it, but the canonical round-trip rejects the non-canonical escape spelling.
    const escapedDup = header.replace("{", `{"\\u0062odyBytes":1,`);
    await expect(decodeEnvelope(reframe(escapedDup))).rejects.toThrow(/canonically encoded|duplicate/);
    // whitespace / key-order deviations are equally non-canonical
    await expect(decodeEnvelope(reframe(` ${header}`))).rejects.toThrow("canonically encoded");
  });

  test("lone surrogate in an object member NAME fails canonicalization closed", () => {
    const m = { generatedAt: "now", files: [], gitRepos: { "repo-\ud800": {} } } as unknown as Manifest;
    expect(() => canonicalManifestBytes(m)).toThrow("well-formed Unicode");
  });
});
