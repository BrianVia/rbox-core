import { describe, expect, test } from "bun:test";
import type { CaseFoldCollisionGroup, Manifest } from "../../engine/index.js";
import { CommitRejectedError } from "../remote.js";
import type { PushResult } from "../sync/push.js";
import {
  PublishLocalWorkspaceTransition,
  classifyPublishOutcome,
  reduceDaemonPublishOutcome,
  sealPublishRequest,
  type DaemonPublishEffect,
  type DaemonPublishEffects,
  type DaemonPushOutcome,
  type PublishAttemptInputs,
  type PushTransitionPort,
  type SealedPublishRequest,
} from "./daemon-publish-transition.js";
import type { PushProvenance } from "./daemon.js";

const PROVENANCE: PushProvenance = { signal: false, candidate: false, scan: true, other: false };

function manifest(files: string[], generatedAt = "2026-07-26T00:00:00.000Z"): Manifest {
  return { generatedAt, files: files.map((path) => ({ path, size: 1, mtime: 0, hash: `h-${path}` })) } as Manifest;
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

class RecordingEffects implements DaemonPublishEffects, PushTransitionPort {
  readonly calls: string[] = [];
  requests: SealedPublishRequest[] = [];
  outcomeFor: (request: SealedPublishRequest) => Promise<DaemonPushOutcome> = async (request) =>
    ({ kind: "committed", attemptId: request.attemptId, result: pushResult() });
  lastSequence: number | undefined = undefined;
  attemptInputs: PublishAttemptInputs = inputs();

  constructor(overrides: Partial<RecordingEffects> = {}) {
    Object.assign(this, overrides);
  }

  sealAttemptInputs(): PublishAttemptInputs { this.calls.push("seal-inputs"); return this.attemptInputs; }
  lastPublishedSequence(): number | undefined { return this.lastSequence; }
  async execute(request: SealedPublishRequest): Promise<DaemonPushOutcome> {
    this.requests.push(request);
    this.calls.push("execute");
    return this.outcomeFor(request);
  }
  settleReport(): void { this.calls.push("settle-report"); }
  noteTerminalBlock(fingerprint: string | undefined): void { this.calls.push(`terminal-block:${fingerprint}`); }
  recordGitCaptureSuccess(provenance: PushProvenance): void { this.calls.push(`capture-success:${provenance.scan}`); }
  commitPublishedSubset(next: Manifest, deferred: readonly string[]): void {
    this.calls.push(`commit-subset:${next.files.length}:${deferred.join(",")}`);
  }
  adoptCollisionObservation(groups: readonly CaseFoldCollisionGroup[], complete: boolean): void {
    this.calls.push(`collisions:${groups.length}:${complete}`);
  }
  log(line: string): void { this.calls.push(`log:${line}`); }
  notePublishedSequence(sequence: number): void { this.calls.push(`seq:${sequence}`); }
  recordPublishActivity(files: number, sequence: number): void { this.calls.push(`activity:${files}:${sequence}`); }
  scheduleWriteFinish(paths: readonly string[]): void { this.calls.push(`write-finish:${paths.join(",")}`); }
  scheduleGcFence(paths: readonly string[]): void { this.calls.push(`gc-fence:${paths.join(",")}`); }
  async refreshDurableState(): Promise<void> { this.calls.push("refresh-durable"); }
  async recordSyncMetric(): Promise<void> { this.calls.push("sync-metric"); }
}

const kinds = (effects: readonly DaemonPublishEffect[]): string[] => effects.map((effect) => effect.kind);

describe("sealPublishRequest", () => {
  test("carries the local manifest verbatim when no path is GC-fenced", () => {
    const request = sealPublishRequest("attempt-1", inputs());
    expect(request.attemptId).toBe("attempt-1");
    expect(request.manifest.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(request.localFileObservation).toEqual({ authority: "authoritative" });
    expect(request.blockedFingerprint).toBeUndefined();
  });

  test("defers GC-fenced paths onto the applied base", () => {
    const request = sealPublishRequest("attempt-1", inputs({ gcFencedPaths: new Set(["b.txt"]) }));
    expect(request.manifest.files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  test("without an applied base a GC fence cannot defer anything", () => {
    const request = sealPublishRequest("attempt-1", inputs({ appliedBase: undefined, gcFencedPaths: new Set(["b.txt"]) }));
    expect(request.manifest.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
  });

  test("an incomplete observation publishes in preserve mode carrying its collisions", () => {
    const collisions: CaseFoldCollisionGroup[] = [{ paths: ["A.txt", "a.txt"] }];
    const request = sealPublishRequest("attempt-1", inputs({ observationComplete: false, caseCollisions: collisions }));
    expect(request.localFileObservation).toEqual({ authority: "preserve", caseCollisions: collisions });
  });

  test("the terminal fingerprint is carried into the request", () => {
    const request = sealPublishRequest("attempt-1", inputs({ blockedFingerprint: "fp-1" }));
    expect(request.blockedFingerprint).toBe("fp-1");
  });
});

describe("classifyPublishOutcome", () => {
  const request = sealPublishRequest("attempt-9", inputs());

  test("a sequence-advancing result is committed", async () => {
    const outcome = await classifyPublishOutcome(request, async () => pushResult({ committed: true }));
    expect(outcome.kind).toBe("committed");
    expect(outcome.attemptId).toBe("attempt-9");
  });

  test("a no-op result is not-committed", async () => {
    const outcome = await classifyPublishOutcome(request, async () => pushResult({ committed: false }));
    expect(outcome.kind).toBe("not-committed");
  });

  test("a still-blocked commit rejection is a terminal block carrying its fingerprint", async () => {
    const outcome = await classifyPublishOutcome(request, async () => {
      throw new CommitRejectedError("too_many_refs", 1, 2, "fp-terminal", true);
    });
    expect(outcome).toEqual({ kind: "terminal-block", attemptId: "attempt-9", fingerprint: "fp-terminal" });
  });

  test("a commit rejection that is NOT still blocked propagates", async () => {
    await expect(classifyPublishOutcome(request, async () => {
      throw new CommitRejectedError("body_too_large", 1, 2, "fp", false);
    })).rejects.toThrow(CommitRejectedError);
  });

  test("any other failure propagates unclassified", async () => {
    await expect(classifyPublishOutcome(request, async () => { throw new Error("network"); }))
      .rejects.toThrow("network");
  });
});

describe("reduceDaemonPublishOutcome", () => {
  const attemptId = "attempt-1";

  test("a terminal block adopts the durable nonce and does nothing else", () => {
    const effects = reduceDaemonPublishOutcome(
      { kind: "terminal-block", attemptId, fingerprint: "fp-1" },
      { lastPublishedSequence: 3 },
    );
    expect(kinds(effects)).toEqual(["terminal-block", "refresh-durable-state"]);
    expect(kinds(effects)).not.toContain("settle-report");
  });

  test("a committed publication orders capture, subset, collisions, log, sequence, activity, durable, metric", () => {
    const effects = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult({ sequence: 7 }) },
      { lastPublishedSequence: 6 },
    );
    expect(kinds(effects)).toEqual([
      "record-git-capture-success",
      "commit-published-subset",
      "adopt-collision-observation",
      "log",
      "note-published-sequence",
      "record-publish-activity",
      "refresh-durable-state",
      "record-sync-metric",
      "settle-report",
    ]);
  });

  test("a repeated sequence is not logged again but is still noted", () => {
    const effects = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult({ sequence: 7 }) },
      { lastPublishedSequence: 7 },
    );
    expect(kinds(effects)).not.toContain("log");
    expect(effects).toContainEqual({ kind: "note-published-sequence", sequence: 7 });
  });

  test("a no-op push logs nothing and records no publish activity", () => {
    const effects = reduceDaemonPublishOutcome(
      { kind: "not-committed", attemptId, result: pushResult({ committed: false, sequence: 4 }) },
      { lastPublishedSequence: 3 },
    );
    expect(kinds(effects)).toEqual([
      "record-git-capture-success",
      "commit-published-subset",
      "adopt-collision-observation",
      "note-published-sequence",
      "refresh-durable-state",
      "record-sync-metric",
      "settle-report",
    ]);
  });

  test("the committed subset carries the deferred paths as unsettled", () => {
    const effects = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult({ deferred: ["x.bin"] }) },
      { lastPublishedSequence: undefined },
    );
    expect(effects).toContainEqual({
      kind: "commit-published-subset",
      manifest: expect.anything(),
      deferred: ["x.bin"],
    });
  });

  test("deferred paths split into write-finish and GC-fence retries", () => {
    const effects = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult({ deferred: ["churn.txt", "fenced.bin"], retryLater: ["fenced.bin"] }) },
      { lastPublishedSequence: undefined },
    );
    expect(effects).toContainEqual({ kind: "schedule-write-finish", paths: ["churn.txt"] });
    expect(effects).toContainEqual({ kind: "schedule-gc-fence", paths: ["fenced.bin"] });
    const order = kinds(effects);
    expect(order.indexOf("schedule-write-finish")).toBeLessThan(order.indexOf("schedule-gc-fence"));
    expect(order.indexOf("schedule-gc-fence")).toBeLessThan(order.indexOf("refresh-durable-state"));
  });

  test("no deferrals schedules no retry at all", () => {
    const effects = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult({ deferred: [] }) },
      { lastPublishedSequence: undefined },
    );
    expect(kinds(effects)).not.toContain("schedule-write-finish");
    expect(kinds(effects)).not.toContain("schedule-gc-fence");
  });

  test("collision authority downgrades completeness; a clean authoritative push restores it", () => {
    const preserved = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult({ localFileObservationAuthority: "preserve" }) },
      { lastPublishedSequence: undefined },
    );
    expect(preserved).toContainEqual({ kind: "adopt-collision-observation", groups: [], observationComplete: false });

    const collided = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult({ caseCollisions: [{ paths: ["A", "a"] }] }) },
      { lastPublishedSequence: undefined },
    );
    expect(collided).toContainEqual({
      kind: "adopt-collision-observation",
      groups: [{ paths: ["A", "a"] }],
      observationComplete: false,
    });

    const clean = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult() },
      { lastPublishedSequence: undefined },
    );
    expect(clean).toContainEqual({ kind: "adopt-collision-observation", groups: [], observationComplete: true });
  });

  test("adopted collision groups are copies, not the push result's arrays", () => {
    const groups: CaseFoldCollisionGroup[] = [{ paths: ["A", "a"] }];
    const effects = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult({ caseCollisions: groups }) },
      { lastPublishedSequence: undefined },
    );
    const adopted = effects.find((effect) => effect.kind === "adopt-collision-observation");
    expect(adopted).toBeDefined();
    const adoptedGroups = (adopted as { groups: CaseFoldCollisionGroup[] }).groups;
    expect(adoptedGroups[0]).not.toBe(groups[0]);
    expect(adoptedGroups[0]!.paths).not.toBe(groups[0]!.paths);
  });

  test("the publication log names the sequence, file count, and bounded deferral sample", () => {
    const effects = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult({ sequence: 12, deferred: ["one.txt", "two.txt"] }) },
      { lastPublishedSequence: 11 },
    );
    const line = effects.find((effect) => effect.kind === "log");
    expect(line).toEqual({ kind: "log", line: "push: published sequence 12 (2 files; deferred 2: one.txt two.txt)" });
  });

  test("a deferral sample never renders more than the log path cap", () => {
    const deferred = Array.from({ length: 60 }, (_, i) => `f${i}.txt`);
    const effects = reduceDaemonPublishOutcome(
      { kind: "committed", attemptId, result: pushResult({ sequence: 12, deferred }) },
      { lastPublishedSequence: 11 },
    );
    const line = effects.find((effect) => effect.kind === "log") as { line: string };
    expect(line.line).toContain("deferred 60: ");
    expect(line.line).toContain("f49.txt");
    expect(line.line).not.toContain("f50.txt");
  });
});

