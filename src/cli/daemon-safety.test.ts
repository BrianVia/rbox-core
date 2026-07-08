import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nextSafetyDelay, RboxDaemon } from "./daemon.js";

// Design 49: the safety scan heals DROPPED watcher events, and drops happen under
// churn — so quiet intervals back the scan off (60s → 5m cap) instead of
// stat-sweeping every tracked file each minute on an idle machine, forever.

const FLOOR = 60_000;
const CAP = 5 * 60_000;
const quiet = { watcherLive: true, churned: false };

test("nextSafetyDelay doubles quiet intervals and caps at 5m", () => {
  expect(nextSafetyDelay(FLOOR, quiet)).toBe(120_000);
  expect(nextSafetyDelay(120_000, quiet)).toBe(240_000);
  expect(nextSafetyDelay(240_000, quiet)).toBe(CAP); // 480s would overshoot — capped
  expect(nextSafetyDelay(CAP, quiet)).toBe(CAP);
});

test("churn snaps the delay back to the 60s floor from any level", () => {
  expect(nextSafetyDelay(CAP, { watcherLive: true, churned: true })).toBe(FLOOR);
  expect(nextSafetyDelay(120_000, { watcherLive: true, churned: true })).toBe(FLOOR);
});

test("no live watcher never backs off — the periodic scan IS the sync mechanism there", () => {
  expect(nextSafetyDelay(FLOOR, { watcherLive: false, churned: false })).toBe(FLOOR);
  expect(nextSafetyDelay(CAP, { watcherLive: false, churned: false })).toBe(FLOOR);
});

interface SafetyInternals {
  startWatcherFn: (
    root: string,
    matcher: unknown,
    cb: (events: unknown[]) => void,
    opts?: { onError?: (err: Error) => void }
  ) => Promise<{ close(): Promise<void> }>;
  startLiveWatch(): Promise<void>;
  churnSinceSafety: boolean;
  watcherHealthy: boolean;
  safetyDelay: number;
  pumping: boolean;
  want: { push: boolean };
  watcher?: { close(): Promise<void> };
  safetyTimer?: ReturnType<typeof setTimeout>;
  deepTimer?: ReturnType<typeof setInterval>;
  matcher: { ignores(path: string): boolean };
  cfg: { respectGitignore?: boolean };
  reloadWorkspaceConfigIfChanged(): Promise<void>;
}

function makeDaemon(root: string, opts: { pullOnly?: boolean } = {}): SafetyInternals {
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  return new RboxDaemon(root, cfg as never, {} as never, opts) as unknown as SafetyInternals;
}

