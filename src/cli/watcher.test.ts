import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, type WatchEvent } from "../engine/index.js";
import { startWatcher, type Watcher } from "./watcher.js";

// These exercise the DEFAULT (@parcel/watcher) backend end-to-end on a real temp
// tree: the design-§41 swap that took the founder's workspace from ~11 GB / 330 s
// to ~60 MB / <1 s. They assert the memory/latency win AND that correctness
// (event delivery, authoritative JS ignore post-filter, atomic saves, directory
// ops, coalescing) survives the backend change. Small, bounded, CI-safe.

const DEBOUNCE = 40;
let active: Watcher | undefined;
let roots: string[] = [];

afterEach(async () => {
  await active?.close().catch(() => {});
  active = undefined;
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

function tmpRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-watch-test-"));
  roots.push(r);
  return r;
}

/** Start the watcher, accumulating every settled event. */
async function watch(root: string, extraIgnore = "") {
  if (extraIgnore) fs.writeFileSync(path.join(root, ".rboxignore"), extraIgnore);
  const settled: WatchEvent[] = [];
  const matcher = buildIgnoreMatcher(root);
  const t0 = Date.now();
  active = await startWatcher(root, matcher, (evs) => settled.push(...evs), { debounceMs: DEBOUNCE });
  const readyMs = Date.now() - t0;
  // Let the OS watch's initial snapshot settle before the test mutates, so a
  // mutation isn't raced against baseline establishment (would surface a spurious
  // create instead of the update). Realistic: nothing edits files µs after boot.
  await new Promise((r) => setTimeout(r, 200));
  return { settled, readyMs };
}

/** Poll until `pred()` or timeout; returns whether it became true. */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

const has = (evs: WatchEvent[], relPath: string, kind?: string) =>
  evs.some((e) => e.relPath === relPath && (kind === undefined || e.kind === kind));

test("delivers a file create as an `add` event with the POSIX-relative path", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root);
  fs.writeFileSync(path.join(root, "hello.txt"), "hi");
  expect(await waitFor(() => has(settled, "hello.txt", "add"))).toBe(true);
});

test("delivers a modify as a `change` event", async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "a.txt"), "one");
  const { settled } = await watch(root);
  fs.writeFileSync(path.join(root, "a.txt"), "two");
  expect(await waitFor(() => has(settled, "a.txt", "change"))).toBe(true);
});

test("JS matcher is the authoritative post-filter: a `.rboxignore` glob suppresses events natively-unpruned", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root, "*.log\n");
  fs.writeFileSync(path.join(root, "keep.txt"), "x");
  fs.writeFileSync(path.join(root, "debug.log"), "x"); // matched only by the JS matcher, not native prune
  expect(await waitFor(() => has(settled, "keep.txt"))).toBe(true);
  // give the ignored one ample time to (not) show up
  await new Promise((r) => setTimeout(r, 400));
  expect(has(settled, "debug.log")).toBe(false);
});

test("respects negation re-includes: `.env` filtered, `.env.example` delivered", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root);
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(root, ".env.example"), "SECRET=");
  expect(await waitFor(() => has(settled, ".env.example"))).toBe(true);
  await new Promise((r) => setTimeout(r, 400));
  expect(has(settled, ".env")).toBe(false);
});

test("atomic write-then-rename (editor save) surfaces the FINAL path, not the temp", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root);
  const tmp = path.join(root, ".save.tmp");
  const final = path.join(root, "doc.md");
  fs.writeFileSync(tmp, "content");
  fs.renameSync(tmp, final);
  expect(await waitFor(() => has(settled, "doc.md"))).toBe(true);
});

test("directory delete removes the whole subtree via `unlinkDir`", async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "f.txt"), "x");
  const { settled } = await watch(root);
  fs.rmSync(path.join(root, "sub"), { recursive: true, force: true });
  // The delete maps to unlinkDir(sub), which applyWatchEvents expands to remove sub + sub/**.
  expect(await waitFor(() => has(settled, "sub", "unlinkDir"))).toBe(true);
});

test("create-then-delete within one debounce window coalesces to the delete (last-kind-wins)", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root);
  const f = path.join(root, "ephemeral.txt");
  fs.writeFileSync(f, "x");
  fs.rmSync(f, { force: true });
  // Whatever settles, the net must be the removal — never a stale `add`.
  expect(await waitFor(() => settled.some((e) => e.relPath === "ephemeral.txt"))).toBe(true);
  const last = [...settled].reverse().find((e) => e.relPath === "ephemeral.txt");
  expect(last?.kind).toBe("unlinkDir"); // our delete mapping; covers file-or-dir removal
});

test("SCALE (design §41): monorepo-shaped tree — ready fast, memory flat, node_modules pruned", async () => {
  const root = tmpRoot();
  // Synthetic ~2,600-file tree: a real source tree + a big node_modules that MUST
  // be pruned by the native ignore (the thing that pegged chokidar at 11 GB).
  for (let d = 0; d < 60; d++) {
    const dir = path.join(root, "src", `mod${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(dir, `f${f}.ts`), "export const x = 1;\n");
  }
  for (let d = 0; d < 200; d++) {
    const dir = path.join(root, "node_modules", `pkg${d}`, "dist");
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(dir, `i${f}.js`), "module.exports={};\n");
  }

  const { settled, readyMs } = await watch(root);

  // Ready fast (chokidar took ~330 s on the real corpus; the gate is 10 s).
  expect(readyMs).toBeLessThan(10_000);
  // Memory flat — nowhere near chokidar's multi-GB. Generous 300 MB gate.
  expect(process.memoryUsage.rss()).toBeLessThan(300 * 1024 * 1024);

  // A create under node_modules must produce ZERO events (native prune).
  fs.writeFileSync(path.join(root, "node_modules", "pkg0", "dist", "new.js"), "x");
  // A create in src must be delivered.
  fs.writeFileSync(path.join(root, "src", "mod0", "live.ts"), "x");

  expect(await waitFor(() => has(settled, "src/mod0/live.ts"))).toBe(true);
  await new Promise((r) => setTimeout(r, 400));
  expect(settled.some((e) => e.relPath.includes("node_modules"))).toBe(false);
});
