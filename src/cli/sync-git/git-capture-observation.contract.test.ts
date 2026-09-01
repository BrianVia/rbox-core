import { describe, expect, test } from "bun:test";
import type { GitDeferral, GitDeferrals } from "../config.js";
import { carryRepoBaseProof } from "./base-composer.js";
import {
  recordGitCaptureObservation,
  type CaptureObservationSidecarValues,
  type CaptureObservationWrite,
  type GitCaptureObservation,
  type LineageSnapshot,
  type RepoObservationWritePort,
} from "./git-capture-observation.js";

const OBSERVED_AT = "2026-07-26T12:00:00.000Z";
const EARLIER = "2026-07-26T11:00:00.000Z";

function standingDeferral(lane: GitDeferral["lane"], overrides: Partial<GitDeferral> = {}): GitDeferral {
  return {
    lane,
    deferredSince: EARLIER,
    reasonSince: EARLIER,
    lastSeen: EARLIER,
    reason: "local-edits",
    ...overrides,
  };
}

function observation(overrides: Partial<GitCaptureObservation> = {}): GitCaptureObservation {
  return {
    observedAt: OBSERVED_AT,
    captureObserved: [],
    captureDeferrals: {},
    configObserved: [],
    configDeferrals: {},
    ignoreRetired: [],
    protectedPending: [],
    packedRefsIdentity: undefined,
    ackLineageOf: () => undefined,
    changedFilePaths: () => [],
    ...overrides,
  };
}

function lineage(overrides: Partial<LineageSnapshot> = {}): LineageSnapshot {
  return { acceptedSequence: 7, originLineageOf: () => undefined, ...overrides };
}

interface Harness {
  port: RepoObservationWritePort;
  writes: CaptureObservationWrite[];
  changedRequests: CaptureObservationSidecarValues[];
}

/** The port stands in for durable state: `changedRepos` reports exactly the
 * repositories the caller declares dirty, so the contract locks composition and
 * write binding rather than re-testing `changedSidecarRepoKeys`. */
function harness(options: {
  records?: Record<string, { deferrals?: GitDeferrals }>;
  dirty?: (values: CaptureObservationSidecarValues) => readonly string[];
} = {}): Harness {
  const writes: CaptureObservationWrite[] = [];
  const changedRequests: CaptureObservationSidecarValues[] = [];
  const port: RepoObservationWritePort = {
    records: options.records ?? {},
    carried: {
      bases: { a: { head: "base-a" } as never },
      pending: { p: { head: "pending-p" } as never },
      removed: { r: "removed-key" },
      resolutions: { s: "resolution-key" },
    },
    changedRepos: (values) => {
      changedRequests.push(values);
      return options.dirty ? options.dirty(values) : Object.keys(values.deferrals).sort();
    },
    save: async (write) => {
      writes.push(write);
    },
  };
  return { port, writes, changedRequests };
}

