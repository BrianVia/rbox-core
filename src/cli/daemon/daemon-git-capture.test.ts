import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { HashCache, scanManifest, type BlobStore, type Manifest } from "../../engine/index.js";
import { type SyncState, type WorkspaceConfig } from "../config.js";
import type { CommitResult, SyncRemote } from "../remote.js";
import { GIT_BUSY_RETRY_DELAYS_MS, RboxDaemon, gitCaptureSampleForProvenance, type GitBusyRetryClock } from "./daemon.js";
import { GitRefWatchRegistry, type GitRefWatchHandle, type GitRefWatchMode } from "./git-ref-watch.js";
import { createSignalDebouncer, type GitSignalBatch } from "./watcher.js";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox episode",
  GIT_AUTHOR_EMAIL: "rbox-episode@local",
  GIT_COMMITTER_NAME: "rbox episode",
  GIT_COMMITTER_EMAIL: "rbox-episode@local",
};
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: GIT_ENV }).then((result) => result.stdout.toString().trim());
const KEK = Buffer.alloc(32, 17);

class CaptureRemote implements SyncRemote {
  head = 0;
  readonly manifests = new Map<number, Manifest>();
  readonly blobs = new Map<string, Buffer>();

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.manifests.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> { return shas.filter((sha) => !this.blobs.has(sha)); }
  async putBlobFile(sha: string, source: string): Promise<void> { this.blobs.set(sha, await fsp.readFile(source)); }
  async commit(parent: number, _device: string, manifest: Manifest): Promise<CommitResult> {
    if (parent !== this.head) return { conflict: true, head: this.head };
    this.head++;
    this.manifests.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    return {
      has: async (sha) => this.blobs.has(sha),
      put: async (sha, bytes) => { this.blobs.set(sha, Buffer.from(bytes)); },
      get: async (sha) => {
        const bytes = this.blobs.get(sha);
        if (!bytes) throw new Error(`blob missing: ${sha}`);
        return bytes;
      },
      getToFile: async (sha, destination) => {
        const bytes = this.blobs.get(sha);
        if (!bytes) throw new Error(`blob missing: ${sha}`);
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.writeFile(destination, bytes);
      },
      putFile: async (sha, source, size, _uploadsDir, onBytes) => {
        this.blobs.set(sha, await fsp.readFile(source));
        onBytes?.(size ?? 0);
      },
    };
  }
}

class FakeBusyClock implements GitBusyRetryClock {
  now = 0;
  nextId = 1;
  timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, delay: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.timers.delete(handle as number); };
  async advanceTo(target: number): Promise<void> {
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
      await Promise.resolve();
    }
    this.now = target;
  }
}

class RoutingHandle implements GitRefWatchHandle {
  constructor(
    readonly target: string,
    readonly mode: GitRefWatchMode,
    readonly listener: (eventType: string, filename: string | Buffer | null) => void,
  ) {}
  close(): void {}
}

class RoutingWatches {
  readonly handles: RoutingHandle[] = [];
  watch = (target: string, mode: GitRefWatchMode, listener: RoutingHandle["listener"]): RoutingHandle => {
    const handle = new RoutingHandle(target, mode, listener);
    this.handles.push(handle);
    return handle;
  };
  get(target: string, mode: GitRefWatchMode): RoutingHandle {
    const handle = this.handles.find((candidate) => candidate.target === target && candidate.mode === mode);
    if (!handle) throw new Error(`missing routing handle: ${mode} ${target}`);
    return handle;
  }
}

