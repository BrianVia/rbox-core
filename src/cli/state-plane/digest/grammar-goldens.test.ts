/**
 * Golden differentials for the two grammars U1b freezes.
 *
 * A digest is only load-bearing if every distinction it claims to make is proven
 * to change it. These fixtures exercise the complete nested/optional/extras matrix
 * — absent versus JSON null versus `{}` versus `[]`, optional-presence bits,
 * empty-versus-absent Git roles, proof presence, and evidence — and pin the exact
 * hex so a grammar change cannot pass silently.
 */
import { expect, test } from "bun:test";
import type { FileEntry, GitSection } from "../../../engine/index.js";
import { carryRepoBaseProof } from "../../sync-git/base-composer.js";
import type { RepoRecordInput } from "../../sync-state-model.js";
import { encodeFileEntry } from "../codecs/file-entry.js";
import type { LineageSnapshot, ManifestHeader } from "../ports.js";
import { canonicalJson } from "./codecs.js";
import { RepoTransitionDigestBuilder, type SourceStageBinding } from "./repo-transition-v1.js";
import { StageDigestBuilder, type StageCounts } from "./stage-semantic-v1.js";

const STAGE_ID = "1".repeat(32);
const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

const HEADER: ManifestHeader = {
  generatedAt: "2026-07-28T10:00:00.000Z",
  manifestSchema: 2,
  sourceSequence: 41,
  trustEpoch: "epoch-1",
  complete: true,
  extensionNull: null,
  extensionObject: {},
  extensionArray: [],
};

/** file / symlink / encrypted / compressed, plus each extras shape. */
const ENTRIES: FileEntry[] = [
  { path: "a/plain.txt", sha256: hex(64, 1), size: 1, mode: 0o644, mtimeMs: 1.5, type: "file" },
  {
    path: "b/link", sha256: hex(64, 2), size: 0, mode: 0o777, mtimeMs: 2,
    type: "symlink", symlinkTarget: "../a/plain.txt", extensionNull: null,
  },
  {
    path: "c/encrypted.bin", sha256: hex(64, 3), size: 4096, mode: 0o600, mtimeMs: 3.25,
    type: "file", encSha: hex(64, 4), extensionObject: {},
  },
  {
    path: "d/compressed.bin", sha256: hex(64, 5), size: 8192, mode: 0o644, mtimeMs: 4,
    type: "file", encSha: hex(64, 6), comp: "zstd", payloadSha: hex(64, 7), cipherSize: 900,
    extensionArray: [],
  },
] as FileEntry[];

function section(seed: number, extras: Record<string, unknown> = {}): GitSection {
  return {
    ...extras,
    bundleSha: hex(64, seed + 1), bundleEncSha: hex(64, seed + 2), bundleCipherSize: seed,
    head: hex(40, seed + 3), refs: {}, config: {}, refScope: "all",
    generatedAt: "2026-07-28T00:00:00.000Z",
  } as GitSection;
}

const COUNTS: StageCounts = { files: ENTRIES.length, gitSections: 1 };

function stageDigest(mutate: (builder: StageDigestBuilder) => void = () => {}, counts: StageCounts = COUNTS): string {
  const builder = new StageDigestBuilder(STAGE_ID, "base", HEADER as unknown as Record<string, unknown>);
  for (const entry of ENTRIES) builder.file(encodeFileEntry(entry).canonical);
  builder.gitSection("meta-wire", "repo-a", canonicalJson(section(30, { extensionNull: null })));
  mutate(builder);
  return builder.seal(counts);
}

const TOKEN: LineageSnapshot = {
  authorityId: "a".repeat(32),
  lineageId: "b".repeat(32),
  stream: "workspace/163",
  nonce: "c".repeat(32),
  stateRevision: 7,
  lastSyncedSequence: 41,
  baseGeneration: 3,
  localRevision: 2,
  telemetryBindingId: "d".repeat(16),
  lineageExtras: { extensionNull: null, extensionObject: {}, extensionArray: [] },
  manifestGitReposPresent: true,
  baseHeader: HEADER,
  localHeader: { generatedAt: "", complete: false },
};

const BINDING: SourceStageBinding = {
  stageId: "e".repeat(32), logicalDigest: hex(64, 100), physicalSha256: hex(64, 101),
};

const RECORD: RepoRecordInput = {
  sourceSeq: 41,
  base: section(20),
  packedRefsIdentity: { mtimeMs: 12.5 },
  cfgToken: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
  extensionNull: null,
  extensionObject: {},
  extensionArray: [],
} as RepoRecordInput;

const EVIDENCE = canonicalJson({ sourceStages: [BINDING] });

function transitionDigest(
  rows: Array<{ relPath: string; expectedRepoGen: number; record: RepoRecordInput; proof: boolean }> = [
    { relPath: "repo-a", expectedRepoGen: 0, record: RECORD, proof: true },
    { relPath: "repo-b", expectedRepoGen: 4, record: { sourceSeq: 41 }, proof: false },
  ],
  token: LineageSnapshot = TOKEN,
  bindings: SourceStageBinding[] = [BINDING],
  evidence: string = EVIDENCE,
): string {
  const builder = new RepoTransitionDigestBuilder(token, bindings);
  for (const row of rows) {
    builder.row({
      relPath: row.relPath,
      expectedRepoGen: row.expectedRepoGen,
      canonicalRecord: canonicalJson(row.record),
      canonicalBaseProof: row.proof ? canonicalJson(carryRepoBaseProof("lineage")) : undefined,
      canonicalEvidenceBindings: evidence,
    });
  }
  return builder.seal();
}

test("stage-semantic-v1 golden covers the complete nested/optional/extras matrix", () => {
  expect(stageDigest()).toBe("0c22a666b8423a4542def3452f271f98ea27d52ba438361403073d0ed9f9474c");
});

