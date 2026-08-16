import path from "node:path";
import { basePresentKeepRef, readBasePresentArtifact, type BasePresentPayload, type PreparedProtocolRef } from "./base-artifacts.js";
import { PreparedRefTransactionPrepareError, readRefReflogFingerprint, runPreparedUpdateRefTransaction } from "./keep-pins.js";
import { withProtocolLockClass, withRepoProtocolLocks } from "./protocol-locks.js";
import { type ArtifactBinding } from "./repo-lineage.js";
import { type RepoCtx } from "./git-state.js";
import { ZERO_OID } from "./git-state.js";
import {
  applyStateSavePacket,
  loadRawState,
  statePath,
} from "../sync-state-store.js";
import {
  type RepoRecordInput, type StateSaveOptions, type SyncState,
} from "../sync-state-model.js";
import {
  expectedStateNonce, repoRecordsForState,
} from "../sync-state-records.js";
import { presentWitnessFromPreparedRef, type RepoBaseProof } from "./base-composer.js";
import { MutationGateClosedError, type MutationBoundary, type MutationLease } from "../../engine/mutation-gate.js";

export type ExactPSettlementResult =
  | { status: "absent" }
  | { status: "settled"; state: SyncState; ref: string }
  | { status: "moved"; reason: "live" | "reflog" | "base-shape" }
  | { status: "hold"; reason: string };

class PSettlementMovementError extends Error {
  constructor(readonly movement: Extract<ExactPSettlementResult, { status: "moved" }>["reason"], message: string) {
    super(message);
    this.name = "PSettlementMovementError";
  }
}

function exactEpisodeTop(bytes: Uint8Array, payload: BasePresentPayload): boolean {
  const lines = Buffer.from(bytes).toString("latin1").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const top = lines.at(-1);
  if (!top) return false;
  const expectedOld = payload.priorOid ?? ZERO_OID;
  const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) [^\t]*\t([^\r\n]*)$/.exec(top);
  return !!match && match[1] === expectedOld && match[2] === payload.nextOid && match[3] === payload.episode;
}

function retirementLines(p: PreparedProtocolRef<BasePresentPayload>): string[] {
  const binding = { lineageHash: p.payload.lineageHash, repositoryIdentityHash: p.payload.repositoryIdentityHash };
  return [
    `verify ${p.payload.ref} ${p.payload.nextOid}`,
    `delete ${p.ref} ${p.targetOid}`,
    ...(p.payload.priorOid === null ? [] : [
      `delete ${basePresentKeepRef(binding, p.payload.ref, p.payload.episode, "prior")} ${p.payload.priorOid}`,
    ]),
    `delete ${basePresentKeepRef(binding, p.payload.ref, p.payload.episode, "next")} ${p.payload.nextOid}`,
  ].sort((a, b) => Buffer.compare(Buffer.from(a.split(" ")[1]!), Buffer.from(b.split(" ")[1]!)));
}

/** Settle one exact P while its R/P/K locks remain prepared. BASE's selected
 * member and pull-p origin are generation-CASed first; only then may P/K retire. */
