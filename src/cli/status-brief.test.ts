import { expect, test } from "bun:test";
import {
  aggregatePlanQuotaAttention,
  attributeDaemonForStatus,
  briefAge,
  briefBehindRemote,
  briefIdentityLine,
  briefWorkspaceLabel,
  freshBriefActive,
  headlineBlocked,
  renderBriefStatus,
  translateBriefProgressLabel,
  type BriefAccountSummary,
  type BriefStatusSnapshot,
} from "./status-view.js";

const NOW = Date.parse("2026-07-17T12:00:00Z");
const ago = (milliseconds: number) => new Date(NOW - milliseconds).toISOString();
const account = (plan: string | null = "pro", email: string | null = "owner@example.com"): BriefAccountSummary => ({
  state: "ok",
  identity: { plan, email },
});
type Full = Extract<BriefStatusSnapshot, { kind: "full" }>;

const full = (over: Partial<Full> = {}): Full => ({
  kind: "full",
  workspaceLabel: "Development",
  daemonRunning: true,
  daemonStale: false,
  account: account(),
  pendingChanges: 0,
  behindRemote: false,
  planQuota: { kind: "none" },
  daemonVersionSkew: false,
  locking: { status: "ok" },
  now: NOW,
  ...over,
});

const lines = (snapshot: BriefStatusSnapshot): string[] => renderBriefStatus(snapshot).lines;

test("healthy, upload-evidence, paused, and initial-populate headline goldens", () => {
  expect(lines(full())).toEqual(["Development · syncing normally", "Signed in as owner@example.com · pro"]);
  expect(lines(full({ pendingChanges: 1 }))[0]).toBe("Development · syncing normally — 1 change waiting to upload");
  expect(lines(full({ pendingChanges: 2, active: { phase: "upload", done: 1, total: 2 } }))[0])
    .toBe("Development · syncing normally — 2 changes uploading now");
  expect(lines(full({ pendingChanges: 2, active: { phase: "encrypt", done: 1, total: 2 } }))[0])
    .toBe("Development · syncing now — encrypting 1/2");
  expect(lines(full({ populate: { filesDone: 12, filesTotal: 20 } }))[0])
    .toBe("Development · initial sync in progress — 12/20 files");
  expect(lines(full({ populate: { filesDone: 0, filesTotal: 0 } }))[0])
    .toBe("Development · initial sync in progress — starting");
  expect(lines(full({ daemonRunning: false }))).toEqual([
    "Development · sync is paused",
    "⚠ background sync is stopped · rbox start",
    "Signed in as owner@example.com · pro",
  ]);
  expect(lines(full({ daemonRunning: false, daemonStale: true }))).toEqual([
    "Development · sync is paused",
    "⚠ background sync is attached to a previous workspace · rbox start",
    "Signed in as owner@example.com · pro",
  ]);
});

test("founder target shape is headline, one attention item, then identity", () => {
  expect(lines(full({
    pendingChanges: 1,
    active: { phase: "upload", done: 1, total: 2 },
    git: { count: 3, oldestDeferredSince: ago(86400_000), allLocalEditDeferrals: true },
  }))).toEqual([
    "Development · syncing normally — 1 change uploading now",
    "⚠ 3 git repos waiting on uncommitted changes (oldest: 1 day) · rbox status --git",
    "Signed in as owner@example.com · pro",
  ]);
});

test("plain progress prefix translation retains suffixes and passes unknown labels through", () => {
  expect(translateBriefProgressLabel("scanning… 12,304 files")).toBe("checking files… 12,304 files");
  expect(translateBriefProgressLabel("capturing git state 3/140 — repo")).toBe("saving git history 3/140 — repo");
  expect(translateBriefProgressLabel("encrypting 1/2")).toBe("encrypting 1/2");
  expect(translateBriefProgressLabel("uploading 1/2 · 3.0/4.0 GiB")).toBe("uploading 1/2 · 3.0/4.0 GiB");
  expect(translateBriefProgressLabel("downloading 50% (1/2)")).toBe("downloading 50% (1/2)");
  expect(translateBriefProgressLabel("future operation 7/9 — safe detail")).toBe("future operation 7/9 — safe detail");
  expect(lines(full({ active: { phase: "gitcap", done: 3, total: 140, detail: "repo\u001b[31m\n" } }))[0])
    .toBe("Development · syncing now — saving git history 3/140 — repo");
});

