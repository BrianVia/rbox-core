import { addTimedMs } from "./chain-timings.js";
import type { GitSection } from "../../engine/index.js";
import type { GitChainTimings } from "./chain-timings.js";
import type { GitDeferral, GitHeldAttempt, GitPartialApply, RepoRecord, TypedBlocker } from "../config.js";
import type { GitApplyRepoResult } from "./apply-metrics.js";
import type { GitFingerprint } from "./fingerprint.js";
import {
  gitOwnershipNoEscalateEnabled,
  heldBlockersAllowSkip,
  ownershipBlockersArePerRefOnly,
  sameHeldOutcome,
  sortedTypedBlockers,
} from "./held-blockers.js";
import {
  createHeldAttempt,
  earlyHeldAttemptDecision,
  gitHeldSkipEnabled,
  heldAttemptFloorElapsed,
  heldAttemptMatches,
  heldAttemptMismatchField,
  incomingIndexArtifactDescriptor,
  observeHeldInputs,
  type ObserveHeldInputsOptions,
} from "./held-skip.js";

/**
 * The held-skip decision plane (design 174).
 *
 * One owner for the whole question "may this pull skip a repository whose last
 * follow ended held, and what does the skip leave behind?". It owns both halves
 * that must agree: the cheap pre-frame check, the authoritative post-protocol
 * check, the attempt a completed classification stores, and the apply-deferral
 * retention that every skip must preserve. `held-skip.ts` remains the primitive
 * layer beneath it (observation, matcher, safety floor); `applyGitSections` is
 * an Adapter that asks this plane for decisions and never re-derives them.
 *
 * It also owns the RBOX_TRACE_HELD diagnostic, because every field that line
 * reports is an intermediate of these decisions.
 */

/** The apply deferral lane, exactly as the held plane needs it. A skip performs
 * no follow, so it must leave the standing refusal standing — including the
 * ownership holds it once retired (design 273 P2). The lane can therefore only
 * re-stand a record; it has no clear operation to misuse, and `restandApply` is
 * reached only when NO record stands, so a skip writes at most once per hold. */
export interface HeldDeferralLane {
  standingApply(relPath: string): GitDeferral | undefined;
  restandApply(relPath: string, standing: Pick<GitDeferral, "reason">): void;
}

export interface HeldDecisionEnv {
  root: string;
  log: (line: string) => void;
  /** This pull's attempt sidecar lane; the plane is its held-decision writer. */
  attempts: Record<string, GitHeldAttempt | null>;
  deferrals: HeldDeferralLane;
  /** Shared logical time for held-attempt tests; absent keeps wall-clock reads. */
  now?: () => number;
}

export interface HeldRepoInput {
  relPath: string;
  incoming: GitSection | undefined;
  /** The durable attempt as it stood before this repo's frame — trace only. */
  storedAttempt: GitHeldAttempt | undefined;
  traced: boolean;
  timings: GitChainTimings | undefined;
}

export interface HeldSteadyInput {
  /** The attempt eligible for the late check: absent once standing P work
   * invalidated it, or when nothing is pending. */
  attempt: GitHeldAttempt | undefined;
  record: RepoRecord | undefined;
  partial: GitPartialApply | undefined;
  stateNonce: string;
  effectiveBaseIndexProjection: string | null | undefined;
}

export interface HeldClassificationInput {
  blockers: readonly TypedBlocker[];
  reflogPaths: readonly string[];
  trustedFingerprint: GitFingerprint | undefined;
  effectiveBaseIndexProjection: string | null | undefined;
  effectiveIncomingIndexProjection: string | null | undefined;
  boundBase: GitSection | undefined;
  boundOrigins: RepoRecord["branchBaseOrigins"] | undefined;
  partial: GitPartialApply;
  record: RepoRecord | undefined;
  stateNonce: string;
  expectedWorktreeRegistryDigest: string | undefined;
}

export interface HeldRepoDecision {
  /** Layer A: the cheap pre-frame skip, before any per-repo probe or lock work. */
  earlySkip(input: {
    pending: boolean;
    attempt: GitHeldAttempt | undefined;
    partial: GitPartialApply | undefined;
  }): Promise<boolean>;
  /** Layer B: the authoritative check, after the follower branch protocol settled. */
  steadySkip(input: HeldSteadyInput): Promise<boolean>;
  /** Store the attempt a completed classification proved. */
  recordClassification(input: HeldClassificationInput): Promise<void>;
  /** Name the blocker a full follow ended on (diagnostic only). */
  noteBlockers(blockers: readonly TypedBlocker[], fallback: string): void;
  emitTrace(input: { result: GitApplyRepoResult; wallMs: number }): void;
}

interface HeldTraceAttempt {
  storedAttempt: boolean;
  earlySkip: boolean;
  matchConsulted: boolean;
  mismatch: string;
  earlyReason: string;
  blocker: string;
}

