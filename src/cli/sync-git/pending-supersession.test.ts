import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, repoCtx } from "../../engine/git/shared.js";
import type { BlobStore, GitSection, JournalRecoveryResult } from "../../engine/index.js";
import {
  gitPendingSupersedeEnabled,
  journalAllowsPendingSupersession,
  provePendingSupersession,
} from "./pending-supersession.js";

const roots: string[] = [];
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

const unusedStore = {} as BlobStore;

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
