import { expect, test } from "bun:test";
import type { DaemonActivity } from "./activity.js";
import {
  attributeDaemonForStatus,
  healthDetailLines,
  healthLine,
  lastSyncLines,
  progressLabel,
  relTime,
  type StatusSnapshot,
} from "./status-view.js";

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
  remote: { sequence: 78, source: "probe" },
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

test("progressLabel renders byte channel as a second fraction without a unified percent", () => {
  const GiB = 1024 ** 3;
  expect(progressLabel("upload", 126352, 126369, undefined, { bytesDone: Math.round(4.1 * GiB), bytesTotal: Math.round(6.3 * GiB) })).toBe(
    "uploading 126,352/126,369 · 4.1/6.3 GiB"
  );
  expect(progressLabel("gitcap", 2, 140, undefined, { bytesDone: Math.round(4.1 * GiB) })).toBe(
    "capturing git state 2/140 · 4.1 GiB sent"
  );
  expect(progressLabel("gitcap", 2, 140, "repo", { bytesDone: 512 })).toBe("capturing git state 2/140 · 512 B sent — repo");
});

test("progressLabel scan is indeterminate — formatted count, no percent", () => {
  expect(progressLabel("scan", 12304, 0)).toBe("scanning… 12,304 files");
  expect(progressLabel("scan", 500, 0)).toBe("scanning… 500 files");
});

test("progressLabel gitcap renders N/total with the repo name", () => {
  expect(progressLabel("gitcap", 3, 140, "zen-browser-desktop")).toBe("capturing git state 3/140 — zen-browser-desktop");
  // No detail (e.g. the status line, which never persists a name) → count only.
  expect(progressLabel("gitcap", 3, 140)).toBe("capturing git state 3/140");
});

test("progressLabel gitcap truncates an over-long detail keeping the tail", () => {
  const longName = "deeply/nested/monorepo/packages/some-really-long-repo-name";
  const out = progressLabel("gitcap", 1, 2, longName);
  expect(out.startsWith("capturing git state 1/2 — ")).toBe(true);
  const rendered = out.split(" — ")[1]!;
  expect(rendered.length).toBeLessThanOrEqual(40);
  expect(rendered.startsWith("…")).toBe(true);
  expect(rendered.endsWith("some-really-long-repo-name")).toBe(true); // tail (the repo) survives
});

test("progressLabel gitcap detail truncation is code-point safe with emoji (never a lone surrogate)", () => {
  // 45 ASCII chars force truncation; the astral-plane emoji live in the kept tail.
  const name = `${"x".repeat(45)}-🦊🎉-repo`;
  const rendered = progressLabel("gitcap", 1, 2, name).split(" — ")[1]!;
  expect(Array.from(rendered).length).toBeLessThanOrEqual(40); // budget counted in code points
  expect(rendered.endsWith("-🦊🎉-repo")).toBe(true); // tail intact, emoji unsplit
  expect(rendered.isWellFormed()).toBe(true); // no lone surrogate (a UTF-16 slice could make one)
});

test("progressLabel gitcap detail strips ANSI escapes and control chars", () => {
  // A repo dir name is untrusted terminal-bound input: CSI color codes, BEL, tabs —
  // all must vanish rather than reach the spinner/status line.
  const evil = "evil\u001b[31mred\u001b[0m\u0007\tname";
  expect(progressLabel("gitcap", 1, 2, evil)).toBe("capturing git state 1/2 — evilredname");
});

test("progressLabel unknown phase falls back to a sane verb, not garbage", () => {
  // Simulates an older/other writer landing a phase this build's union doesn't name:
  // it must not masquerade as "downloading".
  expect(progressLabel("bogus" as unknown as Parameters<typeof progressLabel>[0], 1, 4)).toBe("syncing 25% (1/4)");
});

// ── healthLine priority order ────────────────────────────────────────────────

test("in sync — clean local diff, remote agrees", () => {
  const line = healthLine(base());
  expect(line).toContain("in sync");
  expect(line).toContain("8,603 files");
});

test("fresh active progress outranks a standing halt and renders the halt as retry context", () => {
  const activity: DaemonActivity = {
    at: iso(10),
    halt: { at: iso(120), reason: "ENOENT: no such file or directory", count: 1, op: "push" },
    active: { at: iso(1), phase: "encrypt", done: 105551, total: 121885 },
  };
  const snapshot = base({ activity, added: 5, remote: { sequence: 99, source: "probe" } });
  const line = healthLine(snapshot);
  expect(line).toBe("↻ syncing — encrypting 86% (105,551/121,885)");
  expect(healthDetailLines(snapshot)).toEqual([
    "⚠ last attempt failed (2m ago) ENOENT: no such file or directory — will be retried",
  ]);
});

