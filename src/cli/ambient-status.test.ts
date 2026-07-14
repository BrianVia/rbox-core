import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatPromptStatus,
  projectAmbientDaemonStatus,
  promptStatusJson,
  readPromptStatus,
  type AmbientDaemonStatusV1,
} from "./ambient-status.js";
import { daemonPidPath, daemonRuntimeDir, daemonStatusPath } from "./rbox-paths.js";
import type { DaemonActivity } from "./activity.js";
import { saveAmbientDaemonStatus } from "./ambient-status-writer.js";

const NOW = Date.parse("2026-07-08T12:00:00.000Z");
const freshAt = new Date(NOW - 1_000).toISOString();
const staleAt = new Date(NOW - 16_000).toISOString();

let tmp: string;
let root: string;
let outside: string;
let oldHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ambient-status-"));
  root = path.join(tmp, "workspace");
  outside = path.join(tmp, "outside");
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({ remoteWorkspaceId: "ws_ambient", name: "Ambient" }));
  oldHome = process.env.RBOX_HOME;
  process.env.RBOX_HOME = path.join(tmp, "home");
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = oldHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writePid(): Promise<void> {
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(daemonPidPath(root), "v2 123 boot\n");
}

async function writeStatus(status: Partial<AmbientDaemonStatusV1>): Promise<void> {
  const full: AmbientDaemonStatusV1 = {
    schemaVersion: 1,
    state: "synced",
    heartbeatAt: freshAt,
    sequence: 12,
    lastSyncedAt: freshAt,
    ...status,
  };
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(daemonStatusPath(root), JSON.stringify(full));
}

test("reader matrix: absent/corrupt/stale/fresh status crossed with pidfile presence", async () => {
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("○");

  await writePid();
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! dead");

  await fs.writeFile(daemonStatusPath(root), "{nope");
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! dead");
  await fs.rm(daemonPidPath(root));
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! dead");

  await writeStatus({ state: "paused", heartbeatAt: staleAt });
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("○");
  await writePid();
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! dead");

  await writeStatus({ state: "synced", heartbeatAt: staleAt });
  await fs.rm(daemonPidPath(root));
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! dead");
  await writePid();
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! dead");

  await writeStatus({ state: "synced", heartbeatAt: freshAt });
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("✓");

  await writeStatus({
    state: "syncing",
    operation: { kind: "push", phase: "upload", filesDone: 2, filesTotal: 5 },
  });
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("↑3");

  await writeStatus({ state: "attention", attentionReason: "out-of-storage" });
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! quota");
});

test("outside a workspace prints nothing, including --json shape", async () => {
  const verdict = readPromptStatus(outside, NOW);
  expect(formatPromptStatus(verdict)).toBe("");
  expect(promptStatusJson(verdict)).toBe("");

  const cliEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
  const res = Bun.spawnSync(["bun", cliEntry, "prompt-status", "--json"], {
    cwd: outside,
    env: { ...process.env, RBOX_HOME: process.env.RBOX_HOME! },
  });
  expect(res.exitCode).toBe(0);
  expect(new TextDecoder().decode(res.stdout)).toBe("");
  expect(new TextDecoder().decode(res.stderr)).toBe("");
});

test("prompt output is path-free even when daemon.status.json carries currentPath", async () => {
  const sentinel = "SENTINEL_CURRENT_PATH_secret.txt";
  await writeStatus({
    state: "syncing",
    operation: { kind: "push", phase: "encrypt", filesDone: 1, filesTotal: 2, currentPath: sentinel },
  });
  const verdict = readPromptStatus(root, NOW);
  expect(formatPromptStatus(verdict)).toBe("↑1");
  expect(formatPromptStatus(verdict)).not.toContain(sentinel);
  expect(promptStatusJson(verdict)).not.toContain(sentinel);
});

test("ambient writer aborts silently when ownership is lost before rename", async () => {
  await writePid();
  await writeStatus({ state: "synced", sequence: 12 });
  const before = await fs.readFile(daemonStatusPath(root), "utf8");

  let checked = false;
  await saveAmbientDaemonStatus(
    root,
    { schemaVersion: 1, state: "syncing", heartbeatAt: freshAt, sequence: 99, lastSyncedAt: freshAt },
    {
      beforeRename: async () => {
        checked = true;
        await fs.rm(daemonPidPath(root), { force: true });
        return false;
      },
    }
  );

  expect(checked).toBe(true);
  expect(await fs.readFile(daemonStatusPath(root), "utf8")).toBe(before);
});

