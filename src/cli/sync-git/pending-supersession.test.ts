import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  indexIdentityV2,
  LocalBlobStore,
  type BlobStore,
  type GitArtifactRef,
  type GitSection,
  type JournalRecoveryResult,
} from "../../engine/index.js";
import { cleanGitEnv, git, putGitArtifact, repoCtx } from "../../engine/git/shared.js";
import {
  gitPendingSupersedeEnabled,
  journalAllowsPendingSupersession,
  pendingSupersessionAckConverges,
  provePendingSupersession,
} from "./pending-supersession.js";

const roots: string[] = [];
const KEK = Buffer.alloc(32, 23);
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pending-proof-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "f"), "a");
  await git(root, ["add", "f"]);
  await git(root, ["commit", "-m", "a"]);
  const a = await git(root, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(root, "f"), "b");
  await git(root, ["commit", "-am", "b"]);
  const b = await git(root, ["rev-parse", "HEAD"]);
  const ctx = (await repoCtx(root))!;
  return { root, ctx, a, b };
}

function section(main: string, extra: Partial<GitSection> = {}): GitSection {
  return {
    bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
    head: "ref: refs/heads/main\n", refs: { "refs/heads/main": main }, refScope: "all",
    ...extra,
  };
}

test("ACK-composer dry-run rejects BASE-only preservation and ignores object key order", () => {
  const main = "a".repeat(40);
  const prior = "b".repeat(40);
  const binding = {
    lineageHash: "c".repeat(64),
    repositoryIdentityHash: "d".repeat(64),
    repoKind: "dir" as const,
  };
  const previous = section(main, { refs: { "refs/heads/main": main, "refs/heads/prior": prior } });
  const omitted = section(main, { refs: { "refs/heads/main": main } });
  expect(pendingSupersessionAckConverges({ previousBase: previous, candidate: omitted, binding })).toBe(false);
  expect(pendingSupersessionAckConverges({ candidate: omitted, binding })).toBe(true);

  const reordered = section(main, { refs: { "refs/heads/prior": prior, "refs/heads/main": main } });
  expect(pendingSupersessionAckConverges({ previousBase: previous, candidate: reordered, binding })).toBe(true);
});

const unusedStore = {} as BlobStore;

function withIndex(sectionValue: GitSection, artifact: GitArtifactRef): GitSection {
  return {
    ...sectionValue,
    indexSha: artifact.sha,
    indexEncSha: artifact.encSha,
    indexCipherSize: artifact.cipherSize,
    ...(artifact.comp ? { indexComp: artifact.comp } : {}),
    ...(artifact.payloadSha ? { indexPayloadSha: artifact.payloadSha } : {}),
  };
}

async function uploadArtifact(
  root: string,
  store: LocalBlobStore,
  label: string,
  source = path.join(root, ".git", "index"),
): Promise<{ ref: GitArtifactRef; identity: string | undefined; path: string }> {
  const artifactDir = path.join(root, ".git", "rbox-pending-proof-artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  const snapshot = path.join(artifactDir, label);
  await fs.copyFile(source, snapshot);
  return {
    ref: await putGitArtifact(store, KEK, snapshot, artifactDir),
    identity: await indexIdentityV2(root, snapshot),
    path: snapshot,
  };
}

async function indexFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pending-index-proof-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.mkdir(path.join(root, "keep"), { recursive: true });
  await fs.mkdir(path.join(root, "drop"), { recursive: true });
  await fs.writeFile(path.join(root, "f"), "a");
  await fs.writeFile(path.join(root, "keep", "kept"), "kept");
  await fs.writeFile(path.join(root, "drop", "nested"), "drop");
  await git(root, ["add", "f", "keep/kept", "drop/nested"]);
  await git(root, ["commit", "-m", "a"]);
  const a = await git(root, ["rev-parse", "HEAD"]);
  const store = new LocalBlobStore(path.join(root, ".git", "rbox-pending-proof-store"));
  const pendingIndex = await uploadArtifact(root, store, "pending-a.index");

  await fs.writeFile(path.join(root, "f"), "b");
  await git(root, ["commit", "-am", "b"]);
  const b = await git(root, ["rev-parse", "HEAD"]);
  const candidateIndex = await uploadArtifact(root, store, "candidate-b.index");
  const ctx = (await repoCtx(root))!;
  return { root, ctx, store, a, b, pendingIndex, candidateIndex };
}

