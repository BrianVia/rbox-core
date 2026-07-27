import { expect, test } from "bun:test";
import type { GitSection, Manifest } from "../../engine/index.js";
import type { GitResolutionPublicationReceipt } from "../config.js";
import {
  acknowledgePublishedGitTransitions,
  PublisherAckIdentityError,
  type AcceptedPublicationReceipt,
  type PublishedGitTransition,
  type PublisherAckSidecarValues,
  type PublisherAckStateWrite,
  type RepoTransitionPort,
  type SealedPublishedCandidate,
} from "./publisher-ack-transition.js";
import type { PublicationIdentity } from "./publish-candidate.js";

const IDENTITY: PublicationIdentity = { acceptedSequence: 7, capturePlanId: "capture-1", observedSequence: 7 };

function section(overrides: Partial<GitSection> = {}): GitSection {
  return { refs: { "refs/heads/main": "a".repeat(40) }, head: "refs/heads/main", refScope: "all", ...overrides } as GitSection;
}

function manifest(gitRepos?: Record<string, GitSection>): Manifest {
  return { generatedAt: "now", files: [], ...(gitRepos ? { gitRepos } : {}) };
}

function transition(overrides: Partial<PublishedGitTransition> = {}): PublishedGitTransition {
  return {
    supersededPending: [],
    resolvedPending: [],
    pending: undefined,
    removed: undefined,
    resolutions: undefined,
    repoAbsent: undefined,
    packedRefsIdentity: undefined,
    authoredCfgHashByRepo: {},
    ...overrides,
  };
}

interface Rig {
  port: RepoTransitionPort;
  writes: PublisherAckStateWrite[];
  lines: string[];
  observed: PublisherAckSidecarValues[];
}

function rigFor(
  records: RepoTransitionPort["records"] = {},
  options: { failSave?: Error } = {},
): Rig {
  const writes: PublisherAckStateWrite[] = [];
  const lines: string[] = [];
  const observed: PublisherAckSidecarValues[] = [];
  return {
    writes,
    lines,
    observed,
    port: {
      records,
      observedRepos: (values) => {
        observed.push(values);
        return [...new Set([...Object.keys(records), ...Object.keys(values.advertised ?? {})])].sort();
      },
      announce: (line) => { lines.push(line); },
      save: async (write) => {
        if (options.failSave) throw options.failSave;
        writes.push(write);
      },
    },
  };
}

function candidateFor(overrides: Partial<SealedPublishedCandidate> = {}): SealedPublishedCandidate {
  return {
    identity: IDENTITY,
    manifest: manifest({ repo: section() }),
    appliedBaseGit: undefined,
    transition: transition(),
    ...overrides,
  };
}

function acceptedFor(overrides: Partial<AcceptedPublicationReceipt> = {}): AcceptedPublicationReceipt {
  return { identity: IDENTITY, sequence: 8, ...overrides };
}

