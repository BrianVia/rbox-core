import {
  canonicalManifestHashStreaming,
  diffManifests,
  PhaseReport,
  scanManifest,
  validateManifest,
  manifestRequiresSchema4,
  type IgnoreMatcher,
  type GitSection,
  type FileEntry,
  type Manifest,
  type CaseFoldCollisionGroup,
} from "../../engine/index.js";
import { applyStateSavePacket, ensureCapableStateLineage, expectedStateNonce, loadState, manifestFromMeta, repoRecordsForState, stateWasStreamMismatch, syncStreamId, validManifestMeta, type GitResolutionPublicationReceipt, type GlobalManifestMeta, type WorkspaceConfig } from "../config.js";
import { mdeWritePolicy } from "../e2ee-remote.js";
import { type CommitOptions, type CommitTimings } from "../remote.js";
import {
  deferManifest,
  encryptAndUpload,
  pruneEncryptAddressCache,
  reportDeferred,
  uploadLaneTimingSummary,
} from "../sync-recovery.js";
import {
  formatGitPlanStats,
  formatGitPushLine,
  gitBaseAfterCommit,
  gitForceForMissingBlobs,
  gitIncomingKey,
  gitReposManifestSchema,
  planGitSections,
} from "../sync-git.js";
import { carryRepoBaseProof, recordOriginLineage, type RepoBaseProof } from "../sync-git/base-composer.js";
import { recordGitCaptureObservation } from "../sync-git/git-capture-observation.js";
import type { GitResolutionRider } from "../sync-git/resolution-intent.js";
import { assertSyncMutex, workspaceSyncMutexDegraded } from "../sync-mutex.js";
import { changedSidecarRepoKeys, inputRecord, observedRepoKeys, orderedDeferralUpdates, saveStateSource, type OrderedGitDeferralUpdates } from "../sync-state.js";
import { beginFirstPublishTiming, finishFirstPublishStats, firstPublishMeasurementLive, firstPublishMeasurementToken, firstPublishTiming, formatFirstPublishStats } from "../upload-lane-timing.js";
import { type SyncDeps, withReportScanStats, withCache, withDircache, refreshWriteContext } from "./deps.js";
import { withPushLaneAccumulator } from "../telemetry/lane-accumulator.js";
import { withPushTailTiming } from "../push-tail-timing.js";
import { savePathWarnings } from "../path-warnings.js";
import { formatCommitTimings, formatScanStats, scanDetailsOf } from "./format.js";
import { apiFor, MAX_ATTEMPTS, MassDeleteGuardError, NO_GIT_FORCE, pushMassDeleteTrips, makeDeferErrnoReporter, defaultBackoff, filesFirstFlagEnabled, matcherForState, plaintextBytesOf, fileCountOf, scanTick } from "./policy.js";
import { finishResolutionReceipt, pull, reconcileResolutionReceipt, scanManifestForPushResult, surfaceResolutionReceiptReconciliation } from "./pull.js";
import { MutationGateClosedError } from "../../engine/mutation-gate.js";
import { projectLocalManifest } from "../local-file-projection.js";

const COMMIT_FILE_ENTRY_KEYS = ["path", "sha256", "size", "mode", "mtimeMs", "type", "symlinkTarget", "encSha", "comp", "payloadSha", "cipherSize"] as const;
const COMMIT_FILE_ENTRY_KEY_SET: ReadonlySet<string> = new Set(COMMIT_FILE_ENTRY_KEYS);
const COMMIT_FILE_IDENTITY_KEYS = COMMIT_FILE_ENTRY_KEYS.filter((key) => key !== "mtimeMs");

function knownCommitFileEntry(entry: FileEntry): boolean {
  return Object.keys(entry).every((key) => COMMIT_FILE_ENTRY_KEY_SET.has(key));
}

/**
 * Stamp the manifest schema and keep advisory mtimes stable at the single
 * commit seam. Reusing the applied base entry makes the field-exact delta
 * encoder see no change while preserving every existing wire field.
 */
export function stampManifestSchemaForCommit(manifest: Manifest, base?: Manifest): Manifest {
  let files = manifest.files;
  if (process.env.RBOX_MTIME_NORMALIZE !== "0" && base && base.files.length > 0) {
    const baseFiles = new Map(base.files.map((entry) => [entry.path, entry]));
    for (let index = 0; index < manifest.files.length; index++) {
      const outgoing = manifest.files[index]!;
      const prior = baseFiles.get(outgoing.path);
      if (
        prior
        && knownCommitFileEntry(prior)
        && knownCommitFileEntry(outgoing)
        && COMMIT_FILE_IDENTITY_KEYS.every((key) => prior[key] === outgoing[key])
        && prior !== outgoing
      ) {
        if (files === manifest.files) files = [...manifest.files];
        files[index] = prior;
      }
    }
  }
  const normalized = files === manifest.files ? manifest : { ...manifest, files };
  const schema = Math.max(gitReposManifestSchema(normalized.gitRepos) ?? 0, manifestRequiresSchema4(normalized) ? 4 : 0);
  if (schema === 0) {
    const { manifestSchema: _manifestSchema, ...withoutSchema } = normalized;
    return withoutSchema;
  }
  return { ...normalized, manifestSchema: schema };
}
/**
 * Scan and push. Convenience wrapper for CLI one-shots — the daemon uses
 * {@link pushManifest} directly with its incrementally-patched in-memory manifest.
 */
export async function push(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps = {},
  purgeIgnored = false
): Promise<{ sequence: number; committed: boolean; gitDeferred?: boolean; caseCollisions: CaseFoldCollisionGroup[] }> {
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const callerObservation = deps.onCaseCollisionObservation;
  deps = {
    ...deps,
    onCaseCollisionObservation: async (observation) => {
      if (deps.syncMutex && observation.authority === "authoritative") {
        await savePathWarnings(root, observation.caseCollisions);
      }
      await callerObservation?.(observation);
    },
  };
  const reconciliation = await reconcileResolutionReceipt(root, cfg, deps);
  surfaceResolutionReceiptReconciliation(reconciliation, deps);
  const report = deps.report ?? PhaseReport.disabled("push");
  deps = withReportScanStats(deps, report);
  const { cache, save } = await withCache(root, deps.cache);
  const { dircache, save: dircacheSave } = await withDircache(root, deps.dircache);
  const state = await report.phase("state-load", () => loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex));
  const matcher = matcherForState(root, cfg, state, { purgeSafety: purgeIgnored });
  const scanStats = report.enabled ? deps.scanStats : undefined;
  const scanDeferred = new Set<string>();
  const scanFault = () => deps.telemetry?.record({ kind: "safety_event", eventType: "scan_fault", count: 1 });
  const deferErrnos = deps.warningSink ? makeDeferErrnoReporter(deps.warningSink, scanFault) : makeDeferErrnoReporter(undefined, scanFault);
  const scanT0 = Date.now();
  let local = await report.phase("scan", () => scanManifest(root, matcher, cache, scanTick(deps), undefined, scanStats, scanDeferred, undefined, dircache, deps.forceFullScan ? "unpruned" : "pruned", deferErrnos.onErrno, deps.warningSink));
  deferErrnos.flush();
  const scanWallMs = Date.now() - scanT0;
  if (scanDeferred.size > 0) local = deferManifest(local, state.lastSyncedManifest, scanDeferred);
  await Promise.all([save(), dircacheSave()]);
  if (report.enabled) {
    report.files = fileCountOf(local);
    report.record("scan", { count: report.files, plaintextBytes: plaintextBytesOf(local) });
    if (scanStats) {
      const details = scanDetailsOf(scanStats, scanWallMs, scanDeferred.size);
      report.recordDetails("scan", { ...details }, formatScanStats(details));
    }
  }
  const { sequence, committed, gitDeferred, caseCollisions } = await pushManifest(root, cfg, local, deps, {
    purgeIgnored,
    // Any unrelated deferral makes this scan non-authoritative, so a discovered
    // collision is still returned/printed but not persisted to the sidecar until
    // the next clean push authors durable truth.
    localFileObservation: localFileObservationForScan(scanDeferred.size === 0),
  });
  return { sequence, committed, caseCollisions, ...(gitDeferred ? { gitDeferred } : {}) };
}

