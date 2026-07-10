import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LocalBlobStore,
  buildIgnoreMatcher,
  captureGitState,
  gitIdentity,
  gitIdentityKey,
  type GitSection,
  type Manifest,
} from "../engine/index.js";
import type { GitConfig } from "../engine/git/config-sync.js";
import type { ConfigShapeIdentity, RepoRecord, SyncState, WorkspaceConfig } from "./config.js";
import { composeStateSavePacket, observedRepoKeys } from "./sync-state.js";
import { applyGitSections, gitConfigHash } from "./sync-git.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then((r) => r.stdout.toString().trim());
const KEK = Buffer.alloc(32, 93);
const desired: GitConfig = { "remote.upstream.url": ["git@example.com:team/repo.git"] };
const configFailure = async () => ({
  status: "deferred" as const,
  attempts: 1,
  fault: { disposition: "transient" as const, reason: "candidate-error" as const },
});

let tmp = "";
let source = "";
let receiver = "";
let store: LocalBlobStore;
let base: GitSection;

async function commit(dir: string, content: string, message: string): Promise<void> {
  await fs.writeFile(path.join(dir, "tracked.txt"), content);
  await git(dir, "add", "tracked.txt");
  await git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message);
}

async function capture(dir = source): Promise<GitSection> {
  return (await captureGitState(dir, store, KEK))!;
}

function cfg(root = receiver): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_pull_93",
    projectId: "root",
    deviceId: "dev_pull_93",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: KEK,
  };
}

function manifest(section: GitSection, rel = "."): Manifest {
  return { generatedAt: "remote", files: [], manifestSchema: 2, gitRepos: { [rel]: section } };
}

function stateWith(section: GitSection | undefined, record: Partial<RepoRecord> = {}, rel = "."): SyncState {
  const repoRecord: RepoRecord = {
    repoGen: record.repoGen ?? 1,
    sourceSeq: record.sourceSeq ?? 1,
    ...(section === undefined ? {} : { base: section }),
    ...record,
  };
  return {
    stream: "test",
    stateNonce: "a".repeat(32),
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "base", files: [], ...(section === undefined ? {} : { manifestSchema: 2, gitRepos: { [rel]: section } }) },
    repoRecords: { [rel]: repoRecord },
  };
}

async function dirShape(dir = receiver): Promise<ConfigShapeIdentity> {
  const common = await fs.realpath(path.join(dir, ".git"));
  const stat = await fs.stat(common, { bigint: true });
  return {
    shape: "dir",
    commonDir: {
      realpath: common,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      birthtime: stat.birthtimeNs > 0n ? stat.birthtimeNs.toString() : "0",
    },
  };
}

async function apply(remote: GitSection, state: SyncState, options: Parameters<typeof applyGitSections>[7] = {}) {
  return applyGitSections(receiver, cfg(), state, manifest(remote), store, buildIgnoreMatcher(receiver), () => {}, options);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-config-pull-"));
  source = path.join(tmp, "source");
  receiver = path.join(tmp, "receiver");
  store = new LocalBlobStore(path.join(tmp, "store"));
  await fs.mkdir(source);
  await git(source, "init", "-q", "-b", "main");
  await commit(source, "one\n", "one");
  base = await capture();
  await git(tmp, "clone", "-q", source, receiver);
  await git(receiver, "remote", "remove", "origin");
});

afterEach(async () => fs.rm(tmp, { recursive: true, force: true }));

