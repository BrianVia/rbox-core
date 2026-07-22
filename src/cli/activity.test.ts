import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ACTIVE_STALE_MS, loadActivity, renderShellDeferrals, renderShellLine, saveActivity, saveShellDeferrals, saveShellLine, type DaemonActivity } from "./activity.js";
import { resetSyncState } from "./config.js";
import type { SyncState } from "./config.js";
import { ageBucket } from "./status-view.js";

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
    ws: {
      connected: true,
      at: "2026-07-02T12:00:01.000Z",
      caughtUp: true,
      lastBroadcastSequence: 79,
      bootId: "boot-1",
      pid: 1234,
    },
    lastPush: { at: "2026-07-02T11:58:00.000Z", files: 3, sequence: 78 },
    lastPull: { at: "2026-07-02T11:57:00.000Z", writes: 2, deletes: 1, conflicts: 0 },
    active: { at: "2026-07-02T12:00:00.000Z", phase: "upload", done: 1, total: 3, detail: "repo", bytesDone: 512, bytesTotal: 1024 },
    halt: {
      at: "2026-07-02T11:00:00.000Z", reason: "push conflict", count: 2, op: "push",
      firstFailureAt: "2026-07-02T11:00:00.000Z", lastFailureAt: "2026-07-02T11:01:00.000Z",
      consecutiveFailures: 2, nextProbeAt: "2026-07-02T11:02:00.000Z", lastProbeAt: "2026-07-02T11:00:30.000Z",
      recoveryState: "armed",
      typedReason: { kind: "push-conflict" },
    },
    suspendedPushHalt: {
      at: "2026-07-02T10:00:00.000Z", reason: "earlier push conflict", count: 1, op: "push",
      firstFailureAt: "2026-07-02T10:00:00.000Z", recoveryState: "suspended",
      typedReason: { kind: "push-conflict" },
    },
    outOfStorage: { at: "2026-07-02T11:30:00.000Z", kind: "storage", used: 2147483648, cap: 2147483648 },
    local: {
      at: "2026-07-02T12:00:02.000Z",
      stream: "https://api.test::ws::root",
      baseSequence: 78,
      trackedFiles: 8603,
      added: 1,
      changed: 2,
      deleted: 3,
      settled: true,
      sourceVersion: 1,
    },
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
      ws: { connected: true, at, caughtUp: true, lastBroadcastSequence: -1, bootId: "boot-1", pid: 1234 },
      lastPull: { at, writes: 1, deletes: 0, conflicts: 0 }, // valid — must survive
      active: { at, phase: "teleport", done: 1, total: 2 }, // bogus phase
      halt: { at, reason: 7, count: 1, op: "pull" }, // non-string reason
      outOfStorage: { at, kind: "storage", used: "full", cap: 1 }, // non-number used
      local: { at, stream: "s", baseSequence: 0, trackedFiles: 1, added: 0, changed: 0, deleted: 0, settled: true }, // missing sourceVersion
    })
  );
  expect(await loadActivity(root)).toEqual({ at, lastPull: { at, writes: 1, deletes: 0, conflicts: 0 } });
});