async function gitWithStdin(root: string, args: string[], stdin: string): Promise<void> {
  const inputPath = path.join(root, ".git", `pending-proof-stdin-${Date.now()}`);
  await fs.writeFile(inputPath, stdin);
  const input = await fs.open(inputPath, "r");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["-C", root, ...args], { env: cleanGitEnv(), stdio: [input.fd, "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`)));
    });
  } finally {
    await input.close();
    await fs.rm(inputPath, { force: true });
  }
}

test("final candidate proof accepts equal/FF branches and rejects missing or non-FF lanes", async () => {
  const { root, ctx, a, b } = await fixture();
  expect(await provePendingSupersession({ ctx, pending: section(a), candidate: section(b), store: unusedStore, kek: Buffer.alloc(32) })).toBe(true);
  expect(await provePendingSupersession({
    ctx,
    pending: section(a, { refs: { "refs/heads/main": a, "refs/heads/side": a } }),
    candidate: section(b), store: unusedStore, kek: Buffer.alloc(32),
  })).toBe(false);
  await git(root, ["checkout", "--orphan", "other"]);
  await fs.writeFile(path.join(root, "g"), "other");
  await git(root, ["add", "g"]);
  await git(root, ["commit", "-m", "other"]);
  const unrelated = await git(root, ["rev-parse", "HEAD"]);
  expect(await provePendingSupersession({ ctx, pending: section(a), candidate: section(unrelated), store: unusedStore, kek: Buffer.alloc(32) })).toBe(false);
});

test("exact lanes fail closed and local replace refs cannot launder ancestry", async () => {
  const { root, ctx, a, b } = await fixture();
  const exact = section(a, {
    refs: { "refs/heads/main": a, "refs/tags/v1": a, "refs/stash": b },
    config: { "core.ignorecase": ["false"] },
  });
  expect(await provePendingSupersession({
    ctx, pending: exact,
    candidate: { ...exact, refs: { ...exact.refs, "refs/tags/v1": b } },
    store: unusedStore, kek: Buffer.alloc(32),
  })).toBe(false);
  expect(await provePendingSupersession({
    ctx, pending: exact, candidate: { ...exact, head: a }, store: unusedStore, kek: Buffer.alloc(32),
  })).toBe(false);

  await git(root, ["checkout", "--orphan", "unrelated"]);
  await fs.writeFile(path.join(root, "u"), "u");
  await git(root, ["add", "u"]);
  await git(root, ["commit", "-m", "u"]);
  const unrelated = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["replace", unrelated, b]);
  expect(await git(root, ["merge-base", "--is-ancestor", a, unrelated]).then(() => true, () => false)).toBe(true);
  expect(await provePendingSupersession({
    ctx, pending: section(a), candidate: section(unrelated), store: unusedStore, kek: Buffer.alloc(32),
  })).toBe(false);
});

test("index lane v6 (5b-a): unequal clean indexes across a fast-forward are subsumed", async () => {
  const { ctx, store, a, b, pendingIndex, candidateIndex } = await indexFixture();
  expect(pendingIndex.identity).toMatch(/^v2:[0-9a-f]{64}$/);
  expect(candidateIndex.identity).toMatch(/^v2:[0-9a-f]{64}$/);
  expect(pendingIndex.identity).not.toBe(candidateIndex.identity);

  expect(await provePendingSupersession({
    ctx,
    pending: withIndex(section(a), pendingIndex.ref),
    candidate: withIndex(section(b), candidateIndex.ref),
    store,
    kek: KEK,
  })).toBe(true);
});

