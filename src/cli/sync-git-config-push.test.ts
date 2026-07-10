import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalBlobStore, buildIgnoreMatcher, gitIdentity, gitIdentityKey, type GitSection } from "../engine/index.js";
import type { GitConfig } from "../engine/git/config-sync.js";
import { gitRaw } from "../engine/git/shared.js";
import type { SyncState, WorkspaceConfig } from "./config.js";
import type { SyncRemote } from "./remote.js";
import {
  GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS,
  gitConfigHash,
  gitDivergenceStatus,
  planGitSections,
  shouldPublishGitConfig,
} from "./sync-git.js";

const exec = promisify(execFile);
const runGit = (root: string, ...args: string[]) => exec("git", ["-C", root, ...args]).then((result) => result.stdout.toString().trim());

let root = "";
let cfg: WorkspaceConfig;
let baseSection: GitSection;

const remote = {} as SyncRemote; // carry-only fixtures never touch the blob API

function stateWith(section: GitSection, cfgSynced?: string): SyncState {
  return {
    stream: "test",
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "", files: [], manifestSchema: 2, gitRepos: { ".": section } },
    repoRecords: {
      ".": {
        repoGen: 1,
        sourceSeq: 1,
        base: section,
        ...(cfgSynced === undefined ? {} : { cfgSynced }),
      },
    },
  };
}

async function plan(section = baseSection, cfgSynced?: string) {
  return planGitSections(root, cfg, stateWith(section, cfgSynced), remote, new Set(), buildIgnoreMatcher(root));
}

async function trustCache(): Promise<void> {
  const cachePath = path.join(root, ".rbox", "state", "git-divergence.json");
  const cache = JSON.parse(await fs.readFile(cachePath, "utf8")) as { repos?: Record<string, { writtenAtMs?: number }> };
  for (const entry of Object.values(cache.repos ?? {})) {
    entry.writtenAtMs = Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 5_000;
  }
  await fs.writeFile(cachePath, JSON.stringify(cache));
}

