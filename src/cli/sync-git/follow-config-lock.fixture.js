import { mock } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LocalBlobStore,
  buildIgnoreMatcher,
} from "../../engine/index.js";
import { captureGitState } from "./capture.js";

// A distinct module identity preserves the real implementation while the
// canonical import used by apply.ts is wrapped below.
const realReceivedConfig = await import("./received-git-config.js?fixture-real");
const calls = [];
let armed = false;
mock.module("./received-git-config.js", () => ({
  ...realReceivedConfig,
  createReceivedGitConfig(input) {
    const receiver = realReceivedConfig.createReceivedGitConfig(input);
    return {
      ...receiver,
      async applyExisting() {
        if (armed) {
          calls.push("applyExisting");
          throw new Error("follow used the unguarded received-config window");
        }
        return receiver.applyExisting();
      },
      async applyWhileCommonDirLocked() {
        if (armed) calls.push("applyWhileCommonDirLocked");
        return receiver.applyWhileCommonDirLocked();
      },
    };
  },
}));

const { applyGitSections } = await import("./apply.js");
const exec = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test",
  GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test",
  GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const git = (dir, ...args) => exec("git", ["-C", dir, ...args], { env: gitEnv })
  .then(({ stdout }) => stdout.toString().trim());
const kek = Buffer.alloc(32, 71);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-follow-config-lock-"));
const source = path.join(tmp, "source");
const workspace = path.join(tmp, "workspace");
const receiver = path.join(workspace, "repo");
const store = new LocalBlobStore(path.join(tmp, "store"));
const cfg = {
  schema: "e2ee/v1",
  remoteWorkspaceId: "ws_follow_lock",
  projectId: "root",
  deviceId: "dev_follow_lock",
  rootPath: workspace,
  remoteUrl: "https://api.test",
  token: "",
  syncGit: true,
  encrypted: true,
  kek,
};
const manifest = (section) => ({
  generatedAt: "fixture",
  files: [],
  manifestSchema: 2,
  gitRepos: { repo: section },
});

try {
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await git(source, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(source, "tracked.txt"), "base\n");
  await git(source, "add", "tracked.txt");
  await git(source, "commit", "-qm", "base");
  const base = await captureGitState(source, store, kek);
  if (!base) throw new Error("base capture failed");
  await git(workspace, "clone", "-q", source, receiver);
  await git(receiver, "remote", "remove", "origin");

  await fs.writeFile(path.join(source, "tracked.txt"), "remote\n");
  await git(source, "add", "tracked.txt");
  await git(source, "commit", "-qm", "remote");
  const captured = await captureGitState(source, store, kek);
  if (!captured) throw new Error("incoming capture failed");
  const incoming = {
    ...captured,
    config: { "remote.upstream.url": ["git@example.com:team/repo.git"] },
  };
  await fs.writeFile(path.join(receiver, "tracked.txt"), "local edit\n");
  const state = {
    stream: "fixture-stream",
    stateNonce: "a".repeat(32),
    lastSyncedSequence: 1,
    lastSyncedManifest: manifest(base),
    repoRecords: { repo: { repoGen: 1, sourceSeq: 1, base } },
  };
  calls.length = 0;
  armed = true;
  await applyGitSections(
    workspace,
    cfg,
    state,
    manifest(incoming),
    store,
    buildIgnoreMatcher(workspace),
    () => {},
    {
      oracle: {
        proveRepo: async () => ({ kind: "match" }),
        reproveRepo: async () => ({ kind: "match" }),
        receiptHash: () => "fixture-receipt",
      },
      capabilityProbe: async () => true,
      sourceGlobalSeq: 2,
    },
  );
  process.stdout.write(JSON.stringify(calls));
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
