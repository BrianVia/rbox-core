import fs from "node:fs/promises";
import path from "node:path";
import { GitCaptureDeferredError, discoverGitRepos, gitIdentity, gitIdentityKey, gitPreflight, inTreeWorktreeParentRel, isGitBusy, isPresentButUnreadableError, gitSectionBlobRefs, repoCtxFromDisk, poolMap, type GitRepoKind, type GitSection, type IgnoreMatcher, type RepoCtx } from "../../engine/index.js";
import { type GitConfigRunner } from "../../engine/git/config-txn.js";
import { expectedStateNonce, repoRecordsForState, type GitDeferralReason, type SyncState, type WorkspaceConfig } from "../config.js";
import { savePublishedRepoIntent } from "../sync-state.js";
import type { SyncRemote } from "../remote.js";
import type { TransferProgress } from "../transfer-progress.js";
import { GIT_CAPTURE_CONCURRENCY, configCredentialSkipLogged, configOwnershipSkipLogged, gitRepoCap, repoDirOf, carryMatrixMatches, emptyToUndef, errMsg, capturePlannedGitSection } from "./shared.js";
import { configReceiver, gitConfigHash, readLocalGitConfig, shouldPublishGitConfig, type LocalCfgRead } from "./config-lane.js";
import { gitFingerprint, gitFingerprintRun } from "./fingerprint.js";
import { loadGitDivergenceCache, saveGitDivergenceCache, fingerprintHitProbe, buildPlanProbe, writeDivergenceCacheEntry, isGitRepoKind, type FingerprintHitProbeResult, type DivergenceCacheProbeSnapshot, type DivergenceCacheWriteResult } from "./divergence-cache.js";
import { checkoutJournalBinding, clearFollowJournal, quarantineUnboundFollowJournal, recoverFollowJournal } from "./follow.js";
/** The outcome of push-side git orchestration: the outbound `gitRepos` map, whether it
 *  differs from what the last commit carried, the local-only state after this cycle
 *  (persisted only on a successful commit — recomputed idempotently otherwise), and
 *  the forensic counts for the §10 log line. */
export interface GitPushPlan {
  gitRepos?: Record<string, GitSection>;
  changed: boolean;
  /** Design 108 §3.1: this plan deferred git capture (files-first genesis) AND at least
   *  one repo actually exists to attach — so the driver should run commit 2. Absent when
   *  files-first was inactive or the workspace has no git repos (commit 1 is terminal). */
  filesFirstDeferred?: boolean;
  gitReposRemoved?: Record<string, string>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
  /** Config hashes authored by this exact plan. Step 4 deliberately initializes
   * this empty; publication/capture rows add entries in steps 5 and 7. */
  authoredCfgHashByRepo: Record<string, string>;
  captured: string[];
  carried: string[];
  deferred: Array<{ relPath: string; reason: string }>;
  captureDeferrals: Record<string, GitDeferralReason>;
  configDeferrals: Record<string, GitDeferralReason>;
  captureObserved: string[];
  configObserved: string[];
  /** Design 68 §3.3 — in-tree linked-worktree pointers whose full-store capture was
   *  policy-skipped because the owning main clone is captured in this same cycle (history
   *  travels with the parent bundle). Base-carry, never a drop — so no removal memory. */
  skipped: Array<{ relPath: string; reason: string }>;
  removed: string[];
  gitPlanStats?: GitPlanStats;
}

export interface GitPlanStats {
  repos: number;
  fpHits: number;
  fpMisses: number;
  fpUntrusted: number;
  spawnedRepos: number;
  pointerPreSkips: number;
  parentRelCached: number;
  carried: number;
  captured: number;
}

export interface GitPlanOptions {
  /** Forensic sink shared with the surrounding sync operation. */
  onGitLog?: (line: string) => void;
  /** Deterministic test seam for the snapshot-only config subprocess. */
  gitConfigRunner?: GitConfigRunner;
  /** Workspace lock identity/link support is unavailable. Preserve Git syncing,
   * but neither read nor author config-lane updates. */
  disableConfigLane?: boolean;
  /** Degraded workspace serialization permits rollback-only journal recovery. */
  degradedMutex?: boolean;
  /** Design 108 §3.2: files-first genesis defer. When true, planGitSections returns an
   *  empty/absent git section with changed=false WITHOUT discovering/capturing any repo
   *  and WITHOUT touching any local-only sidecar (base/pending/needsRes/removed are all
   *  empty on a genuine genesis, so they pass through untouched). Git is re-derived as
   *  owed by the next ordinary push. */
  filesFirstDefer?: boolean;
}

/**
 * Push-side git orchestration (design 43 §6): discover every repo in the tree, then per
 * repo either CARRY (pending section, needs-resolution checkpoint, or unchanged identity
 * per the §7 shape×scope matrix), CAPTURE (bounded pool), DEFER with base carry (any
 * per-repo failure — never abort the push), or REMOVE (repo dir gone entirely, §9).
 * `force` is the per-relPath 422 recapture set [v2, M5]: forced repos skip the carry
 * fast-path; a forced repo that cannot recapture is DROPPED from this commit (the
 * non-looping failure path [v3]) rather than re-referencing blobs the server lost.
 */
