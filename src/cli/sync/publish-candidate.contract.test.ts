import { describe, expect, test } from "bun:test";
import { MAX_ENTRIES, type CaseFoldCollisionGroup, type FileEntry, type IgnoreMatcher, type Manifest } from "../../engine/index.js";
import type { CaptureObservationReceipt } from "../sync-git/git-capture-observation.js";
import type { GitPushPlan } from "../sync-git/plan.js";
import { EntryCapGuardError, MassDeleteGuardError } from "./policy.js";
import {
  preparePublishCandidate,
  PublishCandidateSealError,
  type GitCaptureEffectPlan,
  type GitCaptureExecutionReceipt,
  type GitCapturePort,
  type LocalObservation,
  type NoOpBaseCarry,
  type PublishLineageSnapshot,
  type PublishPolicy,
} from "./publish-candidate.js";

const OBSERVED_AT = new Date("2026-07-26T12:00:00.000Z");

function entry(path: string, sha = "a".repeat(64)): FileEntry {
  return { path, sha256: sha, size: 1, mode: 0o644, mtimeMs: 0, type: "file" };
}

function manifest(files: FileEntry[], gitRepos?: Manifest["gitRepos"]): Manifest {
  return { generatedAt: OBSERVED_AT.toISOString(), files, ...(gitRepos ? { gitRepos } : {}) };
}

function gitPlan(overrides: Partial<GitPushPlan> = {}): GitPushPlan {
  return {
    changed: false,
    authoredCfgHashByRepo: {},
    captured: [],
    carried: [],
    supersededPending: [],
    protectedPending: [],
    deferred: [],
    captureDeferrals: {},
    configDeferrals: {},
    captureObserved: [],
    configObserved: [],
    skipped: [],
    removed: [],
    ...overrides,
  };
}

const PASSTHROUGH_MATCHER: IgnoreMatcher = { ignores: () => false };

interface Harness {
  capture: GitCapturePort;
  /** Every port effect, in the exact order prepare invoked it. */
  effects: string[];
  executed: GitCaptureEffectPlan[];
  observed: Parameters<GitCapturePort["observe"]>[0][];
  busy: readonly string[][];
  carries: NoOpBaseCarry[];
  plan: GitPushPlan;
}

function harness(options: {
  plan?: GitPushPlan;
  /** Break the plan→receipt binding to prove the seal is load-bearing. */
  receiptPlanId?: string;
  observationSequence?: number;
} = {}): Harness {
  const plan = options.plan ?? gitPlan();
  const effects: string[] = [];
  const executed: GitCaptureEffectPlan[] = [];
  const observed: Parameters<GitCapturePort["observe"]>[0][] = [];
  const busy: (readonly string[])[] = [];
  const carries: NoOpBaseCarry[] = [];
  const capture: GitCapturePort = {
    async execute(effectPlan) {
      effects.push("execute");
      executed.push(effectPlan);
      const receipt: GitCaptureExecutionReceipt = {
        planId: options.receiptPlanId ?? effectPlan.planId,
        plan,
      };
      return receipt;
    },
    notifyBusyDeferred(relPaths) {
      effects.push(`notifyBusyDeferred:${relPaths.join(",")}`);
      busy.push(relPaths);
    },
    async observe(observation) {
      effects.push("observe");
      observed.push(observation);
      const receipt: CaptureObservationReceipt = {
        kind: "no-change",
        acceptedSequence: options.observationSequence ?? 0,
        observedRepos: [],
        deferralUpdates: {},
      };
      return receipt;
    },
    reportCapturePlan() {
      effects.push("reportCapturePlan");
    },
    async carryBaseOnNoOp(carry) {
      effects.push("carryBaseOnNoOp");
      carries.push(carry);
    },
    logPublicationLine() {
      effects.push("logPublicationLine");
    },
  };
  return { capture, effects, executed, observed, busy, carries, plan };
}

function snapshot(appliedBase: Manifest, acceptedSequence = 0): PublishLineageSnapshot {
  return { acceptedSequence, appliedBase };
}

interface ObservationHarness {
  local: LocalObservation;
  projections: { manifest: Manifest; caseCollisions: CaseFoldCollisionGroup[] }[];
}

