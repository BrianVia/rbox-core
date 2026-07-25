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
import { branchesCheckedOutElsewhereStrict } from "../../engine/git/apply.js";
import { readAllRefsStrict } from "../../engine/git/refs.js";
import { addTimedMs, readHead, repoCtx, type GitChainTimings } from "../../engine/git/shared.js";
import type { BranchTransitionWitness, LockedBranchProof } from "./base-composer.js";

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
  /** HEAD bytes are reserved by this transaction unless checkout owns HEAD. */
  headReservation?: { content: string; currentRef: boolean };
}

export interface CommittedBranchTransition {
  witness: BranchTransitionWitness;
  lockedProof: LockedBranchProof & { witness: BranchTransitionWitness };
}

/** A prepared, verify-only proof that a branch is absent. It reserves HEAD and
 * verifies the ref at the zero OID, but authors no artifact and mutates no ref. */
export interface PlannedAbsentBranchVerification {
  repoDir: string;
  ref: string;
  lines: string[];
  headReservation: NonNullable<PlannedBranchTransition["headReservation"]>;
}

export async function planAbsentBranchVerification(
  repoDir: string,
  ref: string,
): Promise<PlannedAbsentBranchVerification> {
  branchRefHash(ref);
  const head = await reserveNonRacingHead(repoDir, ref, true);
  if (!head.reservation) throw new Error("absence verification lacks a reserved HEAD observation");
  if (head.reservation.currentRef) throw new Error("current branch cannot be verified as a deletion");
  return {
    repoDir,
    ref,
    lines: sortedUniqueLines([...head.lines, `verify ${ref} ${ZERO_OID}`]),
    headReservation: head.reservation,
  };
}

export async function commitAbsentBranchVerification(
  plan: PlannedAbsentBranchVerification,
  lockedSecondProof: () => Promise<void> = async () => {},
  chainTimings?: GitChainTimings,
): Promise<void> {
  if (plan.headReservation.currentRef) throw new Error("current branch cannot be verified as a deletion");
  await runPreparedUpdateRefTransaction(plan.repoDir, plan.lines, async () => {
    const ctx = await addTimedMs(chainTimings, "ownershipMs", () => repoCtx(plan.repoDir));
    if (!ctx) throw new Error("repository disappeared at prepared absence boundary");
    const [strict, owned, head] = await addTimedMs(chainTimings, "ownershipMs", () => Promise.all([
      readAllRefsStrict(plan.repoDir),
      branchesCheckedOutElsewhereStrict(ctx).then((result) => {
        if (result.status === "unreadable") throw result.cause;
        return result.owned;
      }),
      readHead(ctx),
    ]));
    if (strict.status === "unreadable") throw new Error(`ref-read-unreadable: ${strict.marker}`);
    if (strict.refs[plan.ref] !== undefined) throw new Error("branch appeared at prepared absence boundary");
    if (head !== plan.headReservation.content) throw new Error("HEAD changed at prepared absence boundary");
    if (owned.has(plan.ref)) throw new Error("absent branch became sibling-owned at prepared absence boundary");
    await addTimedMs(chainTimings, "ownershipMs", lockedSecondProof);
  }, {
    ...(chainTimings ? { onExclusiveMs: (ms: number) => { chainTimings.refTxnExclusiveMs += ms; } } : {}),
  });
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
  /** Checkout transactions reserve/mutate HEAD themselves. */
  reserveHead?: boolean;
}

