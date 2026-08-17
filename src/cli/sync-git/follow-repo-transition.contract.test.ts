import { describe, expect, test } from "bun:test";
import type { GitSection } from "../../engine/index.js";
import type { GitDeferral, GitDeferrals, TypedBlocker } from "../config.js";
import type { GitDeferralUpdates } from "../sync-state.js";
import type { BranchTransitionWitness, LockedBranchProof, SafeRefWitness } from "./base-composer.js";
import type { FollowProgress } from "./follow.js";
import {
  composeFollowAuthority,
  composeFollowRepoTransition,
  followBaseProof,
  followHeldDeferralReason,
  FollowRepoTransitionIdentityMismatch,
  mergeFollowDeferralLanes,
  type FollowCommitInput,
  type FollowExecutionReceipt,
  type FollowTransitionIdentity,
  type StandingBranchProofReceipt,
} from "./follow-repo-transition.js";

const LINEAGE = "a".repeat(64);
const REPO_ID = "b".repeat(64);
const OLD_OID = "1".repeat(40);
const NEW_OID = "2".repeat(40);
const ARTIFACT_OID = "3".repeat(40);
const EPISODE = "c".repeat(32);

const identity: FollowTransitionIdentity = {
  relPath: "repo", incomingKey: "incoming-1", repoKind: "dir", effectiveRefScope: "all",
};

/** A bound input whose prior BASE stands, so proof minting stays on the
 * pull-ref-transaction authority unless a test says otherwise. */
function boundInput(overrides: Partial<FollowCommitInput> = {}): FollowCommitInput {
  const incoming = section({ "refs/heads/main": NEW_OID });
  return {
    identity,
    incoming,
    baseComposition: {
      prior: { base: section({ "refs/heads/main": OLD_OID }) },
      candidate: { base: incoming },
    },
    ...overrides,
  };
}

function section(refs: Record<string, string>): GitSection {
  return { refs, head: "ref: refs/heads/main\n", refScope: "all" } as GitSection;
}

function proofReceipt(overrides: Partial<StandingBranchProofReceipt> = {}): StandingBranchProofReceipt {
  return {
    relPath: identity.relPath, incomingKey: identity.incomingKey,
    lineageHash: LINEAGE, repositoryIdentityHash: REPO_ID,
    unmaterializedAbsenceRefs: new Set<string>(), ...overrides,
  };
}

function progress(overrides: Partial<FollowProgress> = {}): FollowProgress {
  return { appliedRefs: {}, heldRefs: {}, blockers: [], configApplied: true, ...overrides };
}

function receipt(overrides: Partial<FollowExecutionReceipt> = {}): FollowExecutionReceipt {
  return {
    relPath: identity.relPath, incomingKey: identity.incomingKey,
    outcome: "followed", progress: progress(), ...overrides,
  } as FollowExecutionReceipt;
}

/** A branch advance whose witness/locked proof are complete: composeRepoBase
 * reaches `terminal` and mints pull-p provenance for it. */
type ProvenBranchAdvance = { input: FollowCommitInput; progress: FollowProgress };

function provenBranchAdvance(): ProvenBranchAdvance {
  const witness = {
    kind: "present", ref: "refs/heads/main", priorOid: OLD_OID, nextOid: NEW_OID,
    lineageHash: LINEAGE, repositoryIdentityHash: REPO_ID,
    artifactRef: "refs/rbox-base/p/main", artifactOid: ARTIFACT_OID, episode: EPISODE,
  } as BranchTransitionWitness;
  const locked = {
    witness, liveOid: NEW_OID, artifactsClear: true, ownershipStable: true,
    reflogStable: true, reflogEpisode: EPISODE, currentRef: false, siblingOwned: false,
  } as LockedBranchProof;
  const incoming = section({ "refs/heads/main": NEW_OID });
  return {
    input: {
      identity,
      incoming,
      baseComposition: {
        prior: { base: section({ "refs/heads/main": OLD_OID }) },
        candidate: { base: incoming },
      },
    },
    progress: progress({
      appliedRefs: { "refs/heads/main": { kind: "direct", oid: NEW_OID } },
      branchWitnesses: { "refs/heads/main": witness },
      branchLockedProofs: { "refs/heads/main": locked },
      incomingIndexProjection: "idx-next",
    }),
  };
}

