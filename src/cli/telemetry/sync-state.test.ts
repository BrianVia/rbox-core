import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTelemetryBindingId, loadState, saveState, type SyncState } from "../config.js";
import { buildSyncStateSummary, SyncStateReporter } from "./sync-state.js";

const manifest = { generatedAt: "", files: [] };

test("summary uses repo projection and emits explicit null when no repo is deferred", () => {
  const clean: SyncState = { stream: "s", lastSyncedSequence: 7, lastSyncedManifest: manifest, repoRecords: {
    a: { repoGen: 0, sourceSeq: 7 }, b: { repoGen: 0, sourceSeq: 7 },
  }};
  expect(buildSyncStateSummary({ remoteWorkspaceId: "ws", projectId: "p" }, clean, "0011223344556677", 10_000)).toEqual({
    workspaceId: "ws", projectId: "p", bindingId: "0011223344556677", fileSeq: 7,
    reposTotal: 2, reposDeferred: 0, oldestDeferralAgeMs: null, deferralReasons: [],
  });
  const deferred: SyncState = { ...clean, repoRecords: { ...clean.repoRecords!, a: { repoGen: 0, sourceSeq: 7, deferrals: {
    apply: { lane: "apply", deferredSince: new Date(1_000).toISOString(), reasonSince: new Date(1_000).toISOString(), lastSeen: new Date(1_000).toISOString(), reason: "local-edits" },
    capture: { lane: "capture", deferredSince: new Date(2_000).toISOString(), reasonSince: new Date(2_000).toISOString(), lastSeen: new Date(2_000).toISOString(), reason: "git-busy" },
  }}}};
  const summary = buildSyncStateSummary({ remoteWorkspaceId: "ws", projectId: "p" }, deferred, "0011223344556677", 10_000);
  expect(summary.reposDeferred).toBe(1);
  expect(summary.oldestDeferralAgeMs).toBe(9_000);
  expect(summary.deferralReasons).toEqual(["git-busy", "local-edits"]);
});

test("binding id is generated once and persisted in local state.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-state-"));
  try {
    await saveState(root, { stream: "s", lastSyncedSequence: 0, lastSyncedManifest: manifest });
    const random = () => Buffer.from("0011223344556677", "hex");
    const first = await ensureTelemetryBindingId(root, "s", random);
    const second = await ensureTelemetryBindingId(root, "s", () => Buffer.from("ffffffffffffffff", "hex"));
    expect(first.bindingId).toBe("0011223344556677");
    expect(second.bindingId).toBe(first.bindingId);
    expect((await loadState(root, "s")).telemetryBindingId).toBe(first.bindingId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("reporter gates unchanged ticks despite advancing age and still sends a heartbeat", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-report-"));
  let now = 10_000;
  let calls = 0;
  try {
    const state: SyncState = { stream: "s", lastSyncedSequence: 1, lastSyncedManifest: manifest, repoRecords: {} };
    await saveState(root, state);
    const reporter = new SyncStateReporter(root, { remoteWorkspaceId: "ws", projectId: "p", remoteUrl: "http://x" }, {
      postJson: async () => { calls++; return new Response('{"accepted":1,"dropped":0}', { status: 202 }); },
    }, () => {}, () => now);
    reporter.afterSyncTick(state);
    await Bun.sleep(10);
    now += 5_000;
    reporter.afterSyncTick(state);
    await Bun.sleep(10);
    expect(calls).toBe(1);
    reporter.heartbeat(state);
    await Bun.sleep(10);
    expect(calls).toBe(2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("reporter kill switch performs no network call", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-off-"));
  let calls = 0;
  process.env.RBOX_TELEMETRY = "0";
  try {
    const state: SyncState = { stream: "s", lastSyncedSequence: 0, lastSyncedManifest: manifest };
    const reporter = new SyncStateReporter(root, { remoteWorkspaceId: "ws", projectId: "p", remoteUrl: "http://x" }, {
      postJson: async () => { calls++; return new Response(null, { status: 202 }); },
    });
    reporter.afterSyncTick(state);
    await Bun.sleep(10);
    expect(calls).toBe(0);
  } finally {
    delete process.env.RBOX_TELEMETRY;
    await fs.rm(root, { recursive: true, force: true });
  }
});
