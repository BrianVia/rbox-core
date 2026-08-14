import fs from "node:fs/promises";
import path from "node:path";
import { GitCaptureDeferredError, artifactBinding, checkoutJournalPresent, discoverGitRepos, gitPreflight, inTreeWorktreeParentRel, isGitBusy, isPresentButUnreadableError, gitSectionBlobRefs, oracleFromState, readRepoIdentityV1, readStateLineageV1, receiverEquivalentCollisionNames, repoCtxFromDisk, poolMap, stateLineageV1FromRealRoot, type DiscoveredGitRepo, type GitRepoKind, type GitSection, type IgnoreMatcher, type OwnedRefMutationBoundary, type RepoCtx } from "../../engine/index.js";
import { pinDisplaced } from "../../engine/git/keep-pins.js";
import { git } from "../../engine/git/shared.js";
import { PlanArtifactLifecycle } from "./plan-artifacts.js";
import { type GitConfigRunner } from "../../engine/git/config-txn.js";
import { expectedStateNonce, repoRecordsForState, syncStreamId, type GitDeferralReason, type SyncState, type WorkspaceConfig } from "../config.js";
import type { SyncRemote } from "../remote.js";
import type { TransferProgress } from "../transfer-progress.js";
import { GIT_CAPTURE_CONCURRENCY, configCredentialSkipLogged, configOwnershipSkipLogged, pendingCarryLogged, gitRepoCap, repoDirOf, carryMatrixMatches, emptyToUndef, errMsg, gitIncomingKey, observePackedRefsIdentity, packedRefsMtimeRegressed, type ResolutionCaptureTestHooks } from "./shared.js";
import { shouldPublishGitConfig } from "./config-lane.js";
import { gitFingerprint, gitFingerprintRun } from "./fingerprint.js";
import { loadGitDivergenceCache, saveGitDivergenceCache, fingerprintHitProbe, buildPlanProbe, writeDivergenceCacheEntry, isGitRepoKind, type FingerprintHitProbeResult } from "./divergence-cache.js";
import { checkoutJournalBinding, quarantineUnboundFollowJournal, recoverAndLandFollowJournal } from "./follow.js";
import { cachedSupersessionRefusal, gitPendingSupersedeEnabled, journalAllowsPendingSupersession, pendingSupersessionAckConverges, pendingSupersessionPreProbe, provePendingSupersession, recordSupersessionRefusal, supersessionMemoKeys } from "./pending-supersession.js";
import { CONFLICT_REF_PRUNE_LIMIT, pruneConflictRefs } from "./conflict-retention.js";
import { discardedIncomingOids, finalResolutionReport, reportAuthorized, resolutionReportHash, type GitResolutionRider } from "./resolution-intent.js";
import { branchesCheckedOutElsewhereStrict } from "../../engine/git/apply.js";
import { readHead } from "../../engine/git/shared.js";
import { branchBaseOriginMatches } from "./base-composer.js";
import { prepareFollowerBranchProtocol } from "./follower-protocol.js";
import { commitAbsentBranchVerification, planAbsentBranchVerification } from "./branch-transition.js";
import { asyncMemo } from "./async-memo.js";
import { republishPlanInput } from "./republish-requests.js";
import { GitPlanAccumulator } from "./plan-accumulator.js";
import { RepoCaptureAttempt, type RepoAttemptCommand } from "./repo-capture-attempt.js";

function applyRepoAttemptCommands(
  accumulator: GitPlanAccumulator,
  rel: string,
  commands: readonly RepoAttemptCommand[],
): void {
  for (const command of commands) {
    switch (command.kind) {
      case "carry":
        accumulator.carry(rel, command.section);
        break;
      case "defer":
        accumulator.deferRepo(rel, command.reason, command.forced, command.typedReason);
        break;
      case "clear-removal":
        delete accumulator.removedMemory[rel];
        break;
      case "clear-resolution":
        delete accumulator.needsResolution[rel];
        break;
      case "structural-refusal":
        if (command.removed) accumulator.removed.push(rel);
        if (command.repoAbsent) accumulator.repoAbsent[rel] = true;
        accumulator.defer(rel, command.reason);
        delete accumulator.needsResolution[rel];
        break;
      case "config-observed":
        accumulator.configObserved.add(rel);
        break;
      case "config-defer":
        accumulator.deferConfig(rel, command.reason, command.transient);
        break;
      case "config-skip":
        accumulator.logOnce(
          configOwnershipSkipLogged,
          rel,
          `git-sync config skipped ${rel}: ${command.reason}. rbox left shared Git settings alone; Git history can still sync.`,
        );
        break;
      case "config-authored":
        accumulator.authoredCfgHashByRepo[rel] = command.hash;
        break;
    }
  }
}

interface RepoClassificationStage {
  accumulator: GitPlanAccumulator;
  root: string;
  state: SyncState;
  kindByPath: ReadonlyMap<string, GitRepoKind>;
  keys: readonly string[];
  recoveryBlocked: ReadonlyMap<string, string>;
  recoveryAllowsSupersession: ReadonlyMap<string, boolean>;
  matcher: IgnoreMatcher;
  force: ReadonlySet<string>;
  republish: ReadonlySet<string>;
  cache: Awaited<ReturnType<typeof loadGitDivergenceCache>>;
  fingerprintRun: ReturnType<typeof gitFingerprintRun>;
  options: GitPlanOptions;
  preCaptureRepoCtx(rel: string): Promise<RepoCtx | undefined>;
  clearPreCaptureCtx(): void;
}

interface RepoClassificationResult {
  attempts: Map<string, RepoCaptureAttempt>;
  toCapture: string[];
}