interface EpisodeDaemon {
  cache: HashCache;
  local: { head: Manifest };
  pendingEvents: unknown[];
  pendingPushReasons: { signal: boolean; candidate: boolean; scan: boolean; other: boolean };
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  pumping: boolean;
  stopped: boolean;
  gitBusyEpisode?: { timers: unknown[]; queuedStages: Array<1 | 2> };
  handleGitSignalBatch(batch: GitSignalBatch): Promise<void>;
  noteGitBusyDeferred(): void;
  loadSyncBase(): Promise<SyncState>;
  pump(): Promise<void>;
  stop(): Promise<void>;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("git capture push provenance", () => {
  test("uses mutually exclusive signal > candidate > scan precedence", () => {
    expect(gitCaptureSampleForProvenance({ signal: true, candidate: true, scan: true, other: true })).toEqual({
      kind: "git_capture", signalPushes: 1, candidatePushes: 0, scanPushes: 0,
    });
    expect(gitCaptureSampleForProvenance({ signal: false, candidate: true, scan: true, other: true })).toEqual({
      kind: "git_capture", signalPushes: 0, candidatePushes: 1, scanPushes: 0,
    });
    expect(gitCaptureSampleForProvenance({ signal: false, candidate: false, scan: true, other: true })).toEqual({
      kind: "git_capture", signalPushes: 0, candidatePushes: 0, scanPushes: 1,
    });
    expect(gitCaptureSampleForProvenance({ signal: false, candidate: false, scan: false, other: true })).toBeUndefined();
  });
});

test("git-busy retries are scheduled at two absolute episode offsets", () => {
  expect(GIT_BUSY_RETRY_DELAYS_MS).toEqual([2_000, 8_000]);
});

test("lock pre-signal alone captures branch and packed refs through one absolute busy-retry episode", async () => {
  const runVariant = async (variant: "branch" | "packed") => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `rbox-git-episode-${variant}-`)));
    const remote = new CaptureRemote();
    const clock = new FakeBusyClock();
    const cfg: WorkspaceConfig = {
      schema: "e2ee/v1",
      remoteWorkspaceId: `ws_${variant}`,
      projectId: "root",
      deviceId: `dev_${variant}`,
      rootPath: root,
      remoteUrl: "mem://",
      token: "",
      syncGit: true,
      encrypted: true,
      kek: KEK,
      accountId: "acct_episode",
      accountEpoch: 0,
      keyEpoch: 0,
    };
    await git(root, "init", "-qb", "main");
    await git(root, "commit", "--allow-empty", "-qm", "baseline");
    const daemon = new RboxDaemon(root, cfg, { remote, backoff: async () => {} }, {
      bootId: `episode-${variant}`,
      gitBusyRetryClock: clock,
      log: () => {},
    }) as unknown as EpisodeDaemon;
    let signalBatches = 0;
    const debouncer = createSignalDebouncer((batch) => {
      signalBatches++;
      return daemon.handleGitSignalBatch(batch);
    }, 400, 3_000);
    const routingWatches = new RoutingWatches();
    const registry = new GitRefWatchRegistry({
      root,
      watch: routingWatches.watch,
      onSignal: () => debouncer.push("signal"),
    });

    try {
      daemon.cache = await HashCache.load(root);
      daemon.local.head = await scanManifest(root);
      await daemon.loadSyncBase();
      daemon.want.push = true;
      await daemon.pump();
      expect((await remote.latest()).manifest.gitRepos?.["."]).toBeDefined();
      await registry.upsert([{ relPath: ".", kind: "dir" }]);

      if (variant === "packed") await git(root, "pack-refs", "--all");
      const tree = await git(root, "rev-parse", "HEAD^{tree}");
      const parent = await git(root, "rev-parse", "HEAD");
      const oid = await git(root, "commit-tree", tree, "-p", parent, "-m", `${variant} target`);
      const ref = variant === "branch" ? "refs/heads/side" : "refs/tags/packed-side";
      const lockPath = variant === "branch"
        ? path.join(root, ".git", "refs", "heads", "side.lock")
        : path.join(root, ".git", "packed-refs.lock");
      const targetPath = variant === "branch"
        ? path.join(root, ".git", "refs", "heads", "side")
        : path.join(root, ".git", "packed-refs");
      const lockRoute = variant === "branch"
        ? routingWatches.get(path.join(root, ".git", "refs", "heads"), "recursive")
        : routingWatches.get(path.join(root, ".git"), "shallow");
      const lockTail = variant === "branch" ? "side.lock" : "packed-refs.lock";
      if (variant === "branch") {
        await fsp.writeFile(lockPath, `${oid}\n`);
      } else {
        const packed = await fsp.readFile(targetPath, "utf8");
        await fsp.writeFile(lockPath, `${packed}${packed.endsWith("\n") ? "" : "\n"}${oid} ${ref}\n`);
      }

      const reports: Array<{ episode: EpisodeDaemon["gitBusyEpisode"]; timers: unknown[] }> = [];
      const originalReport = daemon.noteGitBusyDeferred.bind(daemon);
      daemon.noteGitBusyDeferred = () => {
        originalReport();
        reports.push({ episode: daemon.gitBusyEpisode, timers: [...(daemon.gitBusyEpisode?.timers ?? [])] });
      };

      // Only the accepted lock callback is supplied. Repeated pre-signals keep
      // the quiet timer moving until the real 3s max-wait forces the first push.
      const pulseStarted = Date.now();
      while (Date.now() - pulseStarted < 3_000) {
        lockRoute.listener("rename", lockTail);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      lockRoute.listener("rename", lockTail);
      expect(signalBatches).toBe(1); // synchronous max-wait flush, not later quiet debounce
      await waitFor(() => reports.length === 1 && !daemon.pumping, `${variant} initial busy report`);
      expect(Date.now() - pulseStarted).toBeGreaterThanOrEqual(3_000);
      expect(daemon.pendingEvents).toEqual([]);
      expect((await remote.latest()).manifest.gitRepos?.["."]?.refs[ref]).toBeUndefined();
      const firstEpisode = reports[0]!.episode;
      expect(firstEpisode).toBeDefined();
      expect([...clock.timers.values()].map((timer) => timer.at).sort((a, b) => a - b)).toEqual([2_000, 8_000]);

      await clock.advanceTo(2_000);
      await waitFor(() => reports.length === 2 && !daemon.pumping, `${variant} +2s busy retry`);
      expect(reports[1]!.episode).toBe(firstEpisode);
      expect(reports[1]!.timers).toEqual(reports[0]!.timers);
      expect([...clock.timers.values()].map((timer) => timer.at)).toEqual([8_000]);
      expect((await remote.latest()).manifest.gitRepos?.["."]?.refs[ref]).toBeUndefined();

      // Complete the transaction without delivering the final target callback.
      await fsp.rename(lockPath, targetPath);
      await clock.advanceTo(8_000);
      await waitFor(
        () => !daemon.pumping && remote.manifests.get(remote.head)?.gitRepos?.["."]?.refs[ref] === oid,
        `${variant} +8s capture`,
      );
      expect((await remote.latest()).manifest.gitRepos?.["."]?.refs[ref]).toBe(oid);
      expect(daemon.gitBusyEpisode).toBeUndefined();

      // The second retry surrendered/reset the episode. A later report opens a
      // distinct episode, and daemon close cancels it before its +2s callback.
      daemon.noteGitBusyDeferred();
      const secondEpisode = daemon.gitBusyEpisode;
      expect(secondEpisode).toBeDefined();
      expect(secondEpisode).not.toBe(firstEpisode);
      expect(clock.timers.size).toBe(2);
      await daemon.stop();
      expect(daemon.gitBusyEpisode).toBeUndefined();
      expect(clock.timers.size).toBe(0);
      daemon.want.push = false;
      await clock.advanceTo(10_000);
      expect(daemon.want.push).toBe(false);
    } finally {
      debouncer.dispose();
      await registry.close();
      if (!daemon.stopped) await daemon.stop().catch(() => {});
      await fsp.rm(root, { recursive: true, force: true });
    }
  };

  await Promise.all([runVariant("branch"), runVariant("packed")]);
}, 30_000);

