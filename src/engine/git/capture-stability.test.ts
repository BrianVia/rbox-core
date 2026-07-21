import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalBlobStore } from "../blobstore.js";
import { decryptFileToPath } from "../crypto.js";
import { captureGitState, stagedIndexObjectOids } from "./capture.js";
import { git } from "./shared.js";

const exec = promisify(execFile);
const KEK = Buffer.alloc(32, 23);
const ENV = {
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox@test.invalid",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox@test.invalid",
};
let root = "";
let repo = "";
let store: LocalBlobStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-capture-stability-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await exec("git", ["-C", repo, "init", "-b", "main"], { env: ENV });
  await fs.writeFile(path.join(repo, "tracked"), "one\n");
  await exec("git", ["-C", repo, "add", "tracked"], { env: ENV });
  await exec("git", ["-C", repo, "commit", "-m", "one"], { env: ENV });
  store = new LocalBlobStore(path.join(root, "store"));
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

async function scratchRefs(): Promise<string[]> {
  const out = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/rbox-wip"]);
  return out.split("\n").filter(Boolean);
}

test("design 177 pins recorded branch OIDs and refuses an unrestored ref move", async () => {
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const tree = await git(repo, ["rev-parse", "HEAD^{tree}"]);
  const captured = (await exec("git", ["-C", repo, "commit-tree", tree, "-m", "captured unrelated"], { env: ENV })).stdout.trim();
  const moved = (await exec("git", ["-C", repo, "commit-tree", tree, "-m", "replacement unrelated"], { env: ENV })).stdout.trim();
  await git(repo, ["update-ref", "refs/heads/topic", captured]);
  expect(captured).not.toBe(head);
  await expect(exec("git", ["-C", repo, "merge-base", "--is-ancestor", captured, moved], { env: ENV })).rejects.toMatchObject({ code: 1 });
  const copiedBundle = path.join(root, "captured.bundle");
  let bundlePath = "";

  await expect(captureGitState(repo, store, KEK, {
    workspaceRoot: root,
    resolution: true,
    testHooks: {
      afterRefsRecorded: async () => { await git(repo, ["update-ref", "refs/heads/topic", moved]); },
      afterScratchPins: (snapshot) => { bundlePath = snapshot.bundlePath; },
      beforeStabilityCheck: async () => { await fs.copyFile(bundlePath, copiedBundle); },
    },
  })).rejects.toThrow("your repository changed while publishing — run the command again");
  const heads = (await exec("git", ["-C", repo, "bundle", "list-heads", copiedBundle], { env: ENV })).stdout;
  expect(heads).toContain(captured);
  expect(await scratchRefs()).toEqual([]);
});

test("design 177 ambient index churn can only refuse at the endpoint and a bounded retry succeeds", async () => {
  let running = false;
  let churn: Promise<void> | undefined;
  await expect(captureGitState(repo, store, KEK, {
    workspaceRoot: root,
    resolution: true,
    testHooks: {
      afterRefsRecorded: async () => {
        await fs.writeFile(path.join(repo, "tracked"), "churn-0\n");
        await git(repo, ["add", "tracked"]);
        running = true;
        churn = (async () => {
          let n = 1;
          while (running) {
            await fs.writeFile(path.join(repo, "tracked"), `churn-${n++}\n`);
            try {
              await git(repo, ["add", "tracked"]);
            } catch (error) {
              if (!String(error).includes("index.lock")) throw error;
            }
          }
        })();
      },
      beforeStabilityCheck: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        running = false;
        await churn;
      },
    },
  })).rejects.toThrow("your repository changed while publishing — run the command again");
  const retry = await captureGitState(repo, store, KEK, { workspaceRoot: root, resolution: true });
  expect(retry).toBeDefined();
  expect(await scratchRefs()).toEqual([]);
});