function localObservation(
  candidate: Manifest,
  overrides: Partial<Omit<LocalObservation, "recordProjection">> = {},
): ObservationHarness {
  const projections: { manifest: Manifest; caseCollisions: CaseFoldCollisionGroup[] }[] = [];
  return {
    projections,
    local: {
      manifest: candidate,
      matcher: PASSTHROUGH_MATCHER,
      projected: false,
      caseCollisions: [],
      authority: "authoritative",
      ...overrides,
      async recordProjection(projection) {
        projections.push(projection);
      },
    },
  };
}

function policy(overrides: Partial<PublishPolicy> = {}): PublishPolicy {
  return {
    purgeIgnored: false,
    repairing: false,
    syncGit: true,
    filesFirstEnabled: false,
    filesFirstAborted: false,
    streamMismatch: false,
    forceGitRecapture: new Set<string>(),
    allowMassDelete: true,
    now: () => OBSERVED_AT,
    ...overrides,
  };
}

describe("preparePublishCandidate seals a capture receipt", () => {
  test("a receipt that does not name the executed plan is refused before any state write", async () => {
    const rig = harness({ receiptPlanId: "someone-elses-plan" });
    const observation = localObservation(manifest([entry("a.txt")]));
    await expect(preparePublishCandidate(
      snapshot(manifest([])),
      observation.local,
      rig.capture,
      policy(),
    )).rejects.toBeInstanceOf(PublishCandidateSealError);
    expect(rig.effects).toEqual(["execute"]);
  });

  test("an observation receipt bound to another revision is refused", async () => {
    const rig = harness({ observationSequence: 41 });
    const observation = localObservation(manifest([entry("a.txt")]));
    await expect(preparePublishCandidate(
      snapshot(manifest([]), 7),
      observation.local,
      rig.capture,
      policy(),
    )).rejects.toBeInstanceOf(PublishCandidateSealError);
  });

  test("an admitted candidate carries the capture and observation identity", async () => {
    const rig = harness({ plan: gitPlan({ changed: true, gitRepos: { ".": { refs: {} } as never } }), observationSequence: 3 });
    const observation = localObservation(manifest([entry("a.txt")]));
    const sealed = await preparePublishCandidate(
      snapshot(manifest([]), 3),
      observation.local,
      rig.capture,
      policy(),
    );
    expect(sealed.admission).toBe("publish");
    expect(sealed.identity.acceptedSequence).toBe(3);
    expect(sealed.identity.capturePlanId).toBe(rig.executed[0]!.planId);
    expect(sealed.publication.capturePlanId).toBe(rig.executed[0]!.planId);
    // The sealed plan projects the capture; it never republishes the planner's
    // whole working surface to its consumers.
    expect(sealed.publication).not.toHaveProperty("plan");
    expect(sealed.publication.transition.pending).toBe(rig.plan.gitPendingRemote);
    expect(sealed.publication.transition.authoredCfgHashByRepo).toBe(rig.plan.authoredCfgHashByRepo);
    expect(sealed.publication.transition.supersededPending).toBe(rig.plan.supersededPending);
    expect(sealed.candidate.gitRepos).toBe(rig.plan.gitRepos);
  });
});