test("malformed typed halt classifications are dropped without classifying raw strings", async () => {
  const p = path.join(root, ".rbox", "state", "activity.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const at = "2026-07-02T12:00:00.000Z";
  await fs.writeFile(p, JSON.stringify({
    at,
    halt: { at, reason: "pull mass-delete guard too_many_refs", count: 1, op: "pull", typedReason: { kind: "mass-delete", op: "fullScan" } },
  }));
  expect(await loadActivity(root)).toEqual({ at, halt: { at, reason: "pull mass-delete guard too_many_refs", count: 1, op: "pull" } });
});

test("suspended push halt uses the halt validator and rejects non-push episodes", async () => {
  const p = path.join(root, ".rbox", "state", "activity.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const at = "2026-07-02T12:00:00.000Z";
  await fs.writeFile(p, JSON.stringify({
    at,
    suspendedPushHalt: { at, reason: "not a push", count: 1, op: "pull", typedReason: { kind: "push-conflict" } },
  }));
  expect(await loadActivity(root)).toEqual({ at });
});

test("malformed local slot is dropped alone", async () => {
  const p = path.join(root, ".rbox", "state", "activity.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const at = "2026-07-02T12:00:00.000Z";
  await fs.writeFile(
    p,
    JSON.stringify({
      at,
      ws: { connected: true, at, caughtUp: true, bootId: "boot-1", pid: 1234 },
      local: { at, stream: "s", baseSequence: 0, trackedFiles: 1, added: 0, changed: -1, deleted: 0, settled: true, sourceVersion: 1 },
    })
  );
  expect(await loadActivity(root)).toEqual({
    at,
    ws: { connected: true, at, caughtUp: true, bootId: "boot-1", pid: 1234 },
  });
});

test("loadActivity keeps active when optional byte fields are malformed", async () => {
  const p = path.join(root, ".rbox", "state", "activity.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const at = "2026-07-02T12:00:00.000Z";
  const base = { at, active: { at, phase: "upload", done: 1, total: 2 } };

  await fs.writeFile(p, JSON.stringify({ ...base, active: { ...base.active, bytesDone: 10, bytesTotal: 20 } }));
  expect(await loadActivity(root)).toEqual({ ...base, active: { ...base.active, bytesDone: 10, bytesTotal: 20 } });

  await fs.writeFile(p, JSON.stringify({ ...base, active: { ...base.active, bytesDone: -1, bytesTotal: 20 } }));
  expect(await loadActivity(root)).toEqual(base);

  await fs.writeFile(p, JSON.stringify({ ...base, active: { ...base.active, bytesDone: 30, bytesTotal: 20 } }));
  expect(await loadActivity(root)).toEqual(base);

  await fs.writeFile(p, JSON.stringify({ ...base, active: { ...base.active, bytesTotal: 20 } }));
  expect(await loadActivity(root)).toEqual(base);
});

test("invalid ws evidence is omitted without dropping valid activity slots", async () => {
  const p = path.join(root, ".rbox", "state", "activity.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const at = "2026-07-02T12:00:00.000Z";
  await fs.writeFile(
    p,
    JSON.stringify({
      at,
      ws: { connected: true, at, caughtUp: true, lastBroadcastSequence: 1.5, bootId: "boot-1", pid: 1234 },
      lastPush: { at, files: 3, sequence: 9 },
    })
  );
  expect(await loadActivity(root)).toEqual({ at, lastPush: { at, files: 3, sequence: 9 } });

  await fs.writeFile(p, JSON.stringify({ at, ws: { connected: true, at, caughtUp: true, bootId: "boot-1", pid: 0 } }));
  expect(await loadActivity(root)).toEqual({ at });
});

test("resetSyncState clears the sidecar too — a rebind must not inherit the old trail (codex R4)", async () => {
  await saveActivity(root, {
    at: "2026-07-02T12:00:00.000Z",
    halt: { at: "2026-07-02T12:00:00.000Z", reason: "old workspace's halt", count: 1, op: "pull" },
  });
  await saveShellLine(root, "v1 100 halt - - - - old-ws"); // design 46: the prompt sidecar joins the reset
  const shellLine = path.join(root, ".rbox", "state", "shell.line");
  expect(await fs.readFile(shellLine, "utf8")).toContain("halt"); // present before reset
  await resetSyncState(root, "activity-test-stream");
  expect(await loadActivity(root)).toBeUndefined();
  await expect(fs.access(shellLine)).rejects.toThrow(); // shell.line removed too
});

const deferralState = (records: SyncState["repoRecords"]): SyncState => ({
  stream: "test", lastSyncedSequence: 1, lastSyncedManifest: { generatedAt: "", files: [] }, repoRecords: records,
});

test("shell.deferrals is stable, encoded, precedence-collapsed, oldest-first, and bounded", () => {
  const now = Date.parse("2026-07-13T12:00:00Z");
  const state = deferralState({
    "nested repo": { repoGen: 1, sourceSeq: 1, deferrals: {
      apply: { lane: "apply", reason: "git-busy", deferredSince: "2026-07-13T11:30:00Z", reasonSince: "2026-07-13T11:30:00Z", lastSeen: "2026-07-13T11:30:00Z" },
      capture: { lane: "capture", reason: "local-edits", deferredSince: "2026-07-13T11:45:00Z", reasonSince: "2026-07-13T11:45:00Z", lastSeen: "2026-07-13T11:45:00Z", bytesChanged: true },
    } },
    "old\trepo": { repoGen: 1, sourceSeq: 1, deferrals: {
      config: { lane: "config", reason: "config", deferredSince: "2026-07-12T12:00:00Z", reasonSince: "2026-07-12T12:00:00Z", lastSeen: "2026-07-12T12:00:00Z" },
    } },
  });
  const rendered = renderShellDeferrals(state, now, ageBucket)!;
  expect(rendered.split("\n").slice(0, 3)).toEqual([
    "v1", "old%09repo\tconfig\t1d\t0", "nested%20repo\tlocal-edits\t30m\t1",
  ]);

  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`repo-${String(i).padStart(2, "0")}`, {
    repoGen: 1, sourceSeq: 1, deferrals: { apply: {
      lane: "apply" as const, reason: "other" as const, deferredSince: "2026-07-13T11:00:00Z",
      reasonSince: "2026-07-13T11:00:00Z", lastSeen: "2026-07-13T11:00:00Z",
      bytesChanged: true,
    } },
  }]));
  const bounded = renderShellDeferrals(deferralState(many), now, ageBucket)!;
  expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(8192);
  const boundedRows = bounded.trimEnd().split("\n").slice(1);
  expect(boundedRows).toHaveLength(50);
  expect(boundedRows.at(-1)).toBe(".\tother\t1h\t1");
  expect(boundedRows.some((row) => row.startsWith("repo-50\t"))).toBe(false);

  const longRows = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`repo-${i}-${"x".repeat(300)}`, {
    repoGen: 1, sourceSeq: 1, deferrals: { apply: {
      lane: "apply" as const, reason: "other" as const, deferredSince: "2026-07-13T11:00:00Z",
      reasonSince: "2026-07-13T11:00:00Z", lastSeen: "2026-07-13T11:00:00Z",
    } },
  }]));
  expect(Buffer.byteLength(renderShellDeferrals(deferralState(longRows), now, ageBucket)!)).toBeLessThanOrEqual(8192);
});

