import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyActions,
  applyStatsDelta,
  setApplyStatsEnabled,
  snapshotApplyStats,
  type Action,
  type ApplyStats,
  type BlobStore,
  type FileEntry,
} from "./index.js";

const roots: string[] = [];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(paths: Array<[string, Buffer]>): { actions: Action[]; store: BlobStore } {
  const blobs = new Map<string, Buffer>();
  const entries: FileEntry[] = paths.map(([entryPath, bytes]) => {
    const sha256 = sha(bytes);
    blobs.set(sha256, bytes);
    return { path: entryPath, type: "file", sha256, size: bytes.length, mode: 0o644, mtimeMs: 1 };
  });
  return {
    actions: entries.map((entry) => ({ kind: "write", entry, expectedLocal: undefined })),
    store: {
      async has(key) { return blobs.has(key); },
      async put(key, bytes) { blobs.set(key, Buffer.from(bytes)); },
      async get(key) { return blobs.get(key)!; },
      async getToFile(key, dest) { await fs.writeFile(dest, blobs.get(key)!); },
    },
  };
}

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-apply-stats-"));
  roots.push(root);
  return root;
}

async function measuredApply(root: string, actions: Action[], store: BlobStore): Promise<{ delta: ApplyStats; wallMs: number }> {
  setApplyStatsEnabled(true);
  const before = snapshotApplyStats();
  const t0 = performance.now();
  try {
    await applyActions(root, actions, store);
    return { delta: applyStatsDelta(before), wallMs: performance.now() - t0 };
  } finally {
    setApplyStatsEnabled(false);
  }
}

afterEach(async () => {
  setApplyStatsEnabled(false);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("phase decomposition tracks apply wall", async () => {
  const root = await tempRoot();
  const { actions, store } = fixture(Array.from({ length: 20 }, (_, i) => [`tree/nested/d${i % 4}/f${i}.txt`, Buffer.from(`payload-${i}`)]));
  const { delta, wallMs } = await measuredApply(root, actions, store);
  const phases = delta.preflightMs + delta.writePoolMs;
  expect(phases).toBeLessThanOrEqual(wallMs);
  expect(phases).toBeGreaterThanOrEqual(wallMs * 0.5);
});

test("syscall and directory counters describe a known tree", async () => {
  const root = await tempRoot();
  const { actions, store } = fixture([
    ["alpha/one.txt", Buffer.from("1")],
    ["alpha/beta/two.txt", Buffer.from("22")],
    ["gamma/three.txt", Buffer.from("333")],
  ]);
  const { delta } = await measuredApply(root, actions, store);
  expect(delta.uniqueDirs).toBe(3);
  expect(delta.dirComponentWalks).toBe(4);
  expect(delta.mkdirCalls).toBeGreaterThanOrEqual(3);
  expect(delta.mkdirCreated).toBeLessThanOrEqual(delta.mkdirCalls);
  expect(delta.renameCalls).toBeGreaterThanOrEqual(3);
  expect(delta.stageCalls).toBe(3);
});

test("size buckets partition staged blobs", async () => {
  const root = await tempRoot();
  const small = Buffer.from("small");
  const large = Buffer.alloc(1_000_001, 7);
  const { actions, store } = fixture([["small.bin", small], ["large.bin", large]]);
  const { delta } = await measuredApply(root, actions, store);
  expect(delta.smallCount).toBe(1);
  expect(delta.largeCount).toBe(1);
  expect(delta.smallBytes).toBe(small.length);
  expect(delta.largeBytes).toBe(large.length);
  expect(delta.smallCount + delta.largeCount).toBe(delta.stageCalls);
});

test("disabled instrumentation produces a zero delta", async () => {
  const root = await tempRoot();
  const { actions, store } = fixture([["off/file.txt", Buffer.from("off")]]);
  const before = snapshotApplyStats();
  await applyActions(root, actions, store);
  expect(Object.values(applyStatsDelta(before)).every((value) => value === 0)).toBe(true);
});

test("sequential snapshots isolate each apply delta", async () => {
  const first = fixture([["first/a.txt", Buffer.from("a")]]);
  const second = fixture([["second/b.txt", Buffer.from("b")], ["second/c.txt", Buffer.from("c")]]);
  const d1 = (await measuredApply(await tempRoot(), first.actions, first.store)).delta;
  const d2 = (await measuredApply(await tempRoot(), second.actions, second.store)).delta;
  expect(d1.stageCalls).toBe(1);
  expect(d2.stageCalls).toBe(2);
  expect(d2.smallBytes).toBe(2);
});