async function classifyGitRepositories(stage: RepoClassificationStage): Promise<RepoClassificationResult> {
  const {
    accumulator,
    root,
    state,
    kindByPath,
    keys,
    recoveryBlocked,
    recoveryAllowsSupersession,
    matcher,
    force,
    republish,
    cache,
    fingerprintRun,
    options,
    preCaptureRepoCtx,
  } = stage;
  const {
    base,
    pending,
    needsResolution,
    removedMemory,
    out,
    removed,
    repoAbsent,
    skipped,
    deferred,
    configObserved,
    stableCarryHygiene,
    pendingSupersessionCandidates,
    resolutionCandidates,
    stats,
    timings,
  } = accumulator;
  const startedAt = performance.now();
  const fingerprintAtStart = timings.fingerprintMs;
  for (const rel of keys) accumulator.captureObserved.add(rel);
  stats.repos = keys.length;
  const cap = gitRepoCap();
  let admitted = new Set([...Object.keys(base), ...Object.keys(pending)]).size;
  let toCapture: string[] = [];
  let carried = accumulator.carried;
  const attempts = new Map<string, RepoCaptureAttempt>();
  const mustCapture = (rel: string): boolean => force.has(rel) || republish.has(rel);
  const noteCredentialSkip = (rel: string): void => accumulator.logOnce(
    configCredentialSkipLogged,
    rel,
    `git-sync WARNING ${rel}: skipped credential-bearing remote URL from config capture`,
  );
  const attemptFor = (rel: string, kind: GitRepoKind | undefined): RepoCaptureAttempt => {
    let attempt = attempts.get(rel);
    if (attempt) return attempt;
    attempt = new RepoCaptureAttempt({
      root,
      relPath: rel,
      kind,
      base: base[rel],
      pending: pending[rel],
      removedKey: removedMemory[rel],
      resolutionKey: needsResolution[rel],
      recordExists: repoRecordsForState(state)[rel] !== undefined,
      cfgSynced: state.repoRecords?.[rel]?.cfgSynced,
      forced: force.has(rel),
      mustCapture: mustCapture(rel),
      repoCap: cap,
      disableConfigLane: options.disableConfigLane === true,
      cache,
      fingerprintRun,
      gitConfigRunner: options.gitConfigRunner,
      preCaptureRepoCtx: () => preCaptureRepoCtx(rel),
      onCredentialSkip: () => noteCredentialSkip(rel),
    });
    attempts.set(rel, attempt);
    return attempt;
  };
  const deferOne = (rel: string, reason: string, typedReason?: GitDeferralReason): void =>
    accumulator.deferRepo(rel, reason, force.has(rel), typedReason);
  const processSlow = async (
    rel: string,
    kind: GitRepoKind | undefined,
    fastLookup?: FingerprintHitProbeResult,
    options: { admissionAlreadyCounted?: boolean; forceCapture?: boolean; resolution?: boolean } = {},
  ): Promise<void> => {
    stats.spawnedRepos++;
    const attempt = attemptFor(rel, kind);
    const result = await attempt.classify(fastLookup, { ...options, admissionAvailable: admitted < cap });
    applyRepoAttemptCommands(accumulator, rel, attempt.drainCommands());
    if (result.parentRelKnown) fastPathParentRel.set(rel, result.parentRel);
    if (result.stableCarry) stableCarryHygiene.add(rel);
    if (result.admissionUsed) admitted++;
    if (result.queued) toCapture.push(rel);
  };
  const fastPathParentRel = new Map<string, string | undefined>();
  const pointerPreSkips: Array<{ relPath: string; parentRel: string; admissionAlreadyCounted: boolean }> = [];

  for (const rel of keys) {
    const kind = kindByPath.get(rel);
    const baseSection = base[rel];
    const protectedSection = pending[rel];
    let fastLookup: FingerprintHitProbeResult | undefined;
    const recoveryReason = recoveryBlocked.get(rel);
    if (recoveryReason) {
      if (protectedSection) {
        accumulator.defer(rel, recoveryReason);
        accumulator.carry(rel, protectedSection);
        if (options.resolution?.repo === rel) accumulator.resolutionDisposition = { outcome: "refused", reason: recoveryReason };
      } else {
        deferOne(rel, recoveryReason);
      }
      continue;
    }
    if (protectedSection) {
      const rider = options.resolution?.repo === rel ? options.resolution : undefined;
      if (rider) {
        if (options.degradedMutex) {
          accumulator.carry(rel, protectedSection);
          const reason = "workspace locking is degraded; keep-mine publication requires safe serialization";
          accumulator.defer(rel, reason);
          accumulator.resolutionDisposition = { outcome: "refused", reason };
        } else {
          resolutionCandidates.add(rel);
          await processSlow(rel, kind, undefined, { forceCapture: true, admissionAlreadyCounted: true, resolution: true });
        }
        continue;
      }
      if (recoveryAllowsSupersession.get(rel) === false || !gitPendingSupersedeEnabled()) {
        accumulator.carry(rel, protectedSection);
        continue;
      }
      const probe = await pendingSupersessionPreProbe(root, rel, protectedSection, baseSection, (fingerprint) =>
        cachedSupersessionRefusal(cache, rel, fingerprint, supersessionMemoKeys(protectedSection, baseSection)));
      if (probe.status === "carry") {
        accumulator.carry(rel, protectedSection);
        if (probe.busy || probe.refused) accumulator.defer(rel, probe.reason);
        else accumulator.logOnce(
          pendingCarryLogged,
          rel,
          `git-sync pending carry ${rel}: ${probe.reason}. Your local Git work is safe while rbox retries.`,
        );
        continue;
      }
      pendingSupersessionCandidates.add(rel);
      attemptFor(rel, kind).rememberSupersessionEvidence({
        fingerprint: probe.fastLookup.fingerprint,
        identityKey: probe.fastLookup.probe.identityKey,
        kind: probe.fastLookup.kind,
      });
      await options.afterPendingPreProbe?.(rel);
      await processSlow(rel, kind, probe.fastLookup, { forceCapture: true });
      continue;
    }
    if (!kind) {
      if (!baseSection) continue;
      const dirPresent = await fs.lstat(repoDirOf(root, rel)).then((entry) => entry.isDirectory()).catch((error) =>
        isPresentButUnreadableError(error) ? undefined : false);
      if (dirPresent === undefined) {
        deferOne(rel, "repo dir unreadable (permission/IO fault) — carrying base");
      } else if (!dirPresent) {
        removed.push(rel);
        repoAbsent[rel] = true;
        delete needsResolution[rel];
      } else {
        const dotGit = await fs.lstat(path.join(repoDirOf(root, rel), ".git")).catch(() => undefined);
        if (dotGit && rel !== "." && (matcher.prunesForGitDiscovery?.(`${rel}/`) ?? false)) {
          out[rel] = baseSection;
          skipped.push({ relPath: rel, reason: "gitignored by discovery pruning — carrying base" });
        } else {
          deferOne(rel, "no usable .git (deleted or unsupported shape) — carrying base");
        }
      }
      continue;
    }
    if (!mustCapture(rel) && needsResolution[rel] === undefined && removedMemory[rel] === undefined && baseSection) {
      fastLookup = await accumulator.measure(
        "fingerprintMs",
        () => fingerprintHitProbe(fingerprintRun, root, rel, cache, kind, !options.disableConfigLane),
      );
      if (fastLookup.status === "untrusted") {
        stats.fpUntrusted++;
      } else if (fastLookup.status === "hit") {
        const probe = fastLookup.probe;
        const baseHeadMissing = Object.keys(baseSection.refs).some((ref) =>
          ref.startsWith("refs/heads/") && probe.identityRefs?.[ref] === undefined);
        if (!baseHeadMissing && !probe.busy && probe.preflightOk && !probe.preflightStructural
          && isGitRepoKind(probe.preflightKind) && carryMatrixMatches(baseSection, probe.preflightKind, probe.identityKey)
          && (options.disableConfigLane || (fastLookup.cachedLocalCfg
            && !shouldPublishGitConfig(baseSection.config, fastLookup.cachedLocalCfg, state.repoRecords?.[rel]?.cfgSynced)))) {
          accumulator.carry(rel, baseSection);
          if (!options.disableConfigLane) configObserved.add(rel);
          fastPathParentRel.set(rel, probe.parentRel);
          stats.fpHits++;
          stableCarryHygiene.add(rel);
          continue;
        }
        stats.fpMisses++;
      } else {
        stats.fpMisses++;
      }
    }
    if (!mustCapture(rel) && needsResolution[rel] === undefined && removedMemory[rel] === undefined
      && kind === "pointer" && !baseSection) {
      fastLookup = await accumulator.measure(
        "fingerprintMs",
        () => fingerprintHitProbe(fingerprintRun, root, rel, cache, kind, !options.disableConfigLane),
      );
      if (fastLookup.status === "untrusted") {
        stats.fpUntrusted++;
      } else if (fastLookup.status === "hit") {
        const probe = fastLookup.probe;
        if (!probe.busy && probe.preflightOk && !probe.preflightStructural
          && isGitRepoKind(probe.preflightKind) && probe.parentRel && admitted < cap) {
          admitted++;
          pointerPreSkips.push({ relPath: rel, parentRel: probe.parentRel, admissionAlreadyCounted: true });
          continue;
        }
        stats.fpMisses++;
      } else {
        stats.fpMisses++;
      }
    }
    await processSlow(rel, kind, fastLookup);
  }

  const sectioned = new Set([...Object.keys(out), ...toCapture]);
  const skippedRelPaths = new Set<string>();
  const skipPointer = (rel: string, parentRel: string): void => {
    skippedRelPaths.add(rel);
    accumulator.skipLinkedPointer(rel, parentRel);
  };
  for (const pointer of pointerPreSkips) {
    if (sectioned.has(pointer.parentRel)) {
      skipPointer(pointer.relPath, pointer.parentRel);
      stats.pointerPreSkips++;
    } else {
      stats.fpMisses++;
      await processSlow(pointer.relPath, kindByPath.get(pointer.relPath), undefined, {
        admissionAlreadyCounted: pointer.admissionAlreadyCounted,
      });
    }
  }
  for (const rel of [...toCapture, ...carried]) {
    if (mustCapture(rel) || kindByPath.get(rel) !== "pointer" || pending[rel] || needsResolution[rel] !== undefined) continue;
    let parentRel: string | undefined;
    if (fastPathParentRel.has(rel)) {
      parentRel = fastPathParentRel.get(rel);
      stats.parentRelCached++;
    } else {
      parentRel = await inTreeWorktreeParentRel(root, repoDirOf(root, rel));
    }
    if (parentRel && sectioned.has(parentRel)) skipPointer(rel, parentRel);
  }
  if (skippedRelPaths.size > 0) {
    toCapture = toCapture.filter((rel) => !skippedRelPaths.has(rel));
    carried = carried.filter((rel) => !skippedRelPaths.has(rel));
    accumulator.carried = carried;
  }
  stage.clearPreCaptureCtx();
  await options.beforeCapturePool?.();
  timings.carryMs += performance.now() - startedAt - (timings.fingerprintMs - fingerprintAtStart);
  return { attempts, toCapture };
}
interface RepoCaptureStage {
  accumulator: GitPlanAccumulator;
  root: string;
  cfg: WorkspaceConfig;
  state: SyncState;
  api: SyncRemote;
  kek: Buffer;
  force: ReadonlySet<string>;
  attempts: ReadonlyMap<string, RepoCaptureAttempt>;
  toCapture: readonly string[];
  artifacts: PlanArtifactLifecycle;
  options: GitPlanOptions;
  backoff?: (attempt: number) => Promise<void>;
}