describe("preparePublishCandidate owns candidate projection", () => {
  test("an authoritative observation replaces prior collisions and records once", async () => {
    const rig = harness();
    const base = manifest([entry("Case.txt", "b".repeat(64))]);
    const observation = localObservation(manifest([entry("case.txt"), entry("Case.txt", "b".repeat(64))]), {
      caseCollisions: [{ paths: ["stale.txt", "STALE.txt"] }],
      authority: "authoritative",
    });
    await preparePublishCandidate(snapshot(base), observation.local, rig.capture, policy());
    expect(observation.projections).toHaveLength(1);
    expect(observation.projections[0]!.caseCollisions).toEqual([{ paths: ["Case.txt", "case.txt"] }]);
  });

  test("a preserve observation merges prior collisions with the projection", async () => {
    const rig = harness();
    const base = manifest([entry("Case.txt", "b".repeat(64))]);
    const observation = localObservation(manifest([entry("case.txt"), entry("Case.txt", "b".repeat(64))]), {
      caseCollisions: [{ paths: ["STALE.txt", "stale.txt"] }],
      authority: "preserve",
    });
    await preparePublishCandidate(snapshot(base), observation.local, rig.capture, policy());
    expect(observation.projections[0]!.caseCollisions).toEqual([
      { paths: ["Case.txt", "case.txt"] },
      { paths: ["STALE.txt", "stale.txt"] },
    ]);
  });

  test("an already-projected candidate is republished verbatim without re-observing collisions", async () => {
    const rig = harness();
    const candidate = manifest([entry("a.txt")]);
    const observation = localObservation(candidate, { projected: true });
    const sealed = await preparePublishCandidate(snapshot(manifest([])), observation.local, rig.capture, policy());
    expect(observation.projections).toHaveLength(0);
    expect(sealed.candidate.files).toEqual(candidate.files);
  });

  test("a purge that cannot evaluate a repo's tracked set refuses before any capture effect", async () => {
    const rig = harness();
    const matcher: IgnoreMatcher = {
      ignores: () => false,
      unevaluatedGitRepoForPath: (path) => (path === "repo/gone.txt" ? "repo" : undefined),
    };
    const observation = localObservation(manifest([]), { matcher });
    await expect(preparePublishCandidate(
      snapshot(manifest([entry("repo/gone.txt")])),
      observation.local,
      rig.capture,
      policy({ purgeIgnored: true }),
    )).rejects.toThrow(/refusing purge: cannot evaluate tracked files for git repo repo/);
    expect(rig.effects).toEqual([]);
  });
});

describe("preparePublishCandidate admits files-first genesis only on every leg", () => {
  const filesFirstPolicy = policy({ filesFirstEnabled: true });

  test("a genuine genesis with a real file diff defers git capture", async () => {
    const rig = harness();
    const observation = localObservation(manifest([entry("a.txt")]));
    await preparePublishCandidate(snapshot(manifest([]), 0), observation.local, rig.capture, filesFirstPolicy);
    expect(rig.executed[0]!.filesFirstDefer).toBe(true);
  });

  for (const [name, overrides] of [
    ["the flag is off", { filesFirstEnabled: false }],
    ["a chain repair is republishing", { repairing: true }],
    ["there is no git to attach", { syncGit: false }],
    ["a 409/epoch/starvation latch fired", { filesFirstAborted: true }],
    ["the stream was rebound", { streamMismatch: true }],
  ] as const) {
    test(`${name} ⇒ ordinary git-inclusive planning`, async () => {
      const rig = harness();
      const observation = localObservation(manifest([entry("a.txt")]));
      await preparePublishCandidate(
        snapshot(manifest([]), 0),
        observation.local,
        rig.capture,
        policy({ filesFirstEnabled: true, ...overrides }),
      );
      expect(rig.executed[0]!.filesFirstDefer).toBe(false);
    });
  }

  test("a non-genesis parent sequence ⇒ ordinary git-inclusive planning", async () => {
    const rig = harness({ plan: gitPlan({ changed: true }), observationSequence: 4 });
    const observation = localObservation(manifest([entry("a.txt")]));
    await preparePublishCandidate(snapshot(manifest([]), 4), observation.local, rig.capture, filesFirstPolicy);
    expect(rig.executed[0]!.filesFirstDefer).toBe(false);
  });

  test("an empty file diff ⇒ ordinary git-inclusive planning", async () => {
    const rig = harness({ plan: gitPlan({ changed: true }) });
    const observation = localObservation(manifest([]));
    await preparePublishCandidate(snapshot(manifest([]), 0), observation.local, rig.capture, filesFirstPolicy);
    expect(rig.executed[0]!.filesFirstDefer).toBe(false);
  });
});