describe("RecordGitCaptureObservation", () => {
  test("writes exactly the observed repository set at the accepted state revision", async () => {
    const { port, writes } = harness({
      records: { "repo-a": {}, "repo-b": {} },
      dirty: () => ["repo-b", "repo-a"],
    });
    const receipt = await recordGitCaptureObservation(
      port,
      lineage({
        acceptedSequence: 41,
        originLineageOf: (rel) => (rel === "repo-a" ? "origin-a" : undefined),
      }),
      observation({
        captureObserved: ["repo-a", "repo-b"],
        captureDeferrals: { "repo-a": "git-busy" },
        ackLineageOf: (rel) => (rel === "repo-b" ? "ack-b" : undefined),
      }),
    );

    expect(receipt.kind).toBe("written");
    expect(receipt.acceptedSequence).toBe(41);
    expect(receipt.observedRepos).toEqual(["repo-b", "repo-a"]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.acceptedSequence).toBe(41);
    expect(writes[0]!.observedRepos).toEqual(["repo-b", "repo-a"]);
    // Proof authority is carry-only, keyed by exactly the written repositories,
    // with durable origin lineage preferred over the plan-time ACK binding.
    expect(Object.keys(writes[0]!.repoProofs).sort()).toEqual(["repo-a", "repo-b"]);
    expect(writes[0]!.repoProofs["repo-a"]).toEqual(carryRepoBaseProof("origin-a"));
    expect(writes[0]!.repoProofs["repo-b"]).toEqual(carryRepoBaseProof("ack-b"));
  });

  test("durable origin lineage outranks the plan-time ACK binding, then legacy-untrusted", async () => {
    const { port, writes } = harness({ dirty: () => ["both", "neither"] });
    await recordGitCaptureObservation(
      port,
      lineage({ originLineageOf: (rel) => (rel === "both" ? "origin-both" : undefined) }),
      observation({ captureObserved: ["both"], ackLineageOf: () => "ack-any" }),
    );
    expect(writes[0]!.repoProofs["both"]).toEqual(carryRepoBaseProof("origin-both"));
    expect(writes[0]!.repoProofs["neither"]).toEqual(carryRepoBaseProof("ack-any"));
  });

  test("falls back to legacy-untrusted lineage when neither origin nor ACK binding exists", async () => {
    const { port, writes } = harness({ dirty: () => ["repo-x"] });
    await recordGitCaptureObservation(port, lineage(), observation({ captureObserved: ["repo-x"] }));
    expect(writes[0]!.repoProofs["repo-x"]).toEqual(carryRepoBaseProof("legacy-untrusted"));
  });

  test("carries the state sidecar lanes and the plan's packed-ref identity into one write", async () => {
    const { port, writes, changedRequests } = harness({ dirty: () => ["repo-a"] });
    const packedRefsIdentity = { "repo-a": { mtimeMs: 5 }, "repo-b": null };
    await recordGitCaptureObservation(
      port,
      lineage(),
      observation({ captureObserved: ["repo-a"], packedRefsIdentity }),
    );
    expect(changedRequests).toHaveLength(1);
    expect(writes[0]!.values).toBe(changedRequests[0]!);
    expect(writes[0]!.values.packedRefsIdentity).toBe(packedRefsIdentity);
    expect(writes[0]!.values.bases).toBe(port.carried.bases);
    expect(writes[0]!.values.pending).toBe(port.carried.pending);
    expect(writes[0]!.values.removed).toBe(port.carried.removed);
    expect(writes[0]!.values.resolutions).toBe(port.carried.resolutions);
  });

  test("records exact capture and config lane transitions", async () => {
    const { port, writes } = harness({
      records: {
        "fresh": {},
        "standing": { deferrals: { capture: standingDeferral("capture", { reason: "git-busy" }) } },
        "cleared": { deferrals: { capture: standingDeferral("capture") } },
        "cfg": { deferrals: { config: standingDeferral("config", { reason: "config" }) } },
      },
    });
    const receipt = await recordGitCaptureObservation(
      port,
      lineage(),
      observation({
        captureObserved: ["fresh", "standing", "cleared", "cfg"],
        captureDeferrals: { "fresh": "conflict", "standing": "git-busy" },
        configObserved: ["cfg"],
        configDeferrals: {},
      }),
    );

    const updates = receipt.deferralUpdates;
    expect(updates["fresh"]).toEqual({
      capture: {
        set: {
          lane: "capture",
          deferredSince: OBSERVED_AT,
          reasonSince: OBSERVED_AT,
          lastSeen: OBSERVED_AT,
          reason: "conflict",
        },
        ifPreviouslyAbsent: true,
      },
    });
    // Same reason as the standing episode: deferredSince/reasonSince are held and
    // the transition is fenced on the exact predecessor lastSeen.
    expect(updates["standing"]).toEqual({
      capture: {
        set: {
          lane: "capture",
          deferredSince: EARLIER,
          reasonSince: EARLIER,
          lastSeen: OBSERVED_AT,
          reason: "git-busy",
        },
        ifLastSeenAtMost: EARLIER,
      },
    });
    expect(updates["cleared"]).toEqual({ capture: { clear: true, ifLastSeenAtMost: EARLIER } });
    expect(updates["cfg"]).toEqual({ config: { clear: true, ifLastSeenAtMost: EARLIER } });
    expect(writes[0]!.values.deferrals).toEqual(updates as Record<string, never>);
  });

  // #828: three paused repos, one now under the effective ignore rules. Exactly
  // that record retires — every lane, including the apply lane no other observed
  // transition can clear — and the other two keep the pauses they earned.
  test("retires every lane of a repository the plan reports as newly ignored", async () => {
    const { port, writes } = harness({
      records: {
        "chromium": {
          deferrals: {
            apply: standingDeferral("apply", { reason: "local-commits" }),
            config: standingDeferral("config", { reason: "config" }),
          },
        },
        "keeps-apply": { deferrals: { apply: standingDeferral("apply", { reason: "local-commits" }) } },
        "keeps-capture": { deferrals: { capture: standingDeferral("capture", { reason: "git-busy" }) } },
      },
      dirty: (values) => Object.keys(values.deferrals).sort(),
    });
    const receipt = await recordGitCaptureObservation(
      port,
      lineage(),
      observation({
        captureObserved: ["chromium", "keeps-apply", "keeps-capture"],
        captureDeferrals: { "keeps-capture": "git-busy" },
        ignoreRetired: ["chromium"],
      }),
    );

    expect(receipt.deferralUpdates["chromium"]).toEqual({
      apply: { clear: true, ifLastSeenAtMost: EARLIER },
      config: { clear: true, ifLastSeenAtMost: EARLIER },
    });
    // The apply lane of an un-ignored sibling is never touched by this pass, and
    // a live capture pause is refreshed rather than retired.
    expect(receipt.deferralUpdates["keeps-apply"]).toBeUndefined();
    expect(receipt.deferralUpdates["keeps-capture"]).toEqual({
      capture: {
        set: { lane: "capture", deferredSince: EARLIER, reasonSince: EARLIER, lastSeen: OBSERVED_AT, reason: "git-busy" },
        ifLastSeenAtMost: EARLIER,
      },
    });
    expect(Object.keys(writes[0]!.values.deferrals).sort()).toEqual(["chromium", "keeps-capture"]);
  });

  // The byte-intersection marker runs after retirement and must not resurrect the
  // apply lane it just cleared.
  test("a retired record is not re-marked by an intersecting file-plane change", async () => {
    const { port } = harness({
      records: { "chromium": { deferrals: { apply: standingDeferral("apply", { reason: "local-commits" }) } } },
      dirty: (values) => Object.keys(values.deferrals).sort(),
    });
    const receipt = await recordGitCaptureObservation(
      port,
      lineage(),
      observation({
        captureObserved: ["chromium"],
        ignoreRetired: ["chromium"],
        changedFilePaths: () => ["chromium/src/main.cc"],
      }),
    );
    expect(receipt.deferralUpdates["chromium"]).toEqual({ apply: { clear: true, ifLastSeenAtMost: EARLIER } });
  });

  test("never touches the config lane of a repository this plan did not observe for config", async () => {
    const { port, writes } = harness({
      records: { "repo": { deferrals: { config: standingDeferral("config", { reason: "config" }) } } },
      dirty: () => ["repo"],
    });
    await recordGitCaptureObservation(
      port,
      lineage(),
      observation({
        captureObserved: ["repo"],
        captureDeferrals: { "repo": "git-busy" },
        configObserved: [],
        configDeferrals: { "repo": "config" },
      }),
    );
    expect(writes[0]!.values.deferrals["repo"]).toEqual({
      capture: {
        set: {
          lane: "capture",
          deferredSince: OBSERVED_AT,
          reasonSince: OBSERVED_AT,
          lastSeen: OBSERVED_AT,
          reason: "git-busy",
        },
        ifPreviouslyAbsent: true,
      },
    });
  });

  test("marks apply-lane bytesChanged only for repositories the file diff intersects", async () => {
    const { port } = harness({
      records: {
        "inside": { deferrals: { apply: standingDeferral("apply") } },
        "outside": { deferrals: { apply: standingDeferral("apply") } },
        "already": { deferrals: { apply: standingDeferral("apply", { bytesChanged: true }) } },
      },
    });
    const receipt = await recordGitCaptureObservation(
      port,
      lineage(),
      observation({ changedFilePaths: () => ["inside/src/a.ts", "already/x", "unrelated/y"] }),
    );
    expect(receipt.deferralUpdates["inside"]).toEqual({
      apply: {
        set: { ...standingDeferral("apply"), bytesChanged: true },
        ifLastSeenAtMost: EARLIER,
      },
    });
    expect(receipt.deferralUpdates["outside"]).toBeUndefined();
    // Already-true is not re-written: the marker is monotonic, not a heartbeat.
    expect(receipt.deferralUpdates["already"]).toBeUndefined();
  });

  test("the workspace-root repository intersects every file-plane change", async () => {
    const { port } = harness({ records: { ".": { deferrals: { apply: standingDeferral("apply") } } } });
    const receipt = await recordGitCaptureObservation(
      port,
      lineage(),
      observation({ changedFilePaths: () => ["anywhere/at/all.txt"] }),
    );
    expect(receipt.deferralUpdates["."]?.apply).toBeDefined();
  });

  test("protected pending repositories are untouched in every lane", async () => {
    const { port, writes } = harness({
      records: {
        "held": { deferrals: { capture: standingDeferral("capture"), apply: standingDeferral("apply") } },
      },
      dirty: (values) => Object.keys(values.deferrals).sort(),
    });
    const receipt = await recordGitCaptureObservation(
      port,
      lineage(),
      observation({
        captureObserved: ["held"],
        captureDeferrals: { "held": "git-busy" },
        configObserved: ["held"],
        configDeferrals: { "held": "config" },
        protectedPending: ["held"],
        changedFilePaths: () => ["held/file.txt"],
      }),
    );
    expect(receipt.kind).toBe("no-change");
    expect(receipt.deferralUpdates).toEqual({});
    expect(writes).toHaveLength(0);
  });

  test("a no-change observation performs no write", async () => {
    const { port, writes, changedRequests } = harness({
      records: { "repo": {} },
      dirty: () => [],
    });
    const receipt = await recordGitCaptureObservation(
      port,
      lineage({ acceptedSequence: 12 }),
      observation({ captureObserved: ["repo"], captureDeferrals: { "repo": "git-busy" } }),
    );
    expect(receipt.kind).toBe("no-change");
    expect(receipt.acceptedSequence).toBe(12);
    expect(receipt.observedRepos).toEqual([]);
    expect(changedRequests).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });
});
