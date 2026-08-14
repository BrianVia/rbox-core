import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalBlobStore, buildIgnoreMatcher, type BlobStore, type GitSection, type Manifest } from "../engine/index.js";
import { captureGitState } from "./sync-git/capture.js";
import { gitIdentity, gitIdentityKey } from "./sync-git/identity.js";
import { gitSectionBlobRefs } from "./sync-git/git-state.js";
import type { GitConfigRunner } from "../cli/sync-git/config-txn.js";
import { loadState, saveStateUnsafeLegacyOrTest, syncStreamId, type SyncState, type WorkspaceConfig } from "./config.js";
import type { CommitResult, SyncRemote } from "./remote.js";
import {
  applyGitSections,
  gitDivergenceStatus,
  planGitSections,
  type GitPullOutcome,
} from "./sync-git.js";
import { pull, push, sync, type SyncDeps } from "./sync.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const KEK = Buffer.alloc(32, 93);
const noBackoff = async () => {};
const runGit = (dir: string, ...args: string[]) =>
  exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV }).then((result) => result.stdout.toString().trim());
const runGitEnv = (dir: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  exec("git", ["-C", dir, ...args], { env: { ...TEST_GIT_ENV, ...env } }).then((result) => result.stdout.toString().trim());

class LoopRemote implements SyncRemote {
  private head = 0;
  private readonly manifests = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  commitCalls = 0;

  headSeq(): number {
    return this.head;
  }

  manifestsAfter(sequence: number): Manifest[] {
    return Array.from({ length: this.head - sequence }, (_, index) => this.manifests.get(sequence + index + 1)!)
      .filter((manifest): manifest is Manifest => manifest !== undefined);
  }

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.manifests.get(this.head) ?? { generatedAt: "", files: [] } };
  }

  /** Simulate a third, old writer committing a valid manifest that strips config. */
  rewriteHead(mutator: (manifest: Manifest) => Manifest): void {
    const current = this.manifests.get(this.head) ?? { generatedAt: "", files: [] };
    this.head += 1;
    this.manifests.set(this.head, mutator(structuredClone(current)));
  }

  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((sha) => !this.blobs.has(sha));
  }

  async putBlobFile(sha: string, absPath: string): Promise<void> {
    this.blobs.set(sha, await fs.readFile(absPath));
  }

  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    this.commitCalls += 1;
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    const missing = new Set<string>();
    for (const file of manifest.files) {
      if (file.type === "file" && !this.blobs.has(file.encSha ?? file.sha256)) missing.add(file.encSha ?? file.sha256);
    }
    for (const section of Object.values(manifest.gitRepos ?? {})) {
      for (const ref of gitSectionBlobRefs(section)) if (!this.blobs.has(ref.encSha)) missing.add(ref.encSha);
    }
    if (missing.size > 0) return { unsatisfiedBlobs: [...missing] };
    this.head += 1;
    this.manifests.set(this.head, manifest);
    return { sequence: this.head };
  }

  blobStore(): BlobStore {
    return {
      has: async (sha) => this.blobs.has(sha),
      put: async (sha, bytes) => void this.blobs.set(sha, Buffer.from(bytes)),
      get: async (sha) => {
        const bytes = this.blobs.get(sha);
        if (!bytes) throw new Error(`blob missing: ${sha}`);
        return bytes;
      },
      getToFile: async (sha, dest) => {
        const bytes = this.blobs.get(sha);
        if (!bytes) throw new Error(`blob missing: ${sha}`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, bytes);
      },
      putFile: async (sha, src, size, _uploadsDir, onBytes) => {
        this.blobs.set(sha, await fs.readFile(src));
        onBytes?.(size ?? 0);
      },
    };
  }
}

let tmp = "";
let rootA = "";
let rootB = "";
let remote: LoopRemote;
let cfgA: WorkspaceConfig;
let cfgB: WorkspaceConfig;
let logsA: string[];
let logsB: string[];
let depsA: SyncDeps;
let depsB: SyncDeps;