test("identity arms normalize plans and never expose account ids", () => {
  expect(briefIdentityLine(account("none"))).toBe("Signed in as owner@example.com · no active plan");
  expect(briefIdentityLine(account("solo", null))).toBe("Signed in · solo");
  expect(briefIdentityLine(account("solo", "\u001b[31m\n"))).toBe("Signed in · solo");
  expect(briefIdentityLine(account("team"))).toBe("Signed in as owner@example.com · team");
  expect(briefIdentityLine(account(null))).toBe("Signed in as owner@example.com · plan unavailable");
  expect(briefIdentityLine(account("future"))).toBe("Signed in as owner@example.com · plan unavailable");
  expect(briefIdentityLine({ state: "signed-out" })).toBe("Signed out · rbox login");
  expect(briefIdentityLine({ state: "unavailable" })).toBe("Signed in · account details unavailable");
  for (const summary of [account(null, null), { state: "signed-out" } as const, { state: "unavailable" } as const]) {
    expect(briefIdentityLine(summary)).not.toContain("acct_");
  }
});

test("all halt discriminants use plain known copy and opaque unknown fallback", () => {
  const cases = [
    [{ kind: "mass-delete", op: "pull" }, "⛔ sync paused to protect against a large deletion · rbox sync --allow-mass-delete"],
    [{ kind: "mass-delete", op: "push" }, "⛔ sync paused to protect against a large deletion · rbox sync --allow-mass-delete"],
    [{ kind: "too-many-refs" }, "⛔ workspace has too many files to upload · rbox ignore"],
    [{ kind: "body-too-large" }, "⛔ workspace update is too large to upload · rbox ignore"],
    [{ kind: "unknown" }, "⛔ sync halted — see rbox logs"],
  ] as const;
  for (const [halt, copy] of cases) {
    const rendered = lines(full({ halt }));
    expect(rendered[0]).toBe("Development · sync needs attention");
    expect(rendered[1]).toBe(copy);
  }
});

test("plan/quota precedence and all quota copy are closed", () => {
  expect(lines(full({ planQuota: { kind: "no-active-plan" } })).slice(0, 2)).toEqual([
    "Development · sync needs attention", "⛔ no active plan · rbox subscribe",
  ]);
  expect(lines(full({ planQuota: { kind: "storage-limit" } }))[1]).toBe("⛔ storage limit reached · rbox usage · rbox subscribe");
  expect(lines(full({ planQuota: { kind: "workspace-limit" } }))[1]).toBe("⛔ workspace limit reached · rbox usage · rbox subscribe");
  expect(aggregatePlanQuotaAttention(account("none"), { at: ago(1), kind: "storage" })).toEqual({ kind: "no-active-plan" });
  expect(aggregatePlanQuotaAttention(account("pro"), { at: ago(1), kind: "storage", reason: "no_plan" })).toEqual({ kind: "no-active-plan" });
  expect(aggregatePlanQuotaAttention(account("pro"), { at: ago(1), kind: "storage" })).toEqual({ kind: "storage-limit" });
  expect(aggregatePlanQuotaAttention(account("pro"), { at: ago(1), kind: "workspaces" })).toEqual({ kind: "workspace-limit" });
  expect(aggregatePlanQuotaAttention(account(null), undefined)).toEqual({ kind: "none" });
});

