import crypto from "node:crypto";
import {
  branchRefHash,
  lookupSettledAbsence,
  prepareBaseAbsentArtifact,
  prepareBasePresentArtifact,
  prepareRetireSettledAbsence,
  readBaseAbsentArtifact,
  readRefReflogFingerprint,
  runPreparedUpdateRefTransaction,
  type ArtifactBinding,
} from "../../engine/index.js";
import type { GitPartialApply } from "../config.js";
import type { BranchTransitionWitness } from "./base-composer.js";

const HEX40 = /^[0-9a-f]{40}$/;
const ZERO_OID = "0".repeat(40);

export interface PlannedBranchTransition {
  repoDir: string;
  ref: string;
  beforeOid: string | null;
  afterOid: string | null;
  lines: string[];
  /** Exact CAS inverse persisted by checkout/clean journals. */
  inverseLines: string[];
  witness: BranchTransitionWitness;
  partial: GitPartialApply["appliedRefs"][string];
  reflogMessage?: string;
  expectedReflogFingerprint?: string;
  settledAbsenceRetirement?: { ref: string; priorTargetOid: string; nextTargetOid: string | null };
}

export interface PlanBranchTransitionInput {
  repoDir: string;
  binding: ArtifactBinding;
  ref: string;
  beforeOid: string | null;
  afterOid: string | null;
  logicalBaseOid: string | null;
  extraTransactionLines?: readonly string[];
  episode?: string;
  expectedReflogFingerprint?: string;
}

function sortedUniqueLines(lines: readonly string[]): string[] {
  const parsed = lines.map((line) => {
    const match = /^(?:create|update|delete|verify) (\S+)(?: |$)/.exec(line);
    if (!match) throw new Error(`invalid branch transition command: ${line}`);
    return { line, ref: match[1]! };
  });
  const refs = new Set<string>();
  for (const item of parsed) {
    if (refs.has(item.ref)) throw new Error(`duplicate branch transition command for ${item.ref}`);
    refs.add(item.ref);
  }
  return parsed.sort((a, b) => Buffer.compare(Buffer.from(a.ref), Buffer.from(b.ref))).map(({ line }) => line);
}

/**
 * Typed planner for every non-checkout branch mutation. It writes immutable
 * payload objects while planning, but the only ref effects are returned as one
 * sorted expected-old transaction containing A or P/K and R together.
 */
