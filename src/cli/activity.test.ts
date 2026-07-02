import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadActivity, saveActivity, type DaemonActivity } from "./activity.js";

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
    last: { at: "2026-07-02T11:58:00.000Z", op: "push", files: 3, sequence: 78 },
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

test("save is best-effort: an unwritable destination is swallowed", async () => {
  // Make `.rbox` a FILE so mkdir(.rbox/state) inside saveActivity must fail.
  await fs.writeFile(path.join(root, ".rbox"), "");
  await saveActivity(root, { at: "2026-07-02T12:00:00.000Z" }); // must not throw
  expect(await loadActivity(root)).toBeUndefined();
});