test("repo-transition-v1 golden covers snapshot, bindings, proofs, and evidence", () => {
  expect(transitionDigest()).toBe("979f67902cf7e7049ef6e19f9bfb62821af20fc5ac6cb09e7b3e31ccd67bcfb8");
});

test("every stage distinction the grammar claims actually changes the digest", () => {
  const base = stageDigest();
  const distinct = new Map<string, string>([
    ["baseline", base],
    // A role that exists with zero sections is not the same as an absent role.
    ["empty manifest-projection role declared", stageDigest((builder) => builder.declareRole("manifest-projection"))],
    ["second section in the same role", stageDigest(
      (builder) => builder.gitSection("meta-wire", "repo-b", canonicalJson(section(31))),
      { files: ENTRIES.length, gitSections: 2 })],
    ["same section under the other role", stageDigest(
      (builder) => builder.gitSection("manifest-projection", "repo-a", canonicalJson(section(30, { extensionNull: null }))),
      { files: ENTRIES.length, gitSections: 2 })],
  ]);
  expect(new Set(distinct.values()).size).toBe(distinct.size);

  // Header, plane, id, counts, and every entry-level optional/extras distinction.
  const variants: Array<[string, string]> = [
    ["plane", new StageDigestBuilder(STAGE_ID, "local", HEADER as unknown as Record<string, unknown>).seal({ files: 0, gitSections: 0 })],
    ["stage id", new StageDigestBuilder("2".repeat(32), "base", HEADER as unknown as Record<string, unknown>).seal({ files: 0, gitSections: 0 })],
    ["header extras absent", new StageDigestBuilder(STAGE_ID, "base", { generatedAt: HEADER.generatedAt, complete: true }).seal({ files: 0, gitSections: 0 })],
    ["header extras null", new StageDigestBuilder(STAGE_ID, "base", { generatedAt: HEADER.generatedAt, complete: true, extensionNull: null }).seal({ files: 0, gitSections: 0 })],
    ["header extras empty object", new StageDigestBuilder(STAGE_ID, "base", { generatedAt: HEADER.generatedAt, complete: true, extensionNull: {} }).seal({ files: 0, gitSections: 0 })],
    ["header extras empty array", new StageDigestBuilder(STAGE_ID, "base", { generatedAt: HEADER.generatedAt, complete: true, extensionNull: [] }).seal({ files: 0, gitSections: 0 })],
  ];
  expect(new Set(variants.map(([, digest]) => digest)).size).toBe(variants.length);

  // Ordering is part of the grammar: the same rows in a different order differ.
  const forward = new StageDigestBuilder(STAGE_ID, "base", HEADER as unknown as Record<string, unknown>);
  const reverse = new StageDigestBuilder(STAGE_ID, "base", HEADER as unknown as Record<string, unknown>);
  for (const entry of ENTRIES) forward.file(encodeFileEntry(entry).canonical);
  for (const entry of [...ENTRIES].reverse()) reverse.file(encodeFileEntry(entry).canonical);
  const counts = { files: ENTRIES.length, gitSections: 0 };
  expect(forward.seal(counts)).not.toBe(reverse.seal(counts));
});

test("every transition distinction the grammar claims actually changes the digest", () => {
  const rows = [{ relPath: "repo-a", expectedRepoGen: 0, record: RECORD, proof: true }];
  const digests = new Map<string, string>([
    ["baseline", transitionDigest(rows)],
    ["different repository", transitionDigest([{ ...rows[0]!, relPath: "repo-z" }])],
    ["different expected generation", transitionDigest([{ ...rows[0]!, expectedRepoGen: 9 }])],
    ["proof removed", transitionDigest([{ ...rows[0]!, proof: false }])],
    ["record extras absent", transitionDigest([{ ...rows[0]!, record: { sourceSeq: 41, base: section(20), packedRefsIdentity: { mtimeMs: 12.5 }, cfgToken: RECORD.cfgToken } as RepoRecordInput }])],
    ["snapshot moved", transitionDigest(rows, { ...TOKEN, stateRevision: 8 })],
    ["snapshot nonce absent", transitionDigest(rows, (() => { const { nonce: _nonce, ...rest } = TOKEN; return rest as LineageSnapshot; })())],
    ["bindings empty", transitionDigest(rows, TOKEN, [], canonicalJson({ sourceStages: [] }))],
    ["evidence empty", transitionDigest(rows, TOKEN, [BINDING], canonicalJson({ sourceStages: [] }))],
    ["evidence names a different physical hash", transitionDigest(rows, TOKEN, [BINDING],
      canonicalJson({ sourceStages: [{ ...BINDING, physicalSha256: hex(64, 199) }] }))],
    ["row count", transitionDigest([...rows, { relPath: "repo-b", expectedRepoGen: 0, record: { sourceSeq: 1 }, proof: false }])],
  ]);
  expect(new Set(digests.values()).size).toBe(digests.size);
});

test("absent, null, empty object, and empty array stay distinct through the entry codec", () => {
  const shapes: Array<Record<string, unknown>> = [{}, { ext: null }, { ext: {} }, { ext: [] }, { ext: "" }];
  const digests = shapes.map((extras) => {
    const builder = new StageDigestBuilder(STAGE_ID, "base", HEADER as unknown as Record<string, unknown>);
    builder.file(encodeFileEntry({
      ...extras, path: "x.txt", sha256: hex(64, 1), size: 1, mode: 0o644, mtimeMs: 1, type: "file",
    } as FileEntry).canonical);
    return builder.seal({ files: 1, gitSections: 0 });
  });
  expect(new Set(digests).size).toBe(shapes.length);
});
