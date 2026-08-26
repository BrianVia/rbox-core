import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitSection } from "../../engine/index.js";
import { gitRaw } from "../../engine/git-spawn.js";
import { loadRawState, saveStateUnsafeLegacyOrTest, type RepoRecord, type SyncState } from "../config.js";
import { prepareBasePresentArtifact, readBasePresentArtifact } from "../sync-git/base-artifacts.js";
import { repoCtxFromDisk, type RepoCtx } from "../sync-git/git-state.js";
import { artifactBinding, readRepoIdentityV1, readStateLineageV1, type ArtifactBinding } from "../sync-git/repo-lineage.js";
import { preflightManualPresentArtifacts } from "./resolve-artifacts.js";

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
let ctx: RepoCtx;
let binding: ArtifactBinding;
let candidate = "";
let alternate = "";

const git = (...args: string[]) => exec("git", ["-C", repo, ...args], { env }).then(({ stdout }) => stdout.toString().trim());

function section(refs: Record<string, string>): GitSection {
  return {
    bundleSha: "b".repeat(64),
    bundleEncSha: "a".repeat(64),
    bundleCipherSize: 1,
    head: "ref: refs/heads/main",
    refs,
    refScope: "all",
    generatedAt: "2026-08-25T00:00:00.000Z",
  };
}

async function stateFor(incoming: GitSection, base?: GitSection): Promise<SyncState> {
  const record: RepoRecord = { repoGen: 1, sourceSeq: 1, pending: incoming };
  if (base) record.base = base;
  const state: SyncState = {
    stream: "stream",
    stateNonce: "1".repeat(32),
    stateRevision: 1,
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "old", files: [], gitRepos: {} },
    repoRecords: { repo: record },
  };
  await saveStateUnsafeLegacyOrTest(root, state);
  return state;
}

async function createReceipt(ref: string, digit: string): Promise<void> {
  const episode = digit.repeat(32);
  const prepared = await prepareBasePresentArtifact(repo, binding, ref, episode, null, candidate);
  await gitRaw(repo, ["update-ref", "--stdin", "--create-reflog", "-m", episode], {
    stdin: ["start", ...prepared.transactionLines, `create ${ref} ${candidate}`, "prepare", "commit", ""].join("\n"),
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-resolve-artifacts-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git("init", "-qb", "main");
  await fs.writeFile(path.join(repo, "tracked"), "candidate\n");
  await git("add", "tracked");
  await git("commit", "-qm", "candidate");
  candidate = await git("rev-parse", "HEAD");
  alternate = await git("commit-tree", await git("rev-parse", "HEAD^{tree}"), "-p", candidate, "-m", "alternate");
  const found = await repoCtxFromDisk(repo);
  if (!found) throw new Error("fixture repository unavailable");
  ctx = found;
  const identity = await readRepoIdentityV1("repo", ctx.kind, {
    worktreeId: await fs.realpath(repo),
    gitDirReal: await fs.realpath(ctx.gitDir),
    commonDirReal: await fs.realpath(ctx.commonDir),
  });
  binding = artifactBinding(await readStateLineageV1(root, "stream", "1".repeat(32), identity));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("matching CREATE P becomes a manual landing receipt", async () => {
  const ref = "refs/heads/created";
  const incoming = section({ "refs/heads/main": candidate, [ref]: candidate });
  const state = await stateFor(incoming);
  await createReceipt(ref, "2");

  const result = await preflightManualPresentArtifacts({ root, rel: "repo", ctx, state, incoming });

  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0]).toMatchObject({ payload: { ref, priorOid: null, nextOid: candidate } });
});

test("live receipt ref mismatch refuses without entering repair", async () => {
  const ref = "refs/heads/live-moved";
  const incoming = section({ "refs/heads/main": candidate, [ref]: candidate });
  const state = await stateFor(incoming);
  await createReceipt(ref, "3");
  await fs.writeFile(path.join(ctx.commonDir, ref), `${alternate}\n`);

  const result = await preflightManualPresentArtifacts({ root, rel: "repo", ctx, state, incoming });

  expect(result).toMatchObject({ status: "hold" });
  if (result.status !== "hold") return;
  expect(result.reason).toContain(ref);
  expect(result.reason).toContain(`live ${alternate} != nextOid ${candidate}`);
  expect((await loadRawState(root))?.repoRecords?.repo?.partial?.pRepaired).toBeUndefined();
  expect((await readBasePresentArtifact(repo, binding, ref)).status).toBe("valid");
});

test("incoming receipt mismatch refuses with both OIDs", async () => {
  const ref = "refs/heads/incoming-moved";
  const incoming = section({ "refs/heads/main": candidate, [ref]: alternate });
  const state = await stateFor(incoming);
  await createReceipt(ref, "4");

  const result = await preflightManualPresentArtifacts({ root, rel: "repo", ctx, state, incoming });

  expect(result).toMatchObject({ status: "hold" });
  if (result.status !== "hold") return;
  expect(result.reason).toContain(ref);
  expect(result.reason).toContain(`incoming ${alternate} != nextOid ${candidate}`);
});

test("one mismatching receipt refuses the full standing-P set", async () => {
  const matching = "refs/heads/matching";
  const mismatching = "refs/heads/mismatching";
  const incoming = section({ "refs/heads/main": candidate, [matching]: candidate, [mismatching]: alternate });
  const state = await stateFor(incoming);
  await createReceipt(matching, "5");
  await createReceipt(mismatching, "6");

  const result = await preflightManualPresentArtifacts({ root, rel: "repo", ctx, state, incoming });

  expect(result).toMatchObject({ status: "hold" });
  if (result.status !== "hold") return;
  expect(result.reason).toContain(mismatching);
  expect(result.reason).not.toContain(`standing P for ${matching}`);
});

test("WITH-BASE CREATE P keeps the existing exact-settlement path", async () => {
  const ref = "refs/heads/created";
  const incoming = section({ "refs/heads/main": candidate, [ref]: candidate });
  const base = section({ "refs/heads/main": candidate });
  const state = await stateFor(incoming, base);
  await createReceipt(ref, "7");

  const result = await preflightManualPresentArtifacts({ root, rel: "repo", ctx, state, incoming });

  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.receipts).toEqual([]);
  expect(result.state.repoRecords?.repo?.base?.refs[ref]).toBe(candidate);
  expect((await readBasePresentArtifact(repo, binding, ref)).status).toBe("absent");
});