async function captureAndAuthorizeRepositories(stage: RepoCaptureStage): Promise<void> {
  const { accumulator, root, cfg, state, api, kek, force, attempts, toCapture, artifacts, options, backoff } = stage;
  const { base, pending, captured, out, resolutionCandidates, absentBranchProofs, packedRefsIdentity, publisherAckBindings, timings } = accumulator;
  const carried = accumulator.carried;
  const commitCapture = accumulator.capture.bind(accumulator);
  const revertCapture = accumulator.revertCapture.bind(accumulator);
  const glog = accumulator.log.bind(accumulator);
  const captureStartedAt = performance.now();
  accumulator.beginCaptureProgress(toCapture.length);
  const uploadsDir = path.join(root, ".rbox", "state", "uploads");
  const retainDir = await artifacts.startIfNeeded(toCapture.length > 0);
  await poolMap(toCapture, GIT_CAPTURE_CONCURRENCY, async (rel) => {
    options.onCaptureQueued?.(rel);
    try {
      const attempt = attempts.get(rel);
      if (!attempt) throw new Error(`git-sync capture attempt missing for ${rel}`);
      const resolution = resolutionCandidates.has(rel);
      const { section: sec, reason, pendingUploads } = await attempt.capture({
        cfg,
        api,
        kek,
        uploadsDir,
        backoff,
        onBytes: (absoluteBytes) => accumulator.noteRepoBytes(rel, absoluteBytes),
        resolution,
        resolutionHooks: resolution ? options.resolutionCaptureTestHooks : undefined,
        retainDir,
        ownedRefMutationBoundary: options.ownedRefMutationBoundary,
      });
      if (sec) {
        artifacts.retain(rel, pendingUploads ?? []);
        applyRepoAttemptCommands(accumulator, rel, attempt.drainCommands());
        commitCapture(rel, sec);
      } else {
        accumulator.deferRepo(
          rel,
          reason ?? "capture returned nothing (repo vanished mid-capture or failed self-validation)",
          force.has(rel),
        );
      }
    } catch (e) {
      const reason = e instanceof GitCaptureDeferredError ? errMsg(e) : `capture failed: ${errMsg(e)}`;
      accumulator.deferRepo(
        rel,
        reason,
        force.has(rel),
        reason.startsWith("ref-read-unreadable:") ? "ref-read-unreadable" : undefined,
      );
    } finally {
      accumulator.settleCapture(rel);
    }
  });

  // Design 200 W/L/D: observe the packed-refs mtime baseline on captured and
  // carried dir repos regardless of the kill switch. A strict capture may turn
  // a BASE-positive branch into an omission only after the full witness and a
  // prepared verify-only lock.
  const absenceCaptureEnabled = process.env.RBOX_GIT_ABSENCE_CAPTURE !== "0";
  for (const rel of [...new Set([...captured, ...carried])].sort()) {
      const candidate = out[rel];
      if (!candidate) continue;
      const record = repoRecordsForState(state)[rel];
      // A hidden BASE is provenance, never W/L/D refusal authority. A fresh
      // repository at the same path must flow through the normal re-add path.
      if (record?.repoAbsent === true || record?.removedKey !== undefined) continue;
      const baseSection = record?.base ?? base[rel];
      // W/L/D and absence proofs are CAPTURE authority only. A carried pending
      // section legitimately omits held BASE heads (it is protected inbound
      // state, not this cycle's evidence) — carried repos take the packed-refs
      // baseline observation below and nothing else.
      const missing = !captured.includes(rel) ? [] : Object.entries(baseSection?.refs ?? {})
        .filter(([ref]) => ref.startsWith("refs/heads/"))
        .filter(([ref]) => candidate.refs[ref] === undefined);

      if (absenceCaptureEnabled && missing.length > 0) await options.beforeAbsenceWitness?.(rel);
      /** One branch-deletion refusal: name it, drop this cycle's proofs, and fall back
       *  to the protected pending section or the BASE that was carrying before. */
      const refuseBranchDeletion = (reason: string, typed: GitDeferralReason): void => {
        glog(`git-sync deferred ${rel}: finishing branch deletion: ${reason}`);
        delete absentBranchProofs[rel];
        const fallback = pending[rel] ?? baseSection;
        if (fallback) revertCapture(rel, fallback, reason, typed);
      };
      let ctx: RepoCtx | undefined;
      let ctxFailure: unknown;
      try {
        ctx = await repoCtxFromDisk(repoDirOf(root, rel));
      } catch (error) {
        ctxFailure = error;
      }
      if (!ctx) {
        if (absenceCaptureEnabled && missing.length > 0) {
          refuseBranchDeletion(`repository context became unreadable before branch deletion proof: ${errMsg(ctxFailure)}`, "unreadable");
        }
        continue;
      }
      if (ctx.kind !== "dir") continue;

      const packedObservation = await observePackedRefsIdentity(ctx.commonDir);
      const previousPacked = record?.packedRefsIdentity;
      const packedRegressed = packedRefsMtimeRegressed(previousPacked, packedObservation);
      if (packedObservation.status === "absent") {
        packedRefsIdentity[rel] = null;
      } else if (packedObservation.status === "present"
        && !packedRegressed) {
        packedRefsIdentity[rel] = packedObservation.identity;
      }

      if (!absenceCaptureEnabled || missing.length === 0) continue;

      let refusal: string | undefined = packedObservation.status === "unreadable"
        ? `packed-refs baseline could not be read: ${errMsg(packedObservation.error)}`
        : packedRegressed
          ? "packed-refs mtime regressed while a BASE branch was absent"
          : undefined;
      let refusalType: GitDeferralReason | undefined =
        packedObservation.status === "unreadable" ? "unreadable" : undefined;
      const headLog = await fs.readFile(path.join(ctx.commonDir, "logs", "HEAD")).catch(() => undefined);
      if (!headLog || headLog.byteLength === 0) refusal ??= "HEAD reflog is absent or empty";
      const protocol = refusal ? undefined : await prepareFollowerBranchProtocol({
        workspaceRoot: root, relPath: rel, state, ctx, record,
        base: baseSection, incoming: candidate, liveRefs: candidate.refs,
      });
      if (protocol?.status !== "ready") refusal ??= protocol?.reason ?? "BASE artifact/lineage proof unavailable";
      const readyProtocol = protocol?.status === "ready" ? protocol.protocol : undefined;
      const binding = publisherAckBindings[rel];
      if (readyProtocol && (!binding
        || binding.lineageHash !== readyProtocol.lineageHash
        || binding.repositoryIdentityHash !== readyProtocol.repositoryIdentityHash)) {
        refusal ??= "publisher repository binding changed before absence proof";
      }
      let busy = false;
      let preflight: Awaited<ReturnType<typeof gitPreflight>> = { ok: true };
      let owned = new Map<string, string>();
      let head = "";
      if (!refusal) {
        try {
          await options.beforeAbsencePreflight?.(rel);
          const [busyRead, preflightRead, ownedRead, headRead] = await Promise.all([
            isGitBusy(ctx.repoDir),
            gitPreflight(ctx.repoDir),
            branchesCheckedOutElsewhereStrict(ctx),
            readHead(ctx),
          ]);
          if (ownedRead.status === "unreadable") throw ownedRead.cause;
          busy = busyRead;
          preflight = preflightRead;
          owned = ownedRead.owned;
          head = headRead;
        } catch (error) {
          refusal = `branch deletion authorization evidence could not be read: ${errMsg(error)}`;
          refusalType = "unreadable";
        }
      }
      if (busy) refusal ??= "repository operation began before absence proof";
      if (!preflight.ok) refusal ??= preflight.reason;
      const collisions = receiverEquivalentCollisionNames([
        ...Object.keys(baseSection?.refs ?? {}),
        ...Object.keys(candidate.refs),
        ...owned.keys(),
      ]);
      const proofs: Record<string, { priorOid: string }> = {};

      for (const [ref, priorOid] of missing) {
        if (refusal) break;
        const origin = record?.branchBaseOrigins?.[ref];
        const artifacts = readyProtocol!.artifacts[ref];
        const artifactsClear = artifacts === undefined || (artifacts.absence === "absent"
          && artifacts.present === "absent"
          && artifacts.keeps === "clear"
          && artifacts.settledAbsence === "absent");
        const witnessRefusals = [
          ...(candidate.refScope !== "all" ? ["scoped-capture"] : []),
          ...(!branchBaseOriginMatches(origin, priorOid) ? ["origin-mismatch"] : []),
          ...(branchBaseOriginMatches(origin, priorOid) && origin.lineageHash !== readyProtocol!.lineageHash ? ["lineage-changed"] : []),
          ...(!artifactsClear ? ["artifacts-standing"] : []),
          ...(owned.has(ref) ? ["worktree-owned"] : []),
          ...(collisions.has(ref) ? ["name-collision"] : []),
          ...(head === `ref: ${ref}` ? ["head-symref"] : []),
        ];
        if (witnessRefusals.length > 0) {
          refusal = `branch deletion witness refused ${ref} (${witnessRefusals.join("+")})`;
          break;
        }
        try {
          const verification = await planAbsentBranchVerification(ctx.repoDir, ref);
          await commitAbsentBranchVerification(verification);
          proofs[ref] = { priorOid };
        } catch (error) {
          refusal = errMsg(error);
          break;
        }
      }

      if (!refusal && Object.keys(proofs).length === missing.length) {
        absentBranchProofs[rel] = proofs;
        continue;
      }

      const reason = refusal ?? "branch deletion proof unavailable";
      refuseBranchDeletion(reason, refusalType ?? (reason.includes("ref-read-unreadable") ? "ref-read-unreadable" : "deletion-pending"));
  }

  timings.captureMs += performance.now() - captureStartedAt;
}
interface CandidateFinalizeStage {
  accumulator: GitPlanAccumulator;
  root: string;
  state: SyncState;
  artifacts: PlanArtifactLifecycle;
  cache: Awaited<ReturnType<typeof loadGitDivergenceCache>>;
  kek: Buffer;
  options: GitPlanOptions;
  attempts: ReadonlyMap<string, RepoCaptureAttempt>;
}