/** An advance with no witness at all: composeRepoBase holds it, so the
 * disposition is `pending` even though nothing is physically held. */
function unprovenBranchAdvance(): FollowCommitInput {
  const incoming = section({ "refs/heads/main": NEW_OID });
  return {
    identity,
    incoming,
    baseComposition: {
      prior: { base: section({ "refs/heads/main": OLD_OID }) },
      candidate: { base: incoming },
    },
  };
}

describe("follow proof minting", () => {
  test("binds the settled standing-branch lineage, repository identity, and incoming key", () => {
    const advance = provenBranchAdvance();
    const proof = followBaseProof(advance.input, proofReceipt(), advance.progress, true);
    expect(proof.authority).toMatchObject({
      kind: "pull-ref-transaction",
      lineageHash: LINEAGE,
      repositoryIdentityHash: REPO_ID,
      incomingKey: identity.incomingKey,
    });
    expect(proof.lockedProof).toMatchObject({
      repoKind: "dir",
      effectiveRefScope: "all",
      checkoutComplete: true,
      incomingKey: identity.incomingKey,
    });
    expect(proof.lockedProof.branches).toEqual(advance.progress.branchLockedProofs!);
  });

  test("a live stash tip carries stashReflogReady; an absent one does not", () => {
    const live: SafeRefWitness = { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: NEW_OID };
    const gone: SafeRefWitness = { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: null };
    const tag: SafeRefWitness = { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: NEW_OID };
    const proof = followBaseProof(boundInput(), proofReceipt(), progress({
      safeRefWitnesses: { "refs/stash": live, "refs/tags/v1": tag },
    }), true);
    expect(proof.lockedProof.safeRefs["refs/stash"]).toEqual({
      liveOid: NEW_OID, witness: live, stashReflogReady: true,
    });
    expect(proof.lockedProof.safeRefs["refs/tags/v1"]).toEqual({ liveOid: NEW_OID, witness: tag });
    const dropped = followBaseProof(boundInput(), proofReceipt(), progress({
      safeRefWitnesses: { "refs/stash": gone },
    }), true);
    expect(dropped.lockedProof.safeRefs["refs/stash"]).toEqual({ liveOid: null, witness: gone });
  });

  test("checkoutComplete is carried verbatim into the locked proof", () => {
    expect(followBaseProof(boundInput(), proofReceipt(), progress(), false).lockedProof.checkoutComplete).toBe(false);
  });

  test("a proof receipt for another repository or wire section is refused", () => {
    expect(() => followBaseProof(boundInput(), proofReceipt({ relPath: "other" }), progress(), true))
      .toThrow(FollowRepoTransitionIdentityMismatch);
    expect(() => followBaseProof(boundInput(), proofReceipt({ incomingKey: "incoming-2" }), progress(), true))
      .toThrow(FollowRepoTransitionIdentityMismatch);
  });

  test("no prior BASE plus an armed observation mints observed-landing under the follow's own identity", () => {
    const incoming = section({ "refs/heads/main": NEW_OID });
    const landing = followBaseProof({
      identity: { ...identity, repoKind: "pointer", effectiveRefScope: "branches" },
      incoming,
      baseComposition: { prior: {}, candidate: { base: incoming } },
      landingObservation: { "refs/heads/main": NEW_OID },
    }, proofReceipt(), progress(), true);

    expect(landing.authority).toEqual({
      kind: "observed-landing", lineageHash: LINEAGE, observedRefs: { "refs/heads/main": NEW_OID },
    });
    expect(landing.lockedProof).toEqual({
      repoKind: "pointer", effectiveRefScope: "branches", checkoutComplete: true, branches: {}, safeRefs: {},
    });
  });

  test("an armed observation over an EXISTING BASE keeps today's pull-ref-transaction authority", () => {
    const proof = followBaseProof(
      boundInput({ landingObservation: { "refs/heads/main": NEW_OID } }),
      proofReceipt(), progress(), true,
    );
    expect(proof.authority.kind).toBe("pull-ref-transaction");
  });

  test("no prior BASE and no observation also keeps pull-ref-transaction", () => {
    const incoming = section({ "refs/heads/main": NEW_OID });
    const proof = followBaseProof({
      identity, incoming, baseComposition: { prior: {}, candidate: { base: incoming } },
    }, proofReceipt(), progress(), true);
    expect(proof.authority.kind).toBe("pull-ref-transaction");
  });

  test("a deferred transition composes its landing at checkoutComplete false", () => {
    const incoming = section({ "refs/heads/main": NEW_OID });
    const landing = followBaseProof({
      identity, incoming,
      baseComposition: { prior: {}, candidate: { base: incoming } },
      landingObservation: { "refs/heads/main": NEW_OID },
    }, proofReceipt(), progress(), false);
    expect(landing.lockedProof.checkoutComplete).toBe(false);
  });
});

