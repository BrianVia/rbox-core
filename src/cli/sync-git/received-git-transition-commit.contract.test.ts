import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { artifactBinding, readRepoIdentityV1, readStateLineageV1 } from "./repo-lineage.js";
import { prepareBaseAbsentArtifact, prepareBasePresentArtifact, readBaseAbsentArtifact, readBasePresentArtifact } from "./base-artifacts.js";
import { repoCtxFromDisk } from "./git-state.js";
import { gitRaw } from "../../engine/git-spawn.js";
import { MutationGateClosedError, ShutdownMutationGate } from "../../engine/mutation-gate.js";
import { loadRawState, saveStateUnsafeLegacyOrTest, type GitPartialApply, type SyncState } from "../config.js";
import type { GitPullOutcome } from "./apply.js";
import type { BranchTransitionWitness, RepoBaseProof } from "./base-composer.js";
import { gitIncomingKey } from "./shared.js";
import {
  partialRefsStillMatch,
  revalidateGitPartialApplies,
  settleCommittedBranchArtifacts,
  withRevalidatedGitPartialApplies,
} from "./received-git-transition-commit.js";

const exec = promisify(execFile);
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox", GIT_AUTHOR_EMAIL: "rbox@local",
  GIT_COMMITTER_NAME: "rbox", GIT_COMMITTER_EMAIL: "rbox@local",
};

const REL = "repo";
const REF = "refs/heads/topic";
const EPISODE = "9".repeat(32);

let root = "";
let repo = "";

const git = (...args: string[]) =>
  exec("git", ["-C", repo, ...args], { env }).then(({ stdout }) => stdout.toString().trim());

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-received-commit-"));
  repo = path.join(root, REL);
  await fs.mkdir(repo);
  await git("init", "-qb", "topic");
  await fs.writeFile(path.join(repo, "tracked"), "prior\n");
  await git("add", "tracked");
  await git("commit", "-qm", "prior");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function section(refs: Record<string, string>) {
  return {
    bundleEncSha: "a".repeat(64), bundleCipherSize: 1, head: `ref: ${REF}`,
    refs, refScope: "all" as const, generatedAt: "2026-07-16T12:00:00.000Z",
  };
}

function partial(appliedRefs: GitPartialApply["appliedRefs"]): GitPartialApply {
  return { incomingKey: "k1", checkoutPending: false, appliedRefs, heldRefs: {}, configApplied: true };
}

async function persist(state: SyncState): Promise<SyncState> {
  await saveStateUnsafeLegacyOrTest(root, state);
  const loaded = await loadRawState(root);
  if (!loaded) throw new Error("fixture state unavailable");
  return loaded;
}

function stateWithPartial(value: GitPartialApply | undefined): SyncState {
  return {
    stream: "stream",
    stateNonce: "1".repeat(32),
    stateRevision: 1,
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "old", files: [], gitRepos: {} },
    repoRecords: { [REL]: { repoGen: 1, sourceSeq: 1, ...(value ? { partial: value } : {}) } },
  };
}

// ── exact-ref revalidation ───────────────────────────────────────────────────

test("a direct applied ref that still holds keeps the partial marker", async () => {
  const oid = await git("rev-parse", REF);
  const outcome: GitPullOutcome = {};
  await revalidateGitPartialApplies(root, stateWithPartial(partial({ [REF]: { kind: "direct", oid } })), outcome);
  expect(outcome.partial).toBeUndefined();
});

