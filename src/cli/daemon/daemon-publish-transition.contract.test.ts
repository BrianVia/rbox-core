import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { CaseFoldCollisionGroup, Manifest } from "../../engine/index.js";
import type { DaemonActivity } from "../activity.js";
import { loadMetrics, type SyncMetrics } from "../metrics.js";
import { CommitRejectedError } from "../remote.js";
import type { PushResult } from "../sync/push.js";
import type { TelemetrySample } from "../telemetry/contract.js";
import type { TelemetryRecorder } from "../telemetry/queue.js";
import type { PushProvenance } from "./daemon.js";
import {
  PublishLocalWorkspaceTransition,
  classifyPublishOutcome,
  sealPublishRequest,
  type DaemonPushOutcome,
  type PublishAttemptInputs,
  type PushTransitionPort,
  type SealedPublishRequest,
} from "./daemon-publish-transition.js";
import { LocalAuthority } from "./local-observation-transition.js";
import type { LocalRetryQueuePort } from "./local-workspace-observer.js";

const PROVENANCE: PushProvenance = { signal: false, candidate: false, scan: true, other: false };

function manifest(files: string[]): Manifest {
  return {
    generatedAt: "2026-07-26T00:00:00.000Z",
    files: files.map((filePath) => ({ path: filePath, size: 1, mtime: 0, hash: `h-${filePath}` })),
  } as Manifest;
}

function inputs(overrides: Partial<PublishAttemptInputs> = {}): PublishAttemptInputs {
  return {
    manifest: manifest(["a.txt", "b.txt"]),
    appliedBase: manifest(["a.txt"]),
    gcFencedPaths: new Set<string>(),
    observationComplete: true,
    caseCollisions: [],
    blockedFingerprint: undefined,
    ...overrides,
  };
}

function pushResult(overrides: Partial<PushResult> = {}): PushResult {
  return {
    sequence: 7,
    manifest: manifest(["a.txt", "b.txt"]),
    committed: true,
    caseCollisions: [],
    localFileObservationAuthority: "authoritative",
    ...overrides,
  };
}

class RecordingLocal extends LocalAuthority {
  constructor(private readonly calls: string[]) { super(); }

  override commitPatch(...args: Parameters<LocalAuthority["commitPatch"]>): void {
    this.calls.push("commit-local");
    super.commitPatch(...args);
  }
}

class RecordingRetries implements LocalRetryQueuePort {
  readonly deferredPaths = new Set<string>();
  readonly gcFencedPaths = new Set<string>();
  readonly writeFinish: string[][] = [];
  readonly gcFence: string[][] = [];
  constructor(private readonly calls: string[]) {}
  scheduleWriteFinish(paths: Set<string>): void {
    this.calls.push("schedule-write-finish");
    this.writeFinish.push([...paths]);
  }
  scheduleGcFence(paths: Set<string>): void {
    this.calls.push("schedule-gc-fence");
    this.gcFence.push([...paths]);
  }
  settle(): void {}
  stop(): void {}
}

class RecordingTelemetry implements TelemetryRecorder {
  readonly samples: TelemetrySample[] = [];
  constructor(private readonly calls: string[]) {}
  record(sample: TelemetrySample): void {
    this.calls.push("capture-telemetry");
    this.samples.push(sample);
  }
}