export async function planBranchTransition(input: PlanBranchTransitionInput): Promise<PlannedBranchTransition> {
  branchRefHash(input.ref); // exact refs/heads grammar
  if ((input.beforeOid !== null && !HEX40.test(input.beforeOid)) || (input.afterOid !== null && !HEX40.test(input.afterOid))) {
    throw new Error("invalid branch transition OID");
  }
  if (input.beforeOid === input.afterOid) throw new Error("branch transition is a no-op");
  if (input.logicalBaseOid !== input.beforeOid) throw new Error("branch transition does not match logical BASE pre-state");
  const extra = [...(input.extraTransactionLines ?? [])];

  if (input.afterOid === null) {
    if (input.beforeOid === null) throw new Error("cannot delete an absent branch");
    const artifact = await prepareBaseAbsentArtifact(input.repoDir, input.binding, input.ref, input.beforeOid);
    const witness: BranchTransitionWitness = {
      kind: "absent", ref: input.ref, priorOid: input.beforeOid,
      lineageHash: input.binding.lineageHash, repositoryIdentityHash: input.binding.repositoryIdentityHash,
      artifactRef: artifact.ref, artifactOid: artifact.targetOid, source: "a",
    };
    return {
      repoDir: input.repoDir, ref: input.ref, beforeOid: input.beforeOid, afterOid: null,
      lines: sortedUniqueLines([...extra, ...artifact.transactionLines, `delete ${input.ref} ${input.beforeOid}`]),
      inverseLines: sortedUniqueLines([
        `create ${input.ref} ${input.beforeOid}`,
        `delete ${artifact.ref} ${artifact.targetOid}`,
      ]),
      witness,
      partial: { kind: "absent", artifactOid: artifact.targetOid },
      ...(input.expectedReflogFingerprint ? { expectedReflogFingerprint: input.expectedReflogFingerprint } : {}),
    };
  }

  const episode = input.episode ?? crypto.randomBytes(16).toString("hex");
  const artifact = await prepareBasePresentArtifact(input.repoDir, input.binding, input.ref, episode, input.beforeOid, input.afterOid);
  const retirement: string[] = [];
  const retirementInverse: string[] = [];
  let settledAbsenceRetirement: PlannedBranchTransition["settledAbsenceRetirement"];
  if (input.beforeOid === null) {
    const absent = await readBaseAbsentArtifact(input.repoDir, input.binding, input.ref);
    if (absent.status === "invalid") throw new Error(`invalid A blocks branch creation: ${absent.detail}`);
    if (absent.status === "valid") {
      retirement.push(`delete ${absent.artifact.ref} ${absent.artifact.targetOid}`);
      retirementInverse.push(`create ${absent.artifact.ref} ${absent.artifact.targetOid}`);
    }
    else if (await lookupSettledAbsence(input.repoDir, input.binding, input.ref)) {
      const settled = await prepareRetireSettledAbsence(input.repoDir, input.binding, input.ref);
      retirement.push(...settled.transactionLines);
      settledAbsenceRetirement = {
        ref: settled.ref, priorTargetOid: settled.priorTargetOid, nextTargetOid: settled.nextTargetOid,
      };
      retirementInverse.push(settled.nextTargetOid === null
        ? `create ${settled.ref} ${settled.priorTargetOid}`
        : `update ${settled.ref} ${settled.priorTargetOid} ${settled.nextTargetOid}`);
    }
  }
  const mutation = input.beforeOid === null
    ? `create ${input.ref} ${input.afterOid}`
    : `update ${input.ref} ${input.afterOid} ${input.beforeOid}`;
  const witness: BranchTransitionWitness = {
    kind: "present", ref: input.ref, priorOid: input.beforeOid, nextOid: input.afterOid,
    lineageHash: input.binding.lineageHash, repositoryIdentityHash: input.binding.repositoryIdentityHash,
    artifactRef: artifact.ref, artifactOid: artifact.targetOid, episode,
  };
  return {
    repoDir: input.repoDir, ref: input.ref, beforeOid: input.beforeOid, afterOid: input.afterOid,
    lines: sortedUniqueLines([...extra, ...artifact.transactionLines, ...retirement, mutation]),
    inverseLines: sortedUniqueLines([
      ...(input.beforeOid === null
        ? [`delete ${input.ref} ${input.afterOid}`]
        : [`update ${input.ref} ${input.beforeOid} ${input.afterOid}`]),
      `delete ${artifact.ref} ${artifact.targetOid}`,
      ...artifact.keepRefs.map((keep) => `delete ${keep.ref} ${keep.targetOid}`),
      ...retirementInverse,
    ]),
    witness,
    partial: { kind: "present", oid: input.afterOid, artifactOid: artifact.targetOid, episode },
    reflogMessage: episode,
    ...(settledAbsenceRetirement ? { settledAbsenceRetirement } : {}),
    ...(input.expectedReflogFingerprint ? { expectedReflogFingerprint: input.expectedReflogFingerprint } : {}),
  };
}

export interface PlanManualBranchTransitionInput {
  repoDir: string;
  binding: ArtifactBinding;
  ref: string;
  /** Exact snapshotted physical value used by the Git CAS. */
  physicalBeforeOid: string | null;
  afterOid: string | null;
  /** Logical protected BASE before the confirmed episode. */
  logicalBaseOid: string | null;
  extraTransactionLines?: readonly string[];
  episode?: string;
}

/**
 * Explicit-confirmation branch transition. Manual resolution is the one path
 * where the protected BASE pre-state and the displaced physical ref may differ.
 * The returned witness records Git's exact physical P transition, while the
 * manual composer decision separately binds the protected BASE predecessor.
 */
