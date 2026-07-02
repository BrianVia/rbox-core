import { expect, test } from "bun:test";
import type { DaemonActivity } from "./activity.js";
import { healthLine, lastSyncLines, progressLabel, relTime, type StatusSnapshot } from "./status-view.js";

// Assertions match plain substrings so they hold with or without ANSI styling
// (style auto-disables off a TTY, which is how bun test runs).

const NOW = Date.parse("2026-07-02T12:00:00Z");
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

/** A clean, in-sync snapshot; tests override the dimension under test. */
const base = (over: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  added: 0,
  changed: 0,
  deleted: 0,
  trackedFiles: 8603,
  daemonRunning: true,
  localSequence: 78,
  remoteSequence: 78,
  activity: undefined,
  now: NOW,
  ...over,
});

// ── relTime ───────────────────────────────────────────────────────────────────

test("relTime buckets", () => {
  expect(relTime(iso(2), NOW)).toBe("just now");
  expect(relTime(iso(42), NOW)).toBe("42s ago");
  expect(relTime(iso(5 * 60 + 10), NOW)).toBe("5m ago");
  expect(relTime(iso(3 * 3600 + 30), NOW)).toBe("3h ago");
  expect(relTime(iso(2 * 86400), NOW)).toBe("2d ago");
  expect(relTime("not-a-date", NOW)).toBe("unknown");
});

// ── progressLabel ─────────────────────────────────────────────────────────────

test("progressLabel renders percent + counts per phase", () => {
  expect(progressLabel("upload", 3612, 8603)).toBe("uploading 41% (3,612/8,603)");
  expect(progressLabel("encrypt", 1, 4)).toBe("encrypting 25% (1/4)");
  expect(progressLabel("download", 4, 4)).toBe("downloading 100% (4/4)");
  expect(progressLabel("upload", 0, 0)).toBe("uploading 100% (0/0)"); // degenerate: no work = done
  expect(progressLabel("upload", 3, 2)).toBe("uploading 100% (3/2)"); // clamped, never 150%
  expect(progressLabel("upload", -1, 2)).toBe("uploading 0% (-1/2)"); // clamped, never negative
});

// ── healthLine priority order ────────────────────────────────────────────────

test("in sync — clean local diff, remote agrees", () => {
  const line = healthLine(base());
  expect(line).toContain("in sync");
  expect(line).toContain("8,603 files");
});

test("halt outranks everything when the daemon is running", () => {
  const activity: DaemonActivity = {
    at: iso(10),
    halt: { at: iso(300), reason: "pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).", count: 4, op: "pull" },
    active: { at: iso(1), phase: "upload", done: 1, total: 2 },
  };
  const line = healthLine(base({ activity, added: 5, remoteSequence: 99 }));
  expect(line).toContain("sync halted");
  expect(line).toContain("mass-delete guard");
  expect(line).toContain("5m ago");
  expect(line).toContain("×4");
});

test("a stopped daemon's leftover halt is dropped (stopped already says sync is off)", () => {
  const activity: DaemonActivity = { at: iso(10), halt: { at: iso(300), reason: "boom", count: 1, op: "pull" } };
  const line = healthLine(base({ activity, daemonRunning: false }));
  expect(line).not.toContain("halted");
  expect(line).toContain("in sync");
});

test("fresh live progress renders the syncing line", () => {
  const activity: DaemonActivity = { at: iso(1), active: { at: iso(2), phase: "upload", done: 3612, total: 8603 } };
  const line = healthLine(base({ activity }));
  expect(line).toContain("syncing");
  expect(line).toContain("uploading 41% (3,612/8,603)");
});

test("stale live progress is ignored (a crashed daemon must not show syncing forever)", () => {
  const activity: DaemonActivity = { at: iso(120), active: { at: iso(120), phase: "upload", done: 1, total: 2 } };
  expect(healthLine(base({ activity }))).toContain("in sync");
});

test("a stopped daemon never renders syncing, even with fresh active progress (codex R5)", () => {
  const activity: DaemonActivity = { at: iso(1), active: { at: iso(1), phase: "upload", done: 1, total: 2 } };
  const line = healthLine(base({ activity, daemonRunning: false }));
  expect(line).not.toContain("syncing");
  expect(line).toContain("in sync");
});

test("local divergence: counts by kind, hint only when the daemon is stopped", () => {
  const running = healthLine(base({ added: 3, changed: 9, deleted: 1 }));
  expect(running).toContain("13 local changes to sync");
  expect(running).toContain("3 new, 9 changed, 1 deleted");
  expect(running).not.toContain("rbox start");

  const stopped = healthLine(base({ added: 1, daemonRunning: false }));
  expect(stopped).toContain("1 local change to sync");
  expect(stopped).toContain("rbox start");
});

test("git divergence: clean file tree with unpushed git state is NOT in sync", () => {
  const gitOnly = healthLine(base({ gitChanged: 1 }));
  expect(gitOnly).toContain("git changes to sync");
  expect(gitOnly).toContain("git changes in 1 repo");

  const both = healthLine(base({ changed: 2, gitChanged: 3 }));
  expect(both).toContain("2 local changes to sync");
  expect(both).toContain("git changes in 3 repos");
});

test("local divergence + behind remote are reported together", () => {
  const line = healthLine(base({ changed: 2, remoteSequence: 80 }));
  expect(line).toContain("2 local changes");
  expect(line).toContain("behind remote (sequence 78 vs 80)");
});

test("behind remote only", () => {
  const running = healthLine(base({ remoteSequence: 80 }));
  expect(running).toContain("behind remote (sequence 78 vs 80)");
  expect(running).toContain("next pull");

  const stopped = healthLine(base({ remoteSequence: 80, daemonRunning: false }));
  expect(stopped).toContain("rbox pull");
});

test("unknown remote (offline probe) never renders behind-remote", () => {
  expect(healthLine(base({ remoteSequence: undefined }))).toContain("in sync");
});

// ── lastSyncLines ─────────────────────────────────────────────────────────────

test("lastSyncLines: push and pull have separate slots, most recent first", () => {
  // codex R2 regression: the commit after a 409-recovery pull must not mask the
  // local-tree mutations that pull applied — both render, newest on top.
  const activity: DaemonActivity = {
    at: iso(5),
    lastPush: { at: iso(118), files: 8603, sequence: 78 },
    lastPull: { at: iso(120), writes: 2, deletes: 1, conflicts: 0 },
  };
  expect(lastSyncLines(activity, NOW)).toEqual([
    "last push: 1m ago — 8,603 files → sequence 78",
    "last pull: 2m ago — 2 written, 1 deleted",
  ]);
});

test("lastSyncLines: single slot renders alone", () => {
  expect(lastSyncLines({ at: iso(5), lastPush: { at: iso(120), files: 3, sequence: 9 } }, NOW)).toEqual([
    "last push: 2m ago — 3 files → sequence 9",
  ]);
  expect(lastSyncLines({ at: iso(5), lastPull: { at: iso(30), writes: 2, deletes: 1, conflicts: 0 } }, NOW)).toEqual([
    "last pull: 30s ago — 2 written, 1 deleted",
  ]);
});

test("lastSyncLines: heartbeat only / no activity at all", () => {
  expect(lastSyncLines({ at: iso(30) }, NOW)).toEqual(["last checked: 30s ago"]);
  expect(lastSyncLines(undefined, NOW)).toEqual([]);
});
