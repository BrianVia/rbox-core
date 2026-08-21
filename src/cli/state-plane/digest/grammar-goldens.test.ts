/**
 * Per-distinction differentials for the two grammars U1b freezes.
 *
 * Shape: ONE base construction per grammar, then a table of variants that each
 * differ from that base in exactly ONE dimension. Every variant must move the
 * digest, and all of them together must be pairwise distinct — so omitting any
 * single framed token fails here rather than merely changing a fixture that
 * happened to vary in several dimensions at once. The base digests are pinned so a
 * grammar edit cannot pass silently.
 */
import { expect, test } from "bun:test";
import type { FileEntry, GitSection } from "../../../engine/index.js";
import type { JsonValue } from "../../../json.js";
import { carryRepoBaseProof } from "../../sync-git/base-composer.js";
import type { GitHeldAttempt, RepoRecordInput } from "../../sync-state-model.js";
import type { DeltaBinding, DeltaOp } from "../../sync-state-delta.js";
import { encodeFileEntry } from "../codecs/file-entry.js";
import { REPO_RECORD_KEYS } from "../codecs/repo-record.js";
import type { LineageSnapshot, ManifestHeader } from "../ports.js";
import { canonicalJson, domainHash } from "./codecs.js";
import { RepoTransitionDigestBuilder, type SourceStageBinding } from "./repo-transition-v1.js";
import { StageDigestBuilder, STAGE_GIT_ROLES, type StageCounts } from "./stage-semantic-v1.js";
import { StageDeltaDigestBuilder, type DeltaCounts } from "./stage-delta-v1.js";

const STAGE_ID = "1".repeat(32);
const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

function omit<T extends object, K extends keyof T>(value: T, ...keys: readonly K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) Reflect.deleteProperty(copy, key);
  return copy as Omit<T, K>;
}

/** Every variant must move the digest, and no two may collide. */
function assertAllDistinct(base: string, variants: Map<string, string>): void {
  expect([...variants].filter(([, digest]) => digest === base).map(([name]) => name)).toEqual([]);
  const all = [base, ...variants.values()];
  expect(new Set(all).size, `pairwise distinct across ${all.length} constructions`).toBe(all.length);
}

/* ------------------------------------------------------------ stage grammar */

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

const ENTRIES: FileEntry[] = [
  { path: "a/plain.txt", sha256: hex(64, 1), size: 1, mode: 0o644, mtimeMs: 1.5, type: "file" },
  { path: "b/link", sha256: hex(64, 2), size: 0, mode: 0o777, mtimeMs: 2, type: "symlink", symlinkTarget: "../a/plain.txt" },
  { path: "c/encrypted.bin", sha256: hex(64, 3), size: 4096, mode: 0o600, mtimeMs: 3.25, type: "file", encSha: hex(64, 4) },
  {
    path: "d/compressed.bin", sha256: hex(64, 5), size: 8192, mode: 0o644, mtimeMs: 4, type: "file",
    encSha: hex(64, 6), comp: "zstd", payloadSha: hex(64, 7), cipherSize: 900,
  },
] as FileEntry[];

type ExtendedGitSection = GitSection & { extensionNull?: JsonValue };
type ExtendedFileEntry = FileEntry & { ext?: JsonValue };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type OptionalFileEntryKey = "symlinkTarget" | "encSha" | "comp" | "payloadSha" | "cipherSize";

const section = (seed: number, extras: Partial<ExtendedGitSection> = {}): ExtendedGitSection => ({
  ...extras,
  bundleSha: hex(64, seed + 1), bundleEncSha: hex(64, seed + 2), bundleCipherSize: seed,
  head: hex(40, seed + 3), refs: {}, config: {}, refScope: "all",
  generatedAt: "2026-07-28T00:00:00.000Z",
} as GitSection);

type Role = "meta-wire" | "manifest-projection";

interface StageConstruction {
  stageId: string;
  plane: "base" | "local";
  header: ManifestHeader;
  entries: FileEntry[];
  roles: Role[];
  sections: Array<{ role: Role; relPath: string; section: GitSection }>;
  counts?: StageCounts;
}

