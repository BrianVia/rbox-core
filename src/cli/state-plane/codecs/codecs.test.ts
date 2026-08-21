import { expect, test } from "bun:test";
import type { FileEntry } from "../../../engine/index.js";
import { encodeFileEntry } from "./file-entry.js";
import { encodeRepoRecord, REPO_RECORD_COLUMN_BY_FIELD } from "./repo-record.js";
import { canonicalJson, retainedEstimate, utf16beOrderKey } from "../digest/codecs.js";

const sha = "a".repeat(64);
const entry = (path = "src/a.ts"): FileEntry => ({
  path, sha256: sha, size: 3, mode: 0o6755, mtimeMs: 1.25, type: "file",
});

test("rbox canonical JSON preserves JSON distinctions and rejects hostile JS graphs", () => {
  expect(canonicalJson({ b: null, a: {}, c: [] })).toBe('{"a":{},"b":null,"c":[]}');
  expect(canonicalJson({ value: -0 })).toBe('{"value":0}');
  const sparse = Array(2);
  sparse[1] = 1;
  expect(() => canonicalJson(sparse)).toThrow("sparse");
  expect(() => canonicalJson(new Date())).toThrow("prototype");
  expect(() => canonicalJson({ value: undefined })).toThrow("undefined");
  expect(() => canonicalJson({ value: Number.NaN })).toThrow("finite");
});

test("RetainedEstimateV1 follows the aligned frozen formula", () => {
  // object container 64 + one member 96 + key string (56+2) +
  // value scalar 32 + value string (56+2) = 308 -> 4096.
  expect(retainedEstimate({ a: "b" })).toBe(4096);
  expect(retainedEstimate([])).toBe(4096);
});

test("FileEntry exact mapping retains extensions and path ordering", () => {
  const encoded = encodeFileEntry({
    ...entry("😀/x"),
    symlinkTarget: "tolerated-on-file",
    encSha: "b".repeat(64),
    extensionNull: null,
    extensionObject: {},
    extensionArray: [],
  } as FileEntry);
  expect(encoded.extrasCjson).toBe('{"extensionArray":[],"extensionNull":null,"extensionObject":{}}');
  expect(encoded.pathOrder).toEqual(utf16beOrderKey("😀/x"));
  expect(encoded.mtimeMs).toBe(1.25);
  for (const bad of [".", "./a", "../a", "a\\b", "/a", "a//b", "a/../b"]) {
    expect(() => encodeFileEntry(entry(bad))).toThrow("safe POSIX-relative");
  }
});

test("FileEntry identity is independent from the non-unique exact fingerprint", () => {
  const first = encodeFileEntry(entry());
  const second = encodeFileEntry(entry());
  expect(first.exactFingerprint).toBe(second.exactFingerprint);
  expect(first.entryId).not.toBe(first.exactFingerprint);
  expect(second.entryId).not.toBe(first.entryId);
});

test("FileEntry validates hashes, compression joint presence, and known nulls", () => {
  expect(() => encodeFileEntry({ ...entry(), sha256: "A".repeat(64) })).toThrow("hex64");
  expect(() => encodeFileEntry({ ...entry(), comp: "zstd" })).toThrow("jointly");
  expect(() => encodeFileEntry({ ...entry(), type: "symlink" })).toThrow("symlink requires");
});

test("RepoRecord column map is total, strips resolutionIntent, and rejects known null", () => {
  expect(Object.keys(REPO_RECORD_COLUMN_BY_FIELD)).toHaveLength(19);
  const encoded = encodeRepoRecord(".", {
    repoGen: 1,
    sourceSeq: 2,
    packedRefsIdentity: { mtimeMs: 1.5 },
    extensionNull: null,
    resolutionIntent: { obsolete: true },
  } as never);
  expect(encoded.extrasCjson).toBe('{"extensionNull":null}');
  expect(() => encodeRepoRecord("repo", { repoGen: 0, sourceSeq: 0, base: null } as never)).toThrow("base");
  expect(() => encodeRepoRecord("./repo", { repoGen: 0, sourceSeq: 0 })).toThrow("POSIX-relative");
});

test("RepoRecord validates fixed nested carrier shapes before persistence", () => {
  const fixed = {
    repoGen: 1,
    sourceSeq: 2,
    packedRefsIdentity: { mtimeMs: 1.5 },
    cfgToken: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
    cfgStore: {
      repoKind: "standalone",
      commonDir: { realpath: "/repo/.git", dev: "1", ino: "2", birthtime: "3" },
    },
    resolutionReceipt: {
      repo: "repo",
      attemptedGitIncomingKey: "incoming",
      attemptedSequence: 4,
      confirmedReportHash: "report",
    },
  };
  expect(() => encodeRepoRecord("repo", fixed)).not.toThrow();
  for (const packedRefsIdentity of [5, {}, { mtimeMs: 1, extra: true }, { mtimeMs: "1" }]) {
    expect(() => encodeRepoRecord("repo", { ...fixed, packedRefsIdentity } as never)).toThrow("packedRefsIdentity");
  }
  expect(() => encodeRepoRecord("repo", {
    ...fixed, cfgToken: { dev: "1", ino: "2", size: "3", mtimeNs: "4" },
  } as never)).toThrow("cfgToken");
  expect(() => encodeRepoRecord("repo", {
    ...fixed, cfgStore: { repoKind: "standalone", commonDir: { realpath: "/repo", dev: "1", ino: "2" } },
  } as never)).toThrow("cfgStore.commonDir");
  expect(() => encodeRepoRecord("repo", {
    ...fixed,
    resolutionReceipt: {
      repo: "repo", attemptedGitIncomingKey: "incoming", attemptedSequence: 4,
    },
  } as never)).toThrow("resolutionReceipt");
  expect(() => encodeRepoRecord("repo", {
    ...fixed, resolutionReceipt: { ...fixed.resolutionReceipt, attemptedSequence: -1 },
  })).toThrow("attemptedSequence");
});
