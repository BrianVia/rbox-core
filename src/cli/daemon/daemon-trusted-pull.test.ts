import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Design 202 — the daemon hands its watcher-maintained manifest to the single
// top-level pull of an op when the trust predicate P holds, and refreshes it
// afterwards with an O(applied) patch unless a fallback trigger fires.

import { HashCache, nativePruneGlobs, scanManifest, type BlobStore, type FileEntry, type GitSection, type IgnoreMatcher, type Manifest } from "../../engine/index.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import { RboxDaemon, type ScanCadenceClock } from "./daemon.js";
import type { WatcherAttemptWitness, WatcherRearmClock } from "./watcher-session-supervisor.js";
import type { ScanGenerationPlan, ScanObservationReceipt } from "./local-workspace-observer.js";
import type { LocalObservationCommitIntent, LocalObservationCommitReceipt, UnsettledDirective } from "./local-observation-transition.js";
import { gitReposMatcherKey, gitTopologyChanged } from "./manifest-update.js";
import type { ManifestUpdate, TrustedPullViewResult } from "./manifest-update.js";
import { watcherTrustLine } from "../status-view/brief.js";
import { prepareDaemonFolderAdmission, releaseDaemonFolderAdmission } from "./folder-admission.test-helper.js";
import type { CommitResult, SyncRemote } from "../remote.js";
import { saveStateUnsafeLegacyOrTest, syncStreamId, type SyncState, type WorkspaceConfig } from "../config.js";
import type { WorkspaceSyncMutex } from "../sync-mutex.js";

const KEK = Buffer.alloc(32, 7);
const shaHex = (s: string) => createHash("sha256").update(s).digest("hex");

class MiniRemote implements SyncRemote {
  head = 0;
  onLatest?: () => void;
  private readonly manifests = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  injectCommit(files: FileEntry[], gitRepos?: Record<string, GitSection>): void {
    this.head += 1;
    const manifest: Manifest = { generatedAt: "", files };
    if (gitRepos) {
      manifest.gitRepos = gitRepos;
      manifest.manifestSchema = 2;
    }
    this.manifests.set(this.head, manifest);
  }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    this.onLatest?.();
    return { sequence: this.head, manifest: this.manifests.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    this.blobs.set(sha256, await fs.readFile(absPath));
  }
  async commit(parentSequence: number, _device: string, manifest: Manifest): Promise<CommitResult> {
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    this.head += 1;
    this.manifests.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    const blobs = this.blobs;
    return {
      has: async (s) => blobs.has(s),
      put: async (s, bytes) => void blobs.set(s, Buffer.from(bytes)),
      get: async (s) => {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        return b;
      },
      getToFile: async (s, dest) => {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        await fs.writeFile(dest, b);
      },
      putFile: async (s, src) => void blobs.set(s, await fs.readFile(src)),
    };
  }
}

/** The daemon's private surface these tests drive (same pattern as
 *  daemon-scan-defer.test.ts / daemon-safety.test.ts). */
interface DaemonInternals {
  cache: HashCache;
  matcher: IgnoreMatcher;
  matcherGitReposKey: string;
  matcherGeneration: number;
  rulesChangedSinceDeepScan: boolean;
  syncBase?: SyncState;
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  pumpRun: Promise<void>;
  retryQueue: { stop(): void; scheduleWriteFinish(paths: Set<string>): void };
  pendingEvents: { relPath: string; kind: string }[];
  /** LOCAL authority (`CommitLocalObservation`), driven directly for fixture setup. */
  local: {
    head: Manifest;
    complete: boolean;
    unsettled: Set<string>;
    update?: ManifestUpdate;
    fullWorkspace: boolean;
    observedGeneration: number;
  };
  activeCaseCollisions: { paths: string[] }[];
  resetLifecycle: "ready" | "halted" | "recovering" | "bootstrapping";
  watcher?: { backend: "parcel" | "chokidar"; close(): Promise<void> };
  watcherTrust: {
    healthy: boolean;
    degraded: boolean;
    errorGeneration: number;
    state: "trusted" | "suspect" | "fused";
    nativePruneKey: string;
  };
  gitDiscovery: { registry?: unknown };
  openDriftAudits: Set<{ candidates: unknown[]; timer?: ReturnType<typeof setTimeout> }>;
  activity: { halt?: { op: string; message?: string } };
  startWatcherFn: typeof import("./watcher.js").startWatcher;
  watcherSessions: {
    rearmTimer?: { fn: () => void; ms: number };
    activeAttempt?: WatcherAttemptWitness;
    drainReplacement(): Promise<void>;
  };
  pump(): Promise<void>;
  doDeepScan(): Promise<unknown>;
  doFullScan(): Promise<unknown>;
  startLiveWatch(): Promise<void>;
  loadSyncBase(): Promise<SyncState>;
  openOperationBoundary(syncMutex: WorkspaceSyncMutex): Promise<boolean>;
  rebuildMatcher(state?: { lastSyncedManifest: Manifest }): void;
  buildTrustedPullView(base: SyncState): Promise<TrustedPullViewResult>;
  stop(): Promise<void>;
  localObserver: {
    observe(plan: ScanGenerationPlan): Promise<ScanObservationReceipt>;
  };
}

let root: string;
let lines: string[];
let daemon: DaemonInternals | undefined;
let savedEnv = {
  RBOX_PULL_TRUST_WATCHER: process.env.RBOX_PULL_TRUST_WATCHER,
  RBOX_WATCHER_RETRUST: process.env.RBOX_WATCHER_RETRUST,
  RBOX_GIT_APPLY_LAZY: process.env.RBOX_GIT_APPLY_LAZY,
};
const ambientWatcherRetrust = process.env.RBOX_WATCHER_RETRUST;

