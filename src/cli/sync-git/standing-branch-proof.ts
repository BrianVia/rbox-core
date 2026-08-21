/** Never: Git/protocol locking, state-port construction, persistence, deferral writes, or follower preparation. */
import type { GitRefScope, GitSection } from "../../engine/index.js";
import type { ArtifactBinding } from "./repo-lineage.js";
import type { ArtifactReadResult, BasePresentPayload, PreparedProtocolRef } from "./base-artifacts.js";
import type { PRepairAttemptResult, PRepairResumeResult } from "./p-repair-transaction.js";
import type { PRepairReceipt, PRepairRetryAction } from "./p-repair.js";
import type { GitDeferralReason, RepoRecord, SyncState } from "../config.js";
import { repoRecordsForState } from "../config.js";
import type { FollowerBranchProtocol, FollowerBranchProtocolResult } from "./follower-protocol.js";
import type { ExactPSettlementResult } from "./p-settlement.js";

/** The exact repository and wire section this proof transition is bound to. */
export interface StandingBranchProofIdentity {
  readonly relPath: string;
  readonly incomingKey: string;
}

export interface StandingBranchProofInput {
  readonly identity: StandingBranchProofIdentity;
  /** Lineage the transition starts from; every durable row replaces it. */
  readonly state: SyncState;
  readonly record: RepoRecord | undefined;
  /** BASE the caller's protocol was planned against. */
  readonly serializedBase: GitSection | undefined;
  /** Scope used while no serialized BASE stands for this repository. */
  readonly incomingRefScope: GitRefScope;
  readonly protocol: FollowerBranchProtocol;
  /** Maximum settlement passes; exhaustion is a refusal, never a fallback. */
  readonly retryBudget: number;
}

/**
 * Lineage the caller must adopt before it looks at anything else. A durable row
 * can complete and a later row still refuse, so every result — including the
 * refusals — carries the state and record that were already made durable.
 */
export interface StandingProofCarry {
  readonly state: SyncState;
  readonly base: GitSection | undefined;
  /** Reloaded record the caller must install, or undefined when the reloaded
   * lineage no longer projects this repository at all. */
  readonly recoveredRecord: RepoRecord | undefined;
}

export interface GitTransitionHold {
  readonly reason: string;
  readonly deferralReason: GitDeferralReason;
}

export interface ProofFailureReceipt extends GitTransitionHold, StandingBranchProofIdentity {
  readonly passes: number;
  readonly standingArtifacts: number;
}

export type StandingProofOutcome = "compacted" | "settled" | "repaired" | "retried" | "absent";

export interface SettlementDisposition extends StandingBranchProofIdentity {
  readonly passes: number;
  /** Ordered per-row outcomes, terminal compaction first. */
  readonly outcomes: readonly StandingProofOutcome[];
}

export type StandingBranchProofResult =
  | {
      readonly kind: "settled";
      readonly carry: StandingProofCarry;
      readonly protocol: FollowerBranchProtocol;
      readonly disposition: SettlementDisposition;
    }
  /** Nothing is serialized to settle the standing P against, so the transition
   * stops settling and licenses the caller to land a FIRST BASE instead. */
  | {
      readonly kind: "landing";
      readonly carry: StandingProofCarry;
      readonly protocol: FollowerBranchProtocol;
    }
  | { readonly kind: "held"; readonly carry: StandingProofCarry; readonly hold: GitTransitionHold }
  | { readonly kind: "retry-exhausted"; readonly carry: StandingProofCarry; readonly lastProof: ProofFailureReceipt };

/** One bounded repair attempt against the standing P of the current lineage. */
export interface StandingRepairAttempt {
  readonly stream: string;
  readonly effectiveRefScope: GitRefScope;
  readonly p: PreparedProtocolRef<BasePresentPayload>;
  readonly repairAt: string;
  readonly mismatches: { readonly live: boolean; readonly reflog: boolean; readonly baseRefs: boolean };
  validateArtifacts(): Promise<boolean>;
}

/**
 * The effect vocabulary of this transition. Repository context, protocol
 * locking, and state-port construction are the caller's; the transition only
 * orders these rows and decides what each observation means.
 */
export interface StandingProofPort {
  now(): string;
  inspectTerminalReceipt(receipt: PRepairReceipt): Promise<{ action: PRepairRetryAction }>;
  compactTerminalReceipt(input: {
    receipt: PRepairReceipt;
    stream: string;
    effectiveRefScope: GitRefScope;
  }): Promise<"accepted" | "rejected">;
  settleExactArtifact(input: {
    state: SyncState;
    binding: ArtifactBinding;
    p: PreparedProtocolRef<BasePresentPayload>;
  }): Promise<ExactPSettlementResult>;
  resumeAcceptedRepair(input: {
    receipt: PRepairReceipt;
    validateArtifacts(): Promise<boolean>;
  }): Promise<PRepairResumeResult>;
  refreshAcceptedRepair(input: StandingRepairAttempt & { acceptedReceipt: PRepairReceipt }): Promise<PRepairAttemptResult>;
  runRepairAttempt(input: StandingRepairAttempt): Promise<PRepairAttemptResult>;
  readStandingArtifact(binding: ArtifactBinding, ref: string): Promise<ArtifactReadResult<BasePresentPayload>>;
  reloadState(): Promise<SyncState | undefined>;
  refreshProtocol(source: {
    state: SyncState;
    record: RepoRecord | undefined;
    base: GitSection | undefined;
  }): Promise<FollowerBranchProtocolResult>;
}