const STAGE_BASE: StageConstruction = {
  stageId: STAGE_ID,
  plane: "base",
  header: HEADER,
  entries: ENTRIES,
  roles: ["meta-wire"],
  sections: [{ role: "meta-wire", relPath: "repo-a", section: section(30, { extensionNull: null }) }],
};

function stageDigest(construction: StageConstruction): string {
  const builder = new StageDigestBuilder(construction.stageId, construction.plane, construction.header);
  for (const entry of construction.entries) builder.file(encodeFileEntry(entry).canonical);
  for (const role of construction.roles) builder.declareRole(role);
  for (const row of construction.sections) builder.gitSection(row.role, row.relPath, canonicalJson(row.section));
  return builder.seal(construction.counts ?? { files: construction.entries.length, gitSections: construction.sections.length });
}

const withEntry = (index: number, patch: Partial<ExtendedFileEntry> | { remove: OptionalFileEntryKey }): StageConstruction => ({
  ...STAGE_BASE,
  entries: STAGE_BASE.entries.map((entry, at) => {
    if (at !== index) return entry;
    if ("remove" in patch) return omit(entry, patch.remove);
    return { ...entry, ...patch } as FileEntry;
  }),
});

test("stage-semantic-v1 base construction is pinned", () => {
  expect(stageDigest(STAGE_BASE)).toBe("2fc70c72d0f87834996d9305729d09f2f9720525f676f8f6672914a3a0fd77c5");
});

test("stage-semantic-v1 moves for every single dimension it frames", () => {
  const base = stageDigest(STAGE_BASE);
  const variants = new Map<string, StageConstruction>([
    ["stage id", { ...STAGE_BASE, stageId: "2".repeat(32) }],
    ["plane", { ...STAGE_BASE, plane: "local" }],
    ["header generatedAt", { ...STAGE_BASE, header: { ...HEADER, generatedAt: "2026-07-28T10:00:01.000Z" } }],
    ["header manifestSchema value", { ...STAGE_BASE, header: { ...HEADER, manifestSchema: 3 } }],
    ["header manifestSchema absent", { ...STAGE_BASE, header: omit(HEADER, "manifestSchema") }],
    ["header sourceSequence value", { ...STAGE_BASE, header: { ...HEADER, sourceSequence: 42 } }],
    ["header sourceSequence absent", { ...STAGE_BASE, header: omit(HEADER, "sourceSequence") }],
    ["header trustEpoch value", { ...STAGE_BASE, header: { ...HEADER, trustEpoch: "epoch-2" } }],
    ["header trustEpoch absent", { ...STAGE_BASE, header: omit(HEADER, "trustEpoch") }],
    ["header complete", { ...STAGE_BASE, header: { ...HEADER, complete: false } }],
    ["header extra absent", { ...STAGE_BASE, header: omit(HEADER, "extensionNull") }],
    ["header extra null to empty object", { ...STAGE_BASE, header: { ...HEADER, extensionNull: {} } }],
    ["header extra null to empty array", { ...STAGE_BASE, header: { ...HEADER, extensionNull: [] } }],
    ["header extra null to empty string", { ...STAGE_BASE, header: { ...HEADER, extensionNull: "" } }],
    ["entry path", withEntry(0, { path: "a/plain2.txt" })],
    ["entry sha256", withEntry(0, { sha256: hex(64, 99) })],
    ["entry size", withEntry(0, { size: 2 })],
    ["entry mode", withEntry(0, { mode: 0o600 })],
    ["entry mtimeMs", withEntry(0, { mtimeMs: 1.75 })],
    ["entry extra null", withEntry(0, { ext: null })],
    ["entry extra empty object", withEntry(0, { ext: {} })],
    ["entry extra empty array", withEntry(0, { ext: [] })],
    ["symlink target", withEntry(1, { symlinkTarget: "../a/other.txt" })],
    ["encSha value", withEntry(2, { encSha: hex(64, 98) })],
    ["encSha absent", withEntry(2, { remove: "encSha" })],
    ["cipherSize", withEntry(3, { cipherSize: 901 })],
    ["payloadSha", withEntry(3, { payloadSha: hex(64, 97) })],
    ["compression group absent", {
      ...STAGE_BASE,
      entries: STAGE_BASE.entries.map((entry, at) => (at === 3
        ? omit(entry, "comp", "payloadSha", "cipherSize")
        : entry)),
    }],
    ["entry order", { ...STAGE_BASE, entries: [...STAGE_BASE.entries].reverse() }],
    ["entry removed", { ...STAGE_BASE, entries: STAGE_BASE.entries.slice(1) }],
    ["second role declared empty", { ...STAGE_BASE, roles: [...STAGE_GIT_ROLES] }],
    ["every role absent", { ...STAGE_BASE, roles: [], sections: [] }],
    ["section role", { ...STAGE_BASE, sections: [{ ...STAGE_BASE.sections[0]!, role: "manifest-projection" }] }],
    ["section relPath", { ...STAGE_BASE, sections: [{ ...STAGE_BASE.sections[0]!, relPath: "repo-b" }] }],
    ["section content", { ...STAGE_BASE, sections: [{ ...STAGE_BASE.sections[0]!, section: section(31) }] }],
    ["section extra absent", { ...STAGE_BASE, sections: [{ ...STAGE_BASE.sections[0]!, section: section(30) }] }],
    ["second section", {
      ...STAGE_BASE,
      sections: [...STAGE_BASE.sections, { role: "meta-wire" as Role, relPath: "repo-b", section: section(31) }],
    }],
  ]);
  assertAllDistinct(base, new Map([...variants].map(([name, construction]) => [name, stageDigest(construction)])));
});