test("pull sync-point uses BOTH pinned ownership traces and preserves an unrelated ACK", async () => {
  const shape = await dirShape();
  const ours: GitConfig = { "remote.upstream.url": ["git@example.com:ours.git"] };
  const otherHash = gitConfigHash({ "remote.upstream.url": ["git@example.com:other.git"] });

  for (const row of [
    { name: "round-3", baseConfig: undefined, cfgSynced: gitConfigHash(ours) },
    { name: "round-4", baseConfig: ours, cfgSynced: otherHash },
  ]) {
    await git(receiver, "config", "--unset-all", "remote.upstream.url").catch(() => {});
    await git(receiver, "config", "--add", "remote.upstream.url", ours["remote.upstream.url"]![0]!);
    const baseRow = { ...base, ...(row.baseConfig === undefined ? {} : { config: row.baseConfig }) };
    const remote = { ...base, config: desired };
    const state = stateWith(baseRow, { cfgSynced: row.cfgSynced, cfgShape: shape });
    state.repoRecords!.unrelated = { repoGen: 7, sourceSeq: 1, cfgSynced: "keep-me" };
    const outcome = await apply(remote, state);

    expect(outcome.configLane?.["."]?.cfgSynced, row.name).toBe(gitConfigHash(ours));
    expect(outcome.configLane?.["."]?.cfgApplied, row.name).toBe(gitConfigHash(desired));
    const values = { bases: outcome.gitRepos, pending: outcome.gitPendingRemote, configLane: outcome.configLane };
    const packet = composeStateSavePacket(state, {
      expectedStream: state.stream,
      sourceGlobalSeq: 2,
      globalManifest: manifest(remote),
      observedRepos: observedRepoKeys(state, manifest(remote).gitRepos, values),
      values,
    });
    expect(packet.repos.find((r) => r.relPath === "unrelated")?.newRecord.cfgSynced).toBe("keep-me");
  }
});

test("cfgToken detects a manual config delete and heals it through the first unchanged shortcut", async () => {
  const remote = { ...base, config: desired };
  const first = await apply(remote, stateWith(base));
  expect(await git(receiver, "config", "--get", "remote.upstream.url")).toBe(desired["remote.upstream.url"]![0]);
  const lane = first.configLane!["."]!;
  await git(receiver, "config", "--unset-all", "remote.upstream.url");

  const healed = await apply(remote, stateWith(remote, lane));
  expect(healed.gitPendingRemote).toBeUndefined();
  expect(await git(receiver, "config", "--get", "remote.upstream.url")).toBe(desired["remote.upstream.url"]![0]);
  expect(healed.configLane?.["."]?.cfgApplied).toBe(gitConfigHash(desired));
  expect(healed.configLane?.["."]?.cfgToken).not.toEqual(lane.cfgToken);
});

test("workspace-wide legacy degradation leaves receiver config untouched and advances Git", async () => {
  const remote = { ...base, config: desired };
  let configApplyCalls = 0;
  const outcome = await apply(remote, stateWith(base), {
    disableConfigLane: true,
    applyConfig: async () => {
      configApplyCalls++;
      throw new Error("config lane must not apply");
    },
  });
  expect(configApplyCalls).toBe(0);
  expect(outcome.gitPendingRemote).toBeUndefined();
  expect(outcome.gitRepos?.["."]).toEqual(remote);
  expect(outcome.configLane).toBeUndefined();
  expect(await git(receiver, "config", "--get", "remote.upstream.url").catch(() => "missing")).toBe("missing");
});

test("config-only failure holds pending and old base through BOTH unchanged shortcuts", async () => {
  const shape = await dirShape();
  const oldLane = { cfgShape: shape, cfgApplied: "old-applied", cfgSynced: "old-synced" };
  const remoteSameGit = { ...base, config: desired };
  const first = await apply(remoteSameGit, stateWith(base, oldLane), { applyConfig: configFailure });
  expect(first.gitRepos?.["."]).toEqual(base);
  expect(first.gitPendingRemote?.["."]).toEqual(remoteSameGit);
  expect(first.configLane).toBeUndefined();

  await commit(source, "two\n", "two");
  const remoteNewGit = { ...(await capture()), config: desired };
  await fs.rm(receiver, { recursive: true, force: true });
  await git(tmp, "clone", "-q", source, receiver);
  await git(receiver, "remote", "remove", "origin");
  const convergedLane = { ...oldLane, cfgShape: await dirShape() };
  const converged = await apply(remoteNewGit, stateWith(base, convergedLane), { applyConfig: configFailure });
  expect(converged.gitRepos?.["."]).toEqual(base);
  expect(converged.gitPendingRemote?.["."]).toEqual(remoteNewGit);
  expect(converged.configLane).toBeUndefined();
});