async function finalizeCandidates(stage: CandidateFinalizeStage): Promise<void> {
  const { accumulator, root, state, artifacts, cache, kek, options, attempts } = stage;
  const { base, pending, captured, deferred, absentBranchProofs, pendingSupersessionCandidates, resolutionCandidates, resolvedPending, publisherAckBindings, supersededPending, supersessionIdentityKeys, timings } = accumulator;
  const revertCapture = accumulator.revertCapture.bind(accumulator);
  const projectionStartedAt = performance.now();
  const finalizedOutgoing = accumulator.finalizeOutgoing();
  for (const [rel, proofs] of Object.entries(absentBranchProofs)) {
    const section = finalizedOutgoing[rel];
    const exact = section !== undefined && Object.entries(proofs).every(([ref, proof]) =>
      section.refTombstones?.[ref]?.some((entry) => entry.oid === proof.priorOid) === true);
    if (exact) continue;
    delete absentBranchProofs[rel];
    const fallback = pending[rel] ?? base[rel];
    if (fallback) revertCapture(
      rel,
      fallback,
      "proof-backed tombstone could not be authored exactly",
      "deletion-pending",
    );
  }
  timings.projectionMs += performance.now() - projectionStartedAt;
  const finalizeStartedAt = performance.now();
  // Design 226 flush point 1. Every revert that can reach a repo in NEITHER candidate
  // set — unreadable, absence-witness, tombstone-exactness — has now run, so these
  // sections are final and their bytes are owed. Bounds retained disk without narrowing
  // the retained SET, which those three reverts would have leaked past.
  const decidedLate = new Set([...pendingSupersessionCandidates, ...resolutionCandidates]);
  await artifacts.flush(captured.filter((rel) => !decidedLate.has(rel)));

  for (const rel of [...resolutionCandidates].sort()) {
    const rider = options.resolution?.repo === rel ? options.resolution : undefined;
    const p = pending[rel];
    const candidate = finalizedOutgoing[rel];
    const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    if (!rider || !p || !candidate || !ctx || !captured.includes(rel)) {
      const reason = deferred.find((item) => item.relPath === rel)?.reason
        ?? "keep-mine capture did not produce a final candidate";
      if (p && candidate !== p) revertCapture(rel, p, reason);
      accumulator.resolutionDisposition = { outcome: "refused", reason };
      continue;
    }
    const report = await finalResolutionReport({ ctx, pending: p, candidate, store: artifacts.store(), kek });
    if (!reportAuthorized(rider.authorizedLanes, report)) {
      const reason = report.lanes.some((lane) => lane.disposition === "indeterminate")
        ? "keep-mine final discard report was indeterminate"
        : "keep-mine final candidate would discard a lane that was not confirmed — review and confirm again";
      revertCapture(rel, p, reason);
      accumulator.resolutionDisposition = { outcome: "refused", reason };
      continue;
    }
    const reachable: string[] = [];
    for (const oid of discardedIncomingOids(report)) {
      if (await git(ctx.repoDir, ["cat-file", "-e", `${oid}^{object}`]).then(() => true, () => false)) reachable.push(oid);
    }
    if (reachable.length > 0) {
      await pinDisplaced(ctx.repoDir, reachable, {
        ref: `keep-mine:${rel}`,
        episode: resolutionReportHash(rider.confirmedReport),
        time: (options.now?.() ?? new Date()).toISOString(),
        class: "human",
      });
    }
    resolvedPending.add(rel);
    accumulator.resolutionDisposition = {
      outcome: "published",
      confirmedReportHash: resolutionReportHash(rider.confirmedReport),
    };
  }
  for (const rel of [...pendingSupersessionCandidates].sort()) {
    const p = pending[rel];
    const candidate = finalizedOutgoing[rel];
    const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    const binding = publisherAckBindings[rel];
    const candidateProduced = captured.includes(rel) && p !== undefined && candidate !== undefined
      && ctx !== undefined && binding !== undefined;
    const proven = candidateProduced
      && await provePendingSupersession({
        ctx, pending: p, candidate, store: artifacts.store(), kek,
        base: base[rel], absentBranchProofs: absentBranchProofs[rel],
      })
      && pendingSupersessionAckConverges({
        previousBase: base[rel],
        previousOrigins: repoRecordsForState(state)[rel]?.branchBaseOrigins,
        candidate,
        binding,
        absentBranchProofs: absentBranchProofs[rel],
      });
    if (proven) {
      supersededPending.add(rel);
      const candidateKey = gitIncomingKey(candidate!);
      supersessionIdentityKeys[rel] = {
        pending: gitIncomingKey(p!),
        candidate: candidateKey,
        // Admission proved order-insensitive deep equality with the exact
        // composer output, so its section identity is necessarily identical.
        composed: candidateKey,
      };
      continue;
    }
    if (!p) continue;
    // Only a candidate that reached the proof is evidence about the repository
    // state; a transport or context fault says nothing and must re-run (#573).
    const evidence = attempts.get(rel)?.supersessionRefusalEvidence();
    if (candidateProduced && evidence) {
      recordSupersessionRefusal(cache, rel, evidence.fingerprint, evidence.identityKey, {
        ...supersessionMemoKeys(p, base[rel]),
        reason: SUPERSESSION_REFUSED_REASON,
      }, evidence.kind);
    }
    revertCapture(rel, p, SUPERSESSION_REFUSED_REASON);
  }

  // Design 226 flush point 2, and the invariant this whole design exists to hold:
  // planGitSections returns only after every fresh artifact referenced by its final
  // captured sections is either already remotely satisfied or successfully flushed.
  // All-or-nothing — a failure here rejects the push rather than publishing a section
  // whose bytes are missing (the repos past commitAbsentBranchVerification/pinDisplaced
  // cannot be reverted, and the set is not statically known at this point).
  await artifacts.flush(captured);
  timings.finalizeMs += performance.now() - finalizeStartedAt;
}
interface PlanCleanupStage {
  accumulator: GitPlanAccumulator;
  root: string;
  cache: Awaited<ReturnType<typeof loadGitDivergenceCache>>;
  fingerprintRun: ReturnType<typeof gitFingerprintRun>;
  kindByPath: ReadonlyMap<string, GitRepoKind>;
  keys: readonly string[];
  options: GitPlanOptions;
}

