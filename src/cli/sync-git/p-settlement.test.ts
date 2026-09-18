import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { artifactBinding, readRepoIdentityV1, readStateLineageV1 } from "./repo-lineage.js";
import { prepareBasePresentArtifact, readBasePresentArtifact } from "./base-artifacts.js";
import { repoCtxFromDisk } from "./git-state.js";
import { gitRaw } from "../../engine/git-spawn.js";
import { MutationGateClosedError, ShutdownMutationGate, type MutationBoundary } from "../../engine/mutation-gate.js";
import { loadRawState, saveStateUnsafeLegacyOrTest, type GitHeldAttempt, type SyncState } from "../config.js";
import type { GitPullOutcome } from "./apply.js";
import { settleCommittedBranchArtifacts, settlementProgressLine } from "./received-git-transition-commit.js";
import { settleExactPresentArtifact } from "./p-settlement.js";

const exec = promisify(execFile);
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox",
  GIT_AUTHOR_EMAIL: "rbox@local",
  GIT_COMMITTER_NAME: "rbox",
  GIT_COMMITTER_EMAIL: "rbox@local",
};

let root = "";
let repo = "";
const ref = "refs/heads/topic";
const episode = "9".repeat(32);
const git = (...args: string[]) => exec("git", ["-C", repo, ...args], { env }).then(({ stdout }) => stdout.toString().trim());

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-p-settlement-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git("init", "-qb", "topic");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function exactSettlementFixture() {
  await fs.writeFile(path.join(repo, "tracked"), "prior\n");
  await git("add", "tracked");
  await git("commit", "-qm", "prior");
  const prior = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "tracked"), "next\n");
  await git("commit", "-qam", "next");
  const next = await git("rev-parse", "HEAD");
  const section = {
    bundleEncSha: "a".repeat(64),
    bundleCipherSize: 1,
    head: `ref: ${ref}`,
    refs: { [ref]: prior },
    refScope: "all" as const,
    generatedAt: "2026-07-16T12:00:00.000Z",
  };
  const state: SyncState = {
    stream: "stream",
    stateNonce: "1".repeat(32),
    stateRevision: 1,
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "old", files: [], gitRepos: { repo: section } },
    repoRecords: { repo: { repoGen: 1, sourceSeq: 1, base: section } },
  };
  await saveStateUnsafeLegacyOrTest(root, state);
  const ctx = await repoCtxFromDisk(repo);
  if (!ctx) throw new Error("fixture repository unavailable");
  const identity = await readRepoIdentityV1("repo", ctx.kind, {
    worktreeId: await fs.realpath(repo),
    gitDirReal: await fs.realpath(ctx.gitDir),
    commonDirReal: await fs.realpath(ctx.commonDir),
  });
  const binding = artifactBinding(await readStateLineageV1(root, state.stream, state.stateNonce!, identity));
  await git("update-ref", ref, prior, next);
  const prepared = await prepareBasePresentArtifact(repo, binding, ref, episode, prior, next);
  await gitRaw(repo, ["update-ref", "--stdin", "--create-reflog", "-m", episode], {
    stdin: ["start", ...prepared.transactionLines, `update ${ref} ${next} ${prior}`, "prepare", "commit", ""].join("\n"),
  });
  const p = await readBasePresentArtifact(repo, binding, ref);
  if (p.status !== "valid") throw new Error("fixture P invalid");
  const current = await loadRawState(root);
  if (!current) throw new Error("fixture state unavailable");
  return { prior, next, state, ctx, binding, p: p.artifact, current };
}

const heldAttempt: GitHeldAttempt = {
  incomingKey: "incoming-1",
  effectiveBaseIndexProjection: null,
  effectiveIncomingIndexProjection: null,
  incomingIndexArtifactDescriptor: "absent",
  localFingerprint: "f".repeat(64),
  fingerprintVersion: "v1",
  reflogs: [],
  blockers: [],
  repoIdentity: "i".repeat(64),
  stateNonce: "1".repeat(32),
  baseOriginsHash: "0".repeat(64),
  partialDisposition: "none",
  at: "2026-08-16T00:00:00.000Z",
};

