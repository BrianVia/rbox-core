import { describe, expect, test } from "bun:test";
import type { FileEntry, Manifest } from "../../engine/index.js";
import type { GitResolutionPublicationReceipt } from "../config.js";
import type { CommitOptions, CommitResult, CommitTimings } from "../remote.js";
import {
  executeManifestCommit,
  type KeepMineReconciliation,
  type ManifestCommitEffectPlan,
  type ManifestCommitPort,
} from "./manifest-commit-executor.js";
import type { PublicationIdentity } from "./publish-candidate.js";

const IDENTITY: PublicationIdentity = {
  acceptedSequence: 7,
  capturePlanId: "capture-42",
  observedSequence: 7,
};

function entry(path: string): FileEntry {
  return { path, sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 0, type: "file" };
}

const CANDIDATE: Manifest = { generatedAt: "2026-07-26T12:00:00.000Z", files: [entry("a.txt")] };

const ARM: GitResolutionPublicationReceipt = {
  repo: "repo",
  attemptedGitIncomingKey: "incoming-key",
  attemptedSequence: 8,
  confirmedReportHash: "report-hash",
};

function plan(overrides: Partial<ManifestCommitEffectPlan> = {}): ManifestCommitEffectPlan {
  return {
    identity: IDENTITY,
    manifest: CANDIDATE,
    parentSequence: 7,
    forceSnapshot: false,
    reportTimings: false,
    resolutionRider: false,
    ...overrides,
  };
}

interface Harness {
  port: ManifestCommitPort;
  /** Every port effect, in the exact order the executor caused it. */
  effects: string[];
  posted: { parentSequence: number; manifest: Manifest; options?: CommitOptions }[];
  disarmed: GitResolutionPublicationReceipt[];
  armedAt: GitResolutionPublicationReceipt[];
  timings: CommitTimings[];
}

function harness(options: {
  result?: CommitResult;
  commitError?: Error;
  emitTimings?: CommitTimings;
  reconciliation?: KeepMineReconciliation;
  reconcileError?: Error;
  postPull?: { sequence: number; manifest: Manifest };
  pullError?: Error;
} = {}): Harness {
  const effects: string[] = [];
  const posted: Harness["posted"] = [];
  const disarmed: GitResolutionPublicationReceipt[] = [];
  const armedAt: GitResolutionPublicationReceipt[] = [];
  const timings: CommitTimings[] = [];
  const port: ManifestCommitPort = {
    async armKeepMine(receipt) {
      effects.push("arm");
      armedAt.push(receipt);
    },
    async commit(request) {
      effects.push("commit-enter");
      // The transport awaits the arm at its own last boundary before the POST.
      await request.options?.beforeCommitSend?.();
      posted.push(request);
      effects.push("commit-post");
      if (options.commitError) throw options.commitError;
      if (options.emitTimings) request.options?.onCommitTimings?.(options.emitTimings);
      return options.result ?? { sequence: 8 };
    },
    reportCommitTimings(value) {
      effects.push("report-timings");
      timings.push(value);
    },
    async disarmKeepMine(receipt) {
      effects.push("disarm");
      disarmed.push(receipt);
    },
    notifyConflict() {
      effects.push("notify-conflict");
    },
    async reconcileKeepMine() {
      effects.push("reconcile");
      if (options.reconcileError) throw options.reconcileError;
      return options.reconciliation ?? { status: "none" };
    },
    async pullAndLoadAccepted() {
      effects.push("pull");
      if (options.pullError) throw options.pullError;
      return options.postPull ?? { sequence: 9, manifest: CANDIDATE };
    },
  };
  return { port, effects, posted, disarmed, armedAt, timings };
}