describe("first-BASE landing composition", () => {
  const incoming = section({ "refs/heads/main": NEW_OID });
  const baseless: FollowCommitInput = {
    identity, incoming, baseComposition: { prior: {}, candidate: { base: incoming } },
  };

  test("an armed observation lands the incoming section verbatim as the first BASE", () => {
    const authority = composeFollowAuthority(
      { ...baseless, landingObservation: { "refs/heads/main": NEW_OID } },
      proofReceipt(), progress(), true,
    );
    expect(authority.composed.disposition).toBe("terminal");
    expect(authority.composed.base).toEqual(incoming);
    expect(authority.held).toBe(false);
  });

  test("the journal intent, which composes BEFORE the observation exists, carries no first BASE", () => {
    const authority = composeFollowAuthority(baseless, proofReceipt(), progress(), true);
    expect(authority.composed.disposition).toBe("pending");
    expect(authority.composed.base).toBeUndefined();
    expect(authority.held).toBe(true);
  });

  test("an observation that disagrees with the candidate lands nothing at all", () => {
    const authority = composeFollowAuthority(
      { ...baseless, landingObservation: { "refs/heads/main": OLD_OID } },
      proofReceipt(), progress(), true,
    );
    expect(authority.composed.disposition).toBe("pending");
    expect(authority.composed.base).toBeUndefined();
    expect(authority.composed.holds).toEqual([{ ref: "refs/heads/main", code: "missing-branch-proof" }]);
  });

  test("a deferred transition keeps the first BASE unlanded even with a valid observation", () => {
    const transition = composeFollowRepoTransition(
      { ...baseless, landingObservation: { "refs/heads/main": NEW_OID } },
      receipt({ outcome: "deferred", deferralReason: "local-commits" }) as FollowExecutionReceipt,
      proofReceipt(),
    );
    expect(transition.baseAdvance).toBeUndefined();
    expect(transition.pending).toEqual(incoming);
  });
});

