import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, type WatchEvent } from "../engine/index.js";
import { createBatcher, startWatcher, type Watcher } from "./watcher.js";

// These exercise the DEFAULT (@parcel/watcher) backend end-to-end on a real temp
// tree: the design-§41 swap that took the founder's workspace from ~11 GB / 330 s
// to ~60 MB / <1 s. They assert the memory/latency win AND that correctness
// (event delivery, authoritative JS ignore post-filter, atomic saves, directory
// ops, coalescing) survives the backend change.
//
// Some sandboxed/headless CI can't start a native OS watcher ("Error starting
// FSEvents stream"). Rather than fail there, probe once and skip if unavailable —
// on Linux CI (inotify) and dev machines the probe succeeds and the suite runs.

const DEBOUNCE = 40;
let active: Watcher | undefined;
let roots: string[] = [];

// Probe the native @parcel/watcher DIRECTLY — never through `./watcher.js` — so the
// process-global `mock.module("./watcher.js")` in daemon-watch-degrade.test.ts can't corrupt
// this capability signal. Retry a few times: a genuine sandbox fails every attempt, a
// transient FSEvents spike under full-suite CPU contention may fail once (must not skip on that).
async function probeNativeWatch(attempts = 3): Promise<{ ok: boolean; err: string }> {
  const req = createRequire(import.meta.url);
  let err = "";
  for (let i = 0; i < attempts; i++) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-probe-")));
    try {
      const parcel = req("@parcel/watcher") as { subscribe: (d: string, f: () => void, o: object) => Promise<{ unsubscribe(): Promise<void> }> };
      const sub = await parcel.subscribe(dir, () => {}, {});
      await sub.unsubscribe();
      return { ok: true, err: "" };
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return { ok: false, err };
}
// Skip ONLY a genuinely-unsupported macOS sandbox (no FSEvents stream). Linux/inotify and a
// normal macOS MUST run the native suite — a watcher that fails to start there is a real
// regression, never a silent skip (positive-capability gate, not "any error").
const cap = await probeNativeWatch();
const skipNative = !cap.ok && process.platform === "darwin" && /fsevents|not permitted|sandbox|eperm/i.test(cap.err);
// Every native-watch test gets a GENEROUS explicit timeout — the bun-test default is 5s, but
// `waitFor` polls up to 12s, and inotify on a loaded CI runner delivers events noticeably
// slower than macOS FSEvents. Without this, a slow-but-correct delivery times out at 5001ms.
const gated = test.skipIf(skipNative);
const wtest = (name: string, fn: () => void | Promise<void>, timeoutMs = 20_000) => gated(name, fn, timeoutMs);

afterEach(async () => {
  await active?.close().catch(() => {});
  active = undefined;
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

function tmpRoot(): string {
  // realpath so parcel's resolved event paths line up (macOS /tmp → /private/tmp).
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-watch-test-")));
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

/** Poll until `pred()` or timeout; returns whether it became true. Generous default so a
 *  native-watcher latency spike under full-suite CPU contention doesn't flake the assert. */
async function waitFor(pred: () => boolean, timeoutMs = 12000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

const has = (evs: WatchEvent[], relPath: string, kind?: string) =>
  evs.some((e) => e.relPath === relPath && (kind === undefined || e.kind === kind));

wtest("delivers a file create as an `add` event with the POSIX-relative path", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root);
  fs.writeFileSync(path.join(root, "hello.txt"), "hi");
  expect(await waitFor(() => has(settled, "hello.txt", "add"))).toBe(true);
});

wtest("delivers a modify as a `change` event", async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "a.txt"), "one");
  const { settled } = await watch(root);
  fs.writeFileSync(path.join(root, "a.txt"), "two");
  expect(await waitFor(() => has(settled, "a.txt", "change"))).toBe(true);
});

wtest("JS matcher is authoritative: a `.rboxignore` glob suppresses events the native prune doesn't", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root, "*.log\n");
  fs.writeFileSync(path.join(root, "keep.txt"), "x");
  fs.writeFileSync(path.join(root, "debug.log"), "x"); // matched only by the JS matcher, not native prune
  expect(await waitFor(() => has(settled, "keep.txt"))).toBe(true);
  await new Promise((r) => setTimeout(r, 400));
  expect(has(settled, "debug.log")).toBe(false);
});

wtest("respects negation re-includes: `.env` filtered, `.env.example` delivered", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root);
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(root, ".env.example"), "SECRET=");
  expect(await waitFor(() => has(settled, ".env.example"))).toBe(true);
  await new Promise((r) => setTimeout(r, 400));
  expect(has(settled, ".env")).toBe(false);
});

wtest("a re-included hard-prune dir (`!dist/`) delivers LIVE events, not just via the safety scan", async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "dist"));
  // `!dist/` un-ignores the dir → it must be DROPPED from the native prune set so its
  // live events reach the JS matcher (which now re-includes it). Guards finding-2.
  const { settled } = await watch(root, "!dist/\n");
  fs.writeFileSync(path.join(root, "dist", "keep.txt"), "x");
  expect(await waitFor(() => has(settled, "dist/keep.txt"))).toBe(true);
});

