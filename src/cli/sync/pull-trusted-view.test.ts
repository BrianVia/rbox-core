import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Design 202 — pull's main line may consume a TRUSTED local view instead of
// scanning. These tests pin the seam itself: what the view replaces, what it must
// still omit (design-108), what happens when the mass-delete guard trips on it, and
// that no other pull entry point can receive one.

import { PhaseReport, scanManifest, type Action, type BlobStore, type FileEntry, type Manifest } from "../../engine/index.js";
import { applyPulledManifest, MassDeleteGuardError, pull, push, TrustedViewRefusalError, type SyncDeps, type TrustedLocalView } from "../sync.js";
import { loadState, syncStreamId, type WorkspaceConfig } from "../config.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import type { CommitResult, SyncRemote } from "../remote.js";

const shaHex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const KEK = Buffer.alloc(32, 7);

/** Minimal in-memory server (mirrors sync-scan-defer.test.ts's FakeRemote). */
class FakeRemote implements SyncRemote {
  private head = 0;
  private readonly log = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  injectCommit(files: FileEntry[]): void {
    this.head += 1;
    this.log.set(this.head, { generatedAt: "", files });
  }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.log.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    this.blobs.set(sha256, await fs.readFile(absPath));
  }
  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    this.head += 1;
    this.log.set(this.head, manifest);
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

let root: string;
let cfg: WorkspaceConfig;
const deps = (remote: SyncRemote, extra: SyncDeps = {}): SyncDeps => ({ remote, backoff: async () => {}, ...extra });

/** The daemon's job before handing a view over: strip every unsettled path. */
async function viewOfDisk(unsettled: string[] = []): Promise<TrustedLocalView> {
  const scanned = await scanManifest(root);
  return {
    manifest: { ...scanned, files: scanned.files.filter((f) => !unsettled.includes(f.path)) },
    deferred: new Set(unsettled),
  };
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pull-trusted-")));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  cfg = {
    remoteWorkspaceId: "ws_t",
    projectId: "root",
    deviceId: "devA",
    rootPath: root,
    remoteUrl: "http://x",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_t",
    accountEpoch: 0,
    keyEpoch: 0,
  };
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

// Doc test 4 — unsettled stripping is the design-108 pin: an unsettled path is
// absent from `local`, so a remote deletion of it can never plan a disk delete.
test("design 202: an unsettled path is stripped from the trusted view, and a remote delete of it plans nothing", async () => {
  const remote = new FakeRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  await fs.writeFile(path.join(root, "keep.txt"), "k");
  expect((await push(root, cfg, deps(remote))).committed).toBe(true);

  // Remote drops a.txt (sequence 2) while the daemon considers a.txt unsettled.
  remote.injectCommit([await remote.seedEntry("keep.txt", "k")]);
  const view = await viewOfDisk(["a.txt"]);
  expect(view.manifest.files.some((f) => f.path === "a.txt")).toBe(false); // not vacuous

  const actions = await pull(root, cfg, deps(remote), view);

  expect(actions.some((a) => a.kind === "delete" && a.path === "a.txt")).toBe(false);
  expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("one"); // no loss
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(2); // base advances
});

// The control for the test above: a COMPLETE view (the same disk, nothing
// unsettled) does plan the delete — so the omission above is what suppressed it.
test("design 202: with the path present in the trusted view the same remote delete is planned", async () => {
  const remote = new FakeRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  await fs.writeFile(path.join(root, "keep.txt"), "k");
  await push(root, cfg, deps(remote));
  remote.injectCommit([await remote.seedEntry("keep.txt", "k")]);

  const actions = await pull(root, cfg, deps(remote), await viewOfDisk());
  expect(actions.some((a) => a.kind === "delete" && a.path === "a.txt")).toBe(true);
});

