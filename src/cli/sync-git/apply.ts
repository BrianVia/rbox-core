import fs from "node:fs/promises";
import path from "node:path";
import { applyGitState, assertGitTargetWithinRoot, gitIdentity, gitIdentityKey, isGitBusy, preserveGitConflict, quarantineAndWipeGitState, repoCtxFromDisk, poolMap, type GitIdentity, type GitChainTimings, type GitSection, type IgnoreMatcher, type Manifest, type BlobStore, zeroGitChainTimings } from "../../engine/index.js";
import { canonicalizeGitConfig, validateCanonicalGitConfig, type GitConfig } from "../../engine/git/config-sync.js";
import { applyConfigTransaction, materializeFreshGitConfig, readConfigSnapshot, readParsedConfigSnapshot, sameConfigStatToken, type ConfigStatToken, type ConfigTransactionResult } from "../../engine/git/config-txn.js";
import { repoRecordsForState, type ConfigShapeIdentity, type RepoRecordInput, type SyncState, type WorkspaceConfig } from "../config.js";
import { completeConfigApply, configLaneState, type ConfigLaneState } from "../sync-state.js";
import { configInvalidSkipLogged, configOwnershipSkipLogged, repoDirOf, narrowerScope, projectedKey, emptyToUndef, errMsg, chainLock, gitApplyMutationKey, nestedRepoChains, gitApplyConcurrency } from "./shared.js";
import { gitConfigHash, sameConfigShape, configReceiver } from "./config-lane.js";
/** Local-vs-base divergence, projected onto the narrower of the two scopes (§7).
 *  No base → ANY local git identity is divergence-from-nothing (an independently
 *  created local repo must never be clobbered). No local identity (no repo, empty
 *  repo, deleted/unusable `.git`) → never diverged: there is no committed local work
 *  to preserve, so a clean (re)materialization loses nothing. */
function localDivergedFromBase(localId: GitIdentity | undefined, base: GitSection | undefined): boolean {
  if (!localId) return false;
  if (!base) return true;
  const n = narrowerScope(localId.refScope, base.refScope);
  return projectedKey(localId, n) !== projectedKey(base, n);
}
export interface GitPullOutcome {
  gitRepos?: Record<string, GitSection>;
  gitReposRemoved?: Record<string, string>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
  /** Completed/invalidation config-lane updates, saved atomically with this
   * pull's base and pending transitions by the step-4 packet composer. */
  configLane?: Record<string, ConfigLaneState>;
  gitApplyMetrics?: GitApplyMetrics;
}

export type GitApplyRunKind = "fresh" | "steady";
export type GitApplyRepoResult =
  | "unchanged"
  | "applied"
  | "deferred"
  | "conflict"
  | "removed"
  | "skipped";

export interface GitApplyRepoTiming {
  index: number;
  queueMs: number;
  wallMs: number;
  result: GitApplyRepoResult;
  commonDirGroup?: number;
  chain?: GitChainTimings;
}

export interface GitApplyMetrics {
  runKind: GitApplyRunKind;
  repos: number;
  commonDirGroups: number;
  results: Record<GitApplyRepoResult, number>;
  repoTimings: GitApplyRepoTiming[];
}

const emptyGitApplyResults = (): Record<GitApplyRepoResult, number> => ({
  unchanged: 0,
  applied: 0,
  deferred: 0,
  conflict: 0,
  removed: 0,
  skipped: 0,
});

const GIT_APPLY_RESULT_ABBR: Record<GitApplyRepoResult, string> = {
  unchanged: "u",
  applied: "a",
  deferred: "d",
  conflict: "c",
  removed: "rm",
  skipped: "s",
};

function finishGitApplyMetrics(
  metrics: GitApplyMetrics | undefined,
  commonDirGroups: Map<string, number> | undefined
): GitApplyMetrics | undefined {
  if (!metrics) return undefined;
  return {
    ...metrics,
    commonDirGroups: commonDirGroups?.size ?? 0,
    results: { ...metrics.results },
    repoTimings: metrics.repoTimings.map((timing) => ({
      ...timing,
      ...(timing.chain ? { chain: { ...timing.chain } } : {}),
    })),
  };
}