/* ------------------------------------------------------- transition grammar */

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
  lineageExtras: { extensionNull: null },
  manifestGitReposPresent: true,
  baseHeader: HEADER,
  localHeader: { generatedAt: "", complete: false },
};

const GLOBAL: SourceStageBinding = { stageId: "e".repeat(32), logicalDigest: hex(64, 100), physicalSha256: hex(64, 101) };
const GIT_PROOF: SourceStageBinding = { stageId: "f".repeat(32), logicalDigest: hex(64, 102), physicalSha256: hex(64, 103) };

/** Deliberately only the attempt members this grammar frames: completing the
 * record would move the digests pinned below. */
const HELD_ATTEMPT: Partial<GitHeldAttempt> = {
  incomingKey: "held", effectiveBaseIndexProjection: null, effectiveIncomingIndexProjection: null,
  incomingIndexArtifactDescriptor: "descriptor", localFingerprint: "fingerprint",
  fingerprintVersion: "v1", reflogs: [], blockers: [],
};

/** Every optional and nested `RepoRecord` member present at once, so that removing
 * any ONE of them is a single-dimension variant. */
const FULL_RECORD: RepoRecordInput = {
  sourceSeq: 41,
  base: section(20),
  advertised: section(21),
  branchBaseOrigins: {
    "refs/heads/main": { v: 1, oid: "a".repeat(40), lineageHash: "e".repeat(64), kind: "manual", episode: "1".repeat(32) },
  },
  packedRefsIdentity: { mtimeMs: 12.5 },
  pending: section(22),
  repoAbsent: true,
  removedKey: "removed",
  resolutionKey: "resolution",
  cfgSynced: "synced",
  cfgApplied: "applied",
  cfgToken: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
  cfgStore: { repoKind: "standalone", commonDir: { realpath: "/repo/.git", dev: "1", ino: "2", birthtime: "3" } },
  deferrals: { apply: { lane: "apply", deferredSince: "t0", reasonSince: "t0", lastSeen: "t1", reason: "local-commits" } },
  partial: { incomingKey: "incoming", checkoutPending: false, appliedRefs: {}, heldRefs: {}, configApplied: false },
  attempt: HELD_ATTEMPT as GitHeldAttempt,
  resolutionReceipt: { repo: "repo-a", attemptedGitIncomingKey: "key", attemptedSequence: 41, confirmedReportHash: "hash" },
  idxProj: "projection",
};