function workspaceConfig(root: string, deviceId: string): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_git_config_e2e",
    projectId: "root",
    deviceId,
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: KEK,
    accountId: "acct_git_config_e2e",
    accountEpoch: 0,
    keyEpoch: 0,
  };
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await runGit(dir, "init", "-q", "-b", "main");
  await runGit(dir, "config", "user.name", "E2E Test");
  await runGit(dir, "config", "user.email", "e2e@example.com");
}

async function commitFile(dir: string, file: string, body: string, message: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), body);
  await runGit(dir, "add", file);
  await runGit(dir, "commit", "-qm", message);
}

async function configValue(dir: string, key: string): Promise<string | undefined> {
  return runGit(dir, "config", "--get", key).catch(() => undefined);
}

async function state(root: string, cfg: WorkspaceConfig): Promise<SyncState> {
  return loadState(root, syncStreamId(cfg));
}

async function syncCycle(): Promise<void> {
  await sync(rootA, cfgA, depsA);
  await sync(rootB, cfgB, depsB);
}

function failConfig() {
  return Promise.resolve({
    status: "deferred" as const,
    attempts: 1,
    fault: { disposition: "transient" as const, reason: "candidate-error" as const },
  });
}

function carryOutcomeIntoState(baseState: SyncState, remoteManifest: Manifest, sequence: number, outcome: GitPullOutcome): SyncState {
  const records = { ...(baseState.repoRecords ?? {}) };
  for (const rel of new Set([
    ...Object.keys(outcome.gitRepos ?? {}),
    ...Object.keys(outcome.gitPendingRemote ?? {}),
    ...Object.keys(outcome.configLane ?? {}),
  ])) {
    const prior = records[rel] ?? { repoGen: 0, sourceSeq: baseState.lastSyncedSequence };
    records[rel] = {
      ...prior,
      repoGen: prior.repoGen + 1,
      sourceSeq: sequence,
      ...(outcome.gitRepos?.[rel] === undefined ? {} : { base: outcome.gitRepos[rel] }),
      ...(outcome.gitPendingRemote?.[rel] === undefined ? {} : { pending: outcome.gitPendingRemote[rel] }),
      ...(outcome.configLane?.[rel] ?? {}),
    };
  }
  return {
    ...baseState,
    repoRecords: records,
    gitPendingRemote: outcome.gitPendingRemote,
    gitReposRemoved: outcome.gitReposRemoved,
    gitNeedsResolution: outcome.gitNeedsResolution,
    // A failed per-repo apply intentionally does not advance this global base.
    lastSyncedManifest: baseState.lastSyncedManifest,
    lastSyncedSequence: baseState.lastSyncedSequence,
  };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-git-config-e2e-"));
  rootA = path.join(tmp, "A");
  rootB = path.join(tmp, "B");
  await fs.mkdir(path.join(rootA, ".rbox", "state"), { recursive: true });
  await fs.mkdir(path.join(rootB, ".rbox", "state"), { recursive: true });
  remote = new LoopRemote();
  cfgA = workspaceConfig(rootA, "device-A");
  cfgB = workspaceConfig(rootB, "device-B");
  logsA = [];
  logsB = [];
  depsA = { remote, backoff: noBackoff, onGitLog: (line) => logsA.push(line) };
  depsB = { remote, backoff: noBackoff, onGitLog: (line) => logsB.push(line) };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test("§11 E2E: fresh materialization keeps remote/tracking config and can pull from a local bare remote", async () => {
  const bare = path.join(tmp, "origin.git");
  await exec("git", ["init", "--bare", "-q", bare], { env: TEST_GIT_ENV });
  const repoA = path.join(rootA, "repo");
  await initRepo(repoA);
  await commitFile(repoA, "tracked.txt", "one\n", "initial");
  await runGit(repoA, "remote", "add", "origin", bare);
  await runGit(repoA, "push", "-qu", "origin", "main");
  await runGit(repoA, "update-ref", "refs/remotes/origin/main", "HEAD");
  await runGit(repoA, "remote", "set-url", "origin", `local.test:${bare}`);

  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);

  const repoB = path.join(rootB, "repo");
  const remotes = await runGit(repoB, "remote", "-v");
  expect(remotes).toContain(`origin\tlocal.test:${bare} (fetch)`);
  expect(remotes).toContain(`origin\tlocal.test:${bare} (push)`);
  expect(await runGit(repoB, "status", "-sb")).toContain("## main...origin/main");

  // Git's scp transport still talks to the same local bare repository. The helper
  // replaces ssh only for this test and executes git-upload-pack on this host.
  const ssh = path.join(tmp, "local-ssh");
  await fs.writeFile(ssh, "#!/bin/sh\nshift\nexec sh -c \"$1\"\n");
  await fs.chmod(ssh, 0o755);
  await runGit(repoA, "remote", "set-url", "origin", bare);
  await commitFile(repoA, "after.txt", "from bare\n", "remote advance");
  await runGit(repoA, "push", "-q", "origin", "main");
  await runGit(repoA, "remote", "set-url", "origin", `local.test:${bare}`);
  await runGitEnv(repoB, { GIT_SSH_COMMAND: ssh }, "pull", "--ff-only", "-q");
  expect(await fs.readFile(path.join(repoB, "after.txt"), "utf8")).toBe("from bare\n");
});