export async function planManualBranchTransition(input: PlanManualBranchTransitionInput): Promise<PlannedBranchTransition> {
  branchRefHash(input.ref);
  for (const value of [input.physicalBeforeOid, input.afterOid, input.logicalBaseOid]) {
    if (value !== null && !HEX40.test(value)) throw new Error("invalid manual branch transition OID");
  }
  const extra = [...(input.extraTransactionLines ?? [])];

  if (input.afterOid === null) {
    // A confirmed deletion of a local-only branch does not change BASE, but it
    // still receives the same durable deletion receipt and typed inverse. The
    // artifact records the displaced physical value in that shape.
    const priorOid = input.logicalBaseOid ?? input.physicalBeforeOid;
    if (priorOid === null) throw new Error("manual absent branch transition is a no-op");
    const artifact = await prepareBaseAbsentArtifact(input.repoDir, input.binding, input.ref, priorOid);
    const witness: BranchTransitionWitness = {
      kind: "absent", ref: input.ref, priorOid,
      lineageHash: input.binding.lineageHash, repositoryIdentityHash: input.binding.repositoryIdentityHash,
      artifactRef: artifact.ref, artifactOid: artifact.targetOid, source: "a",
    };
    const physical = input.physicalBeforeOid === null
      ? `verify ${input.ref} ${ZERO_OID}`
      : `delete ${input.ref} ${input.physicalBeforeOid}`;
    const inversePhysical = input.physicalBeforeOid === null
      ? `verify ${input.ref} ${ZERO_OID}`
      : `create ${input.ref} ${input.physicalBeforeOid}`;
    return {
      repoDir: input.repoDir, ref: input.ref, beforeOid: input.physicalBeforeOid, afterOid: null,
      lines: sortedUniqueLines([...extra, ...artifact.transactionLines, physical]),
      inverseLines: sortedUniqueLines([inversePhysical, `delete ${artifact.ref} ${artifact.targetOid}`]),
      witness,
      partial: { kind: "absent", artifactOid: artifact.targetOid },
    };
  }

  if (input.physicalBeforeOid === input.afterOid && input.logicalBaseOid !== null) {
    throw new Error("manual positive equality requires no-P authority");
  }
  const episode = input.episode ?? crypto.randomBytes(16).toString("hex");
  const artifact = await prepareBasePresentArtifact(
    input.repoDir, input.binding, input.ref, episode, input.physicalBeforeOid, input.afterOid,
  );
  const retirement: string[] = [];
  const retirementInverse: string[] = [];
  let settledAbsenceRetirement: PlannedBranchTransition["settledAbsenceRetirement"];
  if (input.logicalBaseOid === null) {
    const absent = await readBaseAbsentArtifact(input.repoDir, input.binding, input.ref);
    if (absent.status === "invalid") throw new Error(`invalid A blocks manual branch presence: ${absent.detail}`);
    if (absent.status === "valid") {
      retirement.push(`delete ${absent.artifact.ref} ${absent.artifact.targetOid}`);
      retirementInverse.push(`create ${absent.artifact.ref} ${absent.artifact.targetOid}`);
    } else if (await lookupSettledAbsence(input.repoDir, input.binding, input.ref)) {
      const settled = await prepareRetireSettledAbsence(input.repoDir, input.binding, input.ref);
      retirement.push(...settled.transactionLines);
      settledAbsenceRetirement = { ref: settled.ref, priorTargetOid: settled.priorTargetOid, nextTargetOid: settled.nextTargetOid };
      retirementInverse.push(settled.nextTargetOid === null
        ? `create ${settled.ref} ${settled.priorTargetOid}`
        : `update ${settled.ref} ${settled.priorTargetOid} ${settled.nextTargetOid}`);
    }
  }
  const mutation = input.physicalBeforeOid === null
    ? `create ${input.ref} ${input.afterOid}`
    : `update ${input.ref} ${input.afterOid} ${input.physicalBeforeOid}`;
  const inverseMutation = input.physicalBeforeOid === null
    ? `delete ${input.ref} ${input.afterOid}`
    : `update ${input.ref} ${input.physicalBeforeOid} ${input.afterOid}`;
  const witness: BranchTransitionWitness = {
    kind: "present", ref: input.ref, priorOid: input.physicalBeforeOid, nextOid: input.afterOid,
    lineageHash: input.binding.lineageHash, repositoryIdentityHash: input.binding.repositoryIdentityHash,
    artifactRef: artifact.ref, artifactOid: artifact.targetOid, episode,
  };
  return {
    repoDir: input.repoDir, ref: input.ref, beforeOid: input.physicalBeforeOid, afterOid: input.afterOid,
    lines: sortedUniqueLines([...extra, ...artifact.transactionLines, ...retirement, mutation]),
    inverseLines: sortedUniqueLines([
      inverseMutation,
      `delete ${artifact.ref} ${artifact.targetOid}`,
      ...artifact.keepRefs.map((keep) => `delete ${keep.ref} ${keep.targetOid}`),
      ...retirementInverse,
    ]),
    witness,
    partial: { kind: "present", oid: input.afterOid, artifactOid: artifact.targetOid, episode },
    reflogMessage: episode,
    ...(settledAbsenceRetirement ? { settledAbsenceRetirement } : {}),
  };
}

export async function commitPlannedBranchTransition(
  plan: PlannedBranchTransition,
  lockedSecondProof: () => Promise<void> = async () => {},
): Promise<BranchTransitionWitness> {
  await runPreparedUpdateRefTransaction(plan.repoDir, plan.lines, async () => {
    if (plan.expectedReflogFingerprint) {
      const locked = await readRefReflogFingerprint(plan.repoDir, plan.ref);
      if (locked.sha256 !== plan.expectedReflogFingerprint) throw new Error("branch reflog changed at prepared transaction boundary");
    }
    await lockedSecondProof();
  }, plan.reflogMessage ? { reflogMessage: plan.reflogMessage } : {});
  return plan.witness;
}