function captureRemote(): SyncRemote {
  const store = new LocalBlobStore(path.join(root, ".rbox", "test-config-capture-blobs"));
  return { blobStore: () => store } as SyncRemote;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-config-push-"));
  await runGit(root, "init", "-q");
  await runGit(root, "config", "user.email", "test@example.com");
  await runGit(root, "config", "user.name", "Test");
  await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
  await runGit(root, "add", "tracked.txt");
  await runGit(root, "commit", "-qm", "initial");
  const identity = (await gitIdentity(root))!;
  baseSection = {
    ...identity,
    bundleSha: "a".repeat(64),
    bundleEncSha: "b".repeat(64),
    bundleCipherSize: 1,
    generatedAt: "2026-07-09T00:00:00.000Z",
  };
  cfg = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_test",
    projectId: "root",
    deviceId: "dev_test",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: Buffer.alloc(32, 7),
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("design 93 §6 publish predicate truth table distinguishes presence, edits, and our sync point", () => {
  const empty: GitConfig = {};
  const a: GitConfig = { "remote.origin.url": ["git@example.com:a.git"] };
  const b: GitConfig = { "remote.origin.url": ["git@example.com:b.git"] };
  const ah = { hash: gitConfigHash(a), nonEmpty: true };
  const bh = { hash: gitConfigHash(b), nonEmpty: true };
  const emptyHash = { hash: gitConfigHash(empty), nonEmpty: false };

  expect(shouldPublishGitConfig(undefined, ah, undefined)).toBe(true); // presence
  expect(shouldPublishGitConfig(undefined, emptyHash, undefined)).toBe(false);
  expect(shouldPublishGitConfig(a, ah, undefined)).toBe(false); // unchanged
  expect(shouldPublishGitConfig(a, bh, undefined)).toBe(true); // edit, unset marker
  expect(shouldPublishGitConfig(a, bh, bh.hash)).toBe(false); // our already-authored edit
  expect(shouldPublishGitConfig(a, emptyHash, undefined)).toBe(true); // publish removal to {}
});

test("trusted fast carry cannot hide the presence rule and authorship is wire-exact", async () => {
  await runGit(root, "remote", "add", "origin", "git@example.com:repo.git");

  const slow = await plan();
  expect(slow.gitRepos?.["."]?.config?.["remote.origin.url"]).toEqual(["git@example.com:repo.git"]);
  expect(slow.authoredCfgHashByRepo["."]).toBe(gitConfigHash(slow.gitRepos!["."]!.config!));

  await trustCache();
  const cached = await plan();
  expect(cached.gitPlanStats?.fpHits).toBe(0); // due presence falls through for wire bytes
  expect(cached.gitRepos?.["."]?.config?.["remote.origin.url"]).toEqual(["git@example.com:repo.git"]);
  expect(cached.authoredCfgHashByRepo["."]).toBe(gitConfigHash(cached.gitRepos!["."]!.config!));
});

test("workspace-wide legacy degradation carries the base config without reading or authoring the lane", async () => {
  const oldConfig: GitConfig = { "remote.origin.url": ["git@example.com:old.git"] };
  const based = { ...baseSection, config: oldConfig };
  await runGit(root, "remote", "add", "origin", "git@example.com:new.git");
  const degraded = await planGitSections(
    root,
    cfg,
    stateWith(based),
    remote,
    new Set(),
    buildIgnoreMatcher(root),
    undefined,
    undefined,
    {
      disableConfigLane: true,
      gitConfigRunner: async () => { throw new Error("config lane must not be read"); },
    }
  );
  expect(degraded.gitRepos?.["."]?.config).toEqual(oldConfig);
  expect(degraded.authoredCfgHashByRepo).toEqual({});
});

test("over-bounds config carries each host base verbatim with no authorship or oscillation", async () => {
  for (let i = 0; i < 65; i++) {
    await runGit(root, "config", `remote.r${i}.url`, `git@example.com:r${i}.git`);
  }
  const hostA = { ...baseSection, config: { "remote.origin.url": ["git@example.com:a.git"] } };
  const hostB = { ...baseSection, config: { "remote.origin.url": ["git@example.com:b.git"] } };

  for (const base of [hostA, hostB, hostA]) {
    const result = await plan(base);
    expect(result.gitRepos?.["."]).toEqual(base);
    expect(result.authoredCfgHashByRepo).toEqual({});
    expect(result.changed).toBe(false);
    expect(result.deferred.some((item) => item.reason.includes("over wire bounds"))).toBe(true);
  }
});

test("status mirrors presence publication and missing config is indeterminate, never zero", async () => {
  await runGit(root, "remote", "add", "origin", "git@example.com:repo.git");
  const state = stateWith(baseSection);
  const matcher = buildIgnoreMatcher(root);
  const publish = await planGitSections(root, cfg, state, remote, new Set(), matcher);
  const status = await gitDivergenceStatus(root, cfg, state, matcher);
  expect(status.count).toBe(1);
  expect(status.configChecking).toEqual([]);
  expect(publish.authoredCfgHashByRepo["."]).toBeDefined();

  await fs.unlink(path.join(root, ".git", "config"));
  const indeterminate = await gitDivergenceStatus(root, cfg, state, buildIgnoreMatcher(root));
  expect(indeterminate.count).toBeGreaterThanOrEqual(1);
  expect(indeterminate.configChecking).toContain(".");
});

test("legacy cache version is discarded and forces one slow pass", async () => {
  const first = await plan();
  expect(first.gitPlanStats?.spawnedRepos).toBe(1);
  const cachePath = path.join(root, ".rbox", "state", "git-divergence.json");
  const legacy = JSON.parse(await fs.readFile(cachePath, "utf8")) as { version: number };
  legacy.version = 3;
  await fs.writeFile(cachePath, JSON.stringify(legacy));

  const migrated = await plan();
  expect(migrated.gitPlanStats?.spawnedRepos).toBe(1);
  expect((JSON.parse(await fs.readFile(cachePath, "utf8")) as { version: number }).version).toBe(4);
});

test("non-publishing coverage rows carry verbatim or drop structurally with no authorship", async () => {
  await runGit(root, "remote", "add", "origin", "git@example.com:local.git");
  const base = { ...baseSection, config: { "remote.origin.url": ["git@example.com:base.git"] } };

  const pendingState = stateWith(base);
  pendingState.gitPendingRemote = { ".": base };
  pendingState.repoRecords!["."]!.pending = base;
  const pending = await planGitSections(root, cfg, pendingState, remote, new Set(), buildIgnoreMatcher(root));
  expect(pending.gitRepos?.["."]).toEqual(base);
  expect(pending.authoredCfgHashByRepo).toEqual({});

  const resolutionState = stateWith(base);
  resolutionState.gitNeedsResolution = { ".": gitIdentityKey((await gitIdentity(root))!) };
  resolutionState.repoRecords!["."]!.resolutionKey = resolutionState.gitNeedsResolution["."];
  const resolution = await planGitSections(root, cfg, resolutionState, remote, new Set(), buildIgnoreMatcher(root));
  expect(resolution.gitRepos?.["."]).toEqual(base);
  expect(resolution.authoredCfgHashByRepo).toEqual({});

  await fs.writeFile(path.join(root, ".git", "config.lock"), "busy");
  const busy = await plan(base);
  expect(busy.gitRepos?.["."]).toEqual(base);
  expect(busy.authoredCfgHashByRepo).toEqual({});
  await fs.unlink(path.join(root, ".git", "config.lock"));

  const forced = await planGitSections(root, cfg, stateWith(base), remote, new Set(["."]), buildIgnoreMatcher(root));
  expect(forced.gitRepos?.["."]).toBeUndefined();
  expect(forced.authoredCfgHashByRepo).toEqual({});

  const head = await runGit(root, "rev-parse", "HEAD");
  await fs.writeFile(path.join(root, ".git", "shallow"), `${head}\n`);
  const structural = await plan(base);
  expect(structural.gitRepos?.["."]).toBeUndefined();
  expect(structural.authoredCfgHashByRepo).toEqual({});
  await fs.unlink(path.join(root, ".git", "shallow"));

  await fs.rename(path.join(root, ".git"), path.join(root, ".git-hidden"));
  const undiscoverable = await plan(base);
  expect(undiscoverable.gitRepos?.["."]).toEqual(base);
  expect(undiscoverable.authoredCfgHashByRepo).toEqual({});
  await fs.rename(path.join(root, ".git-hidden"), path.join(root, ".git"));

  await fs.rm(path.join(root, ".git"), { recursive: true, force: true });
  await runGit(root, "init", "-q");
  const empty = await plan(base);
  expect(empty.gitRepos?.["."]).toEqual(base);
  expect(empty.authoredCfgHashByRepo).toEqual({});
});

test("in-tree linked pointer is non-owned: late policy skip removes provisional config authorship", async () => {
  await runGit(root, "remote", "add", "origin", "git@example.com:local.git");
  await runGit(root, "worktree", "add", "-qb", "linked", "linked");
  const linkedIdentity = (await gitIdentity(path.join(root, "linked")))!;
  const linkedBase: GitSection = {
    ...linkedIdentity,
    bundleSha: "c".repeat(64),
    bundleEncSha: "d".repeat(64),
    bundleCipherSize: 1,
    generatedAt: "2026-07-09T00:00:00.000Z",
  };
  const state: SyncState = {
    stream: "test",
    lastSyncedSequence: 1,
    lastSyncedManifest: {
      generatedAt: "",
      files: [],
      manifestSchema: 2,
      gitRepos: { ".": baseSection, linked: linkedBase },
    },
    repoRecords: {
      ".": { repoGen: 1, sourceSeq: 1, base: baseSection },
      linked: { repoGen: 1, sourceSeq: 1, base: linkedBase },
    },
  };

  const result = await planGitSections(root, cfg, state, remote, new Set(), buildIgnoreMatcher(root));
  expect(result.gitRepos?.linked).toEqual(linkedBase);
  expect(result.authoredCfgHashByRepo.linked).toBeUndefined();
  expect(result.skipped.some((item) => item.relPath === "linked")).toBe(true);
});

test("real capture parses only a stability-bracketed snapshot and carries base config on persistent churn", async () => {
  await runGit(root, "remote", "add", "origin", "git@example.com:local.git");
  const baseConfig: GitConfig = { "remote.base.url": ["git@example.com:base.git"] };
  const base = { ...baseSection, config: baseConfig };
  const configPath = path.join(root, ".git", "config");
  let parses = 0;

  const result = await planGitSections(
    root,
    cfg,
    stateWith(base),
    captureRemote(),
    new Set(["."]),
    buildIgnoreMatcher(root),
    undefined,
    undefined,
    {
      gitConfigRunner: async (repoDir, args) => {
        expect(args[2]).not.toBe(configPath);
        await fs.appendFile(configPath, `# capture churn ${++parses}\n`);
        return gitRaw(repoDir, args);
      },
    }
  );

  expect(parses).toBe(3);
  expect(result.captured).toContain(".");
  expect(result.gitRepos?.["."]?.config).toEqual(baseConfig);
  expect(result.gitRepos?.["."]?.config).not.toEqual({});
  expect(result.authoredCfgHashByRepo).toEqual({});
  expect(result.deferred.some((item) => item.reason.includes("unstable") && item.reason.includes("carrying base config"))).toBe(true);

  const subprocessFailure = await planGitSections(
    root,
    cfg,
    stateWith(base),
    captureRemote(),
    new Set(["."]),
    buildIgnoreMatcher(root),
    undefined,
    undefined,
    {
      gitConfigRunner: async () => {
        throw new Error("simulated snapshot parser failure");
      },
    }
  );
  expect(subprocessFailure.captured).toContain(".");
  expect(subprocessFailure.gitRepos?.["."]?.config).toEqual(baseConfig);
  expect(subprocessFailure.authoredCfgHashByRepo).toEqual({});
  expect(subprocessFailure.deferred.some((item) => item.reason.includes("parse-error") && item.reason.includes("carrying base config"))).toBe(true);
}, 30_000);

test("credential-bearing URL is skipped and logged loudly only once per repo across real captures", async () => {
  await runGit(root, "remote", "add", "origin", "https://user:secret@example.com/team/repo.git");
  const logs: string[] = [];
  const options = { onGitLog: (line: string) => logs.push(line) };

  const first = await planGitSections(
    root,
    cfg,
    stateWith(baseSection),
    captureRemote(),
    new Set(["."]),
    buildIgnoreMatcher(root),
    undefined,
    undefined,
    options
  );
  const second = await planGitSections(
    root,
    cfg,
    stateWith(baseSection),
    captureRemote(),
    new Set(["."]),
    buildIgnoreMatcher(root),
    undefined,
    undefined,
    options
  );

  for (const result of [first, second]) {
    expect(result.gitRepos?.["."]?.config?.["remote.origin.url"]).toBeUndefined();
    expect(result.authoredCfgHashByRepo["."]).toBe(gitConfigHash(result.gitRepos!["."]!.config!));
  }
  expect(logs.filter((line) => line.includes("credential-bearing remote URL"))).toHaveLength(1);
}, 20_000);

test("real-capture ownership gate embeds for an owned dir repo and never for a pointer/scoped repo", async () => {
  await runGit(root, "remote", "add", "origin", "git@example.com:owned.git");
  const owned = await planGitSections(
    root,
    cfg,
    stateWith(baseSection),
    captureRemote(),
    new Set(["."]),
    buildIgnoreMatcher(root)
  );
  expect(owned.gitRepos?.["."]?.refScope).toBe("all");
  expect(owned.gitRepos?.["."]?.config?.["remote.origin.url"]).toEqual(["git@example.com:owned.git"]);
  expect(owned.authoredCfgHashByRepo["."]).toBe(gitConfigHash(owned.gitRepos!["."]!.config!));

  const main = path.join(root, "outside-main");
  const pointer = path.join(root, "pointer-worktree");
  await fs.mkdir(main, { recursive: true });
  await runGit(main, "init", "-q");
  await runGit(main, "config", "user.email", "test@example.com");
  await runGit(main, "config", "user.name", "Test");
  await fs.writeFile(path.join(main, "tracked.txt"), "pointer\n");
  await runGit(main, "add", "tracked.txt");
  await runGit(main, "commit", "-qm", "pointer base");
  await runGit(main, "remote", "add", "origin", "git@example.com:pointer.git");
  await runGit(main, "worktree", "add", "-qb", "pointer", pointer);
  const pointerIdentity = (await gitIdentity(pointer))!;
  const pointerBase: GitSection = {
    ...pointerIdentity,
    bundleSha: "c".repeat(64),
    bundleEncSha: "d".repeat(64),
    bundleCipherSize: 1,
    generatedAt: "2026-07-09T00:00:00.000Z",
  };
  const pointerCfg = { ...cfg, rootPath: pointer };
  const logs: string[] = [];
  const pointerResult = await planGitSections(
    pointer,
    pointerCfg,
    stateWith(pointerBase),
    { blobStore: () => new LocalBlobStore(path.join(pointer, ".rbox", "test-blobs")) } as SyncRemote,
    new Set(["."]),
    buildIgnoreMatcher(pointer),
    undefined,
    undefined,
    { onGitLog: (line) => logs.push(line) }
  );
  expect(pointerResult.gitRepos?.["."]?.refScope).toBe("scoped");
  expect(pointerResult.gitRepos?.["."]?.config).toBeUndefined();
  expect(pointerResult.authoredCfgHashByRepo["."]).toBeUndefined();
  expect(logs.some((line) => line.includes("does not own the common config"))).toBe(true);
}, 30_000);

test("real capture suppresses over-bounds config, carries base, and records no authorship", async () => {
  for (let i = 0; i < 65; i++) await runGit(root, "config", `remote.r${i}.url`, `git@example.com:r${i}.git`);
  const baseConfig: GitConfig = { "remote.base.url": ["git@example.com:base.git"] };
  const base = { ...baseSection, config: baseConfig };

  const result = await planGitSections(
    root,
    cfg,
    stateWith(base),
    captureRemote(),
    new Set(["."]),
    buildIgnoreMatcher(root)
  );
  expect(result.captured).toContain(".");
  expect(result.gitRepos?.["."]?.config).toEqual(baseConfig);
  expect(result.authoredCfgHashByRepo).toEqual({});
  expect(result.deferred.some((item) => item.reason.includes("capture config suppressed") && item.reason.includes("carrying base config"))).toBe(true);
}, 20_000);

test("old-writer strip presence republishes config after a real capture", async () => {
  await runGit(root, "remote", "add", "origin", "git@example.com:repo.git");
  const captured = await planGitSections(
    root,
    cfg,
    stateWith(baseSection),
    captureRemote(),
    new Set(["."]),
    buildIgnoreMatcher(root)
  );
  const wire = captured.gitRepos!["."]!;
  expect(wire.config?.["remote.origin.url"]).toEqual(["git@example.com:repo.git"]);
  expect(captured.authoredCfgHashByRepo["."]).toBe(gitConfigHash(wire.config!));

  const stripped = { ...wire };
  delete stripped.config;
  const healed = await planGitSections(root, cfg, stateWith(stripped), remote, new Set(), buildIgnoreMatcher(root));
  expect(healed.gitRepos?.["."]?.config).toEqual(wire.config);
  expect(healed.authoredCfgHashByRepo["."]).toBe(gitConfigHash(wire.config!));
}, 20_000);
