import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalBlobStore } from "../../engine/blobstore.js";
import { importGitPackChain } from "./git-state.js";
import type { GitSection } from "../../engine/types.js";
import type { SyncRemote } from "../remote.js";
import type { WorkspaceConfig } from "../config.js";
import { capturePlannedGitSection } from "./shared.js";

const exec = promisify(execFile);
const KEK = Buffer.alloc(32, 7);
const ENV = {
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox@test.invalid",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox@test.invalid",
};
const REL = "repo";

let root = "";
let repo = "";
let store: LocalBlobStore;
let api: SyncRemote;

const cfg = {} as WorkspaceConfig;

async function commit(name: string): Promise<void> {
  await fs.writeFile(path.join(repo, name), `${name}\n`);
  await exec("git", ["-C", repo, "add", name], { env: ENV });
  await exec("git", ["-C", repo, "commit", "-m", name], { env: ENV });
}

async function capture(base: GitSection | undefined, forced: boolean): Promise<GitSection> {
  const { section } = await capturePlannedGitSection(
    root, REL, cfg, base, api, KEK, path.join(root, ".rbox", "state", "uploads"), forced,
  );
  if (!section) throw new Error("capture produced no section");
  return section;
}

async function freshReceiver(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(root, "receiver-"));
  await exec("git", ["-C", dir, "init", "-b", "main"], { env: ENV });
  return dir;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-republish-chain-"));
  repo = path.join(root, REL);
  await fs.mkdir(repo);
  await exec("git", ["-C", repo, "init", "-b", "main"], { env: ENV });
  // A large, incompressible first commit keeps later increments well under the
  // byte bound that would otherwise recompact the chain away on its own.
  await fs.writeFile(path.join(repo, "bulk.bin"), crypto.randomBytes(2 * 1024 * 1024));
  await exec("git", ["-C", repo, "add", "bulk.bin"], { env: ENV });
  await exec("git", ["-C", repo, "commit", "-m", "bulk"], { env: ENV });
  await commit("one");
  store = new LocalBlobStore(path.join(root, "store"));
  api = { blobStore: () => store } as unknown as SyncRemote;
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

test("#526: a forced capture restarts the pack chain, an ordinary one extends it", async () => {
  const genesis = await capture(undefined, false);
  expect(genesis.packChain ?? []).toEqual([]);

  await commit("two");
  const incremental = await capture(genesis, false);
  expect(incremental.packChain?.length).toBe(1);

  await commit("three");
  const republished = await capture(incremental, true);
  expect(republished.packChain ?? []).toEqual([]);
  expect(republished.bundleSha).not.toBe(incremental.bundleSha);
});

test("#526: a from-scratch receiver rejects a discontinuous chain and accepts the restart", async () => {
  const genesis = await capture(undefined, false);
  await commit("two");
  const incremental = await capture(genesis, false);

  // The savvy-core shape: the newest link is a BASIS bundle whose prerequisites
  // no earlier link in the published chain supplies.
  const discontinuous: GitSection = { ...incremental, packChain: [] };
  const stranded = await freshReceiver();
  await expect(
    importGitPackChain(stranded, discontinuous, store, KEK, await fs.mkdtemp(path.join(root, "tmp-")), "refs/rbox-incoming"),
  ).rejects.toThrow(/bundle verify failed for git pack link 0/);

  await commit("three");
  const republished = await capture(incremental, true);
  const receiver = await freshReceiver();
  const imported = await importGitPackChain(
    receiver, republished, store, KEK, await fs.mkdtemp(path.join(root, "tmp-")), "refs/rbox-incoming",
  );
  expect(imported).toEqual({ imported: 1, skipped: 0 });
  const head = (await exec("git", ["-C", repo, "rev-parse", "HEAD"], { env: ENV })).stdout.trim();
  await exec("git", ["-C", receiver, "cat-file", "-e", `${head}^{commit}`], { env: ENV });
});

test("#526: an already-converged receiver still imports the next incremental after a restart", async () => {
  const genesis = await capture(undefined, false);
  await commit("two");
  const republished = await capture(genesis, true);

  const receiver = await freshReceiver();
  await importGitPackChain(receiver, republished, store, KEK, await fs.mkdtemp(path.join(root, "tmp-")), "refs/rbox-incoming");

  await commit("three");
  const next = await capture(republished, false);
  expect(next.packChain?.length).toBe(1);
  const imported = await importGitPackChain(
    receiver, next, store, KEK, await fs.mkdtemp(path.join(root, "tmp-")), "refs/rbox-incoming",
  );
  // The restart link's tips are already present, so only the new link imports.
  expect(imported).toEqual({ imported: 1, skipped: 1 });
});