test("design 177 stability endpoint rejects index, op-state, bare-root, and HEAD drift", async () => {
  const cases: Array<{ name: string; setup?: () => Promise<void>; mutate: () => Promise<void> }> = [
    {
      name: "index",
      mutate: async () => {
        await fs.writeFile(path.join(repo, "tracked"), "index-two\n");
        await git(repo, ["add", "tracked"]);
      },
    },
    {
      name: "op-add",
      mutate: async () => { await fs.writeFile(path.join(repo, ".git", "ORIG_HEAD"), `${await git(repo, ["rev-parse", "HEAD"])}\n`); },
    },
    {
      name: "op-change",
      setup: async () => { await fs.writeFile(path.join(repo, ".git", "ORIG_HEAD"), `${"1".repeat(40)}\n`); },
      mutate: async () => { await fs.writeFile(path.join(repo, ".git", "ORIG_HEAD"), `${"2".repeat(40)}\n`); },
    },
    {
      name: "op-delete",
      setup: async () => { await fs.writeFile(path.join(repo, ".git", "ORIG_HEAD"), `${"3".repeat(40)}\n`); },
      mutate: async () => { await fs.rm(path.join(repo, ".git", "ORIG_HEAD")); },
    },
    {
      name: "bare-root",
      mutate: async () => { await fs.mkdir(path.join(repo, ".git", "rebase-merge")); },
    },
    {
      name: "head",
      mutate: async () => { await fs.writeFile(path.join(repo, ".git", "HEAD"), `${await git(repo, ["rev-parse", "HEAD"])}\n`); },
    },
  ];
  for (const row of cases) {
    await row.setup?.();
    await expect(captureGitState(repo, store, KEK, {
      workspaceRoot: root,
      resolution: true,
      testHooks: { beforeStabilityCheck: row.mutate },
    }), row.name).rejects.toThrow("your repository changed while publishing — run the command again");
    await git(repo, ["reset", "--hard", "main"]).catch(() => {});
    await fs.rm(path.join(repo, ".git", "ORIG_HEAD"), { force: true });
    await fs.rm(path.join(repo, ".git", "rebase-merge"), { recursive: true, force: true });
    await fs.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(await scratchRefs()).toEqual([]);
  }
});

test("design 177 stable staged in-progress presence vetoes publication independently of equality", async () => {
  await fs.mkdir(path.join(repo, ".git", "rebase-merge"));
  await expect(captureGitState(repo, store, KEK, { workspaceRoot: root, resolution: true }))
    .rejects.toThrow("a Git operation is in progress");
  expect(await scratchRefs()).toEqual([]);
});

test("design 177 staged pseudo refs and staged-index closure, not live ABA values, root the bundle", async () => {
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const tree = await git(repo, ["rev-parse", "HEAD^{tree}"]);
  const a = (await exec("git", ["-C", repo, "commit-tree", tree, "-m", "pseudo A unrelated"], { env: ENV })).stdout.trim();
  const b = (await exec("git", ["-C", repo, "commit-tree", tree, "-m", "pseudo B unrelated"], { env: ENV })).stdout.trim();
  expect(a).not.toBe(head);
  await expect(exec("git", ["-C", repo, "merge-base", "--is-ancestor", a, head], { env: ENV })).rejects.toMatchObject({ code: 1 });
  await fs.writeFile(path.join(repo, ".git", "ORIG_HEAD"), `${a}\n`);
  await fs.writeFile(path.join(repo, "staged-only"), "staged closure\n");
  await git(repo, ["add", "staged-only"]);
  const stagedCopy = path.join(root, "staged.index");
  await fs.copyFile(path.join(repo, ".git", "index"), stagedCopy);
  const stagedOids = await stagedIndexObjectOids(repo, stagedCopy);
  let indexA = Buffer.alloc(0);
  const section = await captureGitState(repo, store, KEK, {
    workspaceRoot: root,
    resolution: true,
    testHooks: {
      afterStagedArtifacts: async () => {
        indexA = await fs.readFile(path.join(repo, ".git", "index"));
        await fs.writeFile(path.join(repo, ".git", "ORIG_HEAD"), `${b}\n`);
        await git(repo, ["read-tree", "HEAD"]);
        await fs.rm(path.join(repo, "staged-only"));
        await fs.writeFile(path.join(repo, "transient"), "transient\n");
        await git(repo, ["add", "transient"]);
      },
      afterScratchPins: async () => {
        await fs.writeFile(path.join(repo, ".git", "index"), indexA);
        await fs.writeFile(path.join(repo, ".git", "ORIG_HEAD"), `${a}\n`);
      },
    },
  });
  if (!section) throw new Error("capture returned no section");
  const encrypted = path.join(root, "bundle.enc");
  const bundle = path.join(root, "bundle");
  await fs.writeFile(encrypted, await store.get(section.bundleEncSha));
  await decryptFileToPath(encrypted, KEK, section.bundleSha, bundle, { comp: section.bundleComp, payloadSha: section.bundlePayloadSha });
  const imported = path.join(root, "imported.git");
  await exec("git", ["init", "--bare", imported], { env: ENV });
  await exec("git", ["-C", imported, "fetch", bundle, "refs/*:refs/*"], { env: ENV });
  for (const oid of stagedOids) {
    await expect(exec("git", ["-C", imported, "cat-file", "-e", `${oid}^{object}`], { env: ENV })).resolves.toBeDefined();
  }
  expect((await exec("git", ["-C", imported, "for-each-ref", "--format=%(objectname)", "refs/rbox-wip"], { env: ENV })).stdout).toContain(a);
  expect(await scratchRefs()).toEqual([]);
});

