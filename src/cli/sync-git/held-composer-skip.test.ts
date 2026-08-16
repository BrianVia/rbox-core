import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../../engine/git-spawn.js";
import type { GitDeferral, GitHeldAttempt, GitPartialApply, TypedBlocker } from "../config.js";
import { createHeldDecisionPlane, heldTraceEnabled } from "./held-decision.js";
import { zeroGitChainTimings } from "./chain-timings.js";
import { composerHoldAllowsSkip, heldBlockersAllowSkip } from "./held-blockers.js";
import { GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS } from "./fingerprint.js";
import { readArtifactPlaneDigest } from "./base-artifact-scan.js";
import {
  createHeldAttempt,
  earlyHeldAttemptDecision,
  observeHeldInputs,
  type HeldInputObservation,
  type ObserveHeldInputsOptions,
} from "./held-skip.js";

/**
 * Design 270: composer-held follows join the held-skip fast path, and the
 * artifact-plane digest plus the partial identity are what make that sound.
 * Every case here runs against a real repository, because the whole change is
 * about state gitFingerprint deliberately cannot see.
 */

const roots: string[] = [];
const savedFlag = process.env.RBOX_GIT_HELD_SKIP_COMPOSER;
afterEach(async () => {
  if (savedFlag === undefined) delete process.env.RBOX_GIT_HELD_SKIP_COMPOSER;
  else process.env.RBOX_GIT_HELD_SKIP_COMPOSER = savedFlag;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const composerHold: TypedBlocker = {
  provenance: "composer", reason: "artifact", ref: "refs/heads/main",
  code: "missing-branch-proof", detail: "BASE composer hold missing-branch-proof at refs/heads/main",
};
const refPlaneCommits: TypedBlocker = {
  provenance: "ref-plane", reason: "local-commits", ref: "refs/heads/side",
};

const standingApply = (subjectKey: string): GitDeferral => ({
  lane: "apply", reason: "artifact", subjectKey,
  deferredSince: "2026-08-16T06:34:43.000Z",
  reasonSince: "2026-08-16T06:34:43.000Z",
  lastSeen: "2026-08-16T06:34:43.000Z",
});

async function repoWithCommit(): Promise<{ root: string; tip: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-270-"));
  roots.push(root);
  await git(root, ["init", "-qb", "main"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "f"), "a");
  await git(root, ["add", "f"]);
  await git(root, ["commit", "-qm", "a"]);
  return { root, tip: (await git(root, ["rev-parse", "HEAD"])).trim() };
}

function sectionFor(tip: string) {
  return {
    bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
    head: "ref: refs/heads/main\n", refs: { "refs/heads/main": tip }, refScope: "all" as const,
  };
}

async function observe(root: string, tip: string, partial?: GitPartialApply): Promise<HeldInputObservation> {
  const options: ObserveHeldInputsOptions = {
    root, relPath: ".", incoming: sectionFor(tip), stateNonce: "nonce",
    effectiveBaseIndexProjection: null, effectiveIncomingIndexProjection: null,
    reflogPaths: [],
  };
  if (partial) options.partial = partial;
  const observed = await observeHeldInputs(options);
  expect(observed).toBeDefined();
  return observed!;
}

/** One pull's early gate, with the deferral lane a skip is allowed to touch. */
async function earlyPull(input: {
  root: string;
  tip: string;
  attempt: GitHeldAttempt;
  partial?: GitPartialApply;
  deferral?: GitDeferral;
  nowMs?: number;
}): Promise<{ skipped: boolean; restood: GitDeferral | undefined; logs: string[] }> {
  let deferral = input.deferral;
  const logs: string[] = [];
  const plane = createHeldDecisionPlane({
    root: input.root,
    log: (line) => logs.push(line),
    attempts: {},
    now: () => input.nowMs ?? Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 1_000,
    deferrals: {
      standingApply: () => deferral,
      restandApply: (_rel, standing) => { deferral = { ...standing, lastSeen: "restood" }; },
      clearApply: () => { deferral = undefined; },
    },
  });
  const repo = plane.repo({
    relPath: ".", incoming: sectionFor(input.tip), storedAttempt: input.attempt,
    traced: false, timings: undefined,
  });
  const skipped = await repo.earlySkip({
    pending: true, attempt: input.attempt, partial: input.partial,
  });
  return { skipped, restood: deferral, logs };
}

test("red-first: a composer missing-branch-proof fixpoint skips instead of re-following forever", async () => {
  const { root, tip } = await repoWithCommit();
  const attempt = createHeldAttempt(await observe(root, tip), [composerHold]);

  const skip = await earlyPull({ root, tip, attempt, deferral: standingApply("incoming") });
  expect(skip.skipped).toBe(true);
  // The skip performs no follow, so it must leave the standing refusal standing.
  expect(skip.restood?.reason).toBe("artifact");
  expect(skip.restood?.subjectKey).toBe("incoming");

  // Flag off is the kill switch for exactly this disjunct.
  process.env.RBOX_GIT_HELD_SKIP_COMPOSER = "0";
  const off = await earlyPull({ root, tip, attempt, deferral: standingApply("incoming") });
  expect(off.skipped).toBe(false);
});

test("a composer hold mixed with allowlisted ref-plane blockers skips; a mismatched proof never does", async () => {
  const { root, tip } = await repoWithCommit();
  const observed = await observe(root, tip);
  const mixed = createHeldAttempt(observed, [composerHold, refPlaneCommits]);
  expect((await earlyPull({ root, tip, attempt: mixed, deferral: standingApply("k") })).skipped).toBe(true);

  const contradicted = createHeldAttempt(observed, [
    { ...composerHold, code: "mismatched-branch-proof" }, refPlaneCommits,
  ]);
  expect((await earlyPull({ root, tip, attempt: contradicted, deferral: standingApply("k") })).skipped).toBe(false);
});

test("a composer-held repo with no standing apply deferral is still refused", async () => {
  const { root, tip } = await repoWithCommit();
  const attempt = createHeldAttempt(await observe(root, tip), [composerHold]);
  expect((await earlyPull({ root, tip, attempt })).skipped).toBe(false);
});

test("the hourly safety floor still forces a full re-prove of a composer-held repo", async () => {
  const { root, tip } = await repoWithCommit();
  const nowMs = Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 1_000;
  const stale = createHeldAttempt(await observe(root, tip), [composerHold],
    new Date(nowMs - 3_600_001).toISOString());
  const decision = await earlyHeldAttemptDecision({
    root, relPath: ".", incoming: sectionFor(tip), attempt: stale, nowMs,
  });
  expect(decision).toEqual({ matches: false, reason: "safety-floor" });
  expect((await earlyPull({ root, tip, attempt: stale, deferral: standingApply("k"), nowMs })).skipped).toBe(false);
});

test("an artifact-plane ref written between cycles sends the next pull down the full path", async () => {
  const { root, tip } = await repoWithCommit();
  const attempt = createHeldAttempt(await observe(root, tip), [composerHold]);
  expect((await earlyPull({ root, tip, attempt, deferral: standingApply("k") })).skipped).toBe(true);

  const artifactRef = `refs/rbox-local/base-present/v2/${"a".repeat(64)}/${"b".repeat(64)}`;
  await git(root, ["update-ref", artifactRef, tip]);
  const invalidated = await earlyHeldAttemptDecision({
    root, relPath: ".", incoming: sectionFor(tip), attempt,
    nowMs: Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 1_000,
  });
  expect(invalidated).toEqual({ matches: false, reason: "artifact-plane" });
  expect((await earlyPull({ root, tip, attempt, deferral: standingApply("k") })).skipped).toBe(false);

  // Deleting it again restores the exact prior identity — the digest is refname+oid, not a counter.
  await git(root, ["update-ref", "-d", artifactRef]);
  expect((await earlyPull({ root, tip, attempt, deferral: standingApply("k") })).skipped).toBe(true);
});

test("gitFingerprint cannot see the artifact plane — only the digest can", async () => {
  const { root, tip } = await repoWithCommit();
  const before = await observe(root, tip);
  await git(root, ["update-ref", `refs/rbox-recovery/base-present/v2/${"c".repeat(64)}/${"d".repeat(64)}/${"e".repeat(32)}`, tip]);
  const after = await observe(root, tip);
  expect(after.localFingerprint).toBe(before.localFingerprint);
  expect(after.artifactPlaneDigest).not.toBe(before.artifactPlaneDigest);
});

test("every rbox base and recovery namespace is inside the digest", async () => {
  const { root, tip } = await repoWithCommit();
  const empty = await readArtifactPlaneDigest(root);
  const prefixes = [
    `refs/rbox-local/base-absent/v2/${"a".repeat(64)}/${"b".repeat(64)}`,
    `refs/rbox-local/base-present/v2/${"a".repeat(64)}/${"c".repeat(64)}`,
    `refs/rbox-local/base-present-keep/v2/${"a".repeat(64)}/${"d".repeat(64)}`,
    `refs/rbox-local/base-absent-settled/v1/${"a".repeat(64)}`,
    `refs/rbox-recovery/base-present/v2/${"a".repeat(64)}/${"e".repeat(64)}/${"f".repeat(32)}`,
  ];
  const seen = new Set<string>([empty]);
  for (const ref of prefixes) {
    await git(root, ["update-ref", ref, tip]);
    const digest = await readArtifactPlaneDigest(root);
    expect(seen.has(digest), ref).toBe(false);
    seen.add(digest);
    await git(root, ["update-ref", "-d", ref]);
  }
  // A non-artifact ref is outside the plane and must not move the digest.
  await git(root, ["update-ref", "refs/heads/unrelated", tip]);
  expect(await readArtifactPlaneDigest(root)).toBe(empty);
});

test("a pRepaired write invalidates the early gate with the composer flag OFF too", async () => {
  const { root, tip } = await repoWithCommit();
  const partial: GitPartialApply = {
    incomingKey: "incoming", checkoutPending: false, appliedRefs: {}, heldRefs: {}, configApplied: false,
  };
  const attempt = createHeldAttempt(await observe(root, tip, partial), [refPlaneCommits]);
  expect((await earlyPull({ root, tip, attempt, partial, deferral: standingApply("k") })).skipped).toBe(true);

  // partialDisposition canonicalizes the WHOLE partial, so the mere presence of
  // the P-repair member moves it — no receipt payload needs synthesizing here.
  const repaired: GitPartialApply = { ...partial, pRepaired: {} };
  for (const flag of ["1", "0"]) {
    process.env.RBOX_GIT_HELD_SKIP_COMPOSER = flag;
    const decision = await earlyHeldAttemptDecision({
      root, relPath: ".", incoming: sectionFor(tip), attempt, partial: repaired,
      nowMs: Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 1_000,
    });
    expect(decision, `flag=${flag}`).toEqual({ matches: false, reason: "partial-disposition" });
  }
});

test("dropping the durable partial entirely also invalidates the early gate", async () => {
  const { root, tip } = await repoWithCommit();
  const partial: GitPartialApply = {
    incomingKey: "incoming", checkoutPending: true, appliedRefs: {}, heldRefs: {}, configApplied: false,
  };
  const attempt = createHeldAttempt(await observe(root, tip, partial), [refPlaneCommits]);
  expect((await earlyPull({ root, tip, attempt, deferral: standingApply("k") })).skipped).toBe(false);
});

test("with the flag off the observation is byte-identical to pre-change and stores no digest", async () => {
  const { root, tip } = await repoWithCommit();
  process.env.RBOX_GIT_HELD_SKIP_COMPOSER = "0";
  const observed = await observe(root, tip);
  expect(Object.hasOwn(observed, "artifactPlaneDigest")).toBe(false);
  const attempt = createHeldAttempt(observed, [refPlaneCommits]);
  expect(Object.hasOwn(attempt, "artifactPlaneDigest")).toBe(false);

  // An artifact-plane write is invisible with the flag off — exactly pre-change behavior.
  await git(root, ["update-ref", `refs/rbox-local/base-absent/v2/${"a".repeat(64)}/${"b".repeat(64)}`, tip]);
  expect((await earlyPull({ root, tip, attempt, deferral: standingApply("k") })).skipped).toBe(true);
});

test("an attempt stored before the digest existed cannot match once the digest is live", async () => {
  const { root, tip } = await repoWithCommit();
  process.env.RBOX_GIT_HELD_SKIP_COMPOSER = "0";
  const legacy = createHeldAttempt(await observe(root, tip), [refPlaneCommits]);
  delete process.env.RBOX_GIT_HELD_SKIP_COMPOSER;
  const decision = await earlyHeldAttemptDecision({
    root, relPath: ".", incoming: sectionFor(tip), attempt: legacy,
    nowMs: Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 1_000,
  });
  expect(decision).toEqual({ matches: false, reason: "artifact-plane" });
});

test("control group: an existing local-* held repo still skips N cycles with the digest live", async () => {
  const { root, tip } = await repoWithCommit();
  const attempt = createHeldAttempt(await observe(root, tip), [
    { provenance: "checkout", reason: "local-index" },
    { provenance: "checkout", reason: "local-operation" },
  ]);
  for (let cycle = 0; cycle < 4; cycle++) {
    const pull = await earlyPull({ root, tip, attempt, deferral: standingApply("k") });
    expect(pull.skipped, `cycle ${cycle}`).toBe(true);
    expect(pull.restood?.subjectKey).toBe("k");
  }
});

test("a semantic section change still invalidates a composer-held attempt", async () => {
  const { root, tip } = await repoWithCommit();
  const attempt = createHeldAttempt(await observe(root, tip), [composerHold]);
  const decision = await earlyHeldAttemptDecision({
    root, relPath: ".", attempt,
    incoming: { ...sectionFor(tip), head: tip },
    nowMs: Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 1_000,
  });
  expect(decision).toEqual({ matches: false, reason: "classifier-key" });
});

test("a bundle recapture with identical semantics keeps the skip, and re-stands the STORED subjectKey", async () => {
  const { root, tip } = await repoWithCommit();
  const attempt = createHeldAttempt(await observe(root, tip), [composerHold]);
  const recaptured = { ...sectionFor(tip), bundleSha: "9".repeat(64), bundleEncSha: "8".repeat(64) };
  const decision = await earlyHeldAttemptDecision({
    root, relPath: ".", incoming: recaptured, attempt,
    nowMs: Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 1_000,
  });
  expect(decision).toEqual({ matches: true, reason: "none" });
  // N10: the stored subjectKey survives the skip; a staled one drops reproof on
  // the next full follow rather than being silently refreshed here.
  const pull = await earlyPull({ root, tip, attempt, deferral: { ...standingApply("stale-key"), reproof: true } });
  expect(pull.skipped).toBe(true);
  expect(pull.restood?.subjectKey).toBe("stale-key");
});

const ALL_HOLD_CODES = [
  "missing-branch-proof", "mismatched-branch-proof", "missing-safe-ref-proof",
  "mismatched-safe-ref-proof", "wrong-ref-class", "scope-refused",
  "manual-proof-mismatch", "p-repair-shape-mismatch", "checkout-incomplete",
] as const satisfies readonly NonNullable<Extract<TypedBlocker, { provenance: "composer" }>["code"]>[];
const ELIGIBLE_HOLD_CODES = new Set(["missing-branch-proof", "missing-safe-ref-proof"]);

test("exactly the two no-proof-was-minted codes are eligible; a later code defaults to refusing", () => {
  for (const code of ALL_HOLD_CODES) {
    const blocker: TypedBlocker = { ...composerHold, code };
    expect(composerHoldAllowsSkip(blocker), code).toBe(ELIGIBLE_HOLD_CODES.has(code));
    expect(heldBlockersAllowSkip([blocker]), code).toBe(ELIGIBLE_HOLD_CODES.has(code));
    expect(heldBlockersAllowSkip([blocker, refPlaneCommits]), `mixed ${code}`)
      .toBe(ELIGIBLE_HOLD_CODES.has(code));
    expect(heldBlockersAllowSkip([blocker], { RBOX_GIT_HELD_SKIP_COMPOSER: "0" }), `off ${code}`).toBe(false);
  }
  const safeRef: TypedBlocker = {
    provenance: "composer", reason: "artifact", ref: "refs/stash",
    code: "missing-safe-ref-proof", detail: "BASE composer hold missing-safe-ref-proof at refs/stash",
  };
  expect(heldBlockersAllowSkip([composerHold, safeRef])).toBe(true);
});

test("a refless or foreign-provenance artifact blocker is never eligible", () => {
  const vacuous: TypedBlocker = {
    provenance: "composer", reason: "artifact",
    detail: "BASE composer retained an unexplained pending disposition",
  };
  expect(composerHoldAllowsSkip(vacuous)).toBe(false);
  expect(heldBlockersAllowSkip([vacuous])).toBe(false);
  // A refless mint that somehow carried an eligible code is still not a ref hold.
  expect(heldBlockersAllowSkip([{ ...vacuous, code: "missing-branch-proof" }])).toBe(true);
  for (const provenance of ["protocol", "checkout", "boundary"] as const) {
    const foreign = { provenance, reason: "artifact", detail: "foreign artifact veto" } as TypedBlocker;
    expect(composerHoldAllowsSkip(foreign), provenance).toBe(false);
    expect(heldBlockersAllowSkip([foreign]), provenance).toBe(false);
  }
});

test("the trace names an applied-but-held repo's standing blocker instead of printing none", async () => {
  const { root, tip } = await repoWithCommit();
  const savedTrace = process.env.RBOX_TRACE_HELD;
  process.env.RBOX_TRACE_HELD = "1";
  try {
    const logs: string[] = [];
    const plane = createHeldDecisionPlane({
      root, log: (line) => logs.push(line), attempts: {},
      deferrals: {
        standingApply: () => standingApply("k"),
        restandApply: () => {}, clearApply: () => {},
      },
    });
    const repo = plane.repo({
      relPath: ".", incoming: sectionFor(tip), storedAttempt: undefined,
      traced: heldTraceEnabled(true), timings: zeroGitChainTimings(),
    });
    repo.emitTrace({ result: "applied", wallMs: 3_500 });
    expect(logs.join("\n")).toContain("blocker=apply/artifact");
  } finally {
    if (savedTrace === undefined) delete process.env.RBOX_TRACE_HELD;
    else process.env.RBOX_TRACE_HELD = savedTrace;
  }
});
