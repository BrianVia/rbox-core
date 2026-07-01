import { afterAll, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The load-bearing §41 invariant: if the live watcher can't start, the daemon must
// NOT go silently dead — the 60s safety scan + 30m deep scan reconcile loops stay
// armed so sync degrades to periodic full-scan. We force startWatcher to reject and
// assert the reconcile timers are armed while the watcher is not.

// Capture the real module first so we can restore it after — bun's mock.module is
// process-global; without restoring, other test files' real watcher would stay mocked.
const realWatcher = await import("./watcher.js");

afterAll(() => {
  mock.module("./watcher.js", () => realWatcher);
});

test("watcher init rejects → reconcile timers stay armed (never silently dead)", async () => {
  // Neutral message on purpose: it must NOT contain "fsevents"/"sandbox"/etc, or if this
  // process-global mock momentarily leaks into another file's native-capability probe it
  // would be mistaken for a real unsupported environment and wrongly skip that suite.
  mock.module("./watcher.js", () => ({
    ...realWatcher,
    startWatcher: () => Promise.reject(new Error("forced watcher-init failure (degrade test stub)")),
  }));

  const { RboxDaemon } = await import("./daemon.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-degrade-")));
  // Minimal config/deps: startLiveWatch touches only root/matcher/timers, not the network.
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const daemon = new RboxDaemon(root, cfg as never, {} as never) as unknown as {
    startLiveWatch(): Promise<void>;
    watcher?: unknown;
    safetyTimer?: ReturnType<typeof setInterval>;
    deepTimer?: ReturnType<typeof setInterval>;
  };

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