test("§11 E2E: config-only edit changes no git identity, and cfgToken heals a manual delete", async () => {
  const repoA = path.join(rootA, "repo");
  await initRepo(repoA);
  await commitFile(repoA, "tracked.txt", "one\n", "initial");
  await runGit(repoA, "remote", "add", "origin", "https://example.test/one.git");
  await runGit(repoA, "branch", "--set-upstream-to", "origin/main", "main").catch(async () => {
    await runGit(repoA, "config", "branch.main.remote", "origin");
    await runGit(repoA, "config", "branch.main.merge", "refs/heads/main");
  });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const repoB = path.join(rootB, "repo");
  const beforeA = gitIdentityKey(await gitIdentity(repoA));
  const beforeB = gitIdentityKey(await gitIdentity(repoB));
  const beforeSection = (await remote.latest()).manifest.gitRepos!.repo!;

  await runGit(repoA, "remote", "set-url", "origin", "https://example.test/two.git");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!.repo!.config!["remote.origin.url"]).toEqual([
    "https://example.test/two.git",
  ]);
  await pull(rootB, cfgB, depsB);
  const afterSection = (await remote.latest()).manifest.gitRepos!.repo!;
  expect((await state(rootB, cfgB)).lastSyncedManifest.gitRepos!.repo!.config!["remote.origin.url"]).toEqual([
    "https://example.test/two.git",
  ]);
  expect(gitIdentityKey(await gitIdentity(repoA))).toBe(beforeA);
  expect(gitIdentityKey(await gitIdentity(repoB))).toBe(beforeB);
  expect({ ...afterSection, config: undefined }).toEqual({ ...beforeSection, config: undefined });

  const laneBeforeDelete = (await state(rootB, cfgB)).repoRecords!.repo!.cfgToken;
  // Existing keys are intentionally add-only on pull. Deleting the old local key
  // makes the incoming wire value absent, and cfgToken must force this same-head
  // pull to reinstall it.
  await runGit(repoB, "config", "--unset-all", "remote.origin.url");
  await pull(rootB, cfgB, depsB);
  expect(await configValue(repoB, "remote.origin.url")).toBe("https://example.test/two.git");
  expect((await state(rootB, cfgB)).repoRecords!.repo!.cfgToken).not.toEqual(laneBeforeDelete);
});