test("every applied-ref witness kind is re-proved independently against live refs", async () => {
  const oid = await git("rev-parse", REF);
  const other = "b".repeat(40);
  const cases: Array<[string, GitPartialApply["appliedRefs"], boolean]> = [
    ["direct match", { [REF]: { kind: "direct", oid } }, true],
    ["direct moved", { [REF]: { kind: "direct", oid: other } }, false],
    ["absent stays absent", { "refs/heads/gone": { kind: "absent", artifactOid: other } }, true],
    ["absent reappeared", { [REF]: { kind: "absent", artifactOid: other } }, false],
    ["safe-ref match", { [REF]: { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: oid } }, true],
    ["safe-ref moved", { [REF]: { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: other } }, false],
    ["safe-ref absent match", { "refs/heads/gone": { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: null } }, true],
    ["symbolic match", { HEAD: { kind: "symbolic", target: REF } }, true],
    ["symbolic retargeted", { HEAD: { kind: "symbolic", target: "refs/heads/other" } }, false],
    ["present match", { [REF]: { kind: "present", oid, artifactOid: other, episode: EPISODE } }, true],
    ["present moved", { [REF]: { kind: "present", oid: other, artifactOid: other, episode: EPISODE } }, false],
  ];
  for (const [label, appliedRefs, expected] of cases) {
    expect(await partialRefsStillMatch(repo, partial(appliedRefs)), label).toBe(expected);
    const outcome: GitPullOutcome = {};
    await revalidateGitPartialApplies(root, stateWithPartial(partial(appliedRefs)), outcome);
    expect(outcome.partial, label).toEqual(expected ? undefined : { [REL]: null });
  }
});

test("this pull's partial transition, not the recorded marker, is what gets re-proved", async () => {
  const oid = await git("rev-parse", REF);
  const stale = partial({ [REF]: { kind: "direct", oid: "c".repeat(40) } });

  // A fresh transition supersedes a stale record and survives on its own proof.
  const fresh: GitPullOutcome = { partial: { [REL]: partial({ [REF]: { kind: "direct", oid } }) } };
  await revalidateGitPartialApplies(root, stateWithPartial(stale), fresh);
  expect(fresh.partial?.[REL]).not.toBeNull();

  // An explicit clear is never resurrected from the record, and the cleared
  // repository is not even a lock subject for the commit that follows.
  const provable = await persist(stateWithPartial(partial({ [REF]: { kind: "direct", oid } })));
  const cleared: GitPullOutcome = { partial: { [REL]: null } };
  const locksHeld: string[] = [];
  await withRevalidatedGitPartialApplies(root, provable, cleared, async () => {
    locksHeld.push(...(await fs.readdir(path.join(repo, ".git", "refs", "heads"))));
  });
  expect(cleared.partial).toEqual({ [REL]: null });
  expect(locksHeld).toEqual(["topic"]);
});

// ── state-CAS lock boundary ─────────────────────────────────────────────────

test("the save runs while one lock per applied ref is held under the repository common dir", async () => {
  const oid = await git("rev-parse", REF);
  const state = await persist(stateWithPartial(partial({ [REF]: { kind: "direct", oid } })));
  const observed: string[] = [];
  const saved = await withRevalidatedGitPartialApplies(root, state, {}, async () => {
    observed.push(...(await fs.readdir(path.join(repo, ".git", "refs", "heads"))));
    return "saved";
  });
  expect(saved).toBe("saved");
  expect(observed).toContain("topic.lock");
  expect(await fs.readdir(path.join(repo, ".git", "refs", "heads"))).toEqual(["topic"]);
});

test("a partial whose repository context disappeared is dropped before any lock is requested", async () => {
  const oid = await git("rev-parse", REF);
  const state = await persist(stateWithPartial(partial({ [REF]: { kind: "direct", oid } })));
  await fs.rm(repo, { recursive: true, force: true });
  const outcome: GitPullOutcome = {};
  await withRevalidatedGitPartialApplies(root, state, outcome, async () => undefined);
  expect(outcome.partial).toEqual({ [REL]: null });
});

test("an applied ref whose lock path escapes the common dir drops the partial", async () => {
  const state = await persist(stateWithPartial(partial({ "../../escape": { kind: "direct", oid: "d".repeat(40) } })));
  const outcome: GitPullOutcome = {};
  await withRevalidatedGitPartialApplies(root, state, outcome, async () => undefined);
  expect(outcome.partial).toEqual({ [REL]: null });
  expect(await fs.readdir(root)).not.toContain("escape.lock");
});

