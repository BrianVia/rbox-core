/**
 * `rbox git resolve <repo> keep-mine`: the transaction that publishes THIS
 * computer's Git state as the synced truth and withdraws the incoming hold.
 *
 * It is the only resolve verb that writes to the remote, so every precondition
 * it checks is re-checked at the execution boundary under the same workspace
 * mutex: the confirmation snapshot, the discard report's force decision, ref
 * readability, worktree ownership, Git business, in-progress operations, and
 * the publisher's branch-deletion consent. A precondition proved before the
 * boundary and not after it is worthless, which is why the second pass reloads
 * every input rather than trusting the first.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { receiverEquivalentCollisionNames, type GitSection } from "../../engine/index.js";
import { hashFile } from "../../engine/hash.js";
import { loadState, repoRecordsForState, syncStreamId, type RepoRecord, type SyncState } from "../config.js";
import { branchBaseOriginMatches } from "../sync-git/base-composer.js";
import { prepareFollowerBranchProtocol } from "../sync-git/follower-protocol.js";
import { headBranchOf, repoCtx, type RepoCtx } from "../sync-git/git-state.js";
import { gitPreflight, isGitBusy } from "../sync-git/preflight.js";
import { hasInProgressOpState, readAllRefsStrict, readOpStateSnapshot } from "../sync-git/refs.js";
import { preliminaryResolutionReport } from "../sync-git/resolution-intent.js";
import { observePackedRefsIdentity, packedRefsMtimeRegressed } from "../sync-git/shared.js";
import { workspaceSyncMutexDegraded, type WorkspaceSyncMutex } from "../sync-mutex.js";
import type { SyncDeps } from "../sync/deps.js";
import { scanManifestForPush } from "../sync/pull.js";
import { pushManifest } from "../sync/push.js";
import type { GitResolveDeps, ResolveEnvironment } from "./resolve-contract.js";
import { buildSnapshot, strictOwnedBranches, type ResolveSnapshot } from "./resolve-evidence.js";
import { emit, refusalMessage } from "./resolve-presentation.js";

/** Everything keep-mine inherits from the orchestrator, already past the
 *  common preflight: a proven repository context, the pending incoming section,
 *  and the snapshot the human is confirming. */
export interface KeepMineRun {
  root: string;
  rel: string;
  repoDir: string;
  json: boolean;
  deps: GitResolveDeps;
  env: ResolveEnvironment;
  mutex: WorkspaceSyncMutex;
  options: { confirm?: string; forceDiscardIncoming?: boolean };
  forceDiscardIncoming: boolean;
  now: () => Date;
  step: (phase: string) => void;
  state: SyncState;
  record: RepoRecord;
  incoming: GitSection;
  ctx: RepoCtx;
  snapshot: ResolveSnapshot;
}