describe("preparePublishCandidate short-circuits a zero-commit candidate", () => {
  test("files and git identity both matching base yields a no-op that carries the sidecar", async () => {
    const rig = harness({
      plan: gitPlan({
        changed: false,
        packedRefsIdentity: { ".": { mtimeMs: 5 } },
        repoAbsent: { "vendor": true },
        gitPendingRemote: {},
        gitReposRemoved: { "old": "gone" },
        gitNeedsResolution: {},
      }),
      observationSequence: 9,
    });
    const base = manifest([entry("a.txt")], { ".": { refs: { "refs/heads/main": "abc" } } as never });
    const observation = localObservation(manifest([entry("a.txt")]));
    const sealed = await preparePublishCandidate(snapshot(base, 9), observation.local, rig.capture, policy());
    expect(sealed.admission).toBe("no-op");
    expect(rig.effects).toEqual(["execute", "notifyBusyDeferred:", "observe", "reportCapturePlan", "carryBaseOnNoOp"]);
    expect(rig.carries[0]!.receipt.plan).toBe(rig.plan);
    expect(rig.carries[0]!.acceptedSequence).toBe(9);
    expect(rig.carries[0]!.values).toEqual({
      bases: base.gitRepos,
      packedRefsIdentity: { ".": { mtimeMs: 5 } },
      repoAbsent: { "vendor": true },
      pending: {},
      removed: { "old": "gone" },
      resolutions: {},
    });
  });

  test("a no-op with git syncing off never carries the sidecar", async () => {
    const rig = harness({ observationSequence: 9 });
    const observation = localObservation(manifest([entry("a.txt")]));
    const sealed = await preparePublishCandidate(
      snapshot(manifest([entry("a.txt")]), 9),
      observation.local,
      rig.capture,
      policy({ syncGit: false }),
    );
    expect(sealed.admission).toBe("no-op");
    expect(rig.effects).toEqual(["execute", "notifyBusyDeferred:", "observe", "reportCapturePlan"]);
  });

  test("a chain repair never short-circuits an unchanged candidate", async () => {
    const rig = harness({ observationSequence: 9 });
    const observation = localObservation(manifest([entry("a.txt")]));
    const sealed = await preparePublishCandidate(
      snapshot(manifest([entry("a.txt")]), 9),
      observation.local,
      rig.capture,
      policy({ repairing: true }),
    );
    expect(sealed.admission).toBe("publish");
  });
});

describe("preparePublishCandidate surfaces capture observations in one order", () => {
  test("git-busy deferrals are reported sorted, before the durable observation", async () => {
    const rig = harness({
      plan: gitPlan({
        changed: true,
        captureDeferrals: { "z": "git-busy", "a": "git-busy", "m": "local-edits" },
      }),
    });
    const observation = localObservation(manifest([entry("a.txt")]));
    await preparePublishCandidate(snapshot(manifest([])), observation.local, rig.capture, policy());
    expect(rig.busy[0]).toEqual(["a", "z"]);
    expect(rig.effects.indexOf("notifyBusyDeferred:a,z")).toBeLessThan(rig.effects.indexOf("observe"));
  });

  test("the durable observation is the bounded projection of the capture receipt", async () => {
    const rig = harness({
      plan: gitPlan({
        changed: true,
        captureObserved: ["a"],
        captureDeferrals: { "a": "local-edits" },
        configObserved: ["a"],
        configDeferrals: {},
        protectedPending: ["p"],
        packedRefsIdentity: { "a": { mtimeMs: 3 } },
        publisherAckBindings: { "a": { lineageHash: "lin", repositoryIdentityHash: "rid", repoKind: "dir" } },
      }),
    });
    const observation = localObservation(manifest([entry("added.txt")]));
    await preparePublishCandidate(
      snapshot(manifest([entry("deleted.txt")])),
      observation.local,
      rig.capture,
      policy(),
    );
    const seen = rig.observed[0]!;
    expect(seen.observedAt).toBe(OBSERVED_AT.toISOString());
    expect(seen.captureObserved).toEqual(["a"]);
    expect(seen.captureDeferrals).toEqual({ "a": "local-edits" });
    expect(seen.configObserved).toEqual(["a"]);
    expect(seen.protectedPending).toEqual(["p"]);
    expect(seen.packedRefsIdentity).toEqual({ "a": { mtimeMs: 3 } });
    expect(seen.ackLineageOf("a")).toBe("lin");
    expect(seen.ackLineageOf("missing")).toBeUndefined();
    expect([...seen.changedFilePaths()].sort()).toEqual(["added.txt", "deleted.txt"]);
  });

  test("the forensic publication line is emitted only for a git-sync candidate that did work", async () => {
    const quiet = harness({ plan: gitPlan({ changed: true }) });
    const quietObservation = localObservation(manifest([entry("a.txt")]));
    await preparePublishCandidate(snapshot(manifest([])), quietObservation.local, quiet.capture, policy());
    expect(quiet.effects).not.toContain("logPublicationLine");

    const loud = harness({ plan: gitPlan({ changed: true, captured: ["a"] }) });
    const loudObservation = localObservation(manifest([entry("a.txt")]));
    await preparePublishCandidate(snapshot(manifest([])), loudObservation.local, loud.capture, policy());
    expect(loud.effects).toEqual(["execute", "notifyBusyDeferred:", "observe", "reportCapturePlan", "logPublicationLine"]);
  });
});