test("a matching plan and receipt advance the exact repository rows and sequence", async () => {
  const rig = rigFor({ repo: {} });
  const outcome = await acknowledgePublishedGitTransitions(
    candidateFor({
      transition: transition({
        publisherAckBindings: { repo: { lineageHash: "lin", repositoryIdentityHash: "rid", repoKind: "dir" } },
        authoredCfgHashByRepo: { repo: "cfg" },
      }),
    }),
    acceptedFor({ manifestMeta: { encManifestSha: "enc", manifestHash: "hash" } as never }),
    rig.port,
  );

  expect(outcome.kind).toBe("acknowledged");
  expect(rig.writes).toHaveLength(1);
  const write = rig.writes[0]!;
  expect(write.acceptedSequence).toBe(8);
  expect(write.observedRepos).toEqual(["repo"]);
  expect(write.authoredCfgHashByRepo).toEqual({ repo: "cfg" });
  expect(write.manifestMeta).toEqual({ encManifestSha: "enc", manifestHash: "hash" } as never);
  expect(write.values.bases).toEqual({ repo: section() });
  expect(write.values.advertised).toEqual({ repo: section() });
  expect(write.repoProofs.repo!.authority).toEqual({
    kind: "publisher-ack",
    lineageHash: "lin",
    repositoryIdentityHash: "rid",
    incomingKey: expect.any(String),
    sourceSeq: 8,
    advertisedRefs: section().refs,
  });
  expect(write.repoProofs.repo!.lockedProof).toEqual({
    repoKind: "dir",
    effectiveRefScope: "all",
    checkoutComplete: true,
    branches: {},
    safeRefs: {},
  });
  if (outcome.kind !== "acknowledged") throw new Error("unreachable");
  expect(outcome.receipt.sequence).toBe(8);
  expect(outcome.receipt.identity).toBe(IDENTITY);
  expect(outcome.receipt.observedRepos).toEqual(["repo"]);
  expect(outcome.receipt.transitionId).toBe("capture-1@8");
});

test("the published manifest itself is what the write installs", async () => {
  const rig = rigFor({ repo: {} });
  const posted = manifest({ repo: section() });
  await acknowledgePublishedGitTransitions(candidateFor({ manifest: posted }), acceptedFor(), rig.port);
  expect(rig.writes[0]!.globalManifest).toBe(posted);
});

test.each([
  ["acceptedSequence", { acceptedSequence: 9, capturePlanId: "capture-1", observedSequence: 7 }],
  ["capturePlanId", { acceptedSequence: 7, capturePlanId: "capture-2", observedSequence: 7 }],
  ["observedSequence", { acceptedSequence: 7, capturePlanId: "capture-1", observedSequence: 6 }],
])("an identity mismatch on %s performs no state transition", async (_field, identity) => {
  const rig = rigFor({ repo: {} });
  await expect(acknowledgePublishedGitTransitions(
    candidateFor(),
    acceptedFor({ identity: identity as PublicationIdentity }),
    rig.port,
  )).rejects.toBeInstanceOf(PublisherAckIdentityError);
  expect(rig.writes).toHaveLength(0);
  expect(rig.lines).toHaveLength(0);
  expect(rig.observed).toHaveLength(0);
});

test("a pending repository keeps its old BASE while the advertised lane records the commit", async () => {
  const rig = rigFor({ repo: {} });
  const oldBase = section({ refs: { "refs/heads/main": "b".repeat(40) } });
  await acknowledgePublishedGitTransitions(
    candidateFor({
      appliedBaseGit: { repo: oldBase },
      transition: transition({ pending: { repo: section() } }),
    }),
    acceptedFor(),
    rig.port,
  );
  expect(rig.writes[0]!.values.bases).toEqual({ repo: oldBase });
  expect(rig.writes[0]!.values.advertised).toEqual({ repo: section() });
  expect(rig.writes[0]!.values.pending).toEqual({ repo: section() });
});

test("a pending repository with no prior BASE advances to no BASE at all", async () => {
  const rig = rigFor({ repo: {} });
  await acknowledgePublishedGitTransitions(
    candidateFor({ transition: transition({ pending: { repo: section() } }) }),
    acceptedFor(),
    rig.port,
  );
  expect(rig.writes[0]!.values.bases).toBeUndefined();
});

