import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPromptStatus, formatPromptStatus, AMBIENT_STATUS_HEARTBEAT_MS, AMBIENT_STATUS_STALE_MS } from "./ambient-status.js";
import { createPopulateStatusWriter, populateStatusPath, readFreshPopulateStatus, type PopulateStatusV1 } from "./populate-status.js";
import { syncStreamId, type WorkspaceConfig } from "./config.js";
import { daemonStatusPath } from "./rbox-paths.js";

const OLD_ENV = { ...process.env };
const NOW = Date.parse("2026-07-08T12:00:00Z");

let root = "";
let runtime = "";
let home = "";
let cfg: WorkspaceConfig;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-populate-root-"));
  runtime = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-populate-runtime-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-populate-home-"));
  process.env = { ...OLD_ENV, RBOX_HOME: runtime, HOME: home };
  cfg = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_populate",
    projectId: "root",
    deviceId: "dev_populate",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    encrypted: true,
  };
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify(cfg));
});

afterEach(async () => {
  process.env = { ...OLD_ENV };
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(runtime, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

function marker(over: Partial<PopulateStatusV1> = {}): PopulateStatusV1 {
  return {
    schemaVersion: 1,
    kind: "initial-populate",
    workspaceId: cfg.remoteWorkspaceId,
    projectId: cfg.projectId,
    stream: syncStreamId(cfg),
    pid: process.pid,
    startedAt: new Date(NOW - 1_000).toISOString(),
    heartbeatAt: new Date(NOW).toISOString(),
    operation: { kind: "pull", phase: "download", filesDone: 7, filesTotal: 10 },
    ...over,
  };
}

async function writeMarker(status: PopulateStatusV1): Promise<void> {
  await fs.mkdir(path.dirname(populateStatusPath(root)), { recursive: true });
  await fs.writeFile(populateStatusPath(root), `${JSON.stringify(status, null, 2)}\n`);
}

test("readFreshPopulateStatus accepts fresh same-stream live-pid markers", async () => {
  await writeMarker(marker());
  expect((await readFreshPopulateStatus(root, cfg, NOW))?.operation).toMatchObject({ phase: "download", filesDone: 7, filesTotal: 10 });
});

test("readFreshPopulateStatus ignores stale, dead-pid, and wrong-stream markers", async () => {
  await writeMarker(marker({ heartbeatAt: new Date(NOW - AMBIENT_STATUS_STALE_MS - 1).toISOString() }));
  expect(await readFreshPopulateStatus(root, cfg, NOW)).toBeUndefined();

  await writeMarker(marker({ pid: 999_999_999 }));
  expect(await readFreshPopulateStatus(root, cfg, NOW)).toBeUndefined();

  await writeMarker(marker({ stream: "https://api.test::ws_other::root" }));
  expect(await readFreshPopulateStatus(root, cfg, NOW)).toBeUndefined();
});

test("populate writer leaves daemon.status.json untouched beside a running daemon", async () => {
  await fs.mkdir(path.dirname(daemonStatusPath(root)), { recursive: true });
  const before = JSON.stringify({
    schemaVersion: 1,
    state: "synced",
    heartbeatAt: new Date(NOW).toISOString(),
    sequence: 42,
    lastSyncedAt: new Date(NOW).toISOString(),
  });
  await fs.writeFile(daemonStatusPath(root), before);

  let now = NOW;
  const writer = createPopulateStatusWriter(root, cfg, () => now);
  await writer.start();
  now += AMBIENT_STATUS_HEARTBEAT_MS;
  await writer.update(2, 6, "download");
  await writer.stop();

  expect(await fs.readFile(daemonStatusPath(root), "utf8")).toBe(before);
});

test("prompt-status merges fresh populate marker with no daemon status", async () => {
  let now = NOW;
  const writer = createPopulateStatusWriter(root, cfg, () => now);
  await writer.start();
  now += AMBIENT_STATUS_HEARTBEAT_MS;
  await writer.update(2, 6, "download");
  await expect(fs.stat(daemonStatusPath(root))).rejects.toThrow();

  const prompt = readPromptStatus(root, now);
  expect(formatPromptStatus(prompt)).toBe("↓4");
  expect(prompt.kind === "workspace" ? prompt.operation?.kind : undefined).toBe("pull");

  await writer.stop();
  expect(await readFreshPopulateStatus(root, cfg, now)).toBeUndefined();
});

test("prompt-status ignores stale populate markers", async () => {
  await writeMarker(marker({ heartbeatAt: new Date(NOW - AMBIENT_STATUS_STALE_MS - 1).toISOString() }));

  expect(formatPromptStatus(readPromptStatus(root, NOW))).toBe("○");
});