/** What a push commit reports back to callers holding an in-memory manifest.
 *  `committed` is true only when a commit actually advanced the sequence — false on
 *  the no-op and everything-deferred short-circuits, so callers can say "already in
 *  sync" instead of reporting a publish that never happened (design 44: the setup
 *  flow once printed "published → sequence 75" for a push that uploaded nothing). */
export type ResolutionPushResult = { outcome: "published" | "refused" | "aborted-remote-moved" | "ack-uncertain"; reason?: string; sequence?: number };
export type PushResult = { sequence: number; manifest: Manifest; deferred?: string[]; retryLater?: string[]; committed: boolean; repairConflict?: boolean; resolution?: ResolutionPushResult;
  /** Complete, deterministic raw collision groups observed for this candidate.
   * Separate from `deferred`, whose retry contract means source churn. */
  caseCollisions: CaseFoldCollisionGroup[];
  /** Final authority after any 409/epoch rescan in this push run. */
  localFileObservationAuthority: "authoritative" | "preserve";
  /** Design 108 §3.1: set true only on a successful, sequence-advancing files-only
   *  genesis commit (commit 1) with git still owed — signals init to run commit 2. */
  gitDeferred?: boolean };
export interface RepairPushMode { kind: "repair"; parentSequence: number }

export class PushConflictExhaustedError extends Error {
  readonly name = "PushConflictExhaustedError";
}

/**
 * The one typed recovery structure behind pushManifest's bounded retry loop. A failed
 * commit attempt classifies into exactly one of these, and the loop applies it — this
 * unifies what were four ad-hoc retry paths (409-conflict, 422-unsatisfied, per-file
 * churn defer, and blob-sha mismatch) into a single sequencing point:
 *  - `pull-first` — a 409 parent-sequence conflict: PULL (absorb the remote change) then
 *    RE-SCAN (disk moved under us) and retry with a fresh manifest and no git force.
 *  - `epoch-stale` — the account rotated under this push: refresh the write context,
 *    RE-SCAN under the new KEK/cache binding, and retry with no git force.
 *  - `reupload` — a 422 unsatisfied-blobs bounce: retry the SAME manifest (no pull, no
 *    re-scan), forcing a git recapture for exactly the referenced repos (§6 [v2, M5]).
 * (The per-file churn defer + blob-sha-mismatch recovery live one layer down, inside
 *  encryptAndUpload: they resolve WITHIN an attempt by committing the stable subset and
 *  deferring the file that won't settle — never a whole-attempt retry.)
 */
type RecoveryAction =
  | { kind: "pull-first" }
  | { kind: "repair-conflict" }
  | { kind: "epoch-stale" }
  // Design 108 §3.2: nonterminal anti-starvation fallback. A files-first attempt that
  // committed nothing (every changed file deferred) returns this so the loop re-plans
  // with ordinary git-inclusive planning — NO pull, NO epoch refresh, NO reupload, and
  // it does not consume the MAX_ATTEMPTS 409 budget (independent cap of 1).
  | { kind: "files-first-fallback" }
  | { kind: "reupload"; forceGitRecapture: ReadonlySet<string>; localForRetry: Manifest; unsatisfiedTotal?: number; unsatisfiedBlobs: string[]; forceSnapshot?: boolean };

const RECOVER_ACCUM_MAX = 100_000;

/** Design 103 Part B: fold one 422 page into the recovery accumulator. Returns the
 *  new full-audit latch state. Once latched (or newly overflowing RECOVER_ACCUM_MAX)
 *  the set is cleared and stays empty — the chunked full audit needs no recovery set,
 *  and holding 100k+ strings would be dead weight (unit-tested memory bound). */
export function accumulateRecoveryPage(accum: Set<string>, latched: boolean, page: readonly string[]): boolean {
  if (latched) return true;
  for (const sha of page) accum.add(sha);
  if (accum.size > RECOVER_ACCUM_MAX) {
    accum.clear();
    return true;
  }
  return false;
}

/** The result of ONE push attempt: either done (committed / no-op / everything deferred),
 *  or a classified recovery to apply, carrying the error to throw once the shared
 *  MAX_ATTEMPTS budget is exhausted. */
type AttemptOutcome =
  | { done: true; result: PushResult }
  | { done: false; action: RecoveryAction; exhaustedError: string };

function reuploadOutcome(committed: Manifest, blobs: readonly string[], total?: number, attemptedChain: readonly string[] = []): AttemptOutcome {
  const unsatisfiedBlobs = [...blobs];
  // §3.3.5/§3.5.4 (design 84): a bounced manifest-chain link can never be
  // re-uploaded (the client does not retain historical link ciphertext), and a
  // TRUNCATED response under a non-empty attempted chain may be hiding one —
  // either way the retry must be a snapshot.
  const missing = new Set(unsatisfiedBlobs);
  const forceSnapshot = attemptedChain.some((sha) => missing.has(sha)) ||
    (attemptedChain.length > 0 && total !== undefined && total > unsatisfiedBlobs.length);
  return {
    done: false,
    action: {
      kind: "reupload",
      forceGitRecapture: gitForceForMissingBlobs(committed.gitRepos, new Set(unsatisfiedBlobs)),
      localForRetry: committed,
      unsatisfiedTotal: total,
      unsatisfiedBlobs,
      ...(forceSnapshot ? { forceSnapshot: true } : {}),
    },
    exhaustedError: "push: server keeps reporting missing blobs after re-upload",
  };
}

/**
 * Push a pre-computed manifest: upload missing blobs, commit. Short-circuits to a
 * no-op (no upload, no commit) when nothing changed vs the last-synced manifest —
 * this is what keeps continuous bidirectional sync from echo-storming (a pull
 * writes exactly the last-synced bytes, so the next push sees no diff). A 409
 * conflict pulls, RE-SCANS (disk changed), and retries (bounded, backed off); a
 * 422 re-uploads the named blobs and retries. A file that keeps changing under the
 * push (never producing a hash-matching ciphertext) is DEFERRED rather than aborting
 * the whole push: the stable subset commits, and the deferred paths are returned so
 * the daemon can re-queue them once they settle. Returns the sequence now in effect,
 * the manifest that reflects it (so a caller holding an in-memory manifest can keep it
 * fresh even across a conflict re-scan), and the deferred paths (empty when none).
 *
 * The retry itself is a bounded LOOP (not recursion): each iteration runs one attempt
 * and, on a classified failure, applies the {@link RecoveryAction} — sharing the single
 * MAX_ATTEMPTS budget, backing off only before a 409 pull (never a 422 re-upload), and
 * preserving the exact interleaving of the original recursive form.
 */