test("§11 E2E: present-different hosts settle after one flip plus one publisher ACK and two idle cycles emit zero sequences", async () => {
  const repoA = path.join(rootA, "repo");
  await initRepo(repoA);
  await commitFile(repoA, "tracked.txt", "one\n", "initial");
  await runGit(repoA, "remote", "add", "origin", "https://example.test/base.git");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const repoB = path.join(rootB, "repo");

  await runGit(repoA, "remote", "set-url", "origin", "https://example.test/from-a.git");
  await runGit(repoB, "remote", "set-url", "origin", "https://example.test/from-b.git");
  const start = remote.headSeq();
  await syncCycle();
  await syncCycle();
  const settled = remote.headSeq();
  // Design 130, "Repository absence and suppression": outbound delta uses each
  // writer's exact `advertised` checkpoint, and publisher ACK advances it. After
  // the one value flip, A may therefore emit one byte-identical ACK before its
  // checkpoint catches up; this is bounded and must then become idle.
  expect(settled - start).toBeLessThanOrEqual(3);
  const postStart = remote.manifestsAfter(start).map((manifest) => manifest.gitRepos!.repo!);
  const urls = postStart.map((section) => section.config!["remote.origin.url"]![0]);
  const flips = urls.slice(1).filter((url, index) => url !== urls[index]).length;
  const duplicateAcks = postStart.slice(1).filter((section, index) => JSON.stringify(section) === JSON.stringify(postStart[index])).length;
  expect(flips).toBeLessThanOrEqual(1);
  expect(duplicateAcks).toBeLessThanOrEqual(1);
  if (postStart.length === 3) expect(postStart[2]).toEqual(postStart[1]);
  const wireUrl = (await remote.latest()).manifest.gitRepos!.repo!.config!["remote.origin.url"]![0];
  expect(["https://example.test/from-a.git", "https://example.test/from-b.git"]).toContain(wireUrl);

  const calls = remote.commitCalls;
  await syncCycle();
  await syncCycle();
  expect(remote.headSeq()).toBe(settled);
  expect(remote.commitCalls).toBe(calls);
});

test("§11 E2E: old-writer strip and structural drop both recover through presence publication", async () => {
  const repoA = path.join(rootA, "repo");
  await initRepo(repoA);
  await commitFile(repoA, "tracked.txt", "one\n", "initial");
  await runGit(repoA, "remote", "add", "origin", "https://example.test/present.git");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);

  remote.rewriteHead((manifest) => ({
    ...manifest,
    gitRepos: Object.fromEntries(Object.entries(manifest.gitRepos ?? {}).map(([rel, section]) => {
      const stripped = { ...section };
      delete stripped.config;
      return [rel, stripped];
    })),
  }));
  await pull(rootA, cfgA, depsA);
  const strippedState = await state(rootA, cfgA);
  expect(strippedState.repoRecords?.repo?.cfgSynced).toBeUndefined();
  expect(strippedState.repoRecords?.repo?.cfgShape).toBeUndefined();
  const presencePlan = await planGitSections(rootA, cfgA, strippedState, remote, new Set(), buildIgnoreMatcher(rootA));
  expect(presencePlan.gitRepos?.repo?.config?.["remote.origin.url"]).toEqual(["https://example.test/present.git"]);
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!.repo!.config!["remote.origin.url"]).toEqual([
    "https://example.test/present.git",
  ]);

  const shallow = path.join(repoA, ".git", "shallow");
  await fs.writeFile(shallow, `${await runGit(repoA, "rev-parse", "HEAD")}\n`);
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos?.repo).toBeUndefined();
  await fs.rm(shallow);
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!.repo!.config!["remote.origin.url"]).toEqual([
    "https://example.test/present.git",
  ]);
});