describe("follow authority composition", () => {
  test("a fully proven advance composes the intended BASE terminally", () => {
    const advance = provenBranchAdvance();
    const authority = composeFollowAuthority(advance.input, proofReceipt(), advance.progress, true);
    expect(authority.composed.disposition).toBe("terminal");
    expect(authority.composed.base?.refs).toEqual({ "refs/heads/main": NEW_OID });
    expect(authority.composed.branchBaseOrigins?.["refs/heads/main"]).toMatchObject({
      v: 1, oid: NEW_OID, kind: "pull-p", lineageHash: LINEAGE, episode: EPISODE,
    });
    expect(authority.held).toBe(false);
    expect(authority.ownershipOnly).toBe(false);
  });

  test("held refs and a pending composition each make the disposition held", () => {
    const advance = provenBranchAdvance();
    expect(composeFollowAuthority(advance.input, proofReceipt(), progress({
      ...advance.progress, heldRefs: { "refs/heads/topic": "local-commits" },
    }), true).held).toBe(true);
    expect(composeFollowAuthority(unprovenBranchAdvance(), proofReceipt(), progress(), true).held).toBe(true);
  });

  test("ownershipOnly requires every held ref to be ownership", () => {
    const advance = provenBranchAdvance();
    const ownership = composeFollowAuthority(advance.input, proofReceipt(), progress({
      ...advance.progress, heldRefs: { "refs/heads/topic": "ownership" },
      blockers: [{ ref: "refs/heads/topic", reason: "worktree-ownership", provenance: "ref-plane" }],
    }), true);
    expect(ownership.ownershipOnly).toBe(true);
    const mixed = composeFollowAuthority(advance.input, proofReceipt(), progress({
      ...advance.progress,
      heldRefs: { "refs/heads/topic": "ownership", "refs/heads/other": "local-commits" },
      // Per-ref ownership blockers alone must not make a mixed hold ownership-only.
      blockers: [{ ref: "refs/heads/topic", reason: "worktree-ownership", provenance: "ref-plane" }],
    }), true);
    expect(mixed.ownershipOnly).toBe(false);
    expect(composeFollowAuthority(advance.input, proofReceipt(), advance.progress, true).ownershipOnly).toBe(false);
  });

  test("an input whose identity does not match the proof receipt is refused", () => {
    const advance = provenBranchAdvance();
    expect(() => composeFollowAuthority(advance.input, proofReceipt({ incomingKey: "other" }), advance.progress, true))
      .toThrow(FollowRepoTransitionIdentityMismatch);
  });
});

// LEFTOVER anti-slop(no-chained-type-assertions), the two blockers below: both
// are deliberately unrepresentable in `TypedBlocker` — no `ref-plane` blocker may
// carry `local-index`, and `composer` is not a provenance at all. They pin that a
// ref-plane blocker outranks a persisted held reason and that a non-ref-plane one
// never classifies, so any representable shape would change what this contract
// asserts. Typing them honestly means widening `TypedBlocker`, not editing here.
describe("held deferral reason", () => {
  test("a ref-plane blocker classifies before any persisted held reason", () => {
    expect(followHeldDeferralReason(progress({
      heldRefs: { "refs/heads/a": "local-commits" },
      blockers: [{ reason: "local-index", provenance: "ref-plane" } as unknown as TypedBlocker],
    }))).toBe("local-index");
  });

  test("non-ref-plane blockers never classify", () => {
    expect(followHeldDeferralReason(progress({
      heldRefs: { "refs/heads/a": "local-stash" },
      blockers: [{ reason: "local-index", provenance: "composer" } as unknown as TypedBlocker],
    }))).toBe("local-stash");
  });

  test("persisted held reasons rank commits over stash over ownership", () => {
    expect(followHeldDeferralReason(progress({
      heldRefs: { "refs/heads/a": "local-stash", "refs/heads/b": "local-commits" },
    }))).toBe("local-commits");
    expect(followHeldDeferralReason(progress({
      heldRefs: { "refs/heads/a": "ownership", "refs/heads/b": "local-stash" },
    }))).toBe("local-stash");
    expect(followHeldDeferralReason(progress({
      heldRefs: { "refs/heads/a": "ownership" },
    }))).toBe("worktree-ownership");
  });
});

describe("deferral lane merge", () => {
  const apply: GitDeferral = { lane: "apply", deferredSince: "t0", reasonSince: "t0", lastSeen: "t0", reason: "conflict" };
  const config: GitDeferral = { lane: "config", deferredSince: "t0", reasonSince: "t0", lastSeen: "t0", reason: "config" };
  const prior: GitDeferrals = { apply, config };

  test("a null transition clears every lane", () => {
    expect(mergeFollowDeferralLanes(prior, null)).toEqual({});
  });

  test("an undefined transition keeps the durable lanes exactly", () => {
    expect(mergeFollowDeferralLanes(prior, undefined)).toEqual({ apply, config });
  });

  test("per-lane nulls clear and per-lane values replace", () => {
    const capture: GitDeferral = { lane: "capture", deferredSince: "t1", reasonSince: "t1", lastSeen: "t1", reason: "other" };
    const transition: GitDeferralUpdates = { apply: null, capture };
    expect(mergeFollowDeferralLanes(prior, transition)).toEqual({ config, capture });
  });

  test("the merge never aliases the durable record", () => {
    const merged = mergeFollowDeferralLanes(prior, undefined);
    delete merged.apply;
    expect(prior.apply).toBe(apply);
  });
});