describe("executeManifestCommit: plan materialization", () => {
  test("posts the plan's exact manifest and parent sequence", async () => {
    const h = harness();
    await executeManifestCommit(plan(), h.port);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.manifest).toBe(CANDIDATE);
    expect(h.posted[0]!.parentSequence).toBe(7);
  });

  test("a plan that requests no wire option POSTs no options object", async () => {
    const h = harness();
    await executeManifestCommit(plan(), h.port);
    expect(h.posted[0]!.options).toBeUndefined();
  });

  test("wire options are exactly the plan's decisions — the executor chooses none", async () => {
    const base = { manifest: CANDIDATE, meta: { encManifestSha: "enc", manifestHash: "hash" } as never };
    const h = harness();
    await executeManifestCommit(
      plan({ blockedFingerprint: "fp", deltaBase: base, forceSnapshot: true, reportTimings: true }),
      h.port,
    );
    const options = h.posted[0]!.options!;
    expect(options.blockedFingerprint).toBe("fp");
    expect(options.deltaBase).toBe(base);
    expect(options.forceSnapshot).toBe(true);
    expect(options.deltaBaseRejection).toBeUndefined();
    expect(typeof options.onCommitTimings).toBe("function");
  });

  test("a withheld delta base carries its rejection cause to the writer", async () => {
    const h = harness();
    await executeManifestCommit(plan({ deltaBaseRejection: "integrity" }), h.port);
    expect(h.posted[0]!.options!.deltaBaseRejection).toBe("integrity");
    expect(h.posted[0]!.options!.deltaBase).toBeUndefined();
    expect(h.posted[0]!.options!.forceSnapshot).toBeUndefined();
  });

  test("commit timings are reported after the POST, only when the plan asked", async () => {
    const emitTimings = { refreshMs: 1, sidecarMs: 2, encodeMs: 3, encryptMs: 4, uploadMs: 5, postMs: 6, encBytes: 7 };
    const on = harness({ emitTimings });
    await executeManifestCommit(plan({ reportTimings: true }), on.port);
    expect(on.effects).toEqual(["commit-enter", "commit-post", "report-timings"]);
    expect(on.timings).toEqual([emitTimings]);

    const off = harness({ emitTimings });
    await executeManifestCommit(plan(), off.port);
    expect(off.effects).toEqual(["commit-enter", "commit-post"]);
  });
});

describe("executeManifestCommit: response classification", () => {
  test("an accepted commit yields one accepted receipt bound to the plan identity", async () => {
    const h = harness({ result: { sequence: 8, manifestMeta: { encManifestSha: "e", manifestHash: "m" } as never } });
    const receipt = await executeManifestCommit(plan(), h.port);
    expect(receipt.kind).toBe("accepted");
    expect(receipt.identity).toBe(IDENTITY);
    if (receipt.kind !== "accepted") throw new Error("unreachable");
    expect(receipt.sequence).toBe(8);
    expect(receipt.manifestMeta).toEqual({ encManifestSha: "e", manifestHash: "m" } as never);
    expect(receipt.armed).toBeUndefined();
  });

  test("a stale epoch yields epoch-stale", async () => {
    const h = harness({ result: { epochStale: 3 } });
    const receipt = await executeManifestCommit(plan(), h.port);
    expect(receipt.kind).toBe("epoch-stale");
    expect(receipt.identity).toBe(IDENTITY);
  });

  test("a parent conflict without a keep-mine rider yields conflict and tallies pressure", async () => {
    const h = harness({ result: { conflict: true, head: 9 } });
    const receipt = await executeManifestCommit(plan(), h.port);
    expect(receipt.kind).toBe("conflict");
    expect(receipt.identity).toBe(IDENTITY);
    expect(h.effects).toEqual(["commit-enter", "commit-post", "notify-conflict"]);
  });

  test("unsatisfied blobs yield the exact bounce payload", async () => {
    const h = harness({
      result: { unsatisfiedBlobs: ["b1", "b2"], unsatisfiedTotal: 5, attemptedManifestChain: ["c1"] },
    });
    const receipt = await executeManifestCommit(plan(), h.port);
    if (receipt.kind !== "unsatisfied") throw new Error(`expected unsatisfied, got ${receipt.kind}`);
    expect(receipt.identity).toBe(IDENTITY);
    expect(receipt.unsatisfiedBlobs).toEqual(["b1", "b2"]);
    expect(receipt.unsatisfiedTotal).toBe(5);
    expect(receipt.attemptedManifestChain).toEqual(["c1"]);
  });

  test("a conflict is classified before an unsatisfied-blob list on the same response", async () => {
    const h = harness({ result: { conflict: true, unsatisfiedBlobs: ["b1"] } });
    expect((await executeManifestCommit(plan(), h.port)).kind).toBe("conflict");
  });

  test("an epoch rotation is classified before a conflict on the same response", async () => {
    const h = harness({ result: { epochStale: 2, conflict: true } });
    expect((await executeManifestCommit(plan(), h.port)).kind).toBe("epoch-stale");
  });
});