test("saveShellDeferrals deletes the sidecar when no deferrals remain", async () => {
  const file = path.join(root, ".rbox", "state", "shell.deferrals");
  const now = Date.parse("2026-07-13T12:00:00Z");
  await saveShellDeferrals(root, deferralState({ repo: { repoGen: 1, sourceSeq: 1, deferrals: {
    apply: { lane: "apply", reason: "local-edits", deferredSince: new Date(now).toISOString(), reasonSince: new Date(now).toISOString(), lastSeen: new Date(now).toISOString() },
  } } }), now, ageBucket);
  expect(await fs.readFile(file, "utf8")).toContain("repo\tlocal-edits\t0m\t0");
  await saveShellDeferrals(root, deferralState({}), now, ageBucket);
  await expect(fs.access(file)).rejects.toThrow();
});

// --- design 46: the pure prompt-sidecar renderer ---------------------------
const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z; floor(NOW/1000) = 1800000000
const at = (epoch: number) => new Date(epoch * 1000).toISOString();

test("renderShellLine state precedence: fresh active can show a retry over halt, quota still outranks active", async () => {
  const active: DaemonActivity["active"] = { at: at(1799999990), phase: "upload", done: 1, total: 4 };
  const staleActive: DaemonActivity["active"] = { at: new Date(NOW - ACTIVE_STALE_MS - 1000).toISOString(), phase: "upload", done: 1, total: 4 };
  const halt: DaemonActivity["halt"] = { at: at(1799999000), reason: "boom", count: 1, op: "pull" };
  const outOfStorage: DaemonActivity["outOfStorage"] = { at: at(1799999500), kind: "storage", used: 1, cap: 2 };
  const base = { settled: true, name: "ws", now: NOW };

  // A fresh retry should show the active glyph even while the older halt is still recorded.
  expect(renderShellLine({ at: "", active, halt }, base).split(" ")[2]).toBe("active");
  // Terminal halts are not retry progress: they stay blocked even with fresh active state.
  expect(renderShellLine({ at: "", active, halt: { ...halt, terminal: { fingerprint: "fp" } } }, base).split(" ")[2]).toBe("halt");
  // A stale active record must not mask a halt.
  expect(renderShellLine({ at: "", active: staleActive, halt }, base).split(" ")[2]).toBe("halt");
  // quota is soft but outranks live progress
  expect(renderShellLine({ at: "", active, outOfStorage }, base).split(" ")[2]).toBe("outofstorage");
  // active wins over settled (ok) and unsettled (pending)
  expect(renderShellLine({ at: "", active }, base).split(" ")[2]).toBe("active");
  expect(renderShellLine({ at: "", active }, { ...base, settled: false }).split(" ")[2]).toBe("active");
  // no active/halt: settled → ok, unsettled → pending
  expect(renderShellLine({ at: "" }, base).split(" ")[2]).toBe("ok");
  expect(renderShellLine({ at: "" }, { ...base, settled: false }).split(" ")[2]).toBe("pending");
});

test("renderShellLine never derives transfer pct from entry counts", () => {
  const render = (done: number, total: number) =>
    renderShellLine({ at: "", active: { at: at(1799999990), phase: "upload", done, total } }, { settled: false, name: "ws", now: NOW }).split(" ")[3];
  expect(render(1, 3)).toBe("-");
  expect(render(4, 4)).toBe("-");
  expect(render(9, 4)).toBe("-");
  expect(render(-1, 4)).toBe("-");
  // Indeterminate active (total<=0, e.g. a live scan): `-`, never a fake 100 — the
  // shell glyph would show `↻ 100%` for the whole walk. `-` is regex-legal in every
  // installed snippet (`([0-9]{1,3}|-)`), whose glyph renders `↻` alone for it.
  expect(render(500, 0)).toBe("-");
  expect(renderShellLine({ at: "" }, { settled: true, name: "ws", now: NOW }).split(" ")[3]).toBe("-");
});

test("renderShellLine pct prefers determinate bytes and keeps count fallback only for git capture", () => {
  const activeAt = at(1799999990);
  const pct = (active: DaemonActivity["active"]) =>
    renderShellLine({ at: "", active }, { settled: false, name: "ws", now: NOW }).split(" ")[3];

  expect(pct({ at: activeAt, phase: "upload", done: 1, total: 10, bytesDone: 512, bytesTotal: 1024 })).toBe("50");
  expect(pct({ at: activeAt, phase: "gitcap", done: 2, total: 140, bytesDone: 1024 })).toBe("1");
  expect(pct({ at: activeAt, phase: "scan", done: 500, total: 0, bytesDone: 1024 })).toBe("-");
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