test("design 177 ordinary capture pins staged MERGE_HEAD and AUTO_MERGE across live A-B-A flips", async () => {
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const headTree = await git(repo, ["rev-parse", "HEAD^{tree}"]);
  const mergeA = (await exec("git", ["-C", repo, "commit-tree", headTree, "-m", "merge A unrelated"], { env: ENV })).stdout.trim();
  const mergeB = (await exec("git", ["-C", repo, "commit-tree", headTree, "-m", "merge B unrelated"], { env: ENV })).stdout.trim();

  const unreferencedTree = async (name: string, content: string): Promise<string> => {
    await fs.writeFile(path.join(repo, name), content);
    await git(repo, ["add", name]);
    await exec("git", ["-C", repo, "commit", "-m", `tree ${name}`], { env: ENV });
    const treeOid = await git(repo, ["rev-parse", "HEAD^{tree}"]);
    await git(repo, ["reset", "--hard", head]);
    return treeOid;
  };
  const autoA = await unreferencedTree("auto-a", "A\n");
  const autoB = await unreferencedTree("auto-b", "B\n");
  expect(autoA).not.toBe(headTree);

  for (const row of [
    { ref: "MERGE_HEAD", a: mergeA, b: mergeB },
    { ref: "AUTO_MERGE", a: autoA, b: autoB },
  ]) {
    await fs.writeFile(path.join(repo, ".git", row.ref), `${row.a}\n`);
    const captured = await captureGitState(repo, store, KEK, {
      workspaceRoot: root,
      testHooks: {
        afterStagedArtifacts: async () => { await fs.writeFile(path.join(repo, ".git", row.ref), `${row.b}\n`); },
      },
    });
    if (!captured) throw new Error("capture returned no section");
    const encrypted = path.join(root, `${row.ref}.bundle.enc`);
    const bundle = path.join(root, `${row.ref}.bundle`);
    await fs.writeFile(encrypted, await store.get(captured.bundleEncSha));
    await decryptFileToPath(encrypted, KEK, captured.bundleSha, bundle, { comp: captured.bundleComp, payloadSha: captured.bundlePayloadSha });
    const imported = path.join(root, `${row.ref}.git`);
    await exec("git", ["init", "--bare", imported], { env: ENV });
    await exec("git", ["-C", imported, "fetch", bundle, "refs/*:refs/*"], { env: ENV });
    await expect(exec("git", ["-C", imported, "cat-file", "-e", `${row.a}^{object}`], { env: ENV })).resolves.toBeDefined();
    await fs.rm(path.join(repo, ".git", row.ref));
    expect(await scratchRefs()).toEqual([]);
  }
});

test("design 177 scratch refs are cleaned when artifact upload fails", async () => {
  const failing = new LocalBlobStore(path.join(root, "failing-store"));
  failing.putFile = async () => { throw new Error("injected artifact failure"); };
  await expect(captureGitState(repo, failing, KEK, { workspaceRoot: root, resolution: true }))
    .rejects.toThrow("injected artifact failure");
  expect(await scratchRefs()).toEqual([]);
});
