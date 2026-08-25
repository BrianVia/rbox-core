/**
 * `rbox git resolve <repo> take-theirs`: the transaction that sets this
 * computer's Git state aside and follows the checkout waiting from another
 * computer.
 *
 * The displaced local history is quarantined and pinned before anything moves,
 * and the checkout runs through the journaled follow so a crash mid-way leaves
 * a recoverable journal rather than a half-applied repository. The follow's
 * second proof re-derives the binding identity under the lock and accepts only
 * the ref changes the checkout itself authored — anything else is a boundary
 * mismatch and the confirmation is refused rather than reused.
 */
import crypto from "node:crypto";
import path from "node:path";
import type { GitSection } from "../../engine/index.js";
import { hashBytes } from "../../engine/hash.js";
import { expectedStateNonce, loadState, repoRecordsForState, syncStreamId, type RepoRecord, type RepoRecordInput, type SyncState } from "../config.js";
import { composeRepoBase, type ManualBranchDecision, type RepoBaseLockedProof, type RepoBaseProof } from "../sync-git/base-composer.js";
import { checkoutJournalBinding, followDivergedRepo, recoverAndLandFollowJournal, type FollowIntended, type FollowProgress } from "../sync-git/follow.js";
import type { FollowerBranchProtocol } from "../sync-git/follower-protocol.js";
import { type RepoCtx } from "../sync-git/git-state.js";
import { pinDisplaced } from "../sync-git/keep-pins.js";
import { quarantineLocal } from "../sync-git/quarantine.js";
import { resolutionBindingIdentity } from "../sync-git/resolution-intent.js";
import { gitIncomingKey } from "../sync-git/shared.js";
import { workspaceSyncMutexDegraded, type WorkspaceSyncMutex } from "../sync-mutex.js";
import { inputRecord } from "../sync-state.js";
import { settleCommittedManualPresentArtifacts } from "./resolve-artifacts.js";
import { ManualBaseProofIncompleteError, ManualLineageProofUnavailableError, RESOLVE_TYPED_REFUSAL, type GitResolveDeps, type ResolveEnvironment } from "./resolve-contract.js";
import { buildSnapshot, incomingFor, type ResolveSnapshot, type SnapshotIdentity } from "./resolve-evidence.js";
import { emit, refusalMessage } from "./resolve-presentation.js";

function reconcileLog(confirmed: readonly string[], actual: readonly string[], authored?: string): string[] | undefined {
  const before = [...confirmed].sort();
  const live = [...actual].sort();
  if (authored === undefined) return live.length === 0 ? before : undefined;
  const withAuthored = [...new Set([...before, authored])].sort();
  return JSON.stringify(live) === JSON.stringify(before) || JSON.stringify(live) === JSON.stringify(withAuthored)
    ? before
    : undefined;
}

function normalizedAfterAuthoredRefs(
  current: SnapshotIdentity,
  confirmed: SnapshotIdentity,
  changes: readonly { ref: string; before?: string; after?: string }[],
): SnapshotIdentity | undefined {
  const refs = new Map(current.refs);
  const confirmedLogs = new Map(confirmed.reflogs);
  const liveLogs = new Map(current.reflogs);
  let stash = [...current.stash];
  for (const change of changes) {
    if (refs.get(change.ref) !== change.after) return undefined;
    if (change.before) refs.set(change.ref, change.before); else refs.delete(change.ref);
    if (change.ref === "refs/stash") {
      const reconciled = reconcileLog(confirmed.stash, stash, change.after);
      if (!reconciled) return undefined;
      stash = reconciled;
      continue;
    }
    const reconciled = reconcileLog(confirmedLogs.get(change.ref) ?? [], liveLogs.get(change.ref) ?? [], change.after);
    if (!reconciled) return undefined;
    if (reconciled.length) liveLogs.set(change.ref, reconciled); else liveLogs.delete(change.ref);
  }
  return {
    ...current,
    refs: [...refs].sort(([a], [b]) => a.localeCompare(b)),
    reflogs: [...liveLogs].sort(([a], [b]) => a.localeCompare(b)),
    stash,
  };
}

/** Everything take-theirs inherits from the orchestrator, already past the
 *  common preflight and the standing-artifact settlement whose protocol it
 *  needs to compose the new BASE. */
export interface TakeTheirsRun {
  root: string;
  rel: string;
  json: boolean;
  deps: GitResolveDeps;
  env: ResolveEnvironment;
  mutex: WorkspaceSyncMutex;
  options: { confirm?: string };
  now: () => Date;
  step: (phase: string) => void;
  state: SyncState;
  record: RepoRecord;
  incoming: GitSection;
  ctx: RepoCtx;
  branchProtocol: FollowerBranchProtocol | undefined;
  snapshot: ResolveSnapshot;
}

