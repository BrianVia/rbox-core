import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import {
  gitIdentityKey,
  validateGitSection,
  type GitRefTombstone,
  type GitSection,
} from "../../engine/index.js";
import { gitIncomingKey } from "./shared.js";
import { composeStateSavePacket } from "../sync-state.js";
import { stateFromRepoRecords, type SyncState } from "../config.js";
import {
  normalizeOutgoingGitSections,
  normalizePublishedGitSection,
  REF_TOMBSTONE_RETENTION_MS,
  tombstoneFindingLine,
} from "./publisher-tombstones.js";

const oid = (n: number): string => n.toString(16).padStart(40, "0");
const sha = (n: number): string => n.toString(16).padStart(64, "0");
const at = (day: number): string => new Date(Date.UTC(2026, 0, day)).toISOString();
const section = (
  refs: Record<string, string>,
  extra: Partial<GitSection> = {},
): GitSection => ({
  bundleSha: sha(1),
  bundleEncSha: sha(2),
  bundleCipherSize: 1,
  head: refs["refs/heads/main"] ? "ref: refs/heads/main" : oid(999),
  refs,
  refScope: "all",
  generatedAt: at(1),
  ...extra,
});
const entry = (n: number, generation = n, ts = at(1)): GitRefTombstone => ({ oid: oid(n), ts, generation });

describe("design 130 publisher chain and generation walk", () => {
  test("S0:Q → S1:T → S2:absent retains the complete supersession chain", () => {
    const ref = "refs/heads/topic";
    const s0 = section({ [ref]: oid(1) });
    const s1 = normalizePublishedGitSection(s0, section({ [ref]: oid(2) }), at(2)).section;
    const s2 = normalizePublishedGitSection(s1, section({}), at(3)).section;
    expect(s1.refTombstones).toEqual({ [ref]: [entry(1, 1, at(2))] });
    expect(s2.refTombstones).toEqual({ [ref]: [entry(1, 1, at(2)), entry(2, 2, at(3))] });
    expect(s2.refTombstoneGeneration).toBe(2);
  });

  test("delete/recreate and repeated rewrites refresh a duplicate under a regressing clock", () => {
    const ref = "refs/heads/topic";
    const q = section({ [ref]: oid(1) });
    const t = normalizePublishedGitSection(q, section({ [ref]: oid(2) }), at(8)).section;
    const qAgain = normalizePublishedGitSection(t, section({ [ref]: oid(1) }), at(7)).section;
    const x = normalizePublishedGitSection(qAgain, section({ [ref]: oid(3) }), at(6)).section;
    expect(x.refTombstones?.[ref]).toEqual([
      entry(2, 2, at(7)),
      entry(1, 3, at(6)),
    ]);
    expect(x.refTombstoneGeneration).toBe(3);
  });

  test("high-water persists across expiry and per-ref eviction, then allocates monotonically", () => {
    const ref = "refs/heads/topic";
    const oldEntries = Array.from({ length: 16 }, (_, index) => entry(index + 10, index + 1, at(index + 1)));
    const advertised = section({ [ref]: oid(1) }, { refTombstones: { [ref]: oldEntries }, refTombstoneGeneration: 16 });
    const evicted = normalizePublishedGitSection(advertised, section({ [ref]: oid(2) }), at(20));
    expect(evicted.section.refTombstones?.[ref]).toHaveLength(16);
    expect(evicted.section.refTombstones?.[ref]?.some((item) => item.oid === oid(10))).toBe(false);
    expect(evicted.section.refTombstoneGeneration).toBe(17);
    expect(evicted.findings).toContainEqual({ kind: "per-ref-evicted", count: 1 });

    const muchLater = new Date(Date.parse(at(20)) + REF_TOMBSTONE_RETENTION_MS + 1).toISOString();
    const expired = normalizePublishedGitSection(evicted.section, section({ [ref]: oid(2) }), muchLater);
    expect(expired.section.refTombstones).toEqual({});
    expect(expired.section.refTombstoneGeneration).toBe(17);
    const next = normalizePublishedGitSection(expired.section, section({ [ref]: oid(3) }), muchLater);
    expect(next.section.refTombstones?.[ref]?.[0]?.generation).toBe(18);
  });

  test("safe-integer overflow refuses authoring and reports the safe-direction hold risk", () => {
    const ref = "refs/heads/topic";
    const advertised = section({ [ref]: oid(1) }, { refTombstones: {}, refTombstoneGeneration: Number.MAX_SAFE_INTEGER });
    const result = normalizePublishedGitSection(advertised, section({ [ref]: oid(2) }), at(2));
    expect(result.section.refTombstones).toEqual({});
    expect(result.section.refTombstoneGeneration).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.findings).toContainEqual({ kind: "generation-overflow", count: 1 });
    expect(tombstoneFindingLine("repo", result.findings[0]!)).toContain("slow followers may hold");
  });
});