/** The wedged shape of design 271 §1: a P whose episode CREATED its ref, so
 * `priorOid` is null and the base-shape test below cannot classify it. Only this
 * shape reaches the transaction — and its "BASE disappeared" throw — over a
 * record that never had a BASE. */
const createdRef = "refs/heads/created";

async function refCreatingPFixture() {
  const advance = await exactSettlementFixture();
  const prepared = await prepareBasePresentArtifact(repo, advance.binding, createdRef, episode, null, advance.next);
  await gitRaw(repo, ["update-ref", "--stdin", "--create-reflog", "-m", episode], {
    stdin: ["start", ...prepared.transactionLines, `create ${createdRef} ${advance.next}`, "prepare", "commit", ""].join("\n"),
  });
  const p = await readBasePresentArtifact(repo, advance.binding, createdRef);
  if (p.status !== "valid") throw new Error("fixture create-shaped P invalid");
  return { ...advance, p: p.artifact };
}

test("a create-shaped P over a record with no serialized BASE holds base-absent without opening the transaction", async () => {
  const { next, state, ctx, binding, p, current } = await refCreatingPFixture();
  const baseless: SyncState = { ...current, repoRecords: { repo: { repoGen: 1, sourceSeq: 1 } } };

  const result = await settleExactPresentArtifact({
    root, stream: state.stream, state: baseless, relPath: "repo", ctx, binding, p,
  });

  expect(result).toEqual({ status: "hold", reason: "P settlement BASE absent", code: "base-absent" });
  expect((await readBasePresentArtifact(repo, binding, createdRef)).status).toBe("valid");
  expect(await git("rev-parse", createdRef)).toBe(next);
  expect((await fs.readdir(ctx.commonDir, { recursive: true })).filter((entry) => entry.toString().endsWith(".lock"))).toEqual([]);
});

test("a repository the lineage no longer projects takes the same base-absent hold", async () => {
  const { state, ctx, binding, p, current } = await refCreatingPFixture();
  // A record-less state must also drop the legacy manifest projection, which
  // would otherwise rebuild the record (and its BASE) from gitRepos.
  const projectionless: SyncState = {
    ...current,
    repoRecords: {},
    lastSyncedManifest: { ...current.lastSyncedManifest, gitRepos: {} },
  };

  const result = await settleExactPresentArtifact({
    root, stream: state.stream, state: projectionless, relPath: "repo", ctx, binding, p,
  });

  expect(result).toEqual({ status: "hold", reason: "P settlement BASE absent", code: "base-absent" });
  expect((await readBasePresentArtifact(repo, binding, createdRef)).status).toBe("valid");
});

/** The base-absent hold is the CREATE-shaped entry only. An advancing P over a
 * BASE-less record keeps its moved/base-shape classification, which is what
 * routes it to bounded P-repair instead of a refusal. */
test("an advancing P over a BASE-less record keeps its moved/base-shape classification", async () => {
  const { state, ctx, binding, p, current } = await exactSettlementFixture();
  const baseless: SyncState = { ...current, repoRecords: { repo: { repoGen: 1, sourceSeq: 1 } } };

  const result = await settleExactPresentArtifact({
    root, stream: state.stream, state: baseless, relPath: "repo", ctx, binding, p,
  });

  expect(result).toEqual({ status: "moved", reason: "base-shape" });
});

test("an advancing P over a record-less repository also stays moved/base-shape", async () => {
  const { state, ctx, binding, p, current } = await exactSettlementFixture();
  const projectionless: SyncState = {
    ...current,
    repoRecords: {},
    lastSyncedManifest: { ...current.lastSyncedManifest, gitRepos: {} },
  };

  const result = await settleExactPresentArtifact({
    root, stream: state.stream, state: projectionless, relPath: "repo", ctx, binding, p,
  });

  expect(result).toEqual({ status: "moved", reason: "base-shape" });
});