test("locking, version, git, trash, and update keep rows use exact copy", () => {
  const lockCases = [
    [{ status: "degraded-unlocked", reason: "identity-unavailable" }, "⚠ safe workspace locking is unavailable; Git config sync is off · rbox doctor"],
    [{ status: "starved", reason: "foreign" }, "⚠ workspace sync is waiting on another lock · rbox doctor"],
    [{ status: "starved", reason: "identity-drift" }, "⚠ workspace lock identity changed · rbox doctor"],
    [{ status: "starved", reason: "stale-owned" }, "⚠ a stale workspace lock is blocking sync · rbox doctor"],
    [{ status: "starved", reason: "fence" }, "⚠ workspace recovery is holding the sync lock · rbox doctor"],
  ] as const;
  for (const [locking, copy] of lockCases) expect(lines(full({ locking }))).toContain(copy);
  expect(lines(full({ daemonVersionSkew: true }))).toContain("⚠ rbox was updated; restart background sync · rbox stop && rbox start");
  expect(lines(full({ git: { count: 1, oldestDeferredSince: ago(86400_000), allLocalEditDeferrals: true } })))
    .toContain("⚠ 1 git repo waiting on uncommitted changes (oldest: 1 day) · rbox status --git");
  expect(lines(full({ git: { count: 2, oldestDeferredSince: ago(2 * 3600_000), allLocalEditDeferrals: false } })))
    .toContain("⚠ 2 git repos need attention (oldest: 2 hours) · rbox status --git");
  expect(lines(full({ trash: { files: 1, bytes: 12_300 } }))).toContain("⚠ 1 trashed file (12.3 KB) · rbox trash list");
  expect(lines(full({ update: { current: "1.0.0", next: "1.1.0" } }))).toContain("⚠ update available: 1.0.0 → 1.1.0 · rbox upgrade");
});

test("behind-remote copy is identical for all four evidence/liveness variants", () => {
  const attention = "⚠ remote changes waiting to download · rbox pull";
  const probeRemote = { sequence: 80, source: "probe" as const };
  const running = lines(full({ behindRemote: briefBehindRemote(78, probeRemote) }));
  const stopped = lines(full({ behindRemote: briefBehindRemote(78, probeRemote), daemonRunning: false }));
  const attributed = attributeDaemonForStatus({
    activity: {
      at: ago(1),
      ws: { connected: true, caughtUp: true, at: ago(1), lastBroadcastSequence: 80, bootId: "boot", pid: 1234 },
    },
    daemonRunning: true,
    boundWorkspaceId: "ws_current",
    currentWorkspaceId: "ws_current",
    livePidfileBootId: "boot",
    localSequence: 78,
    now: NOW,
  });
  expect(attributed.remote).toMatchObject({ sequence: 80, source: "daemon" });
  const daemonSourced = lines(full({ behindRemote: briefBehindRemote(78, attributed.remote) }));
  const simultaneous = lines(full({ behindRemote: briefBehindRemote(78, probeRemote), pendingChanges: 1, active: { phase: "upload", done: 1, total: 2 } }));
  expect(running).toEqual(["Development · syncing normally", attention, "Signed in as owner@example.com · pro"]);
  expect(stopped).toEqual([
    "Development · sync is paused",
    "⚠ background sync is stopped · rbox start",
    attention,
    "Signed in as owner@example.com · pro",
  ]);
  expect(daemonSourced).toEqual(running);
  expect(simultaneous).toEqual([
    "Development · syncing normally — 1 change uploading now",
    attention,
    "Signed in as owner@example.com · pro",
  ]);
  expect(simultaneous.join("\n")).not.toMatch(/sequence|78|80/);
  expect(briefBehindRemote(78, { sequence: 80, source: "probe" })).toBe(true);
  expect(briefBehindRemote(78, { sequence: 80, source: "daemon", ageMs: 10 })).toBe(true);
  expect(briefBehindRemote(80, { sequence: 80, source: "probe" })).toBe(false);
});

test("workspace label fallbacks and active-upload freshness are decided before rendering", () => {
  expect(briefWorkspaceLabel("Configured", "root")).toBe("Configured");
  expect(briefWorkspaceLabel("\u001b[31m\n", "root")).toBe("root");
  expect(briefWorkspaceLabel(undefined, "")).toBe("Workspace");
  const activity = { at: ago(1), active: { at: ago(1), phase: "upload" as const, done: 1, total: 2 } };
  expect(freshBriefActive(activity, true, NOW)).toMatchObject({ phase: "upload" });
  expect(freshBriefActive(activity, false, NOW)).toBeUndefined();
  expect(freshBriefActive({ ...activity, active: { ...activity.active, at: ago(60_000) } }, true, NOW)).toBeUndefined();
});

test("reset-halt snapshot has typed absence of state-backed fields", () => {
  const reset: Extract<BriefStatusSnapshot, { kind: "reset-halt" }> = {
    kind: "reset-halt", workspaceLabel: "Development", daemonRunning: false, account: account(),
  };
  // @ts-expect-error reset-halt cannot carry full-snapshot local evidence
  void reset.pendingChanges;
  // @ts-expect-error reset-halt cannot carry full-snapshot locking evidence
  void reset.locking;
  expect(Object.keys(reset).sort()).toEqual(["account", "daemonRunning", "kind", "workspaceLabel"]);
});