test("index lane v6 (5b-b): staged pending work blocks supersession", async () => {
  const { root, ctx, store, a, b, candidateIndex } = await indexFixture();
  await git(root, ["read-tree", "--reset", a]);
  await fs.writeFile(path.join(root, "f"), "pending staged work");
  await git(root, ["add", "f"]);
  const dirtyExit = await git(root, ["diff-index", "--cached", "--quiet", a, "--"])
    .then(() => 0, (error: { code?: unknown }) => error.code);
  expect(dirtyExit).toBe(1);
  const stagedIndex = await uploadArtifact(root, store, "pending-staged.index");

  expect(await provePendingSupersession({
    ctx,
    pending: withIndex(section(a), stagedIndex.ref),
    candidate: withIndex(section(b), candidateIndex.ref),
    store,
    kek: KEK,
  })).toBe(false);
});

test("index lane v6 (5b-c): clean assume-unchanged and skip-worktree indexes block", async () => {
  for (const semanticFlag of ["assume-unchanged", "skip-worktree"] as const) {
    const { root, ctx, store, a, b, candidateIndex } = await indexFixture();
    await git(root, ["read-tree", "--reset", a]);
    await git(root, ["update-index", `--${semanticFlag}`, "f"]);
    await expect(git(root, ["diff-index", "--cached", "--quiet", a, "--"])).resolves.toBe("");
    const marker = await git(root, ["ls-files", "-v", "f"]);
    expect(semanticFlag === "assume-unchanged" ? marker.startsWith("h ") : marker.startsWith("S ")).toBe(true);
    const flaggedIndex = await uploadArtifact(root, store, `pending-${semanticFlag}.index`);

    expect(await provePendingSupersession({
      ctx,
      pending: withIndex(section(a), flaggedIndex.ref),
      candidate: withIndex(section(b), candidateIndex.ref),
      store,
      kek: KEK,
    })).toBe(false);
  }
});

test("index lane v6 (5b-c): a tree-clean sparse-directory index blocks", async () => {
  const { root, ctx, store, a, b, candidateIndex } = await indexFixture();
  await git(root, ["reset", "--hard", a]);
  await git(root, ["sparse-checkout", "init", "--cone", "--sparse-index"]);
  await git(root, ["sparse-checkout", "set", "keep"]);
  await expect(git(root, ["diff-index", "--cached", "--quiet", a, "--"])).resolves.toBe("");
  expect(await git(root, ["ls-files", "--sparse", "--stage"])).toMatch(/^040000 [0-9a-f]{40} 0\tdrop\/$/m);
  const sparseIndex = await uploadArtifact(root, store, "pending-sparse-directory.index");

  expect(await provePendingSupersession({
    ctx,
    pending: withIndex(section(a), sparseIndex.ref),
    candidate: withIndex(section(b), candidateIndex.ref),
    store,
    kek: KEK,
  })).toBe(false);
});

test("index lane v6 (5b-c): a tree-clean resolve-undo index blocks", async () => {
  const { root, ctx, store, a, b, candidateIndex } = await indexFixture();
  await git(root, ["read-tree", "--reset", a]);
  const base = await git(root, ["rev-parse", `${a}:f`]);
  const oursPath = path.join(root, ".git", "pending-proof-ours");
  const theirsPath = path.join(root, ".git", "pending-proof-theirs");
  await fs.writeFile(oursPath, "ours");
  await fs.writeFile(theirsPath, "theirs");
  const ours = await git(root, ["hash-object", "-w", oursPath]);
  const theirs = await git(root, ["hash-object", "-w", theirsPath]);
  await gitWithStdin(root, ["update-index", "--index-info"], [
    "0 0000000000000000000000000000000000000000\tf",
    `100644 ${base} 1\tf`,
    `100644 ${ours} 2\tf`,
    `100644 ${theirs} 3\tf`,
    "",
  ].join("\n"));
  await fs.writeFile(path.join(root, "f"), "a");
  await git(root, ["add", "f"]);
  await expect(git(root, ["diff-index", "--cached", "--quiet", a, "--"])).resolves.toBe("");
  expect(await git(root, ["ls-files", "--resolve-undo", "f"])).not.toBe("");
  const resolveUndoIndex = await uploadArtifact(root, store, "pending-resolve-undo.index");

  expect(await provePendingSupersession({
    ctx,
    pending: withIndex(section(a), resolveUndoIndex.ref),
    candidate: withIndex(section(b), candidateIndex.ref),
    store,
    kek: KEK,
  })).toBe(false);
});

