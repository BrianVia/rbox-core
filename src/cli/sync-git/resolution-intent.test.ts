import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureGitState, LocalBlobStore, type BlobStore, type GitSection } from "../../engine/index.js";
import { git, repoCtx } from "../../engine/git/shared.js";
import type { GitResolutionBinding } from "../config.js";
import { discardedIncomingOids, finalResolutionReport, preliminaryResolutionReport, reportAuthorized, type ResolutionDiscardReport } from "./resolution-intent.js";

const roots: string[] = [];
const store = {} as BlobStore;
const kek = Buffer.alloc(32, 17);

afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

const section = (refs: Record<string, string>, extra: Partial<GitSection> = {}): GitSection => ({
  bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
  head: "ref: refs/heads/main\n", refs, refScope: "all", generatedAt: "2026-07-21T00:00:00.000Z",
  ...extra,
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-resolution-report-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "f"), "a");
  await git(root, ["add", "f"]);
  await git(root, ["commit", "-m", "a"]);
  const a = await git(root, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(root, "f"), "b");
  await git(root, ["commit", "-am", "b"]);
  const b = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["checkout", "--orphan", "other"]);
  await fs.writeFile(path.join(root, "other"), "other");
  await git(root, ["add", "other"]);
  await git(root, ["commit", "-m", "other"]);
  const unrelated = await git(root, ["rev-parse", "HEAD"]);
  return { ctx: (await repoCtx(root))!, a, b, unrelated };
}

test("design 176 directional report covers branch ancestry, exact safe refs, and pending-absent vacuity", async () => {
  const { ctx, a, b } = await fixture();
  const pending = section({ "refs/heads/main": a, "refs/tags/release": a });
  const candidate = section({ "refs/heads/main": b, "refs/heads/local-only": b, "refs/tags/release": b });
  const report = await finalResolutionReport({ ctx, pending, candidate, store, kek });
  expect(report.lanes.find((lane) => lane.lane === "branch:refs/heads/main")?.disposition).toBe("subsumed");
  expect(report.lanes.find((lane) => lane.lane === "tag:refs/tags/release")?.disposition).toBe("not-subsumed");
  expect(report.lanes.some((lane) => lane.lane.includes("local-only"))).toBe(false);
  expect(report.lanes.find((lane) => lane.lane === "index")?.disposition).toBe("subsumed");
  expect(report.forceRequired).toBe(true);
});

test("design 176 directional report distinguishes divergence and indeterminate evidence", async () => {
  const { ctx, a, unrelated } = await fixture();
  const divergent = await finalResolutionReport({
    ctx, pending: section({ "refs/heads/main": a }), candidate: section({ "refs/heads/main": unrelated }), store, kek,
  });
  expect(divergent.lanes.find((lane) => lane.lane === "branch:refs/heads/main")?.disposition).toBe("not-subsumed");
  const missing = await finalResolutionReport({
    ctx,
    pending: section({ "refs/heads/main": "f".repeat(40) }),
    candidate: section({ "refs/heads/main": unrelated }),
    store,
    kek,
  });
  expect(missing.lanes.find((lane) => lane.lane === "branch:refs/heads/main")?.disposition).toBe("indeterminate");
});

test("design 176 preliminary report projects full live evidence onto scoped capture refs", async () => {
  const { ctx, a, b } = await fixture();
  const pending = section({
    "refs/heads/main": a,
    "refs/heads/side": a,
    "refs/tags/release": a,
  });
  const binding: GitResolutionBinding = {
    stream: "stream",
    stateNonce: "a".repeat(32),
    incomingKey: "incoming",
    repoGen: 1,
    // Full show-me binding still observes the shared store's side branch/tag.
    refs: [
      ["refs/heads/main", b],
      ["refs/heads/side", b],
      ["refs/tags/release", a],
    ],
    reflogs: [],
    head: "ref: refs/heads/main\n",
    index: { kind: "absent" },
    opState: [],
    stash: [],
    oracleReceipt: null,
    config: { ownership: "unowned", read: "not-owned" },
    effectiveRefScope: "scoped",
    capturePolicy: { syncGit: true, respectGitignore: false, incremental: false },
    repoKind: "pointer",
    repositoryIdentity: "b".repeat(64),
  };
  const report = await preliminaryResolutionReport({ ctx, pending, binding, store, kek });
  expect(report.lanes.find((lane) => lane.lane === "branch:refs/heads/main")?.disposition).toBe("subsumed");
  expect(report.lanes.find((lane) => lane.lane === "branch:refs/heads/side")?.disposition).toBe("not-subsumed");
  expect(report.lanes.find((lane) => lane.lane === "tag:refs/tags/release")?.disposition).toBe("not-subsumed");
});

test("design 176 final report permits only lanes recorded by the confirmed intent", async () => {
  const { ctx, a, b } = await fixture();
  const report = await finalResolutionReport({
    ctx,
    pending: section({ "refs/heads/main": a, "refs/tags/release": a }),
    candidate: section({ "refs/heads/main": b, "refs/tags/release": b }),
    store,
    kek,
  });
  expect(reportAuthorized([], report)).toBe(false);
  expect(reportAuthorized(["tag:refs/tags/release"], report)).toBe(true);
});

