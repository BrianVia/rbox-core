import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  StatusDetailProjection,
  StatusHaltProbes,
  StatusHaltProjection,
  StatusMode,
  StatusModeProbes,
  WorkspaceStatusProjection,
} from "./status-contract.js";
import {
  renderStatusBrief,
  renderStatusJson,
  renderStatusVerbose,
  renderWorkspaceStatusSurface,
} from "./status-render.js";
import type { GitDeferralRepoProjection } from "./status-view/git-projection.js";
import { gitStoryFor } from "./status-view/git-stories.js";

const ROOT = "/tmp/rbox-status-render";
const NOW = Date.parse("2026-07-08T12:00:00Z");
const AT = new Date(NOW - 90_000).toISOString();

/** One probe receipt per mode — the exact member `WorkspaceStatusProjection<M>`
 *  demands, so a renderer never sees another mode's probes. */
type DetailProbesByMode = { [M in StatusMode]: Extract<StatusModeProbes, { mode: M }> };
type HaltProbesByMode = { [M in StatusMode]: Extract<StatusHaltProbes, { mode: M }> };

const PROBES: DetailProbesByMode = {
  json: { mode: "json", account: { plan: null, usedBytes: null, capBytes: null } },
  verbose: {
    mode: "verbose",
    accountSummary: { state: "signed-out" },
    metrics: { syncs: 0, commitConflicts409: 0, fileConflicts: 0, lockStarved: 0 },
  },
  brief: { mode: "brief", account: { state: "signed-out" } },
  git: { mode: "git", account: { state: "signed-out" } },
};

function deferredRepo(): GitDeferralRepoProjection {
  return {
    repo: "repos/alpha",
    oldestDeferredSince: AT,
    displayReason: "local-edits",
    displayLane: "capture",
    reasonSince: AT,
    reasonLabel: "local edits",
    reasonText: "uncommitted changes",
    repairText: "commit or stash",
    remediationClass: "user-action",
    story: gitStoryFor("local-edits"),
    quiet: false,
    canResolve: false,
    canKeepMine: false,
    bytesChanged: true,
  } as GitDeferralRepoProjection;
}

function base(): Omit<StatusDetailProjection, "probes"> {
  return {
    kind: "detail",
    workspace: { id: "ws_render", name: "demo", root: ROOT, deviceId: "dev_render", syncGit: true },
    daemon: { running: true, pid: 42, stale: false, versionSkew: false },
    credentials: { state: "absent" },
    bookkeeping: { promoteDaemonModeIntent: false },
    genesisPending: false,
    state: { localSequence: 7, syncedRepos: 1, pendingRepos: 0, conflictRepos: 0 },
    counts: {
      source: "computed",
      added: 0,
      changed: 0,
      deleted: 0,
      trackedFiles: 3,
      gitChanged: 0,
      gitDeferrals: [],
      conflictSnapshots: { total: 0, prunable: 0 },
    },
    localChanges: 0,
    health: "ok",
    locking: { status: "ok" },
    crypto: { state: "off", workers: 0, jobsRun: 0, workerExecutions: 0 },
    git: {
      deferrals: [],
      projectedRepos: [],
      localRepoProjections: [],
      deferredRepos: 0,
      bytesChangedDeferrals: 0,
    },
    hygieneDetails: new Map(),
    now: NOW,
  };
}

function detail<M extends StatusMode>(
  mode: M,
  over: Partial<StatusDetailProjection> = {},
): Extract<WorkspaceStatusProjection<M>, { kind: "detail" }> {
  return { ...base(), ...over, probes: PROBES[mode] };
}

const HALT_PROBES: HaltProbesByMode = {
  json: { mode: "json" },
  verbose: { mode: "verbose" },
  brief: { mode: "brief", account: { state: "signed-out" } },
  git: { mode: "git", account: { state: "signed-out" } },
};

function halt<M extends StatusMode>(mode: M): Extract<WorkspaceStatusProjection<M>, { kind: "reset-halt" }> {
  const { workspace, daemon, credentials, bookkeeping } = base();
  return {
    kind: "reset-halt",
    halted: true,
    reason: "unreadable-journal",
    workspace,
    daemon,
    credentials,
    bookkeeping,
    probes: HALT_PROBES[mode],
  };
}

const withDeferral = () => ({
  git: { ...base().git, projectedRepos: [deferredRepo()], localRepoProjections: [deferredRepo()] },
}) as Partial<StatusDetailProjection>;

test("every renderer is a pure function of its projection: no writer or reader is reachable", async () => {
  const source = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "status-render.ts"),
    "utf8",
  );
  // A renderer that can emit can also skip the composition root's ordering, and
  // a renderer that can read has escaped the single-projection contract.
  const forbidden = [
    "console", "process", "emitJson", "emitJsonTo", "require",
    "loadState", "loadActivity", "loadConfig", "loadMetrics", "loadCredentials", "scanManifest",
    "trashStats", "readUpdateCheckState", "fetchAccountSummary", "readLockingHealth", "readPathWarnings",
    "inspectResetJournalSafety", "readResetHaltHealth", "readFreshPopulateStatus", "cryptoPoolStatus",
    "conflictSnapshotStatus", "checkoutTransactionCapability", "buildIgnoreMatcher", "HashCache",
    "fetchWithDeadline", "readAccountProfile", "pendingGenesisState", "readAmbientDaemonStatusRecord",
    "gitDivergenceCount", "gitDivergenceStatus", "gitDivergenceFastRepoSource", "daemonBindingStatus",
    "projectWorkspaceStatusDetail", "refreshStatusDeferralAssertions", "saveStatusHashCache",
  ];
  expect(forbidden.filter((name) => new RegExp(`\\b${name}\\b`).test(source))).toEqual([]);
  // `Date.parse` over a projected timestamp is pure; a clock read is not.
  expect(/\bDate\.now\s*\(/.test(source)).toBe(false);
});

