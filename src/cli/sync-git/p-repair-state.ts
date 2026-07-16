import {
  applyStateSavePacket,
  expectedStateNonce,
  loadRawState,
  repoRecordsForState,
  statePath,
  type RepoRecord,
} from "../config.js";
import type { BasePresentPayload, PreparedProtocolRef } from "../../engine/git/base-artifacts.js";
import { parsePRepairReceipt, type PRepairReceipt } from "../../engine/git/p-repair.js";
import type { PRepairStatePort, PRepairStateSnapshot } from "../../engine/git/p-repair-transaction.js";
import type { GitRefScope } from "../../engine/types.js";
import type { BranchTransitionWitness, RepoBaseProof } from "./base-composer.js";
import { carryRepoBaseProof } from "./base-composer.js";

export interface PRepairStatePortInput {
  root: string;
  stream: string;
  relPath: string;
  repoKind: "dir" | "pointer";
  effectiveRefScope: GitRefScope;
  p: PreparedProtocolRef<BasePresentPayload>;
}

export type PRepairReceiptStatePortInput = Omit<PRepairStatePortInput, "p"> & { receipt: PRepairReceipt };

const counter = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

function snapshot(stateRevision: number, record: RepoRecord, ref: string): PRepairStateSnapshot {
  return {
    repoGen: record.repoGen,
    stateRevision,
    incomingKey: record.partial?.incomingKey ?? null,
    baseOid: record.base?.refs[ref] ?? null,
  };
}

function sameSnapshot(left: PRepairStateSnapshot, right: PRepairStateSnapshot): boolean {
  return left.repoGen === right.repoGen && left.stateRevision === right.stateRevision
    && left.incomingKey === right.incomingKey && left.baseOid === right.baseOid;
}

function witnessFor(p: PreparedProtocolRef<BasePresentPayload>): Extract<BranchTransitionWitness, { kind: "present" }> {
  return {
    kind: "present",
    ref: p.payload.ref,
    priorOid: p.payload.priorOid,
    nextOid: p.payload.nextOid,
    lineageHash: p.payload.lineageHash,
    repositoryIdentityHash: p.payload.repositoryIdentityHash,
    artifactRef: p.ref,
    artifactOid: p.targetOid,
    episode: p.payload.episode,
  };
}

/** Concrete composer-backed state port used while the final Git transaction is
 * prepared. It changes only BASE[R] and the exact P-bound partial member. */