test("a post-CAS settlement refusal defers the repository and skips its held-attempt rebind", async () => {
  const { next, state, binding, p } = await refCreatingPFixture();
  const section = state.lastSyncedManifest.gitRepos!.repo!;
  await saveStateUnsafeLegacyOrTest(root, {
    ...state,
    repoRecords: { repo: { repoGen: 1, sourceSeq: 1, pending: section, attempt: heldAttempt } },
  } as SyncState);
  const current = await loadRawState(root);
  if (!current) throw new Error("fixture state unavailable");
  const witness = {
    kind: "present" as const,
    ref: createdRef,
    priorOid: null,
    nextOid: next,
    lineageHash: binding.lineageHash,
    repositoryIdentityHash: binding.repositoryIdentityHash,
    artifactRef: p.ref,
    artifactOid: p.targetOid,
    episode,
  };
  const outcome = {
    attempt: { repo: heldAttempt },
    repoProofs: { repo: {
      authority: {
        kind: "pull-ref-transaction" as const,
        lineageHash: binding.lineageHash,
        repositoryIdentityHash: binding.repositoryIdentityHash,
        incomingKey: `p:${episode}`,
        branchWitnesses: { [createdRef]: witness },
        safeRefWitnesses: {},
      },
      lockedProof: {} as never,
    } },
  } satisfies GitPullOutcome;

  const lines: string[] = [];
  const settled = await settleCommittedBranchArtifacts(root, current, outcome, undefined, (line) => lines.push(line));

  const record = settled.repoRecords?.repo;
  expect(record?.deferrals?.apply?.reason).toBe("artifact");
  expect(record?.deferrals?.apply?.detail).toBe("the standing present-artifact could not be settled after its BASE was committed");
  // The curated detail is path-free by contract, so the RAW hold reason — the
  // only thing that tells a chronic CAS race from a never-had-BASE record —
  // survives on the daemon log and nowhere else.
  expect(lines).toEqual([`git-sync post-CAS settlement refused repo:${createdRef} — P settlement BASE absent`]);
  // The refused repository never reached a post-settlement state, so its
  // attempt must stay exactly as it was rather than be rebound.
  expect(record?.attempt).toEqual(heldAttempt);
  expect(record?.base).toBeUndefined();
  expect((await readBasePresentArtifact(repo, binding, createdRef)).status).toBe("valid");
});

test("prepared-ref rejection is a typed live-movement outcome", async () => {
  const { prior, state, ctx, binding, p, current } = await exactSettlementFixture();

  // Bypass update-ref so the forced episode remains the reflog top. The live
  // mismatch is discovered only when Git prepares the expected-old verify.
  await fs.writeFile(path.join(ctx.commonDir, "refs", "heads", "topic"), `${prior}\n`);
  const result = await settleExactPresentArtifact({
    root,
    stream: state.stream,
    state: current,
    relPath: "repo",
    ctx,
    binding,
    p,
  });

  expect(result).toEqual({ status: "moved", reason: "live" });
  expect((await readBasePresentArtifact(repo, binding, ref)).status).toBe("valid");
  expect((await loadRawState(root))?.repoRecords?.repo?.base?.refs[ref]).toBe(prior);
});

test("shutdown aborts an exact-P transaction after prepare but before commit", async () => {
  const { prior, next, state, ctx, binding, p, current } = await exactSettlementFixture();
  let abortReads = 0;
  let beganCommit = false;
  let finished = false;
  const mutationBoundary: MutationBoundary = {
    enter: () => ({
      get abortRequested() { return ++abortReads >= 2; },
      beginCommit: () => { beganCommit = true; return true; },
      finish: () => { finished = true; },
    }),
  };

  await expect(settleExactPresentArtifact({
    root, stream: state.stream, state: current, relPath: "repo", ctx, binding, p, mutationBoundary,
  })).rejects.toBeInstanceOf(MutationGateClosedError);

  expect(abortReads).toBe(2);
  expect(beganCommit).toBe(false);
  expect(finished).toBe(true);
  expect(await git("rev-parse", ref)).toBe(next);
  expect((await readBasePresentArtifact(repo, binding, ref)).status).toBe("valid");
  expect((await loadRawState(root))?.repoRecords?.repo?.base?.refs[ref]).toBe(prior);
  expect((await fs.readdir(ctx.commonDir, { recursive: true })).filter((entry) => entry.toString().endsWith(".lock"))).toEqual([]);
});