test("settled pending clears exactly the partial, attempt, deferral and resolution sidecars", async () => {
  const rig = rigFor({
    repo: { deferrals: { apply: { lane: "apply", reason: "git-busy", sinceMs: 1, lastSeenMs: 1 } as never } },
    other: { deferrals: { apply: { lane: "apply", reason: "git-busy", sinceMs: 1, lastSeenMs: 1 } as never } },
  });
  await acknowledgePublishedGitTransitions(
    candidateFor({
      manifest: manifest({ repo: section(), other: section() }),
      transition: transition({
        supersededPending: ["repo"],
        pending: { repo: section(), other: section() },
        resolutions: { repo: "r", other: "o" },
      }),
    }),
    acceptedFor(),
    rig.port,
  );
  const values = rig.writes[0]!.values;
  expect(Object.keys(values.partial!)).toEqual(["repo"]);
  expect(values.partial!.repo).toBeNull();
  expect(Object.keys(values.attempt!)).toEqual(["repo"]);
  expect(values.attempt!.repo).toBeNull();
  expect(Object.keys(values.deferrals!)).toEqual(["repo"]);
  expect(values.deferrals!.repo!.apply).toMatchObject({ clear: true });
  // A superseded (not resolved) pending never retires the resolution lanes.
  expect(values.resolutionReceipt).toEqual({});
  expect(values.resolutions).toEqual({ repo: "r", other: "o" });
  expect(values.pending).toEqual({ other: section() });
});

test("a resolved pending retires its resolution lane and its receipt", async () => {
  const rig = rigFor({ repo: {} });
  await acknowledgePublishedGitTransitions(
    candidateFor({
      transition: transition({
        resolvedPending: ["repo"],
        pending: { repo: section() },
        resolutions: { repo: "r" },
      }),
    }),
    acceptedFor(),
    rig.port,
  );
  const values = rig.writes[0]!.values;
  expect(values.resolutions).toEqual({});
  expect(values.resolutionReceipt).toEqual({ repo: null });
  expect(values.pending).toEqual({});
});

test("the bounded supersession and keep-mine lines are emitted once, in sorted order", async () => {
  const rig = rigFor({});
  await acknowledgePublishedGitTransitions(
    candidateFor({
      manifest: manifest(),
      transition: transition({
        supersededPending: ["z", "a"],
        resolvedPending: ["m"],
        supersessionIdentityKeys: { a: { pending: "P", candidate: "C", composed: "K" } },
      }),
    }),
    acceptedFor(),
    rig.port,
  );
  expect(rig.lines).toEqual([
    "git-sync superseded pending a [P=P candidate=C composed=K]: local history subsumes the unapplied remote section. rbox will publish the local history instead.",
    "git-sync superseded pending z: local history subsumes the unapplied remote section. rbox will publish the local history instead.",
    "git-sync published keep-mine m: local Git state is now the acknowledged remote truth",
  ]);
});

test("a repository without an ACK binding carries its durable origin lineage forward", async () => {
  const durable = "d".repeat(64);
  const origins = {
    "refs/heads/main": { v: 1, oid: "c".repeat(40), lineageHash: durable, kind: "manual", episode: "e".repeat(32) },
  };
  const rig = rigFor({ repo: { branchBaseOrigins: origins as never } });
  await acknowledgePublishedGitTransitions(
    candidateFor({ manifest: manifest() }),
    acceptedFor(),
    rig.port,
  );
  expect(rig.writes[0]!.repoProofs.repo!.authority).toEqual({ kind: "pull-carry", lineageHash: durable });
  expect(rig.writes[0]!.values.advertised).toEqual({ repo: null });

  // Both lineages present: the durable origin outranks the plan-time ACK one.
  const contested = rigFor({ repo: { branchBaseOrigins: origins as never } });
  await acknowledgePublishedGitTransitions(
    candidateFor({
      manifest: manifest(),
      transition: transition({ publisherAckBindings: { repo: { lineageHash: "b".repeat(64), repositoryIdentityHash: "rid", repoKind: "dir" } } }),
    }),
    acceptedFor(),
    contested.port,
  );
  expect(contested.writes[0]!.repoProofs.repo!.authority).toEqual({ kind: "pull-carry", lineageHash: durable });
});

