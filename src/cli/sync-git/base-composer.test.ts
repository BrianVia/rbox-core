import { describe, expect, test } from "bun:test";
import type { GitSection } from "../../engine/index.js";
import {
  composeRepoBase,
  type BranchTransitionWitness,
  type ComposeRepoBaseAuthority,
  type RepoBaseLockedProof,
  type SafeRefWitness,
} from "./base-composer.js";
import { migrationRepoBaseProof } from "../state-plane/migration/base-proof.js";

const L = "1".repeat(40);
const N = "2".repeat(40);
const U = "3".repeat(40);
const T0 = "4".repeat(40);
const T1 = "5".repeat(40);
const LIN = "a".repeat(64);
const REPO = "b".repeat(64);
const P_OID = "c".repeat(40);

const section = (refs: Record<string, string>, id = "old"): GitSection => ({
  bundleSha: id.padEnd(64, "0").slice(0, 64),
  bundleEncSha: id.padEnd(64, "1").slice(0, 64),
  bundleCipherSize: id.length,
  bundleComp: "zstd",
  bundlePayloadSha: id.padEnd(64, "2").slice(0, 64),
  packChain: [{ sha: "d".repeat(64), encSha: "e".repeat(64), cipherSize: 7, tips: [L] }],
  head: `ref: refs/heads/main`,
  refs,
  refTombstones: { "refs/heads/old": [{ oid: L, ts: "2026-01-01T00:00:00.000Z", generation: id.length }] },
  refTombstoneGeneration: id.length,
  indexSha: "f".repeat(64),
  indexEncSha: "0".repeat(64),
  indexCipherSize: 8,
  indexTree: L,
  opState: {},
  config: { "core.ignorecase": ["false"] },
  refScope: "all",
  generatedAt: id,
});

const locked = (overrides: Partial<RepoBaseLockedProof> = {}): RepoBaseLockedProof => ({
  repoKind: "dir",
  effectiveRefScope: "all",
  checkoutComplete: true,
  incomingKey: "incoming",
  branches: {},
  safeRefs: {},
  ...overrides,
});

const present = (ref: string, priorOid: string | null, nextOid: string): Extract<BranchTransitionWitness, { kind: "present" }> => ({
  kind: "present", ref, priorOid, nextOid, lineageHash: LIN, repositoryIdentityHash: REPO,
  artifactRef: `refs/rbox-local/base-present/v2/${LIN}/hash`, artifactOid: P_OID, episode: "1".repeat(32),
});
const absent = (ref: string, priorOid: string): Extract<BranchTransitionWitness, { kind: "absent" }> => ({
  kind: "absent", ref, priorOid, lineageHash: LIN, repositoryIdentityHash: REPO,
  artifactRef: `refs/rbox-local/base-absent/v2/${LIN}/hash`, artifactOid: P_OID, source: "a",
});
const pull = (branchWitnesses: Record<string, BranchTransitionWitness> = {}, safeRefWitnesses: Record<string, SafeRefWitness> = {}): ComposeRepoBaseAuthority => ({
  kind: "pull-ref-transaction", lineageHash: LIN, repositoryIdentityHash: REPO, incomingKey: "incoming",
  branchWitnesses, safeRefWitnesses,
});
const lockedBranch = (witness: BranchTransitionWitness) => ({
  liveOid: witness.kind === "present" ? witness.nextOid : null,
  witness,
  ...(witness.kind === "present" ? { reflogEpisode: witness.episode } : {}),
  artifactsClear: true,
  ownershipStable: true,
  reflogStable: true,
  currentRef: false,
  siblingOwned: false,
});

