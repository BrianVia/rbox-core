import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RboxDaemon } from "../daemon.js";

// The load-bearing §41 invariant: if the live watcher can't start, the daemon must NOT go
// silently dead — the 60s safety scan + 30m deep scan reconcile loops stay armed so sync
// degrades to periodic full-scan. We force the watcher factory to reject (via the daemon's
// injectable `startWatcherFn` seam — no process-global module mock, so nothing leaks into
// other test files) and assert the reconcile timers are armed while the watcher is not.

test("watcher init rejects → reconcile timers stay armed (never silently dead)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-degrade-")));
  // Minimal config/deps: startLiveWatch touches only root/matcher/timers, not the network.
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  const daemon = new RboxDaemon(root, cfg as never, {} as never) as unknown as {
    startWatcherFn: () => Promise<never>;
    startLiveWatch(): Promise<void>;
    watcher?: unknown;
    safetyTimer?: ReturnType<typeof setInterval>;
    deepTimer?: ReturnType<typeof setInterval>;
  };
  daemon.startWatcherFn = () => Promise.reject(new Error("forced watcher-init failure (degrade test)"));

  try {
    await daemon.startLiveWatch();
    expect(daemon.watcher).toBeUndefined(); // watcher failed to start
    expect(daemon.safetyTimer).toBeDefined(); // …but the reconcile floor is armed
    expect(daemon.deepTimer).toBeDefined();
  } finally {
    if (daemon.safetyTimer) clearInterval(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