test("design 178 D.2: persisted invalid incoming config does not author a corrective echo", async () => {
  const repoA = path.join(rootA, "repo");
  await initRepo(repoA);
  await commitFile(repoA, "tracked.txt", "one\n", "initial");
  await runGit(repoA, "remote", "add", "origin", "https://example.test/present.git");
  await push(rootA, cfgA, depsA);

  remote.rewriteHead((manifest) => ({
    ...manifest,
    gitRepos: Object.fromEntries(Object.entries(manifest.gitRepos ?? {}).map(([rel, section]) => [
      rel,
      { ...section, config: { "remote.origin.url": [] } },
    ])),
  }));
  const invalidSequence = remote.headSeq();
  await pull(rootA, cfgA, depsA);
  const sanitized = await state(rootA, cfgA);
  expect(sanitized.lastSyncedManifest.gitRepos?.repo?.config).toBeUndefined();
  expect(sanitized.repoRecords?.repo?.cfgSynced).toBeDefined();

  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBe(invalidSequence);
});

test("design 178 D.2: invalid incoming preserves the baseline so a genuine A-to-B edit publishes", async () => {
  const repoA = path.join(rootA, "repo");
  await initRepo(repoA);
  await commitFile(repoA, "tracked.txt", "one\n", "initial");
  await runGit(repoA, "remote", "add", "origin", "https://example.test/a.git");
  await push(rootA, cfgA, depsA);
  const beforeEdit = await state(rootA, cfgA);
  const baselineA = beforeEdit.repoRecords?.repo?.cfgSynced;
  expect(baselineA).toBeDefined();

  await runGit(repoA, "remote", "set-url", "origin", "https://example.test/b.git");
  remote.rewriteHead((manifest) => ({
    ...manifest,
    gitRepos: Object.fromEntries(Object.entries(manifest.gitRepos ?? {}).map(([rel, section]) => [
      rel,
      { ...section, config: { "remote.origin.url": [] } },
    ])),
  }));
  const invalidSequence = remote.headSeq();
  await pull(rootA, cfgA, depsA);
  expect((await state(rootA, cfgA)).repoRecords?.repo?.cfgSynced).toBe(baselineA);

  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBe(invalidSequence + 1);
  expect((await remote.latest()).manifest.gitRepos?.repo?.config?.["remote.origin.url"]).toEqual([
    "https://example.test/b.git",
  ]);
});

test("§11 E2E: config failure retries independently while safe Git progress lands", async () => {
  const repoA = path.join(rootA, "repo");
  await initRepo(repoA);
  await commitFile(repoA, "tracked.txt", "one\n", "initial");
  await runGit(repoA, "remote", "add", "origin", "https://example.test/base.git");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const repoB = path.join(rootB, "repo");
  const oldState = await state(rootB, cfgB);
  const oldSection = oldState.lastSyncedManifest.gitRepos!.repo!;

  // Shortcut 1: remote Git identity equals the base, only config is due.
  await runGit(repoA, "remote", "set-url", "origin", "https://example.test/config-only.git");
  await push(rootA, cfgA, depsA);
  const configOnlyHead = await remote.latest();
  const first = await applyGitSections(
    rootB,
    cfgB,
    oldState,
    configOnlyHead.manifest,
    remote.blobStore(),
    buildIgnoreMatcher(rootB),
    () => {},
    { applyConfig: failConfig }
  );
  expect(first.gitRepos?.repo).toEqual(configOnlyHead.manifest.gitRepos!.repo);
  expect(first.gitPendingRemote).toBeUndefined();
  expect(first.partial?.repo?.configApplied).toBe(false);

  // Shortcut 2: retrying the same pending section must not clear it merely because
  // the local Git identity already equals the incoming identity.
  const retryState = carryOutcomeIntoState(oldState, configOnlyHead.manifest, configOnlyHead.sequence, first);
  const second = await applyGitSections(
    rootB,
    cfgB,
    retryState,
    configOnlyHead.manifest,
    remote.blobStore(),
    buildIgnoreMatcher(rootB),
    () => {},
    { applyConfig: failConfig }
  );
  expect(second.gitRepos?.repo).toEqual(configOnlyHead.manifest.gitRepos!.repo);
  expect(second.gitPendingRemote).toBeUndefined();

  // Combined Git+config mutation: safe Git lands even though config remains deferred.
  await commitFile(repoA, "tracked.txt", "two\n", "git plus config");
  await runGit(repoA, "remote", "add", "backup", "https://example.test/backup.git");
  await push(rootA, cfgA, depsA);
  const combinedHead = await remote.latest();
  const oldGitHead = await runGit(repoB, "rev-parse", "HEAD");
  const combined = await applyGitSections(
    rootB,
    cfgB,
    oldState,
    combinedHead.manifest,
    remote.blobStore(),
    buildIgnoreMatcher(rootB),
    () => {},
    { applyConfig: failConfig }
  );
  expect(combined.gitRepos?.repo).toEqual(combinedHead.manifest.gitRepos!.repo);
  expect(combined.gitPendingRemote).toBeUndefined();
  expect(await runGit(repoB, "rev-parse", "HEAD")).not.toBe(oldGitHead);
  expect(await configValue(repoB, "remote.backup.url")).toBeUndefined();
  expect(combined.partial?.repo?.configApplied).toBe(false);
});