interface TransitionRowFixture {
  relPath: string;
  expectedRepoGen: number;
  record: RepoRecordInput;
  proof?: string;
  evidence: SourceStageBinding[];
}

interface TransitionConstruction {
  token: LineageSnapshot;
  bindings: SourceStageBinding[];
  globalBinding?: SourceStageBinding;
  rows: TransitionRowFixture[];
}

const TRANSITION_BASE: TransitionConstruction = {
  token: TOKEN,
  bindings: [GLOBAL, GIT_PROOF],
  globalBinding: GLOBAL,
  rows: [
    {
      relPath: "repo-a", expectedRepoGen: 0, record: FULL_RECORD,
      proof: canonicalJson(carryRepoBaseProof("lineage")), evidence: [GLOBAL],
    },
    { relPath: "repo-b", expectedRepoGen: 4, record: { sourceSeq: 41 }, evidence: [GLOBAL, GIT_PROOF] },
  ],
};

function transitionDigest(construction: TransitionConstruction): string {
  const builder = new RepoTransitionDigestBuilder(construction.token, construction.bindings, construction.globalBinding);
  for (const row of construction.rows) {
    builder.row({
      relPath: row.relPath,
      expectedRepoGen: row.expectedRepoGen,
      canonicalRecord: canonicalJson(row.record),
      canonicalBaseProof: row.proof,
      canonicalEvidenceBindings: canonicalJson({ sourceStages: row.evidence }),
    });
  }
  return builder.seal();
}

const withRecord = (patch: (record: Mutable<RepoRecordInput>) => void): TransitionConstruction => {
  const record = { ...FULL_RECORD };
  patch(record);
  return {
    ...TRANSITION_BASE,
    rows: TRANSITION_BASE.rows.map((row, at) => (at === 0 ? { ...row, record } : row)),
  };
};

test("repo-transition-v1 base construction is pinned", () => {
  expect(transitionDigest(TRANSITION_BASE)).toBe("7cd6d76bb52b57fa03f2eb717c0671098fb792141f6475adca793ed156a461ab");
});

test("repo-transition-v1 moves for every RepoRecord member it frames", () => {
  const base = transitionDigest(TRANSITION_BASE);
  const variants = new Map<string, string>();
  // Mechanically complete over the interface: dropping ANY single member of the
  // record must move the digest, and `sourceSeq` (never absent) is varied instead.
  for (const field of REPO_RECORD_KEYS) {
    if (field === "repoGen") continue;
    if (field === "sourceSeq") {
      variants.set("sourceSeq value", transitionDigest(withRecord((record) => { record.sourceSeq = 42; })));
      continue;
    }
    variants.set(`${field} absent`, transitionDigest(withRecord((record) => { Reflect.deleteProperty(record, field); })));
  }
  expect(variants.size).toBe(REPO_RECORD_KEYS.length - 1);
  assertAllDistinct(base, variants);
});

/**
 * The count tokens both grammars emit at seal time cannot be varied through the
 * builders — `seal()` refuses a count that disagrees with the rows. So these
 * reconstruct the exact framed token sequence by hand, prove the reconstruction is
 * faithful (it must equal the builder's digest), and then re-emit it with the count
 * token dropped or altered. If a builder ever stopped framing its counts, the
 * faithful reconstruction and the count-free one would agree and this fails.
 */
