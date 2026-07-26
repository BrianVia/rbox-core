import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Design 202 — the daemon hands its watcher-maintained manifest to the single
// top-level pull of an op when the trust predicate P holds, and refreshes it
// afterwards with an O(applied) patch unless a fallback trigger fires.

import { HashCache, scanManifest, type BlobStore, type FileEntry, type GitSection, type Manifest } from "../../engine/index.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import { RboxDaemon } from "./daemon.js";
import { gitTopologyChanged } from "./manifest-update.js";
import type { ManifestUpdate } from "./manifest-update.js";
import type { CommitResult, SyncRemote } from "../remote.js";
import type { SyncState, WorkspaceConfig } from "../config.js";
import type { TrustedLocalView } from "../sync.js";

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
    this.manifests.set(this.head, { generatedAt: "", files, ...(gitRepos ? { gitRepos, manifestSchema: 2 as const } : {}) });
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
  manifest: Manifest;
  matcher: unknown;
  matcherGitReposKey: string;
  syncBase?: SyncState;
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  writeFinishRetryTimers: Set<ReturnType<typeof setTimeout>>;
  pendingEvents: { relPath: string; kind: string }[];
  unsettledPaths: Set<string>;
  lastManifestUpdate?: ManifestUpdate;
  fullWorkspaceSinceSeed: boolean;
  manifestObservationComplete: boolean;
  activeCaseCollisions: { paths: string[] }[];
  resetLifecycle: "ready" | "halted" | "recovering" | "bootstrapping";
  watcher?: { backend: "parcel" | "chokidar"; close(): Promise<void> };
  watcherHealthy: boolean;
  watcherDegraded: boolean;
  watcherErrorGeneration: number;
  trustState: "trusted" | "suspect" | "fused";
  gitRefRegistry?: unknown;
  openDriftAudits: Set<{ candidates: unknown[]; timer?: ReturnType<typeof setTimeout> }>;
  activity: { halt?: { op: string; message?: string } };
  pump(): Promise<void>;
  doDeepScan(): Promise<unknown>;
  loadSyncBase(): Promise<SyncState>;
  rebuildMatcher(state?: { lastSyncedManifest: Manifest }): void;
  scheduleWriteFinishRetry(paths: Set<string>): void;
  buildTrustedPullView(base: SyncState): Promise<TrustedLocalView | undefined>;
  replaceManifestFromScan(
    cache: HashCache, previous: Manifest, stats: undefined, kind: undefined, mode: "pruned" | "unpruned",
  ): Promise<{ deferred: Set<string>; coverage: string }>;
}

let root: string;
let lines: string[];
let daemon: DaemonInternals | undefined;