describe("followed transition", () => {
  test("a clean terminal follow retires every in-flight lane and publishes the journal", () => {
    const advance = provenBranchAdvance();
    const transition = composeFollowRepoTransition(
      advance.input,
      receipt({ progress: advance.progress }),
      proofReceipt(),
    );
    expect(transition.result).toBe("applied");
    expect(transition.baseAdvance?.appliedSection?.refs).toEqual({ "refs/heads/main": NEW_OID });
    expect(transition.baseAdvance?.branchOrigins?.["refs/heads/main"]).toMatchObject({ kind: "pull-p" });
    expect(transition.baseAdvance?.proof.lockedProof.checkoutComplete).toBe(true);
    expect(transition.pending).toBeNull();
    expect(transition.partial).toEqual({ kind: "clear" });
    expect(transition.deferral).toEqual({ kind: "clear" });
    expect(transition.heldAttempt).toBe("clear");
    expect(transition.indexProjection).toBe("idx-next");
    expect(transition.resolutionMemory).toBe("clear");
    expect(transition.removalMemory).toBe("clear");
    expect(transition.publishJournal).toBe(true);
  });

  test("an unapplied config lane carries a config-only partial rather than clearing it", () => {
    const advance = provenBranchAdvance();
    const transition = composeFollowRepoTransition(
      advance.input,
      receipt({ progress: progress({ ...advance.progress, configApplied: false }) }),
      proofReceipt(),
    );
    expect(transition.partial).toEqual({ kind: "config-carry" });
    expect(transition.pending).toBeNull();
    expect(transition.heldAttempt).toBe("clear");
  });

  test("a missing index projection is written as an explicit null, never left standing", () => {
    const advance = provenBranchAdvance();
    const bare = progress({ ...advance.progress });
    delete bare.incomingIndexProjection;
    expect(composeFollowRepoTransition(advance.input, receipt({ progress: bare }), proofReceipt()).indexProjection)
      .toBeNull();
  });

  test("held refs keep the incoming section pending and escalate the classified reason", () => {
    const advance = provenBranchAdvance();
    const held = progress({ ...advance.progress, heldRefs: { "refs/heads/topic": "local-commits" } });
    const transition = composeFollowRepoTransition(advance.input, receipt({ progress: held }), proofReceipt());
    expect(transition.result).toBe("applied");
    expect(transition.pending).toBe(advance.input.incoming);
    expect(transition.partial).toEqual({ kind: "from-progress", checkoutPending: false });
    expect(transition.deferral).toEqual({ kind: "set", reason: "local-commits" });
    expect(transition.heldAttempt).toBe("retain");
    expect(transition.publishJournal).toBe(true);
  });

  test("a pending composition with no held ref defers as artifact, not as a held reason", () => {
    const transition = composeFollowRepoTransition(
      unprovenBranchAdvance(),
      receipt({ progress: progress() }),
      proofReceipt(),
    );
    expect(transition.deferral).toEqual({ kind: "set", reason: "artifact" });
    expect(transition.pending).not.toBeNull();
    expect(transition.baseAdvance?.appliedSection?.refs).toEqual({ "refs/heads/main": OLD_OID });
  });

  test("ownership-only holds clear the apply lane while the no-escalate rule stands", () => {
    const advance = provenBranchAdvance();
    const ownership = progress({
      ...advance.progress,
      heldRefs: { "refs/heads/topic": "ownership" },
      blockers: [{ ref: "refs/heads/topic", reason: "worktree-ownership", provenance: "ref-plane" }],
    });
    const escalate = process.env.RBOX_GIT_OWNERSHIP_NO_ESCALATE;
    try {
      delete process.env.RBOX_GIT_OWNERSHIP_NO_ESCALATE;
      expect(composeFollowRepoTransition(advance.input, receipt({ progress: ownership }), proofReceipt()).deferral)
        .toEqual({ kind: "clear" });
      process.env.RBOX_GIT_OWNERSHIP_NO_ESCALATE = "0";
      expect(composeFollowRepoTransition(advance.input, receipt({ progress: ownership }), proofReceipt()).deferral)
        .toEqual({ kind: "set", reason: "worktree-ownership" });
    } finally {
      if (escalate === undefined) delete process.env.RBOX_GIT_OWNERSHIP_NO_ESCALATE;
      else process.env.RBOX_GIT_OWNERSHIP_NO_ESCALATE = escalate;
    }
  });
});