describe("preparePublishCandidate refuses a mass delete before any upload", () => {
  test("the breaker trips after the durable observation and before admission", async () => {
    const rig = harness({ plan: gitPlan({ changed: true }) });
    const base = manifest(Array.from({ length: 1200 }, (_, index) => entry(`f${index}.txt`)));
    const observation = localObservation(manifest([]));
    let refusals = 0;
    await expect(preparePublishCandidate(
      snapshot(base),
      observation.local,
      rig.capture,
      policy({ allowMassDelete: false, onMassDeleteRefused: () => { refusals++; } }),
    )).rejects.toBeInstanceOf(MassDeleteGuardError);
    expect(refusals).toBe(1);
    expect(rig.effects).toEqual(["execute", "notifyBusyDeferred:", "observe", "reportCapturePlan"]);
  });

  test("the refusal names the operator's own consent command", async () => {
    const rig = harness({ plan: gitPlan({ changed: true }) });
    const base = manifest(Array.from({ length: 1200 }, (_, index) => entry(`f${index}.txt`)));
    const observation = localObservation(manifest([]));
    await expect(preparePublishCandidate(
      snapshot(base),
      observation.local,
      rig.capture,
      policy({ allowMassDelete: false, massDeleteHint: "rbox setup --allow-mass-delete" }),
    )).rejects.toThrow(/rbox setup --allow-mass-delete/);
  });

  test("op-scoped consent publishes the deletion", async () => {
    const rig = harness({ plan: gitPlan({ changed: true }) });
    const base = manifest(Array.from({ length: 1200 }, (_, index) => entry(`f${index}.txt`)));
    const observation = localObservation(manifest([]));
    const sealed = await preparePublishCandidate(snapshot(base), observation.local, rig.capture, policy());
    expect(sealed.admission).toBe("publish");
  });
});

/** #813: the cap used to fire only in wire validation, after the whole runaway
 *  tree had been scanned, encrypted and uploaded. Preparing a candidate is the
 *  last point that costs nothing. */
describe("preparePublishCandidate refuses an over-cap candidate before any spend", () => {
  const overCap = (dir: string): Manifest =>
    manifest(Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => entry(`${dir}/f${index}.txt`)));

  test("the refusal names the dominating directory and the ignore that fixes it", async () => {
    const rig = harness({ plan: gitPlan({ changed: true }) });
    const observation = localObservation(overCap("chromium/src"), { projected: true });
    const sealed = preparePublishCandidate(snapshot(manifest([])), observation.local, rig.capture, policy());
    await expect(sealed).rejects.toBeInstanceOf(EntryCapGuardError);
    await expect(sealed).rejects.toThrow(/chromium\/src just added 200,001 files/);
    await expect(sealed).rejects.toThrow(/`rbox ignore chromium\/src\/` skips it \(files stay on disk\)/);
    await expect(sealed).rejects.toThrow(/the limit is 200,000/);
  });

  test("it refuses at candidate time — no upload port is ever reached", async () => {
    const rig = harness({ plan: gitPlan({ changed: true }) });
    const observation = localObservation(overCap("build"), { projected: true });
    await expect(preparePublishCandidate(
      snapshot(manifest([])),
      observation.local,
      rig.capture,
      policy(),
    )).rejects.toBeInstanceOf(EntryCapGuardError);
    // Same effect prefix the mass-delete breaker stops at: capture happened,
    // nothing was encrypted, uploaded or committed.
    expect(rig.effects).toEqual(["execute", "notifyBusyDeferred:", "observe", "reportCapturePlan"]);
  });

  test("a candidate at the cap still publishes", async () => {
    const rig = harness({ plan: gitPlan({ changed: true }) });
    const atCap = manifest(Array.from({ length: MAX_ENTRIES }, (_, index) => entry(`build/f${index}.txt`)));
    const observation = localObservation(atCap, { projected: true });
    const sealed = await preparePublishCandidate(snapshot(manifest([])), observation.local, rig.capture, policy());
    expect(sealed.admission).toBe("publish");
  });
});