test("a lock another writer already holds drops every partial that requested it", async () => {
  const oid = await git("rev-parse", REF);
  const state = await persist(stateWithPartial(partial({ [REF]: { kind: "direct", oid } })));
  await fs.writeFile(path.join(repo, ".git", "refs", "heads", "topic.lock"), "foreign\n");
  const outcome: GitPullOutcome = {};
  await withRevalidatedGitPartialApplies(root, state, outcome, async () => undefined);
  expect(outcome.partial).toEqual({ [REL]: null });
  expect(await fs.readFile(path.join(repo, ".git", "refs", "heads", "topic.lock"), "utf8")).toBe("foreign\n");
});

test("published journals clear only after the durable save and the CAS commit marker", async () => {
  const state = await persist(stateWithPartial(undefined));
  const order: string[] = [];
  await withRevalidatedGitPartialApplies(root, state, {
    publishedJournals: [REL],
    journalCrashAt: (point) => order.push(`journal:${point}`),
  }, async () => {
    order.push("save");
  }, { afterStateCasCommitted: () => { order.push("cas-committed"); } });
  expect(order).toEqual(["save", "cas-committed", "journal:before-journal-clear"]);
});

test("a failing save leaves published journals intact", async () => {
  const state = await persist(stateWithPartial(undefined));
  const order: string[] = [];
  await expect(withRevalidatedGitPartialApplies(root, state, {
    publishedJournals: [REL],
    journalCrashAt: (point) => order.push(`journal:${point}`),
  }, async () => {
    order.push("save");
    throw new Error("state CAS refused");
  })).rejects.toThrow("state CAS refused");
  expect(order).toEqual(["save"]);
});

test("a gate closed before the commit boundary refuses the save and releases every lock", async () => {
  const oid = await git("rev-parse", REF);
  const state = await persist(stateWithPartial(partial({ [REF]: { kind: "direct", oid } })));
  const gate = new ShutdownMutationGate();
  gate.close();
  let saved = false;
  await expect(withRevalidatedGitPartialApplies(root, state, {}, async () => { saved = true; }, {
    mutationBoundary: gate,
  })).rejects.toBeInstanceOf(MutationGateClosedError);
  expect(saved).toBe(false);
  expect(await fs.readdir(path.join(repo, ".git", "refs", "heads"))).toEqual(["topic"]);
});

test("a commit boundary that refuses the transition stops the save even with no lock to hold", async () => {
  const state = await persist(stateWithPartial(undefined));
  let saved = false;
  let finished = false;
  await expect(withRevalidatedGitPartialApplies(root, state, {}, async () => { saved = true; }, {
    mutationBoundary: {
      enter: () => ({
        get abortRequested() { return false; },
        beginCommit: () => false,
        finish: () => { finished = true; },
      }),
    },
  })).rejects.toBeInstanceOf(MutationGateClosedError);
  expect(saved).toBe(false);
  expect(finished).toBe(true);
});

test("a gate closed after the journal is prepared refuses before any lock is published", async () => {
  const oid = await git("rev-parse", REF);
  const state = await persist(stateWithPartial(partial({ [REF]: { kind: "direct", oid } })));
  const gate = new ShutdownMutationGate();
  let saved = false;
  await expect(withRevalidatedGitPartialApplies(root, state, {}, async () => { saved = true; }, {
    mutationBoundary: gate,
    afterStateCasJournalPrepared: () => { gate.close(); },
  })).rejects.toBeInstanceOf(MutationGateClosedError);
  expect(saved).toBe(false);
  expect(await fs.readdir(path.join(repo, ".git", "refs", "heads"))).toEqual(["topic"]);
});

// ── branch-proof terminal revalidation ──────────────────────────────────────

async function lineageBinding(state: SyncState) {
  const ctx = await repoCtxFromDisk(repo);
  if (!ctx) throw new Error("fixture repository unavailable");
  const identity = await readRepoIdentityV1(REL, ctx.kind, {
    worktreeId: await fs.realpath(repo),
    gitDirReal: await fs.realpath(ctx.gitDir),
    commonDirReal: await fs.realpath(ctx.commonDir),
  });
  return { ctx, binding: artifactBinding(await readStateLineageV1(root, state.stream, state.stateNonce!, identity)) };
}