afterAll(() => {
  expect(process.env.RBOX_WATCHER_RETRUST).toBe(ambientWatcherRetrust);
});

beforeEach(async () => {
  // Tests pin default-ON behavior; an ambient kill-switch run must not leak in.
  savedEnv = {
    RBOX_PULL_TRUST_WATCHER: process.env.RBOX_PULL_TRUST_WATCHER,
    RBOX_WATCHER_RETRUST: process.env.RBOX_WATCHER_RETRUST,
    RBOX_GIT_APPLY_LAZY: process.env.RBOX_GIT_APPLY_LAZY,
  };
  delete process.env.RBOX_PULL_TRUST_WATCHER;
  delete process.env.RBOX_WATCHER_RETRUST;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-trusted-pull-")));
  lines = [];
  const cfg = testConfig();
  await prepareDaemonFolderAdmission(root, cfg);
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg), lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
  });
});
afterEach(async () => {
  await daemon?.stop().catch(() => {});
  daemon = undefined;
  try {
    await releaseDaemonFolderAdmission(root);
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

function testConfig(): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_trust",
    projectId: "root",
    deviceId: "dev_trust",
    rootPath: root,
    remoteUrl: "mem://",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_trust",
    accountEpoch: 0,
    keyEpoch: 0,
  };
}

function makeDaemon(remote: MiniRemote, opts: { scanCadenceClock?: ScanCadenceClock; watcherRearmClock?: WatcherRearmClock } = {}): DaemonInternals {
  const d = new RboxDaemon(root, testConfig(), { remote, backoff: async () => {} }, {
    bootId: "boot-trust",
    log: (line: string) => lines.push(line),
    ...opts,
  }) as DaemonInternals;
  d.cache = new HashCache();
  daemon = d;
  return d;
}

/** Baseline: publish the current tree, then bring the daemon into the state P
 *  describes — live trusted watcher, complete manifest from a full-workspace scan,
 *  matcher current with the base's gitRepos, nothing pending.
 *
 *  The fixture watcher is PARCEL (design 206 §3b/r4-F3): on chokidar every matcher
 *  rebuild fuses watcher trust, so the healing claims these tests pin can only be
 *  stated for the fleet's default backend. The chokidar fuse has its own test. */
async function armed(remote: MiniRemote, backend: "parcel" | "chokidar" = "parcel", opts: { watcherRearmClock?: WatcherRearmClock } = {}): Promise<DaemonInternals> {
  const d = makeDaemon(remote, opts);
  d.local.head = await scanManifest(root);
  const base = await d.loadSyncBase();
  d.want.push = true;
  await d.pump();
  const after = await d.loadSyncBase();
  // The rebuild lands BEFORE the fixture watcher exists: §3b's downgrade is about
  // rebuilds under a LIVE subscription, and arming must not trip it.
  d.rebuildMatcher(after ?? base);
  d.watcher = { backend, close: async () => {} };
  d.watcherTrust.healthy = true;
  d.watcherTrust.degraded = false;
  d.watcherTrust.state = "trusted";
  d.local.complete = true;
  d.activeCaseCollisions = [];
  d.resetLifecycle = "ready";
  await d.localObserver.observe({ kind: "scan", cache: d.cache, previous: after.lastSyncedManifest, mode: "unpruned" });
  lines.length = 0;
  return d;
}

const pullLine = (): string | undefined => lines.find((l) => l.startsWith("pull local="));

// ── 1. P-matrix + 206 test 5 skip-cause matrix ────────────────────────────────
test("design 202 P-matrix: every condition independently false drops the pull back to the scan path, naming its clause", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  const base = await d.loadSyncBase();

  expect((await d.buildTrustedPullView(base)).view).toBeDefined(); // armed baseline is trusted

  const cases: [string, string, () => void, () => void][] = [
    ["P1 no watcher", "p1-watcher", () => { d.watcher = undefined; }, () => { d.watcher = { backend: "parcel", close: async () => {} }; }],
    ["P1 unhealthy", "p1-watcher", () => { d.watcherTrust.healthy = false; }, () => { d.watcherTrust.healthy = true; }],
    ["P1 untrusted", "p1-watcher", () => { d.watcherTrust.state = "suspect"; }, () => { d.watcherTrust.state = "trusted"; }],
    ["P1 degraded", "p1-watcher", () => { d.watcherTrust.degraded = true; }, () => { d.watcherTrust.degraded = false; }],
    ["P2 incomplete observation", "p2-observation", () => { d.local.complete = false; }, () => { d.local.complete = true; }],
    ["P2 case collision", "p2-observation", () => { d.activeCaseCollisions = [{ paths: ["A.txt", "a.txt"] }]; }, () => { d.activeCaseCollisions = []; }],
    ["P5 no full-workspace install since seed", "p5-seed", () => { d.local.fullWorkspace = false; }, () => { d.local.fullWorkspace = true; }],
    ["P6 not ready", "p6-reset", () => { d.resetLifecycle = "recovering"; }, () => { d.resetLifecycle = "ready"; }],
    ["P7 stale matcher provenance", "p7-matcher", () => { d.matcherGitReposKey = "some/repo"; }, () => { d.matcherGitReposKey = ""; }],
    ["P7 manifest not observed under this matcher", "p7-matcher-observation",
      () => { d.local.observedGeneration -= 1; }, () => { d.local.observedGeneration += 1; }],
    ["F5 kill switch", "kill-switch", () => { process.env.RBOX_PULL_TRUST_WATCHER = "0"; }, () => { delete process.env.RBOX_PULL_TRUST_WATCHER; }],
  ];
  for (const [label, skip, br0k, restore] of cases) {
    br0k();
    expect((await d.buildTrustedPullView(base)).skip, label).toBe(skip as never);
    restore();
    expect((await d.buildTrustedPullView(base)).view, `${label} (restored)`).toBeDefined();
  }
});