export async function runTakeTheirsResolve(run: TakeTheirsRun): Promise<number> {
  const { root, rel, json, deps, env, mutex, options, now, step, state, record, incoming, ctx, branchProtocol } = run;
  const verb = "take-theirs" as const;
  let snapshot = run.snapshot;
  const takeSnapshot = () => buildSnapshot({
    root, rel, ctx, state, record, incoming, store: env.store, kek: env.cfg.kek!, cfg: env.cfg, now: now(),
  });

if (snapshot.proofIndeterminate || deps.forceProofIndeterminate === true) {
  emit({ status: "refused", verb, repo: rel, code: "proof-indeterminate", message: "proof could not complete; retry after Git state settles", current: snapshot.public }, json, deps, root);
  return 1;
}
if (!options.confirm || options.confirm !== snapshot.public.snapshot) {
  emit({
    status: "snapshot-mismatch",
    verb,
    repo: rel,
    message: options.confirm ? "snapshot changed; review the fresh summary and confirm again" : "--confirm <snapshot> is required",
    current: snapshot.public,
  }, json, deps, root);
  return 1;
}
if (workspaceSyncMutexDegraded(mutex)) {
  emit({ status: "refused", verb, repo: rel, code: "mutex-degraded", message: "locking unavailable; resolution refused" }, json, deps, root);
  return 1;
}

// Confirmation is checked again immediately before the first mutation.
snapshot = await takeSnapshot();
if (options.confirm !== snapshot.public.snapshot) {
  emit({ status: "snapshot-mismatch", verb, repo: rel, message: "snapshot changed before resolution began; confirm the fresh snapshot", current: snapshot.public }, json, deps, root);
  return 1;
}

step("setting this computer's Git state aside");
const quarantine = await quarantineLocal(ctx, path.join(root, ".rbox", "git-quarantine", hashBytes(Buffer.from(rel)).slice(0, 16)), `${Date.now()}`);
await pinDisplaced(ctx.repoDir, snapshot.protectedOids, {
  ref: `resolve:${rel}`,
  episode: snapshot.public.snapshot,
  time: now().toISOString(),
  class: "human",
});

let intended: FollowIntended | undefined;
let boundaryMismatch = false;
const previousRecord: RepoRecordInput = inputRecord(record);
const manualEpisode = crypto.randomBytes(16).toString("hex");
const makeIntended = (progress: FollowProgress): FollowIntended => {
  if (!branchProtocol) throw new ManualLineageProofUnavailableError();
  const branchDecisions: Record<string, ManualBranchDecision> = {};
  const branches: Record<string, RepoBaseLockedProof["branches"][string]> = {};
  for (const [ref, witness] of Object.entries(progress.branchWitnesses ?? {})) {
    branchDecisions[ref] = {
      kind: "artifact",
      beforeBaseOid: branchProtocol.logicalBaseRefs[ref] ?? null,
      witness,
    };
    branches[ref] = {
      liveOid: witness.kind === "present" ? witness.nextOid : null,
      witness,
      ...(witness.kind === "present" ? { reflogEpisode: witness.episode } : {}),
      artifactsClear: true,
      ownershipStable: true,
      reflogStable: true,
      currentRef: false,
      siblingOwned: false,
    };
  }
  for (const [ref, terminal] of Object.entries(progress.manualBranchTerminals ?? {})) {
    branchDecisions[ref] = {
      kind: "no-p", beforeOid: terminal.beforeBaseOid, afterOid: terminal.afterOid, episode: manualEpisode,
    };
    branches[ref] = {
      liveOid: terminal.afterOid,
      artifactsClear: true,
      ownershipStable: true,
      reflogStable: true,
      currentRef: false,
      siblingOwned: false,
    };
  }
  const safeRefs: RepoBaseLockedProof["safeRefs"] = Object.fromEntries(
    Object.entries(progress.safeRefWitnesses ?? {}).map(([ref, witness]) => [ref, {
      liveOid: witness.afterOid,
      witness,
      ...(ref === "refs/stash" && witness.afterOid !== null ? { stashReflogReady: true } : {}),
    }]),
  );
  const baseProof: RepoBaseProof = {
    authority: {
      kind: "manual",
      lineageHash: branchProtocol.lineageHash,
      repositoryIdentityHash: branchProtocol.repositoryIdentityHash,
      incomingKey: gitIncomingKey(incoming),
      episode: manualEpisode,
      snapshotId: snapshot.public.snapshot,
      stateGeneration: record.repoGen,
      branchDecisions,
      safeRefWitnesses: progress.safeRefWitnesses ?? {},
    },
    lockedProof: {
      repoKind: ctx.kind,
      effectiveRefScope: incoming.refScope,
      checkoutComplete: true,
      incomingKey: gitIncomingKey(incoming),
      stateGeneration: record.repoGen,
      snapshotId: snapshot.public.snapshot,
      freshConfirmation: true,
      branches,
      safeRefs,
    },
  };
  const composed = composeRepoBase(
    { base: record.base, branchBaseOrigins: record.branchBaseOrigins },
    { base: incoming },
    baseProof.authority,
    baseProof.lockedProof,
  );
  if (composed.disposition !== "terminal") throw new ManualBaseProofIncompleteError(composed.holds);
  const next: RepoRecordInput = {
    ...previousRecord,
    sourceSeq: Math.max(record.sourceSeq, state.lastSyncedSequence),
    ...(composed.base ? { base: composed.base } : {}),
    ...(composed.branchBaseOrigins ? { branchBaseOrigins: composed.branchBaseOrigins } : {}),
  };
  delete next.pending;
  delete next.resolutionKey;
  delete next.partial;
  delete next.idxProj;
  const deferrals = { ...(next.deferrals ?? {}) };
  delete deferrals.apply;
  if (Object.keys(deferrals).length) next.deferrals = deferrals; else delete next.deferrals;
  if (progress.incomingIndexProjection !== undefined) next.idxProj = progress.incomingIndexProjection;
  intended = { record: next, expectedRepoGen: record.repoGen, relPath: rel, previousRecord, baseProof };
  return intended;
};
step("publishing the incoming checkout");
const confirmedIdentity = JSON.stringify(snapshot.identity);
const binding = await checkoutJournalBinding(state.stream, expectedStateNonce(state), ctx);
const follow = await followDivergedRepo({
  workspaceRoot: root,
  relPath: rel,
  ctx,
  base: record.base,
  incoming,
  store: env.store,
  kek: env.cfg.kek!,
  oracle: snapshot.oracle,
  record,
  binding,
  branchProtocol,
  followEnabled: true,
  makeIntended,
  capabilityProbe: deps.capabilityProbe,
  manualResolution: {
    snapshotId: snapshot.public.snapshot,
    waivedReasons: snapshot.waivedReasons,
    protectedOids: snapshot.protectedOids,
    secondProof: async (authoredRefChanges) => {
      await deps.beforeSecondProof?.();
      const currentState = await loadState(root, syncStreamId(env.cfg));
      const currentRecord = repoRecordsForState(currentState)[rel];
      const currentIncoming = incomingFor(currentRecord);
      if (!currentRecord || !currentIncoming) { boundaryMismatch = true; return false; }
      const currentIdentity = await resolutionBindingIdentity({
        root, rel, ctx, state: currentState, record: currentRecord, incoming: currentIncoming, oracle: snapshot.oracle, cfg: env.cfg, boundary: true,
      });
      const normalized = normalizedAfterAuthoredRefs(currentIdentity, snapshot.identity, authoredRefChanges);
      const same = normalized !== undefined && JSON.stringify(normalized) === confirmedIdentity;
      if (!same) boundaryMismatch = true;
      return same;
    },
  },
});
if (follow.status !== "followed") {
  const freshState = await loadState(root, syncStreamId(env.cfg));
  const freshRecord = repoRecordsForState(freshState)[rel];
  const freshIncoming = incomingFor(freshRecord);
  if (boundaryMismatch && freshRecord && freshIncoming) {
    const fresh = await buildSnapshot({ root, rel, ctx, state: freshState, record: freshRecord, incoming: freshIncoming, store: env.store, kek: env.cfg.kek!, cfg: env.cfg, now: now() });
    emit({ status: "snapshot-mismatch", verb, repo: rel, message: "snapshot changed at the locked checkout boundary; confirm the fresh snapshot", current: fresh.public }, json, deps, root);
  } else {
    // For artifact refusals the deferral's own detail names the actual
    // failure (e.g. "planned graph connectivity proof failed"); the canned
    // text alone cost hours of field archaeology (issue #647). Other codes
    // keep the canned text only — their details can carry filesystem paths
    // outside the workspace, which refusal output must never leak.
    const detail = follow.reason === "artifact" ? (follow as { detail?: string }).detail : undefined;
    emit({ status: "refused", verb, repo: rel, code: follow.reason, message: detail ? `${refusalMessage(follow.reason)}: ${detail}` : refusalMessage(follow.reason) }, json, deps, root);
  }
  return 1;
}
if (deps.forceMutexBodyRefusal === "incomplete-checkout" || Object.keys(follow.heldRefs).length || !intended) {
  emit({ status: "refused", verb, repo: rel, code: "incomplete-checkout", message: RESOLVE_TYPED_REFUSAL["incomplete-checkout"] }, json, deps, root);
  return 1;
}
step("landing the published checkout");
const landed = await recoverAndLandFollowJournal(root, rel, binding, state);
if (deps.forceMutexBodyRefusal === "journal-recovery" || landed.recovery.status !== "keep") {
  emit({ status: "refused", verb, repo: rel, code: "journal-recovery", message: RESOLVE_TYPED_REFUSAL["journal-recovery"] }, json, deps, root);
  return 1;
}
step("settling Git protocol artifacts");
const pSettled = await settleCommittedManualPresentArtifacts({ root, rel, ctx, state: landed.state, incoming });
// The hold reason stringifies arbitrary errors and may carry filesystem
// paths, so the curated text REPLACES it rather than appending to it.
if (pSettled.error) {
  emit({ status: "refused", verb, repo: rel, code: "artifact", message: RESOLVE_TYPED_REFUSAL.artifact }, json, deps, root);
  return 1;
}
emit({ status: "resolved", verb, repo: rel, snapshot: snapshot.public.snapshot, quarantine }, json, deps, root);
return 0;
}