test("state projection table follows design-88 precedence and operation shape", () => {
  const activity: DaemonActivity = {
    at: freshAt,
    lastPush: { at: "2026-07-08T11:59:00.000Z", files: 3, sequence: 41 },
    lastPull: { at: "2026-07-08T11:58:00.000Z", writes: 1, deletes: 0, conflicts: 0 },
  };
  const base = { activity, settled: true, now: NOW, sequence: 41 };

  expect(projectAmbientDaemonStatus(base)).toMatchObject({
    state: "synced",
    sequence: 41,
    lastSyncedAt: "2026-07-08T11:59:00.000Z",
  });

  expect(projectAmbientDaemonStatus({ ...base, want: { push: true } })).toMatchObject({
    state: "syncing",
    operation: { kind: "push" },
  });

  expect(
    projectAmbientDaemonStatus({
      ...base,
      settled: false,
      activePumpOp: "pull",
      activity: { ...activity, active: { at: freshAt, phase: "download", done: 2, total: 6, bytesDone: 20, bytesTotal: 60 } },
      currentPath: "docs/readme.md",
    })
  ).toMatchObject({
    state: "syncing",
    operation: { kind: "pull", phase: "download", filesDone: 2, filesTotal: 6, bytesDone: 20, bytesTotal: 60, currentPath: "docs/readme.md" },
  });

  expect(projectAmbientDaemonStatus({ ...base, activity: { ...activity, halt: { at: freshAt, reason: "blocked", count: 1, op: "push" } } })).toMatchObject({
    state: "attention",
    attentionReason: "halt",
  });
  expect(projectAmbientDaemonStatus({ ...base, activity: { ...activity, outOfStorage: { at: freshAt, kind: "storage" } } })).toMatchObject({
    state: "attention",
    attentionReason: "out-of-storage",
  });
  expect(projectAmbientDaemonStatus({ ...base, watcherDegraded: true })).toMatchObject({
    state: "attention",
    attentionReason: "watcher-degraded",
  });
  expect(projectAmbientDaemonStatus({ ...base, ownershipLost: true })).toMatchObject({
    state: "attention",
    attentionReason: "ownership-lost",
  });
});

test("deferral projection and reader round-trip expose counts and oldest age only", async () => {
  const projected = projectAmbientDaemonStatus({
    activity: { at: freshAt },
    settled: true,
    now: NOW,
    repoRecords: {
      "private/repo-name": {
        repoGen: 1,
        sourceSeq: 1,
        deferrals: {
          apply: {
            lane: "apply",
            reason: "local-edits",
            deferredSince: new Date(NOW - 3_600_500).toISOString(),
            reasonSince: freshAt,
            lastSeen: freshAt,
            checkout: { kind: "branch", label: "secret branch" },
          },
          capture: {
            lane: "capture",
            reason: "local-index",
            deferredSince: new Date(NOW - 600_000).toISOString(),
            reasonSince: freshAt,
            lastSeen: freshAt,
          },
        },
      },
      other: {
        repoGen: 1,
        sourceSeq: 1,
        deferrals: {
          config: {
            lane: "config",
            reason: "config",
            deferredSince: new Date(NOW - 86_400_000).toISOString(),
            reasonSince: freshAt,
            lastSeen: freshAt,
          },
        },
      },
    },
  });
  expect(projected.deferredRepos).toBe(2);
  expect(projected.oldestDeferralAgeSeconds).toBe(86_400);
  expect(JSON.stringify(projected)).not.toContain("private/repo-name");
  expect(JSON.stringify(projected)).not.toContain("secret branch");

  await writeStatus(projected);
  const verdict = readPromptStatus(root, NOW);
  expect(verdict).toMatchObject({ kind: "workspace", state: "synced" });

  await writeStatus({ deferredRepos: -1 as never });
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! dead");
  await writeStatus({ deferredRepos: 1, oldestDeferralAgeSeconds: -1 as never });
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! dead");
});