/** One branch witness under a locked proof that agrees with it. */
function proofFor(binding: { lineageHash: string; repositoryIdentityHash: string }, witness: BranchTransitionWitness): RepoBaseProof {
  return {
    authority: {
      kind: "pull-ref-transaction",
      lineageHash: binding.lineageHash,
      repositoryIdentityHash: binding.repositoryIdentityHash,
      incomingKey: "k1",
      branchWitnesses: { [REF]: witness },
      safeRefWitnesses: {},
    },
    lockedProof: {
      repoKind: "dir",
      effectiveRefScope: "all",
      checkoutComplete: true,
      branches: {
        [REF]: {
          liveOid: witness.kind === "present" ? witness.nextOid : null,
          witness,
          ...(witness.kind === "present" ? { reflogEpisode: witness.episode } : {}),
          artifactsClear: true, ownershipStable: true, reflogStable: true,
          currentRef: true, siblingOwned: false,
        },
      },
      safeRefs: {},
    },
  };
}

/** A committed present-P transition: BASE moved prior→next with a standing P. */
async function presentProofFixture(extra: Partial<NonNullable<SyncState["repoRecords"]>[string]> = {}) {
  const prior = await git("rev-parse", REF);
  await fs.writeFile(path.join(repo, "tracked"), "next\n");
  await git("commit", "-qam", "next");
  const next = await git("rev-parse", REF);
  const state = await persist({
    stream: "stream",
    stateNonce: "1".repeat(32),
    stateRevision: 1,
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "old", files: [], gitRepos: { [REL]: section({ [REF]: prior }) } },
    repoRecords: { [REL]: { repoGen: 1, sourceSeq: 1, base: section({ [REF]: prior }), ...extra } },
  });
  const { binding } = await lineageBinding(state);
  await git("update-ref", REF, prior, next);
  const prepared = await prepareBasePresentArtifact(repo, binding, REF, EPISODE, prior, next);
  await gitRaw(repo, ["update-ref", "--stdin", "--create-reflog", "-m", EPISODE], {
    stdin: ["start", ...prepared.transactionLines, `update ${REF} ${next} ${prior}`, "prepare", "commit", ""].join("\n"),
  });
  const read = await readBasePresentArtifact(repo, binding, REF);
  if (read.status !== "valid") throw new Error("fixture P invalid");
  const witness: BranchTransitionWitness = {
    kind: "present", ref: REF, priorOid: prior, nextOid: next, episode: EPISODE,
    lineageHash: binding.lineageHash, repositoryIdentityHash: binding.repositoryIdentityHash,
    artifactRef: read.artifact.ref, artifactOid: read.artifact.targetOid,
  };
  return { prior, next, state, binding, proof: proofFor(binding, witness) };
}

test("a branch terminal that moved between apply and the CAS is a hard failure", async () => {
  const { prior, next, state, proof } = await presentProofFixture();
  await git("update-ref", REF, prior, next);
  let saved = false;
  await expect(withRevalidatedGitPartialApplies(root, state, { repoProofs: { [REL]: proof } }, async () => { saved = true; }))
    .rejects.toThrow(`branch proof terminal moved for ${REL}:${REF}`);
  expect(saved).toBe(false);
});

test("a locked proof that disagrees with its own witness terminal is a hard failure", async () => {
  const { next, state, proof } = await presentProofFixture();
  const branches = { ...proof.lockedProof.branches };
  branches[REF] = { ...branches[REF]!, liveOid: "e".repeat(40) };
  const forged: RepoBaseProof = { ...proof, lockedProof: { ...proof.lockedProof, branches } };
  await expect(withRevalidatedGitPartialApplies(root, state, { repoProofs: { [REL]: forged } }, async () => undefined))
    .rejects.toThrow(`branch proof terminal moved for ${REL}:${REF}`);
  expect(await git("rev-parse", REF)).toBe(next);
});