export async function settleExactPresentArtifact(input: {
  root: string;
  stream: string;
  state: SyncState;
  relPath: string;
  ctx: RepoCtx;
  binding: ArtifactBinding;
  p: PreparedProtocolRef<BasePresentPayload>;
  /** Reset's complete repository fence owns the physical state lock. */
  stateSaveOptions?: StateSaveOptions;
  /** Daemon-only shutdown boundary. Foreground settlement omits it. */
  mutationBoundary?: MutationBoundary;
}): Promise<ExactPSettlementResult> {
  const payload = input.p.payload;
  const currentRecord = repoRecordsForState(input.state)[input.relPath];
  const currentBase = currentRecord?.base?.refs[payload.ref] ?? null;
  if (currentBase !== payload.priorOid && currentBase !== payload.nextOid) return { status: "moved", reason: "base-shape" };
  let lease: MutationLease | undefined;
  try {
    lease = input.mutationBoundary?.enter({ phase: "git-prepare", repository: input.ctx.repoDir });
    return await withRepoProtocolLocks(input.ctx.repoDir, { reflogRefs: [payload.ref] }, async () => {
      const first = await readBasePresentArtifact(input.ctx.repoDir, input.binding, payload.ref);
      if (first.status !== "valid" || first.artifact.targetOid !== input.p.targetOid) {
        return first.status === "absent" ? { status: "absent" as const } : { status: "hold" as const, reason: "P/K changed before exact settlement" };
      }
      const initialReflog = await readRefReflogFingerprint(input.ctx.repoDir, payload.ref);
      if (!exactEpisodeTop(initialReflog.bytes, payload)) return { status: "moved" as const, reason: "reflog" as const };
      let stateAfter: SyncState | undefined;
      if (lease?.abortRequested) throw new MutationGateClosedError();
      await runPreparedUpdateRefTransaction(input.ctx.repoDir, retirementLines(input.p), async () => {
          // Git has prepared P/K locks but has not committed. Shutdown wins here
          // by throwing, which makes the transaction helper send `abort`.
          if (lease?.abortRequested) throw new MutationGateClosedError();
          const locked = await readBasePresentArtifact(input.ctx.repoDir, input.binding, payload.ref);
          if (locked.status !== "valid" || locked.artifact.targetOid !== input.p.targetOid) throw new Error("P/K moved at exact settlement boundary");
          const reflog = await readRefReflogFingerprint(input.ctx.repoDir, payload.ref);
          if (reflog.sha256 !== initialReflog.sha256 || !exactEpisodeTop(reflog.bytes, payload)) {
            throw new PSettlementMovementError("reflog", "P reflog moved at exact settlement boundary");
          }
          const fresh = await loadRawState(input.root);
          if (!fresh || fresh.stream !== input.stream) throw new Error("P settlement state lineage changed");
          const record = repoRecordsForState(fresh)[input.relPath];
          if (!record?.base) throw new Error("P settlement BASE disappeared");
          const before = record.base.refs[payload.ref] ?? null;
          if (before !== payload.priorOid && before !== payload.nextOid) {
            throw new PSettlementMovementError("base-shape", "P settlement BASE is a later value");
          }
          const witness = presentWitnessFromPreparedRef(input.p);
          const refs = { ...record.base.refs, [payload.ref]: payload.nextOid };
          const proof: RepoBaseProof = {
            authority: {
              kind: "pull-ref-transaction",
              lineageHash: payload.lineageHash,
              repositoryIdentityHash: payload.repositoryIdentityHash,
              incomingKey: `p:${payload.episode}`,
              branchWitnesses: { [payload.ref]: witness },
              safeRefWitnesses: {},
            },
            lockedProof: {
              repoKind: input.ctx.kind,
              effectiveRefScope: record.base.refScope,
              checkoutComplete: true,
              incomingKey: `p:${payload.episode}`,
              branches: { [payload.ref]: {
                liveOid: payload.nextOid,
                witness,
                reflogEpisode: payload.episode,
                artifactsClear: true,
                ownershipStable: true,
                reflogStable: true,
                currentRef: false,
                siblingOwned: false,
              } },
              safeRefs: {},
            },
          };
          const { repoGen: _repoGen, ...withoutGeneration } = record;
          const next: RepoRecordInput = { ...withoutGeneration, base: { ...record.base, refs } };
          // The prepared ref transaction is still abortable through all reads
          // above. Cross the irreversible boundary only immediately before the
          // state CAS whose acceptance requires the ref commit to drain.
          if (lease?.abortRequested || (lease && !lease.beginCommit("git-commit"))) {
            throw new MutationGateClosedError();
          }
          const saved = await withProtocolLockClass("state", path.resolve(statePath(input.root)), () =>
            applyStateSavePacket(input.root, {
              expectedStream: input.stream,
              expectedNonce: expectedStateNonce(fresh),
              sourceGlobalSeq: fresh.lastSyncedSequence,
              repos: [{ relPath: input.relPath, expectedRepoGen: record.repoGen, newRecord: next, baseProof: proof }],
            }, input.stateSaveOptions));
          if (saved.status !== "accepted") throw new Error("P settlement state CAS rejected");
          stateAfter = await loadRawState(input.root) ?? undefined;
        }, { reflogMessage: `rbox p-settle ${payload.episode}` });
      if (!stateAfter) throw new Error("P settlement did not reload state");
      return { status: "settled" as const, state: stateAfter, ref: payload.ref };
    });
  } catch (error) {
    if (error instanceof MutationGateClosedError) throw error;
    const reason = String((error as Error)?.message ?? error);
    if (error instanceof PSettlementMovementError) return { status: "moved", reason: error.movement };
    if (error instanceof PreparedRefTransactionPrepareError) return { status: "moved", reason: "live" };
    return { status: "hold", reason };
  } finally {
    lease?.finish();
  }
}