// ── 206 test 11: the red herring never gates the predicate ────────────────────
test("design 206: rulesChangedSinceDeepScan is diagnostics-only and never gates buildTrustedPullView", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  d.rulesChangedSinceDeepScan = true;
  expect((await d.buildTrustedPullView(await d.loadSyncBase())).view).toBeDefined();
});

test("design 202 P3: the pre-pull drain applies pending events into the view; a deferred one is stripped and exempted", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  await fs.writeFile(path.join(root, "b.txt"), "two");
  d.pendingEvents.push({ relPath: "b.txt", kind: "change" });

  const view = (await d.buildTrustedPullView(await d.loadSyncBase())).view!;
  expect(d.pendingEvents.length).toBe(0);
  expect(view.manifest.files.some((f) => f.path === "b.txt")).toBe(true); // drained INTO the view
  expect(d.local.update).toEqual({ kind: "partial", source: "watch-events", paths: new Set(["b.txt"]) });
});

// ── 12. trusted-pull log line ─────────────────────────────────────────────────
test("design 202: an armed daemon logs `pull local=trusted` and refreshes with the O(applied) patch", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("n.txt", "new")]);

  d.want.pull = true;
  await d.pump();

  expect(pullLine()).toBe("pull local=trusted");
  expect(d.local.update?.kind).toBe("partial");
  expect((d.local.update as { source: string }).source).toBe("pull-applied");
  expect(await fs.readFile(path.join(root, "n.txt"), "utf8")).toBe("new");
});

// ── 2. stale trusted entry ────────────────────────────────────────────────────
test("design 202: a stale trusted entry degrades to a conflict copy — never loss — and the base still advances", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  // Disk moves behind the manifest with no watcher event: the trusted view is stale.
  await fs.writeFile(path.join(root, "a.txt"), "local-edit");
  remote.injectCommit([await remote.seedEntry("a.txt", "remote-edit")]);

  d.want.pull = true;
  await d.pump();

  expect(pullLine()).toBe("pull local=trusted");
  expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("remote-edit");
  const conflicts = (await fs.readdir(root)).filter((n) => n.startsWith("a.") && n !== "a.txt");
  expect(conflicts.length).toBe(1);
  expect(await fs.readFile(path.join(root, conflicts[0]!), "utf8")).toBe("local-edit"); // no loss
  expect((await d.loadSyncBase()).lastSyncedSequence).toBe(2);
});

// ── 3. refusal, rescan once, never halt ───────────────────────────────────────
test("design 202: a mass-delete trip under the trusted view refuses, re-pulls scan-backed once, and that run halts as designed", async () => {
  const remote = new MiniRemote();
  const names = Array.from({ length: 100 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);
  for (const n of names) await fs.writeFile(path.join(root, n), n);
  const d = await armed(remote);
  remote.injectCommit([]);

  d.want.pull = true;
  await d.pump();

  expect(lines).toContain("pull local=trusted refused=mass-delete");
  expect(d.activity.halt?.op).toBe("pull"); // the scan-backed re-run halts, as today
  for (const n of names) expect(await fs.readFile(path.join(root, n), "utf8")).toBe(n);
});

// ── 206 test 6: the refusal names itself on the pull line ─────────────────────
test("design 206: a refusal whose scan-backed re-run completes logs `pull local=scan skip=refused`", async () => {
  const remote = new MiniRemote();
  const names = Array.from({ length: 100 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);
  for (const n of names) await fs.writeFile(path.join(root, n), n);
  const d = await armed(remote);
  // Half the tree leaves disk with no watcher event: the trusted view still carries
  // 100 entries (guard trips at 100), a fresh scan carries 50 (below the floor).
  for (const n of names.slice(0, 50)) await fs.rm(path.join(root, n));
  remote.injectCommit([]);

  d.want.pull = true;
  await d.pump();

  expect(lines).toContain("pull local=trusted refused=mass-delete"); // details stay on their own line
  expect(pullLine()).toBe("pull local=trusted refused=mass-delete");
  expect(lines.filter((l) => l.startsWith("pull local=")).at(-1)).toBe("pull local=scan skip=refused");
  expect(d.activity.halt).toBeUndefined();
});

// ── 5. write-finish give-up ───────────────────────────────────────────────────
test("design 202: a write-finish give-up records the path as unsettled until a covering scan re-observes it", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  await fs.writeFile(path.join(root, "m.txt"), "mid-write");
  const d = await armed(remote);

  for (let i = 0; i < 16; i++) d.retryQueue.scheduleWriteFinish(new Set(["m.txt"])); // MAX_RETRIES = 15
  expect(d.local.unsettled.has("m.txt")).toBe(true);

  const view = (await d.buildTrustedPullView(await d.loadSyncBase())).view!;
  expect(view.manifest.files.some((f) => f.path === "m.txt")).toBe(false); // stripped
  expect(view.deferred.has("m.txt")).toBe(true); // and exempted

  await d.localObserver.observe({ kind: "scan", cache: d.cache, previous: (await d.loadSyncBase()).lastSyncedManifest, mode: "unpruned" });
  expect(d.local.unsettled.has("m.txt")).toBe(false); // healed by the covering scan
});

// ── 7. post-pull patch correctness ────────────────────────────────────────────
test("design 202: the O(applied) patch reflects write/delete/conflict, and a conflict copy lands in unsettledPaths", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "keep.txt"), "k");
  await fs.writeFile(path.join(root, "d.txt"), "doomed");
  await fs.writeFile(path.join(root, "c.txt"), "base");
  const d = await armed(remote);
  // A watched local edit: the drain patches it into the manifest, so reconcile sees
  // both sides diverge and plans a real `conflict` action with its keepLocalAs copy.
  await fs.writeFile(path.join(root, "c.txt"), "local-edit");
  d.pendingEvents.push({ relPath: "c.txt", kind: "change" });
  remote.injectCommit([
    await remote.seedEntry("keep.txt", "k"),
    await remote.seedEntry("n.txt", "new"),
    await remote.seedEntry("c.txt", "remote-edit"),
  ]);

  d.want.pull = true;
  await d.pump();
  expect(pullLine()).toBe("pull local=trusted");

  const byPath = new Map(d.local.head.files.map((f) => [f.path, f]));
  expect(byPath.get("n.txt")?.sha256).toBe(shaHex("new"));       // write installed
  expect(byPath.has("d.txt")).toBe(false);                        // delete removed
  expect(byPath.get("c.txt")?.sha256).toBe(shaHex("remote-edit")); // conflict → remote entry
  const copy = (await fs.readdir(root)).find((n) => n.startsWith("c.") && n !== "c.txt")!;
  expect(d.local.unsettled.has(copy)).toBe(true);                  // copy is unsettled, not authored
  expect(byPath.has(copy)).toBe(false);

  // The chained push publishes nothing spurious: no resurrection of d.txt, no stale
  // c.txt, and the not-yet-observed conflict copy waits for its watcher event.
  const published = (await remote.latest()).manifest;
  expect(published.files.some((f) => f.path === "d.txt")).toBe(false);
  expect(published.files.find((f) => f.path === "c.txt")?.sha256).toBe(shaHex("remote-edit"));
  expect(published.files.find((f) => f.path === "n.txt")?.sha256).toBe(shaHex("new"));
  expect(published.files.some((f) => f.path === copy)).toBe(false);
});