test("§11 E2E: pointer historical all-base carry is normalized; scoped→standalone→pointer skips config", async () => {
  const main = path.join(tmp, "outside-main");
  const pointer = path.join(rootA, "wt");
  await initRepo(main);
  await commitFile(main, "tracked.txt", "one\n", "initial");
  await runGit(main, "remote", "add", "origin", "https://example.test/pointer-original.git");
  await runGit(main, "worktree", "add", "-qb", "linked", pointer);

  const store = new LocalBlobStore(path.join(tmp, "historical-store"));
  const historical: GitSection = {
    ...(await captureGitState(pointer, store, KEK))!,
    refScope: "all",
    config: { "remote.origin.url": ["https://example.test/historical.git"] },
  };
  const historicalState: SyncState = {
    stream: syncStreamId(cfgA),
    stateNonce: "9".repeat(32),
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "", files: [], manifestSchema: 2, gitRepos: { wt: historical } },
    repoRecords: { wt: { repoGen: 1, sourceSeq: 1, base: historical } },
  };
  const carried = await planGitSections(rootA, cfgA, historicalState, remote, new Set(), buildIgnoreMatcher(rootA), undefined, undefined, {
    onGitLog: (line) => logsA.push(line),
  });
  // Design 130, "The single outbound normalization boundary": every outgoing
  // non-PENDING section is canonicalized, including historical carry paths.
  // Empty tombstone fields are therefore explicit; verbatim carry is reserved
  // for PENDING because changing its bytes would orphan partial progress.
  expect(carried.gitRepos?.wt).toEqual({
    ...historical,
    refTombstones: {},
    refTombstoneGeneration: 0,
  });
  expect(carried.authoredCfgHashByRepo.wt).toBeUndefined();
  expect(await configValue(main, "remote.origin.url")).toBe("https://example.test/pointer-original.git");

  // Start a clean stream for the actual cross-shape loop. A pointer authors SCOPED
  // Git without config, B materializes it as standalone, then B authors ALL+config.
  await saveStateUnsafeLegacyOrTest(rootA, {
    stream: syncStreamId(cfgA),
    stateNonce: "a".repeat(32),
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!.wt!.refScope).toBe("scoped");
  expect((await remote.latest()).manifest.gitRepos!.wt!.config).toBeUndefined();
  await pull(rootB, cfgB, depsB);
  const standalone = path.join(rootB, "wt");
  await runGit(standalone, "remote", "add", "origin", "https://example.test/from-standalone.git");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos!.wt!.refScope).toBe("all");
  expect((await remote.latest()).manifest.gitRepos!.wt!.config).toBeDefined();
  await pull(rootA, cfgA, depsA);
  expect(await configValue(main, "remote.origin.url")).toBe("https://example.test/pointer-original.git");
  expect(logsA.filter((line) => line.includes("config skipped wt"))).toHaveLength(1);
});

