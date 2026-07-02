import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadActivity, renderShellLine, saveActivity, saveShellLine, type DaemonActivity } from "./activity.js";
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
  await saveShellLine(root, "v1 100 halt - - - - old-ws"); // design 46: the prompt sidecar joins the reset
  const shellLine = path.join(root, ".rbox", "state", "shell.line");
  expect(await fs.readFile(shellLine, "utf8")).toContain("halt"); // present before reset
  await resetSyncState(root);
  expect(await loadActivity(root)).toBeUndefined();
  await expect(fs.access(shellLine)).rejects.toThrow(); // shell.line removed too
});

// --- design 46: the pure prompt-sidecar renderer ---------------------------
const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z; floor(NOW/1000) = 1800000000
const at = (epoch: number) => new Date(epoch * 1000).toISOString();

test("renderShellLine state precedence: halt > active > pending > ok", async () => {
  const active: DaemonActivity["active"] = { at: at(1799999900), phase: "upload", done: 1, total: 4 };
  const halt: DaemonActivity["halt"] = { at: at(1799999000), reason: "boom", count: 1, op: "pull" };
  const base = { settled: true, name: "ws", now: NOW };

  // halt wins even when active AND settled would otherwise apply
  expect(renderShellLine({ at: "", active, halt }, base).split(" ")[2]).toBe("halt");
  // active wins over settled (ok) and unsettled (pending)
  expect(renderShellLine({ at: "", active }, base).split(" ")[2]).toBe("active");
  expect(renderShellLine({ at: "", active }, { ...base, settled: false }).split(" ")[2]).toBe("active");
  // no active/halt: settled → ok, unsettled → pending
  expect(renderShellLine({ at: "" }, base).split(" ")[2]).toBe("ok");
  expect(renderShellLine({ at: "" }, { ...base, settled: false }).split(" ")[2]).toBe("pending");
});

test("renderShellLine pct: floors, clamps 0–100, total<=0 → 100; `-` when not active", () => {
  const render = (done: number, total: number) =>
    renderShellLine({ at: "", active: { at: at(1799999900), phase: "upload", done, total } }, { settled: false, name: "ws", now: NOW }).split(" ")[3];
  expect(render(1, 3)).toBe("33"); // 33.3 → floored
  expect(render(4, 4)).toBe("100");
  expect(render(9, 4)).toBe("100"); // over-100 clamped
  expect(render(-1, 4)).toBe("0"); // under-0 clamped
  expect(render(1, 0)).toBe("100"); // total<=0 → 100 (avoid /0)
  expect(renderShellLine({ at: "" }, { settled: true, name: "ws", now: NOW }).split(" ")[3]).toBe("-");
});

test("renderShellLine placeholders: no sequence and no ops render `-` and `- -`", () => {
  const parts = renderShellLine({ at: "" }, { settled: true, name: "ws", now: NOW }).split(" ");
  expect(parts.slice(0, 8)).toEqual(["v1", "1800000000", "ok", "-", "-", "-", "-", "ws"]);
});

test("renderShellLine: sequence 0 (never synced) renders `-`, not `(seq 0)` fodder (codex R1)", () => {
  const parts = renderShellLine({ at: "" }, { settled: true, sequence: 0, name: "ws", now: NOW }).split(" ");
  expect(parts[4]).toBe("-");
  expect(renderShellLine({ at: "" }, { settled: true, sequence: 80, name: "ws", now: NOW }).split(" ")[4]).toBe("80");
});

test("renderShellLine lastOp picks the NEWER of push/pull", () => {
  const lastPush = { at: at(1799990000), files: 3, sequence: 80 };
  const lastPull = { at: at(1799995000), writes: 1, deletes: 0, conflicts: 0 };
  // pull newer → pull
  let p = renderShellLine({ at: "", lastPush, lastPull }, { settled: true, name: "ws", now: NOW }).split(" ");
  expect([p[5], p[6]]).toEqual(["1799995000", "pull"]);
  // push newer → push
  const pushNewer = { at: at(1799999000), files: 3, sequence: 80 };
  p = renderShellLine({ at: "", lastPush: pushNewer, lastPull }, { settled: true, name: "ws", now: NOW }).split(" ");
  expect([p[5], p[6]]).toEqual(["1799999000", "push"]);
  // only push present
  p = renderShellLine({ at: "", lastPush }, { settled: true, name: "ws", now: NOW }).split(" ");
  expect([p[5], p[6]]).toEqual(["1799990000", "push"]);
});

test("renderShellLine name is LAST and verbatim (spaces kept), control chars neutralized to `?`", () => {
  // Sequence 80, ok state, spacey name with an embedded newline + tab.
  const line = renderShellLine(
    { at: "" },
    { settled: true, sequence: 80, name: "My Cool Repo\nrm -rf\t/", now: NOW }
  );
  expect(line).toBe("v1 1800000000 ok - 80 - - My Cool Repo?rm -rf?/");
  expect(line).not.toContain("\n"); // stays exactly one line
  // Everything before the name is a fixed 7-field header; the rest is the name verbatim.
  expect(line.split(" ").slice(7).join(" ")).toBe("My Cool Repo?rm -rf?/");
});

test("save is best-effort: an unwritable destination is swallowed", async () => {
  // Make `.rbox` a FILE so mkdir(.rbox/state) inside saveActivity must fail.
  await fs.writeFile(path.join(root, ".rbox"), "");
  await saveActivity(root, { at: "2026-07-02T12:00:00.000Z" }); // must not throw
  expect(await loadActivity(root)).toBeUndefined();
});