test("an A-source absence witness whose artifact moved is a hard failure, and a Z-source one is not re-read", async () => {
  const prior = await git("rev-parse", REF);
  const state = await persist(stateWithPartial(undefined));
  const { binding } = await lineageBinding(state);
  const prepared = await prepareBaseAbsentArtifact(repo, binding, REF, prior);
  await gitRaw(repo, ["update-ref", "--stdin"], {
    stdin: ["start", ...prepared.transactionLines, `delete ${REF} ${prior}`, "prepare", "commit", ""].join("\n"),
  });
  const stored = await readBaseAbsentArtifact(repo, binding, REF);
  if (stored.status !== "valid") throw new Error("fixture A invalid");
  const base = {
    kind: "absent" as const, ref: REF, priorOid: prior,
    lineageHash: binding.lineageHash, repositoryIdentityHash: binding.repositoryIdentityHash,
    artifactRef: stored.artifact.ref, artifactOid: stored.artifact.targetOid,
  };
  await expect(withRevalidatedGitPartialApplies(
    root, state, { repoProofs: { [REL]: proofFor(binding, { ...base, source: "a", artifactOid: "f".repeat(40) }) } }, async () => undefined,
  )).rejects.toThrow(`branch absence artifact moved for ${REL}:${REF}`);

  await expect(withRevalidatedGitPartialApplies(
    root, state, { repoProofs: { [REL]: proofFor(binding, { ...base, source: "z", artifactOid: "f".repeat(40) }) } }, async () => "saved",
  )).resolves.toBe("saved");
});

test("an unreadable ref database carries the prior BASE and defers instead of failing the pull", async () => {
  const { prior, state, proof } = await presentProofFixture();
  const incoming = section({ [REF]: "a".repeat(40) });
  const outcome: GitPullOutcome = {
    repoProofs: { [REL]: proof },
    gitRepos: { [REL]: incoming },
    branchBaseOrigins: { [REL]: { [REF]: { v: 1, oid: prior, lineageHash: "L", kind: "pull-p", episode: EPISODE } } },
    partial: { [REL]: partial({ [REF]: { kind: "direct", oid: prior } }) },
    deferrals: { [REL]: { config: { lane: "config", deferredSince: "t0", reasonSince: "t0", lastSeen: "t0", reason: "config" } } },
  };
  await fs.writeFile(path.join(repo, ".git", "packed-refs"), "garbage\n");

  await expect(withRevalidatedGitPartialApplies(root, state, outcome, async () => "saved")).resolves.toBe("saved");

  expect(outcome.gitPendingRemote).toEqual({ [REL]: incoming });
  expect(outcome.gitRepos?.[REL]).toEqual(state.repoRecords![REL]!.base!);
  expect(outcome.branchBaseOrigins?.[REL]).toBeUndefined();
  expect(outcome.partial).toEqual({ [REL]: null });
  expect(outcome.artifactSettlementProofs).toEqual({ [REL]: proof });
  expect(outcome.repoProofs?.[REL]?.authority).toEqual({ kind: "pull-carry", lineageHash: "legacy-untrusted" });
  expect(outcome.deferrals?.[REL]).toMatchObject({
    config: { reason: "config", deferredSince: "t0" },
    apply: { lane: "apply", reason: "ref-read-unreadable", subjectKey: gitIncomingKey(incoming) },
  });
});

// ── post-CAS A/P/K settlement ───────────────────────────────────────────────

test("the carry fallback's retained proof still retires its standing P after the save", async () => {
  const { next, state, binding, proof } = await presentProofFixture();
  const settled = await settleCommittedBranchArtifacts(root, state, { artifactSettlementProofs: { [REL]: proof } });
  expect(settled.repoRecords?.[REL]?.base?.refs[REF]).toBe(next);
  expect((await readBasePresentArtifact(repo, binding, REF)).status).toBe("absent");
});

test("a settlement artifact that no longer matches its witness is a hard failure", async () => {
  const { state, proof } = await presentProofFixture();
  const witness = { ...proof.authority.branchWitnesses[REF]!, artifactOid: "f".repeat(40) } as BranchTransitionWitness;
  const forged: RepoBaseProof = {
    ...proof,
    authority: { ...proof.authority, branchWitnesses: { [REF]: witness } } as RepoBaseProof["authority"],
  };
  await expect(settleCommittedBranchArtifacts(root, state, { repoProofs: { [REL]: forged } }))
    .rejects.toThrow(`P settlement artifact mismatch for ${REL}:${REF}`);
});