test("push provenance snapshots at dequeue and preserves later reasons for the next push", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-provenance-")));
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  const daemon = new RboxDaemon(root, cfg as never, {} as never) as unknown as {
    requestPush(reason: "signal" | "candidate" | "scan" | "other"): void;
    takePushProvenance(): { signal: boolean; candidate: boolean; scan: boolean; other: boolean };
  };
  try {
    daemon.requestPush("signal");
    expect(daemon.takePushProvenance()).toEqual({ signal: true, candidate: false, scan: false, other: false });
    daemon.requestPush("candidate");
    expect(daemon.takePushProvenance()).toEqual({ signal: false, candidate: true, scan: false, other: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every raw want.push assignment is owned by requestPush and terminal recording is at the normal return boundary", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./daemon.ts", import.meta.url)), "utf8");
  expect(source.match(/this\.want\.push\s*=\s*true/g)).toHaveLength(1);
  const requestPush = source.slice(source.indexOf("private requestPush"), source.indexOf("private takePushProvenance"));
  expect(requestPush).toContain("this.want.push = true");
  expect(source.match(/this\.recordGitCaptureSuccess\(provenance\)/g)).toHaveLength(1);
  // The ordering this gate froze now lives in the publish reducer that owns it: a
  // terminal refusal returns before any capture credit, and credit precedes the
  // committed-subset bookkeeping.
  const reducer = fs.readFileSync(fileURLToPath(new URL("./daemon-publish-transition.ts", import.meta.url)), "utf8");
  const terminal = reducer.indexOf('if (outcome.kind === "terminal-block")');
  const recorded = reducer.indexOf('"record-git-capture-success"', terminal);
  const bookkeeping = reducer.indexOf('"commit-published-subset"', recorded);
  expect(terminal).toBeGreaterThan(0);
  expect(terminal).toBeLessThan(recorded);
  expect(recorded).toBeLessThan(bookkeeping);
});