const ARTIFACT_HOLD = (reason: string): GitTransitionHold => ({ reason, deferralReason: "artifact" });

/**
 * A standing P makes serialized positive BASE unavailable until exact
 * settlement or bounded repair completes. Every successful row mandates a full
 * re-plan with fresh state, artifacts, attestations, and snapshots, so the
 * lineage this transition carries — not the caller's entry lineage — is what
 * every later row is planned against.
 */
export async function settleStandingBranchProof(
  input: StandingBranchProofInput,
  effects: StandingProofPort,
): Promise<StandingBranchProofResult> {
  const { relPath, incomingKey } = input.identity;
  let state = input.state;
  let record = input.record;
  let base = input.serializedBase;
  let recoveredRecord: RepoRecord | undefined;
  let protocol = input.protocol;
  const outcomes: StandingProofOutcome[] = [];
  let passes = 0;

  const carry = (): StandingProofCarry => ({ state, base, recoveredRecord });
  const held = (reason: string): StandingBranchProofResult => ({ kind: "held", carry: carry(), hold: ARTIFACT_HOLD(reason) });
  const scope = (): GitRefScope => base?.refScope ?? input.incomingRefScope;
  /** Adopt a lineage that a durable row just produced. A lineage that no longer
   * projects this repository leaves the prior record and BASE standing. */
  const adopt = (next: SyncState): void => {
    state = next;
    const refreshed = repoRecordsForState(state)[relPath];
    if (refreshed) {
      record = refreshed;
      recoveredRecord = refreshed;
      base = refreshed.base;
    }
  };

  for (const [ref, receipt] of Object.entries(input.record?.partial?.pRepaired ?? {})) {
    const inspected = await effects.inspectTerminalReceipt(receipt);
    if (inspected.action === "compact-and-restart") {
      if (await effects.compactTerminalReceipt({ receipt, stream: state.stream, effectiveRefScope: scope() }) !== "accepted") {
        return held(`P-repair terminal receipt CAS rejected for ${ref}`);
      }
      const refreshed = await effects.reloadState();
      if (!refreshed) return held("P-repair terminal state reload failed");
      adopt(refreshed);
      outcomes.push("compacted");
    } else if (inspected.action === "corruption-hold" || inspected.action === "artifact-contradiction-hold") {
      return held(`P-repair terminal inspection refused ${ref}: ${inspected.action}`);
    }
  }

  for (let pass = 0; protocol.presentArtifacts.length > 0 && pass < input.retryBudget; pass++) {
    passes = pass + 1;
    const p = protocol.presentArtifacts[0]!;
    const exact = await effects.settleExactArtifact({ state, binding: protocol.binding, p });
    if (exact.status === "hold") {
      return exact.code === "base-absent"
        ? { kind: "landing", carry: carry(), protocol }
        : held(exact.reason);
    }
    if (exact.status === "moved") {
      const disposition = protocol.artifacts[p.payload.ref];
      const binding = protocol.binding;
      const validateArtifacts = async (): Promise<boolean> => {
        const fresh = await effects.readStandingArtifact(binding, p.payload.ref);
        return fresh.status === "valid" && fresh.artifact.targetOid === p.targetOid
          && disposition?.present === "valid-owning" && disposition.keeps === "exact"
          && disposition.absence === "absent" && disposition.settledAbsence === "absent";
      };
      const attempt: StandingRepairAttempt = {
        stream: state.stream,
        effectiveRefScope: scope(),
        p,
        repairAt: effects.now(),
        mismatches: { live: exact.reason === "live", reflog: exact.reason === "reflog", baseRefs: exact.reason === "base-shape" },
        validateArtifacts,
      };
      const accepted = record?.partial?.pRepaired?.[p.payload.ref];
      let repaired: PRepairAttemptResult;
      if (accepted) {
        const resumed = await effects.resumeAcceptedRepair({ receipt: accepted, validateArtifacts });
        repaired = resumed.status === "refresh-receipt"
          ? await effects.refreshAcceptedRepair({ ...attempt, acceptedReceipt: accepted })
          : resumed;
      } else {
        repaired = await effects.runRepairAttempt(attempt);
      }
      if (repaired.status === "hold") return held(repaired.reason);
      if (repaired.status === "retry") {
        outcomes.push("retried");
        continue;
      }
      const refreshed = await effects.reloadState();
      if (!refreshed) return held("P-repair state reload failed");
      adopt(refreshed);
      outcomes.push("repaired");
    } else if (exact.status === "settled") {
      adopt(exact.state);
      outcomes.push("settled");
    } else {
      outcomes.push("absent");
      break;
    }
    const replanned = await effects.refreshProtocol({ state, record, base });
    if (replanned.status === "hold") return held(replanned.reason);
    protocol = replanned.protocol;
  }

  if (protocol.presentArtifacts.length > 0) {
    return {
      kind: "retry-exhausted",
      carry: carry(),
      lastProof: {
        relPath,
        incomingKey,
        ...ARTIFACT_HOLD("P settlement did not stabilize"),
        passes,
        standingArtifacts: protocol.presentArtifacts.length,
      },
    };
  }
  return { kind: "settled", carry: carry(), protocol, disposition: { relPath, incomingKey, passes, outcomes } };
}