test("§11 E2E: nested repositories retain independent config lanes", async () => {
  const outer = path.join(rootA, "outer");
  const inner = path.join(outer, "nested", "inner");
  await initRepo(outer);
  await commitFile(outer, "outer.txt", "outer\n", "outer");
  await runGit(outer, "remote", "add", "origin", "https://example.test/outer.git");
  await initRepo(inner);
  await commitFile(inner, "inner.txt", "inner\n", "inner");
  await runGit(inner, "remote", "add", "upstream", "https://example.test/inner.git");

  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  expect(await configValue(path.join(rootB, "outer"), "remote.origin.url")).toBe("https://example.test/outer.git");
  expect(await configValue(path.join(rootB, "outer", "nested", "inner"), "remote.upstream.url")).toBe(
    "https://example.test/inner.git"
  );
  expect(await configValue(path.join(rootB, "outer"), "remote.upstream.url")).toBeUndefined();
  expect(await configValue(path.join(rootB, "outer", "nested", "inner"), "remote.origin.url")).toBeUndefined();
});

test("§11 E2E: status is indeterminate when all bounded config reads are unstable", async () => {
  await initRepo(rootA);
  await commitFile(rootA, "tracked.txt", "one\n", "initial");
  await runGit(rootA, "remote", "add", "origin", "https://example.test/status.git");
  await push(rootA, cfgA, depsA);
  const saved = await state(rootA, cfgA);
  await fs.rm(path.join(rootA, ".rbox", "state", "git-divergence.json"), { force: true });
  const configPath = path.join(rootA, ".git", "config");
  let attempt = 0;
  const unstableRunner: GitConfigRunner = async (repoDir, args) => {
    await fs.appendFile(configPath, `# forced instability ${++attempt}\n`);
    return exec("git", ["-C", repoDir, ...args], { env: TEST_GIT_ENV }).then((result) => result.stdout.toString());
  };
  const status = await gitDivergenceStatus(
    rootA,
    cfgA,
    saved,
    buildIgnoreMatcher(rootA),
    undefined,
    true,
    { gitConfigRunner: unstableRunner }
  );
  expect(attempt).toBeGreaterThanOrEqual(3);
  expect(status.count).toBeGreaterThanOrEqual(1);
  expect(status.configChecking).toContain(".");
});