describe("deferred transition", () => {
  test("an ordinary deferral carries serialized BASE untouched", () => {
    const advance = provenBranchAdvance();
    const transition = composeFollowRepoTransition(
      advance.input,
      receipt({ outcome: "deferred", deferralReason: "local-edits", progress: advance.progress }),
      proofReceipt(),
    );
    expect(transition.result).toBe("deferred");
    expect(transition.baseAdvance).toBeUndefined();
    expect(transition.pending).toBe(advance.input.incoming);
    expect(transition.partial).toEqual({ kind: "from-progress", checkoutPending: true });
    expect(transition.deferral).toEqual({ kind: "set", reason: "local-edits" });
    expect(transition.heldAttempt).toBe("retain");
    expect(transition.indexProjection).toBe("retain");
    expect(transition.resolutionMemory).toBe("retain");
    expect(transition.removalMemory).toBe("retain");
    expect(transition.publishJournal).toBe(false);
  });

  test("a crash-reconstructed owning absence consumes exactly its stale BASE member", () => {
    const witness = {
      kind: "absent", ref: "refs/heads/gone", priorOid: OLD_OID, lineageHash: LINEAGE,
      repositoryIdentityHash: REPO_ID, artifactRef: "refs/rbox-base/a/gone",
      artifactOid: ARTIFACT_OID, source: "a",
    } as BranchTransitionWitness;
    const locked = {
      witness, liveOid: null, artifactsClear: true, ownershipStable: true, reflogStable: true,
      currentRef: false, siblingOwned: false,
    } as LockedBranchProof;
    const incoming = section({ "refs/heads/main": OLD_OID });
    const input: FollowCommitInput = {
      identity,
      incoming,
      baseComposition: {
        prior: { base: section({ "refs/heads/main": OLD_OID, "refs/heads/gone": OLD_OID }) },
        candidate: { base: incoming },
      },
    };
    const deferred = progress({
      appliedRefs: {
        "refs/heads/gone": { kind: "absent", artifactOid: ARTIFACT_OID },
        "refs/heads/other": { kind: "direct", oid: NEW_OID },
      },
      heldRefs: { "refs/heads/topic": "local-commits" },
      configApplied: true,
      branchWitnesses: { "refs/heads/gone": witness },
      branchLockedProofs: { "refs/heads/gone": locked },
      safeRefWitnesses: { "refs/tags/v1": { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: NEW_OID } },
      incomingIndexProjection: "idx-next",
    });
    const transition = composeFollowRepoTransition(
      input,
      receipt({ outcome: "deferred", deferralReason: "local-edits", progress: deferred }),
      proofReceipt({ unmaterializedAbsenceRefs: new Set(["refs/heads/gone"]) }),
    );
    const advanceProof = transition.baseAdvance!.proof;
    // Only the reconstructed absence may be published: unrelated pre-checkout
    // ref progress and every safe-ref witness stay out of the narrowed proof.
    expect(Object.keys(advanceProof.authority.branchWitnesses)).toEqual(["refs/heads/gone"]);
    expect(advanceProof.authority.safeRefWitnesses).toEqual({});
    expect(advanceProof.lockedProof.safeRefs).toEqual({});
    expect(advanceProof.lockedProof.checkoutComplete).toBe(false);
    expect(transition.baseAdvance!.appliedSection?.refs).toEqual({ "refs/heads/main": OLD_OID });
    // A deferred checkout never advances the rest of the transition.
    expect(transition.result).toBe("deferred");
    expect(transition.indexProjection).toBe("retain");
    expect(transition.partial).toEqual({ kind: "from-progress", checkoutPending: true });
  });

  test("an unmaterialized absence without a complete owning receipt is not reconstructed", () => {
    const incoming = section({ "refs/heads/main": OLD_OID });
    const input: FollowCommitInput = {
      identity,
      incoming,
      baseComposition: {
        prior: { base: section({ "refs/heads/main": OLD_OID, "refs/heads/gone": OLD_OID }) },
        candidate: { base: incoming },
      },
    };
    const absenceRefs = new Set(["refs/heads/gone"]);
    const witness = {
      kind: "absent", ref: "refs/heads/gone", priorOid: OLD_OID, lineageHash: LINEAGE,
      repositoryIdentityHash: REPO_ID, artifactRef: "refs/rbox-base/a/gone",
      artifactOid: ARTIFACT_OID, source: "a",
    } as BranchTransitionWitness;
    const locked = {
      witness, liveOid: null, artifactsClear: true, ownershipStable: true, reflogStable: true,
      currentRef: false, siblingOwned: false,
    } as LockedBranchProof;
    const base = {
      appliedRefs: { "refs/heads/gone": { kind: "absent" as const, artifactOid: ARTIFACT_OID } },
      branchWitnesses: { "refs/heads/gone": witness },
      branchLockedProofs: { "refs/heads/gone": locked },
    };
    const deferredWith = (over: Partial<FollowProgress>): FollowExecutionReceipt =>
      receipt({ outcome: "deferred", deferralReason: "local-edits", progress: progress({ ...base, ...over }) });
    const proof = proofReceipt({ unmaterializedAbsenceRefs: absenceRefs });
    // No physical absence applied.
    expect(composeFollowRepoTransition(input, deferredWith({ appliedRefs: {} }), proof).baseAdvance).toBeUndefined();
    // No absent witness.
    expect(composeFollowRepoTransition(input, deferredWith({ branchWitnesses: {} }), proof).baseAdvance).toBeUndefined();
    // No locked proof.
    expect(composeFollowRepoTransition(input, deferredWith({ branchLockedProofs: {} }), proof).baseAdvance).toBeUndefined();
    // Not named by the settled standing-branch proof.
    expect(composeFollowRepoTransition(input, deferredWith({}), proofReceipt()).baseAdvance).toBeUndefined();
  });
});