describe("design 130 mandatory BASE composer", () => {
  test("closed authority union has exactly all seven members", () => {
    const kinds = [
      "pull-ref-transaction", "pull-carry", "journal-recovery", "publisher-ack", "manual", "p-repair", "migration",
    ] as const satisfies readonly ComposeRepoBaseAuthority["kind"][];
    const exhaustive: Record<ComposeRepoBaseAuthority["kind"], true> = Object.fromEntries(kinds.map((kind) => [kind, true])) as never;
    expect(Object.keys(exhaustive).sort()).toEqual([...kinds].sort());
  });

  test("branch cross-product: same retains provenance, P changes, A removes, missing proof holds", () => {
    const main = "refs/heads/main";
    const side = "refs/heads/side";
    const add = "refs/heads/add";
    const pMain = present(main, L, N);
    const aSide = absent(side, U);
    const pAdd = present(add, null, U);
    const previous = {
      base: section({ [main]: L, [side]: U, "refs/heads/unchanged": T0 }),
      branchBaseOrigins: {
        [main]: { v: 1 as const, oid: L, lineageHash: LIN, kind: "manual" as const, episode: "9".repeat(32) },
        "refs/heads/unchanged": { v: 1 as const, oid: T0, lineageHash: LIN, kind: "publisher-ack" as const, sourceSeq: 1, incomingKey: "old" },
      },
    };
    const candidate = { base: section({ [main]: N, [add]: U, "refs/heads/unchanged": T0 }, "new") };
    const result = composeRepoBase(previous, candidate, pull({ [main]: pMain, [side]: aSide, [add]: pAdd }), locked({
      branches: { [main]: lockedBranch(pMain), [side]: lockedBranch(aSide), [add]: lockedBranch(pAdd) },
    }));
    expect(result.disposition).toBe("terminal");
    expect(result.base?.refs).toEqual(candidate.base.refs);
    expect(result.branchBaseOrigins?.[main]).toMatchObject({ kind: "pull-p", oid: N });
    expect(result.branchBaseOrigins?.[add]).toMatchObject({ kind: "pull-p", oid: U });
    expect(result.branchBaseOrigins?.["refs/heads/unchanged"]).toMatchObject({ kind: "publisher-ack", oid: T0 });
    expect(result.branchBaseOrigins?.[side]).toBeUndefined();

    const held = composeRepoBase(previous, candidate, pull({ [side]: aSide, [add]: pAdd }), locked({
      branches: { [side]: lockedBranch(aSide), [add]: lockedBranch(pAdd) },
    }));
    expect(held.disposition).toBe("pending");
    expect(held.holds).toContainEqual({ ref: main, code: "missing-branch-proof" });
    expect(held.base?.refs[main]).toBe(L);
    expect(held.base?.refs[side]).toBeUndefined();
    expect(held.base?.refs[add]).toBe(U);
  });

  test("missing or OID-mismatched origins are dropped while stale-lineage metadata survives carry", () => {
    const ref = "refs/heads/main";
    for (const origin of [
      undefined,
      { v: 1 as const, oid: N, lineageHash: LIN, kind: "manual" as const, episode: "8".repeat(32) },
    ]) {
      const result = composeRepoBase(
        { base: section({ [ref]: L }), ...(origin ? { branchBaseOrigins: { [ref]: origin } } : {}) },
        { base: section({ [ref]: L }, "same") },
        { kind: "pull-carry", lineageHash: LIN },
        locked(),
      );
      expect(result.base?.refs[ref]).toBe(L);
      expect(result.branchBaseOrigins?.[ref]).toBeUndefined();
    }
    const stale = { v: 1 as const, oid: L, lineageHash: "f".repeat(64), kind: "manual" as const, episode: "7".repeat(32) };
    const carried = composeRepoBase(
      { base: section({ [ref]: L }), branchBaseOrigins: { [ref]: stale } },
      { base: section({ [ref]: L }, "same") },
      { kind: "pull-carry", lineageHash: LIN },
      locked(),
    );
    expect(carried.branchBaseOrigins?.[ref]).toEqual(stale);
  });

  test("mixed outcome retains the entire previous non-branch and artifact family", () => {
    const main = "refs/heads/main";
    const topic = "refs/heads/topic";
    const pMain = present(main, L, N);
    const old = section({ [main]: L, [topic]: U, "refs/tags/v1": T0, "refs/stash": U }, "old");
    const next = section({ [main]: N, [topic]: N, "refs/tags/v1": T1, "refs/tags/v2": N, "refs/stash": N }, "next");
    const result = composeRepoBase({ base: old }, { base: next }, pull({ [main]: pMain }), locked({ branches: { [main]: lockedBranch(pMain) } }));
    expect(result.disposition).toBe("pending");
    expect(result.base).toMatchObject({
      bundleSha: old.bundleSha, bundleEncSha: old.bundleEncSha, bundleCipherSize: old.bundleCipherSize,
      packChain: old.packChain, indexSha: old.indexSha, opState: old.opState, config: old.config,
      refTombstones: old.refTombstones, refTombstoneGeneration: old.refTombstoneGeneration, generatedAt: old.generatedAt,
    });
    expect(result.base?.refs).toMatchObject({ [main]: N, [topic]: U, "refs/tags/v1": T0, "refs/stash": U });
    expect(result.base?.refs["refs/tags/v2"]).toBeUndefined();
  });

  test("mixed-outcome settlement walk overlays crash-rebuilt safe refs, then manual no-P terminates wholesale", () => {
    const topic = "refs/heads/topic";
    const v1 = "refs/tags/v1";
    const v2 = "refs/tags/v2";
    const oldTag = "refs/tags/old";
    const stash = "refs/stash";
    const S0 = U;
    const S1 = "6".repeat(40);
    const T2 = "7".repeat(40);
    const TD = "8".repeat(40);
    const previous = section({ [topic]: L, [v1]: T0, [oldTag]: TD, [stash]: S0 }, "mixed-old");
    const incoming = section({ [topic]: N, [v1]: T1, [v2]: T2, [stash]: S1 }, "mixed-next");
    const safeRefWitnesses: Record<string, SafeRefWitness> = {
      [v1]: { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: T1 },
      [v2]: { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: T2 },
      [oldTag]: { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: null },
      [stash]: { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: S1 },
    };
    const safeRefs = Object.fromEntries(Object.entries(safeRefWitnesses).map(([ref, witness]) => [ref, {
      liveOid: witness.afterOid,
      witness,
      ...(ref === stash ? { stashReflogReady: true } : {}),
    }]));

    // Safe refs have committed and the process crashed before partial/state
    // persistence. Locked-terminal recovery proves them, but the already-live
    // topic has no P, so its protected BASE and the whole old family stay put.
    const recovered = composeRepoBase(
      { base: previous },
      { base: incoming },
      pull({}, safeRefWitnesses),
      locked({
        branches: { [topic]: { liveOid: N, artifactsClear: true, ownershipStable: true, reflogStable: true, currentRef: false, siblingOwned: false } },
        safeRefs,
      }),
    );
    expect(recovered.disposition).toBe("pending");
    expect(recovered.holds).toContainEqual({ ref: topic, code: "missing-branch-proof" });
    expect(recovered.base?.refs).toEqual(previous.refs);
    expect(recovered.base).toMatchObject({
      bundleSha: previous.bundleSha,
      indexSha: previous.indexSha,
      refTombstones: previous.refTombstones,
      generatedAt: previous.generatedAt,
    });

    const episode = "9".repeat(32);
    const manual = composeRepoBase(
      { base: recovered.base, branchBaseOrigins: recovered.branchBaseOrigins },
      { base: incoming },
      {
        kind: "manual",
        lineageHash: LIN,
        repositoryIdentityHash: REPO,
        incomingKey: "incoming",
        episode,
        snapshotId: "fresh-mixed-snapshot",
        stateGeneration: 12,
        branchDecisions: { [topic]: { kind: "no-p", beforeOid: L, afterOid: N, episode } },
        safeRefWitnesses,
      },
      locked({
        snapshotId: "fresh-mixed-snapshot",
        stateGeneration: 12,
        freshConfirmation: true,
        branches: { [topic]: { liveOid: N, artifactsClear: true, ownershipStable: true, reflogStable: true, currentRef: false, siblingOwned: false } },
        safeRefs,
      }),
    );
    expect(manual.disposition).toBe("terminal");
    expect(manual.holds).toEqual([]);
    expect(manual.base).toEqual(incoming);
    expect(manual.branchBaseOrigins).toEqual({
      [topic]: { v: 1, oid: N, lineageHash: LIN, kind: "manual", episode },
    });
    for (const ref of [v1, v2, oldTag, stash]) expect(manual.branchBaseOrigins?.[ref]).toBeUndefined();
  });

  test("safe-ref create/update/delete admits physical before different from logical BASE", () => {
    const refs = ["refs/tags/v1", "refs/stash"];
    for (const ref of refs) {
      for (const [logicalBefore, physicalBefore, after] of [[null, U, N], [L, U, N], [L, U, null]] as const) {
        const witness: SafeRefWitness = { kind: "safe-ref", proof: "expected-old-transaction", beforeOid: physicalBefore, afterOid: after };
        const beforeRefs = logicalBefore ? { [ref]: logicalBefore } : {};
        const afterRefs = after ? { [ref]: after } : {};
        const result = composeRepoBase({ base: section(beforeRefs) }, { base: section(afterRefs, "next") }, pull({}, { [ref]: witness }), locked({
          safeRefs: { [ref]: { liveOid: after, witness, ...(ref === "refs/stash" && after ? { stashReflogReady: true } : {}) } },
        }));
        expect(result.disposition, `${ref}:${logicalBefore}->${after}`).toBe("terminal");
        expect(result.base?.refs[ref] ?? null).toBe(after);
      }
    }
  });

  test("terminal-observation safe ref is exact-key/live bound; stash and pointer restrictions hold", () => {
    const ref = "refs/tags/v1";
    const witness: SafeRefWitness = { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: N };
    const candidate = { base: section({ [ref]: N }, "next") };
    const ok = composeRepoBase({ base: section({}) }, candidate, pull({}, { [ref]: witness }), locked({
      safeRefs: { [ref]: { liveOid: N, witness } },
    }));
    expect(ok.disposition).toBe("terminal");
    const raced = composeRepoBase({ base: section({}) }, candidate, pull({}, { [ref]: witness }), locked({
      safeRefs: { [ref]: { liveOid: U, witness } },
    }));
    expect(raced.holds).toContainEqual({ ref, code: "mismatched-safe-ref-proof" });
    const pointer = composeRepoBase({ base: section({}) }, candidate, pull({}, { [ref]: witness }), locked({
      repoKind: "pointer", effectiveRefScope: "scoped", safeRefs: { [ref]: { liveOid: N, witness } },
    }));
    expect(pointer.holds).toContainEqual({ ref, code: "scope-refused" });
    const stash = "refs/stash";
    const stashResult = composeRepoBase({ base: section({}) }, { base: section({ [stash]: N }, "next") }, pull({}, { [stash]: witness }), locked({
      safeRefs: { [stash]: { liveOid: N, witness } },
    }));
    expect(stashResult.holds).toContainEqual({ ref: stash, code: "mismatched-safe-ref-proof" });
  });

  test("manual no-P is positive-to-positive, fresh, locked, single-key authority", () => {
    const ref = "refs/heads/topic";
    const authority: ComposeRepoBaseAuthority = {
      kind: "manual", lineageHash: LIN, repositoryIdentityHash: REPO, incomingKey: "incoming",
      episode: "6".repeat(32), snapshotId: "snapshot", stateGeneration: 7,
      branchDecisions: { [ref]: { kind: "no-p", beforeOid: L, afterOid: N, episode: "6".repeat(32) } }, safeRefWitnesses: {},
    };
    const proof = locked({
      snapshotId: "snapshot", stateGeneration: 7, freshConfirmation: true,
      branches: { [ref]: { liveOid: N, artifactsClear: true, ownershipStable: true, reflogStable: true, currentRef: false, siblingOwned: false } },
    });
    const result = composeRepoBase({ base: section({ [ref]: L }) }, { base: section({ [ref]: N }, "next") }, authority, proof);
    expect(result.disposition).toBe("terminal");
    expect(result.branchBaseOrigins?.[ref]).toEqual({ v: 1, oid: N, lineageHash: LIN, kind: "manual", episode: "6".repeat(32) });

    for (const invalid of [
      locked({ ...proof, incomingKey: "other" }),
      locked({ ...proof, stateGeneration: 8 }),
      locked({ ...proof, freshConfirmation: false }),
      locked({ ...proof, branches: { [ref]: { ...proof.branches[ref]!, siblingOwned: true } } }),
    ]) {
      expect(composeRepoBase({ base: section({ [ref]: L }) }, { base: section({ [ref]: N }, "next") }, authority, invalid).disposition).toBe("pending");
    }
    expect(composeRepoBase({ base: section({}) }, { base: section({ [ref]: N }, "next") }, authority, proof).disposition).toBe("pending");
  });

  test("manual artifact binds protected BASE separately from the displaced physical P prior", () => {
    const ref = "refs/heads/topic";
    const witness = present(ref, U, N);
    const authority: ComposeRepoBaseAuthority = {
      kind: "manual", lineageHash: LIN, repositoryIdentityHash: REPO, incomingKey: "incoming",
      episode: "6".repeat(32), snapshotId: "snapshot", stateGeneration: 7,
      branchDecisions: { [ref]: { kind: "artifact", beforeBaseOid: L, witness } }, safeRefWitnesses: {},
    };
    const proof = locked({
      snapshotId: "snapshot", stateGeneration: 7, freshConfirmation: true,
      branches: { [ref]: lockedBranch(witness) },
    });
    const result = composeRepoBase({ base: section({ [ref]: L }) }, { base: section({ [ref]: N }, "next") }, authority, proof);
    expect(result.disposition).toBe("terminal");
    expect(result.base?.refs[ref]).toBe(N);
    expect(result.branchBaseOrigins?.[ref]).toMatchObject({ kind: "pull-p", oid: N });
    expect(composeRepoBase({ base: section({ [ref]: U }) }, { base: section({ [ref]: N }, "next") }, authority, proof).disposition).toBe("pending");
  });

  test("publisher ACK creates provenance but never removes; migration imports positives untrusted and never removes", () => {
    const main = "refs/heads/main";
    const side = "refs/heads/side";
    const previous = { base: section({ [main]: L, [side]: U }) };
    const candidate = { base: section({ [main]: N }, "next") };
    const ack = composeRepoBase(previous, candidate, {
      kind: "publisher-ack", lineageHash: LIN, repositoryIdentityHash: REPO, incomingKey: "ack", sourceSeq: 9,
      advertisedRefs: { [main]: N },
    }, locked());
    expect(ack.base?.refs).toMatchObject({ [main]: N, [side]: U });
    expect(ack.branchBaseOrigins?.[main]).toMatchObject({ kind: "publisher-ack", sourceSeq: 9, incomingKey: "ack" });
    // Blanket authority is branded; a structural literal is no longer one.
    const migrated = composeRepoBase(previous, candidate, migrationRepoBaseProof(LIN).authority, locked());
    expect(migrated.base?.refs).toMatchObject({ [main]: N, [side]: U });
    expect(migrated.branchBaseOrigins).toBeUndefined();
  });

  test("publisher ACK retires an omitted branch only with the exact six-part absence receipt", () => {
    const ref = "refs/heads/deleted";
    const previous = { base: section({ [ref]: L }) };
    const candidateSection = {
      ...section({}, "next"),
      refTombstones: { [ref]: [{ oid: L, ts: "2026-01-01T00:00:00.000Z", generation: 1 }] },
      refTombstoneGeneration: 1,
    };
    const authority: ComposeRepoBaseAuthority = {
      kind: "publisher-ack", lineageHash: LIN, repositoryIdentityHash: REPO,
      incomingKey: "ack", sourceSeq: 9, advertisedRefs: {},
      absentBranchProofs: { [ref]: { priorOid: L } },
    };
    const retired = composeRepoBase(previous, { base: candidateSection }, authority, locked());
    expect(retired.disposition).toBe("terminal");
    expect(retired.base?.refs[ref]).toBeUndefined();

    for (const bad of [
      { ...candidateSection, refTombstones: {} },
      { ...candidateSection, refScope: "scoped" as const },
    ]) {
      const held = composeRepoBase(previous, { base: bad }, authority, locked());
      expect(held.disposition).toBe("pending");
      expect(held.base?.refs[ref]).toBe(L);
    }
    const wrongOid = composeRepoBase(previous, { base: candidateSection }, {
      ...authority, absentBranchProofs: { [ref]: { priorOid: U } },
    }, locked());
    expect(wrongOid.disposition).toBe("pending");
    expect(wrongOid.base?.refs[ref]).toBe(L);
  });

  test("publisher ACK absence receipt rejects every single-factor contract violation", () => {
    const ref = "refs/heads/deleted";
    const tombstoned = {
      ...section({}, "next"),
      refTombstones: { [ref]: [{ oid: L, ts: "2026-01-01T00:00:00.000Z", generation: 1 }] },
      refTombstoneGeneration: 1,
    };
    const authority: Extract<ComposeRepoBaseAuthority, { kind: "publisher-ack" }> = {
      kind: "publisher-ack",
      lineageHash: LIN,
      repositoryIdentityHash: REPO,
      incomingKey: "ack",
      sourceSeq: 9,
      advertisedRefs: {},
      absentBranchProofs: { [ref]: { priorOid: L } },
    };
    const assertHeld = (
      previous: GitSection,
      candidate: GitSection,
      ack: Extract<ComposeRepoBaseAuthority, { kind: "publisher-ack" }> = authority,
      proof: RepoBaseLockedProof = locked(),
      heldRef = ref,
    ) => {
      const result = composeRepoBase({ base: previous }, { base: candidate }, ack, proof);
      expect(result.disposition).toBe("pending");
      expect(result.holds).toContainEqual(expect.objectContaining({ ref: heldRef }));
      expect(result.base?.refs[ref]).toBe(previous.refs[ref]);
    };

    assertHeld(section({ [ref]: L }), tombstoned, { ...authority, advertisedRefs: { [ref]: L } });
    assertHeld(section({ [ref]: L }), { ...tombstoned, refs: { [ref]: L } });
    assertHeld(section({ [ref]: L }), tombstoned, authority, locked({ effectiveRefScope: "scoped" }));
    assertHeld(section({ [ref]: L }), tombstoned, authority, locked({ repoKind: "pointer" }));
    assertHeld(section({ [ref]: L }), {
      ...tombstoned,
      refTombstones: { [ref]: [{ oid: U, ts: "2026-01-01T00:00:00.000Z", generation: 1 }] },
    });
    assertHeld(section({ [ref]: L }), tombstoned, { ...authority, lineageHash: "not-a-lineage" });
    assertHeld(section({ [ref]: L }), tombstoned, { ...authority, repositoryIdentityHash: "not-an-identity" });
    assertHeld(section({ [ref]: L }), tombstoned, { ...authority, sourceSeq: -1 });
    assertHeld(section({ [ref]: L }), tombstoned, { ...authority, incomingKey: "" });

    const malformed = "not-an-oid";
    assertHeld(
      section({ [ref]: malformed }),
      {
        ...tombstoned,
        refTombstones: { [ref]: [{ oid: malformed, ts: "2026-01-01T00:00:00.000Z", generation: 1 }] },
      },
      { ...authority, absentBranchProofs: { [ref]: { priorOid: malformed } } },
    );

    const tag = "refs/tags/not-a-branch";
    assertHeld(
      section({ [ref]: L }),
      tombstoned,
      { ...authority, absentBranchProofs: { [tag]: { priorOid: L } } },
      locked(),
      tag,
    );
  });

  test("P-repair advances only pre-state, repairs already-next, and preserves absence/third", () => {
    const ref = "refs/heads/topic";
    const witness = present(ref, L, N);
    for (const [before, disposition, expected] of [
      [L, "advance-prior-to-next", N],
      [N, "already-next", N],
      [null, "preserve-absent", null],
      [U, "preserve-third", U],
    ] as const) {
      const beforeRefs = before ? { [ref]: before } : {};
      const expectedRefs = expected ? { [ref]: expected } : {};
      const result = composeRepoBase({ base: section(beforeRefs) }, { base: section(expectedRefs, "next") }, {
        kind: "p-repair", lineageHash: LIN, repositoryIdentityHash: REPO,
        repairs: { [ref]: { witness, disposition } },
      }, locked({ branches: { [ref]: {
        liveOid: expected, witness, artifactsClear: true, ownershipStable: true,
        reflogStable: true, currentRef: false, siblingOwned: false,
      } } }));
      expect(result.base?.refs[ref] ?? null).toBe(expected);
      expect(result.holds).toEqual([]);
      if (expected === N) expect(result.branchBaseOrigins?.[ref]).toMatchObject({ kind: "pull-p", oid: N });
      else expect(result.branchBaseOrigins?.[ref]).toBeUndefined();
    }
  });

  test("branch and safe-ref witness classes cannot cross", () => {
    const branch = "refs/heads/topic";
    const tag = "refs/tags/v1";
    const safe: SafeRefWitness = { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: N };
    const p = present(branch, L, N);
    const result = composeRepoBase({ base: section({ [branch]: L }) }, { base: section({ [branch]: N }, "next") }, pull({ [tag]: p }, { [branch]: safe }), locked());
    expect(result.holds).toContainEqual({ ref: branch, code: "wrong-ref-class" });
    expect(result.holds).toContainEqual({ ref: tag, code: "wrong-ref-class" });
  });
});