async function harness(options: {
  result?: (request: SealedPublishRequest) => DaemonPushOutcome;
  metrics?: SyncMetrics;
  failAt?: "refresh-durable" | "settle-report";
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-publish-transition-"));
  const calls: string[] = [];
  const local = new RecordingLocal(calls);
  local.seed(manifest(["a.txt", "old.txt"]));
  local.setObservationComplete(true);
  const retries = new RecordingRetries(calls);
  const activity: DaemonActivity = { at: "2026-07-26T00:00:00.000Z" };
  const metrics = options.metrics ?? { syncs: 0, commitConflicts409: 0, fileConflicts: 0, lockStarved: 0 };
  const telemetry = new RecordingTelemetry(calls);
  const logs: string[] = [];
  const requests: SealedPublishRequest[] = [];
  const observed = { durableRefreshed: false, reportEnqueued: false };
  const transition = new PublishLocalWorkspaceTransition({ root, local, retries, activity, metrics, telemetry }, {
    log: (line) => { calls.push("log"); logs.push(line); },
    refreshDurableState: async () => {
      calls.push("refresh-durable");
      if (options.failAt === "refresh-durable") throw new Error("injected durable refresh failure");
      observed.durableRefreshed = true;
    },
  });
  const port: PushTransitionPort = {
    appliedBase: manifest(["a.txt"]),
    execute: async (request) => {
      calls.push("execute");
      requests.push(request);
      return options.result?.(request)
        ?? { kind: "committed", attemptId: request.attemptId, result: pushResult() };
    },
    settleReport: () => {
      calls.push("settle-report");
      if (options.failAt === "settle-report") throw new Error("injected report enqueue failure");
      observed.reportEnqueued = true;
    },
  };
  return { root, calls, local, retries, activity, metrics, telemetry, logs, requests, observed, transition, port };
}

describe("publish request and outcome classification", () => {
  test("sealing preserves authoritative LOCAL and terminal identity", () => {
    const request = sealPublishRequest("attempt-1", inputs({ blockedFingerprint: "fp-1" }));
    expect(request.manifest.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(request.localFileObservation).toEqual({ authority: "authoritative" });
    expect(request.blockedFingerprint).toBe("fp-1");
  });

  test("GC-fenced paths carry BASE, while missing BASE cannot invent one", () => {
    const fenced = new Set(["b.txt"]);
    expect(sealPublishRequest("a", inputs({ gcFencedPaths: fenced })).manifest.files.map((file) => file.path))
      .toEqual(["a.txt"]);
    expect(sealPublishRequest("b", inputs({ gcFencedPaths: fenced, appliedBase: undefined })).manifest.files.map((file) => file.path))
      .toEqual(["a.txt", "b.txt"]);
  });

  test("incomplete observation carries collision evidence in preserve mode", () => {
    const collisions: CaseFoldCollisionGroup[] = [{ paths: ["A.txt", "a.txt"] }];
    expect(sealPublishRequest("a", inputs({ observationComplete: false, caseCollisions: collisions })).localFileObservation)
      .toEqual({ authority: "preserve", caseCollisions: collisions });
  });

  test("classification binds committed, no-op, and repeated terminal outcomes", async () => {
    const request = sealPublishRequest("attempt-9", inputs());
    expect((await classifyPublishOutcome(request, async () => pushResult())).kind).toBe("committed");
    expect((await classifyPublishOutcome(request, async () => pushResult({ committed: false }))).kind).toBe("not-committed");
    expect(await classifyPublishOutcome(request, async () => {
      throw new CommitRejectedError("too_many_refs", 1, 2, "fp-terminal", true);
    })).toEqual({ kind: "terminal-block", attemptId: "attempt-9", fingerprint: "fp-terminal" });
  });

  test("first terminal and unrelated failures propagate", async () => {
    const request = sealPublishRequest("attempt-9", inputs());
    await expect(classifyPublishOutcome(request, async () => {
      throw new CommitRejectedError("body_too_large", 1, 2, "fp", false);
    })).rejects.toThrow(CommitRejectedError);
    await expect(classifyPublishOutcome(request, async () => { throw new Error("network"); }))
      .rejects.toThrow("network");
  });
});

describe("PublishLocalWorkspaceTransition", () => {
  test("settles a commit through owned state and narrow ports", async () => {
    const h = await harness({ metrics: { syncs: 8, commitConflicts409: 3, fileConflicts: 2, lockStarved: 1, lastConflictAt: "then" } });
    const receipt = await h.transition.publish(PROVENANCE, h.port);
    expect(receipt).toMatchObject({ outcome: "committed", sequence: 7 });
    expect(h.local.manifest.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(h.transition.lastPublishedSequence).toBe(7);
    expect(h.activity.lastPush).toMatchObject({ files: 2, sequence: 7 });
    expect(h.transition.activityDirty).toBe(true);
    expect(h.telemetry.samples).toContainEqual({ kind: "git_capture", signalPushes: 0, candidatePushes: 0, scanPushes: 1 });
    expect(h.metrics).toEqual({ syncs: 9, commitConflicts409: 3, fileConflicts: 2, lockStarved: 1, lastConflictAt: "then" });
    expect(await loadMetrics(h.root)).toEqual(h.metrics);
    expect(h.calls).toEqual([
      "execute", "capture-telemetry", "commit-local", "log", "refresh-durable", "settle-report",
    ]);
  });

  test("a no-op adopts sequence and LOCAL without logging or activity", async () => {
    const h = await harness({ result: (request) => ({
      kind: "not-committed",
      attemptId: request.attemptId,
      result: pushResult({ committed: false, sequence: 4 }),
    }) });
    await h.transition.publish(PROVENANCE, h.port);
    expect(h.transition.lastPublishedSequence).toBe(4);
    expect(h.activity.lastPush).toBeUndefined();
    expect(h.logs).toEqual([]);
    expect(h.calls.at(-1)).toBe("settle-report");
  });

  test("deferred paths stay unsettled and partition into retry owners", async () => {
    const h = await harness({ result: (request) => ({
      kind: "committed",
      attemptId: request.attemptId,
      result: pushResult({ deferred: ["churn.txt", "fenced.bin"], retryLater: ["fenced.bin"] }),
    }) });
    await h.transition.publish(PROVENANCE, h.port);
    expect(h.local.unsettledPaths).toEqual(new Set(["churn.txt", "fenced.bin"]));
    expect(h.retries.writeFinish).toEqual([["churn.txt"]]);
    expect(h.retries.gcFence).toEqual([["fenced.bin"]]);
    expect(h.calls.indexOf("schedule-gc-fence")).toBeLessThan(h.calls.indexOf("refresh-durable"));
  });

  test("durable refresh failure leaves sequence, activity, and retries applied but stops metrics and report", async () => {
    const h = await harness({
      failAt: "refresh-durable",
      result: (request) => ({
        kind: "committed",
        attemptId: request.attemptId,
        result: pushResult({ deferred: ["churn.txt", "fenced.bin"], retryLater: ["fenced.bin"] }),
      }),
    });
    await expect(h.transition.publish(PROVENANCE, h.port)).rejects.toThrow("injected durable refresh failure");
    expect(h.transition.lastPublishedSequence).toBe(7);
    expect(h.activity.lastPush).toMatchObject({ files: 2, sequence: 7 });
    expect(h.transition.activityDirty).toBe(true);
    expect(h.local.unsettledPaths).toEqual(new Set(["churn.txt", "fenced.bin"]));
    expect(h.retries.writeFinish).toEqual([["churn.txt"]]);
    expect(h.retries.gcFence).toEqual([["fenced.bin"]]);
    expect(h.metrics.syncs).toBe(0);
    expect((await loadMetrics(h.root)).syncs).toBe(0);
    expect(h.observed).toEqual({ durableRefreshed: false, reportEnqueued: false });
  });

  test("report enqueue failure observes already-refreshed durable state and persisted metrics", async () => {
    const h = await harness({ failAt: "settle-report" });
    await expect(h.transition.publish(PROVENANCE, h.port)).rejects.toThrow("injected report enqueue failure");
    expect(h.observed).toEqual({ durableRefreshed: true, reportEnqueued: false });
    expect(h.metrics.syncs).toBe(1);
    expect((await loadMetrics(h.root)).syncs).toBe(1);
  });

  test("collision observations are copied and completeness follows authority", async () => {
    const groups: CaseFoldCollisionGroup[] = [{ paths: ["A", "a"] }];
    const h = await harness({ result: (request) => ({
      kind: "committed",
      attemptId: request.attemptId,
      result: pushResult({ caseCollisions: groups }),
    }) });
    await h.transition.publish(PROVENANCE, h.port);
    expect(h.transition.activeCaseCollisions).toEqual(groups);
    expect(h.transition.activeCaseCollisions[0]).not.toBe(groups[0]);
    expect(h.local.observationComplete).toBe(false);
    h.transition.adoptCollisionObservation([], true);
    expect(h.local.observationComplete).toBe(true);
  });

  test("duplicate sequences stay silent and deferral samples remain bounded", async () => {
    const h = await harness({ result: (request) => ({
      kind: "committed",
      attemptId: request.attemptId,
      result: pushResult({ sequence: 12, deferred: Array.from({ length: 60 }, (_, index) => `f${index}.txt`) }),
    }) });
    h.transition.adoptPublishedSequence(11);
    await h.transition.publish(PROVENANCE, h.port);
    expect(h.logs[0]).toContain("deferred 60:");
    expect(h.logs[0]).toContain("f49.txt");
    expect(h.logs[0]).not.toContain("f50.txt");
    await h.transition.publish(PROVENANCE, h.port);
    expect(h.logs).toHaveLength(1);
  });

  test("terminal repeat owns the halt episode and refreshes nothing else", async () => {
    const h = await harness({ result: (request) => ({
      kind: "terminal-block",
      attemptId: request.attemptId,
      fingerprint: "fp-2",
    }) });
    h.activity.halt = { at: "now", reason: "too many refs", count: 1, op: "push", terminal: { fingerprint: "fp-2" } };
    const receipt = await h.transition.publish(PROVENANCE, h.port);
    expect(receipt).toEqual({ attemptId: h.requests[0]!.attemptId, outcome: "terminal-block" });
    expect(h.transition.isTerminalBlocked).toBe(true);
    expect(h.calls).toEqual(["execute", "log", "refresh-durable"]);
    expect(h.metrics.syncs).toBe(0);
  });

  test("mismatched identity performs no transition", async () => {
    const h = await harness({ result: () => ({ kind: "committed", attemptId: "someone-else", result: pushResult() }) });
    await expect(h.transition.publish(PROVENANCE, h.port)).rejects.toThrow(/attempt/);
    expect(h.calls).toEqual(["execute"]);
    expect(h.transition.lastPublishedSequence).toBeUndefined();
    expect(h.activity.lastPush).toBeUndefined();
  });

  test("attempt identities advance and activity dirtiness is explicitly acknowledged", async () => {
    const h = await harness();
    await h.transition.publish(PROVENANCE, h.port);
    h.transition.acknowledgeActivityWrite();
    expect(h.transition.activityDirty).toBe(false);
    await h.transition.publish(PROVENANCE, h.port);
    expect(h.requests[0]!.attemptId).not.toBe(h.requests[1]!.attemptId);
  });
});