export interface PushManifestOptions {
  purgeIgnored?: boolean;
  forceGitRecapture?: ReadonlySet<string>;
  /** §3.6.3: publish as the PIN's child, snapshot-only, short-circuits bypassed. */
  repair?: RepairPushMode;
  resolution?: GitResolutionRider;
  /** Whether this caller owns a complete local-file observation. Preserve-mode
   * callers may supply a prior episode which this publication must not clear. */
  localFileObservation?:
    | { authority: "authoritative" }
    | { authority: "preserve"; caseCollisions?: readonly CaseFoldCollisionGroup[] };
}

export function localFileObservationForScan(
  observationComplete: boolean,
  preserved: readonly CaseFoldCollisionGroup[] = [],
): NonNullable<PushManifestOptions["localFileObservation"]> {
  return observationComplete
    ? { authority: "authoritative" }
    : { authority: "preserve", caseCollisions: cloneCollisionGroups(preserved) };
}

export async function pushManifest(
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  deps: SyncDeps = {},
  options: PushManifestOptions = {}
): Promise<PushResult> {
  const report = deps.report ?? PhaseReport.disabled("push");
  return withPushTailTiming(report, () => withPushLaneAccumulator(
      () => pushManifestInner(root, cfg, local, deps, options),
      (samples) => { for (const sample of samples) deps.telemetry?.record(sample); },
    ));
}

async function pushManifestInner(
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  deps: SyncDeps = {},
  options: PushManifestOptions = {}
): Promise<PushResult> {
  const { purgeIgnored = false, repair, resolution } = options;
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const report = deps.report ?? PhaseReport.disabled("push");
  deps = withReportScanStats(deps, report);
  const backoff = deps.backoff ?? defaultBackoff;
  let attempt = 0;
  // Loop-carried attempt state, mutated by the RecoveryAction transitions below.
  const reconciled = await reconcileResolutionReceipt(root, cfg, deps);
  surfaceResolutionReceiptReconciliation(reconciled, deps);
  let initialObservation = options.localFileObservation;
  if (reconciled.status !== "none") {
    const scanned = await scanManifestForPushResult(root, cfg, deps, purgeIgnored);
    local = scanned.manifest;
    initialObservation = localFileObservationForScan(
      scanned.observationComplete,
      initialObservation?.authority === "preserve" ? initialObservation.caseCollisions : [],
    );
  }
  const state: PushAttemptState = {
    local,
    rawScannedFilePaths: filePathsForCache(local),
    candidateProjected: false,
    caseCollisions: initialObservation?.authority === "preserve"
      ? cloneCollisionGroups(initialObservation.caseCollisions ?? [])
      : [],
    observationAuthority: initialObservation?.authority ?? "preserve",
    purgeIgnored,
    forceGitRecapture: options.forceGitRecapture ?? NO_GIT_FORCE,
    recoverAddresses: new Set<string>(),
    forceFullAudit: false,
    forceSnapshot: repair !== undefined,
    filesFirstAborted: false,
    filesFirstFallbackUsed: false,
    ...(repair ? { repair } : {}),
    ...(resolution ? { resolution } : {}),
  };
  let previousUnsatisfiedTotal: number | undefined;
  const baseIntegrityByMeta = new Map<string, boolean>();
  // Shared "discard the attempt, rebuild from disk truth" reset — used by the
  // pull-first/epoch-stale arm AND the files-first fallback arm below.
  const rescanReset = async (): Promise<void> => {
    const scanned = await scanManifestForPushResult(root, cfg, deps, purgeIgnored);
    state.local = scanned.manifest;
    state.rawScannedFilePaths = filePathsForCache(state.local);
    state.candidateProjected = false;
    if (scanned.observationComplete) {
      state.caseCollisions = [];
      state.observationAuthority = "authoritative";
    } else {
      state.observationAuthority = "preserve";
    }
    state.forceGitRecapture = NO_GIT_FORCE;
    // The manifest was rebuilt; recovery pages from the discarded attempt no longer apply.
    state.recoverAddresses.clear();
    state.forceFullAudit = false;
    state.forceSnapshot = repair !== undefined;
  };

  for (;;) {
    const outcome = await runPushAttempt(root, cfg, deps, backoff, state, baseIntegrityByMeta);
    if (outcome.done) {
      const lane = uploadLaneTimingSummary();
      if (lane) (deps.warningSink ?? ((line) => process.stderr.write(`${line}\n`)))(lane);
      return outcome.result;
    }
    if (outcome.action.kind === "repair-conflict") {
      // Repair conflicts deliberately escape this inner budget immediately. The
      // outer repairChain budget owns 409 races; this loop only spends retries on
      // bounded 422 reuploads and epoch refreshes while in repair mode.
      return { sequence: repair!.parentSequence, manifest: state.local, committed: false, repairConflict: true, ...resultCollisionMetadata(state) };
    }
    if (outcome.action.kind === "files-first-fallback") {
      // Design 108 §3.2: a files-first attempt committed nothing (every file deferred).
      // Re-plan with ordinary git-inclusive planning so git is not starved. This is a
      // MODE SWITCH, not a conflict: no pull, no epoch refresh, no reupload, and it does
      // NOT consume the MAX_ATTEMPTS 409 budget (independent cap of 1).
      if (state.filesFirstFallbackUsed) throw new Error(outcome.exhaustedError);
      state.filesFirstFallbackUsed = true;
      state.filesFirstAborted = true; // disables files-first defer on the re-run
      await rescanReset(); // rebuild from disk truth
      continue; // does NOT increment attempt
    }
    const consumesAttempt =
      outcome.action.kind !== "reupload" ||
      outcome.action.unsatisfiedTotal === undefined ||
      previousUnsatisfiedTotal === undefined ||
      outcome.action.unsatisfiedTotal >= previousUnsatisfiedTotal;
    previousUnsatisfiedTotal = outcome.action.kind === "reupload" ? outcome.action.unsatisfiedTotal : undefined;
    // Shared budget: throw once we've exhausted MAX_ATTEMPTS (the just-failed attempt is
    // `attempt`), matching the original recursion's throw-before-retry ordering.
    if (consumesAttempt && attempt >= MAX_ATTEMPTS) {
      if (outcome.action.kind === "pull-first") throw new PushConflictExhaustedError(outcome.exhaustedError);
      throw new Error(outcome.exhaustedError);
    }
    if (outcome.action.kind !== "reupload") {
      // Design 108 §3.2/§3.4: a 409/pull-first or epoch-stale discovery latches
      // files-first OFF for the rest of the run — the refreshed parentSequence will be
      // ≥1 anyway, but the latch makes the "retry-after-409 captures git" guarantee
      // independent of the sequence check.
      state.filesFirstAborted = true;
      if (outcome.action.kind === "pull-first") {
        await backoff(attempt);
        await pull(root, cfg, deps);
      } else {
        await refreshWriteContext(cfg, deps);
      }
      await rescanReset(); // disk changed under us
    } else {
      // 422: same manifest, no backoff, no re-scan — force git recapture of the named repos.
      state.forceFullAudit = accumulateRecoveryPage(state.recoverAddresses, state.forceFullAudit, outcome.action.unsatisfiedBlobs);
      state.local = outcome.action.localForRetry;
      state.forceGitRecapture = outcome.action.forceGitRecapture;
      // Once a missing/truncated chain selects repair, every retry stays a snapshot:
      // a later data-only page must not revive the known-broken historical base.
      state.forceSnapshot ||= outcome.action.forceSnapshot === true;
    }
    if (consumesAttempt) attempt++;
  }
}