// ── 8. F2 git topology ────────────────────────────────────────────────────────
test("design 202 F2: gitTopologyChanged fires on a key-set change and on a section-value change", () => {
  const section = (head: string): GitSection => ({
    bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
    head, refs: { "refs/heads/main": "3".repeat(40) }, refScope: "all", generatedAt: "2026-07-26T00:00:00.000Z",
  });
  const state = (gitRepos: Record<string, GitSection>): SyncState => ({
    stream: "s", stateNonce: "n", stateRevision: 0, lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "", files: [], gitRepos, manifestSchema: 2 },
  });
  expect(gitTopologyChanged(state({}), state({}))).toBe(false);
  expect(gitTopologyChanged(state({ r: section("a") }), state({ r: section("a") }))).toBe(false);
  expect(gitTopologyChanged(state({}), state({ r: section("a") }))).toBe(true);
  expect(gitTopologyChanged(state({ r: section("a") }), state({}))).toBe(true);
  expect(gitTopologyChanged(state({ r: section("a") }), state({ r: section("b") }))).toBe(true);
});

test("design 202 F2: a pull that changes the base gitRepos set falls back to the scan, which registers repos immediately", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  // A real repo appears on disk; only the scan path discovers it.
  await fs.mkdir(path.join(root, "repo", ".git"), { recursive: true });
  await fs.writeFile(path.join(root, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
  const upserted: string[] = [];
  d.gitDiscovery.registry = {
    beginSnapshot: () => 1,
    applySnapshot: async () => {},
    upsert: async (repos: { relPath: string }[]) => { for (const r of repos) upserted.push(r.relPath); },
  };
  // Stage the resident pre-op topology immediately after the new held-mutex
  // boundary refresh. It is absent on disk and from the remote result; the real
  // repo below remains available for the healing scan to discover.
  const section: GitSection = {
    bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
    head: "ref: refs/heads/main\n", refs: {}, refScope: "all", generatedAt: "2026-07-26T00:00:00.000Z",
  };
  stagePreOpTopologyChange(d, { ghost: section });
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("n.txt", "new")], {});

  d.want.pull = true;
  await d.pump();

  expect(pullLine()).toBe("pull local=trusted fallback=git-topology");
  expect(d.local.update?.kind).toBe("full-workspace");
  expect(upserted).toContain("repo");
});

// ── 9. F1 / P4 watcher drop mid-pull ──────────────────────────────────────────
test("design 202 F1: a watcher drop during the pull fails the P4 re-check and forces the post-pull scan", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("n.txt", "new")]);
  remote.onLatest = () => { d.watcherTrust.errorGeneration++; remote.onLatest = undefined; };

  d.want.pull = true;
  await d.pump();

  expect(pullLine()).toBe("pull local=trusted fallback=watcher-drop");
  expect(d.local.update?.kind).toBe("full-workspace");
  expect(d.local.head.files.some((f) => f.path === "n.txt")).toBe(true); // the scan healed it
});

// ── 10. drift-audit accounting ────────────────────────────────────────────────
test("design 202: a deep-scan audit opened after the pre-pull drain does not mint drift for the drained paths", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  await fs.writeFile(path.join(root, "a.txt"), "edited");
  d.pendingEvents.push({ relPath: "a.txt", kind: "change" });
  remote.injectCommit([await remote.seedEntry("keep.txt", "k")]);

  d.want.pull = true;
  await d.pump(); // drains a.txt at the top of doPull

  await d.doDeepScan(); // audit opens AFTER that drain
  const audits = [...d.openDriftAudits];
  expect(audits.length).toBe(1);
  expect(audits[0]!.candidates).toEqual([]); // memory already matched disk
});