export async function runKeepMineResolve(run: KeepMineRun): Promise<number> {
  const { root, rel, repoDir, json, deps, env, mutex, options, forceDiscardIncoming, now, step } = run;
  const verb = "keep-mine" as const;
  let { state, record, incoming, ctx, snapshot } = run;
  const takeSnapshot = () => buildSnapshot({
    root, rel, ctx, state, record, incoming, store: env.store, kek: env.cfg.kek!, cfg: env.cfg, now: now(),
  });

  let discardReport = await preliminaryResolutionReport({ ctx, pending: incoming, binding: snapshot.identity, store: env.store, kek: env.cfg.kek! });
  if (snapshot.proofIndeterminate || deps.forceProofIndeterminate === true || discardReport.lanes.some((lane) => lane.disposition === "indeterminate")) {
    emit({ status: "refused", verb, repo: rel, code: "proof-indeterminate", message: "the incoming-versus-local comparison could not complete; retry after Git state settles", current: snapshot.public }, json, deps, root);
    return 1;
  }
  const strictRefs = await readAllRefsStrict(ctx!.repoDir);
  if (strictRefs.status === "unreadable") {
    emit({ status: "refused", verb, repo: rel, code: "proof-indeterminate", message: refusalMessage("ref-read-unreadable") }, json, deps, root);
    return 1;
  }
  const protocolResult = await prepareFollowerBranchProtocol({
    workspaceRoot: root, relPath: rel, state, ctx: ctx!, record,
    base: record!.base, incoming, liveRefs: strictRefs.refs,
  });
  const owned = await strictOwnedBranches(ctx!);
  const priorPacked = record!.packedRefsIdentity;
  const currentPacked = await observePackedRefsIdentity(ctx!.commonDir);
  const packedRegressed = currentPacked.status === "unreadable"
    || packedRefsMtimeRegressed(priorPacked, currentPacked);
  const headLog = await fs.readFile(path.join(ctx!.commonDir, "logs", "HEAD")).catch(() => undefined);
  const [busyNow, preflightNow] = await Promise.all([isGitBusy(ctx!.repoDir), gitPreflight(ctx!.repoDir)]);
  const collisions = receiverEquivalentCollisionNames([
    ...Object.keys(strictRefs.refs),
    ...Object.keys(record!.base?.refs ?? {}),
    ...Object.keys(incoming.refs),
    ...owned.keys(),
  ]);
  const absenceCaptureEnabled = process.env.RBOX_GIT_ABSENCE_CAPTURE !== "0";
  const absentPublisherBranch = Object.entries(incoming.refs).find(([ref]) =>
    ref.startsWith("refs/heads/")
    && record!.base?.refs[ref] !== undefined
    && strictRefs.refs[ref] === undefined
    && (() => {
      if (!absenceCaptureEnabled || ctx!.kind !== "dir" || incoming!.refScope !== "all"
        || protocolResult.status !== "ready" || packedRegressed
        || busyNow || !preflightNow.ok || collisions.has(ref)
        || !headLog || headLog.byteLength === 0
        || snapshot.identity.head === `ref: ${ref}` || owned.has(ref)) return true;
      const baseOid = record!.base!.refs[ref]!;
      const origin = record!.branchBaseOrigins?.[ref];
      const artifact = protocolResult.protocol.artifacts[ref];
      const artifactsClear = artifact === undefined || (artifact.absence === "absent"
        && artifact.present === "absent" && artifact.keeps === "clear"
        && artifact.settledAbsence === "absent");
      return !artifactsClear || !branchBaseOriginMatches(origin, baseOid)
        || origin.lineageHash !== protocolResult.protocol.lineageHash;
    })());
  if (absentPublisherBranch) {
    emit({
      status: "refused", verb, repo: rel, code: "conflict",
      message: `keep-mine can't remove branch ${absentPublisherBranch[0]} — it is deleted here but rbox still tracks it as synced. Restore the branch, or resolve it explicitly, then retry`,
    }, json, deps, root);
    return 1;
  }
  const currentCheckoutRef = /^ref:\s*(refs\/\S+)\s*$/.exec(snapshot.identity.head)?.[1];
  const divergentBranch = discardReport.lanes.find((lane) =>
    lane.lane === `branch:${currentCheckoutRef}`
    && lane.disposition === "not-subsumed"
    && strictRefs.refs[lane.lane.slice("branch:".length)] !== undefined);
  if (divergentBranch) {
    emit({
      status: "refused", verb, repo: rel, code: "conflict",
      message: `branch ${divergentBranch.lane.slice("branch:".length)} was changed on another machine AND here — rbox won't pick a side. Reconcile it with git (merge or rebase), then retry`,
    }, json, deps, root);
    return 1;
  }
  if (!options.confirm) {
    emit({
      status: "preview", verb, repo: rel,
      message: "Review the preliminary report before publishing; confirmation re-checks the final candidate immediately.",
      current: snapshot.public,
      discardReport,
      confirm: { snapshot: snapshot.public.snapshot, forceDiscardIncoming: discardReport.forceRequired },
    }, json, deps, root);
    return 1;
  }
  if (options.confirm !== snapshot.public.snapshot) {
    emit({ status: "snapshot-mismatch", verb, repo: rel, message: "snapshot changed; review the fresh preliminary report and confirm again", current: snapshot.public, discardReport }, json, deps, root);
    return 1;
  }
  if (forceDiscardIncoming !== discardReport.forceRequired) {
    emit({
      status: "preview", verb, repo: rel,
      message: discardReport.forceRequired
        ? "This preview discards at least one incoming lane, so confirmation requires --force-discard-incoming."
        : "This preview retains every incoming lane, so confirmation must omit --force-discard-incoming.",
      current: snapshot.public,
      discardReport,
      confirm: { snapshot: snapshot.public.snapshot, forceDiscardIncoming: discardReport.forceRequired },
    }, json, deps, root);
    return 1;
  }
  if (workspaceSyncMutexDegraded(mutex)) {
    emit({ status: "refused", verb, repo: rel, code: "mutex-degraded", message: "locking unavailable; keep-mine will not publish until safe serialization is restored" }, json, deps, root);
    return 1;
  }

  // Recompute the live preview at the execution boundary under the same lock.
  await deps.beforeConfirmRecheck?.();
  const boundaryState = await loadState(root, syncStreamId(env.cfg));
  const boundaryRecord = repoRecordsForState(boundaryState)[rel];
  const boundaryIncoming = boundaryRecord?.pending;
  const boundaryCtx = await repoCtx(repoDir).catch(() => undefined);
  if (!boundaryRecord || !boundaryIncoming || !boundaryCtx) {
    emit({ status: "snapshot-mismatch", verb, repo: rel, message: "the pending repository binding changed before publication; inspect and confirm again", current: snapshot.public, discardReport }, json, deps, root);
    return 1;
  }
  state = boundaryState;
  record = boundaryRecord;
  incoming = boundaryIncoming;
  ctx = boundaryCtx;
  snapshot = await takeSnapshot();
  if (options.confirm !== snapshot.public.snapshot) {
    discardReport = await preliminaryResolutionReport({ ctx, pending: incoming, binding: snapshot.identity, store: env.store, kek: env.cfg.kek! });
    emit({ status: "snapshot-mismatch", verb, repo: rel, message: "snapshot changed before publication; confirm the fresh preliminary report", current: snapshot.public, discardReport }, json, deps, root);
    return 1;
  }
  if (await isGitBusy(ctx.repoDir, ctx)) {
    emit({ status: "refused", verb, repo: rel, code: "git-busy", message: "Git became busy; retry keep-mine after the other Git operation finishes" }, json, deps, root);
    return 1;
  }
  const confirmOpState = await readOpStateSnapshot(ctx.gitDir, hashFile);
  if (hasInProgressOpState(confirmOpState)) {
    emit({ status: "refused", verb, repo: rel, code: "local-operation", message: "a Git operation began before confirmation; finish or abort it, then run keep-mine again" }, json, deps, root);
    return 1;
  }
  const boundaryCheckoutRef = headBranchOf(incoming.head);
  if (boundaryCheckoutRef && (await strictOwnedBranches(ctx)).has(boundaryCheckoutRef)) {
    emit({ status: "refused", verb, repo: rel, code: "worktree-ownership", message: "the incoming checkout branch became active in another linked worktree; switch or detach that worktree, then retry keep-mine" }, json, deps, root);
    return 1;
  }
  discardReport = await preliminaryResolutionReport({ ctx, pending: incoming, binding: snapshot.identity, store: env.store, kek: env.cfg.kek! });
  if (discardReport.lanes.some((lane) => lane.disposition === "indeterminate")
    || forceDiscardIncoming !== discardReport.forceRequired) {
    emit({ status: "snapshot-mismatch", verb, repo: rel, message: "the preliminary discard decision changed before publication; review and confirm again", current: snapshot.public, discardReport }, json, deps, root);
    return 1;
  }
  const finalCheckoutRef = headBranchOf(incoming.head);
  if (finalCheckoutRef && (await strictOwnedBranches(ctx)).has(finalCheckoutRef)) {
    emit({ status: "refused", verb, repo: rel, code: "worktree-ownership", message: "the incoming checkout branch became active in another linked worktree; switch or detach that worktree, then retry keep-mine" }, json, deps, root);
    return 1;
  }
  const resolution = {
    repo: rel,
    verb: "keep-mine" as const,
    confirmedReport: discardReport,
    authorizedLanes: discardReport.lanes.filter((lane) => lane.disposition === "not-subsumed").map((lane) => lane.lane).sort(),
    forceDiscardIncoming,
  };
  const syncDeps: SyncDeps = {
    ...(env.remote ? { remote: env.remote } : {}),
    syncMutex: mutex,
    warningSink: deps.stderr,
  };
  step("publishing this computer's version");
  const result = deps.confirmedPush
    ? await deps.confirmedPush({ cfg: env.cfg, deps: syncDeps, resolution })
    : await scanManifestForPush(root, env.cfg, syncDeps).then((local) =>
        pushManifest(root, env.cfg, local, syncDeps, { resolution }));
  const disposition = result.resolution;
  if (disposition?.outcome === "published") {
    emit({ status: "published", verb, repo: rel, sequence: disposition.sequence ?? result.sequence }, json, deps, root);
    return 0;
  }
  if (disposition?.outcome === "ack-uncertain") {
    emit({
      status: "ack-uncertain",
      verb,
      repo: rel,
      message: disposition.reason ?? "the publish acknowledgement is uncertain; run rbox push or rbox pull to reconcile",
    }, json, deps, root);
    return 1;
  }
  const freshState = await loadState(root, syncStreamId(env.cfg));
  const freshRecord = repoRecordsForState(freshState)[rel];
  const freshIncoming = freshRecord?.pending;
  if (freshRecord && freshIncoming) {
    const freshCtx = await repoCtx(repoDir).catch(() => undefined);
    if (freshCtx) {
      const fresh = await buildSnapshot({
        root, rel, ctx: freshCtx, state: freshState, record: freshRecord, incoming: freshIncoming,
        store: env.store, kek: env.cfg.kek!, cfg: env.cfg, now: now(),
      });
      const freshReport = await preliminaryResolutionReport({ ctx: freshCtx, pending: freshIncoming, binding: fresh.identity, store: env.store, kek: env.cfg.kek! });
      emit({
        status: "snapshot-mismatch",
        verb,
        repo: rel,
        message: disposition?.outcome === "aborted-remote-moved"
          ? "another machine published while confirming — review the new state and confirm again"
          : disposition?.reason ?? "publication was refused; review the fresh preliminary report and confirm again",
        current: fresh.public,
        discardReport: freshReport,
      }, json, deps, root);
      return 1;
    }
  }
  emit({
    status: "refused",
    verb,
    repo: rel,
    code: "no-incoming",
    message: disposition?.outcome === "aborted-remote-moved"
      ? "another machine published while confirming; the post-pull state has no incoming hold"
      : disposition?.reason ?? "keep-mine did not publish because no incoming hold remains",
  }, json, deps, root);
  return 1;
}
