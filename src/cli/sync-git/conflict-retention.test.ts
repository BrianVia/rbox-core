import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { repoCtxFromDisk, setGitSpawnObserver } from "../../engine/index.js";
import { CONFLICT_REF_PRUNE_LIMIT, CONFLICT_REF_RETENTION_MS, inspectConflictRefs, pruneConflictRefs } from "./conflict-retention.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  setGitSpawnObserver(undefined);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ repo: string; tip: string; reachable: string; youngUnreachable: string; oldUnreachable: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-conflict-retention-"));
  roots.push(repo);
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args], { env: {
    ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@local", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@local",
  }}).then(({ stdout }) => stdout.toString().trim());
  await git("init", "-qb", "main");
  await fs.writeFile(path.join(repo, "f"), "one");
  await git("add", "f");
  await git("commit", "-qm", "one");
  const reachable = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "f"), "two");
  await git("commit", "-qam", "two");
  const tree = await git("rev-parse", "HEAD^{tree}");
  const youngUnreachable = await git("commit-tree", tree, "-m", "young orphan");
  const oldUnreachable = await git("commit-tree", tree, "-m", "old orphan");
  return { repo, tip: await git("rev-parse", "HEAD"), reachable, youngUnreachable, oldUnreachable };
}

test("conflict retention prunes reachable or old refs, keeps young unreachable refs, and caps globally", async () => {
  const { repo, reachable, youngUnreachable, oldUnreachable } = await fixture();
  const now = Date.now();
  const youngTs = now - CONFLICT_REF_RETENTION_MS + 1_000;
  const oldTs = now - CONFLICT_REF_RETENTION_MS - 1_000;
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  for (let i = 0; i < 70; i++) await git("update-ref", `refs/rbox-conflict/${youngTs}/heads/reachable-${i}`, reachable);
  await git("update-ref", `refs/rbox-conflict/${youngTs}/heads/young-unreachable`, youngUnreachable);
  await git("update-ref", `refs/rbox-conflict/${oldTs}/heads/old-unreachable`, oldUnreachable);

  let invalidations = 0;
  const first = await pruneConflictRefs(repo, { nowMs: now, onBatch: () => { invalidations++; } });
  expect(first).toMatchObject({ total: 72, prunable: 71, deleted: CONFLICT_REF_PRUNE_LIMIT, indeterminate: false });
  expect(invalidations).toBe(1);
  const status = await inspectConflictRefs(repo, now);
  expect(status).toMatchObject({ total: 8, indeterminate: false });
  expect(status.prunable).toHaveLength(7);
  const second = await pruneConflictRefs(repo, { nowMs: now, onBatch: () => { invalidations++; } });
  expect(second.deleted).toBe(7);
  expect(invalidations).toBe(2);
  expect(await inspectConflictRefs(repo, now)).toMatchObject({ total: 1, prunable: [] });
});

test("empty conflict namespace costs no Git subprocess", async () => {
  const { repo } = await fixture();
  const ctx = await repoCtxFromDisk(repo);
  if (!ctx) throw new Error("missing repo context");
  let spawns = 0;
  setGitSpawnObserver(() => { spawns++; });
  expect(await inspectConflictRefs(repo, Date.now(), ctx)).toEqual({ total: 0, prunable: [], indeterminate: false });
  expect(spawns).toBe(0);
});