async function cleanAndRefreshPlan(stage: PlanCleanupStage): Promise<void> {
  const { accumulator, root, cache, fingerprintRun, kindByPath, keys, options } = stage;
  const { captured, stableCarryHygiene, resolutionCandidates, timings } = accumulator;
  const measure = accumulator.measure.bind(accumulator);
  const noteCredentialSkip = (rel: string): void => accumulator.logOnce(
    configCredentialSkipLogged, rel, `git-sync WARNING ${rel}: skipped credential-bearing remote URL from config capture`,
  );
  // Design 174 D: independently bounded scratch-ref hygiene. Only an exact
  // stable carry or a successful final capture qualifies; an unconditional P,
  // needs-resolution, policy, or failure carry never spends this authority.
  let conflictDeleteBudget = CONFLICT_REF_PRUNE_LIMIT;
  const cleanedCommonDirs = new Set<string>();
  const postCleanupCacheRefresh = new Set(captured);
  await measure("hygieneMs", async () => {
    for (const rel of [...new Set([...stableCarryHygiene, ...captured])]
      .filter((candidate) => !resolutionCandidates.has(candidate))
      .sort()) {
      if (conflictDeleteBudget === 0) break;
      const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
      options.onHygieneCtx?.(rel, ctx);
      if (!ctx) continue;
      const commonDir = path.resolve(ctx.commonDir);
      if (cleanedCommonDirs.has(commonDir)) continue;
      cleanedCommonDirs.add(commonDir);
      const result = await pruneConflictRefs(repoDirOf(root, rel), {
        limit: conflictDeleteBudget,
        ctx,
        onBatch: async () => {
          for (const cachedRel of [...cache.repos.keys()]) {
            const cachedCtx = await repoCtxFromDisk(repoDirOf(root, cachedRel)).catch(() => undefined);
            if (cachedCtx && path.resolve(cachedCtx.commonDir) === commonDir) {
              postCleanupCacheRefresh.add(cachedRel);
              cache.repos.delete(cachedRel);
            }
          }
          cache.dirty = true;
          fingerprintRun.commonDirFingerprints.delete(commonDir);
        },
      }).catch(() => undefined);
      conflictDeleteBudget -= result?.deleted ?? 0;
    }
  });

  // Refresh captured entries only after every capture-side cleanup, including
  // conflict-ref pruning above. A per-repo fingerprint run avoids reusing the
  // full-plan common-dir memo that predates capture scratch refs.
  const divergenceCacheStartedAt = performance.now();
  const divergenceCacheFingerprintStartedAt = timings.fingerprintMs;
  const refreshOrder = [...postCleanupCacheRefresh].sort();
  for (const rel of refreshOrder) {
    cache.repos.delete(rel);
    cache.dirty = true;
    try {
      const postCaptureFingerprintRun = gitFingerprintRun("per-decision");
      const beforeFingerprint = await measure(
        "fingerprintMs",
        () => gitFingerprint(postCaptureFingerprintRun, root, rel),
      );
      const pf = await gitPreflight(repoDirOf(root, rel));
      const built = await buildPlanProbe(root, rel, beforeFingerprint.diskCtx, pf);
      await writeDivergenceCacheEntry(
        postCaptureFingerprintRun,
        root,
        rel,
        cache,
        built.probe,
        pf.kind ?? kindByPath.get(rel),
        beforeFingerprint,
        undefined,
        () => noteCredentialSkip(rel),
        options.disableConfigLane,
      );
    } catch {
      // Cache absence is the safe fallback; it is never correctness-bearing.
    }
  }

  const liveKeys = new Set(keys);
  for (const rel of [...cache.repos.keys()]) {
    if (!liveKeys.has(rel)) {
      cache.repos.delete(rel);
      cache.dirty = true;
    }
  }
  await saveGitDivergenceCache(root, cache).catch(() => {});
  timings.divergenceCacheMs += performance.now() - divergenceCacheStartedAt
    - (timings.fingerprintMs - divergenceCacheFingerprintStartedAt);
}
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
  /** Repositories intentionally omitted by the publisher without any branch
   * CAS. Their RepoRecord BASE remains protected but is not wire-projected. */
  repoAbsent?: Record<string, true>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
  /** Config hashes authored by this exact plan. Step 4 deliberately initializes
   * this empty; publication/capture rows add entries in steps 5 and 7. */
  authoredCfgHashByRepo: Record<string, string>;
  /** Plan-time physical/logical binding for accepted publisher ACK authority.
   * Captured before publication so a post-commit path replacement cannot lend
   * the committed section another repository's lineage. */
  publisherAckBindings?: Record<string, {
    lineageHash: string;
    repositoryIdentityHash: string;
    repoKind: "dir" | "pointer";
  }>;
  absentBranchProofs?: Record<string, Record<string, { priorOid: string }>>;
  packedRefsIdentity?: Record<string, { mtimeMs: number } | null>;
  captured: string[];
  carried: string[];
  /** Candidate-bound receipts consumed only by the accepted publisher ACK. */
  supersededPending: string[];
  /** Privacy-safe section identity keys proven by the ACK-composer dry run. */
  supersessionIdentityKeys?: Record<string, { pending: string; candidate: string; composed: string }>;
  /** Synchronous keep-mine candidate whose final directional report was authorized. */
  resolvedPending?: string[];
  /** Explicit disposition for the foreground resolver. Never infer this from changed. */
  resolution?: { outcome: "published" | "refused"; reason?: string; confirmedReportHash?: string };
  /** Repos whose entire P-bound record is immutable before accepted ACK. */
  protectedPending: string[];
  deferred: Array<{ relPath: string; reason: string; typedReason?: GitDeferralReason }>;
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
  totalMs: number;
  setupMs: number;
  discoverMs: number;
  removalPruneMs: number;
  journalPreloopMs: number;
  carryMs: number;
  fingerprintMs: number;
  captureMs: number;
  projectionMs: number;
  finalizeMs: number;
  hygieneMs: number;
  divergenceCacheMs: number;
  otherMs: number;
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
  /** Deterministic design-130 tombstone timestamp seam. */
  now?: () => Date;
  /** Awaited daemon registry observer; errors are observability-only. */
  onGitReposDiscovered?: (repos: readonly DiscoveredGitRepo[]) => Promise<void>;
  /** Daemon-only observation boundary for owned scratch-ref mutations. */
  ownedRefMutationBoundary?: OwnedRefMutationBoundary;
  /** Deterministic test seam for a ref race after B's provisional pre-probe. */
  afterPendingPreProbe?: (relPath: string) => void | Promise<void>;
  /** Deterministic test seam after capture and immediately before Step-D reads. */
  beforeAbsenceWitness?: (relPath: string) => void | Promise<void>;
  /** Tests only: after context/protocol reads, before authorization preflight. */
  beforeAbsencePreflight?: (relPath: string) => void | Promise<void>;
  /** Ephemeral foreground confirmation authority, retained by the push loop. */
  resolution?: GitResolutionRider;
  /** Publication-capture race seam. Tests only; ordinary/preliminary capture never receives it. */
  resolutionCaptureTestHooks?: ResolutionCaptureTestHooks;
  /** Tests only: observes journal-pair entry after the lazy presence gate. */
  onJournalRecovery?: (relPath: string) => void;
  /** Tests only: runs after the journal pre-loop and before stage-2 decisions. */
  afterJournalPreloop?: () => void | Promise<void>;
  /** Tests only: runs after read-only decisions and memo invalidation, before capture. */
  beforeCapturePool?: () => void | Promise<void>;
  /** Tests only: observes the repos admitted to the serialized capture work. */
  onCaptureQueued?: (relPath: string) => void;
  /** Tests only: observes the fresh repository context used by hygiene. */
  onHygieneCtx?: (relPath: string, ctx: RepoCtx | undefined) => void;
}