// Doc test 3 (seam half) — the guard trips BEFORE any action executes, and on the
// trusted path it refuses (rescan) instead of halting. Scan-backed it still halts.
test("design 202: a mass-delete trip on a trusted view refuses with zero actions; scan-backed it still halts", async () => {
  const remote = new FakeRemote();
  const names = Array.from({ length: 100 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);
  for (const n of names) await fs.writeFile(path.join(root, n), n);
  await push(root, cfg, deps(remote));
  remote.injectCommit([]); // remote wiped: 100 planned deletes against a 100-file baseline

  const view = await viewOfDisk();
  await expect(pull(root, cfg, deps(remote), view)).rejects.toBeInstanceOf(TrustedViewRefusalError);
  // Nothing executed: every file is still on disk and the base did not advance.
  for (const n of names) expect(await fs.readFile(path.join(root, n), "utf8")).toBe(n);
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(1);

  // The scan-backed re-run the daemon performs after a refusal keeps today's halt.
  await expect(pull(root, cfg, deps(remote))).rejects.toBeInstanceOf(MassDeleteGuardError);
});

// Doc test 12 (seam half) — the trusted view REPLACES the walk: no scan progress
// is discovered and the `scan` phase costs ~nothing.
test("design 202: a trusted pull walks nothing — no scan discovery, scan phase ≈ 0", async () => {
  const remote = new FakeRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  await push(root, cfg, deps(remote));
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("b.txt", "two")]);

  const scanTicks: number[] = [];
  const onProgress = (done: number, _total: number, phase: string) => { if (phase === "scan") scanTicks.push(done); };
  const report = PhaseReport.pull();
  await pull(root, cfg, deps(remote, { onProgress, report }), await viewOfDisk());
  expect(scanTicks).toEqual([]);
  const scanMs = report.toJSON().phases.scan?.ms ?? -1;
  expect(scanMs).toBeGreaterThanOrEqual(0);
  expect(scanMs).toBeLessThanOrEqual(5); // an awaited constant, not a tree walk

  // Not vacuous: the same pull shape without a view really does discover a tree.
  remote.injectCommit([await remote.seedEntry("a.txt", "one"), await remote.seedEntry("b.txt", "two"), await remote.seedEntry("c.txt", "three")]);
  await pull(root, cfg, deps(remote, { onProgress }));
  expect(scanTicks.length).toBeGreaterThan(0);
});

// Doc test 6 (seam half) — single-use is structural: only `pullWithMetadata`'s main
// line forwards a view. Every other entry point (the resolution-receipt inner pull,
// each chain-repair iteration, the post-repair re-pull, CLI one-shots) calls
// `applyPulledManifest`/`pull` WITHOUT one and therefore reads disk. A view that
// lies about disk proves which of the two happened.
test("design 202: applyPulledManifest without a view scans disk even when a trusted view exists for the op", async () => {
  const remote = new FakeRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  await push(root, cfg, deps(remote));

  // Disk moves on behind the (now stale) view.
  await fs.writeFile(path.join(root, "a.txt"), "edited-locally");
  const staleView = await viewOfDisk();
  await fs.writeFile(path.join(root, "a.txt"), "edited-again");

  remote.injectCommit([await remote.seedEntry("a.txt", "remote")]);
  const head = await remote.latest();
  const actions: Action[] = await applyPulledManifest(root, cfg, deps(remote), remote, {
    sequence: head.sequence,
    manifest: head.manifest,
  });
  // Scanned: the conflict copy holds "edited-again" (real disk), not the view's bytes.
  const conflict = actions.find((a) => a.kind === "conflict");
  expect(conflict).toBeDefined();
  expect(await fs.readFile(path.join(root, (conflict as Extract<Action, { kind: "conflict" }>).keepLocalAs), "utf8")).toBe("edited-again");
  expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("remote");
  expect(staleView.manifest.files.find((f) => f.path === "a.txt")!.sha256).toBe(shaHex("edited-locally")); // the view really was stale
});