test("watcher events mark churn AND pull a backed-off timer forward (codex R1)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  let deliver: ((events: unknown[]) => void) | undefined;
  daemon.startWatcherFn = (_root, _matcher, cb) => {
    deliver = cb;
    return Promise.resolve({ close: async () => {} });
  };
  // Block the pump so delivering an event exercises ONLY the callback's
  // bookkeeping (churn flag + queued want) — this minimal daemon has no deps.
  daemon.pumping = true;

  try {
    await daemon.startLiveWatch();
    expect(daemon.churnSinceSafety).toBe(false); // boots quiet
    // Simulate a fully backed-off idle daemon, then a churn storm at T+1s.
    daemon.safetyDelay = CAP;
    const armedBefore = daemon.safetyTimer;
    deliver!([{ type: "update", path: path.join(root, "a.txt") }]);
    expect(daemon.churnSinceSafety).toBe(true); // churn recorded for the next tick
    expect(daemon.want.push).toBe(true); // hot path still queued the push
    // The codex R1 repro: the flag alone would let a drop from THIS storm wait out
    // the armed 5m timer. The timer must be re-armed at the floor immediately.
    expect(daemon.safetyDelay).toBe(FLOOR);
    expect(daemon.safetyTimer).not.toBe(armedBefore);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pull-only daemon watcher path never queues push", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root, { pullOnly: true });
  let deliver: ((events: unknown[]) => void) | undefined;
  daemon.startWatcherFn = (_root, _matcher, cb) => {
    deliver = cb;
    return Promise.resolve({ close: async () => {} });
  };
  daemon.pumping = true;

  try {
    await daemon.startLiveWatch();
    deliver!([{ type: "update", path: path.join(root, "a.txt") }]);
    expect(daemon.want.push).toBe(false);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a post-init watcher error revokes trust: backoff treats the watcher as dead (codex R1)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  let onError: ((err: Error) => void) | undefined;
  daemon.startWatcherFn = (_root, _matcher, _cb, opts) => {
    onError = opts?.onError;
    return Promise.resolve({ close: async () => {} });
  };
  daemon.pumping = true;

  try {
    await daemon.startLiveWatch();
    expect(daemon.watcherHealthy).toBe(true);
    // Simulate a fully backed-off idle daemon at the moment the stream dies.
    daemon.safetyDelay = CAP;
    const armedBefore = daemon.safetyTimer;
    onError!(new Error("FSEvents stream died"));
    expect(daemon.watcherHealthy).toBe(false); // …and stays false: trust is not restored
    // codex R2: the error must also pull the ARMED backed-off timer forward — the
    // flag alone would wait out the remaining (up to 5m) timeout.
    expect(daemon.safetyDelay).toBe(FLOOR);
    expect(daemon.safetyTimer).not.toBe(armedBefore);
    // With trust revoked, quiet intervals must NOT back off — the scan is now the
    // only healer for anything the (possibly dead) watcher misses.
    expect(nextSafetyDelay(CAP, { watcherLive: daemon.watcher !== undefined && daemon.watcherHealthy, churned: false })).toBe(FLOOR);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("design 72: safety tick reloads workspace.json and rebuilds the matcher", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  const cfg = {
    remoteWorkspaceId: "w",
    projectId: "root",
    deviceId: "d",
    rootPath: root,
    remoteUrl: "https://example.invalid",
    token: "",
    respectGitignore: false,
  };
  try {
    fs.mkdirSync(path.join(root, ".rbox"), { recursive: true });
    fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "pkg", ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(root, ".rbox", "workspace.json"), JSON.stringify(cfg));

    await daemon.reloadWorkspaceConfigIfChanged();
    expect(daemon.cfg.respectGitignore).toBe(false);
    expect(daemon.matcher.ignores("pkg/ignored.txt")).toBe(false);

    fs.writeFileSync(path.join(root, ".rbox", "workspace.json"), JSON.stringify({ ...cfg, respectGitignore: true }, null, 2));
    await daemon.reloadWorkspaceConfigIfChanged();
    expect(daemon.cfg.respectGitignore).toBe(true);
    expect(daemon.matcher.ignores("pkg/ignored.txt")).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v0.9.2 regression: reload preserves runtime-attached encrypted/kek/remoteUrl", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  const persisted = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://persisted.invalid", token: "" };
  try {
    fs.mkdirSync(path.join(root, ".rbox"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rbox", "workspace.json"), JSON.stringify(persisted));
    // Simulate what buildAuthedRemote layers on at boot — none of it is persisted.
    daemon.cfg.encrypted = true;
    daemon.cfg.kek = Buffer.alloc(32, 7);
    daemon.cfg.remoteUrl = "https://credential-override.invalid";
    daemon.cfg.token = "runtime-token";
    daemon.cfg.accountId = "acct_runtime";
    daemon.cfg.accountEpoch = 2;
    daemon.cfg.keyEpoch = 9;

    await daemon.reloadWorkspaceConfigIfChanged();

    // The v0.9.2 bug: cfg rebuilt from workspace.json dropped `encrypted` (and the
    // credential remoteUrl), so every subsequent daemon push failed "E2EE required".
    expect(daemon.cfg.encrypted).toBe(true);
    expect(Buffer.isBuffer(daemon.cfg.kek)).toBe(true);
    expect(daemon.cfg.remoteUrl).toBe("https://credential-override.invalid");
    expect(daemon.cfg.token).toBe("runtime-token");
    expect(daemon.cfg.accountId).toBe("acct_runtime");
    expect(daemon.cfg.accountEpoch).toBe(2);
    expect(daemon.cfg.keyEpoch).toBe(9);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