const SUPERSESSION_REFUSED_REASON = "final candidate did not supersede pending section — carrying pending verbatim";

/**
 * Push-side git orchestration (design 43 §6): discover every repo in the tree, then per
 * repo either CARRY (protected pending, needs-resolution checkpoint, or unchanged identity
 * per the §7 shape×scope matrix), CAPTURE (including a provisionally superseding P
 * candidate, bounded pool), DEFER with base carry (any
 * per-repo failure — never abort the push), or REMOVE (repo dir gone entirely, §9).
 * `force` is the per-relPath 422 recapture set [v2, M5]: forced repos skip the carry
 * fast-path; a forced non-P repo that cannot recapture is DROPPED from this commit (the
 * non-looping failure path [v3]) rather than re-referencing blobs the server lost.
 * The #526 republish set also skips the carry fast-path and captures with no basis, but
 * never inherits that drop: its base is still valid server-side, so a failed chain
 * restart defers with base carry and stays pending for the next push.
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
   *  `detail` is the repo just captured. Display-only. Design 226: `bytesDone` follows
   *  the WIRE, so it arrives in bursts at the two flush points rather than during
   *  capture — the completed count is what keeps the long silent phase alive. */
  onProgress?: TransferProgress,
  backoff?: (attempt: number) => Promise<void>,
  options: GitPlanOptions = {}
): Promise<GitPushPlan> {
  const artifacts = new PlanArtifactLifecycle(
    root,
    () => api.blobStore(),
    options.onGitLog ?? ((line: string) => console.error(line)),
  );
  try {
    return await planGitSectionsWithRetention(artifacts, root, cfg, state, api, force, matcher, onProgress, backoff, options);
  } finally {
    await artifacts.dispose();
  }
}

