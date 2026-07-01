import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, type WatchEvent } from "../engine/index.js";
import { startWatcher, type Watcher } from "./watcher.js";

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
const wtest = test.skipIf(skipNative);

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

wtest("create-then-delete within one debounce window coalesces to the delete (last-kind-wins)", async () => {
  const root = tmpRoot();
  const { settled } = await watch(root);
  const f = path.join(root, "ephemeral.txt");
  fs.writeFileSync(f, "x");
  fs.rmSync(f, { force: true });
  expect(await waitFor(() => settled.some((e) => e.relPath === "ephemeral.txt"))).toBe(true);
  const last = [...settled].reverse().find((e) => e.relPath === "ephemeral.txt");
  expect(last?.kind).toBe("unlinkDir");
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
});