test("stage-semantic-v1 frames its explicit count tokens", () => {
  const emit = (tokens: (hash: ReturnType<typeof domainHash>) => void): string => {
    const hash = domainHash("stage-semantic-v1");
    tokens(hash);
    return hash.digest();
  };
  const body = (hash: ReturnType<typeof domainHash>): void => {
    hash.token("stage-id");
    hash.token(STAGE_BASE.stageId);
    hash.token("plane");
    hash.token(STAGE_BASE.plane);
    hash.token("header");
    hash.token(canonicalJson(STAGE_BASE.header));
    for (const entry of STAGE_BASE.entries) {
      hash.token("file");
      hash.token(encodeFileEntry(entry).canonical);
    }
    for (const row of STAGE_BASE.sections) {
      hash.token("git-section");
      hash.token(row.role);
      hash.token(row.relPath);
      hash.token(canonicalJson(row.section));
    }
    for (const role of STAGE_GIT_ROLES) {
      hash.token("role-present");
      hash.token(role);
      hash.token(STAGE_BASE.roles.includes(role) ? "1" : "0");
    }
  };
  const counts: StageCounts = { files: STAGE_BASE.entries.length, gitSections: STAGE_BASE.sections.length };
  const faithful = emit((hash) => {
    body(hash);
    hash.token("counts");
    hash.token(canonicalJson(counts));
  });
  expect(faithful, "reconstruction must match the builder exactly").toBe(stageDigest(STAGE_BASE));
  expect(emit(body), "counts token dropped").not.toBe(faithful);
  expect(emit((hash) => {
    body(hash);
    hash.token("counts");
    hash.token(canonicalJson({ files: counts.files + 1, gitSections: counts.gitSections }));
  }), "counts token altered").not.toBe(faithful);
});

test("repo-transition-v1 frames its explicit row-count token", () => {
  const emit = (tokens: (hash: ReturnType<typeof domainHash>) => void): string => {
    const hash = domainHash("repo-transition-v1");
    tokens(hash);
    return hash.digest();
  };
  const body = (hash: ReturnType<typeof domainHash>): void => {
    hash.token("snapshot");
    hash.token(canonicalJson(TRANSITION_BASE.token));
    hash.token("source-stages");
    hash.token(String(TRANSITION_BASE.bindings.length));
    for (const binding of TRANSITION_BASE.bindings) hash.token(canonicalJson(binding));
    hash.token("global-stage");
    hash.token(TRANSITION_BASE.globalBinding === undefined ? "0" : "1");
    if (TRANSITION_BASE.globalBinding !== undefined) hash.token(canonicalJson(TRANSITION_BASE.globalBinding));
    for (const row of TRANSITION_BASE.rows) {
      hash.token("transition");
      hash.token(row.relPath);
      hash.token(String(row.expectedRepoGen));
      hash.token(canonicalJson(row.record));
      hash.token(row.proof === undefined ? "0" : "1");
      if (row.proof !== undefined) hash.token(row.proof);
      hash.token(canonicalJson({ sourceStages: row.evidence }));
    }
  };
  const faithful = emit((hash) => {
    body(hash);
    hash.token("rows");
    hash.token(String(TRANSITION_BASE.rows.length));
  });
  expect(faithful, "reconstruction must match the builder exactly").toBe(transitionDigest(TRANSITION_BASE));
  expect(emit(body), "rows token dropped").not.toBe(faithful);
  expect(emit((hash) => {
    body(hash);
    hash.token("rows");
    hash.token(String(TRANSITION_BASE.rows.length + 1));
  }), "rows token altered").not.toBe(faithful);
});