describe("executeManifestCommit: keep-mine authority", () => {
  test("the durable arm is immediately followed by the POST — nothing in between", async () => {
    const h = harness();
    const receipt = await executeManifestCommit(plan({ keepMineArm: ARM, resolutionRider: true }), h.port);
    expect(h.effects).toEqual(["commit-enter", "arm", "commit-post"]);
    expect(h.armedAt).toEqual([ARM]);
    if (receipt.kind !== "accepted") throw new Error(`expected accepted, got ${receipt.kind}`);
    expect(receipt.armed).toBe(ARM);
  });

  test("a lost POST acknowledgement under an armed receipt is ack-uncertain, not a throw", async () => {
    const h = harness({ commitError: new Error("socket hang up") });
    const receipt = await executeManifestCommit(plan({ keepMineArm: ARM, resolutionRider: true }), h.port);
    if (receipt.kind !== "ack-uncertain") throw new Error(`expected ack-uncertain, got ${receipt.kind}`);
    expect(receipt.identity).toBe(IDENTITY);
    expect(receipt.reason).toContain("acknowledgement was lost");
    expect(h.effects).toEqual(["commit-enter", "arm", "commit-post"]);
  });

  test("a POST failure with no armed authority propagates unchanged", async () => {
    const boom = new Error("socket hang up");
    const h = harness({ commitError: boom });
    await expect(executeManifestCommit(plan(), h.port)).rejects.toThrow(boom);
  });

  test("epoch staleness disarms and reloads the armed receipt", async () => {
    const h = harness({ result: { epochStale: 3 } });
    await executeManifestCommit(plan({ keepMineArm: ARM, resolutionRider: true }), h.port);
    expect(h.effects).toEqual(["commit-enter", "arm", "commit-post", "disarm"]);
    expect(h.disarmed).toEqual([ARM]);
  });

  test("an unsatisfied bounce disarms and reloads the armed receipt", async () => {
    const h = harness({ result: { unsatisfiedBlobs: ["b1"] } });
    await executeManifestCommit(plan({ keepMineArm: ARM, resolutionRider: true }), h.port);
    expect(h.effects).toEqual(["commit-enter", "arm", "commit-post", "disarm"]);
    expect(h.disarmed).toEqual([ARM]);
  });

  test("an unarmed epoch/unsatisfied response disarms nothing", async () => {
    const epoch = harness({ result: { epochStale: 1 } });
    await executeManifestCommit(plan(), epoch.port);
    expect(epoch.effects).not.toContain("disarm");
    const bounce = harness({ result: { unsatisfiedBlobs: ["b"] } });
    await executeManifestCommit(plan(), bounce.port);
    expect(bounce.effects).not.toContain("disarm");
  });
});