export async function planGitSections(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  api: SyncRemote,
  force: ReadonlySet<string>,
  matcher: IgnoreMatcher,
  /** Per-repo capture progress (the `gitcap` phase): the longest silent phase on a
   *  repo-heavy first push — one `git bundle` per repo, minutes each. Emits after each
   *  capture settles so `done` is a truthful completed-count under bounded concurrency;
   *  `detail` is the repo just captured. Display-only. */
  onProgress?: TransferProgress,
  backoff?: (attempt: number) => Promise<void>,
  options: GitPlanOptions = {}
): Promise<GitPushPlan> {
  const base = { ...(state.lastSyncedManifest.gitRepos ?? {}) };
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  const pending = { ...(state.gitPendingRemote ?? {}) };
  const captured: string[] = [];
  let carried: string[] = [];
  const authoredCfgHashByRepo: Record<string, string> = {};
  const removed: string[] = [];
  const deferred: Array<{ relPath: string; reason: string }> = [];
  const configLaneDefers = new Set<(typeof deferred)[number]>();
  const configLaneItems = new Set<(typeof deferred)[number]>();
  const captureObserved = new Set<string>();
  const configObserved = new Set<string>();
  const skipped: Array<{ relPath: string; reason: string }> = [];
  const out: Record<string, GitSection> = {};
  const cache = await loadGitDivergenceCache(root);
  const fingerprintRun = gitFingerprintRun("per-decision");
  const fastPathParentRel = new Map<string, string | undefined>();
  const stats: GitPlanStats = {
    repos: 0,
    fpHits: 0,
    fpMisses: 0,
    fpUntrusted: 0,
    spawnedRepos: 0,
    pointerPreSkips: 0,
    parentRelCached: 0,
    carried: 0,
    captured: 0,
  };
  const glog = options.onGitLog ?? ((line: string) => console.error(line));
  const logOnce = (seen: Set<string>, rel: string, line: string) => {
    const key = `${root}\0${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    glog(line);
  };
  const noteCredentialSkip = (rel: string) =>
    logOnce(configCredentialSkipLogged, rel, `git-sync WARNING ${rel}: skipped credential-bearing remote URL from config capture`);
  const readConfigForPush = (rel: string, diskCtx?: RepoCtx) =>
    readLocalGitConfig(root, rel, diskCtx, options.gitConfigRunner, () => noteCredentialSkip(rel));
  const captureReason = (reason: string): GitDeferralReason => {
    if (/\bbusy\b/i.test(reason)) return "git-busy";
    if (/ownership|worktree/i.test(reason)) return "worktree-ownership";
    if (/containment|outside.*root/i.test(reason)) return "containment";
    if (/unsupported|structural|shallow|bare|alternates/i.test(reason)) return "unsupported";
    if (/capture|artifact|blob|decrypt|import|bundle/i.test(reason)) return "artifact";
    if (/unreadable|no usable \.git|preflight/i.test(reason)) return "unreadable";
    return "other";
  };
  const plan = (): GitPushPlan => {
    // Changed = the outbound map differs from what the LAST COMMIT carried. For a
    // pending repo the last commit carried the pending section itself (see the per-repo
    // base-advance in pushManifest), so the expected-previous map is base ∪ pending —
    // a steady pending carry is NOT a change (no echo-commit storm).
    const prev: Record<string, GitSection> = { ...base, ...(state.gitPendingRemote ?? {}) };
    let changed = false;
    for (const k of new Set([...Object.keys(out), ...Object.keys(prev)])) {
      if (!out[k] || !prev[k] || (out[k] !== prev[k] && JSON.stringify(out[k]) !== JSON.stringify(prev[k]))) {
        changed = true;
        break;
      }
    }
    const captureDeferrals: Record<string, GitDeferralReason> = {};
    const configDeferrals: Record<string, GitDeferralReason> = {};
    for (const item of deferred) {
      if (configLaneDefers.has(item)) configDeferrals[item.relPath] = "config";
      else if (configLaneItems.has(item)) continue;
      else captureDeferrals[item.relPath] = captureReason(item.reason);
    }
    return {
      gitRepos: emptyToUndef(out),
      changed,
      gitReposRemoved: emptyToUndef(removedMem),
      gitNeedsResolution: emptyToUndef(needsRes),
      gitPendingRemote: emptyToUndef(pending),
      authoredCfgHashByRepo,
      captured,
      carried,
      deferred,
      captureDeferrals,
      configDeferrals,
      captureObserved: [...captureObserved].sort(),
      configObserved: [...configObserved].sort(),
      skipped,
      removed,
      gitPlanStats: { ...stats, carried: carried.length, captured: captured.length },
    };
  };
  // Design 108 §3.2/§3.1: genesis files-first defer — attach nothing this commit. On a
  // genuine genesis (parentSequence 0, fresh state) base/pending/needsRes/removed are
  // empty, so plan() yields gitRepos=undefined, changed=false, sidecars absent — git is
  // re-derived as owed by the next ordinary push. A cheap discovery (NO capture) decides
  // whether commit 2 is warranted: with ≥1 repo, flag `filesFirstDeferred` so the driver
  // attaches; with zero repos there is nothing owed and commit 1 is terminal (no wasted
  // second push, no "history attached" lie).
  if (options.filesFirstDefer && cfg.syncGit) {
    const discovered = await discoverGitRepos(root, matcher);
    return { ...plan(), ...(discovered.length > 0 ? { filesFirstDeferred: true } : {}) };
  }
  if (!cfg.syncGit) {
    // Opt-out: out stays empty → any base entries read as removal (the opt-out
    // propagates), and the local-only bookkeeping is abandoned with it — a surviving
    // pending entry would otherwise re-trigger the per-repo base restore every push
    // (changed forever → echo-commit loop).
    for (const k of new Set([...Object.keys(state.repoRecords ?? {}), ...Object.keys(base), ...Object.keys(pending)])) {
      captureObserved.add(k);
      configObserved.add(k);
    }
    for (const k of Object.keys(pending)) delete pending[k];
    for (const k of Object.keys(needsRes)) delete needsRes[k];
    for (const k of Object.keys(removedMem)) delete removedMem[k];
    return plan();
  }
  if (!cfg.kek) throw new Error("git-sync requires an encryption key (E2EE)"); // §28: artifacts are encrypted
  const kek = cfg.kek;

  const discovered = await discoverGitRepos(root, matcher);
  const kindByPath = new Map(discovered.map((d) => [d.relPath, d.kind]));

  // §9: removal memories are pruned ONLY when the local `.git` genuinely disappears —
  // never on mere discovery absence (an ignored-but-present leftover is undiscoverable
  // yet must keep its resurrection guard for when it is unignored).
  for (const rel of Object.keys(removedMem)) {
    if (kindByPath.has(rel)) continue;
    const dotGit = await fs.lstat(path.join(repoDirOf(root, rel), ".git")).catch(() => undefined);
    if (!dotGit) delete removedMem[rel];
  }

  const keys = [...new Set([...kindByPath.keys(), ...Object.keys(base), ...Object.keys(pending)])].sort();
  const recoveryBlocked = new Map<string, string>();
  for (const rel of keys) {
    const repoDir = repoDirOf(root, rel);
    const ctx = await repoCtxFromDisk(repoDir).catch(() => undefined);
    if (!ctx) {
      const recovery = await quarantineUnboundFollowJournal(root, rel, state.stream, expectedStateNonce(state));
      if (recovery.status === "binding-mismatch") glog(`git-sync WARNING ${rel}: journal for an absent/unreadable repository quarantined at ${recovery.quarantinePath}`);
      else if (recovery.status === "defer") recoveryBlocked.set(rel, recovery.reason);
      continue;
    }
    const binding = await checkoutJournalBinding(state.stream, expectedStateNonce(state), ctx);
    const recovery = await recoverFollowJournal(root, rel, binding);
    if (recovery.status === "keep") {
      if (options.degradedMutex) {
        recoveryBlocked.set(rel, "published checkout journal awaits non-degraded state save");
        continue;
      }
      const published = await savePublishedRepoIntent(root, state, rel, recovery.intended);
      state = published.state;
      const record = repoRecordsForState(state)[rel];
      if (record?.base) base[rel] = record.base; else delete base[rel];
      if (record?.pending) pending[rel] = record.pending; else delete pending[rel];
      if (record?.removedKey) removedMem[rel] = record.removedKey; else delete removedMem[rel];
      if (record?.resolutionKey) needsRes[rel] = record.resolutionKey; else delete needsRes[rel];
      if (published.disposition === "landed"
        || published.disposition === "already-semantic"
        || published.disposition === "superseded") {
        await clearFollowJournal(root, rel);
      }
      glog(`git-sync recovered published checkout ${rel} before capture`);
    } else if (recovery.status === "defer") {
      recoveryBlocked.set(rel, recovery.reason);
    } else if (recovery.status === "human-intervened") {
      recoveryBlocked.set(rel, `crash-window human changes preserved; journal quarantined at ${recovery.quarantinePath}`);
    } else if (recovery.status === "binding-mismatch") {
      glog(`git-sync WARNING ${rel}: stale checkout journal quarantined at ${recovery.quarantinePath}`);
    } else if (recovery.status === "fresh-quarantined") {
      recoveryBlocked.set(rel, `partial fresh repository quarantined at ${recovery.quarantinePath}`);
    }
  }
  for (const rel of keys) captureObserved.add(rel);
  stats.repos = keys.length;
  // New-repo admission budget [v2, M4]: base/pending repos never count as new work.
  const cap = gitRepoCap();
  let admitted = new Set([...Object.keys(base), ...Object.keys(pending)]).size;

  let toCapture: string[] = [];
  const carryOwnedWithConfig = async (rel: string, baseSec: GitSection, bracketed?: LocalCfgRead, knownCtx?: RepoCtx): Promise<void> => {
    out[rel] = baseSec;
    carried.push(rel);
    if (options.disableConfigLane) return;
    configObserved.add(rel);
    const diskCtx = knownCtx ?? (await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined));
    if (!diskCtx || diskCtx.kind !== "dir") {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: local ${diskCtx?.kind ?? "unreadable"} shape does not own the common config`);
      return;
    }
    const receiver = await configReceiver(root, diskCtx).catch(() => undefined);
    if (!receiver?.owned) {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: local common config is outside workspace ownership`);
      return;
    }
    const localCfg = bracketed ?? (await readConfigForPush(rel));
    if (localCfg.status === "over-bounds") {
      const item = {
        relPath: rel,
        reason: `git config over wire bounds — publication disabled; carrying base verbatim (${localCfg.reason})`,
      };
      deferred.push(item);
      configLaneItems.add(item);
      return;
    }
    if (localCfg.status === "failed") {
      const item = {
        relPath: rel,
        reason: `git config ${localCfg.fault.disposition === "permanent" ? "disabled" : "deferred"} (${localCfg.fault.reason}) — carrying base verbatim`,
      };
      deferred.push(item);
      configLaneItems.add(item);
      if (localCfg.fault.disposition === "transient") configLaneDefers.add(item);
      return;
    }
    if (!shouldPublishGitConfig(baseSec.config, localCfg.cached, state.repoRecords?.[rel]?.cfgSynced)) return;
    out[rel] = { ...baseSec, config: localCfg.config };
    authoredCfgHashByRepo[rel] = localCfg.cached.hash;
  };
  const carryBaseConfig = (section: GitSection, baseSec: GitSection | undefined): GitSection => {
    const carried = { ...section };
    delete carried.config;
    if (baseSec?.config !== undefined) carried.config = baseSec.config;
    return carried;
  };
  const captureWithConfig = async (rel: string, section: GitSection): Promise<GitSection> => {
    if (options.disableConfigLane) return carryBaseConfig(section, base[rel]);
    configObserved.add(rel);
    const repoDir = repoDirOf(root, rel);
    const diskCtx = await repoCtxFromDisk(repoDir).catch(() => undefined);
    if (!diskCtx || diskCtx.kind !== "dir" || section.refScope !== "all") {
      logOnce(
        configOwnershipSkipLogged,
        rel,
        `git-sync config skipped ${rel}: capture repository is ${diskCtx?.kind ?? "unreadable"}/scoped and does not own the common config`
      );
      const unowned = { ...section };
      delete unowned.config;
      return unowned;
    }
    let receiver: Awaited<ReturnType<typeof configReceiver>>;
    try {
      receiver = await configReceiver(root, diskCtx);
    } catch (error) {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: capture ownership could not be proven (${errMsg(error)})`);
      return carryBaseConfig(section, undefined);
    }
    if (!receiver.owned) {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: capture common config is outside workspace ownership`);
      return carryBaseConfig(section, undefined);
    }

    let localCfg: LocalCfgRead;
    try {
      localCfg = await readConfigForPush(rel, diskCtx);
    } catch (error) {
      localCfg = {
        status: "failed",
        fault: { disposition: "transient", reason: "read-error", error },
      };
    }
    if (localCfg.status === "over-bounds") {
      const item = {
        relPath: rel,
        reason: `git config over wire bounds — capture config suppressed; carrying base config (${localCfg.reason})`,
      };
      deferred.push(item);
      configLaneItems.add(item);
      return carryBaseConfig(section, base[rel]);
    }
    if (localCfg.status === "failed") {
      const item = {
        relPath: rel,
        reason: `git config ${localCfg.fault.disposition === "permanent" ? "disabled" : "deferred"} during capture (${localCfg.fault.reason}) — carrying base config`,
      };
      deferred.push(item);
      configLaneItems.add(item);
      if (localCfg.fault.disposition === "transient") configLaneDefers.add(item);
      return carryBaseConfig(section, base[rel]);
    }
    const embedded = { ...section, config: localCfg.config };
    authoredCfgHashByRepo[rel] = gitConfigHash(embedded.config);
    return embedded;
  };
  /** Per-repo failure → defer. Forced (422) repos take the M5 non-looping DROP instead:
   *  their base section references exactly the blobs the server lost, so carrying it
   *  would 422 forever — drop from THIS commit; the daemon re-captures when possible. */
  const deferOne = (rel: string, reason: string) => {
    if (force.has(rel)) {
      deferred.push({ relPath: rel, reason: `${reason} — section dropped from this commit (its blobs are missing server-side)` });
      return;
    }
    const b = base[rel];
    if (b) out[rel] = b; // defer-with-base-carry: never regress a synced repo (§6.4)
    deferred.push({ relPath: rel, reason });
  };
  const pendingPointerPreSkips: Array<{ relPath: string; parentRel: string; admissionAlreadyCounted: boolean }> = [];
  const processRepoSlowPath = async (
    rel: string,
    kind: GitRepoKind | undefined,
    baseSec: GitSection | undefined,
    fastLookup?: FingerprintHitProbeResult,
    opts: { admissionAlreadyCounted?: boolean } = {}
  ): Promise<void> => {
    stats.spawnedRepos++;
    const probeBeforeFingerprint = fastLookup?.fingerprint ?? (await gitFingerprint(fingerprintRun, root, rel));
    const recomputeCacheProbe = async (): Promise<DivergenceCacheProbeSnapshot> => {
      const beforeFingerprint = await gitFingerprint(fingerprintRun, root, rel);
      if (await isGitBusy(repoDirOf(root, rel))) {
        const { probe } = await buildPlanProbe(root, rel, beforeFingerprint.diskCtx);
        return { beforeFingerprint, probe, kind };
      }
      const pf = await gitPreflight(repoDirOf(root, rel));
      const { probe } = await buildPlanProbe(root, rel, beforeFingerprint.diskCtx, pf);
      return { beforeFingerprint, probe, kind: pf.kind ?? kind };
    };

    // Quiescence before ANY identity-based decision (mirrors the pull side): a lock
    // makes write-tree fail → raw-index identity fallback, which would spuriously
    // CLEAR a needsResolution suppression (republishing the conflicted state — the
    // exact [v2, M2] hazard) or a removal memory (resurrection), or re-capture a
    // mid-operation repo. Busy → defer with base carry; next cycle re-examines.
    if (await isGitBusy(repoDirOf(root, rel))) {
      const { probe } = await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx);
      await writeDivergenceCacheEntry(
        fingerprintRun,
        root,
        rel,
        cache,
        probe,
        kind,
        probeBeforeFingerprint,
        recomputeCacheProbe,
        () => noteCredentialSkip(rel),
        options.disableConfigLane
      ).catch(() => undefined);
      deferOne(rel, "git busy (lock present)");
      return;
    }

    // Removal memory [v2, B4]: a leftover whose identity still equals the memory is the
    // untouched residue of a remote deletion — NOT re-added. Identity changed → the
    // user worked there → re-adding is intentional; clear the memory and fall through.
    // An UNREADABLE leftover (dangling pointer, transient) keeps its guard and is
    // skipped — clearing on a transient would re-add unchanged git once it heals.
    if (!baseSec && removedMem[rel] !== undefined) {
      const id = await gitIdentity(repoDirOf(root, rel));
      if (!id || gitIdentityKey(id) === removedMem[rel]) return;
      delete removedMem[rel];
    }

    // needsResolution [v2, M2]: carry the checkpointed base until the local identity
    // CHANGES from the recorded conflict-time value (republish must be intentional).
    if (needsRes[rel] !== undefined) {
      const id = await gitIdentity(repoDirOf(root, rel));
      if (gitIdentityKey(id) === needsRes[rel]) {
        if (baseSec) {
          out[rel] = baseSec;
          carried.push(rel);
        }
        return;
      }
      delete needsRes[rel];
    }

    const pf = await gitPreflight(repoDirOf(root, rel));
    if (!pf.ok) {
      const builtProbe = await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx, pf);
      if (builtProbe.diskCtx?.kind === "pointer") fastPathParentRel.set(rel, builtProbe.parentRel);
      const probe = builtProbe.probe;
      await writeDivergenceCacheEntry(
        fingerprintRun,
        root,
        rel,
        cache,
        probe,
        pf.kind ?? kind,
        probeBeforeFingerprint,
        recomputeCacheProbe,
        () => noteCredentialSkip(rel),
        options.disableConfigLane
      ).catch(() => undefined);
      // STRUCTURAL refusal (shallow/bare/alternates/…): the shape can't sync and won't
      // heal by waiting — DROP the section instead of carrying it. Carrying would be
      // permanent poison: identity can't see the structural property, so a base section
      // authored before the shape was detected (e.g. a shallow clone's incomplete
      // bundle, found by live validation) would carry — and fail-close on every
      // receiver — forever. Dropping self-heals: receivers clean their bookkeeping via
      // absence (never touching local .git), and when the user fixes the shape a fresh
      // preflight passes with no base tie to the old bad section.
      if (pf.structural) {
        if (baseSec) removed.push(rel);
        deferred.push({ relPath: rel, reason: `${pf.reason} — section ${baseSec ? "dropped" : "not captured"}` });
        delete needsRes[rel];
        return;
      }
      deferOne(rel, pf.reason ?? "preflight failed");
      return;
    }
    const builtProbe = await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx, pf);
    if (builtProbe.diskCtx?.kind === "pointer") fastPathParentRel.set(rel, builtProbe.parentRel);
    const id = builtProbe.identity;
    const idKey = builtProbe.probe.identityKey;
    const liveKind = pf.kind ?? kind;
    const probe = builtProbe.probe;
    const cacheWrite = await writeDivergenceCacheEntry(
      fingerprintRun,
      root,
      rel,
      cache,
      probe,
      liveKind,
      probeBeforeFingerprint,
      recomputeCacheProbe,
      () => noteCredentialSkip(rel),
      options.disableConfigLane
    ).catch((): DivergenceCacheWriteResult => ({ kind: liveKind }));
    if (!id) {
      // empty repo (no commits yet): nothing to capture; keep any synced base.
      if (baseSec) {
        out[rel] = baseSec;
        carried.push(rel);
      }
      return;
    }

    // §7 capture-side carry-forward — the normative shape×scope matrix [v3; v4]:
    //   dir/all-base      → carry on full-identity match (design-02 semantics)
    //   dir/scoped-base   → ALWAYS capture fresh (a projected compare would hide a
    //                       genuinely new local branch forever)
    //   pointer/scoped    → carry on scoped-identity match
    //   pointer/all-base  → the explicit wider-carry exception: carry when the base's
    //                       SCOPED PROJECTION matches (terminates the convergence loop)
    if (baseSec && !force.has(rel)) {
      if (!isGitRepoKind(liveKind)) {
        deferOne(rel, "preflight did not report a usable git repo kind");
        return;
      }
      const carry = carryMatrixMatches(baseSec, liveKind, idKey);
      if (carry) {
        await carryOwnedWithConfig(rel, baseSec, cacheWrite.localCfg, builtProbe.diskCtx);
        return;
      }
    }
    if (!baseSec) {
      if (!opts.admissionAlreadyCounted) {
        if (admitted >= cap) {
          deferred.push({ relPath: rel, reason: `over the ${cap}-repo cap — new repo not captured this cycle` });
          return;
        }
        admitted++;
      }
    }
    toCapture.push(rel);
  };

  for (const rel of keys) {
    const kind = kindByPath.get(rel);
    const baseSec = base[rel];
    const pend = pending[rel];
    let fastLookup: FingerprintHitProbeResult | undefined;

    const recoveryReason = recoveryBlocked.get(rel);
    if (recoveryReason) {
      if (pend) {
        deferred.push({ relPath: rel, reason: recoveryReason });
        if (!force.has(rel)) {
          out[rel] = pend;
          carried.push(rel);
        }
        continue;
      }
      deferOne(rel, recoveryReason);
      continue;
    }

    // Pending unapplied remote [v5]: carry THE PENDING SECTION (the newest known truth),
    // capture suppressed. 422-while-pending [v6] → M5 drop; the pending entry stays for
    // the next pull to refresh (remote re-establishes it or absence-supersedes clears it).
    if (pend) {
      if (force.has(rel)) {
        deferred.push({ relPath: rel, reason: "pending remote section's blobs are missing server-side — dropped this commit; the next pull refreshes it" });
      } else {
        out[rel] = pend;
        carried.push(rel);
      }
      continue;
    }

    if (!kind) {
      if (!baseSec) continue; // never synced, nothing local → nothing to do
      const dirPresent = await fs
        .lstat(repoDirOf(root, rel))
        .then((s) => s.isDirectory())
        .catch((e) => {
          // Only genuine absence drops the section; a permission/IO fault carries the base
          // (design 108 — a chmod-000 hiccup must not propagate a git-section removal).
          return isPresentButUnreadableError(e) ? undefined : false;
        });
      if (dirPresent === undefined) {
        deferOne(rel, "repo dir unreadable (permission/IO fault) — carrying base");
        continue;
      }
      if (!dirPresent) {
        // §9: repo dir GONE ENTIRELY → the pusher drops the section (receivers drop
        // their base entry but never touch local .git).
        removed.push(rel);
        delete needsRes[rel];
        continue;
      }
      const dotGit = await fs.lstat(path.join(repoDirOf(root, rel), ".git")).catch(() => undefined);
      if (dotGit && rel !== "." && (matcher.prunesForGitDiscovery?.(`${rel}/`) ?? false)) {
        out[rel] = baseSec;
        skipped.push({ relPath: rel, reason: "gitignored by discovery pruning — carrying base" });
        continue;
      }
      deferOne(rel, "no usable .git (deleted or unsupported shape) — carrying base");
      continue;
    }

    // §3.3 fast-path guards:
    // 1 !force.has(rel)
    // 2 no pending, needs-resolution, or removed-memory suppression
    // 3 repo was discovered this run
    // 4 base section exists
    // 5 trusted fingerprint hit with a probe
    // 6 probe is plannable-clean with a valid preflight kind
    // 7 design-43 §7 carry matrix reaches carry
    if (!force.has(rel) && !pend && needsRes[rel] === undefined && removedMem[rel] === undefined && kindByPath.has(rel) && baseSec) {
      fastLookup = await fingerprintHitProbe(fingerprintRun, root, rel, cache, kind, !options.disableConfigLane);
      if (fastLookup.status === "untrusted") {
        stats.fpUntrusted++;
      } else if (fastLookup.status === "hit") {
        const probe = fastLookup.probe;
        const pfKind = probe.preflightKind;
        if (!probe.busy && probe.preflightOk && !probe.preflightStructural && isGitRepoKind(pfKind) && carryMatrixMatches(baseSec, pfKind, probe.identityKey)) {
          // A trusted summary can prove a verbatim carry. If publication is due,
          // fall through: the wire needs the canonical config, not merely its hash.
          if (options.disableConfigLane || (fastLookup.cachedLocalCfg && !shouldPublishGitConfig(baseSec.config, fastLookup.cachedLocalCfg, state.repoRecords?.[rel]?.cfgSynced))) {
            out[rel] = baseSec;
            carried.push(rel);
            if (!options.disableConfigLane) configObserved.add(rel);
            fastPathParentRel.set(rel, probe.parentRel);
            stats.fpHits++;
            continue;
          }
        }
        stats.fpMisses++;
      } else {
        stats.fpMisses++;
      }
    }

    // §3.8 post-gate extension: a baseless in-tree worktree pointer can only be
    // skipped after `sectioned` is known, but a trusted cached parentRel lets us
    // defer that decision without paying the identity/preflight spawn floor.
    if (!force.has(rel) && !pend && needsRes[rel] === undefined && removedMem[rel] === undefined && kind === "pointer" && !baseSec) {
      fastLookup = await fingerprintHitProbe(fingerprintRun, root, rel, cache, kind, !options.disableConfigLane);
      if (fastLookup.status === "untrusted") {
        stats.fpUntrusted++;
      } else if (fastLookup.status === "hit") {
        const probe = fastLookup.probe;
        const pfKind = probe.preflightKind;
        if (!probe.busy && probe.preflightOk && !probe.preflightStructural && isGitRepoKind(pfKind) && probe.parentRel) {
          if (admitted < cap) {
            admitted++;
            pendingPointerPreSkips.push({ relPath: rel, parentRel: probe.parentRel, admissionAlreadyCounted: true });
            continue;
          }
          stats.fpMisses++;
        } else {
          stats.fpMisses++;
        }
      } else {
        stats.fpMisses++;
      }
    }

    await processRepoSlowPath(rel, kind, baseSec, fastLookup);
  }

  // Design 68 §3.3 — base-carry POLICY SKIP for in-tree linked-worktree pointers. A pointer
  // whose owning main clone is (a) an in-tree linked-worktree parent AND (b) itself authored
  // a section THIS cycle skips its own full-store capture: the shared history already rides
  // the main clone's `--single-worktree --all` bundle, so capturing the pointer would upload
  // the same object store again. Skip is BASE-CARRY, never a drop: an existing
  // section is carried forward unchanged (the remote never observes an absence → no removal
  // memory is stamped, sync-git.ts:443/:231 untouched), and a repo with no base is simply
  // never authored. `sectioned` is snapshotted BEFORE mutating toCapture — parents are dir
  // repos, never pointers, so removing a pointer can't change any parent's membership.
  const sectioned = new Set([...Object.keys(out), ...toCapture]);
  const skippedRelPaths = new Set<string>();
  const skipLinkedWorktreePointer = (rel: string, parentRel: string) => {
    skippedRelPaths.add(rel);
    // Ownership is known only now. Undo any provisional slow-carry lane result:
    // linked pointers are non-owned and therefore carry their base verbatim.
    delete authoredCfgHashByRepo[rel];
    for (let i = deferred.length - 1; i >= 0; i--) {
      if (deferred[i]!.relPath === rel && configLaneItems.has(deferred[i]!)) deferred.splice(i, 1);
    }
    const b = base[rel];
    if (b) out[rel] = b; // base-carry: never a remote absence, never a removal memory
    else delete out[rel]; // fresh pointer: never authored
    skipped.push({ relPath: rel, reason: `linked worktree of in-tree repo ${parentRel} — history travels with the main clone` });
  };
  for (const { relPath: rel, parentRel, admissionAlreadyCounted } of pendingPointerPreSkips) {
    if (sectioned.has(parentRel)) {
      skipLinkedWorktreePointer(rel, parentRel);
      stats.pointerPreSkips++;
    } else {
      stats.fpMisses++;
      await processRepoSlowPath(rel, kindByPath.get(rel), base[rel], undefined, { admissionAlreadyCounted });
    }
  }
  for (const rel of [...toCapture, ...carried]) {
    if (force.has(rel)) continue; // 422 recapture must capture, not base-carry via policy skip
    if (kindByPath.get(rel) !== "pointer" || pending[rel] || needsRes[rel] !== undefined) continue;
    let parentRel: string | undefined;
    if (fastPathParentRel.has(rel)) {
      parentRel = fastPathParentRel.get(rel);
      stats.parentRelCached++;
    } else {
      parentRel = await inTreeWorktreeParentRel(root, repoDirOf(root, rel));
    }
    if (!parentRel || !sectioned.has(parentRel)) continue; // out-of-tree/submodule/uncaptured parent → unchanged
    skipLinkedWorktreePointer(rel, parentRel);
  }
  if (skippedRelPaths.size > 0) {
    toCapture = toCapture.filter((rel) => !skippedRelPaths.has(rel));
    carried = carried.filter((rel) => !skippedRelPaths.has(rel));
  }

  // Changed repos: bounded-concurrency capture. Any per-repo failure defers THAT repo
  // (base carry) — the push itself always proceeds (PR #38 churn discipline). Progress
  // is a monotonic completed-count (captures run concurrently, so a settle counter is
  // the only truthful "done") with the just-settled repo's name as the display detail.
  const repoCount = toCapture.length;
  let captureDone = 0;
  let gitBytesDone = 0;
  const repoByteAbs = new Map<string, number>();
  const noteRepoBytes = (rel: string, abs: number) => {
    const prev = repoByteAbs.get(rel) ?? 0;
    if (abs < prev) {
      repoByteAbs.set(rel, abs);
      return;
    }
    gitBytesDone += abs - prev;
    repoByteAbs.set(rel, abs);
    onProgress?.(captureDone, repoCount, "gitcap", rel === "." ? path.basename(root) : path.basename(rel), { bytesDone: gitBytesDone });
  };
  const uploadsDir = path.join(root, ".rbox", "state", "uploads");
  await poolMap(toCapture, GIT_CAPTURE_CONCURRENCY, async (rel) => {
    try {
      const { section: sec, reason } = await capturePlannedGitSection(
        root, rel, cfg, base[rel], api, kek, uploadsDir, force.has(rel), backoff,
        (abs) => noteRepoBytes(rel, abs)
      );
      if (sec) {
        out[rel] = await captureWithConfig(rel, sec);
        captured.push(rel);
      } else {
        deferOne(rel, reason ?? "capture returned nothing (repo vanished mid-capture or failed self-validation)");
      }
    } catch (e) {
      deferOne(rel, e instanceof GitCaptureDeferredError ? errMsg(e) : `capture failed: ${errMsg(e)}`);
    } finally {
      // Root repo (rel ".") shows the workspace folder name rather than a bare ".".
      onProgress?.(
        ++captureDone,
        repoCount,
        "gitcap",
        rel === "." ? path.basename(root) : path.basename(rel),
        gitBytesDone > 0 ? { bytesDone: gitBytesDone } : undefined
      );
    }
  });

  const liveKeys = new Set(keys);
  for (const rel of [...cache.repos.keys()]) {
    if (!liveKeys.has(rel)) {
      cache.repos.delete(rel);
      cache.dirty = true;
    }
  }
  await saveGitDivergenceCache(root, cache).catch(() => {});

  return plan();
}

/** Format the §10 forensic push line:
 *  `git-sync: captured N (a, b) · carried N · skipped N (p: reason) · deferred N (p: reason) · removed N (x)`
 *  Skipped (design 68 §3.3 in-tree worktree pointers) is its own category — distinct from a
 *  failure defer — so the summary reads honestly instead of hiding N× redundant captures. */
export function formatGitPushLine(plan: GitPushPlan): string {
  const names = (xs: string[]) => (xs.length ? ` (${xs.join(", ")})` : "");
  const reasons = (xs: Array<{ relPath: string; reason: string }>) => (xs.length ? ` (${xs.map((d) => `${d.relPath}: ${d.reason}`).join("; ")})` : "");
  return (
    `git-sync: captured ${plan.captured.length}${names(plan.captured)} · carried ${plan.carried.length}` +
    ` · skipped ${plan.skipped.length}${reasons(plan.skipped)}` +
    ` · deferred ${plan.deferred.length}${reasons(plan.deferred)} · removed ${plan.removed.length}${names(plan.removed)}`
  );
}

export function formatGitPlanStats(stats: GitPlanStats): string {
  return `hit${stats.fpHits}m${stats.fpMisses}u${stats.fpUntrusted} pps${stats.pointerPreSkips} sp${stats.spawnedRepos} prc${stats.parentRelCached}`;
}

/** Per-repo base advance (design 43 §7 [v5]): a PENDING repo's committed section is the
 *  remote's own unapplied truth — the saved git BASE must keep the OLD entry (or none)
 *  so the next pull still sees remote != base and retries the apply. Advancing the base
 *  to the pending section would make that pull read "unchanged" and clear pending
 *  without ever applying — silently regressing the other machine's work. */
export function gitBaseAfterCommit(
  committedGit: Record<string, GitSection> | undefined,
  pending: Record<string, GitSection> | undefined,
  baseGit: Record<string, GitSection> | undefined
): Record<string, GitSection> | undefined {
  const stateGit = { ...(committedGit ?? {}) };
  for (const rel of Object.keys(pending ?? {})) {
    const old = baseGit?.[rel];
    if (old) stateGit[rel] = old;
    else delete stateGit[rel];
  }
  return emptyToUndef(stateGit);
}

/** The per-relPath 422 recapture set [v2, M5]: ONLY the repos whose sections reference a
 *  missing (unsatisfied) encSha are force-recaptured — a missing GIT artifact can't be
 *  satisfied by a file re-upload, and the identity-carry would re-reference the absent
 *  bundle (§28). A naive "recapture everything" would drop exactly the repos the
 *  defer machinery is protecting. */
export function gitForceForMissingBlobs(committedGit: Record<string, GitSection> | undefined, missing: Set<string>): Set<string> {
  const gitForce = new Set<string>();
  for (const [rel, sec] of Object.entries(committedGit ?? {})) {
    if (gitSectionBlobRefs(sec).some((ref) => missing.has(ref.encSha))) gitForce.add(rel);
  }
  return gitForce;
}