test("headline blocker predicate is closed and attention ordering is total", () => {
  const blockers: Partial<Full>[] = [
    { halt: { kind: "unknown" } },
    { planQuota: { kind: "storage-limit" } },
    { daemonVersionSkew: true },
    { locking: { status: "starved", reason: "foreign" } },
  ];
  for (const blocker of blockers) expect(headlineBlocked(full(blocker))).toBe(true);
  const nonBlockers: Partial<Full>[] = [
    { daemonRunning: false }, { daemonStale: true }, { populate: { filesDone: 1, filesTotal: 2 } },
    { active: { phase: "download", done: 1, total: 2 } }, { pendingChanges: 1 }, { behindRemote: true },
    { git: { count: 1, oldestDeferredSince: ago(1000), allLocalEditDeferrals: true } },
    { trash: { files: 1, bytes: 1 } }, { update: { current: "1", next: "2" } },
  ];
  for (const nonBlocker of nonBlockers) expect(headlineBlocked(full(nonBlocker))).toBe(false);
  expect(lines({ kind: "reset-halt", workspaceLabel: "Development", daemonRunning: false, account: account() })).toEqual([
    "Development · sync needs attention",
    "⛔ sync halted to protect recovery state · rbox doctor reset-journal",
    "Signed in as owner@example.com · pro",
  ]);

  const ordered = lines(full({
    daemonRunning: false,
    daemonStale: true,
    halt: { kind: "unknown" },
    planQuota: { kind: "no-active-plan" },
    daemonVersionSkew: true,
    locking: { status: "starved", reason: "fence" },
    behindRemote: true,
    git: { count: 2, oldestDeferredSince: ago(8 * 86400_000), allLocalEditDeferrals: false },
    trash: { files: 2, bytes: 1000 },
    update: { current: "1.0.0", next: "2.0.0" },
  }));
  expect(ordered).toEqual([
    "Development · sync needs attention",
    "⛔ sync halted — see rbox logs",
    "⛔ no active plan · rbox subscribe",
    "⚠ background sync is attached to a previous workspace · rbox start",
    "⚠ rbox was updated; restart background sync · rbox stop && rbox start",
    "⚠ workspace recovery is holding the sync lock · rbox doctor",
    "⚠ remote changes waiting to download · rbox pull",
    "⚠ 2 git repos need attention (oldest: 7 days) · rbox status --git",
    "⚠ 2 trashed files (1.0 KB) · rbox trash list",
    "⚠ update available: 1.0.0 → 2.0.0 · rbox upgrade",
    "Signed in as owner@example.com · pro",
  ]);
});

test("brief age spells and inflects every required unit", () => {
  expect(briefAge(ago(60_000), NOW)).toBe("1 minute");
  expect(briefAge(ago(2 * 3600_000), NOW)).toBe("2 hours");
  expect(briefAge(ago(86400_000), NOW)).toBe("1 day");
  expect(briefAge(ago(8 * 86400_000), NOW)).toBe("7 days");
  expect(briefAge(ago(20 * 86400_000), NOW)).toBe("14 days");
  expect(briefAge(ago(45 * 86400_000), NOW)).toBe("30 days");
});

test("healthy brief suppresses every legacy healthy/history/footer class", () => {
  const snapshot = full() as Full & Record<string, unknown>;
  Object.assign(snapshot, {
    workspaceId: "ws_secret", deviceId: "dev_secret", accountId: "acct_secret", pid: 4242,
    localSequence: 78, remoteSequence: 80, lockingPath: ".rbox/state/sync.lock",
    lastSync: "last push", syncs: 5, commitConflicts409: 2, trackedFiles: 99,
    crypto: "workers healthy", healthyGit: "3 repos synced",
  });
  const output = lines(snapshot).join("\n");
  for (const forbidden of ["ws_", "dev_", "acct_", "4242", "sequence", "commit-409", "last push", "syncs", "files on disk", "locking:", "git-sync:", "crypto workers:"]) {
    expect(output).not.toContain(forbidden);
  }
  expect(renderBriefStatus(snapshot).daemonRunning).toBe(true);
});