wtest("dotdot-named files (`..keep`) are delivered, not treated as escaping the root", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root);
  fs.writeFileSync(path.join(root, "..keep"), "x");
  expect(await waitFor(() => has(settled, "..keep"))).toBe(true);
});

wtest("atomic write-then-rename (editor save) surfaces the FINAL path, not the temp", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root);
  const tmp = path.join(root, ".save.tmp");
  const final = path.join(root, "doc.md");
  fs.writeFileSync(tmp, "content");
  fs.renameSync(tmp, final);
  expect(await waitFor(() => has(settled, "doc.md"))).toBe(true);
});

wtest("directory delete removes the whole subtree via `unlinkDir`", async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "f.txt"), "x");
  const { settled } = await watch(root);
  fs.rmSync(path.join(root, "sub"), { recursive: true, force: true });
  expect(await waitFor(() => has(settled, "sub", "unlinkDir"))).toBe(true);
});

// Coalescing / last-kind-wins is tested DETERMINISTICALLY against the shared batcher rather
// than via OS events: a create-then-delete blip is reported inconsistently across backends
// (inotify may sample after the file is already gone and emit nothing), so an OS-timing test
// is inherently flaky. The batcher is what actually implements the invariant, and it's the
// same code path both backends feed — so this is real coverage, just backend-independent.
test("batcher last-kind-wins: create-then-delete in one window coalesces to a single delete", async () => {
  const batches: WatchEvent[][] = [];
  const b = createBatcher((evs) => batches.push(evs), 20, 3000);
  b.push("ephemeral.txt", "add");
  b.push("ephemeral.txt", "unlinkDir"); // same path, same window → overwrites the add
  await new Promise((r) => setTimeout(r, 80)); // > debounce → one flush
  b.dispose();
  expect(batches).toHaveLength(1);
  expect(batches[0]).toEqual([{ relPath: "ephemeral.txt", kind: "unlinkDir" }]);
});

test("batcher coalesces a burst of many events across paths into one settled batch", async () => {
  const batches: WatchEvent[][] = [];
  const b = createBatcher((evs) => batches.push(evs), 20, 3000);
  b.push("a.ts", "add");
  b.push("b.ts", "add");
  b.push("a.ts", "change"); // last-kind-wins for a.ts
  await new Promise((r) => setTimeout(r, 80));
  b.dispose();
  expect(batches).toHaveLength(1);
  expect(new Map(batches[0]!.map((e) => [e.relPath, e.kind]))).toEqual(new Map([["a.ts", "change"], ["b.ts", "add"]]));
});

test("batcher maxWait cap flushes a sustained burst even without a quiet gap", async () => {
  const batches: WatchEvent[][] = [];
  const b = createBatcher((evs) => batches.push(evs), 1000, 60); // debounce >> maxWait
  b.push("x.ts", "add");
  await new Promise((r) => setTimeout(r, 20));
  b.push("y.ts", "add"); // still within maxWait; no flush yet
  await new Promise((r) => setTimeout(r, 90)); // now past maxWait (60ms) → forced flush on next push
  b.push("z.ts", "add");
  await new Promise((r) => setTimeout(r, 10));
  b.dispose();
  // The cap forced a flush that included the earlier events (not stuck behind the long debounce).
  expect(batches.length).toBeGreaterThanOrEqual(1);
  expect(batches.flat().some((e) => e.relPath === "x.ts")).toBe(true);
});

wtest("SCALE (design §41): monorepo-shaped tree — ready fast, memory flat, node_modules subtree pruned", async () => {
  const root = tmpRoot();
  // ~10k-file tree: a source tree + a LARGE node_modules that MUST be pruned by the
  // native ignore. Sized so that if the pre-fix per-path chokidar backend (or a broken
  // native prune) were in play, memory/watch-count would blow the 300 MB gate; with the
  // native single-stream backend + subtree prune it stays flat.
  for (let d = 0; d < 100; d++) {
    const dir = path.join(root, "src", `mod${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(dir, `f${f}.ts`), "export const x = 1;\n");
  }
  for (let d = 0; d < 450; d++) {
    const dir = path.join(root, "node_modules", `pkg${d}`, "dist");
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 20; f++) fs.writeFileSync(path.join(dir, `i${f}.js`), "module.exports={};\n");
  }

  const { settled, readyMs } = await watch(root);

  expect(readyMs).toBeLessThan(10_000); // chokidar took ~330 s on the real corpus
  expect(process.memoryUsage.rss()).toBeLessThan(300 * 1024 * 1024); // vs ~11 GB

  // A create DEEP under an existing node_modules must produce ZERO events — the native
  // `**/node_modules/**` subtree prune keeps children off the JS hot path (finding 3).
  fs.writeFileSync(path.join(root, "node_modules", "pkg0", "dist", "new-deep.js"), "x");
  fs.writeFileSync(path.join(root, "src", "mod0", "live.ts"), "x");

  expect(await waitFor(() => has(settled, "src/mod0/live.ts"))).toBe(true);
  await new Promise((r) => setTimeout(r, 500));
  expect(settled.some((e) => e.relPath.includes("node_modules"))).toBe(false);
}, 40_000); // builds ~10k files + waits — extra headroom on a loaded CI runner