/**
 * Run ONE push attempt: forward-only ignore carry, git-section plan, no-op short-circuit,
 * encrypt+upload (with per-file churn defer), and commit — then classify the commit into
 * a done result or a {@link RecoveryAction} for the loop to apply. Attempt-agnostic: the
 * MAX_ATTEMPTS budget and backoff live in {@link pushManifest}'s loop.
 */
/** The loop-carried state of {@link pushManifest}'s bounded retry loop — one
 *  object instead of seven positionals, mutated by the RecoveryAction arms. */
interface PushAttemptState {
  local: Manifest;
  rawScannedFilePaths: Set<string>;
  candidateProjected: boolean;
  caseCollisions: CaseFoldCollisionGroup[];
  observationAuthority: "authoritative" | "preserve";
  purgeIgnored: boolean;
  forceGitRecapture: ReadonlySet<string>;
  recoverAddresses: Set<string>;
  forceFullAudit: boolean;
  forceSnapshot: boolean;
  /** Design 108 §3.2: loop-carried latch. Set on any 409/pull-first or epoch-stale
   *  branch, and on the no-advance files-first fallback. Once set, files-first defer is
   *  OFF for the rest of the run (git captured on retry). */
  filesFirstAborted: boolean;
  /** Design 108 §3.2: independent cap (=1) for the files-first-fallback RecoveryAction. */
  filesFirstFallbackUsed: boolean;
  repair?: RepairPushMode;
  resolution?: GitResolutionRider;
}

function filePathsForCache(manifest: Manifest): Set<string> {
  return new Set(manifest.files.filter((entry) => entry.type === "file").map((entry) => entry.path));
}

function cloneCollisionGroups(groups: readonly CaseFoldCollisionGroup[]): CaseFoldCollisionGroup[] {
  return groups.map((group) => ({ paths: [...group.paths] }));
}