function sortedUniqueLines(lines: readonly string[]): string[] {
  const parsed = lines.map((line) => {
    const match = /^(?:create|update|delete|verify|symref-verify) (\S+)(?: |$)/.exec(line);
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

async function reserveNonRacingHead(
  repoDir: string,
  ref: string,
  enabled: boolean,
): Promise<{ lines: string[]; reservation?: PlannedBranchTransition["headReservation"] }> {
  if (!enabled) return { lines: [] };
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while reserving HEAD");
  const content = await readHead(ctx);
  if (content.startsWith("ref: ")) {
    const target = content.slice(5);
    // Updating HEAD's current referent already reserves HEAD.lock; Git rejects
    // an additional symref-verify in that exact shape.
    return {
      lines: target === ref ? [] : [`symref-verify HEAD ${target}`],
      reservation: { content, currentRef: target === ref },
    };
  }
  if (!HEX40.test(content)) throw new Error("unreadable detached HEAD while planning branch transition");
  return { lines: [`verify HEAD ${content}`], reservation: { content, currentRef: false } };
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
  const head = await reserveNonRacingHead(input.repoDir, input.ref, input.reserveHead !== false);
  const extra = [...(input.extraTransactionLines ?? []), ...head.lines];

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
      ...(head.reservation ? { headReservation: head.reservation } : {}),
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
    ...(head.reservation ? { headReservation: head.reservation } : {}),
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
  expectedReflogFingerprint?: string;
  reserveHead?: boolean;
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
  const head = await reserveNonRacingHead(input.repoDir, input.ref, input.reserveHead !== false);
  const extra = [...(input.extraTransactionLines ?? []), ...head.lines];

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
      ...(input.expectedReflogFingerprint ? { expectedReflogFingerprint: input.expectedReflogFingerprint } : {}),
      ...(head.reservation ? { headReservation: head.reservation } : {}),
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
    ...(input.expectedReflogFingerprint ? { expectedReflogFingerprint: input.expectedReflogFingerprint } : {}),
    ...(head.reservation ? { headReservation: head.reservation } : {}),
  };
}

export async function commitPlannedBranchTransition(
  plan: PlannedBranchTransition,
  lockedSecondProof: () => Promise<void> = async () => {},
  chainTimings?: GitChainTimings,
): Promise<CommittedBranchTransition> {
  if (!plan.headReservation) throw new Error("standalone branch transition lacks a reserved HEAD observation");
  let lockedObservation: Omit<LockedBranchProof, "liveOid" | "witness" | "reflogEpisode" | "artifactsClear" | "reflogStable"> | undefined;
  await runPreparedUpdateRefTransaction(plan.repoDir, plan.lines, async () => {
    if (plan.expectedReflogFingerprint) {
      const locked = await addTimedMs(chainTimings, "reflogMs", () => readRefReflogFingerprint(plan.repoDir, plan.ref));
      if (locked.sha256 !== plan.expectedReflogFingerprint) throw new Error("branch reflog changed at prepared transaction boundary");
    }
    const ctx = await addTimedMs(chainTimings, "ownershipMs", () => repoCtx(plan.repoDir));
    if (!ctx) throw new Error("repository disappeared at prepared transaction boundary");
    const [refs, owned, head] = await addTimedMs(chainTimings, "ownershipMs", () => Promise.all([
      readAllRefsStrict(plan.repoDir).then((result) => {
        if (result.status === "unreadable") throw new Error(`ref-read-unreadable: ${result.marker}`);
        return result.refs;
      }),
      branchesCheckedOutElsewhereStrict(ctx).then((result) => {
        if (result.status === "unreadable") throw result.cause;
        return result.owned;
      }),
      readHead(ctx),
    ]));
    if ((refs[plan.ref] ?? null) !== plan.beforeOid) throw new Error("branch changed at prepared transaction boundary");
    if (head !== plan.headReservation!.content) throw new Error("HEAD changed at prepared transaction boundary");
    if (owned.has(plan.ref)) throw new Error("branch became sibling-owned at prepared transaction boundary");
    await addTimedMs(chainTimings, "ownershipMs", lockedSecondProof);
    lockedObservation = {
      ownershipStable: true,
      currentRef: plan.headReservation!.currentRef,
      siblingOwned: false,
    };
  }, {
    ...(plan.reflogMessage ? { reflogMessage: plan.reflogMessage } : {}),
    ...(chainTimings ? { onExclusiveMs: (ms: number) => { chainTimings.refTxnExclusiveMs += ms; } } : {}),
  });
  if (!lockedObservation) throw new Error("branch transaction committed without locked observations");
  return {
    witness: plan.witness,
    lockedProof: {
      liveOid: plan.afterOid,
      witness: plan.witness,
      ...(plan.witness.kind === "present" ? { reflogEpisode: plan.witness.episode } : {}),
      artifactsClear: true,
      reflogStable: true,
      ...lockedObservation,
    },
  };
}