test("an indeterminate lane passes only when the confirmed intent covers that exact lane, and its oids stay preserved", async () => {
  const { ctx, b, unrelated } = await fixture();
  // Field shape (2026-07-21): the pending branch oid no longer exists anywhere
  // (squash-merged PR, deleted worktree, deleted origin branch), so ancestry
  // can never be proven and the lane is permanently indeterminate.
  const missingOid = "f".repeat(40);
  const report = await finalResolutionReport({
    ctx,
    pending: section({ "refs/heads/main": b, "refs/heads/gone": missingOid }),
    candidate: section({ "refs/heads/main": b, "refs/heads/gone": unrelated }),
    store,
    kek,
  });
  expect(report.lanes.find((lane) => lane.lane === "branch:refs/heads/gone")?.disposition).toBe("indeterminate");
  expect(reportAuthorized([], report)).toBe(false);
  expect(reportAuthorized(["branch:refs/heads/main"], report)).toBe(false);
  expect(reportAuthorized(["branch:refs/heads/gone"], report)).toBe(true);
  expect(discardedIncomingOids(report)).toContain(missingOid);
});

test("indeterminate index and op-state lanes refuse even when authorized — their preservation set cannot be enumerated", () => {
  const base = { detail: "could not be proven" };
  for (const lane of ["index", "op-state"]) {
    const report = { forceRequired: true, lanes: [{ lane, disposition: "indeterminate", ...base }] } as unknown as ResolutionDiscardReport;
    expect(reportAuthorized([lane], report)).toBe(false);
  }
});

test("design 176 closed exact lanes report stash, HEAD, scope, index, op-state, config, and every discarded root", async () => {
  const { ctx, a, b, unrelated } = await fixture();
  const artifacts = new LocalBlobStore(path.join(ctx.gitDir, "resolution-artifacts"));
  await fs.writeFile(path.join(ctx.repoDir, "staged"), "incoming index\n");
  await git(ctx.repoDir, ["add", "staged"]);
  await fs.writeFile(path.join(ctx.gitDir, "MERGE_HEAD"), `${b}\n`);
  const autoMergeTree = await git(ctx.repoDir, ["rev-parse", `${a}^{tree}`]);
  await fs.writeFile(path.join(ctx.gitDir, "AUTO_MERGE"), `${autoMergeTree}\n`);
  const pendingCaptured = await captureGitState(ctx.repoDir, artifacts, kek);
  if (!pendingCaptured?.indexTree) throw new Error("pending index capture unavailable");

  await fs.writeFile(path.join(ctx.repoDir, "staged"), "local index\n");
  await git(ctx.repoDir, ["add", "staged"]);
  await fs.writeFile(path.join(ctx.gitDir, "MERGE_HEAD"), `${unrelated}\n`);
  await fs.writeFile(path.join(ctx.gitDir, "AUTO_MERGE"), `${await git(ctx.repoDir, ["rev-parse", `${unrelated}^{tree}`])}\n`);
  const candidateCaptured = await captureGitState(ctx.repoDir, artifacts, kek);
  if (!candidateCaptured?.indexTree) throw new Error("candidate index capture unavailable");

  const pending: GitSection = {
    ...pendingCaptured,
    head: `${a}\n`,
    refs: { ...pendingCaptured.refs, "refs/stash": a },
    refScope: "all",
    config: { "branch.main.remote": ["incoming"] },
  };
  const candidate: GitSection = {
    ...candidateCaptured,
    head: `${b}\n`,
    refs: { ...candidateCaptured.refs, "refs/stash": b },
    refScope: "scoped",
    config: { "branch.main.remote": ["local"] },
  };
  const report = await finalResolutionReport({ ctx, pending, candidate, store: artifacts, kek });
  for (const lane of ["stash", "head", "ref-scope", "index", "op-state", "config"]) {
    expect(report.lanes.find((entry) => entry.lane === lane)?.disposition).toBe("not-subsumed");
  }
  const roots = discardedIncomingOids(report);
  expect(roots).toContain(a);
  expect(roots).toContain(b);
  expect(roots).toContain(pending.indexTree);
  expect(roots).toContain(autoMergeTree);
});

test("design 176 discarded unmerged-index stage objects are preservation roots", async () => {
  const { ctx } = await fixture();
  const artifacts = new LocalBlobStore(path.join(ctx.gitDir, "unmerged-index-artifacts"));
  const stage1 = await git(ctx.repoDir, ["hash-object", "-w", "--stdin"], { stdin: "base blob\n" });
  const stage2 = await git(ctx.repoDir, ["hash-object", "-w", "--stdin"], { stdin: "ours blob\n" });
  const stage3 = await git(ctx.repoDir, ["hash-object", "-w", "--stdin"], { stdin: "theirs blob\n" });
  await git(ctx.repoDir, ["update-index", "--index-info"], {
    stdin: `100644 ${stage1} 1\tconflicted\n100644 ${stage2} 2\tconflicted\n100644 ${stage3} 3\tconflicted\n`,
  });
  const pending = await captureGitState(ctx.repoDir, artifacts, kek);
  if (!pending) throw new Error("unmerged pending capture unavailable");

  await git(ctx.repoDir, ["reset", "--hard", "HEAD"]);
  const candidate = await captureGitState(ctx.repoDir, artifacts, kek);
  if (!candidate) throw new Error("candidate capture unavailable");
  const report = await finalResolutionReport({ ctx, pending, candidate, store: artifacts, kek });
  expect(report.lanes.find((lane) => lane.lane === "index")?.disposition).toBe("not-subsumed");
  expect(discardedIncomingOids(report)).toEqual(expect.arrayContaining([stage1, stage2, stage3]));
});