describe("design 130 all-to-all authoring and the final boundary", () => {
  test.each([
    ["pointer switch", "scoped", "scoped"],
    ["detached pointer", "scoped", "scoped"],
    ["scoped to scoped", "scoped", "scoped"],
    ["all to scoped", "all", "scoped"],
    ["scoped to all", "scoped", "all"],
  ] as const)("%s authors no tombstone", (_label, beforeScope, afterScope) => {
    const ref = "refs/heads/topic";
    const before = section({ [ref]: oid(1) }, { refScope: beforeScope });
    const after = section({ [ref]: oid(2) }, { refScope: afterScope });
    const result = normalizePublishedGitSection(before, after, at(2));
    expect(result.section.refTombstones).toEqual({});
    expect(result.section.refTombstoneGeneration).toBe(0);
  });

  test("tags and stash are never tombstoned even across all-scope deletion", () => {
    const before = section({ "refs/tags/v1": oid(1), "refs/stash": oid(2) });
    expect(normalizePublishedGitSection(before, section({}), at(2)).section.refTombstones).toEqual({});
  });

  test("PENDING is the only byte-identical exemption and normalization resumes after it drops", () => {
    const ref = "refs/heads/topic";
    const pending = section({ [ref]: oid(2) });
    const advertised = section({ [ref]: oid(1) });
    const exempt = normalizeOutgoingGitSections({ repo: pending }, { repo: pending }, { repo: advertised }, at(2));
    expect(exempt.sections.repo).toBe(pending);
    expect(JSON.stringify(exempt.sections.repo)).toBe(JSON.stringify(pending));
    expect(exempt.sections.repo?.refTombstones).toBeUndefined();
    const clonedPending = structuredClone(pending);
    const cloned = normalizeOutgoingGitSections({ repo: clonedPending }, { repo: pending }, { repo: advertised }, at(2));
    expect(cloned.sections.repo).toBe(pending);
    expect(cloned.sections.repo?.refTombstones).toBeUndefined();
    const resumed = normalizeOutgoingGitSections({ repo: pending }, {}, { repo: advertised }, at(2));
    expect(resumed.sections.repo).not.toBe(pending);
    expect(resumed.sections.repo?.refTombstones?.[ref]).toEqual([entry(1, 1, at(2))]);
  });

  test("repository cap evicts deterministically by (ts,ref,oid) and logs loudly", () => {
    const chains: Record<string, GitRefTombstone[]> = {};
    const refs: Record<string, string> = {};
    let generation = 0;
    for (let r = 0; r < 32; r++) {
      const ref = `refs/heads/r${r.toString().padStart(2, "0")}`;
      chains[ref] = Array.from({ length: 16 }, (_, index) => entry(1000 + r * 16 + index, ++generation, at(1)));
    }
    const superseded = "refs/heads/zz";
    refs[superseded] = oid(900);
    const advertised = section(refs, { refTombstones: chains, refTombstoneGeneration: generation });
    const result = normalizePublishedGitSection(advertised, section({ [superseded]: oid(901) }), at(2));
    expect(Object.values(result.section.refTombstones ?? {}).flat()).toHaveLength(512);
    expect(result.section.refTombstones?.["refs/heads/r00"]?.some((item) => item.oid === oid(1000))).toBe(false);
    expect(result.findings).toContainEqual({ kind: "repository-evicted", count: 1 });
    expect(tombstoneFindingLine("repo", result.findings.find((item) => item.kind === "repository-evicted")!)).toContain("repository cap");
  });

  test("plan.ts has one final normalizer and returns only its finalized map", async () => {
    const source = await fs.readFile(new URL("./plan.ts", import.meta.url), "utf8");
    expect(source.match(/normalizeOutgoingGitSections\s*\(/g)).toHaveLength(1);
    expect(source).toContain("gitRepos: emptyToUndef(outgoing)");
    expect(source).not.toContain("gitRepos: emptyToUndef(out),");
  });
});

describe("design 130 strict skew validation and keys", () => {
  const ref = "refs/heads/topic";
  const valid = section({ [ref]: oid(9) }, {
    refTombstones: { [ref]: [entry(1, 1, at(1)), entry(2, 2, at(2))] },
    refTombstoneGeneration: 2,
  });

  test("old fields may both be absent; a complete canonical container is accepted", () => {
    expect(validateGitSection(section({ [ref]: oid(9) })).ok).toBe(true);
    expect(validateGitSection(valid).ok).toBe(true);
    expect(validateGitSection(section({ [ref]: oid(9) }, { refTombstones: {}, refTombstoneGeneration: 9 })).ok).toBe(true);
  });

  test.each([
    ["one field missing", { refTombstones: {} }],
    ["bad container", { refTombstones: [] as never, refTombstoneGeneration: 0 }],
    ["tag key", { refTombstones: { "refs/tags/v1": [entry(1)] }, refTombstoneGeneration: 1 }],
    ["malformed branch", { refTombstones: { "refs/heads/bad..name": [entry(1)] }, refTombstoneGeneration: 1 }],
    ["bad oid", { refTombstones: { [ref]: [{ ...entry(1), oid: "bad" }] }, refTombstoneGeneration: 1 }],
    ["bad timestamp", { refTombstones: { [ref]: [{ ...entry(1), ts: "2026-01-01T00:00:00Z" }] }, refTombstoneGeneration: 1 }],
    ["unsafe generation", { refTombstones: { [ref]: [{ ...entry(1), generation: Number.MAX_SAFE_INTEGER + 1 }] }, refTombstoneGeneration: Number.MAX_SAFE_INTEGER + 1 }],
    ["duplicate oid", { refTombstones: { [ref]: [entry(1, 1), entry(1, 2)] }, refTombstoneGeneration: 2 }],
    ["decreasing generation", { refTombstones: { [ref]: [entry(1, 2), entry(2, 1)] }, refTombstoneGeneration: 2 }],
    ["high-water below max", { refTombstones: { [ref]: [entry(1, 2)] }, refTombstoneGeneration: 1 }],
    ["zero with entries", { refTombstones: { [ref]: [entry(1, 1)] }, refTombstoneGeneration: 0 }],
    ["unknown entry field", { refTombstones: { [ref]: [{ ...entry(1), extra: true }] }, refTombstoneGeneration: 1 }],
    ["empty chain", { refTombstones: { [ref]: [] }, refTombstoneGeneration: 1 }],
    ["per-ref cap", { refTombstones: { [ref]: Array.from({ length: 17 }, (_, i) => entry(i + 1, i + 1)) }, refTombstoneGeneration: 17 }],
  ] as const)("rejects %s before attestation", (_label, extra) => {
    expect(validateGitSection(section({ [ref]: oid(9) }, extra as Partial<GitSection>)).ok).toBe(false);
  });

  test("tombstones are canonical in incoming keys and excluded from live identity", () => {
    const reordered = section({ [ref]: oid(9) }, {
      refTombstones: { [ref]: [entry(2, 2, at(2)), entry(1, 1, at(1))] },
      refTombstoneGeneration: 2,
    });
    const changed = section({ [ref]: oid(9) }, {
      refTombstones: { [ref]: [entry(1, 1, at(1)), entry(3, 3, at(3))] },
      refTombstoneGeneration: 3,
    });
    expect(gitIncomingKey(reordered)).toBe(gitIncomingKey(valid));
    expect(gitIncomingKey(changed)).not.toBe(gitIncomingKey(valid));
    expect(gitIdentityKey(changed)).toBe(gitIdentityKey(valid));
  });

  test("publisher ACK stores exact advertised wire presence and absence independently of BASE", () => {
    const old = section({ [ref]: oid(1) });
    const next = section({ [ref]: oid(2) }, { refTombstones: { [ref]: [entry(1)] }, refTombstoneGeneration: 1 });
    const state: SyncState = {
      stream: "stream",
      stateNonce: "a".repeat(32),
      stateRevision: 1,
      lastSyncedSequence: 1,
      lastSyncedManifest: { generatedAt: "", files: [] },
      repoRecords: { repo: { repoGen: 1, sourceSeq: 1, base: old, advertised: old } },
    };
    const present = composeStateSavePacket(state, {
      expectedStream: state.stream,
      sourceGlobalSeq: 2,
      observedRepos: ["repo"],
      values: { bases: { repo: old }, advertised: { repo: next } },
    });
    expect(present.repos[0]?.newRecord.base).toEqual(old);
    expect(present.repos[0]?.newRecord.advertised).toEqual(next);
    const absent = composeStateSavePacket(state, {
      expectedStream: state.stream,
      sourceGlobalSeq: 2,
      observedRepos: ["repo"],
      values: { bases: { repo: old }, advertised: { repo: null }, repoAbsent: { repo: true } },
    });
    expect(absent.repos[0]?.newRecord.base).toEqual(old);
    expect(absent.repos[0]?.newRecord.advertised).toBeUndefined();
    expect(absent.repos[0]?.newRecord.repoAbsent).toBe(true);

    const projected = stateFromRepoRecords(state, {
      repo: { ...absent.repos[0]!.newRecord, repoGen: 2 },
    });
    expect(projected.lastSyncedManifest.gitRepos?.repo).toBeUndefined();
    expect(projected.repoRecords?.repo?.base).toEqual(old);
  });
});