function mergeCollisionGroups(
  previous: readonly CaseFoldCollisionGroup[],
  discovered: readonly CaseFoldCollisionGroup[],
): CaseFoldCollisionGroup[] {
  const groups = new Map<string, CaseFoldCollisionGroup>();
  for (const group of [...previous, ...discovered]) {
    const paths = [...new Set(group.paths)].sort();
    groups.set(paths.join("\0"), { paths });
  }
  return [...groups.values()].sort((a, b) => {
    const ak = a.paths.join("\0");
    const bk = b.paths.join("\0");
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
}

function resultCollisionMetadata(state: PushAttemptState): Pick<PushResult, "caseCollisions" | "localFileObservationAuthority"> {
  return {
    caseCollisions: cloneCollisionGroups(state.caseCollisions),
    localFileObservationAuthority: state.observationAuthority,
  };
}

async function runPushAttempt(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps,
  backoff: (attempt: number) => Promise<void>,
  attemptState: PushAttemptState,
  baseIntegrityByMeta: Map<string, boolean>,
): Promise<AttemptOutcome> {
  const { purgeIgnored, forceGitRecapture, recoverAddresses, forceFullAudit, forceSnapshot, filesFirstAborted, repair, resolution } = attemptState;
  let local = attemptState.local;
  // Created PER attempt (not once in the loop): when no remote is injected, a stateful
  // RboxApi must start each attempt with a clean upload-receipt slate — exactly as the
  // prior recursive form did (each recursive call re-ran `deps.remote ?? apiFor(cfg)`).
  const api = deps.remote ?? apiFor(cfg);
  // Needed before the no-op short-circuit (state-load/git-plan are phased, design 82
  // §4); §35's "a no-op tick allocates nothing" still holds — disabled() is a shared
  // free singleton, not a per-attempt allocation.
  const report = deps.report ?? PhaseReport.disabled("push");
  let state = await report.phase("state-load", () => loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex));
  state = await ensureCapableStateLineage(root, state);
  // One authority for every push decision: the persisted base records the last
  // pull that applied completely. A newer remote manifest may have been verified
  // (and its anti-rollback head pinned) before apply failed, but it is not a base.
  const appliedSequence = state.lastSyncedSequence;
  const appliedBase = state.lastSyncedManifest;
  const matcher = matcherForState(root, cfg, state, { purgeSafety: purgeIgnored }); // shared: forward-only ignore carry + git discovery
  const scannedFilePaths = attemptState.rawScannedFilePaths;

  // A 422 retries the already-projected candidate verbatim. A fresh input or a
  // 409/epoch rescan is projected exactly once against the newly loaded applied
  // base, after forward-ignore carry and before every publication decision.
  if (!attemptState.candidateProjected) {
    const projected = projectLocalManifest(local, appliedBase, matcher, purgeIgnored);
    attemptState.caseCollisions = attemptState.observationAuthority === "authoritative"
      ? cloneCollisionGroups(projected.caseCollisions)
      : mergeCollisionGroups(attemptState.caseCollisions, projected.caseCollisions);
    attemptState.local = projected.manifest;
    attemptState.candidateProjected = true;
    local = projected.manifest;
    try {
      await deps.onCaseCollisionObservation?.({
        authority: attemptState.observationAuthority,
        caseCollisions: cloneCollisionGroups(attemptState.caseCollisions),
      });
    } catch (error) {
      try {
        deps.warningSink?.(`rbox: could not record path-collision warning: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // The warning observer and its diagnostic are advisory by contract.
      }
    }
  }

  if (purgeIgnored) {
    const deleted = diffManifests(appliedBase, local).deleted;
    assertNoUnevaluatedPurgeDeletes(matcher, deleted);
  }

  // Design 108 §3.2: the file-plane diff drives BOTH the files-must-diff guard and (later)
  // the no-op / mass-delete checks. Computed once here — planGitSections does not touch the
  // file plane — so the files-first decision precedes git capture.
  const filesDiff = diffManifests(appliedBase, local);
  const fileDiffNonEmpty = filesDiff.added.length > 0 || filesDiff.changed.length > 0 || filesDiff.deleted.length > 0;
  // Files-first defers git capture ONLY on a genuine genesis first-init with a real file
  // diff (§3.1/§3.4): flag on, no 409/epoch/starvation latch yet, parentSequence 0, NOT a
  // rebind/stream-mismatch, and files actually differ. Any false leg ⇒ ordinary git-inclusive
  // planning (byte-identical to today when the flag is off).
  const filesFirstDefer =
    filesFirstFlagEnabled() &&
    repair === undefined &&                // NEVER defer under chain-repair: a repair supersede
                                           // posts repair.parentSequence (≠ appliedSequence) and
                                           // must republish git verbatim, never drop it (BLOCKER).
    cfg.syncGit === true &&                // no git to attach ⇒ nothing to defer (no wasted commit 2)
    !filesFirstAborted &&
    appliedSequence === 0 &&
    !stateWasStreamMismatch(state) &&
    fileDiffNonEmpty;

  // Attach the git sections (design 43 §6): per-repo carry/capture/defer/remove map
  // orchestration. `forceGitRecapture` is the per-relPath 422 recapture set [v2, M5]:
  // a git artifact missing server-side can't be satisfied by a file re-upload — ONLY
  // the repos whose sections reference the missing encShas recapture; the force lives
  // at this single site (each retry recomputes the map) or the recovery is dead.
  const gitPlan = await report.phase("git-plan", async () => {
    // Capture owns scratch/conflict-ref mutations. Register the whole planner
    // conservatively so a stop drains any read phase that can later reach one.
    const lease = deps.mutationBoundary?.enter({ phase: "git-commit" });
    try {
      if (lease && !lease.beginCommit()) throw new MutationGateClosedError();
      return await planGitSections(root, cfg, state, api, forceGitRecapture, matcher, deps.onProgress, backoff, {
        onGitLog: deps.onGitLog,
        disableConfigLane: workspaceSyncMutexDegraded(deps.syncMutex),
        degradedMutex: workspaceSyncMutexDegraded(deps.syncMutex),
        filesFirstDefer,
        onGitReposDiscovered: deps.onGitReposDiscovered,
        resolution,
        resolutionCaptureTestHooks: deps.resolutionCaptureTestHooks,
        beforeAbsenceWitness: deps.beforeAbsenceWitness,
      });
    } finally {
      lease?.finish();
    }
  });
  const busyRepos = Object.entries(gitPlan.captureDeferrals)
    .filter(([, reason]) => reason === "git-busy")
    .map(([relPath]) => relPath)
    .sort();
  try { deps.onGitBusyDeferred?.(busyRepos); } catch { /* daemon observer is non-throwing */ }
  const carryProofsFor = (snapshot: typeof state, relPaths: readonly string[]): Record<string, RepoBaseProof> => {
    const records = repoRecordsForState(snapshot);
    return Object.fromEntries(relPaths.map((relPath) => {
      const lineageHash = recordOriginLineage(records[relPath]?.branchBaseOrigins)
        ?? gitPlan.publisherAckBindings?.[relPath]?.lineageHash
        ?? "legacy-untrusted";
      return [relPath, carryRepoBaseProof(lineageHash)];
    }));
  };
  const observationRecords = repoRecordsForState(state);
  await recordGitCaptureObservation(
    {
      records: observationRecords,
      carried: {
        bases: state.lastSyncedManifest.gitRepos,
        pending: state.gitPendingRemote,
        removed: state.gitReposRemoved,
        resolutions: state.gitNeedsResolution,
      },
      changedRepos: (values) => changedSidecarRepoKeys(state, values),
      save: async (write) => {
        state = await report.phase("state-save", () => saveStateSource(root, state, {
          expectedStream: syncStreamId(cfg),
          sourceGlobalSeq: write.acceptedSequence,
          observedRepos: write.observedRepos,
          values: write.values,
          repoProofs: write.repoProofs,
        }, {
          allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
          forceLegacy: workspaceSyncMutexDegraded(deps.syncMutex),
        }));
        try {
          deps.onGitDeferralsSaved?.(state);
        } catch {
          // A local visibility hook cannot fail a save that is already durable.
        }
      },
    },
    {
      acceptedSequence: state.lastSyncedSequence,
      originLineageOf: (relPath) => recordOriginLineage(observationRecords[relPath]?.branchBaseOrigins),
    },
    {
      observedAt: new Date().toISOString(),
      captureObserved: gitPlan.captureObserved,
      captureDeferrals: gitPlan.captureDeferrals,
      configObserved: gitPlan.configObserved,
      configDeferrals: gitPlan.configDeferrals,
      protectedPending: gitPlan.protectedPending,
      packedRefsIdentity: gitPlan.packedRefsIdentity,
      ackLineageOf: (relPath) => gitPlan.publisherAckBindings?.[relPath]?.lineageHash,
      changedFilePaths: () => [
        ...filesDiff.added.map((entry) => entry.path),
        ...filesDiff.changed.map((entry) => entry.path),
        ...filesDiff.deleted,
      ],
    },
  );
  if (report.enabled) {
    report.record("git-plan", { count: Object.keys(gitPlan.gitRepos ?? {}).length }); // guarded: skip the key-array materialization on no-op ticks
    if (gitPlan.gitPlanStats) report.recordDetails("git-plan", { gitPlan: gitPlan.gitPlanStats }, formatGitPlanStats(gitPlan.gitPlanStats));
  }
  // Schema is stamped once, at commit (stampManifestSchemaForCommit) — deriving it
  // here too would be a second copy of the rule.
  local = { ...local, gitRepos: gitPlan.gitRepos };

  // The file plane is unchanged by git-plan, so the hoisted filesDiff above is
  // authoritative — filesUnchanged is exactly its negation (single source, can't drift).
  const filesUnchanged = !fileDiffNonEmpty;
  const gitUnchanged = !gitPlan.changed;
  if (!repair && filesUnchanged && gitUnchanged) {
    // No-op (files AND git identity match base). Safe even under a forced git RE-CAPTURE
    // (the 422 recovery): reaching here needs local == base, but to have hit the 422 at all
    // attempt-0 must have passed its own no-op — i.e. a real file or git-identity change. The
    // base sequence is unadvanced across a 422, so that change still shows here (filesUnchanged
    // or gitUnchanged is false) → this no-op is unreachable whenever there is anything to
    // commit; when it IS reachable, local == base and committing would just echo. So the git
    // recapture's re-uploaded artifacts are never silently dropped by this branch.
    //
    // LOCAL-ONLY git bookkeeping may still have moved even though nothing needs
    // committing — deleting a leftover .git is usually EXACTLY a no-op push (a .git
    // removal changes no synced files), yet §9 requires its removal memory to be
    // pruned then, or the stale memory suppresses a later legitimate re-add at that
    // path. Persist the bookkeeping commit-free.
    if (cfg.syncGit) {
      const values = {
        bases: appliedBase.gitRepos,
        packedRefsIdentity: gitPlan.packedRefsIdentity,
        repoAbsent: gitPlan.repoAbsent ?? {},
        pending: gitPlan.gitPendingRemote,
        removed: gitPlan.gitReposRemoved,
        resolutions: gitPlan.gitNeedsResolution,
      };
      const changedRepos = changedSidecarRepoKeys(state, values);
      if (changedRepos.length > 0) {
        await report.phase("state-save", () => saveStateSource(root, state, {
          expectedStream: syncStreamId(cfg),
          sourceGlobalSeq: appliedSequence,
          observedRepos: changedRepos,
          values,
          repoProofs: carryProofsFor(state, changedRepos),
        }, {
          allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
          forceLegacy: workspaceSyncMutexDegraded(deps.syncMutex),
        }));
      }
    }
    if (cfg.encrypted) await pruneEncryptAddressCache(root, cfg, scannedFilePaths);
    return { done: true, result: { sequence: appliedSequence, manifest: local, committed: false, ...resultCollisionMetadata(attemptState), ...(gitPlan.resolution ? { resolution: gitPlan.resolution } : {}) } };
  }
  // §10 forensic line — only when git-sync did something beyond a steady carry.
  if (cfg.syncGit && (gitPlan.captured.length || gitPlan.deferred.length || gitPlan.removed.length)) {
    (deps.onGitLog ?? ((l: string) => console.error(l)))(formatGitPushLine(gitPlan), gitPlan);
  }

  // Push-side mass-delete breaker (design 108): compute the intended deletions on the
  // PRE-UPLOAD manifest and refuse before any encrypt/upload/commit work. Deferral only
  // carries base entries forward, so pre-upload `local` and post-defer `committed` have an
  // identical DELETE count (a churning file is a change, not a delete). Op-scoped consent
  // only (allowMassDeletePush / RBOX_ALLOW_MASS_DELETE handled at the CLI boundary) — the
  // daemon never consents, so a runaway wipe halts background push instead of publishing.
  const pushDeletes = filesDiff.deleted.length;
  if (!deps.allowMassDeletePush && pushMassDeleteTrips(pushDeletes, appliedBase.files.length)) {
    deps.telemetry?.record({ kind: "safety_event", eventType: "mass_delete_breaker", count: 1 });
    throw new MassDeleteGuardError("push",
      `push would delete ${pushDeletes} of ${appliedBase.files.length} tracked files — refusing (mass-delete guard). ` +
        `If this deletion is intentional, run \`${deps.massDeleteHint ?? "rbox push --allow-mass-delete"}\` ` +
        `(or set RBOX_ALLOW_MASS_DELETE=1) to publish it once.`
    );
  }

  // Upload missing blobs — ALWAYS convergently encrypted (by encSha, ciphertext).
  // E2EE is the only mode (design 12 D6): a non-encrypted config reaching the sync
  // core is a fail-closed error, BEFORE any byte is uploaded — never plaintext.
  if (!cfg.encrypted || !cfg.kek) throw new Error("E2EE required: refusing to sync without an encryption key (run `rbox init`/`rbox pair`/`rbox key recover`)");

  // (design 108): everything from encryptAndUpload (which ARMS the
  // module-global firstPublishTiming singleton) onward runs inside this try. Its finally
  // disables the singleton on EVERY exit that did not finalize it — a reupload /
  // no-advance return, an epoch/409/422 return, or a thrown encrypt/commit/state-save
  // error. The success path needs no flag: finishFirstPublishStats itself disables the
  // singleton, so `enabled` in the finally means exactly "exited without finalizing".
  try {
    // Missing or scan-mismatched sources defer immediately; ciphertext upload
    // mismatches retry within a bounded per-file budget. Only the stable subset is
    // committed, and watcher/safety scans re-queue deferred paths once they settle.
    const { deferred, retryLater, needsUpload } = await encryptAndUpload(api, root, cfg, local, appliedBase, report, deps.onProgress, backoff, {
      encryptFileToTemp: deps.encryptFileToTemp,
      encryptCacheFlushMs: deps.encryptCacheFlushMs,
      pruneLivePaths: scannedFilePaths,
      recoverAddresses,
      forceFullAudit,
      ...(deps.warningSink ? { warningSink: deps.warningSink } : {}),
    });

    // Build the manifest we actually COMMIT. A deferred file is dropped from this commit;
    // if it was previously synced we carry its base entry forward (mirrors the forward-only
    // ignore carry above) so it NEVER reads as a deletion on other machines, and a never-synced
    // deferred file is simply omitted. Invariant: every blob the committed manifest references
    // was uploaded AND hash-matched this run, or is an already-synced base blob — no dangling
    // ref, no phantom deletion.
    const committed = stampManifestSchemaForCommit(
      deferred.size === 0 ? local : deferManifest(local, appliedBase, deferred),
      state.lastSyncedManifest,
    );

    if (needsUpload && needsUpload.size > 0) {
      return reuploadOutcome(committed, [...needsUpload], needsUpload.size);
    }

    // If deferral left nothing to commit (every change deferred, git unchanged), don't burn a
    // no-op commit — the deferred files stand alone for the daemon to re-queue later. NEVER
    // short-circuit a forced git RE-CAPTURE (422 recovery): its whole point is to re-commit a
    // manifest whose git artifacts were re-uploaded, and gitUnchanged (identity-only) can't see
    // that the artifact blobs were missing.
    if (!repair && deferred.size > 0 && forceGitRecapture.size === 0) {
      const dd = diffManifests(appliedBase, committed);
      if (dd.added.length === 0 && dd.changed.length === 0 && dd.deleted.length === 0 && gitUnchanged) {
        if (gitPlan.filesFirstDeferred) {
          // Design 108 §3.2 anti-starvation: files-first committed nothing (every file
          // deferred) yet real repos were deferred. A terminal committed:false here would
          // leave the sequence at 0 and re-fire genesis every push, STARVING git. Return the
          // nonterminal fallback so the loop re-plans with ordinary git-inclusive planning
          // (best-effort, never a block). The uncommitted, idempotent ciphertext this attempt
          // uploaded is safe; the re-run reconstructs disk truth.
          return { done: false, action: { kind: "files-first-fallback" }, exhaustedError: "push: files-first fallback exceeded its independent cap" };
        }
        reportDeferred(deferred, deps.warningSink);
        return { done: true, result: { sequence: appliedSequence, manifest: committed, deferred: [...deferred], retryLater: [...retryLater], committed: false, ...resultCollisionMetadata(attemptState), ...(gitPlan.resolution ? { resolution: gitPlan.resolution } : {}) } };
      }
    }

    let commitTimings: CommitTimings | undefined;
    let commitOptions: CommitOptions | undefined;
    // Design 204 §4.2: the writer's policy decides this seam too — no raw env read
    // here, or the two seams could diverge in a way no wire assertion can see.
    // Under the master kill (or with deltas killed) NOTHING is reconstructed: the
    // meta validate + manifestFromMeta + O(N) validateManifest + O(N) canonical
    // hash below are pure waste for a base the writer would immediately discard.
    let deltaBase: { manifest: Manifest; meta: GlobalManifestMeta } | undefined;
    let deltaBaseRejection: "no-base" | "integrity" | undefined;
    if (mdeWritePolicy().delta && !forceSnapshot) {
      const manifestMeta = validManifestMeta(state.manifestMeta);
      const reconstructedBase = manifestMeta ? manifestFromMeta(state.lastSyncedManifest, manifestMeta) : undefined;
      if (!manifestMeta || !reconstructedBase || !validateManifest(reconstructedBase).ok || state.lastSyncedSequence !== appliedSequence) {
        deltaBaseRejection = "no-base";
      } else {
        const integrityKey = JSON.stringify([
          appliedSequence,
          manifestMeta.encManifestSha,
          manifestMeta.manifestHash,
        ]);
        let integrityOk = baseIntegrityByMeta.get(integrityKey);
        if (integrityOk === undefined) {
          integrityOk = canonicalManifestHashStreaming(reconstructedBase) === manifestMeta.manifestHash;
          baseIntegrityByMeta.set(integrityKey, integrityOk);
        }
        if (!integrityOk) {
        // §4.2 base-integrity precondition (REVIEW-204 A7): validManifestMeta
        // validates SHAPE only. A structurally valid but stale/mismatched meta
        // publishes a delta whose base no reader can reproduce — and readers only
        // discover that AFTER the head commits. Bind the meta's manifestHash to
        // the base we actually reconstructed; any mismatch snapshots instead,
        // which rewrites the meta and self-heals the next push.
          deltaBaseRejection = "integrity";
        } else {
          deltaBase = { manifest: reconstructedBase, meta: manifestMeta };
        }
      }
    }
    if (deps.blockedFingerprint !== undefined || report.enabled || deltaBase || deltaBaseRejection || repair || forceSnapshot) {
      commitOptions = {
        ...(deps.blockedFingerprint !== undefined ? { blockedFingerprint: deps.blockedFingerprint } : {}),
        ...(report.enabled ? { onCommitTimings: (t: CommitTimings) => (commitTimings = t) } : {}),
        ...(deltaBase ? { deltaBase } : {}),
        ...(deltaBaseRejection ? { deltaBaseRejection } : {}),
        // The 422 chain-link arm (`attemptState.forceSnapshot`) already withheld
        // deltaBase above; forwarding the flag is behaviour-neutral there and is
        // what lets the writer log §7's `force` instead of a misleading `no-base`.
        ...(repair || forceSnapshot ? { forceSnapshot: true } : {}),
      };
    }
    const parentSequence = repair?.parentSequence ?? appliedSequence;
    let armedReceipt: GitResolutionPublicationReceipt | undefined;
    if (resolution && gitPlan.resolution?.outcome === "published") {
      const candidate = committed.gitRepos?.[resolution.repo];
      if (!candidate || !gitPlan.resolution.confirmedReportHash) {
        throw new Error("keep-mine planner admitted no exact publication candidate");
      }
      const receipt: GitResolutionPublicationReceipt = {
        repo: resolution.repo,
        attemptedGitIncomingKey: gitIncomingKey(candidate),
        attemptedSequence: parentSequence + 1,
        confirmedReportHash: gitPlan.resolution.confirmedReportHash,
      };
      commitOptions = {
        ...(commitOptions ?? {}),
        beforeCommitSend: async () => {
          const boundary = await loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex);
          const record = repoRecordsForState(boundary)[resolution.repo];
          if (!record) throw new Error("keep-mine receipt repository disappeared before commit send");
          const installed = await applyStateSavePacket(root, {
            expectedStream: boundary.stream,
            expectedNonce: expectedStateNonce(boundary),
            sourceGlobalSeq: boundary.lastSyncedSequence,
            repos: [{
              relPath: resolution.repo,
              expectedRepoGen: record.repoGen,
              newRecord: { ...inputRecord(record), resolutionReceipt: receipt },
              baseProof: carryRepoBaseProof(recordOriginLineage(record.branchBaseOrigins) ?? "legacy-untrusted"),
            }],
          });
          if (installed.status !== "accepted") throw new Error("keep-mine publication receipt could not be armed");
          // No failure-capable work may follow the durable arm before POST.
          // The accepted transaction already returns the exact installed state.
          state = installed.state;
          armedReceipt = receipt;
        },
      };
    }
    const commitStatsToken = firstPublishMeasurementToken();
    const commitStatsT0 = commitStatsToken ? performance.now() : 0;
    const redeemBefore = firstPublishTiming.stats.receiptRedemptionWallMs;
    let res: Awaited<ReturnType<typeof api.commit>>;
    try {
      res = await report.phase("commit", () => api.commit(parentSequence, cfg.deviceId, committed, commitOptions));
    } catch (error) {
      if (armedReceipt) {
        return { done: true, result: {
          sequence: appliedSequence,
          manifest: committed,
          committed: false,
          ...resultCollisionMetadata(attemptState),
          resolution: { outcome: "ack-uncertain", reason: "the publish acknowledgement was lost; run rbox push or rbox pull to reconcile" },
        } };
      }
      throw error;
    }
    if (firstPublishMeasurementLive(commitStatsToken)) {
      const redeemDuring = firstPublishTiming.stats.receiptRedemptionWallMs - redeemBefore;
      firstPublishTiming.stats.commitWallMs += Math.max(0, Math.round(performance.now() - commitStatsT0) - redeemDuring);
    }
    if (commitTimings) report.recordDetails("commit", { ...commitTimings }, formatCommitTimings(commitTimings));

    if (res.epochStale !== undefined) {
      if (armedReceipt) {
        await finishResolutionReceipt(root, state, armedReceipt.repo, armedReceipt, false);
        state = await loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex);
      }
      return { done: false, action: { kind: "epoch-stale" }, exhaustedError: "push: account epoch kept rotating under us" };
    }
    if (res.conflict) {
      deps.onCommitConflict?.(); // tally 409 retry pressure (design 09 §3)
      if (resolution) {
        try {
          if (armedReceipt) {
            const reconciled = await reconcileResolutionReceipt(root, cfg, deps, api);
            if (reconciled.status === "exact") {
              return { done: true, result: {
                sequence: reconciled.sequence,
                manifest: reconciled.manifest,
                committed: false,
                ...resultCollisionMetadata(attemptState),
                resolution: { outcome: "published", sequence: reconciled.sequence },
              } };
            }
            if (reconciled.status === "mismatch") {
              return { done: true, result: {
                sequence: reconciled.sequence,
                manifest: reconciled.manifest,
                committed: false,
                ...resultCollisionMetadata(attemptState),
                resolution: { outcome: "aborted-remote-moved", reason: "another machine published while confirming" },
              } };
            }
          }
          await pull(root, cfg, deps);
          const postPull = await loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex);
          return { done: true, result: {
            sequence: postPull.lastSyncedSequence,
            manifest: postPull.lastSyncedManifest,
            committed: false,
            ...resultCollisionMetadata(attemptState),
            resolution: { outcome: "aborted-remote-moved", reason: "another machine published while confirming" },
          } };
        } catch {
          return { done: true, result: {
            sequence: appliedSequence,
            manifest: committed,
            committed: false,
            ...resultCollisionMetadata(attemptState),
            resolution: { outcome: "ack-uncertain", reason: "remote truth could not be authenticated; run rbox push or rbox pull to reconcile" },
          } };
        }
      }
      return repair
        ? { done: false, action: { kind: "repair-conflict" }, exhaustedError: "repair: verified head advanced during publication" }
        : { done: false, action: { kind: "pull-first" }, exhaustedError: "push: too many conflicts, remote is moving faster than we can reconcile" };
    }
    if (res.unsatisfiedBlobs) {
      if (armedReceipt) {
        await finishResolutionReceipt(root, state, armedReceipt.repo, armedReceipt, false);
        state = await loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex);
      }
      // A missing GIT artifact can't be satisfied by a file re-upload, and an identity-carry
      // would re-reference the absent bundle (§28) — so force a RE-CAPTURE for
      // exactly the repos whose sections reference the missing encShas (see gitForceForMissingBlobs).
      // The reupload retry re-checks missingBlobs + re-uploads the missing FILE ciphertext with
      // the same per-file defer; the SAME manifest is retried (no pull, no re-scan).
      return reuploadOutcome(committed, res.unsatisfiedBlobs, res.unsatisfiedTotal, res.attemptedManifestChain);
    }

    // ACCEPTED. Capture the files-synced ACK timestamp NOW (design 108 §3.6): the END is
    // this accepted commit response; the START is init's command milestone (before scan).
    // Scoped to init (which sets filesFirstStartedAt) — a daemon/CLI push without it leaves
    // the KPI 0 so it never forces a FirstPublishStats render on a non-init push, and the
    // value survives across a 409/422 retry (it is the command wall, not a per-attempt one).
    if (firstPublishTiming.enabled && deps.filesFirstStartedAt !== undefined) {
      firstPublishTiming.stats.timeToFilesSyncedMs = Math.max(0, Math.round(performance.now() - deps.filesFirstStartedAt));
    }

    // Per-repo base advance (design 43 §7 [v5]): a PENDING repo's committed section is the
    // remote's own unapplied truth — the saved git BASE keeps the OLD entry (or none) so the
    // next pull still sees remote != base and retries the apply (see gitBaseAfterCommit).
    const supersededPending = new Set(gitPlan.supersededPending);
    const resolvedPending = new Set(gitPlan.resolvedPending ?? []);
    const settledPending = new Set([...supersededPending, ...resolvedPending]);
    // Design 174 §4.2: the one bounded supersession line — emitted ONLY here, after
    // the accepted commit, so it never claims a supersession a pre-ACK failure undid.
    for (const relPath of [...supersededPending].sort()) {
      const keys = gitPlan.supersessionIdentityKeys?.[relPath];
      (deps.onGitLog ?? ((l: string) => console.error(l)))(
        `git-sync superseded pending ${relPath}${keys ? ` [P=${keys.pending} candidate=${keys.candidate} composed=${keys.composed}]` : ""}: local history subsumes the unapplied remote section. rbox will publish the local history instead.`,
      );
    }
    for (const relPath of [...resolvedPending].sort()) {
      (deps.onGitLog ?? ((l: string) => console.error(l)))(
        `git-sync published keep-mine ${relPath}: local Git state is now the acknowledged remote truth`,
      );
    }
    const pendingAfterAck = { ...(gitPlan.gitPendingRemote ?? {}) };
    for (const relPath of settledPending) delete pendingAfterAck[relPath];
    const stateGit = gitBaseAfterCommit(committed.gitRepos, pendingAfterAck, appliedBase.gitRepos);
    const advertised: Record<string, GitSection | null> = {};
    const repoProofs: Record<string, RepoBaseProof> = {};
    const ackRecords = repoRecordsForState(state);
    const ackPartial = Object.fromEntries([...settledPending].map((relPath) => [relPath, null]));
    const ackAttempt = Object.fromEntries([...settledPending].map((relPath) => [relPath, null]));
    const ackDeferrals: Record<string, OrderedGitDeferralUpdates> = {};
    for (const relPath of settledPending) {
      const ordered = orderedDeferralUpdates(ackRecords[relPath]?.deferrals, { apply: null });
      if (ordered) ackDeferrals[relPath] = ordered;
    }
    const resolutionsAfterAck = { ...(gitPlan.gitNeedsResolution ?? {}) };
    for (const relPath of resolvedPending) delete resolutionsAfterAck[relPath];
    for (const relPath of new Set([
      ...Object.keys(ackRecords),
      ...Object.keys(committed.gitRepos ?? {}),
    ])) {
      const section = committed.gitRepos?.[relPath];
      advertised[relPath] = section ?? null;
      const binding = gitPlan.publisherAckBindings?.[relPath];
      if (section && binding) repoProofs[relPath] = {
        authority: {
          kind: "publisher-ack",
          lineageHash: binding.lineageHash,
          repositoryIdentityHash: binding.repositoryIdentityHash,
          incomingKey: gitIncomingKey(section),
          sourceSeq: res.sequence!,
          advertisedRefs: section.refs,
          ...(gitPlan.absentBranchProofs?.[relPath]
            ? { absentBranchProofs: gitPlan.absentBranchProofs[relPath] }
            : {}),
        },
        lockedProof: {
          repoKind: binding.repoKind,
          effectiveRefScope: section.refScope,
          checkoutComplete: true,
          branches: {},
          safeRefs: {},
        },
      };
      else {
        const retainedLineage = recordOriginLineage(ackRecords[relPath]?.branchBaseOrigins)
          ?? binding?.lineageHash
          ?? "legacy-untrusted";
        repoProofs[relPath] = carryRepoBaseProof(retainedLineage);
      }
    }
    const ackValues = {
      bases: stateGit,
      packedRefsIdentity: gitPlan.packedRefsIdentity,
      advertised,
      repoAbsent: gitPlan.repoAbsent ?? {},
      pending: pendingAfterAck,
      removed: gitPlan.gitReposRemoved,
      resolutions: resolutionsAfterAck,
      partial: ackPartial,
      attempt: ackAttempt,
      resolutionReceipt: Object.fromEntries([...resolvedPending].map((relPath) => [relPath, null])),
      deferrals: ackDeferrals,
    };
    try {
      await report.phase("state-save", () => saveStateSource(root, state, {
        expectedStream: syncStreamId(cfg),
        sourceGlobalSeq: res.sequence!,
        globalManifest: committed,
        ...(res.manifestMeta ? { manifestMeta: res.manifestMeta } : {}),
        observedRepos: observedRepoKeys(state, committed.gitRepos, ackValues),
        values: ackValues,
        repoProofs,
        authoredCfgHashByRepo: gitPlan.authoredCfgHashByRepo,
      }, {
        allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
        forceLegacy: workspaceSyncMutexDegraded(deps.syncMutex),
      }));
    } catch (error) {
      if (armedReceipt) {
        return { done: true, result: {
          sequence: res.sequence!,
          manifest: committed,
          committed: true,
          ...resultCollisionMetadata(attemptState),
          resolution: { outcome: "ack-uncertain", reason: "the publish landed but local acknowledgement could not be saved; run rbox push or rbox pull" },
        } };
      }
      throw error;
    }

    // Finalize AFTER the fully-persisted commit — a failed attempt never appends a
    // success KPI, and a retry never double-appends. finishFirstPublishStats disables
    // the singleton (even when it returns no stats), so the finally below no-ops here.
    const firstPublish = finishFirstPublishStats();
    if (firstPublish) {
      report.recordDetails("upload", { firstPublish }, formatFirstPublishStats(firstPublish));
      deps.telemetry?.record({
        kind: "first_publish",
        timeToFilesSyncedMs: firstPublish.timeToFilesSyncedMs,
        pushWallMs: report.toJSON().wallMs,
        fileCount: fileCountOf(committed),
        uniqueBlobs: report.blobs,
      });
    }

    if (deferred.size > 0) reportDeferred(deferred, deps.warningSink);
    return { done: true, result: { sequence: res.sequence!, manifest: committed, deferred: [...deferred], retryLater: [...retryLater], committed: true, ...resultCollisionMetadata(attemptState), ...(gitPlan.filesFirstDeferred ? { gitDeferred: true } : {}), ...(gitPlan.resolution ? { resolution: {
      outcome: gitPlan.resolution.outcome,
      ...(gitPlan.resolution.reason ? { reason: gitPlan.resolution.reason } : {}),
      sequence: res.sequence!,
    } } : {}) } };
  } finally {
    if (firstPublishTiming.enabled) beginFirstPublishTiming(false);
  }
}

function assertNoUnevaluatedPurgeDeletes(matcher: IgnoreMatcher, deleted: string[]): void {
  for (const path of deleted) {
    const repo = matcher.unevaluatedGitRepoForPath?.(path);
    if (repo !== undefined) {
      throw new Error(
        `refusing purge: cannot evaluate tracked files for git repo ${repo} (first affected path ${path}). ` +
          `Fix that repo's .git/index and retry.`
      );
    }
  }
}