async function planGitSectionsWithRetention(
  artifacts: PlanArtifactLifecycle,
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  api: SyncRemote,
  force: ReadonlySet<string>,
  matcher: IgnoreMatcher,
  onProgress?: TransferProgress,
  backoff?: (attempt: number) => Promise<void>,
  options: GitPlanOptions = {}
): Promise<GitPushPlan> {
  const planStartedAt = performance.now();
  const accumulator = new GitPlanAccumulator(root, state, options, onProgress);
  // #526: pending operator chain restarts. Read once at entry alongside the 422
  // force set. A republished repo must skip every carry fast-path and capture with
  // no basis, but — unlike a 422 force, whose BASE references blobs the server has
  // LOST — its base is still valid server-side, so a failed republish capture takes
  // the ordinary defer-with-base-carry path and stays pending.
  const { repos: republish, warning: republishWarning } = await republishPlanInput(root, syncStreamId(cfg));
  if (republishWarning) options.onGitLog?.(republishWarning);
  if (republish.size > 0) options.onGitLog?.(`git-sync republish pending ${[...republish].sort().join(", ")}`);
  // Design 204 §5.1: one policy read at entry. The legacy arm retains the
  // pre-204 probe order and does not consume the scoped memo.
  const gitPlanLazy = process.env.RBOX_GIT_PLAN_LAZY !== "0";
  const measure = accumulator.measure.bind(accumulator);
  const preCaptureCtx = new Map<string, ReturnType<typeof asyncMemo<RepoCtx | undefined>>>();
  const preCaptureRepoCtx = (rel: string): Promise<RepoCtx | undefined> => {
    if (!gitPlanLazy) return repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    let get = preCaptureCtx.get(rel);
    if (!get) {
      get = asyncMemo(() => repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined));
      preCaptureCtx.set(rel, get);
    }
    return get();
  };
  const {
    base,
    repoAbsent,
    removedMemory: removedMem,
    needsResolution: needsRes,
    pending,
    publisherAckBindings,
    timings,
  } = accumulator;
  const cache = await loadGitDivergenceCache(root);
  const fingerprintRun = gitFingerprintRun("per-decision");
  const glog = accumulator.log.bind(accumulator);
  timings.setupMs = performance.now() - planStartedAt;
  // Design 108 §3.2/§3.1: genesis files-first defer — attach nothing this commit. On a
  // genuine genesis (parentSequence 0, fresh state) base/pending/needsRes/removed are
  // empty, so plan() yields gitRepos=undefined, changed=false, sidecars absent — git is
  // re-derived as owed by the next ordinary push. A cheap discovery (NO capture) decides
  // whether commit 2 is warranted: with ≥1 repo, flag `filesFirstDeferred` so the driver
  // attaches; with zero repos there is nothing owed and commit 1 is terminal (no wasted
  // second push, no "history attached" lie).
  if (options.filesFirstDefer && cfg.syncGit) {
    const discovered = await measure(
      "discoverMs",
      () => discoverGitRepos(root, matcher),
    );
    try { await options.onGitReposDiscovered?.(discovered); } catch { /* daemon observer never changes planning */ }
    const plan = accumulator.plan();
    if (discovered.length > 0) plan.filesFirstDeferred = true;
    return plan;
  }
  if (!cfg.syncGit) {
    const carryStartedAt = performance.now();
    // Opt-out: out stays empty → any base entries read as removal (the opt-out
    // propagates), and the local-only bookkeeping is abandoned with it — a surviving
    // pending entry would otherwise re-trigger the per-repo base restore every push
    // (changed forever → echo-commit loop).
    for (const k of new Set([...Object.keys(state.repoRecords ?? {}), ...Object.keys(base), ...Object.keys(pending)])) {
      accumulator.captureObserved.add(k);
      accumulator.configObserved.add(k);
      repoAbsent[k] = true;
    }
    for (const k of Object.keys(pending)) delete pending[k];
    for (const k of Object.keys(needsRes)) delete needsRes[k];
    for (const k of Object.keys(removedMem)) delete removedMem[k];
    timings.carryMs += performance.now() - carryStartedAt;
    return accumulator.plan();
  }
  if (!cfg.kek) throw new Error("git-sync requires an encryption key (E2EE)"); // §28: artifacts are encrypted
  const kek = cfg.kek;

  const discovered = await measure(
    "discoverMs",
    () => discoverGitRepos(root, matcher),
  );
  try { await options.onGitReposDiscovered?.(discovered); } catch { /* daemon observer never changes planning */ }
  const kindByPath = new Map(discovered.map((d) => [d.relPath, d.kind]));

  // §9: removal memories are pruned ONLY when the local `.git` genuinely disappears —
  // never on mere discovery absence (an ignored-but-present leftover is undiscoverable
  // yet must keep its resurrection guard for when it is unignored).
  await measure("removalPruneMs", async () => {
    for (const rel of Object.keys(removedMem)) {
      if (kindByPath.has(rel)) continue;
      const dotGit = await fs.lstat(path.join(repoDirOf(root, rel), ".git")).catch(() => undefined);
      if (!dotGit) delete removedMem[rel];
    }
  });

  const keys = [...new Set([...kindByPath.keys(), ...Object.keys(base), ...Object.keys(pending)])].sort();
  const recoveryBlocked = new Map<string, string>();
  const recoveryAllowsSupersession = new Map<string, boolean>();
  const workspaceRootReal = asyncMemo(() => fs.realpath(root));
  await measure("journalPreloopMs", async () => {
    if (gitPlanLazy) {
      await poolMap(keys, GIT_CAPTURE_CONCURRENCY, async (rel) => {
        await preCaptureRepoCtx(rel);
      });
    }
    for (const rel of keys) {
      const ctx = await preCaptureRepoCtx(rel);
      if (options.resolution?.repo === rel && pending[rel]) {
        const journalPresent = await checkoutJournalPresent(root, rel);
        if (journalPresent) {
          recoveryAllowsSupersession.set(rel, false);
          recoveryBlocked.set(rel, "checkout journal must be recovered before keep-mine can publish");
          continue;
        }
      }
      if (!ctx) {
        const recovery = await quarantineUnboundFollowJournal(root, rel, state.stream, expectedStateNonce(state));
        recoveryAllowsSupersession.set(rel, journalAllowsPendingSupersession(recovery.status));
        if (recovery.status === "binding-mismatch") glog(`git-sync WARNING ${rel}: journal for an absent/unreadable repository quarantined at ${recovery.quarantinePath}`);
        else if (recovery.status === "defer") recoveryBlocked.set(rel, recovery.reason);
        continue;
      }
      if (/^[0-9a-f]{32}$/.test(state.stateNonce ?? "")) {
        try {
          const identity = await readRepoIdentityV1(rel, ctx.kind, {
            worktreeId: ctx.repoDir,
            gitDirReal: ctx.gitDir,
            commonDirReal: ctx.commonDir,
          });
          const lineage = gitPlanLazy
            ? stateLineageV1FromRealRoot(await workspaceRootReal(), state.stream, state.stateNonce!, identity)
            : await readStateLineageV1(root, state.stream, state.stateNonce!, identity);
          const binding = artifactBinding(lineage);
          publisherAckBindings[rel] = {
            lineageHash: binding.lineageHash,
            repositoryIdentityHash: binding.repositoryIdentityHash,
            repoKind: ctx.kind,
          };
        } catch (error) {
          recoveryBlocked.set(rel, `publisher BASE binding unavailable: ${errMsg(error)}`);
          continue;
        }
      }
      const recover = !gitPlanLazy || await checkoutJournalPresent(root, rel);
      if (!recover) continue;
      options.onJournalRecovery?.(rel);
      const binding = await checkoutJournalBinding(state.stream, expectedStateNonce(state), ctx);
      const landedRecovery = await recoverAndLandFollowJournal(root, rel, binding, state, { land: !options.degradedMutex });
      const recovery = landedRecovery.recovery;
      recoveryAllowsSupersession.set(rel, journalAllowsPendingSupersession(recovery.status));
      if (recovery.status === "keep") {
        if (options.degradedMutex) {
          recoveryBlocked.set(rel, "published checkout journal awaits non-degraded state save");
          continue;
        }
        state = landedRecovery.state;
        accumulator.state = state;
        const record = repoRecordsForState(state)[rel];
        if (record?.base) base[rel] = record.base; else delete base[rel];
        if (record?.pending) pending[rel] = record.pending; else delete pending[rel];
        if (record?.repoAbsent === true) repoAbsent[rel] = true; else delete repoAbsent[rel];
        if (record?.removedKey) removedMem[rel] = record.removedKey; else delete removedMem[rel];
        if (record?.resolutionKey) needsRes[rel] = record.resolutionKey; else delete needsRes[rel];
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
  });
  await options.afterJournalPreloop?.();
  const { attempts, toCapture } = await classifyGitRepositories({
    accumulator,
    root,
    state,
    kindByPath,
    keys,
    recoveryBlocked,
    recoveryAllowsSupersession,
    matcher,
    force,
    republish,
    cache,
    fingerprintRun,
    options,
    preCaptureRepoCtx,
    clearPreCaptureCtx: () => preCaptureCtx.clear(),
  });
  // Changed repos: bounded-concurrency capture. Any per-repo failure defers THAT repo
  // (base carry) — the push itself always proceeds (PR #38 churn discipline). Progress
  // is a monotonic completed-count (captures run concurrently, so a settle counter is
  // the only truthful "done") with the just-settled repo's name as the display detail.
  await captureAndAuthorizeRepositories({
    accumulator, root, cfg, state, api, kek, force, attempts, toCapture, artifacts, options, backoff,
  });
  await finalizeCandidates({ accumulator, root, state, artifacts, cache, kek, options, attempts });

  await cleanAndRefreshPlan({ accumulator, root, cache, fingerprintRun, kindByPath, keys, options });

  return accumulator.plan();
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
  const ms = (value: number) => Math.round(value);
  return (
    `hit${stats.fpHits}m${stats.fpMisses}u${stats.fpUntrusted} pps${stats.pointerPreSkips}` +
    ` sp${stats.spawnedRepos} prc${stats.parentRelCached}` +
    ` ms[t${ms(stats.totalMs)} s${ms(stats.setupMs)} d${ms(stats.discoverMs)}` +
    ` rm${ms(stats.removalPruneMs)} j${ms(stats.journalPreloopMs)} cy${ms(stats.carryMs)}` +
    ` f${ms(stats.fingerprintMs)} cp${ms(stats.captureMs)} pr${ms(stats.projectionMs)}` +
    ` fn${ms(stats.finalizeMs)} h${ms(stats.hygieneMs)} dc${ms(stats.divergenceCacheMs)}` +
    ` o${ms(stats.otherMs)}]`
  );
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
