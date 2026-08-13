import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  currentWorkspaceId,
  parseDaemonBinding,
  parseDaemonPid,
  readDaemonBinding,
  readDaemonBindingRecord,
  recordDaemonBinding,
} from "../daemon-control.js";
import { summarizeActions } from "../daemon.js";
import type { Action } from "../../engine/reconcile.js";
import type { FileEntry } from "../../engine/types.js";

// The stale-daemon incident (v0.5.6): a repeat `rbox setup` re-bound the root to a
// NEW workspace, but the already-running daemon kept its startup binding and 404'd
// on every op forever — while `rbox start` reported "already running". These cover
// the detection primitives startDaemon now uses to tell live from stale.

let home: string;
let root: string;
let savedRboxHome: string | undefined;
beforeAll(async () => {
  savedRboxHome = process.env.RBOX_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-bind-home-"));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-bind-root-"));
  process.env.RBOX_HOME = home; // daemon runtime dirs land under the temp home
});
afterAll(async () => {
  if (savedRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = savedRboxHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

test("recordDaemonBinding → readDaemonBinding round-trips; a re-record overwrites", async () => {
  expect(readDaemonBinding(root)).toBeUndefined(); // never started → can't tell
  await recordDaemonBinding(root, "ws_old", "boot-old");
  expect(readDaemonBinding(root)).toBe("ws_old");
  expect(readDaemonBindingRecord(root)).toMatchObject({ workspaceId: "ws_old", bootId: "boot-old", version: "v2" });
  await recordDaemonBinding(root, "ws_new", "boot-new"); // daemon restarted after a re-init
  expect(readDaemonBinding(root)).toBe("ws_new");
});

test("dual-format daemon pidfile and binding parsers", () => {
  expect(parseDaemonPid("123\n")).toEqual({ version: "legacy", pid: 123 });
  expect(parseDaemonPid("v2 123 boot-abc\n")).toEqual({ version: "v2", pid: 123, bootId: "boot-abc" });
  expect(parseDaemonPid("v2 nope boot-abc\n")).toEqual({ version: "invalid" });

  expect(parseDaemonBinding("ws_legacy\n")).toEqual({ version: "legacy", workspaceId: "ws_legacy" });
  expect(parseDaemonBinding("v2 ws_current boot-abc\n")).toEqual({ version: "v2", workspaceId: "ws_current", bootId: "boot-abc" });
  expect(parseDaemonBinding("v2 ws_current\n")).toEqual({ version: "invalid" });
});

test("currentWorkspaceId reads the root's live binding; missing/invalid → undefined (can't tell ≠ stale)", async () => {
  expect(currentWorkspaceId(root)).toBeUndefined(); // no .rbox at all
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), "{not json");
  expect(currentWorkspaceId(root)).toBeUndefined(); // corrupt → undefined, never a throw
  await fs.writeFile(
    path.join(root, ".rbox", "workspace.json"),
    JSON.stringify({ schema: "e2ee/v1", remoteWorkspaceId: "ws_current", projectId: "root" })
  );
  expect(currentWorkspaceId(root)).toBe("ws_current");
});

test("the stale-daemon signal: recorded binding differs from the root's current workspace", async () => {
  // Self-contained setup: the root was re-initialized to ws_current AFTER a daemon
  // bound ws_old — the exact v0.5.6 incident shape.
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".rbox", "workspace.json"),
    JSON.stringify({ schema: "e2ee/v1", remoteWorkspaceId: "ws_current", projectId: "root" })
  );
  await recordDaemonBinding(root, "ws_old", "boot-old");
  const bound = readDaemonBinding(root);
  const current = currentWorkspaceId(root);
  expect(bound).toBe("ws_old");
  expect(current).toBe("ws_current");
  expect(bound !== current).toBe(true); // ← startDaemon restarts on exactly this
});

// ── summarizeActions: the pull forensic line ──────────────────────────────────

const entry = (p: string): FileEntry => ({ path: p, size: 1, mode: 0o644, mtimeMs: 0, sha256: "x" }) as FileEntry;

test("summarizeActions counts by kind and prefixes each path (+ write, - delete, ! conflict)", () => {
  const actions: Action[] = [
    { kind: "write", entry: entry("a.ts") },
    { kind: "delete", path: "b.ts" },
    { kind: "conflict", path: "c.ts", keepLocalAs: "c.conflict.ts", entry: entry("c.ts") },
  ] as Action[];
  const s = summarizeActions(actions);
  expect(s).toContain("1 write, 1 delete, 1 conflict");
  expect(s).toContain("+a.ts");
  expect(s).toContain("-b.ts");
  expect(s).toContain("!c.ts");
});

test("summarizeActions elides beyond the cap but keeps exact counts", () => {
  const actions: Action[] = Array.from({ length: 60 }, (_, i) => ({ kind: "delete", path: `f${i}` })) as Action[];
  const s = summarizeActions(actions);
  expect(s).toContain("0 write, 60 delete, 0 conflict");
  expect(s).toContain("(+10 more)"); // 60 - LOG_PATHS_MAX(50)
});