// ── 11. kill-switch matrix ────────────────────────────────────────────────────
test("design 202 kill switch: RBOX_PULL_TRUST_WATCHER=0 restores the scan path end to end", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  process.env.RBOX_PULL_TRUST_WATCHER = "0";
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("n.txt", "new")]);

  d.want.pull = true;
  await d.pump();

  expect(pullLine()).toBe("pull local=scan skip=kill-switch");
  expect(d.local.update?.kind).toBe("full-workspace");
  expect(await fs.readFile(path.join(root, "n.txt"), "utf8")).toBe("new");
});

/** Design 203 (lazy per-repo git probes) lands on a parallel branch; its switch
 *  must stay independent of this one. The combined steady-state assertion can only
 *  run once both are present. */
const lazyGitProbesPresent = fsSync
  .readFileSync(path.join(import.meta.dir, "../sync-git/apply.ts"), "utf8")
  .includes("RBOX_GIT_APPLY_LAZY");

test.skipIf(!lazyGitProbesPresent)("design 202 + 203 both on: a steady-state pull converges with neither a scan nor an eager probe", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  delete process.env.RBOX_PULL_TRUST_WATCHER; // both default ON
  delete process.env.RBOX_GIT_APPLY_LAZY;
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("n.txt", "new")]);

  d.want.pull = true;
  await d.pump();

  expect(pullLine()).toBe("pull local=trusted");
  expect(await fs.readFile(path.join(root, "n.txt"), "utf8")).toBe("new");
  expect(d.local.head.files.find((f) => f.path === "n.txt")?.sha256).toBe(shaHex("new"));
  expect((await d.loadSyncBase()).lastSyncedSequence).toBe(remote.head);
});

// ══ design 206 — matcher provenance must follow the base, skips must be named ══

const REPO_SECTION: GitSection = {
  bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
  head: "ref: refs/heads/main\n", refs: {}, refScope: "all", generatedAt: "2026-07-26T00:00:00.000Z",
};

const withRepos = (base: SyncState, gitRepos: Record<string, GitSection>): SyncState => ({
  ...base,
  lastSyncedManifest: { ...base.lastSyncedManifest, gitRepos, manifestSchema: 2 },
});

/** Install a one-shot test seam after the real held-mutex boundary reload and
 * before operation selection. This preserves the original F2 topology: the
 * resident pre-op base has a repo key the durable post-pull base will not. */
function stagePreOpTopologyChange(
  d: DaemonInternals,
  gitRepos: Record<string, GitSection> = { ghost: REPO_SECTION },
): void {
  const original = d.openOperationBoundary.bind(d);
  d.openOperationBoundary = async (syncMutex) => {
    const admitted = await original(syncMutex);
    d.openOperationBoundary = original;
    if (!admitted) return false;
    if (!d.syncBase) throw new Error("operation boundary did not refresh the durable base");
    d.syncBase = withRepos(d.syncBase, gitRepos);
    d.matcherGitReposKey = Object.keys(gitRepos).sort().join("\0");
    d.local.observedGeneration = d.matcherGeneration;
    return true;
  };
}

// ── 206 test 1 + 10: the #464 regression ──────────────────────────────────────
test("design 206 (#464): a git-topology pull falls back once, then the NEXT pull is trusted again", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  stagePreOpTopologyChange(d);
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("n.txt", "new")], {});

  d.want.pull = true;
  await d.pump();
  expect(pullLine()).toBe("pull local=trusted fallback=git-topology");
  // The healing scan ran under a matcher whose provenance is the post-pull
  // base, and its install stamped that observation as current.
  const base = await d.loadSyncBase();
  expect(d.matcherGitReposKey).toBe(gitReposMatcherKey(base));
  expect(d.local.observedGeneration).toBe(d.matcherGeneration);

  lines.length = 0;
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("n.txt", "new"), await remote.seedEntry("s.txt", "second")]);
  d.want.pull = true;
  await d.pump();
  expect(pullLine()).toBe("pull local=trusted"); // pre-206 this stayed local=scan until restart
});

// ── 206 test 2: the push-side latch ───────────────────────────────────────────
test("design 206: a base key-set change that arrives via the push path is not a permanent latch", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  await fs.writeFile(path.join(root, "p.txt"), "push me");
  // State-level simulation of the key change (MiniRemote has no git capture): the
  // base moved and no rebuild site fired, exactly what push completion left behind.
  d.matcherGitReposKey = "repo";

  d.want.push = true;
  await d.pump();
  expect(d.matcherGitReposKey).toBe(gitReposMatcherKey(await d.loadSyncBase())); // realigned

  lines.length = 0;
  d.want.pull = true;
  await d.pump();
  // The rebuild invalidated the manifest's observation provenance: one scan pull.
  expect(pullLine()).toBe("pull local=scan skip=p7-matcher-observation");

  lines.length = 0;
  d.want.pull = true;
  await d.pump();
  expect(pullLine()).toBe("pull local=trusted");
});

// ── 206 test 3: anti-re-trust invariant ───────────────────────────────────────
test("design 206: a rebuilt matcher with no full-workspace install since is skip=p7-matcher-observation", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  const base = await d.loadSyncBase();

  d.rebuildMatcher(base);
  expect((await d.buildTrustedPullView(base)).skip).toBe("p7-matcher-observation");

  d.want.pull = true;
  await d.pump();
  expect(pullLine()).toBe("pull local=scan skip=p7-matcher-observation");
});