test("fresh populate marker suppresses local-change verdict", () => {
  const line = healthLine(base({
    daemonRunning: false,
    added: 120_058,
    populate: { phase: "download", filesDone: 119_812, filesTotal: 119_813 },
  }));
  expect(line).toContain("initial sync in progress");
  expect(line).toContain("119,812/119,813 files");
  expect(line).not.toContain("local changes");
});

test("terminal halt renders blocked red, outranks fresh active, and omits retry copy", () => {
  const activity: DaemonActivity = {
    at: iso(10),
    halt: {
      at: iso(120),
      reason: "workspace needs 250,001 blob refs per commit; the server cap is 250,000.",
      count: 1,
      op: "push",
      terminal: { fingerprint: "sidecar-sha" },
    },
    active: { at: iso(1), phase: "upload", done: 1, total: 2 },
  };
  const snapshot = base({ activity, added: 5, remote: { sequence: 99, source: "probe" } });
  const line = healthLine(snapshot);
  expect(line).toContain("sync blocked");
  expect(line).toContain("2m ago");
  expect(line).toContain("250,001 blob refs");
  expect(line).not.toContain("will be retried");
  expect(line).not.toContain("syncing");
  expect(healthDetailLines(snapshot)).toEqual([]);
});

test("stale active progress with a halt keeps the halt as the verdict", () => {
  const activity: DaemonActivity = {
    at: iso(10),
    halt: { at: iso(300), reason: "pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).", count: 4, op: "pull" },
    active: { at: iso(120), phase: "upload", done: 1, total: 2 },
  };
  const snapshot = base({ activity, added: 5, remote: { sequence: 99, source: "probe" } });
  const line = healthLine(snapshot);
  expect(line).toContain("sync failing");
  expect(line).toContain("mass-delete guard");
  expect(line).toContain("will be retried");
  expect(line).toContain("5m ago");
  expect(line).toContain("×4");
  expect(healthDetailLines(snapshot)).toEqual([]);
});