beforeEach(async () => {
  // Tests pin default-ON behavior; an ambient kill-switch run must not leak in.
  delete process.env.RBOX_PULL_TRUST_WATCHER;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-trusted-pull-")));
  lines = [];
});
afterEach(async () => {
  for (const t of daemon?.writeFinishRetryTimers ?? []) clearTimeout(t);
  for (const audit of daemon?.openDriftAudits ?? []) if (audit.timer) clearTimeout(audit.timer);
  daemon = undefined;
  delete process.env.RBOX_PULL_TRUST_WATCHER;
  await fs.rm(root, { recursive: true, force: true });
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

function makeDaemon(remote: MiniRemote): DaemonInternals {
  const d = new RboxDaemon(root, testConfig(), { remote, backoff: async () => {} }, {
    bootId: "boot-trust",
    log: (line: string) => lines.push(line),
  }) as unknown as DaemonInternals;
  d.cache = new HashCache();
  daemon = d;
  return d;
}

/** Baseline: publish the current tree, then bring the daemon into the state P
 *  describes — live trusted watcher, complete manifest from a full-workspace scan,
 *  matcher current with the base's gitRepos, nothing pending. */
async function armed(remote: MiniRemote): Promise<DaemonInternals> {
  const d = makeDaemon(remote);
  d.manifest = await scanManifest(root);
  const base = await d.loadSyncBase();
  d.want.push = true;
  await d.pump();
  const after = await d.loadSyncBase();
  d.watcher = { backend: "chokidar", close: async () => {} };
  d.watcherHealthy = true;
  d.watcherDegraded = false;
  d.trustState = "trusted";
  d.manifestObservationComplete = true;
  d.activeCaseCollisions = [];
  d.resetLifecycle = "ready";
  d.rebuildMatcher(after ?? base);
  await d.replaceManifestFromScan(d.cache, after.lastSyncedManifest, undefined, undefined, "unpruned");
  lines.length = 0;
  return d;
}

const pullLine = (): string | undefined => lines.find((l) => l.startsWith("pull local="));

// ── 1. P-matrix ────────────────────────────────────────────────────────────────
test("design 202 P-matrix: every condition independently false drops the pull back to the scan path", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  const base = await d.loadSyncBase();

  expect(await d.buildTrustedPullView(base)).toBeDefined(); // armed baseline is trusted

  const cases: [string, () => void, () => void][] = [
    ["P1 no watcher", () => { d.watcher = undefined; }, () => { d.watcher = { backend: "chokidar", close: async () => {} }; }],
    ["P1 unhealthy", () => { d.watcherHealthy = false; }, () => { d.watcherHealthy = true; }],
    ["P1 untrusted", () => { d.trustState = "suspect"; }, () => { d.trustState = "trusted"; }],
    ["P1 degraded", () => { d.watcherDegraded = true; }, () => { d.watcherDegraded = false; }],
    ["P2 incomplete observation", () => { d.manifestObservationComplete = false; }, () => { d.manifestObservationComplete = true; }],
    ["P2 case collision", () => { d.activeCaseCollisions = [{ paths: ["A.txt", "a.txt"] }]; }, () => { d.activeCaseCollisions = []; }],
    ["P5 no full-workspace install since seed", () => { d.fullWorkspaceSinceSeed = false; }, () => { d.fullWorkspaceSinceSeed = true; }],
    ["P6 not ready", () => { d.resetLifecycle = "recovering"; }, () => { d.resetLifecycle = "ready"; }],
    ["P7 stale matcher provenance", () => { d.matcherGitReposKey = "some/repo"; }, () => { d.matcherGitReposKey = ""; }],
    ["F5 kill switch", () => { process.env.RBOX_PULL_TRUST_WATCHER = "0"; }, () => { delete process.env.RBOX_PULL_TRUST_WATCHER; }],
  ];
  for (const [label, br0k, restore] of cases) {
    br0k();
    expect(await d.buildTrustedPullView(base), label).toBeUndefined();
    restore();
    expect(await d.buildTrustedPullView(base), `${label} (restored)`).toBeDefined();
  }
});

test("design 202 P3: the pre-pull drain applies pending events into the view; a deferred one is stripped and exempted", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  await fs.writeFile(path.join(root, "b.txt"), "two");
  d.pendingEvents.push({ relPath: "b.txt", kind: "change" });

  const view = (await d.buildTrustedPullView(await d.loadSyncBase()))!;
  expect(d.pendingEvents.length).toBe(0);
  expect(view.manifest.files.some((f) => f.path === "b.txt")).toBe(true); // drained INTO the view
  expect(d.lastManifestUpdate).toEqual({ kind: "partial", source: "watch-events", paths: new Set(["b.txt"]) });
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
  expect(d.lastManifestUpdate?.kind).toBe("partial");
  expect((d.lastManifestUpdate as { source: string }).source).toBe("pull-applied");
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

// ── 5. write-finish give-up ───────────────────────────────────────────────────
test("design 202: a write-finish give-up records the path as unsettled until a covering scan re-observes it", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  await fs.writeFile(path.join(root, "m.txt"), "mid-write");
  const d = await armed(remote);

  for (let i = 0; i < 16; i++) d.scheduleWriteFinishRetry(new Set(["m.txt"])); // MAX_RETRIES = 15
  expect(d.unsettledPaths.has("m.txt")).toBe(true);

  const view = (await d.buildTrustedPullView(await d.loadSyncBase()))!;
  expect(view.manifest.files.some((f) => f.path === "m.txt")).toBe(false); // stripped
  expect(view.deferred.has("m.txt")).toBe(true); // and exempted

  await d.replaceManifestFromScan(d.cache, (await d.loadSyncBase()).lastSyncedManifest, undefined, undefined, "unpruned");
  expect(d.unsettledPaths.has("m.txt")).toBe(false); // healed by the covering scan
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

  const byPath = new Map(d.manifest.files.map((f) => [f.path, f]));
  expect(byPath.get("n.txt")?.sha256).toBe(shaHex("new"));       // write installed
  expect(byPath.has("d.txt")).toBe(false);                        // delete removed
  expect(byPath.get("c.txt")?.sha256).toBe(shaHex("remote-edit")); // conflict → remote entry
  const copy = (await fs.readdir(root)).find((n) => n.startsWith("c.") && n !== "c.txt")!;
  expect(d.unsettledPaths.has(copy)).toBe(true);                  // copy is unsettled, not authored
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
  d.gitRefRegistry = {
    beginSnapshot: () => 1,
    applySnapshot: async () => {},
    upsert: async (repos: { relPath: string }[]) => { for (const r of repos) upserted.push(r.relPath); },
  };
  // The pre-op base carries a repo the post-pull base will not: exactly the shape
  // F2 detects when a pull materializes or drops a repo.
  const base = await d.loadSyncBase();
  const section: GitSection = {
    bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
    head: "ref: refs/heads/main\n", refs: {}, refScope: "all", generatedAt: "2026-07-26T00:00:00.000Z",
  };
  d.syncBase = { ...base, lastSyncedManifest: { ...base.lastSyncedManifest, gitRepos: { repo: section }, manifestSchema: 2 } };
  d.matcherGitReposKey = "repo"; // P7 is measured against that same pre-op base
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("n.txt", "new")]);

  d.want.pull = true;
  await d.pump();

  expect(pullLine()).toBe("pull local=trusted fallback=git-topology");
  expect(d.lastManifestUpdate?.kind).toBe("full-workspace");
  expect(upserted).toContain("repo");
});

// ── 9. F1 / P4 watcher drop mid-pull ──────────────────────────────────────────
test("design 202 F1: a watcher drop during the pull fails the P4 re-check and forces the post-pull scan", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const d = await armed(remote);
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("n.txt", "new")]);
  remote.onLatest = () => { d.watcherErrorGeneration++; remote.onLatest = undefined; };

  d.want.pull = true;
  await d.pump();

  expect(pullLine()).toBe("pull local=trusted fallback=watcher-drop");
  expect(d.lastManifestUpdate?.kind).toBe("full-workspace");
  expect(d.manifest.files.some((f) => f.path === "n.txt")).toBe(true); // the scan healed it
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

  expect(pullLine()).toBe("pull local=scan");
  expect(d.lastManifestUpdate?.kind).toBe("full-workspace");
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
  expect(d.manifest.files.find((f) => f.path === "n.txt")?.sha256).toBe(shaHex("new"));
  expect((await d.loadSyncBase()).lastSyncedSequence).toBe(remote.head);
});
