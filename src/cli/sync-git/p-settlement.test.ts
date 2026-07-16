import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  artifactBinding,
  prepareBasePresentArtifact,
  readBasePresentArtifact,
  readRepoIdentityV1,
  readStateLineageV1,
  repoCtxFromDisk,
} from "../../engine/index.js";
import { gitRaw } from "../../engine/git/shared.js";
import { loadRawState, saveStateUnsafeLegacyOrTest, type SyncState } from "../config.js";
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

test("prepared-ref rejection is a typed live-movement outcome", async () => {
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

  // Bypass update-ref so the forced episode remains the reflog top. The live
  // mismatch is discovered only when Git prepares the expected-old verify.
  await fs.writeFile(path.join(ctx.commonDir, "refs", "heads", "topic"), `${prior}\n`);
  const current = await loadRawState(root);
  if (!current) throw new Error("fixture state unavailable");
  const result = await settleExactPresentArtifact({
    root,
    stream: state.stream,
    state: current,
    relPath: "repo",
    ctx,
    binding,
    p: p.artifact,
  });

  expect(result).toEqual({ status: "moved", reason: "live" });
  expect((await readBasePresentArtifact(repo, binding, ref)).status).toBe("valid");
  expect((await loadRawState(root))?.repoRecords?.repo?.base?.refs[ref]).toBe(prior);
});