export function formatGitApplyMetrics(metrics: GitApplyMetrics): string {
  const resultBits = (Object.entries(metrics.results) as Array<[GitApplyRepoResult, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(",");
  const repoBits = metrics.repoTimings
    .map((t) => {
      const group = t.commonDirGroup === undefined ? "" : `g${t.commonDirGroup}`;
      const chain = t.chain && t.chain.chainLength > 0
        ? ` L${t.chain.chainLength}fd${Math.round(t.chain.fetchDecryptMs)}bv${Math.round(t.chain.bundleVerifyMs)}gi${Math.round(t.chain.gitImportMs)}io${Math.round(t.chain.indexOpStateMs)}`
        : "";
      return `i${t.index}q${t.queueMs}w${t.wallMs}${GIT_APPLY_RESULT_ABBR[t.result]}${group}${chain}`;
    })
    .join(",");
  return `mode=${metrics.runKind} repos=${metrics.repos} commonDirs=${metrics.commonDirGroups} results=${resultBits || "none"} repoMs=${repoBits || "none"}`;
}

/**
 * Pull-side git orchestration (design 43 §7, §9, §13.5): iterate
 * `remote.gitRepos ∪ base.gitRepos ∪ gitPendingRemote` per key. Per repo:
 *  - remote ABSENT → conflict-precedence first if a pending repo's local diverged
 *    (§13.5), then clear pending ([v6] absence supersedes pending), record a removal
 *    memory when the local `.git` survives, drop the base entry — NEVER touch local .git.
 *  - unchanged (projected onto the narrower scope) → base advances, no apply.
 *  - local diverged from base → per-repo CONFLICT: preserve remote, checkpoint base to
 *    remote, record `needsResolution` with the conflict-time local identity [v2, M2].
 *  - clean → applyGitState (containment + ignored-subtree refusal BEFORE any mutation);
 *    a removal-memory-matching leftover is treated as ABSENT → clean materialization
 *    (dir: quarantine + ref-wipe first; pointer: NEVER ref-wipe — guarded update-only).
 *  - deferred apply → record `gitPendingRemote`; that repo's base does not advance;
 *    every other repo advances independently.
 */
export async function applyGitSections(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  remote: Manifest,
  store: BlobStore,
  matcher: IgnoreMatcher,
  glog: (line: string) => void,
opts: {
    collectMetrics?: boolean;
    onProgress?: (done: number, total: number) => void;
    /** Workspace-wide legacy fallback: Git applies, config is left untouched. */
    disableConfigLane?: boolean;
    /** Deterministic fault injection for §11 pull-lane tests. */
    applyConfig?: typeof applyConfigTransaction;
    materializeFreshConfig?: typeof materializeFreshGitConfig;
  } = {}
): Promise<GitPullOutcome> {
  const baseRepos = state.lastSyncedManifest.gitRepos ?? {};
  const applied: Record<string, GitSection> = { ...baseRepos };
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  const pending = { ...(state.gitPendingRemote ?? {}) };
  const records = repoRecordsForState(state);
  const configLane: Record<string, ConfigLaneState> = {};
  let commonDirGroups: Map<string, number> | undefined;
  let metrics: GitApplyMetrics | undefined;
  const pack = (): GitPullOutcome => ({
    gitRepos: emptyToUndef(applied),
    gitReposRemoved: emptyToUndef(removedMem),
    gitNeedsResolution: emptyToUndef(needsRes),
    gitPendingRemote: emptyToUndef(pending),
    configLane: emptyToUndef(configLane),
    gitApplyMetrics: finishGitApplyMetrics(metrics, commonDirGroups),
  });
  if (!cfg.syncGit) return pack();
  const keys = [...new Set([...Object.keys(remote.gitRepos ?? {}), ...Object.keys(baseRepos), ...Object.keys(pending)])].sort();
  if (opts.collectMetrics) {
    commonDirGroups = new Map();
    metrics = {
      // "fresh" = no useful local/base git state (design 74 §3) — NOT sequence 0:
      // a file-synced workspace receiving its first remote.gitRepos is fresh for
      // git purposes even at a nonzero baseline (review finding: sequence-keyed
      // classification would poison the Phase-1 gate data).
      runKind: Object.keys(baseRepos).length === 0 && Object.keys(pending).length === 0 ? "fresh" : "steady",
      repos: keys.length,
      commonDirGroups: 0,
      results: emptyGitApplyResults(),
      repoTimings: [],
    };
  }
  if (keys.length === 0) return pack();
  // Fail closed ONCE, before any per-repo work: git sections (incl. pending ones) are
  // E2EE artifacts — without the key nothing below can decrypt-verify.
  if (!cfg.kek && keys.some((k) => remote.gitRepos?.[k] !== undefined || pending[k] !== undefined)) {
    throw new Error("E2EE required: remote has git state but no key on this device — run `rbox pair`/`rbox key recover`.");
  }

  const commonDirGroupFor = async (repoDir: string, hasDotGit: boolean): Promise<number | undefined> => {
    if (!commonDirGroups || !hasDotGit) return undefined;
    const ctx = await repoCtxFromDisk(repoDir).catch(() => undefined);
    if (!ctx) return undefined;
    const key = path.resolve(ctx.commonDir);
    let group = commonDirGroups.get(key);
    if (group === undefined) {
      group = commonDirGroups.size + 1;
      commonDirGroups.set(key, group);
    }
    return group;
  };

  const laneRecord = (rel: string): RepoRecordInput => ({
    sourceSeq: records[rel]?.sourceSeq ?? state.lastSyncedSequence,
    ...(configLane[rel] ?? configLaneState(records[rel] ?? { repoGen: 0, sourceSeq: state.lastSyncedSequence })),
  });
  const replaceLane = (rel: string, record: RepoRecordInput): void => {
    configLane[rel] = configLaneState(record);
  };
  const invalidateLaneShape = (rel: string, shape: ConfigShapeIdentity | undefined): RepoRecordInput => {
    const current = laneRecord(rel);
    if (sameConfigShape(current.cfgShape, shape)) return current;
    const reset: RepoRecordInput = { sourceSeq: current.sourceSeq, ...(shape === undefined ? {} : { cfgShape: shape }) };
    replaceLane(rel, reset);
    return reset;
  };
  const completeLane = (
    rel: string,
    shape: ConfigShapeIdentity,
    hashes: { pre: string; post: string; incoming: string; basePre?: string; postToken: ConfigStatToken }
  ): void => {
    replaceLane(rel, {
      ...completeConfigApply(laneRecord(rel), {
        pre: hashes.pre,
        post: hashes.post,
        incoming: hashes.incoming,
        ...(hashes.basePre === undefined ? {} : { basePre: hashes.basePre }),
        postToken: hashes.postToken,
      }),
      cfgShape: shape,
    });
  };
  const configFailure = (result: Exclude<ConfigTransactionResult, { status: "completed" }>): Error =>
    new Error(`config ${result.status}: ${result.fault.reason}`);

  /** Run the config mutation only after the caller has selected the correct Git
   * disposition. Existing repos use the optimistic locked transaction; a truly
   * fresh repo uses the step-3 private-target helper. */
  const runConfigApply = async (
    rel: string,
    repoDir: string,
    incoming: GitConfig,
    baseConfig: GitConfig | undefined,
    receiver: { fresh: true } | { fresh: false; shape: ConfigShapeIdentity; configPath: string }
  ): Promise<void> => {
    if (receiver.fresh) {
      await (opts.materializeFreshConfig ?? materializeFreshGitConfig)(repoDir, incoming, path.join(repoDir, ".git"));
      const ctx = await repoCtxFromDisk(repoDir);
      if (!ctx) throw new Error("fresh config apply lost repository context");
      const owned = await configReceiver(root, ctx);
      if (!owned.owned) throw new Error("fresh config target is not receiver-owned");
      const installed = await readParsedConfigSnapshot(repoDir, owned.configPath, "locked");
      if (!installed.ok) throw new Error(`fresh config post-read: ${installed.fault.reason}`);
      const post = canonicalizeGitConfig(installed.snapshot.entries);
      if (!post.ok) throw new Error(`fresh config post-parse: ${post.reason}`);
      completeLane(rel, owned.shape, {
        pre: gitConfigHash({}),
        post: gitConfigHash(post.config),
        incoming: gitConfigHash(incoming),
        ...(baseConfig === undefined ? {} : { basePre: gitConfigHash(baseConfig) }),
        postToken: installed.snapshot.token,
      });
      return;
    }

    const result = await (opts.applyConfig ?? applyConfigTransaction)(repoDir, receiver.configPath, incoming, { baseConfig });
    if (result.status !== "completed") throw configFailure(result);
    for (const warning of result.warnings) {
      try {
        glog(`git-sync WARNING ${rel}: config ${warning}`);
      } catch {
        // Observability after the rename commit point is strictly non-fatal.
      }
    }
    completeLane(rel, receiver.shape, {
      pre: result.preHash,
      post: result.postHash,
      incoming: result.incomingHash,
      ...(result.baseHash === undefined ? {} : { basePre: result.baseHash }),
      postToken: result.postToken,
    });
  };

  const processRepo = async (rel: string, chainTimings?: GitChainTimings): Promise<{ result: GitApplyRepoResult; commonDirGroup?: number }> => {
    const wireRemoteSec = remote.gitRepos?.[rel];
    let remoteSec = wireRemoteSec;
    if (wireRemoteSec?.config !== undefined) {
      const config = validateCanonicalGitConfig(wireRemoteSec.config);
      const invalidReason = !config.ok
        ? config.reason
        : wireRemoteSec.refScope === "scoped"
          ? "scoped git section cannot carry config"
          : undefined;
      if (invalidReason) {
        // Treat the field as truly absent for every downstream decision and for
        // the persisted base/pending section. This prevents a later push from
        // carrying the invalid field back onto the wire.
        remoteSec = { ...wireRemoteSec };
        delete remoteSec.config;
        const logKey = `${root}\0${rel}`;
        if (!configInvalidSkipLogged.has(logKey)) {
          configInvalidSkipLogged.add(logKey);
          glog(`git-sync WARNING ${rel}: ignored invalid incoming config (${invalidReason}); Git state continues`);
        }
      }
    }
    const baseSec = baseRepos[rel];
    const pend = pending[rel];
    const repoDir = repoDirOf(root, rel);
    const dotGit = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
    const commonDirGroup = await commonDirGroupFor(repoDir, dotGit !== undefined);

    // Receiver quiescence (design 43 §7): a busy repo defers only itself, and the busy
    // check must run BEFORE any identity comparison — a lock makes write-tree fail,
    // flipping gitIdentity onto the raw-index fallback, which would read as FALSE
    // divergence (spurious conflict) or poison a removal memory with a transient key.
    const busy = dotGit !== undefined && (await isGitBusy(repoDir));
    if (busy && remoteSec) {
      pending[rel] = remoteSec; // apply needs quiescence — retry next pull; outbound carries newest truth
      glog(`git-sync deferred ${rel}: receiver git busy`);
      return { result: "deferred", commonDirGroup };
    }
    // NOTE: remote ABSENCE is processed even when busy — it never mutates local .git,
    // and skipping it would leave gitPendingRemote/base carrying a section the remote
    // deleted, which the next file-only push would resurrect (codex step-3 BLOCKER).
    const localId = dotGit ? await gitIdentity(repoDir) : undefined;

    if (!remoteSec) {
      // §9 removal + [v6] absence-supersedes-pending. The DIVERGENCE EXAMINATION runs
      // first (§13.5: never stamp a removal memory over unexamined local divergence),
      // then the pure state transitions apply UNCONDITIONALLY — absence is the newer
      // truth no matter what else succeeds — and only then the best-effort recovery
      // preserve. Ordering is crash-safety (codex step-3 round-3 MAJOR): if the
      // preserve throws (blob/fs failure), the per-repo catch must not leave a stale
      // pending/base entry for the next push to resurrect.
      const diverged = pend !== undefined && localDivergedFromBase(localId, baseSec);
      delete pending[rel];
      delete needsRes[rel];
      if (rel in applied) {
        delete applied[rel];
        glog(`git-sync removed ${rel} (remote deleted; local .git untouched)`);
      }
      if (dotGit) {
        // Resurrection guard [v2, B4]: the leftover's identity at removal. On a BUSY
        // repo the live identity is the volatile raw-index fallback — record the base
        // section's identity instead (projected onto the leftover's shape), which is
        // lock-immune and equals the live identity whenever the leftover is untouched.
        removedMem[rel] =
          busy && baseSec ? projectedKey(baseSec, dotGit.isFile() ? "scoped" : "all") : gitIdentityKey(localId);
      }
      // §13.5 conflict precedence: the pending remote section is preserved for manual
      // recovery. Best-effort — preserve never mutates local branches/index/identity,
      // so a failure loses only the convenience recovery bundle (logged loudly); the
      // user's diverged local work is untouched either way. (On a busy repo the
      // raw-index fallback can only over-trigger this — a safe, logged no-clobber.)
      if (diverged && pend) {
        try {
          const { recoveryBundle } = await preserveGitConflict(repoDir, pend, store, cfg.kek!);
          glog(
            `git-sync CONFLICT ${rel} — remote deleted the repo while an apply was pending and local diverged; local kept, pending remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}`
          );
        } catch (e) {
          glog(`git-sync WARNING ${rel}: could not preserve the pending remote section after the remote deletion (local work untouched): ${errMsg(e)}`);
        }
      }
      return { result: "removed", commonDirGroup };
    }

    // Removal memory: a leftover whose identity still EQUALS the memory is treated as
    // ABSENT (clean materialization target [v3/v4]); a leftover that CHANGED re-enters
    // the normal rules (conflict path) with the memory cleared. An UNREADABLE pointer
    // leftover (dangling gitfile — identity unknowable) defers instead: guessing would
    // either wipe the guard or mis-run the conflict path.
    let cleanMaterialize = false;
    if (removedMem[rel] !== undefined) {
      if (!dotGit) {
        delete removedMem[rel]; // leftover gone → memory pruned; plain fresh target
      } else if (gitIdentityKey(localId) === removedMem[rel]) {
        cleanMaterialize = true;
      } else if (!localId && dotGit.isFile()) {
        pending[rel] = remoteSec;
        glog(`git-sync deferred ${rel}: leftover pointer repo unreadable — keeping removal memory`);
        return { result: "deferred", commonDirGroup };
      } else {
        delete removedMem[rel]; // identity genuinely changed (incl. a re-init'd empty dir repo)
      }
    }

    const defer = (reason: string) => {
      pending[rel] = remoteSec; // [v5]: outbound pushes carry newest unapplied truth
      glog(`git-sync deferred ${rel}: ${reason}`);
    };

    // Design 93 §6/§9. The config predicate is deliberately decided before
    // EITHER unchanged shortcut. Receiver ownership is local shape, not sender
    // shape; cross-shape rows skip config loudly once while Git keeps its existing
    // disposition. A shape mismatch first clears the old lane markers and records
    // the new identity in this pull's atomic repo transition.
    let configDue = false;
    let configTarget: { fresh: true } | { fresh: false; shape: ConfigShapeIdentity; configPath: string } | undefined;
    if (!opts.disableConfigLane && remoteSec.config !== undefined) {
      if (!dotGit) {
        invalidateLaneShape(rel, undefined);
        configDue = true;
        configTarget = { fresh: true };
      } else {
        const diskCtx = await repoCtxFromDisk(repoDir).catch(() => undefined);
        if (!diskCtx) {
          invalidateLaneShape(rel, undefined);
          const logKey = `${root}\0${rel}`;
          if (!configOwnershipSkipLogged.has(logKey)) {
            configOwnershipSkipLogged.add(logKey);
            glog(`git-sync config skipped ${rel}: receiver repository shape is unreadable/non-owned`);
          }
        } else {
          const receiver = await configReceiver(root, diskCtx);
          const lane = invalidateLaneShape(rel, receiver.shape);
          if (!receiver.owned) {
            const logKey = `${root}\0${rel}`;
            if (!configOwnershipSkipLogged.has(logKey)) {
              configOwnershipSkipLogged.add(logKey);
              glog(`git-sync config skipped ${rel}: receiver ${diskCtx.kind} shape does not own the common config`);
            }
          } else {
            configTarget = { fresh: false, shape: receiver.shape, configPath: receiver.configPath };
            const current = await readConfigSnapshot(receiver.configPath);
            const token = current.ok ? current.snapshot.token : undefined;
            configDue = gitConfigHash(remoteSec.config) !== lane.cfgApplied || !sameConfigStatToken(token, lane.cfgToken);
          }
        }
      }
    }

    // A conflict checkpoint owns the Git disposition until the user changes the
    // recorded local identity. Config waits; after that change the same due
    // predicate above feeds either the converged shortcut or a new conflict/apply.
    let resolutionChanged = false;
    if (needsRes[rel] !== undefined) {
      if (gitIdentityKey(localId) === needsRes[rel]) {
        return { result: "unchanged", commonDirGroup };
      }
      delete needsRes[rel];
      resolutionChanged = true;
    }

    const applyConfigOnly = async (): Promise<boolean> => {
      if (!configDue || !configTarget || configTarget.fresh) return !configDue;
      try {
        await runConfigApply(rel, repoDir, remoteSec.config!, baseSec?.config, configTarget);
        return true;
      } catch (error) {
        defer(errMsg(error));
        return false;
      }
    };

    // Projected identity comparison on the NARROWER of the two scopes (§7) — what makes
    // worktree→standalone→worktree round-trips converge without apply ping-pong.
    const cmpScope = narrowerScope(remoteSec.refScope, baseSec?.refScope);
    const remoteChanged = projectedKey(remoteSec, cmpScope) !== (baseSec ? projectedKey(baseSec, cmpScope) : "none");
    if (!remoteChanged && !pend && !resolutionChanged && !(configDue && configTarget?.fresh)) {
      if (!(await applyConfigOnly())) return { result: "deferred", commonDirGroup };
      applied[rel] = remoteSec; // unchanged → base advances (possibly across scopes)
      return { result: "unchanged", commonDirGroup };
    }

    // Already converged? (e.g. a pending retry finding the user manually resolved, or a
    // remote change that equals local work) → advance base, clear pending, no mutation.
    // A removal-memory leftover never takes this shortcut: it must go through the §9
    // clean-materialization path (wipe on dir targets) so stale refs can't survive.
    if (localId && !cleanMaterialize) {
      const n = narrowerScope(localId.refScope, remoteSec.refScope);
      if (projectedKey(localId, n) === projectedKey(remoteSec, n)) {
        if (!(await applyConfigOnly())) return { result: "deferred", commonDirGroup };
        applied[rel] = remoteSec;
        delete pending[rel];
        delete removedMem[rel];
        return { result: "unchanged", commonDirGroup };
      }
    }

    const kek = cfg.kek!; // guaranteed by the fail-closed gate above
    if (!cleanMaterialize && localDivergedFromBase(localId, baseSec)) {
      // Per-repo conflict: never auto-clobber local. Preserve remote for manual merge,
      // checkpoint base to remote (stop pull-conflict-looping), and suppress capture
      // until the local identity changes from this recorded value [v2, M2].
      const { recoveryBundle } = await preserveGitConflict(repoDir, remoteSec, store, kek);
      applied[rel] = remoteSec;
      needsRes[rel] = gitIdentityKey(localId);
      delete pending[rel];
      glog(`git-sync CONFLICT ${rel} — local kept; remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}. Resolve manually.`);
      return { result: "conflict", commonDirGroup };
    }

    // Clean apply. Refusals and containment run BEFORE any mutation [v2, B5].
    if (rel !== "." && (matcher.ignores(rel) || matcher.ignores(`${rel}/`))) {
      defer("target is inside an ignored subtree — refusing to materialize");
      return { result: "deferred", commonDirGroup };
    }
    try {
      await assertGitTargetWithinRoot(root, rel);
    } catch (e) {
      defer(errMsg(e));
      return { result: "deferred", commonDirGroup };
    }

    // Dir leftover clean materialization [v5]: quarantine (capture-grade pinning +
    // index/op-state copies) then wipe syncable refs/index/op-state, so the leftover's
    // old refs can never re-enter a later all-scope capture. Runs as applyGitState's
    // beforeMutate hook — i.e. ONLY after every remote artifact has been fetched,
    // decrypted, and verified — so a missing/corrupt bundle can never strand a wiped
    // repo (codex step-3 MAJOR). Hook/quarantine failure → defer, nothing wiped.
    // Pointer leftover: NEVER ref-wipe (shared main-clone store) — the guarded
    // update-only apply is the whole treatment; the memory clears on success.
    const wipeLeftover = cleanMaterialize && dotGit !== undefined && dotGit.isDirectory();
    const configAfterGit = configDue && configTarget && remoteSec.config !== undefined
      ? async () => runConfigApply(rel, repoDir, remoteSec.config!, baseSec?.config, configTarget!)
      : undefined;
    const res = await applyGitState(
      repoDir,
      remoteSec,
      store,
      kek,
      {
        ...(wipeLeftover
          ? {
            beforeMutateWipesRefs: true,
            beforeMutate: async () => {
              await quarantineAndWipeGitState(repoDir);
              delete removedMem[rel]; // leftover quarantined + wiped — the memory served its purpose
            },
          }
          : {}),
        ...(configAfterGit ? { afterGitMutate: configAfterGit } : {}),
        ...(chainTimings ? { chainTimings } : {}),
      }
    );
    if (res.applied) {
      // Belt-and-braces post-init containment re-verify (§7 [v2, B5; v3]).
      try {
        await assertGitTargetWithinRoot(root, rel);
      } catch (e) {
        glog(`git-sync WARNING ${rel}: post-apply containment check failed: ${errMsg(e)}`);
      }
      applied[rel] = remoteSec;
      delete pending[rel];
      delete removedMem[rel];
      glog(`git-sync applied ${rel}${res.filteredRefs?.length ? ` (filtered refs: ${res.filteredRefs.join(" ")})` : ""}`);
      return { result: "applied", commonDirGroup };
    } else {
      defer(res.reason ?? "apply deferred");
      return { result: "deferred", commonDirGroup };
    }
  };

  const queuedAt = Date.now();
  const commonDirLocks = new Map<string, Promise<void>>();
  const indexes = new Map(keys.map((rel, i) => [rel, i]));
  let progressDone = 0;
  const runRepo = async (rel: string): Promise<void> => {
    const i = indexes.get(rel)!;
    let startedAt = Date.now();
    let result: GitApplyRepoResult = "deferred";
    let commonDirGroup: number | undefined;
    const chainTimings = metrics ? zeroGitChainTimings() : undefined;
    try {
      const lockKey = await gitApplyMutationKey(root, rel);
      await chainLock(commonDirLocks, lockKey, async () => {
        startedAt = Date.now();
        const processed = await processRepo(rel, chainTimings);
        result = processed.result;
        commonDirGroup = processed.commonDirGroup;
      });
    } catch (e) {
      // Per-repo failures defer only THAT repo — one bad repo (a blob missing mid
      // conflict-preserve, an ENOTDIR/hostile target, an fs error) must never abort
      // the whole pull or block the other repos' base advance.
      const remoteSec = remote.gitRepos?.[rel];
      if (remoteSec) pending[rel] = remoteSec;
      glog(`git-sync deferred ${rel}: ${errMsg(e)}`);
      result = "deferred";
    } finally {
      if (metrics) {
        metrics.results[result] += 1;
        metrics.repoTimings.push({
          index: i,
          queueMs: startedAt - queuedAt,
          wallMs: Date.now() - startedAt,
          result,
          commonDirGroup,
          chain: chainTimings,
        });
      }
      opts.onProgress?.(++progressDone, keys.length);
    }
  };
  await poolMap(nestedRepoChains(keys), gitApplyConcurrency(), async (chain) => {
    for (const rel of chain) await runRepo(rel);
  });
  return pack();
}