test("repo-transition-v1 moves for every binding, evidence, row, and snapshot dimension", () => {
  const base = transitionDigest(TRANSITION_BASE);
  const [first, second] = TRANSITION_BASE.rows as [TransitionRowFixture, TransitionRowFixture];
  const variants = new Map<string, TransitionConstruction>([
    ["row relPath", { ...TRANSITION_BASE, rows: [{ ...first, relPath: "repo-z" }, second] }],
    ["row expected generation", { ...TRANSITION_BASE, rows: [{ ...first, expectedRepoGen: 9 }, second] }],
    ["row proof absent", { ...TRANSITION_BASE, rows: [omit(first, "proof"), second] }],
    ["row proof value", { ...TRANSITION_BASE, rows: [{ ...first, proof: canonicalJson(carryRepoBaseProof("other")) }, second] }],
    ["row order", { ...TRANSITION_BASE, rows: [second, first] }],
    ["row count", { ...TRANSITION_BASE, rows: [first] }],
    ["evidence binding count", { ...TRANSITION_BASE, rows: [{ ...first, evidence: [GLOBAL, GIT_PROOF] }, second] }],
    ["evidence binding order", { ...TRANSITION_BASE, rows: [first, { ...second, evidence: [GIT_PROOF, GLOBAL] }] }],
    ["evidence stageId", { ...TRANSITION_BASE, rows: [{ ...first, evidence: [{ ...GLOBAL, stageId: "9".repeat(32) }] }, second] }],
    ["evidence logicalDigest", { ...TRANSITION_BASE, rows: [{ ...first, evidence: [{ ...GLOBAL, logicalDigest: hex(64, 199) }] }, second] }],
    ["evidence physicalSha256", { ...TRANSITION_BASE, rows: [{ ...first, evidence: [{ ...GLOBAL, physicalSha256: hex(64, 198) }] }, second] }],
    ["declared binding order", { ...TRANSITION_BASE, bindings: [GIT_PROOF, GLOBAL] }],
    ["declared binding count", { ...TRANSITION_BASE, bindings: [GLOBAL] }],
    ["declared binding field", { ...TRANSITION_BASE, bindings: [{ ...GLOBAL, physicalSha256: hex(64, 197) }, GIT_PROOF] }],
    ["global binding absent", { ...TRANSITION_BASE, globalBinding: undefined }],
    ["global binding is the other stage", { ...TRANSITION_BASE, globalBinding: GIT_PROOF }],
    ["snapshot authorityId", { ...TRANSITION_BASE, token: { ...TOKEN, authorityId: "9".repeat(32) } }],
    ["snapshot lineageId", { ...TRANSITION_BASE, token: { ...TOKEN, lineageId: "9".repeat(32) } }],
    ["snapshot stream", { ...TRANSITION_BASE, token: { ...TOKEN, stream: "workspace/other" } }],
    ["snapshot nonce value", { ...TRANSITION_BASE, token: { ...TOKEN, nonce: "9".repeat(32) } }],
    ["snapshot nonce absent", { ...TRANSITION_BASE, token: omit(TOKEN, "nonce") }],
    ["snapshot stateRevision value", { ...TRANSITION_BASE, token: { ...TOKEN, stateRevision: 8 } }],
    ["snapshot stateRevision absent", { ...TRANSITION_BASE, token: omit(TOKEN, "stateRevision") }],
    ["snapshot lastSyncedSequence", { ...TRANSITION_BASE, token: { ...TOKEN, lastSyncedSequence: 42 } }],
    ["snapshot baseGeneration", { ...TRANSITION_BASE, token: { ...TOKEN, baseGeneration: 4 } }],
    ["snapshot localRevision", { ...TRANSITION_BASE, token: { ...TOKEN, localRevision: 3 } }],
    ["snapshot telemetryBindingId value", { ...TRANSITION_BASE, token: { ...TOKEN, telemetryBindingId: "9".repeat(16) } }],
    ["snapshot telemetryBindingId absent", { ...TRANSITION_BASE, token: omit(TOKEN, "telemetryBindingId") }],
    ["snapshot lineageExtras", { ...TRANSITION_BASE, token: { ...TOKEN, lineageExtras: {} } }],
    ["snapshot manifestGitReposPresent", { ...TRANSITION_BASE, token: { ...TOKEN, manifestGitReposPresent: false } }],
    ["snapshot baseHeader", { ...TRANSITION_BASE, token: { ...TOKEN, baseHeader: { ...HEADER, complete: false } } }],
    ["snapshot localHeader", { ...TRANSITION_BASE, token: { ...TOKEN, localHeader: { generatedAt: "x", complete: false } } }],
    ["snapshot manifestMeta present", {
      ...TRANSITION_BASE,
      token: {
        ...TOKEN,
        manifestMeta: {
          encManifestSha: hex(64, 1), manifestHash: hex(64, 2), accountEpoch: 1, keyEpoch: 2,
          chainBytes: 0, snapshotBytes: 1,
        },
      } as LineageSnapshot,
    }],
  ]);
  assertAllDistinct(base, new Map([...variants].map(([name, construction]) => [name, transitionDigest(construction)])));
});

