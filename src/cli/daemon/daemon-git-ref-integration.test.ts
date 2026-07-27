import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RboxDaemon } from "../daemon.js";
import type { GitRefWatchRegistry } from "./git-ref-watch.js";
import type { SignalDebouncer, Watcher } from "./watcher.js";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox integration",
  GIT_AUTHOR_EMAIL: "rbox-integration@local",
  GIT_COMMITTER_NAME: "rbox integration",
  GIT_COMMITTER_EMAIL: "rbox-integration@local",
};

interface IntegrationDaemon {
  startLiveWatch(): Promise<void>;
  pumping: boolean;
  pendingEvents: Array<{ relPath: string }>;
  pendingPushReasons: { signal: boolean; candidate: boolean; scan: boolean; other: boolean };
  want: { push: boolean };
  takePushProvenance(): { signal: boolean; candidate: boolean; scan: boolean; other: boolean };
  gitDiscovery: { registry?: GitRefWatchRegistry; close(): Promise<void> };
  gitSignalDebouncer?: SignalDebouncer;
  watcher?: Watcher;
  safetyTimer?: ReturnType<typeof setTimeout>;
  deepTimer?: ReturnType<typeof setInterval>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for daemon ref-watch condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test.skipIf(process.platform !== "linux")(
  "real Parcel churn: a post-start repo arms, handshakes, and its empty commit stays signal-only",
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-ref-flood-")));
    const repo = path.join(root, "post-start");
    const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
    const daemon = new RboxDaemon(root, cfg as never, {} as never) as unknown as IntegrationDaemon;
    daemon.pumping = true; // exercise enqueue/provenance without entering network sync

    try {
      await daemon.startLiveWatch();
      fs.mkdirSync(repo);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await exec("git", ["-C", repo, "init", "--initial-branch=main", "--quiet"], { env: GIT_ENV });
      await waitFor(() => (daemon.gitDiscovery.registry?.activeHandles ?? 0) >= 4);
      await new Promise((resolve) => setTimeout(resolve, 650)); // drain the arm handshake batch
      expect(daemon.want.push).toBe(true);

      daemon.want.push = false;
      daemon.pendingPushReasons = { signal: false, candidate: false, scan: false, other: false };
      daemon.pendingEvents = [];

      const noise = path.join(root, "noise");
      fs.mkdirSync(noise);
      const commit = exec("git", ["-C", repo, "commit", "--allow-empty", "--quiet", "-m", "post-start empty"], { env: GIT_ENV });
      for (let index = 0; index < 512; index++) fs.writeFileSync(path.join(noise, `f-${index}`), `${index}\n`);
      await commit;

      await waitFor(() => daemon.want.push && daemon.pendingPushReasons.signal);
      const provenance = daemon.takePushProvenance();
      expect(provenance.signal).toBe(true);
      expect(daemon.pendingEvents.some((event) => event.relPath.split("/").includes(".git"))).toBe(false);
    } finally {
      if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
      if (daemon.deepTimer) clearInterval(daemon.deepTimer);
      await daemon.watcher?.close().catch(() => {});
      await daemon.gitDiscovery.close().catch(() => {});
      daemon.gitSignalDebouncer?.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
