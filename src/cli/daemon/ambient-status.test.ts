import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatPromptStatus,
  pausedAmbientDaemonStatus,
  projectAmbientDaemonStatus,
  promptStatusJson,
  readAmbientDaemonStatusRecord,
  readPromptStatus,
  type AmbientDaemonStatusV1,
} from "./ambient-status.js";
import { daemonPidPath, daemonRuntimeDir, daemonStatusPath } from "../rbox-paths.js";
import type { DaemonActivity } from "../activity.js";
import { saveAmbientDaemonStatus } from "./ambient-status-writer.js";
import { RBOX_VERSION } from "../version.js";

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

test("top-level ambient timestamps require an explicit timezone", async () => {
  await writeStatus({ heartbeatAt: "2026-07-08T11:59:59.000" });
  expect(readAmbientDaemonStatusRecord(root).kind).toBe("corrupt");

  await writeStatus({ lastSyncedAt: "2026-07-08T11:59:59.000" });
  expect(readAmbientDaemonStatusRecord(root).kind).toBe("corrupt");

  await writeStatus({ heartbeatAt: "2026-07-08T07:59:59.000-04:00", lastSyncedAt: null });
  expect(readAmbientDaemonStatusRecord(root).kind).toBe("ok");
});

test("outside a workspace prints nothing, including --json shape", async () => {
  const verdict = readPromptStatus(outside, NOW);
  expect(formatPromptStatus(verdict)).toBe("");
  expect(promptStatusJson(verdict)).toBe("");

  const cliEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
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

test("every persisted projection carries the daemon's build version", () => {
  const activity: DaemonActivity = {
    at: freshAt,
    lastPush: { at: "2026-07-08T11:59:00.000Z", files: 3, sequence: 41 },
  };
  const projected = projectAmbientDaemonStatus({ activity, settled: true, now: NOW, sequence: 41 });
  expect(projected.daemonVersion).toBe(RBOX_VERSION);
  expect(pausedAmbientDaemonStatus(NOW, projected).daemonVersion).toBe(RBOX_VERSION);
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

test("deferral projection and reader round-trip expose bounded repo details", async () => {
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
  expect(projected.deferrals).toHaveLength(2);
  expect(projected.deferrals?.[1]).toMatchObject({
    repo: "private/repo-name",
    reason: "local-edits",
    reasonLabel: "local edits",
    checkout: { kind: "branch", label: "secret branch" },
  });

  await writeStatus(projected);
  const verdict = readPromptStatus(root, NOW);
  expect(verdict).toMatchObject({ kind: "workspace", state: "synced" });

  await writeStatus({ deferredRepos: -1 as never });
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! dead");
  await writeStatus({ deferredRepos: 1, oldestDeferralAgeSeconds: -1 as never });
  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("! dead");
});

test("nested deferrals are capped, sanitized, item-local, and unknown-safe", async () => {
  const valid = {
    repo: " private\nrepo ", reason: "future-reason", reasonLabel: "forged", reasonText: "forged text",
    remediationClass: "forged", deferredSince: freshAt, reasonSince: freshAt,
    checkout: { kind: "branch", label: " topic\u0000name " }, extra: true,
  };
  await writeStatus({
    deferredRepos: 8,
    deferrals: [
      valid,
      { ...valid, repo: "" },
      { ...valid, repo: "bad-time", deferredSince: "today" },
      { ...valid, repo: "bad-checkout", checkout: { kind: "future" } },
      ...Array.from({ length: 6 }, (_, index) => ({ ...valid, repo: `repo-${index}` })),
    ],
  });
  const record = readAmbientDaemonStatusRecord(root);
  expect(record.kind).toBe("ok");
  if (record.kind !== "ok") return;
  expect(record.status.deferrals).toHaveLength(2);
  expect(record.status.deferrals?.[0]).toMatchObject({
    repo: "private repo",
    reason: "future-reason",
    reasonLabel: "unrecognized Git issue",
    reasonText: "Git sync is deferred for an unrecognized reason.",
    remediationClass: "apply-unavailable",
    checkout: { kind: "branch", label: "topic name" },
  });
});

test("ambient deferral timestamps require an explicit timezone", async () => {
  const valid = {
    repo: "repo", reason: "conflict", reasonLabel: "conflict", reasonText: "conflict",
    remediationClass: "apply-unavailable", deferredSince: freshAt, reasonSince: freshAt,
  };
  await writeStatus({
    deferredRepos: 3,
    deferrals: [
      valid,
      { ...valid, repo: "no-zone-deferred", deferredSince: "2026-07-08T11:59:59.000" },
      { ...valid, repo: "no-zone-reason", reasonSince: "2026-07-08T11:59:59.000" },
    ],
  });
  const record = readAmbientDaemonStatusRecord(root);
  expect(record.kind).toBe("ok");
  if (record.kind === "ok") expect(record.status.deferrals?.map(({ repo }) => repo)).toEqual(["repo"]);
});

test("future producer timestamps sort last and never become a fresh zero age", () => {
  const future = new Date(NOW + 60_000).toISOString();
  const projected = projectAmbientDaemonStatus({
    activity: { at: freshAt }, settled: true, now: NOW,
    repoRecords: {
      future: { repoGen: 1, sourceSeq: 1, deferrals: { apply: { lane: "apply", reason: "conflict", deferredSince: future, reasonSince: future, lastSeen: future } } },
    },
  });
  expect(projected.oldestDeferralAgeSeconds).toBeNull();
  expect(projected.deferrals?.[0]?.deferredSince).toBe(future);
});

test("ambient reader retains optional daemon identity fields and accepts older records without them", async () => {
  await writeStatus({ daemonVersion: "1.6.3", mode: "pull-only", bootId: "boot-mode" });
  expect(readPromptStatus(root, NOW)).toMatchObject({ kind: "workspace", state: "synced" });
  const record = readAmbientDaemonStatusRecord(root);
  expect(record).toMatchObject({ kind: "ok", status: { daemonVersion: "1.6.3", mode: "pull-only", bootId: "boot-mode" } });

  await writeStatus({ daemonVersion: undefined, mode: undefined, bootId: undefined });
  expect(readPromptStatus(root, NOW)).toMatchObject({ kind: "workspace", state: "synced" });
});

test("ambient reader rejects malformed daemonVersion records", async () => {
  await writeStatus({ daemonVersion: "1.6.3\nforged" });
  expect(readAmbientDaemonStatusRecord(root).kind).toBe("corrupt");
  await writeStatus({ daemonVersion: "" });
  expect(readAmbientDaemonStatusRecord(root).kind).toBe("corrupt");
});

test("ambient reader rejects malformed mode and boot witnesses", async () => {
  await writeStatus({ mode: "writer" as "read-write" });
  expect(readAmbientDaemonStatusRecord(root).kind).toBe("corrupt");
  await writeStatus({ mode: "read-write", bootId: "boot\nforged" });
  expect(readAmbientDaemonStatusRecord(root).kind).toBe("corrupt");
});