test("combined config failure rolls ordinary Git back but clean-materialization lands pending", async () => {
  await commit(source, "two\n", "two");
  const remote = { ...(await capture()), config: desired };
  const oldHead = await git(receiver, "rev-parse", "HEAD");
  const shape = await dirShape();
  const lane = { cfgShape: shape, cfgApplied: "old", cfgSynced: "old" };

  const ordinary = await apply(remote, stateWith(base, lane), { applyConfig: configFailure });
  expect(ordinary.gitPendingRemote?.["."]).toEqual(remote);
  expect(ordinary.gitRepos?.["."]).toEqual(base);
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(oldHead);
  expect(await git(receiver, "config", "--get", "remote.upstream.url").catch(() => "missing")).toBe("missing");

  const removedKey = gitIdentityKey((await gitIdentity(receiver))!);
  const cleanState = stateWith(base, { ...lane, removedKey });
  cleanState.gitReposRemoved = { ".": removedKey };
  const clean = await apply(remote, cleanState, { applyConfig: configFailure });
  expect(clean.gitPendingRemote?.["."]).toEqual(remote);
  expect(clean.gitRepos?.["."]).toEqual(base);
  expect(clean.gitReposRemoved?.["."]).toBeUndefined();
});

test("fresh materialization uses the private helper and installs config last", async () => {
  const fresh = path.join(tmp, "fresh");
  await fs.mkdir(fresh);
  const remote = { ...base, config: desired };
  const outcome = await applyGitSections(fresh, cfg(fresh), stateWith(undefined), manifest(remote), store, buildIgnoreMatcher(fresh), () => {});
  expect(outcome.gitPendingRemote).toBeUndefined();
  expect(await git(fresh, "config", "--get", "remote.upstream.url")).toBe(desired["remote.upstream.url"]![0]);
  expect(outcome.configLane?.["."]?.cfgApplied).toBe(gitConfigHash(desired));
});

test("conflict checkpoint waits for identity resolution before applying config", async () => {
  await commit(source, "remote\n", "remote");
  const remote = { ...(await capture()), config: desired };
  await commit(receiver, "local\n", "local");
  const first = await apply(remote, stateWith(base));
  expect(first.gitNeedsResolution?.["."]).toBeDefined();
  expect(await git(receiver, "config", "--get", "remote.upstream.url").catch(() => "missing")).toBe("missing");

  const checkpoint = stateWith(remote, {
    resolutionKey: first.gitNeedsResolution!["."]!,
    ...(first.configLane?.["."] ?? {}),
  });
  checkpoint.gitNeedsResolution = { ".": first.gitNeedsResolution!["."]! };
  const held = await apply(remote, checkpoint);
  expect(held.gitNeedsResolution?.["."]).toBe(first.gitNeedsResolution!["."]!);
  expect(await git(receiver, "config", "--get", "remote.upstream.url").catch(() => "missing")).toBe("missing");

  await fs.rm(receiver, { recursive: true, force: true });
  await git(tmp, "clone", "-q", source, receiver);
  await git(receiver, "remote", "remove", "origin");
  const resolved = await apply(remote, checkpoint);
  expect(resolved.gitNeedsResolution).toBeUndefined();
  expect(await git(receiver, "config", "--get", "remote.upstream.url")).toBe(desired["remote.upstream.url"]![0]);
});

test("pinned cross-shape receiver skips config once and advances Git normally", async () => {
  const main = path.join(tmp, "main");
  const workspace = path.join(tmp, "workspace");
  const wt = path.join(workspace, "wt");
  await fs.mkdir(main);
  await fs.mkdir(workspace);
  await git(main, "init", "-q", "-b", "main");
  await commit(main, "main\n", "main");
  await git(main, "worktree", "add", "-q", "-b", "wt", wt);
  const section = await capture(main);
  const remote = { ...section, config: desired };
  const state = stateWith(section, {}, "wt");
  const logs: string[] = [];
  const outcome = await applyGitSections(workspace, cfg(workspace), state, manifest(remote, "wt"), store, buildIgnoreMatcher(workspace), (line) => logs.push(line));

  expect(outcome.gitPendingRemote).toBeUndefined();
  expect(outcome.gitRepos?.wt).toEqual(remote);
  expect(await git(main, "config", "--get", "remote.upstream.url").catch(() => "missing")).toBe("missing");
  expect(logs.filter((line) => line.includes("config skipped wt"))).toHaveLength(1);
  expect(outcome.configLane?.wt?.cfgShape?.shape).toBe("pointer");
  expect(outcome.configLane?.wt?.cfgApplied).toBeUndefined();
});