describe("transition identity", () => {
  test("an execution receipt for another repository or wire section is refused", () => {
    const advance = provenBranchAdvance();
    expect(() => composeFollowRepoTransition(
      advance.input, receipt({ relPath: "other", progress: advance.progress }), proofReceipt(),
    )).toThrow(FollowRepoTransitionIdentityMismatch);
    expect(() => composeFollowRepoTransition(
      advance.input, receipt({ incomingKey: "incoming-2", progress: advance.progress }), proofReceipt(),
    )).toThrow(FollowRepoTransitionIdentityMismatch);
  });

  test("a proof receipt bound to another wire section is refused before any composition", () => {
    const advance = provenBranchAdvance();
    expect(() => composeFollowRepoTransition(
      advance.input, receipt({ progress: advance.progress }), proofReceipt({ incomingKey: "incoming-2" }),
    )).toThrow(FollowRepoTransitionIdentityMismatch);
  });

  test("a deferral that composes nothing is still refused on a foreign proof receipt", () => {
    const advance = provenBranchAdvance();
    expect(() => composeFollowRepoTransition(
      advance.input,
      receipt({ outcome: "deferred", deferralReason: "local-edits", progress: advance.progress }),
      proofReceipt({ relPath: "other" }),
    )).toThrow(FollowRepoTransitionIdentityMismatch);
  });

  test("the composed transition carries the exact bound identity", () => {
    const advance = provenBranchAdvance();
    expect(composeFollowRepoTransition(advance.input, receipt({ progress: advance.progress }), proofReceipt()).identity)
      .toEqual(identity);
  });
});
