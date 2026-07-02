import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadActivity, saveActivity, type DaemonActivity } from "./activity.js";
import { resetSyncState } from "./config.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-activity-test-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("round-trips the full record", async () => {
  const a: DaemonActivity = {
    at: "2026-07-02T12:00:00.000Z",
    lastPush: { at: "2026-07-02T11:58:00.000Z", files: 3, sequence: 78 },
    lastPull: { at: "2026-07-02T11:57:00.000Z", writes: 2, deletes: 1, conflicts: 0 },
    active: { at: "2026-07-02T12:00:00.000Z", phase: "upload", done: 1, total: 3 },
    halt: { at: "2026-07-02T11:00:00.000Z", reason: "mass-delete guard", count: 2, op: "pull" },
  };
  await saveActivity(root, a);
  expect(await loadActivity(root)).toEqual(a);
});

test("absent file → undefined (daemon never ran here)", async () => {
  expect(await loadActivity(root)).toBeUndefined();
});

test("corrupt or shape-invalid file → undefined, never a throw", async () => {
  const p = path.join(root, ".rbox", "state", "activity.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, "{not json");
  expect(await loadActivity(root)).toBeUndefined();
  await fs.writeFile(p, JSON.stringify({ nope: true })); // parses, but no `at` stamp
  expect(await loadActivity(root)).toBeUndefined();
});

test("malformed nested slots are dropped individually, never handed to render (codex R3)", async () => {
  const p = path.join(root, ".rbox", "state", "activity.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const at = "2026-07-02T12:00:00.000Z";
  await fs.writeFile(
    p,
    JSON.stringify({
      at,
      lastPush: {}, // the R3 repro: rendered as `undefined.toLocaleString` crash
      lastPull: { at, writes: 1, deletes: 0, conflicts: 0 }, // valid — must survive
      active: { at, phase: "teleport", done: 1, total: 2 }, // bogus phase
      halt: { at, reason: 7, count: 1, op: "pull" }, // non-string reason
    })
  );
  expect(await loadActivity(root)).toEqual({ at, lastPull: { at, writes: 1, deletes: 0, conflicts: 0 } });
});

test("resetSyncState clears the sidecar too — a rebind must not inherit the old trail (codex R4)", async () => {
  await saveActivity(root, {
    at: "2026-07-02T12:00:00.000Z",
    halt: { at: "2026-07-02T12:00:00.000Z", reason: "old workspace's halt", count: 1, op: "pull" },
  });
  await resetSyncState(root);
  expect(await loadActivity(root)).toBeUndefined();
});

test("save is best-effort: an unwritable destination is swallowed", async () => {
  // Make `.rbox` a FILE so mkdir(.rbox/state) inside saveActivity must fail.
  await fs.writeFile(path.join(root, ".rbox"), "");
  await saveActivity(root, { at: "2026-07-02T12:00:00.000Z" }); // must not throw
  expect(await loadActivity(root)).toBeUndefined();
});