test("a completed held attempt rebinds durably, against the post-settlement state", async () => {
  const attempt = {
    incomingKey: "k1", effectiveBaseIndexProjection: null, effectiveIncomingIndexProjection: null,
    incomingIndexArtifactDescriptor: "absent", localFingerprint: "fp", fingerprintVersion: "v1",
    reflogs: [], blockers: [{ provenance: "ref-plane" as const, reason: "local-commits" as const, ref: REF }],
    repoIdentity: "id", stateNonce: "1".repeat(32), baseOriginsHash: "h",
    partialDisposition: "none", at: "2026-07-16T12:00:00.000Z",
  };
  const { next, state, proof } = await presentProofFixture({
    pending: section({ [REF]: "a".repeat(40) }),
    attempt,
  });
  expect((await loadRawState(root))?.repoRecords?.[REL]?.attempt).toBeDefined();

  const settled = await settleCommittedBranchArtifacts(root, state, {
    repoProofs: { [REL]: proof },
    attempt: { [REL]: attempt },
  });

  // The rebind observes the BASE the P settlement just committed, and is itself
  // durable: an in-memory-only result would leave the stale attempt on disk.
  expect(settled.repoRecords?.[REL]?.base?.refs[REF]).toBe(next);
  expect(settled.repoRecords?.[REL]?.attempt).toBeUndefined();
  expect((await loadRawState(root))?.repoRecords?.[REL]?.attempt).toBeUndefined();
});

test("settlement refuses to mutate artifacts once the boundary gate is closed", async () => {
  const { prior, state, binding, proof } = await presentProofFixture();
  const gate = new ShutdownMutationGate();
  gate.close();
  await expect(settleCommittedBranchArtifacts(root, state, { repoProofs: { [REL]: proof } }, gate))
    .rejects.toBeInstanceOf(MutationGateClosedError);
  expect((await readBasePresentArtifact(repo, binding, REF)).status).toBe("valid");
  expect((await loadRawState(root))?.repoRecords?.[REL]?.base?.refs[REF]).toBe(prior);
});

test("a closed gate stops absence-artifact compaction, which has no inner boundary of its own", async () => {
  const prior = await git("rev-parse", REF);
  const state = await persist(stateWithPartial(undefined));
  const { binding } = await lineageBinding(state);
  const prepared = await prepareBaseAbsentArtifact(repo, binding, REF, prior);
  await gitRaw(repo, ["update-ref", "--stdin"], {
    stdin: ["start", ...prepared.transactionLines, `delete ${REF} ${prior}`, "prepare", "commit", ""].join("\n"),
  });
  const stored = await readBaseAbsentArtifact(repo, binding, REF);
  if (stored.status !== "valid") throw new Error("fixture A invalid");
  const proof = proofFor(binding, {
    kind: "absent", ref: REF, priorOid: prior,
    lineageHash: binding.lineageHash, repositoryIdentityHash: binding.repositoryIdentityHash,
    artifactRef: stored.artifact.ref, artifactOid: stored.artifact.targetOid, source: "a",
  });
  // A boundary that admits the lease but refuses the commit: the outer gate is
  // the ONLY thing standing between a closing daemon and this compaction.
  await expect(settleCommittedBranchArtifacts(root, state, { repoProofs: { [REL]: proof } }, {
    enter: () => ({
      get abortRequested() { return false; },
      beginCommit: () => false,
      finish: () => {},
    }),
  })).rejects.toBeInstanceOf(MutationGateClosedError);
  expect((await readBaseAbsentArtifact(repo, binding, REF)).status).toBe("valid");
});

test("a repository that vanished between the CAS and settlement is a hard failure", async () => {
  const { state, proof } = await presentProofFixture();
  await fs.rm(repo, { recursive: true, force: true });
  await expect(settleCommittedBranchArtifacts(root, state, { repoProofs: { [REL]: proof } })).rejects.toThrow();
});