/** RBOX_TRACE_HELD is a per-repo diagnostic: only a repo carrying pending work
 * has a held decision to explain. */
export function heldTraceEnabled(pendingPresent: boolean): boolean {
  return process.env.RBOX_TRACE_HELD === "1" && pendingPresent;
}

function namedBlocker(blockers: readonly TypedBlocker[], fallback: string): string {
  const first = sortedTypedBlockers(blockers)[0];
  return first ? `${first.provenance}/${first.reason}` : fallback;
}

export interface HeldDecisionPlane {
  repo(input: HeldRepoInput): HeldRepoDecision;
}

export function createHeldDecisionPlane(env: HeldDecisionEnv): HeldDecisionPlane {
  return {
    repo({ relPath, incoming, storedAttempt, traced, timings }) {
      const trace: HeldTraceAttempt | undefined = traced ? {
        storedAttempt: storedAttempt !== undefined,
        earlySkip: false,
        matchConsulted: false,
        mismatch: storedAttempt ? "not-consulted" : "none",
        earlyReason: storedAttempt ? "not-consulted" : "no-attempt",
        blocker: "none",
      } : undefined;
      // The late check's intermediates, consumed again when a completed
      // classification decides whether its outcome contradicts the skip that
      // the same inputs would have licensed.
      let lateNowMs: number | undefined;
      let lateAttempt: GitHeldAttempt | undefined;
      let lateInputsMatch = false;
      let lateFloorElapsed = false;
      let phase: "early" | "early-running" | "steady" | "steady-running" | "classification" | "done" = "early";

      const refuseOutOfPhase = (operation: string): void => {
        env.log(`git-sync WARNING ${relPath}: refused out-of-phase held ${operation}`);
      };

      /** Preserve the exact sidecar transition shared by the early optimization
       * and the authoritative post-protocol held check. */
      // Design 273 P2: this runs on EVERY skipping pull. It used to CLEAR the
      // record for ownership-only holds, which re-deleted what the follow site
      // had just restored one pull later, and whose clear/set cycle reset
      // `deferredSince` — leaving a multi-day hold permanently young enough to
      // count as a quiet transient, and therefore permanently invisible. It now
      // leaves the standing record exactly as it is, preserving the age.
      const retain = (priorAttempt: GitHeldAttempt): boolean => {
        if (!heldBlockersAllowSkip(priorAttempt.blockers)) return false;
        // A record that already stands needs NOTHING written. Re-stamping its
        // `lastSeen` on every skipping pull made the packet semantically newer
        // (sync-published-intent's deferralSemantic), so a fleet held on 51
        // repos paid 51 durable record writes per pull to say what the record
        // already said. Only the repo whose hold has no record yet writes one.
        if (env.deferrals.standingApply(relPath)) return true;
        if (!gitOwnershipNoEscalateEnabled() || !ownershipBlockersArePerRefOnly(priorAttempt.blockers)) return false;
        env.deferrals.restandApply(relPath, { reason: "worktree-ownership" });
        return true;
      };

      return {
        async earlySkip(input) {
          if (phase !== "early") {
            refuseOutOfPhase("early check");
            return false;
          }
          phase = "early-running";
          const priorAttempt = input.pending && incoming ? input.attempt : undefined;
          const decision = gitHeldSkipEnabled() && priorAttempt
            ? await addTimedMs(timings, "heldInputMs", () => earlyHeldAttemptDecision({
                root: env.root, relPath, incoming: incoming!, attempt: priorAttempt,
                partial: input.partial, nowMs: env.now?.(),
              }))
            : { matches: false, reason: priorAttempt ? "disabled" : "no-attempt" };
          if (trace) trace.earlyReason = decision.reason;
          if (decision.matches && priorAttempt && retain(priorAttempt)) {
            if (trace) {
              trace.earlySkip = true;
              trace.matchConsulted = true;
              trace.mismatch = "none";
              trace.earlyReason = "none";
              trace.blocker = namedBlocker(priorAttempt.blockers, "none");
            }
            phase = "done";
            return true;
          }
          if (trace && decision.matches) trace.earlyReason = "retention-ineligible";
          phase = "steady";
          return false;
        },

        async steadySkip(input) {
          if (phase !== "steady") {
            refuseOutOfPhase("steady check");
            return false;
          }
          phase = "steady-running";
          lateNowMs = env.now?.();
          lateAttempt = input.attempt;
          const priorAttempt = input.attempt;
          const observation = priorAttempt
            ? await addTimedMs(timings, "heldInputMs", () => observeHeldInputs({
                root: env.root, relPath, incoming: incoming!,
                record: input.record, partial: input.partial,
                stateNonce: input.stateNonce,
                effectiveBaseIndexProjection: input.effectiveBaseIndexProjection,
                effectiveIncomingIndexProjection:
                  incomingIndexArtifactDescriptor(incoming!) === priorAttempt.incomingIndexArtifactDescriptor
                    ? priorAttempt.effectiveIncomingIndexProjection
                    : undefined,
                reflogPaths: priorAttempt.reflogs.map((entry) => entry.path),
              }))
            : undefined;
          if (priorAttempt && observation) {
            if (trace) {
              trace.matchConsulted = true;
              trace.mismatch = heldAttemptMismatchField(priorAttempt, observation, lateNowMs)?.toString() ?? "none";
            }
            lateInputsMatch = lateNowMs === undefined
              ? heldAttemptMatches(priorAttempt, observation)
              : heldAttemptMatches(priorAttempt, observation, lateNowMs);
          } else if (trace && priorAttempt) {
            trace.mismatch = "observation-unavailable";
          }
          lateFloorElapsed = priorAttempt !== undefined && (lateNowMs === undefined
            ? heldAttemptFloorElapsed(priorAttempt)
            : heldAttemptFloorElapsed(priorAttempt, lateNowMs));
          if (gitHeldSkipEnabled() && priorAttempt && observation && lateInputsMatch && !lateFloorElapsed
            && retain(priorAttempt)) {
            // A compatibility attempt can prove the late matcher while lacking the
            // explicit key required by the cheap gate. Re-store the exact matched
            // inputs so the primary state-save packet upgrades even a deferred repo;
            // artifact settlement is not this transition's persistence owner.
            // Preserve `at`: migration must not reset the independent safety-floor clock.
            env.attempts[relPath] = createHeldAttempt(observation, priorAttempt.blockers, priorAttempt.at);
            if (trace) trace.blocker = namedBlocker(priorAttempt.blockers, "none");
            phase = "done";
            return true;
          }
          phase = "classification";
          return false;
        },

        async recordClassification(input) {
          if (phase !== "classification") {
            refuseOutOfPhase("classification recording");
            return;
          }
          phase = "done";
          if (!input.trustedFingerprint || !input.expectedWorktreeRegistryDigest) {
            env.attempts[relPath] = null;
            return;
          }
          const options: ObserveHeldInputsOptions = {
            root: env.root, relPath, incoming: incoming!,
            record: input.record,
            partial: input.partial,
            stateNonce: input.stateNonce, reflogPaths: input.reflogPaths,
            trustedFingerprint: input.trustedFingerprint,
            effectiveBaseIndexProjection: input.effectiveBaseIndexProjection,
            effectiveIncomingIndexProjection: input.effectiveIncomingIndexProjection,
            expectedWorktreeRegistryDigest: input.expectedWorktreeRegistryDigest,
          };
          if (input.boundBase !== undefined) options.boundBase = input.boundBase;
          if (input.boundOrigins !== undefined) options.boundOrigins = input.boundOrigins;
          const observed = await addTimedMs(timings, "heldInputMs", () => observeHeldInputs(options));
          if (!observed) {
            env.attempts[relPath] = null;
            return;
          }
          const merged = sortedTypedBlockers(input.blockers);
          if (lateFloorElapsed && lateInputsMatch && lateAttempt && !sameHeldOutcome(lateAttempt.blockers, merged)) {
            env.log(`git-sync WARNING ${relPath}: held-skip fingerprint miss`);
          }
          env.attempts[relPath] = lateNowMs === undefined
            ? createHeldAttempt(observed, merged)
            : createHeldAttempt(observed, merged, new Date(lateNowMs).toISOString());
        },

        noteBlockers(blockers, fallback) {
          if (trace) trace.blocker = namedBlocker(blockers, fallback);
        },

        emitTrace({ result, wallMs }) {
          if (!trace || !timings) return;
          const deferral = env.deferrals.standingApply(relPath);
          // Composer-held repos report `applied`, so gating on `deferred` blinded
          // the diagnostic on exactly the population it explains (design 270 §1.2).
          if (trace.blocker === "none" && deferral) trace.blocker = `apply/${deferral.reason}`;
          const namedMs = timings.fetchDecryptMs + timings.bundleVerifyMs + timings.gitImportMs
            + timings.classifyMs + timings.standingProofMs;
          env.log(`git-sync held-trace repo=${JSON.stringify(relPath)} storedAttempt=${trace.storedAttempt ? 1 : 0} earlySkip=${trace.earlySkip ? 1 : 0} matchConsulted=${trace.matchConsulted ? 1 : 0} mismatch=${trace.mismatch} earlyReason=${trace.earlyReason} blocker=${trace.blocker} fetchDecryptMs=${Math.round(timings.fetchDecryptMs)} verifyMs=${Math.round(timings.bundleVerifyMs)} importMs=${Math.round(timings.gitImportMs)} classifyMs=${Math.round(timings.classifyMs)} supersessionProofMs=${Math.round(timings.standingProofMs)} otherMs=${Math.round(Math.max(0, wallMs - namedMs))} allMs=${wallMs}`);
        },
      };
    },
  };
}