// ── 206 test 4: capture at observation START, not at install ──────────────────
test("design 206: a rebuild landing mid-scan leaves the installed manifest stamped stale", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  const base = await d.loadSyncBase();

  // Fires strictly after the generation capture and strictly before the install —
  // the window a stamp-at-install-time implementation would wrongly credit.
  class RebuildDuringWalk extends HashCache {
    fired = false;
    lookup(rel: string, mtimeMs: number, size: number, ctimeMs: number): string | undefined {
      if (!this.fired) {
        this.fired = true;
        d.rebuildMatcher(base);
      }
      return super.lookup(rel, mtimeMs, size, ctimeMs);
    }
  }
  const cache = new RebuildDuringWalk();
  await d.localObserver.observe({ kind: "scan", cache, previous: base.lastSyncedManifest, mode: "unpruned" });

  expect(cache.fired).toBe(true);
  expect(d.local.observedGeneration).not.toBe(d.matcherGeneration);
  expect((await d.buildTrustedPullView(base)).skip).toBe("p7-matcher-observation");
});

// ── 206 test 7: the hot-path guard ────────────────────────────────────────────
test("design 206: loadSyncBase on an unchanged gitRepos key set rebuilds nothing", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  const matcher = d.matcher;
  const generation = d.matcherGeneration;

  await d.loadSyncBase();
  await d.loadSyncBase();

  expect(d.matcher).toBe(matcher);
  expect(d.matcherGeneration).toBe(generation);
});