export function createPRepairStatePort(input: PRepairStatePortInput): PRepairStatePort {
  const witness = witnessFor(input.p);
  const receiptOnly = async (
    expected: PRepairStateSnapshot,
    mode: "replace" | "compact" | "restore",
    receipt: PRepairReceipt,
    prior?: PRepairReceipt,
  ): Promise<"accepted" | "rejected"> => {
    parsePRepairReceipt(receipt);
    if (prior) parsePRepairReceipt(prior);
    const state = await loadRawState(input.root);
    if (!state || state.stream !== input.stream) return "rejected";
    const record = repoRecordsForState(state)[input.relPath];
    if (!record || !sameSnapshot(snapshot(counter(state.stateRevision), record, witness.ref), expected)) return "rejected";
    const existingPartial = record.partial ?? {
      incomingKey: `p:${witness.episode}`,
      checkoutPending: true,
      appliedRefs: {},
      heldRefs: {},
      configApplied: true,
    };
    const current = existingPartial.pRepaired?.[witness.ref];
    if ((mode === "replace" || mode === "compact") && JSON.stringify(current) !== JSON.stringify(prior ?? receipt)) return "rejected";
    if (mode === "restore" && current !== undefined) return "rejected";
    const pRepaired = { ...(existingPartial.pRepaired ?? {}) };
    if (mode === "compact") delete pRepaired[witness.ref]; else pRepaired[witness.ref] = receipt;
    const appliedRefs = { ...existingPartial.appliedRefs };
    if (mode === "restore") delete appliedRefs[witness.ref];
    const partial = {
      ...existingPartial,
      appliedRefs,
      ...(Object.keys(pRepaired).length ? { pRepaired } : {}),
    };
    if (!Object.keys(pRepaired).length) delete partial.pRepaired;
    const { repoGen: _repoGen, ...withoutGeneration } = record;
    const proof = carryRepoBaseProof(witness.lineageHash);
    const result = await applyStateSavePacket(input.root, {
      expectedStream: input.stream,
      expectedNonce: expectedStateNonce(state),
      sourceGlobalSeq: state.lastSyncedSequence,
      repos: [{
        relPath: input.relPath,
        expectedRepoGen: expected.repoGen,
        newRecord: { ...withoutGeneration, partial },
        baseProof: proof,
      }],
    });
    return result.status === "accepted" ? "accepted" : "rejected";
  };
  return {
    stateLockIdentity: statePath(input.root),
    async read() {
      const state = await loadRawState(input.root);
      if (!state || state.stream !== input.stream) throw new Error("P-repair state stream unavailable");
      const record = repoRecordsForState(state)[input.relPath];
      if (!record) throw new Error("P-repair RepoRecord unavailable");
      return snapshot(counter(state.stateRevision), record, witness.ref);
    },
    async cas({ expected, nextBaseOid, receipt, lockedObservation }) {
      parsePRepairReceipt(receipt);
      if (lockedObservation.liveOid !== receipt.q.value.observed.liveOid
        || lockedObservation.reflogSha256 !== receipt.reflog.sha256
        || !lockedObservation.artifactsValidated || !lockedObservation.keepRefsVerified) return "rejected";
      const state = await loadRawState(input.root);
      if (!state || state.stream !== input.stream) return "rejected";
      const records = repoRecordsForState(state);
      const record = records[input.relPath];
      if (!record || !sameSnapshot(snapshot(counter(state.stateRevision), record, witness.ref), expected)
        || !record.base) return "rejected";
      const refs = { ...record.base.refs };
      if (nextBaseOid === null) delete refs[witness.ref]; else refs[witness.ref] = nextBaseOid;
      const existingPartial = record.partial ?? {
        incomingKey: `p:${witness.episode}`,
        checkoutPending: true,
        appliedRefs: {},
        heldRefs: {},
        configApplied: true,
      };
      const appliedRefs = { ...existingPartial.appliedRefs };
      delete appliedRefs[witness.ref];
      const partial = {
        ...existingPartial,
        appliedRefs,
        pRepaired: { ...(existingPartial.pRepaired ?? {}), [witness.ref]: receipt },
      };
      const disposition = receipt.baseDisposition;
      const proof: RepoBaseProof = {
        authority: {
          kind: "p-repair",
          lineageHash: witness.lineageHash,
          repositoryIdentityHash: witness.repositoryIdentityHash,
          repairs: { [witness.ref]: { witness, disposition } },
        },
        lockedProof: {
          repoKind: input.repoKind,
          effectiveRefScope: input.effectiveRefScope,
          checkoutComplete: false,
          branches: {
            [witness.ref]: {
              liveOid: lockedObservation.liveOid,
              witness,
              artifactsClear: true,
              ownershipStable: true,
              reflogStable: true,
              currentRef: false,
              siblingOwned: false,
            },
          },
          safeRefs: {},
        },
      };
      const { repoGen: _repoGen, ...withoutGeneration } = record;
      const result = await applyStateSavePacket(input.root, {
        expectedStream: input.stream,
        expectedNonce: expectedStateNonce(state),
        sourceGlobalSeq: state.lastSyncedSequence,
        repos: [{
          relPath: input.relPath,
          expectedRepoGen: expected.repoGen,
          newRecord: { ...withoutGeneration, base: { ...record.base, refs }, partial },
          baseProof: proof,
        }],
      });
      return result.status === "accepted" ? "accepted" : "rejected";
    },
    replaceReceipt: ({ expected, prior, next }) => receiptOnly(expected, "replace", next, prior),
    compactReceipt: ({ expected, receipt }) => receiptOnly(expected, "compact", receipt),
    restoreReceipt: ({ expected, receipt }) => receiptOnly(expected, "restore", receipt),
  };
}

/** Terminal Q-exact rows no longer have P on disk. The accepted receipt retains
 * every witness field needed for receipt-only compaction/restoration. */
export function createPRepairStatePortFromReceipt(input: PRepairReceiptStatePortInput): PRepairStatePort {
  const receipt = parsePRepairReceipt(input.receipt);
  const payload = receipt.q.value.p.payload;
  return createPRepairStatePort({
    ...input,
    p: {
      ref: receipt.p.ref,
      targetOid: receipt.p.targetOid,
      payload: {
        v: 2,
        lineageHash: receipt.lineageHash,
        repositoryIdentityHash: receipt.repositoryIdentityHash,
        ref: receipt.ref,
        episode: receipt.episode,
        priorOid: payload.priorOid,
        nextOid: payload.nextOid,
      },
      // Receipt-only methods never consume canonical P bytes.
      payloadBytes: new Uint8Array(),
    },
  });
}