/* ------------------------------------------------------------ delta grammar */

interface DeltaConstruction {
  stageId: string;
  plane: "base" | "local";
  header: ManifestHeader;
  binding: DeltaBinding;
  ops: DeltaOp[];
  counts?: DeltaCounts;
}

const DELTA_BASE: DeltaConstruction = {
  stageId: STAGE_ID,
  plane: "base",
  header: HEADER,
  binding: { nonce: "e".repeat(32), stateRevision: 7 },
  ops: [
    { kind: "upsert", entry: ENTRIES[0]! },
    { kind: "delete", path: "b/gone" },
    { kind: "upsert", entry: ENTRIES[2]! },
  ],
};

function deltaDigest(construction: DeltaConstruction): string {
  const builder = new StageDeltaDigestBuilder(construction.stageId, construction.plane, construction.header, construction.binding);
  let upserts = 0;
  let deletes = 0;
  for (const op of construction.ops) {
    if (op.kind === "upsert") {
      builder.upsert(op.entry.path, encodeFileEntry(op.entry).canonical);
      upserts++;
    } else {
      builder.delete(op.path);
      deletes++;
    }
  }
  return builder.seal(construction.counts ?? { upserts, deletes, resultFiles: 4 });
}

test("stage-delta-v1 base construction is pinned", () => {
  expect(deltaDigest(DELTA_BASE)).toBe("4f2cd5e55d94ee17695df746c334a65c3bb99578c12df4a954cd0f30ca296cba");
});

test("stage-delta-v1 moves for every dimension it frames", () => {
  const base = deltaDigest(DELTA_BASE);
  const [first, second, third] = DELTA_BASE.ops as [DeltaOp, DeltaOp, DeltaOp];
  const variants = new Map<string, DeltaConstruction>([
    ["stage id", { ...DELTA_BASE, stageId: "2".repeat(32) }],
    ["plane", { ...DELTA_BASE, plane: "local" }],
    ["header generatedAt", { ...DELTA_BASE, header: { ...HEADER, generatedAt: "2026-07-28T10:00:01.000Z" } }],
    ["header complete", { ...DELTA_BASE, header: { ...HEADER, complete: false } }],
    ["binding nonce", { ...DELTA_BASE, binding: { nonce: "f".repeat(32), stateRevision: 7 } }],
    ["binding stateRevision", { ...DELTA_BASE, binding: { nonce: "e".repeat(32), stateRevision: 8 } }],
    ["op order", { ...DELTA_BASE, ops: [second, first, third] }],
    ["op count", { ...DELTA_BASE, ops: [first, second] }],
    ["op kind", { ...DELTA_BASE, ops: [first, { kind: "upsert", entry: ENTRIES[1]! }, third] }],
    ["delete path", { ...DELTA_BASE, ops: [first, { kind: "delete", path: "b/other" }, third] }],
    ["upsert value", { ...DELTA_BASE, ops: [{ kind: "upsert", entry: { ...ENTRIES[0]!, size: 99 } }, second, third] }],
    ["resultFiles", { ...DELTA_BASE, counts: { upserts: 2, deletes: 1, resultFiles: 5 } }],
  ]);
  assertAllDistinct(base, new Map([...variants].map(([name, construction]) => [name, deltaDigest(construction)])));
});

test("stage-delta-v1 refuses counts that disagree with what it framed", () => {
  expect(() => deltaDigest({ ...DELTA_BASE, counts: { upserts: 1, deletes: 1, resultFiles: 4 } }))
    .toThrow("do not match expected");
  expect(() => deltaDigest({ ...DELTA_BASE, counts: { upserts: 2, deletes: 1, resultFiles: -1 } }))
    .toThrow("nonnegative");
});