// ── 206 test 8: the watcher follows the CURRENT matcher ───────────────────────
test("design 206: the watcher receives a facade that tracks rebuilds, not the matcher object", async () => {
  const clock: ScanCadenceClock = {
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  const d = makeDaemon(new MiniRemote(), { scanCadenceClock: clock });
  let captured: IgnoreMatcher | undefined;
  d.startWatcherFn = async (_root, matcher) => {
    captured = matcher;
    return { backend: "parcel", close: async () => {} };
  };
  await d.startLiveWatch();

  expect(captured).toBeDefined();
  expect(captured).not.toBe(d.matcher);
  expect(captured!.ignores("x.txt")).toBe(false);

  await fs.writeFile(path.join(root, ".rboxignore"), "x.txt\n");
  d.rebuildMatcher(await d.loadSyncBase());

  expect(captured!.ignores("x.txt")).toBe(true); // delegated, not captured-by-value
});

// ── 206 test 8b: backend-input downgrade (parcel) ──────────────────────────────
const DOWNGRADE_LINE = "watcher downgraded: ignore-rule change alters native watch coverage — pulls scan pending supervised re-arm";

test("design 237: a native-coverage fuse recovers through the same witnessed Parcel re-arm loop", async () => {
  delete process.env.RBOX_WATCHER_RETRUST;
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  let timer: { fn: () => void; ms: number } | undefined;
  const d = await armed(remote, "parcel", {
    watcherRearmClock: {
      setTimeout: (fn, ms) => {
        timer = { fn, ms };
        return { cancel: () => { timer = undefined; } };
      },
    },
  });
  d.startWatcherFn = async (_root, _matcher, _settle, opts) => {
    (opts as { onArm?: () => void }).onArm?.();
    return { backend: "parcel", close: async () => {} };
  };
  // `!dist/keep.txt` re-includes under a hard-pruned dir, so `dist` LEAVES the native
  // set — the live subscription's globs no longer match the matcher.
  await fs.writeFile(path.join(root, ".rboxignore"), "!dist/keep.txt\n");
  d.rebuildMatcher(await d.loadSyncBase());

  expect(lines).toContain(DOWNGRADE_LINE);
  expect(d.watcherTrust.state).toBe("fused");
  expect(d.watcher?.backend).toBe("parcel");
  expect(timer?.ms).toBe(120_000);

  lines.length = 0;
  d.want.pull = true;
  await d.pump();
  expect(pullLine()).toBe("pull local=scan skip=p1-watcher");

  await d.doFullScan(); // a pre-arm scan is not testimony
  expect(d.watcherTrust.state).toBe("fused");
  const fireRearm = timer!.fn;
  timer = undefined;
  fireRearm();
  await d.watcherSessions.drainReplacement();
  expect(d.watcherSessions.activeAttempt).toBeDefined();
  await d.pumpRun;
  expect(d.watcherTrust.state).toBe("trusted");
});

test("design 237 r4: post-arm recertification reads a real `.rboxignore` mutation", async () => {
  let timer: { fn: () => void; ms: number } | undefined;
  const d = await armed(new MiniRemote(), "parcel", {
    watcherRearmClock: {
      setTimeout: (fn, ms) => {
        timer = { fn, ms };
        return { cancel: () => { timer = undefined; } };
      },
    },
  });
  d.startWatcherFn = async (_root, _matcher, _settle, opts) => {
    fsSync.writeFileSync(path.join(root, ".rboxignore"), "!build/keep.txt\n");
    (opts as { onArm?: () => void }).onArm?.();
    return { backend: "parcel", close: async () => {} };
  };
  await fs.writeFile(path.join(root, ".rboxignore"), "!dist/keep.txt\n");
  d.rebuildMatcher(await d.loadSyncBase());

  timer!.fn();
  await d.watcherSessions.drainReplacement();

  expect(d.watcherTrust.state).toBe("fused");
  expect(d.watcherSessions.activeAttempt).toBeUndefined();
  expect(timer?.ms).toBe(240_000);
});

test("design 237 r4: daemon kill-switch transition synchronously cancels recovery", async () => {
  let timer: { fn: () => void; ms: number } | undefined;
  const d = await armed(new MiniRemote(), "parcel", {
    watcherRearmClock: {
      setTimeout: (fn, ms) => {
        timer = { fn, ms };
        return { cancel: () => { timer = undefined; } };
      },
    },
  });
  await fs.writeFile(path.join(root, ".rboxignore"), "!dist/keep.txt\n");
  d.rebuildMatcher(await d.loadSyncBase());
  expect(timer?.ms).toBe(120_000);

});

test("design 237 r4: publication recertifies real disk authority after the scan", async () => {
  let timer: { fn: () => void; ms: number } | undefined;
  const d = await armed(new MiniRemote(), "parcel", {
    watcherRearmClock: {
      setTimeout: (fn, ms) => {
        timer = { fn, ms };
        return { cancel: () => { timer = undefined; } };
      },
    },
  });
  d.startWatcherFn = async (_root, _matcher, _settle, opts) => {
    (opts as { onArm?: () => void }).onArm?.();
    return { backend: "parcel", close: async () => {} };
  };
  await fs.writeFile(path.join(root, ".rboxignore"), "!dist/keep.txt\n");
  d.rebuildMatcher(await d.loadSyncBase());

  const observe = d.localObserver.observe.bind(d.localObserver);
  let scanFinished!: () => void;
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { scanFinished = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let hold = true;
  d.localObserver.observe = async (plan) => {
    const result = await observe(plan);
    if (hold) {
      hold = false;
      scanFinished();
      await blocked;
    }
    return result;
  };

  timer!.fn();
  await d.watcherSessions.drainReplacement();
  await finished;
  await fs.writeFile(path.join(root, ".rboxignore"), "!build/keep.txt\n");
  release();
  await d.pumpRun;

  expect(d.watcherTrust.state).toBe("fused");
  expect(timer?.ms).toBe(240_000);
});

test("design 237 r4: daemon-classified fatal error makes a real stale scan inert while a newer attempt wins", async () => {
  let timer: { fn: () => void; ms: number } | undefined;
  let candidateCallbacks: { onArm?: () => void; onError?: (error: Error) => void } | undefined;
  const d = await armed(new MiniRemote(), "parcel", {
    watcherRearmClock: {
      setTimeout: (fn, ms) => {
        timer = { fn, ms };
        return { cancel: () => { timer = undefined; } };
      },
    },
  });
  d.startWatcherFn = async (_root, _matcher, _settle, opts) => {
    candidateCallbacks = opts as typeof candidateCallbacks;
    candidateCallbacks?.onArm?.();
    return { backend: "parcel", close: async () => {} };
  };
  await fs.writeFile(path.join(root, ".rboxignore"), "!dist/keep.txt\n");
  d.rebuildMatcher(await d.loadSyncBase());

  const observe = d.localObserver.observe.bind(d.localObserver);
  let firstScanFinished!: () => void;
  let releaseFirst!: () => void;
  const firstFinished = new Promise<void>((resolve) => { firstScanFinished = resolve; });
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let first = true;
  d.localObserver.observe = async (plan) => {
    const result = await observe(plan);
    if (first) {
      first = false;
      firstScanFinished();
      await firstBlocked;
    }
    return result;
  };

  timer!.fn();
  await d.watcherSessions.drainReplacement();
  await firstFinished;
  const firstAttempt = d.watcherSessions.activeAttempt;
  candidateCallbacks!.onError!(new Error("permission denied"));
  expect(d.watcherSessions.activeAttempt).toBeUndefined();
  expect(timer?.ms).toBe(240_000);

  timer!.fn();
  await d.watcherSessions.drainReplacement();
  expect(d.watcherSessions.activeAttempt).toBeDefined();
  expect(d.watcherSessions.activeAttempt).not.toBe(firstAttempt);
  releaseFirst();
  await d.pumpRun;

  expect(d.watcherTrust.state).toBe("trusted");
  expect(lines.some((line) => line.includes("stale scan inert"))).toBe(true);
});

test("design 237 r4: a real observer-flow refused commit cannot publish watcher trust", async () => {
  let timer: { fn: () => void; ms: number } | undefined;
  const d = await armed(new MiniRemote(), "parcel", {
    watcherRearmClock: {
      setTimeout: (fn, ms) => {
        timer = { fn, ms };
        return { cancel: () => { timer = undefined; } };
      },
    },
  });
  d.startWatcherFn = async (_root, _matcher, _settle, opts) => {
    (opts as { onArm?: () => void }).onArm?.();
    return { backend: "parcel", close: async () => {} };
  };
  await fs.writeFile(path.join(root, ".rboxignore"), "!dist/keep.txt\n");
  d.rebuildMatcher(await d.loadSyncBase());

  const authority = d.local as typeof d.local & {
    commitObservation(intent: LocalObservationCommitIntent): LocalObservationCommitReceipt;
    commitPatch(next: Manifest, update: ManifestUpdate & { kind: "partial" }, unsettled: UnsettledDirective): void;
  };
  const commitObservation = authority.commitObservation.bind(authority);
  let race = true;
  authority.commitObservation = (intent) => {
    if (race) {
      race = false;
      authority.commitPatch(authority.head, { kind: "partial", source: "pull-applied", paths: new Set() }, { add: [] });
    }
    return commitObservation(intent);
  };

  timer!.fn();
  await d.watcherSessions.drainReplacement();
  await d.pumpRun;

  expect(lines.some((line) => line.includes("not committed: stale-revision"))).toBe(true);
  expect(d.watcherTrust.state).toBe("fused");
  expect(timer?.ms).toBe(240_000);
});

test("design 237: watcher replacement never re-arms boot-owned safety or deep timers", async () => {
  let safetyArms = 0;
  let deepArms = 0;
  let rearm: { fn: () => void } | undefined;
  let starts = 0;
  const d = makeDaemon(new MiniRemote(), {
    scanCadenceClock: {
      setTimeout: () => ++safetyArms,
      clearTimeout: () => {},
      setInterval: () => ++deepArms,
      clearInterval: () => {},
    },
    watcherRearmClock: {
      setTimeout: (fn) => {
        rearm = { fn };
        return { cancel: () => { rearm = undefined; } };
      },
    },
  });
  d.startWatcherFn = async (_root, _matcher, _settle, opts) => {
    const callbacks = opts as { onArm?: () => void; onError?: (error: Error) => void };
    if (starts++ === 0) callbacks.onError?.(new Error("fatal during boot subscribe"));
    callbacks.onArm?.();
    return { backend: "parcel", close: async () => {} };
  };
  await d.startLiveWatch();
  expect([safetyArms, deepArms]).toEqual([1, 1]);
  expect(d.watcherTrust.state).toBe("fused");
  rearm!.fn();
  await d.watcherSessions.drainReplacement();
  await d.pumpRun;
  expect([safetyArms, deepArms]).toEqual([1, 1]);
});

test("design 237: a thrown witnessed scan advances watcher backoff without a daemon halt", async () => {
  delete process.env.RBOX_WATCHER_RETRUST;
  let timer: { fn: () => void; ms: number } | undefined;
  const d = await armed(new MiniRemote(), "parcel", {
    watcherRearmClock: {
      setTimeout: (fn, ms) => {
        timer = { fn, ms };
        return { cancel: () => { timer = undefined; } };
      },
    },
  });
  d.startWatcherFn = async (_root, _matcher, _settle, opts) => {
    (opts as { onArm?: () => void }).onArm?.();
    return { backend: "parcel", close: async () => {} };
  };
  await fs.writeFile(path.join(root, ".rboxignore"), "!dist/keep.txt\n");
  d.rebuildMatcher(await d.loadSyncBase());
  d.localObserver.observe = async () => { throw new Error("injected recovery scan failure"); };

  timer!.fn();
  await d.watcherSessions.drainReplacement();
  await d.pumpRun;

  expect(d.activity.halt).toBeUndefined();
  expect(d.watcherTrust.state).toBe("fused");
  expect(timer?.ms).toBe(240_000);
});

test("design 206 §3b: matcher coverage expanding into an ALWAYS_NATIVE_PRUNE dir downgrades even though the globs are unchanged", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  let timer: { fn: () => void; ms: number } | undefined;
  const d = await armed(remote, "parcel", {
    watcherRearmClock: {
      setTimeout: (fn, ms) => {
        timer = { fn, ms };
        return { cancel: () => { timer = undefined; } };
      },
    },
  });
  const globsBefore = d.watcherTrust.nativePruneKey;
  await fs.writeFile(path.join(root, ".rboxignore"), "!node_modules/\n");
  d.rebuildMatcher(await d.loadSyncBase());

  expect(nativePruneGlobs(root).join("\n")).toBe(globsBefore); // the r4 false negative
  expect(lines).toContain(DOWNGRADE_LINE);
  expect(d.watcherTrust.state).toBe("fused");
  const fireTerminalRearm = timer!.fn;
  timer = undefined;
  fireTerminalRearm();
  await d.watcherSessions.drainReplacement();
  expect(d.watcherSessions.activeAttempt).toBeUndefined();
  expect(timer).toBeUndefined();
  expect(watcherTrustLine("fused")).toContain("restarting rbox restores reactive sync");
});

test("design 206 §3b: a rebuild that leaves the backend inputs alone does NOT downgrade", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  await fs.writeFile(path.join(root, ".rboxignore"), "notes.txt\n");
  d.rebuildMatcher(await d.loadSyncBase());

  expect(lines).not.toContain(DOWNGRADE_LINE);
  expect(d.watcherTrust.state).toBe("trusted");

  lines.length = 0;
  d.want.pull = true;
  await d.pump(); // re-observes under the new matcher
  d.want.pull = true;
  lines.length = 0;
  await d.pump();
  expect(pullLine()).toBe("pull local=trusted");
});

