/**
 * #863: the scratch-ref cleanup loops became one `git update-ref --stdin`
 * transaction each. The batch is only allowed to change the SPAWN COUNT — the
 * ref set it deletes, the namespaces it touches, and its tolerance of a ref
 * that vanished or is locked all have to match the per-ref loop it replaced.
 *
 * So the per-ref loop is reimplemented here verbatim as a differential oracle
 * and run against a twin fixture repo. Spawns are counted through the existing
 * `setGitSpawnObserver` seam — the same seam the status-performance assertions
 * use — so nothing is mocked and every git call is real.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, setGitSpawnObserver } from "../../engine/git-spawn.js";
import { deleteRefsBatch, pruneStaleScratchRefs, WIP_NS } from "./pins.js";
import { listRefs } from "./refs.js";

const HOUR_MS = 60 * 60 * 1000;

afterEach(() => setGitSpawnObserver(undefined));

/** A repo with one commit, plus whatever refs the caller names. */
async function fixture(refs: string[]): Promise<{ dir: string; head: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pins-"));
  await git(dir, ["init", "-q", "--initial-branch=main", "."]);
  await git(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  for (const ref of refs) await git(dir, ["update-ref", ref, head]);
  return { dir, head };
}

const refSet = async (dir: string): Promise<string[]> =>
  (await git(dir, ["for-each-ref", "--format=%(refname)"])).split("\n").filter(Boolean).sort();

/** The pre-#863 `cleanupRefs` body, verbatim. */
async function perRefDelete(dir: string, refs: string[]): Promise<void> {
  for (const ref of refs) await git(dir, ["update-ref", "-d", ref]).catch(() => {});
}

/** The pre-#863 `pruneStaleScratchRefs` body, verbatim. */
async function perRefPrune(dir: string, ns: string): Promise<void> {
  const out = await git(dir, ["for-each-ref", "--format=%(refname)", ns]).catch(() => "");
  const cutoff = Date.now() - HOUR_MS;
  for (const ref of out.split("\n").filter(Boolean)) {
    if (ref === ns) {
      await git(dir, ["update-ref", "-d", ref]).catch(() => {});
      continue;
    }
    const id = ref.slice(ns.length + 1).split("/")[0] ?? "";
    const epoch = Number.parseInt(id, 10);
    if (Number.isFinite(epoch) && epoch < cutoff) await git(dir, ["update-ref", "-d", ref]).catch(() => {});
  }
}

function countUpdateRefSpawns(): () => number {
  let spawns = 0;
  setGitSpawnObserver((_root, args) => {
    if (args[0] === "update-ref") spawns += 1;
  });
  return () => spawns;
}

const stale = `${WIP_NS}/${Date.now() - 2 * HOUR_MS}-dead`;
const fresh = `${WIP_NS}/${Date.now()}-live`;

test("deleting N refs spawns exactly one git process, and none for N=0", async () => {
  const { dir } = await fixture(["refs/rbox-incoming/1-aa/0", "refs/rbox-incoming/1-aa/1", "refs/rbox-incoming/1-aa/2"]);
  const refs = await listRefs(dir, "refs/rbox-incoming");
  expect(refs.length).toBe(3);

  const spawns = countUpdateRefSpawns();
  await deleteRefsBatch(dir, refs);
  expect(spawns()).toBe(1);
  expect(await listRefs(dir, "refs/rbox-incoming")).toEqual([]);

  // The empty set must not reach git at all — the old loop's zero iterations.
  await deleteRefsBatch(dir, []);
  expect(spawns()).toBe(1);
});

test("the batch deletes exactly the refs the per-ref loop deleted, and nothing outside them", async () => {
  const staged = ["refs/rbox-incoming/9-bb/0", "refs/rbox-incoming/9-bb/1"];
  const bystanders = ["refs/heads/keep", "refs/tags/keep", `${WIP_NS}/1-cc/0`, "refs/rbox-incoming-lookalike/0"];
  const old = await fixture([...staged, ...bystanders]);
  const now = await fixture([...staged, ...bystanders]);

  await perRefDelete(old.dir, await listRefs(old.dir, "refs/rbox-incoming/9-bb"));
  await deleteRefsBatch(now.dir, await listRefs(now.dir, "refs/rbox-incoming/9-bb"));

  expect(await refSet(now.dir)).toEqual(await refSet(old.dir));
  // Namespace fence, asserted absolutely and not only differentially: every
  // bystander — including the `refs/rbox-incoming`-PREFIXED lookalike outside
  // this follow's own `<id>` namespace — survives.
  for (const ref of bystanders) expect(await refSet(now.dir)).toContain(ref);
  expect(await refSet(now.dir)).not.toContain(staged[0]!);
});

test("pruneStaleScratchRefs batches, keeps the age fence, and reports its width", async () => {
  const refs = [`${stale}/0`, `${stale}/1`, `${fresh}/0`, "refs/heads/keep"];
  const old = await fixture(refs);
  const now = await fixture(refs);

  await perRefPrune(old.dir, WIP_NS);
  const spawns = countUpdateRefSpawns();
  const pruned = await pruneStaleScratchRefs(now.dir, WIP_NS);

  expect(spawns()).toBe(1);
  expect(pruned).toBe(2);
  expect(await refSet(now.dir)).toEqual(await refSet(old.dir));
  // A concurrent sibling capture's live pins and every non-scratch ref survive.
  expect(await refSet(now.dir)).toContain(`${fresh}/0`);
  expect(await refSet(now.dir)).toContain("refs/heads/keep");
});

test("a ref that vanished before the delete is tolerated, exactly as the loop tolerated it", async () => {
  const refs = ["refs/rbox-incoming/7-dd/0", "refs/rbox-incoming/7-dd/1"];
  const { dir } = await fixture(refs);
  const enumerated = await listRefs(dir, "refs/rbox-incoming");
  // Racing cleanup: something else removed one ref between listing and deleting.
  await git(dir, ["update-ref", "-d", enumerated[0]!]);

  await deleteRefsBatch(dir, [...enumerated, "refs/rbox-incoming/7-dd/never-existed"]);
  expect(await listRefs(dir, "refs/rbox-incoming")).toEqual([]);
});

test("one locked ref does not cost the others their deletion", async () => {
  // The single behavioural gap between a `--stdin` transaction and the old
  // loop: the transaction is all-or-nothing, so without the per-ref fallback a
  // lone `.lock` would strand every other staged ref until the next follow.
  const refs = ["refs/rbox-incoming/5-ee/0", "refs/rbox-incoming/5-ee/1"];
  const { dir } = await fixture(refs);
  const locked = refs[1]!;
  await fs.mkdir(path.dirname(path.join(dir, ".git", `${locked}.lock`)), { recursive: true });
  await fs.writeFile(path.join(dir, ".git", `${locked}.lock`), "");

  await deleteRefsBatch(dir, refs);
  expect(await listRefs(dir, "refs/rbox-incoming")).toEqual([locked]);

  // And once the lock clears, the same batch finishes the job — deletes are
  // idempotent, so a retry over a partially applied transaction is safe.
  await fs.rm(path.join(dir, ".git", `${locked}.lock`));
  await deleteRefsBatch(dir, refs);
  expect(await listRefs(dir, "refs/rbox-incoming")).toEqual([]);
});