test("halt alone keeps the existing halt verdict", () => {
  const activity: DaemonActivity = {
    at: iso(10),
    halt: { at: iso(300), reason: "pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).", count: 4, op: "pull" },
  };
  const line = healthLine(base({ activity, added: 5, remote: { sequence: 99, source: "probe" } }));
  expect(line).toContain("sync failing");
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

test("out-of-storage outranks fresh live progress but stays below halt", () => {
  const activity: DaemonActivity = {
    at: iso(10),
    outOfStorage: { at: iso(5), kind: "storage", used: 2 * 1024 * 1024 * 1024, cap: 2 * 1024 * 1024 * 1024 },
    active: { at: iso(1), phase: "upload", done: 1, total: 2 },
  };
  const line = healthLine(base({ activity }));
  expect(line).toBe("⛔ out of storage — 2.0 GiB of 2.0 GiB used · run `rbox usage`, then `rbox subscribe solo`");
  expect(healthDetailLines(base({ activity }))).toEqual([]);

  const halted = healthLine(base({ activity: { ...activity, halt: { at: iso(1), reason: "boom", count: 1, op: "push" } } }));
  expect(halted).toContain("sync failing");
  expect(halted).not.toContain("out of storage");
});

test("fresh live progress renders the syncing line", () => {
  const activity: DaemonActivity = { at: iso(1), active: { at: iso(2), phase: "upload", done: 3612, total: 8603 } };
  const line = healthLine(base({ activity }));
  expect(line).toContain("syncing");
  expect(line).toContain("uploading 41% (3,612/8,603)");
});

test("fresh live progress renders byte suffix from activity", () => {
  const activity: DaemonActivity = { at: iso(1), active: { at: iso(2), phase: "upload", done: 12, total: 100, bytesDone: 512, bytesTotal: 1024 } };
  const line = healthLine(base({ activity }));
  expect(line).toBe("↻ syncing — uploading 12/100 · 0.5/1.0 KiB");
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
  const line = healthLine(base({ changed: 2, remote: { sequence: 80, source: "probe" } }));
  expect(line).toContain("2 local changes");
  expect(line).toContain("behind remote (sequence 78 vs 80)");
});

test("behind remote only", () => {
  const running = healthLine(base({ remote: { sequence: 80, source: "probe" } }));
  expect(running).toContain("behind remote (sequence 78 vs 80)");
  expect(running).toContain("next pull");

  const stopped = healthLine(base({ remote: { sequence: 80, source: "probe" }, daemonRunning: false }));
  expect(stopped).toContain("rbox pull");
});

test("unknown remote (offline probe) never renders behind-remote", () => {
  expect(healthLine(base({ remote: undefined }))).toContain("in sync");
});

test("daemon-sourced behind-remote verdict says the daemon has not applied the broadcast yet", () => {
  const line = healthLine(base({ remote: { sequence: 80, source: "daemon", ageMs: 8000 } }));
  expect(line).toContain("behind remote (sequence 78 vs 80)");
  expect(line).toContain("daemon has not applied seq 80 yet");
});

// ── daemon attribution / probe elision ───────────────────────────────────────

const wsActivity = (over: Partial<NonNullable<DaemonActivity["ws"]>> = {}, activityOver: Partial<DaemonActivity> = {}): DaemonActivity => ({
  at: iso(120),
  ...activityOver,
  ws: {
    connected: true,
    at: iso(8),
    caughtUp: true,
    lastBroadcastSequence: 80,
    bootId: "boot-live",
    pid: 1234,
    ...over,
  },
});

const attrBase = (over: Partial<Parameters<typeof attributeDaemonForStatus>[0]> = {}) =>
  attributeDaemonForStatus({
    activity: wsActivity(),
    daemonRunning: true,
    boundWorkspaceId: "ws_current",
    currentWorkspaceId: "ws_current",
    livePidfileBootId: "boot-live",
    localSequence: 78,
    now: NOW,
    ...over,
  });

test("attribution elides with current binding, matching live pidfile bootId, connected, caught-up, fresh ws, and no halt", () => {
  expect(attrBase()).toEqual({
    activity: wsActivity(),
    elided: true,
    remote: { sequence: 80, source: "daemon", ageMs: 8000 },
    remoteLine: "remote: seq 80 · live via daemon (8s ago)",
  });
});

test("elided remote sequence is at least the local synced sequence", () => {
  expect(attrBase({ activity: wsActivity({ lastBroadcastSequence: 70 }) }).remote?.sequence).toBe(78);
  expect(attrBase({ activity: wsActivity({ lastBroadcastSequence: undefined }) }).remote?.sequence).toBe(78);
});

test("daemon remote evidence is used only when every trust condition passes", () => {
  const cases: Array<[string, Partial<Parameters<typeof attributeDaemonForStatus>[0]>]> = [
    ["daemon stopped", { daemonRunning: false }],
    ["binding missing", { boundWorkspaceId: undefined }],
    ["binding stale", { boundWorkspaceId: "ws_old" }],
    ["pidfile legacy/missing boot", { livePidfileBootId: undefined }],
    ["disconnected", { activity: wsActivity({ connected: false }) }],
    ["not caught up", { activity: wsActivity({ caughtUp: false }) }],
    ["halted", { activity: wsActivity({}, { halt: { at: iso(1), reason: "boom", count: 1, op: "pull" } }) }],
  ];
  for (const [name, over] of cases) {
    const r = attrBase(over);
    expect(`${name}:${r.elided}`).toBe(`${name}:false`);
    expect(r.remote).toBeUndefined();
  }
  expect(attrBase({ livePidfileBootId: undefined }).activity).toBeDefined();
});

test("daemon remote evidence expires after the freshness window", () => {
  expect(attrBase({ activity: wsActivity({ at: iso(29) }) }).elided).toBe(true);
  expect(attrBase({ activity: wsActivity({ at: iso(31) }) }).elided).toBe(false);
});

test("conflicting ws boot suppresses inherited activity", () => {
  const activity = wsActivity(
    { bootId: "boot-loser" },
    {
      lastPush: { at: iso(5), files: 1, sequence: 80 },
      halt: { at: iso(5), reason: "old halt", count: 2, op: "pull" },
    }
  );
  expect(attrBase({ activity })).toEqual({ activity: undefined, elided: false });
});

test("binding bootId does not affect attribution when pidfile and activity match", () => {
  const activity = wsActivity({ bootId: "boot-live" });
  const r = attrBase({ activity, boundWorkspaceId: "ws_current", livePidfileBootId: "boot-live" });
  expect(r.activity).toBe(activity);
  expect(r.elided).toBe(true);
});

// ── lastSyncLines ─────────────────────────────────────────────────────────────

test("lastSyncLines: push and pull have separate slots, most recent first", () => {
  // Regression guard: the commit after a 409-recovery pull must not mask the
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