test("design 206 §3b: on chokidar ANY rebuild downgrades — its watch admission bakes in `prunes`", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote, "chokidar");
  await fs.writeFile(path.join(root, ".rboxignore"), "notes.txt\n");
  d.rebuildMatcher(await d.loadSyncBase());

  expect(lines).toContain(DOWNGRADE_LINE);
  expect(d.watcherTrust.state).toBe("fused");
  expect(d.watcherSessions.rearmTimer).toBeUndefined();
});

// ── 206 test 8c: the observation-op boundary guard ────────────────────────────
test("design 206 §1: a hygiene-installed base with a changed key set is re-baselined by the next deep scan", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  // Hygiene installs syncBase directly and the pump prefers it over a reload: without
  // the op-boundary guard a pull-only daemon would deep-scan under the stale matcher.
  d.syncBase = withRepos(await d.loadSyncBase(), { repo: REPO_SECTION });

  await d.doDeepScan();

  expect(d.matcherGitReposKey).toBe(gitReposMatcherKey(d.syncBase!));
  expect(d.local.observedGeneration).toBe(d.matcherGeneration);
  expect((await d.buildTrustedPullView(d.syncBase!)).view).toBeDefined();
});

// ── 206 test 9: the founder's literal sequence ────────────────────────────────
test("design 206: clone → publish → delete → publish realigns P7 at every step", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  const base = await d.loadSyncBase();

  for (const gitRepos of [{ repo: REPO_SECTION }, {}, { repo: REPO_SECTION }, {}]) {
    d.syncBase = withRepos(base, gitRepos);
    await d.doFullScan(); // the pump-owned observation boundary of that step
    expect(d.matcherGitReposKey).toBe(gitReposMatcherKey(d.syncBase!));
    expect(d.local.observedGeneration).toBe(d.matcherGeneration);
    expect((await d.buildTrustedPullView(d.syncBase!)).view).toBeDefined();
  }
});