describe("PublishLocalWorkspaceTransition", () => {
  test("seals inputs, executes once, and applies the reduced effects in order", async () => {
    const effects = new RecordingEffects({ lastSequence: 6 });
    const transition = new PublishLocalWorkspaceTransition(effects);
    const receipt = await transition.publish(PROVENANCE, effects);
    expect(effects.calls).toEqual([
      "seal-inputs",
      "execute",
      "capture-success:true",
      "commit-subset:2:",
      "collisions:0:true",
      "log:push: published sequence 7 (2 files)",
      "seq:7",
      "activity:2:7",
      "refresh-durable",
      "sync-metric",
      "settle-report",
    ]);
    expect(receipt.outcome).toBe("committed");
    expect(receipt.sequence).toBe(7);
    expect(receipt.attemptId).toBe(effects.requests[0]!.attemptId);
  });

  test("provenance is consumed exactly once per publication", async () => {
    const effects = new RecordingEffects();
    const transition = new PublishLocalWorkspaceTransition(effects);
    await transition.publish(PROVENANCE, effects);
    await transition.publish(PROVENANCE, effects);
    expect(effects.calls.filter((call) => call.startsWith("capture-success"))).toHaveLength(2);
  });

  test("each attempt is sealed under a fresh identity", async () => {
    const effects = new RecordingEffects();
    const transition = new PublishLocalWorkspaceTransition(effects);
    await transition.publish(PROVENANCE, effects);
    await transition.publish(PROVENANCE, effects);
    expect(effects.requests[0]!.attemptId).not.toBe(effects.requests[1]!.attemptId);
  });

  test("a terminal block adopts the durable nonce and records no capture success", async () => {
    const effects = new RecordingEffects({
      outcomeFor: async (request) => ({ kind: "terminal-block", attemptId: request.attemptId, fingerprint: "fp-2" }),
    });
    const transition = new PublishLocalWorkspaceTransition(effects);
    const receipt = await transition.publish(PROVENANCE, effects);
    expect(effects.calls).toEqual(["seal-inputs", "execute", "terminal-block:fp-2", "refresh-durable"]);
    expect(effects.calls).not.toContain("settle-report");
    expect(receipt.outcome).toBe("terminal-block");
    expect(receipt.sequence).toBeUndefined();
  });

  test("an outcome bound to another attempt performs NO transition", async () => {
    const effects = new RecordingEffects({
      outcomeFor: async () => ({ kind: "committed", attemptId: "someone-else", result: pushResult() }),
    });
    const transition = new PublishLocalWorkspaceTransition(effects);
    await expect(transition.publish(PROVENANCE, effects)).rejects.toThrow(/attempt/);
    expect(effects.calls).toEqual(["seal-inputs", "execute"]);
  });

  test("a busy-retry deferral schedule survives the reduction", async () => {
    const effects = new RecordingEffects({
      outcomeFor: async (request) => ({
        kind: "committed",
        attemptId: request.attemptId,
        result: pushResult({ deferred: ["a", "b"], retryLater: ["b"] }),
      }),
    });
    const transition = new PublishLocalWorkspaceTransition(effects);
    await transition.publish(PROVENANCE, effects);
    expect(effects.calls).toContain("write-finish:a");
    expect(effects.calls).toContain("gc-fence:b");
    expect(effects.calls.indexOf("write-finish:a")).toBeLessThan(effects.calls.indexOf("refresh-durable"));
  });
});