test("plan-time ACK lineage is the fallback when no durable origin exists, legacy otherwise", async () => {
  const withBinding = rigFor({ repo: {} });
  await acknowledgePublishedGitTransitions(
    candidateFor({
      manifest: manifest(),
      transition: transition({ publisherAckBindings: { repo: { lineageHash: "planned", repositoryIdentityHash: "rid", repoKind: "dir" } } }),
    }),
    acceptedFor(),
    withBinding.port,
  );
  expect(withBinding.writes[0]!.repoProofs.repo!.authority).toEqual({ kind: "pull-carry", lineageHash: "planned" });

  const bare = rigFor({ repo: {} });
  await acknowledgePublishedGitTransitions(candidateFor({ manifest: manifest() }), acceptedFor(), bare.port);
  expect(bare.writes[0]!.repoProofs.repo!.authority).toEqual({ kind: "pull-carry", lineageHash: "legacy-untrusted" });
});

test("absent branch proofs ride the publisher-ACK authority when the plan proved them", async () => {
  const rig = rigFor({ repo: {} });
  await acknowledgePublishedGitTransitions(
    candidateFor({
      transition: transition({
        publisherAckBindings: { repo: { lineageHash: "lin", repositoryIdentityHash: "rid", repoKind: "pointer" } },
        absentBranchProofs: { repo: { "refs/heads/gone": { priorOid: "d".repeat(40) } } },
      }),
    }),
    acceptedFor(),
    rig.port,
  );
  const authority = rig.writes[0]!.repoProofs.repo!.authority as { absentBranchProofs?: unknown };
  expect(authority.absentBranchProofs).toEqual({ "refs/heads/gone": { priorOid: "d".repeat(40) } });
  expect(rig.writes[0]!.repoProofs.repo!.lockedProof.repoKind).toBe("pointer");
});

test("a keep-mine state-save failure after acceptance returns accepted-state-pending, not an advanced BASE", async () => {
  const armed: GitResolutionPublicationReceipt = {
    repo: "repo", attemptedGitIncomingKey: "k", attemptedSequence: 8, confirmedReportHash: "h",
  };
  const cause = new Error("state write refused");
  const rig = rigFor({ repo: {} }, { failSave: cause });
  const outcome = await acknowledgePublishedGitTransitions(candidateFor(), acceptedFor({ armed }), rig.port);
  expect(outcome.kind).toBe("accepted-state-pending");
  if (outcome.kind !== "accepted-state-pending") throw new Error("unreachable");
  expect(outcome.publication.sequence).toBe(8);
  expect(outcome.transitionId).toBe("capture-1@8");
  expect(outcome.reason.armed).toBe(armed);
  expect(outcome.reason.cause).toBe(cause);
  expect(rig.writes).toHaveLength(0);
});

test("an ordinary state-save failure after acceptance is the same bound result with no armed authority", async () => {
  const cause = new Error("state write refused");
  const rig = rigFor({ repo: {} }, { failSave: cause });
  const outcome = await acknowledgePublishedGitTransitions(candidateFor(), acceptedFor(), rig.port);
  expect(outcome.kind).toBe("accepted-state-pending");
  if (outcome.kind !== "accepted-state-pending") throw new Error("unreachable");
  expect(outcome.reason.armed).toBeUndefined();
  expect(outcome.reason.cause).toBe(cause);
});

test("repositories are observed from both the durable rows and the committed sections", async () => {
  const rig = rigFor({ gone: {} });
  await acknowledgePublishedGitTransitions(
    candidateFor({ manifest: manifest({ fresh: section() }) }),
    acceptedFor(),
    rig.port,
  );
  expect(rig.writes[0]!.values.advertised).toEqual({ gone: null, fresh: section() });
});

test("the observed-repository question is asked with the exact values that get written", async () => {
  const rig = rigFor({ repo: {} });
  await acknowledgePublishedGitTransitions(candidateFor(), acceptedFor(), rig.port);
  expect(rig.observed).toHaveLength(1);
  expect(rig.observed[0]).toBe(rig.writes[0]!.values);
});
