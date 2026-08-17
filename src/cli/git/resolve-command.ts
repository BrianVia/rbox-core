/**
 * `rbox git resolve` — the orchestrator.
 *
 * It owns the parts every verb shares and nothing a single verb owns: resolving
 * the repository argument inside the workspace, taking the workspace sync mutex,
 * building the authed environment, recovering a checkout journal before anything
 * reads state, the common refusals (no incoming, Git disabled, Git busy, an
 * operation in progress, a branch owned by another worktree), the show-me
 * progress heartbeat, and the first evidence snapshot.
 *
 * From there it hands off: `resolve-keep-mine.ts` publishes this computer's
 * state, `resolve-take-theirs.ts` follows the incoming checkout. Every refusal
 * either verb raises — including the two proof failures that travel as thrown
 * classes out of the follow executor's callback — lands in the single catch at
 * the bottom, so no path can exit without a typed code.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GitSection } from "../../engine/index.js";
import { assertGitTargetWithinRoot } from "../sync-git/containment.js";
import { checkoutJournalDir } from "../sync-git/journal.js";
import { isGitBusy } from "../sync-git/preflight.js";
import { quarantineUnboundFollowJournal, recoverAndLandFollowJournal, checkoutJournalBinding } from "../sync-git/follow.js";
import { hasInProgressOpState, readOpStateSnapshot } from "../sync-git/refs.js";
import { headBranchOf, repoCtx, type RepoCtx } from "../sync-git/git-state.js";
import { hashFile } from "../../engine/hash.js";
import {
  expectedStateNonce,
  loadState,
  repoRecordsForState,
  syncStreamId,
  type SyncState,
} from "../config.js";
import { buildAuthedRemote } from "../e2ee-client.js";
import { reconcileResolutionReceipt } from "../sync/pull.js";
import { withWorkspaceSyncMutex, WorkspaceSyncBusyError, WorkspaceSyncTimeoutError, type SyncMutexOptions } from "../sync-mutex.js";
import { repoDirOf } from "../sync-git/shared.js";
import type { FollowerBranchProtocol } from "../sync-git/follower-protocol.js";
import { assertCommandAllowedOnScopedBinding, ScopedBindingRefusal } from "../scope/binding-scope.js";
import { ensureFolderAuthority } from "../folder-authority.js";
import { applyFolderPolicy, observeFolderAdmission, runtimeRefusal } from "../folder-inventory.js";
import { preflightManualPresentArtifacts } from "./resolve-artifacts.js";
import {
  ManualBaseProofIncompleteError,
  ManualLineageProofUnavailableError,
  RESOLVE_TYPED_REFUSAL,
  type GitResolveDeps,
  type GitResolveVerb,
  type ResolveEnvironment,
  type ResolveRefusalCode,
} from "./resolve-contract.js";
import { buildSnapshot, incomingFor, strictOwnedBranches, type ResolveSnapshot } from "./resolve-evidence.js";
import { emit } from "./resolve-presentation.js";
import { runKeepMineResolve } from "./resolve-keep-mine.js";
import { runTakeTheirsResolve } from "./resolve-take-theirs.js";

function normalizedRepo(root: string, arg: string): string {
  const abs = path.resolve(arg);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) throw new Error("repository is outside this workspace");
  return rel;
}

async function defaultBuild(root: string): Promise<ResolveEnvironment> {
  const state = await ensureFolderAuthority({ currentRoot: root });
  const admission = await observeFolderAdmission(root, state);
  if (admission.kind !== "admitted") throw runtimeRefusal(admission);
  const built = await buildAuthedRemote(root);
  return { cfg: applyFolderPolicy(built.cfg, admission.policy), store: built.remote.blobStore(), remote: built.remote };
}

async function recoverFirst(root: string, rel: string, ctx: RepoCtx | undefined, state: SyncState): Promise<{ state: SyncState; error?: string }> {
  if (!ctx) {
    const recovery = await quarantineUnboundFollowJournal(root, rel, state.stream, expectedStateNonce(state));
    if (recovery.status === "defer") return { state, error: recovery.reason };
    return { state, error: "repository is absent or unreadable" };
  }
  const landedRecovery = await recoverAndLandFollowJournal(
    root,
    rel,
    await checkoutJournalBinding(state.stream, expectedStateNonce(state), ctx),
    state,
  );
  const recovery = landedRecovery.recovery;
  if (recovery.status === "keep") {
    return { state: landedRecovery.state };
  }
  if (recovery.status === "defer") return { state, error: recovery.reason };
  if (recovery.status === "human-intervened") return { state, error: `crash-window changes were preserved in ${recovery.quarantinePath}` };
  if (recovery.status === "fresh-quarantined") return { state, error: `partial repository was quarantined at ${recovery.quarantinePath}` };
  return { state };
}

async function checkoutJournalPresent(root: string, rel: string): Promise<boolean> {
  return fs.lstat(checkoutJournalDir(root, rel)).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

export async function gitResolveCmd(
  root: string,
  repoArg: string,
  verb: GitResolveVerb = "show-me",
  options: { json?: boolean; confirm?: string; forceDiscardIncoming?: boolean } = {},
  deps: GitResolveDeps = {},
): Promise<number> {
  const json = options.json === true;
  const forceDiscardIncoming = options.forceDiscardIncoming === true;
  let rel = ".";
  try {
    rel = normalizedRepo(root, repoArg);
  } catch {
    emit({ status: "refused", verb, repo: rel, code: "operation-failed", message: "the Git resolution could not complete safely; no confirmation can be reused" }, json, deps, root);
    return 1;
  }
  const now = deps.now ?? (() => new Date());
  // Extends the shipped show-me stderr seam to the two mutating verbs. stdout
  // stays byte-clean, so --json is unchanged.
  const stepWrite = deps.stderr ?? console.error;
  const step = (phase: string): void => {
    if (verb !== "show-me") stepWrite(`${verb}: ${phase}…`);
  };
  const confirmedKeepMine = verb === "keep-mine" && options.confirm !== undefined;
  if (verb === "keep-mine") {
    // Design 212 §3.1b layer 2: keep-mine publishes. Refuse before the remote,
    // state, repository, config, journal, and scan work below, and keep the named
    // condition rather than letting it collapse into a generic failure at the end.
    try {
      await assertCommandAllowedOnScopedBinding(root, "resolve");
    } catch (error) {
      if (!(error instanceof ScopedBindingRefusal)) throw error;
      emit({ status: "refused", verb, repo: rel, code: error.condition, message: error.message }, json, deps, root);
      return 1;
    }
  }
  const mutexOptions: SyncMutexOptions | undefined = confirmedKeepMine
    ? {
        ...deps.mutexOptions,
        acquisitionDeadlineMs: deps.mutexOptions?.acquisitionDeadlineMs ?? 60_000,
        onWait: () => {
          (deps.stderr ?? console.error)("waiting for the current sync cycle to finish…");
          deps.mutexOptions?.onWait?.();
        },
      }
    : deps.mutexOptions;
  const run = withWorkspaceSyncMutex(root, async (mutex) => {
    const env = await (deps.build ?? defaultBuild)(root);
    if (confirmedKeepMine) {
      await reconcileResolutionReceipt(root, env.cfg, {
        ...(env.remote ? { remote: env.remote } : {}),
        syncMutex: mutex,
        warningSink: deps.stderr,
      });
    }
    let state = await loadState(root, syncStreamId(env.cfg));
    const repoDir = repoDirOf(root, rel);
    let ctx = await repoCtx(repoDir).catch(() => undefined);
    // keep-mine confirmation is a sidecar-only transition. A journal must be
    // handled by an ordinary sync first; resolving or quarantining it here would
    // mutate checkout state before the publisher ACK.
    const recovered = verb === "keep-mine"
      ? { state, ...(await checkoutJournalPresent(root, rel) ? { error: "checkout journal is present" } : {}) }
      : await recoverFirst(root, rel, ctx, state);
    state = recovered.state;
    if (recovered.error || !ctx) {
      emit({ status: "refused", verb, repo: rel, code: "journal-recovery", message: RESOLVE_TYPED_REFUSAL["journal-recovery"] }, json, deps, root);
      return 1;
    }

    await assertGitTargetWithinRoot(root, rel);
    let record = repoRecordsForState(state)[rel];
    let incoming = verb === "keep-mine" ? record?.pending : incomingFor(record);
    if (!record || !incoming || !env.cfg.kek) {
      emit({
        status: "refused", verb, repo: rel, code: "no-incoming",
        message: verb === "keep-mine"
          ? "nothing is waiting to apply here — this hold clears on its own or names a different fix"
          : "no deferred incoming Git state is available for this repository",
      }, json, deps, root);
      return 1;
    }
    if (verb === "keep-mine" && env.cfg.syncGit !== true) {
      emit({ status: "refused", verb, repo: rel, code: "unsupported", message: "Git sync is disabled; enable it before confirming keep-mine" }, json, deps, root);
      return 1;
    }
    if (verb === "keep-mine" && await isGitBusy(ctx.repoDir, ctx)) {
      emit({ status: "refused", verb, repo: rel, code: "git-busy", message: "Git is busy; retry keep-mine after the other Git operation finishes" }, json, deps, root);
      return 1;
    }
    // Breadcrumbs (ORIG_HEAD-class, design 126) are inert leftovers, not
    // operations — refusing on them blocked the founder's live unwedge on a
    // stale ORIG_HEAD. Only genuinely in-progress op-state refuses.
    const opStateSnapshot = await readOpStateSnapshot(ctx.gitDir, hashFile);
    if (verb === "keep-mine" && hasInProgressOpState(opStateSnapshot)) {
      emit({ status: "refused", verb, repo: rel, code: "local-operation", message: "a Git operation is in progress; finish or abort it, then run keep-mine again" }, json, deps, root);
      return 1;
    }
    if (verb === "keep-mine") {
      const incomingCheckoutRef = headBranchOf(incoming.head);
      const ownedElsewhere = await strictOwnedBranches(ctx);
      if (incomingCheckoutRef && ownedElsewhere.has(incomingCheckoutRef)) {
        emit({
          status: "refused", verb, repo: rel, code: "worktree-ownership",
          message: "the incoming checkout branch is active in another linked worktree; switch or detach that worktree, then retry keep-mine",
        }, json, deps, root);
        return 1;
      }
    }
    let branchProtocol: FollowerBranchProtocol | undefined;
    if (verb === "take-theirs") {
      step("settling standing Git protocol artifacts");
      const preflight = await preflightManualPresentArtifacts({ root, rel, ctx, state });
      if (preflight.status === "hold") {
        emit({ status: "refused", verb, repo: rel, code: "artifact", message: preflight.reason }, json, deps, root);
        return 1;
      }
      state = preflight.state;
      record = preflight.record;
      incoming = preflight.incoming;
      branchProtocol = preflight.protocol;
    }
    const progressScheduler = deps.progressScheduler ?? {
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
    let progressTimer: unknown;
    let progressStarted = 0;
    const progressWrite = deps.stderr ?? console.error;
    const setProgressPhase = verb === "show-me" ? (phase: "staging" | "proving" | "found", count?: number) => {
      if (progressTimer !== undefined) { progressScheduler.clearInterval(progressTimer); progressTimer = undefined; }
      progressStarted = Date.now();
      if (phase === "staging") progressWrite("show-me: staging incoming bundle…");
      else if (phase === "proving") progressWrite(`show-me: proving ownership of ${count ?? 0} candidates…`);
      else progressWrite(`show-me: ${count ?? 0} local-only commits found`);
      if (phase !== "found") {
        progressTimer = progressScheduler.setInterval(() => {
          progressWrite(`show-me: still working (${Math.max(0, Math.floor((Date.now() - progressStarted) / 1000))}s)`);
        }, deps.progressIntervalMs ?? 10_000);
      }
    } : undefined;
    const takeSnapshot = () => buildSnapshot({
      root, rel, ctx: ctx!, state, record: record!, incoming: incoming!, store: env.store, kek: env.cfg.kek!, cfg: env.cfg, now: now(),
      ...(setProgressPhase ? { progress: (phase: "proving" | "found", count: number) => setProgressPhase(phase, count) } : {}),
    });
    if (setProgressPhase) {
      setProgressPhase("staging");
    }
    let snapshot: ResolveSnapshot;
    try {
      snapshot = await takeSnapshot();
    } finally {
      if (progressTimer !== undefined) progressScheduler.clearInterval(progressTimer);
    }
    if (verb === "show-me") {
      emit(snapshot.public, json, deps, root);
      return 0;
    }
    if (verb === "keep-mine") {
      return await runKeepMineResolve({
        root, rel, repoDir, json, deps, env, mutex, options, forceDiscardIncoming, now, step,
        state, record: record!, incoming: incoming!, ctx: ctx!, snapshot,
      });
    }
    return await runTakeTheirsResolve({
      root, rel, json, deps, env, mutex, options, now, step,
      state, record: record!, incoming: incoming!, ctx: ctx!, snapshot, branchProtocol,
    });

  }, mutexOptions);
  return run.catch((error) => {
    const busy = error instanceof WorkspaceSyncBusyError;
    const timedOut = error instanceof WorkspaceSyncTimeoutError;
    const classified: ResolveRefusalCode | undefined = error instanceof ManualLineageProofUnavailableError
      ? "manual-lineage-proof"
      : error instanceof ManualBaseProofIncompleteError ? "manual-base-proof" : undefined;
    emit({
      status: "refused",
      verb,
      repo: rel,
      code: classified ?? (busy || timedOut ? "sync-busy" : "operation-failed"),
      message: classified ? RESOLVE_TYPED_REFUSAL[classified]
        : timedOut ? "timed out waiting for the current sync cycle to finish; try again"
        : busy ? "daemon/CLI is syncing; retry, or run `rbox stop` first"
        : "the Git resolution could not complete safely; no confirmation can be reused",
    }, json, deps, root);
    return 1;
  });
}