describe("executeManifestCommit: resolution transition", () => {
  const REMOTE = { generatedAt: "2026-07-26T13:00:00.000Z", files: [entry("remote.txt")] };

  test("an armed 409 reconciles the lost ACK as an exact publication", async () => {
    const h = harness({
      result: { conflict: true },
      reconciliation: { status: "exact", sequence: 11, manifest: REMOTE },
    });
    const receipt = await executeManifestCommit(plan({ keepMineArm: ARM, resolutionRider: true }), h.port);
    if (receipt.kind !== "resolution-transition") throw new Error(`expected resolution-transition, got ${receipt.kind}`);
    expect(receipt.identity).toBe(IDENTITY);
    expect(receipt.transition).toEqual({ kind: "published", sequence: 11, manifest: REMOTE });
    expect(h.effects).toEqual(["commit-enter", "arm", "commit-post", "notify-conflict", "reconcile"]);
  });

  test("an armed 409 whose reconciliation mismatches reports remote movement without pulling", async () => {
    const h = harness({
      result: { conflict: true },
      reconciliation: { status: "mismatch", sequence: 12, manifest: REMOTE },
    });
    const receipt = await executeManifestCommit(plan({ keepMineArm: ARM, resolutionRider: true }), h.port);
    if (receipt.kind !== "resolution-transition") throw new Error(`expected resolution-transition, got ${receipt.kind}`);
    expect(receipt.transition).toEqual({
      kind: "remote-moved",
      sequence: 12,
      manifest: REMOTE,
      reason: "another machine published while confirming",
    });
    expect(h.effects).not.toContain("pull");
  });

  test("an armed 409 with nothing to reconcile falls through to the conflict pull", async () => {
    const h = harness({
      result: { conflict: true },
      reconciliation: { status: "none" },
      postPull: { sequence: 13, manifest: REMOTE },
    });
    const receipt = await executeManifestCommit(plan({ keepMineArm: ARM, resolutionRider: true }), h.port);
    if (receipt.kind !== "resolution-transition") throw new Error(`expected resolution-transition, got ${receipt.kind}`);
    expect(receipt.transition).toEqual({
      kind: "remote-moved",
      sequence: 13,
      manifest: REMOTE,
      reason: "another machine published while confirming",
    });
    expect(h.effects).toEqual(["commit-enter", "arm", "commit-post", "notify-conflict", "reconcile", "pull"]);
  });

  test("a rider 409 that never armed pulls directly — there is no ACK to reconcile", async () => {
    const h = harness({ result: { conflict: true }, postPull: { sequence: 14, manifest: REMOTE } });
    const receipt = await executeManifestCommit(plan({ resolutionRider: true }), h.port);
    if (receipt.kind !== "resolution-transition") throw new Error(`expected resolution-transition, got ${receipt.kind}`);
    expect(receipt.transition).toMatchObject({ kind: "remote-moved", sequence: 14 });
    expect(h.effects).toEqual(["commit-enter", "commit-post", "notify-conflict", "pull"]);
  });

  test("an unauthenticated reconciliation is ack-uncertain, never a silent abort", async () => {
    const h = harness({ result: { conflict: true }, reconcileError: new Error("bad signature") });
    const receipt = await executeManifestCommit(plan({ keepMineArm: ARM, resolutionRider: true }), h.port);
    if (receipt.kind !== "resolution-transition") throw new Error(`expected resolution-transition, got ${receipt.kind}`);
    expect(receipt.transition).toEqual({
      kind: "authentication-failed",
      reason: "remote truth could not be authenticated; run rbox push or rbox pull to reconcile",
    });
  });

  test("a failed conflict pull is ack-uncertain too", async () => {
    const h = harness({ result: { conflict: true }, pullError: new Error("offline") });
    const receipt = await executeManifestCommit(plan({ resolutionRider: true }), h.port);
    if (receipt.kind !== "resolution-transition") throw new Error(`expected resolution-transition, got ${receipt.kind}`);
    expect(receipt.transition).toMatchObject({ kind: "authentication-failed" });
  });
});

describe("executeManifestCommit: BASE authority", () => {
  test("an accepted commit performs no durable effect beyond the POST", async () => {
    const h = harness();
    await executeManifestCommit(plan({ keepMineArm: ARM, resolutionRider: true }), h.port);
    // Arming is publication authority, not BASE: no reconcile, pull, or disarm
    // follows an accepted POST, and advancing BASE is not a member of the port.
    expect(h.effects).toEqual(["commit-enter", "arm", "commit-post"]);
    expect(Object.keys(h.port).sort()).toEqual([
      "armKeepMine",
      "commit",
      "disarmKeepMine",
      "notifyConflict",
      "pullAndLoadAccepted",
      "reconcileKeepMine",
      "reportCommitTimings",
    ]);
  });

  test("every classification carries the plan's exact publication identity", async () => {
    const responses: CommitResult[] = [
      { sequence: 8 },
      { epochStale: 1 },
      { conflict: true },
      { unsatisfiedBlobs: ["b"] },
    ];
    for (const result of responses) {
      const h = harness({ result });
      expect((await executeManifestCommit(plan(), h.port)).identity).toBe(IDENTITY);
    }
    const lost = harness({ commitError: new Error("x") });
    expect((await executeManifestCommit(plan({ keepMineArm: ARM, resolutionRider: true }), lost.port)).identity).toBe(IDENTITY);
    const transition = harness({ result: { conflict: true } });
    expect((await executeManifestCommit(plan({ resolutionRider: true }), transition.port)).identity).toBe(IDENTITY);
  });
});