test("index lane v6 (5b-d): exact non-main symbolic and detached pending heads resolve from P", async () => {
  const { ctx, store, a, b, pendingIndex, candidateIndex } = await indexFixture();
  expect(await provePendingSupersession({
    ctx,
    pending: withIndex(section(a, { head: "ref: refs/heads/topic\n", refs: { "refs/heads/topic": a } }), pendingIndex.ref),
    candidate: withIndex(section(b, { head: "ref: refs/heads/topic\n", refs: { "refs/heads/topic": b } }), candidateIndex.ref),
    store,
    kek: KEK,
  })).toBe(true);
  expect(await provePendingSupersession({
    ctx,
    pending: withIndex(section(a, { head: a }), pendingIndex.ref),
    candidate: withIndex(section(b, { head: a }), candidateIndex.ref),
    store,
    kek: KEK,
  })).toBe(true);
});

test("index lane v6 (5b-d): unresolved heads and corrupt or missing artifacts block", async () => {
  const { root, ctx, store, a, b, pendingIndex, candidateIndex } = await indexFixture();
  const missingOid = "f".repeat(40);
  expect(await provePendingSupersession({
    ctx,
    pending: withIndex(section(a, { head: missingOid }), pendingIndex.ref),
    candidate: withIndex(section(b, { head: missingOid }), candidateIndex.ref),
    store,
    kek: KEK,
  })).toBe(false);

  const corruptPath = path.join(root, ".git", "corrupt-index");
  await fs.writeFile(corruptPath, "not a git index");
  const corruptIndex = await uploadArtifact(root, store, "pending-corrupt.index", corruptPath);
  expect(await provePendingSupersession({
    ctx,
    pending: withIndex(section(a), corruptIndex.ref),
    candidate: withIndex(section(b), candidateIndex.ref),
    store,
    kek: KEK,
  })).toBe(false);

  const missingArtifact: GitArtifactRef = { sha: "a".repeat(64), encSha: "b".repeat(64), cipherSize: 1 };
  expect(await provePendingSupersession({
    ctx,
    pending: withIndex(section(a), missingArtifact),
    candidate: withIndex(section(b), candidateIndex.ref),
    store,
    kek: KEK,
  })).toBe(false);
});

test("index lane v6 absent-lane rule is explicit presence equality", async () => {
  const { ctx, store, a, b, pendingIndex, candidateIndex } = await indexFixture();
  expect(await provePendingSupersession({
    ctx, pending: section(a), candidate: section(b), store, kek: KEK,
  })).toBe(true);
  expect(await provePendingSupersession({
    ctx, pending: section(a), candidate: withIndex(section(b), candidateIndex.ref), store, kek: KEK,
  })).toBe(false);
  expect(await provePendingSupersession({
    ctx, pending: withIndex(section(a), pendingIndex.ref), candidate: section(b), store, kek: KEK,
  })).toBe(false);
});

test("journal gate is exhaustive over every recovery disposition", () => {
  const statuses = ["none", "rolled-back", "keep", "binding-mismatch", "defer", "human-intervened", "fresh-quarantined"] as const satisfies readonly JournalRecoveryResult["status"][];
  expect(statuses.map((status) => [status, journalAllowsPendingSupersession(status)])).toEqual([
    ["none", true], ["rolled-back", true], ["keep", true], ["binding-mismatch", true],
    ["defer", false], ["human-intervened", false], ["fresh-quarantined", false],
  ]);
});

test("pending supersession kill switch is exact-zero only", () => {
  expect(gitPendingSupersedeEnabled({})).toBe(true);
  expect(gitPendingSupersedeEnabled({ RBOX_GIT_PENDING_SUPERSEDE: "0" })).toBe(false);
  expect(gitPendingSupersedeEnabled({ RBOX_GIT_PENDING_SUPERSEDE: "false" })).toBe(true);
});