test("rendering emits nothing: stdout stays untouched for every surface", () => {
  const writes: unknown[] = [];
  const realLog = console.log;
  const realWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => void writes.push(args);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    renderWorkspaceStatusSurface(detail("json"));
    renderWorkspaceStatusSurface(detail("verbose"));
    renderWorkspaceStatusSurface(detail("brief"));
    renderWorkspaceStatusSurface(detail("git", withDeferral()));
    renderWorkspaceStatusSurface(halt("json"));
    renderWorkspaceStatusSurface(halt("verbose"));
    renderWorkspaceStatusSurface(halt("brief"));
  } finally {
    console.log = realLog;
    process.stdout.write = realWrite;
  }
  expect(writes).toEqual([]);
});

test("one projection selects exactly one surface", () => {
  expect(renderWorkspaceStatusSurface(detail("json")).surface).toBe("json");
  expect(renderWorkspaceStatusSurface(halt("json")).surface).toBe("json");
  for (const rendered of [
    renderWorkspaceStatusSurface(detail("verbose")),
    renderWorkspaceStatusSurface(detail("brief")),
    renderWorkspaceStatusSurface(detail("git")),
    renderWorkspaceStatusSurface(halt("verbose")),
    renderWorkspaceStatusSurface(halt("brief")),
    renderWorkspaceStatusSurface(halt("git")),
  ]) {
    expect(rendered.surface).toBe("lines");
  }
});

test("JSON carries health for a detail projection and halt for a reset projection", () => {
  const detailed = renderStatusJson(detail("json"));
  expect(detailed.health).toBe("ok");
  expect(detailed.halted).toBeUndefined();
  expect(detailed.daemon.watcherTrust).toBeNull();

  const fused = renderStatusJson(detail("json", { daemon: { ...base().daemon, watcherTrust: "fused" } }));
  expect(fused.daemon.watcherTrust).toBe("fused");

  const halted = renderWorkspaceStatusSurface(halt("json"));
  if (halted.surface !== "json") throw new Error("unreachable");
  expect(halted.payload.halted).toBe(true);
  expect(halted.payload.reason).toBe("unreadable-journal");
  expect(halted.payload.health).toBeUndefined();
});

test("verbose watcher trust remains supplementary to stronger conditions", () => {
  const projection = detail("verbose", {
    daemon: { ...base().daemon, watcherTrust: "fused" },
    activity: { at: AT, outOfStorage: { at: AT, kind: "storage" } },
  });
  const lines = renderStatusVerbose(projection);
  // Design 237 §4.3: the fused copy is cause-neutral and no longer says "fused".
  expect(lines.some((line) => line.includes("watcher trust:") && line.includes("reliability reduced"))).toBe(true);
  expect(lines.some((line) => line.includes("storage"))).toBe(true);
});

test("the shared Git line is suppressed in brief and added by Git detail", () => {
  const brief = renderStatusBrief(detail("brief", withDeferral()));
  const git = renderStatusBrief(detail("git", withDeferral()));

  // Design 273 S2: `--git` appends the grouped story listing under the same
  // brief surface. Full repo paths, no daemon log grammar. The one line brief
  // has that `--git` does not is the pointer AT the listing being printed.
  const pointer = "  See them:  rbox status --git";
  expect(brief).toContain(pointer);
  expect(git).not.toContain(pointer);
  expect(git.slice(0, brief.length - 1)).toEqual(brief.filter((line) => line !== pointer));
  expect(git.length).toBeGreaterThan(brief.length);
  expect(git.join("\n")).toContain("repos/alpha");
  expect(git.join("\n")).not.toContain("git deferred ");
});

test("verbose renders its own surface, never the brief one", () => {
  const verbose = renderStatusVerbose(detail("verbose", withDeferral()));
  const brief = renderStatusBrief(detail("brief", withDeferral()));

  expect(verbose.some((line) => line.includes("workspace"))).toBe(true);
  expect(verbose.some((line) => line.includes("git-sync:"))).toBe(true);
  expect(brief.some((line) => line.includes("git-sync:"))).toBe(false);
  expect(verbose).not.toEqual(brief);
});

test("a renderer reads no clock of its own: the same projection renders identically", () => {
  const projection = detail("brief", withDeferral());
  expect(renderStatusBrief(projection)).toEqual(renderStatusBrief(projection));
  expect(renderStatusVerbose(detail("verbose", withDeferral()))).toEqual(
    renderStatusVerbose(detail("verbose", withDeferral())),
  );
  expect(renderStatusJson(detail("json", withDeferral()))).toEqual(renderStatusJson(detail("json", withDeferral())));
});

test("the halt surface for every mode reports the daemon the projection carries", () => {
  for (const mode of ["json", "verbose", "brief", "git"] as const) {
    const rendered = renderWorkspaceStatusSurface(halt(mode));
    expect(rendered.daemonRunning).toBe(true);
  }
});

test("StatusHaltProjection and StatusDetailProjection are the only accepted inputs", () => {
  // The renderers accept their mode's projection only; this is the runtime
  // witness that a halt projection never reaches a detail renderer.
  const haltProjection: StatusHaltProjection = halt("json");
  expect(haltProjection.kind).toBe("reset-halt");
  expect(renderWorkspaceStatusSurface(halt("json")).surface).toBe("json");
});