test("post-CAS branch artifact settlement remains inside its own committed lease", async () => {
  const { prior, next, state, ctx, binding, p, current } = await exactSettlementFixture();
  const lifecycle: string[] = [];
  const mutationBoundary: MutationBoundary = {
    enter: ({ phase }) => {
      lifecycle.push(`enter:${phase}`);
      return {
        get abortRequested() { return false; },
        beginCommit: (phase) => { lifecycle.push(`commit:${phase ?? "same"}`); return true; },
        finish: () => {
          lifecycle.push("finish");
        },
      };
    },
  };
  const witness = {
    kind: "present" as const,
    ref,
    priorOid: prior,
    nextOid: next,
    lineageHash: binding.lineageHash,
    repositoryIdentityHash: binding.repositoryIdentityHash,
    artifactRef: p.ref,
    artifactOid: p.targetOid,
    episode,
  };
  const outcome = {
    repoProofs: { repo: {
      authority: {
        kind: "pull-ref-transaction" as const,
        lineageHash: binding.lineageHash,
        repositoryIdentityHash: binding.repositoryIdentityHash,
        incomingKey: `p:${episode}`,
        branchWitnesses: { [ref]: witness },
        safeRefWitnesses: {},
      },
      lockedProof: {} as never,
    } },
  } satisfies GitPullOutcome;

  const settled = await settleCommittedBranchArtifacts(root, current, outcome, mutationBoundary);
  expect(settled.repoRecords?.repo?.base?.refs[ref]).toBe(next);
  expect((await readBasePresentArtifact(repo, binding, ref)).status).toBe("absent");
  expect(lifecycle[0]).toBe("enter:git-prepare");
  expect(lifecycle.at(-1)).toBe("finish");
  expect(lifecycle).toContain("commit:git-commit");
  // The outer settlement lease plus exact-P's prepared-transaction lease both
  // remain active until their protected mutation is complete.
  expect(lifecycle.filter((event) => event.startsWith("enter:")).length).toBe(2);
  expect(state.repoRecords?.repo?.base?.refs[ref]).toBe(prior);
  expect(ctx.repoDir).toBe(repo);
});

test("a gate close between state CAS release and settlement prevents artifact mutation", async () => {
  const { prior, state, binding, current } = await exactSettlementFixture();
  const gate = new ShutdownMutationGate();
  gate.close();

  await expect(settleCommittedBranchArtifacts(root, current, {
    repoProofs: { repo: {
      authority: {
        kind: "pull-ref-transaction",
        lineageHash: binding.lineageHash,
        repositoryIdentityHash: binding.repositoryIdentityHash,
        incomingKey: `p:${episode}`,
        branchWitnesses: {},
        safeRefWitnesses: {},
      },
      lockedProof: {} as never,
    } },
  }, gate)).rejects.toBeInstanceOf(MutationGateClosedError);

  expect((await readBasePresentArtifact(repo, binding, ref)).status).toBe("valid");
  expect((await loadRawState(root))?.repoRecords?.repo?.base?.refs[ref]).toBe(prior);
  expect(state.repoRecords?.repo?.base?.refs[ref]).toBe(prior);
});

test("settlement progress is named only for branch-scaled repositories, every 25 branches (#875)", () => {
  expect(settlementProgressLine("repo", 0, 3)).toBeUndefined();
  expect(settlementProgressLine("repo", 0, 256)).toBe("git-sync settling repo: 0/256 branch artifacts");
  expect(settlementProgressLine("repo", 24, 256)).toBeUndefined();
  expect(settlementProgressLine("repo", 25, 256)).toBe("git-sync settling repo: 25/256 branch artifacts");
});