test("§11 E2E: concurrent daemon/CLI process saves preserve newer-source atomicity", async () => {
  const stream = syncStreamId(cfgA);
  const initial: SyncState = {
    stream,
    stateNonce: "b".repeat(32),
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "zero", files: [] },
    repoRecords: {},
  };
  await saveStateUnsafeLegacyOrTest(rootA, initial);
  const worker = path.join(tmp, "state-save-worker.ts");
  const configModule = path.join(import.meta.dir, "config.ts");
  const syncStateModule = path.join(import.meta.dir, "sync-state.ts");
  await fs.writeFile(
    worker,
    `import fs from "node:fs/promises";\n` +
      `import path from "node:path";\n` +
      `import { loadState } from ${JSON.stringify(configModule)};\n` +
      `import { saveStateSource } from ${JSON.stringify(syncStateModule)};\n` +
      `const [root, stream, role, seqText] = Bun.argv.slice(2);\n` +
      `const seq = Number(seqText);\n` +
      `const snapshot = await loadState(root, stream);\n` +
      `await fs.writeFile(path.join(root, \`.ready-\${role}\`), "ready");\n` +
      `while (!(await fs.stat(path.join(root, \`.release-\${role}\`)).then(() => true, () => false))) await Bun.sleep(2);\n` +
      `const fill = role === "daemon" ? "d" : "c";\n` +
      `const section = { bundleSha: fill.repeat(64), bundleEncSha: (role === "daemon" ? "e" : "f").repeat(64), bundleCipherSize: 1, head: "ref: refs/heads/main", refs: { "refs/heads/main": "1".repeat(40) }, refScope: "all", generatedAt: role };\n` +
      `const proof = { authority: { kind: "publisher-ack", lineageHash: "a".repeat(64), repositoryIdentityHash: "b".repeat(64), incomingKey: role, sourceSeq: seq, advertisedRefs: section.refs }, lockedProof: { repoKind: "dir", effectiveRefScope: "all", checkoutComplete: true, branches: {}, safeRefs: {} } } as const;\n` +
      `await saveStateSource(root, snapshot, { expectedStream: stream, sourceGlobalSeq: seq, globalManifest: { generatedAt: role, files: [], manifestSchema: 2, gitRepos: { repo: section } }, observedRepos: ["repo"], values: { bases: { repo: section } }, repoProofs: { repo: proof } });\n`
  );
  const daemon = Bun.spawn([process.execPath, worker, rootA, stream, "daemon", "1"], { stdout: "pipe", stderr: "pipe" });
  const cli = Bun.spawn([process.execPath, worker, rootA, stream, "cli", "2"], { stdout: "pipe", stderr: "pipe" });
  const daemonStdout = new Response(daemon.stdout).text();
  const daemonStderr = new Response(daemon.stderr).text();
  const cliStdout = new Response(cli.stdout).text();
  const cliStderr = new Response(cli.stderr).text();
  const ceilingMs = 10_000;
  const waitForMarker = async (marker: string, child: typeof daemon, stderr: Promise<string>): Promise<void> => {
    const deadline = Date.now() + ceilingMs;
    while (!(await fs.stat(marker).then(() => true, () => false))) {
      if (child.exitCode !== null) {
        throw new Error(`state-save child exited ${child.exitCode} before ${path.basename(marker)}: ${await stderr}`);
      }
      if (Date.now() >= deadline) {
        child.kill();
        await child.exited;
        throw new Error(`timed out waiting for ${path.basename(marker)}: ${await stderr}`);
      }
      await Bun.sleep(5);
    }
  };
  const waitForExit = async (role: string, child: typeof daemon, stderr: Promise<string>): Promise<number> => {
    const deadline = Date.now() + ceilingMs;
    while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(5);
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
      throw new Error(`timed out waiting for ${role} state-save child: ${await stderr}`);
    }
    return child.exitCode;
  };
  try {
    await Promise.all([
      waitForMarker(path.join(rootA, ".ready-daemon"), daemon, daemonStderr),
      waitForMarker(path.join(rootA, ".ready-cli"), cli, cliStderr),
    ]);
    await fs.writeFile(path.join(rootA, ".release-cli"), "release");
    const cliExit = await waitForExit("cli", cli, cliStderr);
    if (cliExit !== 0) throw new Error(`cli state-save child exited ${cliExit}: ${await cliStderr}`);
    await fs.writeFile(path.join(rootA, ".release-daemon"), "release");
    const daemonExit = await waitForExit("daemon", daemon, daemonStderr);
    if (daemonExit !== 0) throw new Error(`daemon state-save child exited ${daemonExit}: ${await daemonStderr}`);
    expect({ daemonExit, cliExit }).toEqual({ daemonExit: 0, cliExit: 0 });
  } finally {
    if (daemon.exitCode === null) daemon.kill();
    if (cli.exitCode === null) cli.kill();
    await Promise.allSettled([daemon.exited, cli.exited, daemonStdout, daemonStderr, cliStdout, cliStderr]);
  }
  const final = await state(rootA, cfgA);
  expect(final.lastSyncedSequence).toBe(2);
  expect(final.lastSyncedManifest.generatedAt).toBe("cli");
  expect(final.repoRecords?.repo?.sourceSeq).toBe(2);
  expect(final.repoRecords?.repo?.base?.generatedAt).toBe("cli");
});
