/**
 * Publication owns one pushManifest call from capture through classified outcome.
 * Its bounded in-process retry loop stays inside this module; daemon long-horizon
 * recovery-probe and git-busy retries stay outside. Publisher acknowledgement is
 * conditional: ordinary acceptance acknowledges, while resolution transitions
 * settle and return without it.
 *
 * Never: candidate admission, commit classification, ACK composition, and capture-observation
 * persistence belong to their dedicated owners.
 */
import {
  canonicalManifestHashStreaming,
  diffManifests,
  scanManifest,
  validateManifest,
  manifestRequiresSchema4,
  type FileEntry,
  type Manifest,
  type CaseFoldCollisionGroup,
} from "../../engine/index.js";
import { applyStateSavePacket, ensureCapableStateLineage, expectedStateNonce, loadState, manifestFromMeta, repoRecordsForState, stateWasStreamMismatch, syncStreamId, validManifestMeta, type GitResolutionPublicationReceipt, type GlobalManifestMeta, type WorkspaceConfig } from "../config.js";
import { mdeWritePolicy } from "../e2ee-remote.js";
import { attestSavedBase, baseHashIsAttested } from "./base-hash-attestation.js";
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
  gitForceForMissingBlobs,
  gitIncomingKey,
  gitReposManifestSchema,
  planGitSections,
} from "../sync-git.js";
import { carriedLineageProof, recordOriginLineage, type RepoBaseProof } from "../sync-git/base-composer.js";
import { recordGitCaptureObservation } from "../sync-git/git-capture-observation.js";
import { settleRepublishRequests } from "../sync-git/republish-requests.js";
import type { GitResolutionRider } from "../sync-git/resolution-intent.js";
import { assertMayPublish } from "../scope/binding-scope.js";
import { assertSyncMutex, workspaceSyncMutexDegraded } from "../sync-mutex.js";
import { changedSidecarRepoKeys, inputRecord, observedRepoKeys, saveStateSource } from "../sync-state.js";
import { beginFirstPublishTiming, finishFirstPublishStats, formatFirstPublishStats } from "../upload-lane-timing.js";
import { type SyncDeps, withReportScanStats, withCache, withDircache, refreshWriteContext } from "./deps.js";
import { PushSpans } from "../push-spans.js";
import { savePathWarnings } from "../path-warnings.js";
import { formatCommitTimings, formatScanStats, scanDetailsOf } from "./format.js";
import { apiFor, MAX_ATTEMPTS, PUSH_CONFLICT_SURRENDER_MS, NO_GIT_FORCE, makeDeferErrnoReporter, defaultBackoff, filesFirstFlagEnabled, matcherForState, plaintextBytesOf, fileCountOf, scanTick } from "./policy.js";
import { finishResolutionReceipt, pull, reconcileResolutionReceipt, scanManifestForPushResult, surfaceResolutionReceiptReconciliation } from "./pull.js";
import { MutationGateClosedError } from "../../engine/mutation-gate.js";
import { cloneCollisionGroups, preparePublishCandidate, type GitCapturePort } from "./publish-candidate.js";
import type { LocalManifestProjectionSpans } from "../local-file-projection.js";
import { executeManifestCommit, type ManifestCommitPort } from "./manifest-commit-executor.js";
import { acknowledgePublishedGitTransitions, type RepoTransitionPort } from "./publisher-ack-transition.js";

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
  let files: FileEntry[] | undefined;
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
        files ??= [...manifest.files];
        files[index] = prior;
      }
    }
  }
  const normalized = files === undefined ? manifest : { ...manifest, files };
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
  const spans = PushSpans.from(deps);
  const report = spans.report;
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
  const { sequence, committed, gitDeferred, caseCollisions } = await pushManifestWithSpans(root, cfg, local, deps, {
    purgeIgnored,
    // Any unrelated deferral makes this scan non-authoritative, so a discovered
    // collision is still returned/printed but not persisted to the sidecar until
    // the next clean push authors durable truth.
    localFileObservation: localFileObservationForScan(scanDeferred.size === 0),
  }, spans);
  return gitDeferred
    ? { sequence, committed, caseCollisions, gitDeferred: true }
    : { sequence, committed, caseCollisions };
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

/** One typed transition behind the bounded retry loop: 409 pulls and rescans,
 * epoch-stale refreshes and rescans, while 422 retries the same manifest and
 * recaptures only referenced repos. Per-file churn remains inside upload. */
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
  const action: Extract<RecoveryAction, { kind: "reupload" }> = {
    kind: "reupload",
    forceGitRecapture: gitForceForMissingBlobs(committed.gitRepos, new Set(unsatisfiedBlobs)),
    localForRetry: committed,
    unsatisfiedTotal: total,
    unsatisfiedBlobs,
  };
  if (forceSnapshot) action.forceSnapshot = true;
  return {
    done: false,
    action,
    exhaustedError: "push: server keeps reporting missing blobs after re-upload",
  };
}

/** Upload and commit a precomputed manifest. No-op avoids echo storms; changing
 * files defer without aborting stable work; 409 pulls/rescans and 422 reuploads.
 * The bounded loop owns the shared attempt budget and only backs off for 409. */
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
  return pushManifestWithSpans(root, cfg, local, deps, options, PushSpans.from(deps));
}

function pushManifestWithSpans(
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  deps: SyncDeps,
  options: PushManifestOptions,
  spans: PushSpans,
): Promise<PushResult> {
  return spans.run(() => pushManifestInner(root, cfg, local, deps, options, spans));
}

async function pushManifestInner(
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  deps: SyncDeps,
  options: PushManifestOptions,
  spans: PushSpans,
): Promise<PushResult> {
  const { purgeIgnored = false, repair, resolution } = options;
  // Design 212 §3.1b layer 1. This is the shared publication boundary: ignore purge,
  // git keep-mine, recover's repair-publish and chain repair all arrive here. It must
  // stay the FIRST statement — ahead of resolution-receipt reconciliation, the scan,
  // git planning, upload and repair — because a scoped binding holds only part of the
  // tree, and every one of those steps reads that partial tree as the whole truth.
  await assertMayPublish(root);
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const report = spans.report;
  deps = withReportScanStats(deps, report);
  const backoff = deps.backoff ?? defaultBackoff;
  const now = deps.now ?? Date.now;
  let attempt = 0;
  // Design 244 a2: when the first pull-first conflict of this op happened. The op
  // surrenders the lane once it has spent PUSH_CONFLICT_SURRENDER_MS losing 409 races,
  // even with attempts left — the daemon probe, not this loop, owns long retry.
  let firstConflictAt: number | undefined;
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
  };
  if (repair) state.repair = repair;
  if (resolution) state.resolution = resolution;
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
    // Checked BEFORE the attempt: a single slow pull can outlast the budget on its own,
    // and a new attempt must never start once the op has surrendered the lane.
    if (firstConflictAt !== undefined && now() - firstConflictAt > PUSH_CONFLICT_SURRENDER_MS) {
      throw new PushConflictExhaustedError("push: too many conflicts, remote is moving faster than we can reconcile");
    }
    const outcome = await runPushAttempt(root, cfg, deps, backoff, state, baseIntegrityByMeta, spans);
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
    if (outcome.action.kind === "pull-first") firstConflictAt ??= now();
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
        // Design 267 §3.0: a recovery pull nested in this retry loop never mints
        // an elision receipt — it observes a slice, not a whole cycle.
        await pull(root, cfg, deps, undefined, "recovery");
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

/** Run one attempt and classify its result; the outer loop owns retry policy. */
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

/** #526: clear chain-restart requests the landed manifest proves satisfied.
 *  Called on every receipt that proves a manifest landed. A settle failure can
 *  never fail an already-durable commit — the worst case is one more full
 *  bundle on the next push. */
async function settleRepublish(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps,
  gitRepos: Manifest["gitRepos"],
): Promise<void> {
  if (!deps.syncMutex) return;
  try {
    const settled = await settleRepublishRequests(root, syncStreamId(cfg), gitRepos, deps.syncMutex);
    for (const relPath of settled) {
      (deps.onGitLog ?? ((line: string) => console.error(line)))(`git-sync republish restarted ${relPath}`);
    }
  } catch (error) {
    deps.warningSink?.(`rbox: could not clear the Git republish request: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function filePathsForCache(manifest: Manifest): Set<string> {
  return new Set(manifest.files.filter((entry) => entry.type === "file").map((entry) => entry.path));
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
  spans: PushSpans,
): Promise<AttemptOutcome> {
  const { purgeIgnored, forceGitRecapture, recoverAddresses, forceFullAudit, forceSnapshot, filesFirstAborted, repair, resolution } = attemptState;
  let local = attemptState.local;
  // Created PER attempt (not once in the loop): when no remote is injected, a stateful
  // RboxApi must start each attempt with a clean upload-receipt slate — exactly as the
  // prior recursive form did (each recursive call re-ran `deps.remote ?? apiFor(cfg)`).
  const api = deps.remote ?? apiFor(cfg);
  const report = spans.report;
  let state = await spans.span("state-load", () => loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex));
  state = await spans.span("state_lineage_ms", () => ensureCapableStateLineage(root, state));
  // One authority for every push decision: the persisted base records the last
  // pull that applied completely. A newer remote manifest may have been verified
  // (and its anti-rollback head pinned) before apply failed, but it is not a base.
  const appliedSequence = state.lastSyncedSequence;
  const appliedBase = state.lastSyncedManifest;
  const matcher = spans.span("matcher_ms", () => matcherForState(root, cfg, state, { purgeSafety: purgeIgnored })); // shared: forward-only ignore carry + git discovery
  const projectionT0 = report.enabled ? performance.now() : 0;
  const scannedFilePaths = attemptState.rawScannedFilePaths;
  let projectionSpans: (LocalManifestProjectionSpans & { projection_diff_ms: number; projection_ms: number }) | undefined;

  // Every Git-plane effect the candidate transition may order. `execute` is the
  // sole mutating member: it owns scratch/conflict-ref mutations, so the whole
  // planner is registered conservatively under one commit lease and a stop drains
  // any read phase that can later reach one.
  const capture: GitCapturePort = {
    execute: (plan) => spans.span("git-plan", async () => {
      const lease = deps.mutationBoundary?.enter({ phase: "git-commit" });
      try {
        if (lease && !lease.beginCommit()) throw new MutationGateClosedError();
        return {
          planId: plan.planId,
          // `forceGitRecapture` is the per-relPath 422 recapture set [v2, M5]: a git
          // artifact missing server-side can't be satisfied by a file re-upload — ONLY
          // the repos whose sections reference the missing encShas recapture; the force
          // lives at this single site or the recovery is dead.
          plan: await planGitSections(root, cfg, state, api, plan.forceGitRecapture, matcher, deps.onProgress, backoff, {
            onGitLog: deps.onGitLog,
            disableConfigLane: workspaceSyncMutexDegraded(deps.syncMutex),
            degradedMutex: workspaceSyncMutexDegraded(deps.syncMutex),
            filesFirstDefer: plan.filesFirstDefer,
            onGitReposDiscovered: deps.onGitReposDiscovered,
            ownedRefMutationBoundary: deps.ownedRefMutationBoundary,
            resolution: plan.resolution,
            resolutionCaptureTestHooks: deps.resolutionCaptureTestHooks,
            beforeAbsenceWitness: deps.beforeAbsenceWitness,
          }),
        };
      } finally {
        lease?.finish();
      }
    }),
    notifyBusyDeferred: (relPaths) => {
      try { deps.onGitBusyDeferred?.(relPaths); } catch { /* daemon observer is non-throwing */ }
    },
    observe: (observation) => {
      const observationRecords = repoRecordsForState(state);
      return recordGitCaptureObservation(
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
            state = await spans.span("state-save", () => saveStateSource(root, state, {
              expectedStream: syncStreamId(cfg),
              sourceGlobalSeq: write.acceptedSequence,
              observedRepos: write.observedRepos,
              values: write.values,
              repoProofs: write.repoProofs,
            }, {
              allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
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
        observation,
      );
    },
    reportCapturePlan: ({ plan }) => {
      if (!report.enabled) return;
      report.record("git-plan", { count: Object.keys(plan.gitRepos ?? {}).length }); // guarded: skip the key-array materialization on no-op ticks
      if (plan.gitPlanStats) report.recordDetails("git-plan", { gitPlan: plan.gitPlanStats }, formatGitPlanStats(plan.gitPlanStats));
    },
    carryBaseOnNoOp: async ({ receipt, acceptedSequence: carrySequence, values }) => {
      const changedRepos = changedSidecarRepoKeys(state, values);
      if (changedRepos.length === 0) return;
      const records = repoRecordsForState(state);
      const repoProofs: Record<string, RepoBaseProof> = Object.fromEntries(changedRepos.map((relPath) => [
        relPath,
        carriedLineageProof(
          recordOriginLineage(records[relPath]?.branchBaseOrigins),
          receipt.plan.publisherAckBindings?.[relPath]?.lineageHash,
        ),
      ]));
      await spans.span("state-save", () => saveStateSource(root, state, {
        expectedStream: syncStreamId(cfg),
        sourceGlobalSeq: carrySequence,
        observedRepos: changedRepos,
        values,
        repoProofs,
      }, {
        allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
      }));
    },
    logPublicationLine: ({ plan }) => {
      (deps.onGitLog ?? ((l: string) => console.error(l)))(formatGitPushLine(plan), plan);
    },
  };
  if (report.enabled) {
    capture.reportProjectionSpans = (spans) => {
      projectionSpans = { ...spans, projection_ms: performance.now() - projectionT0 };
    };
  }

  const candidateOptions = {
    purgeIgnored,
    repairing: repair !== undefined,
    syncGit: cfg.syncGit === true,
    filesFirstEnabled: filesFirstFlagEnabled(),
    filesFirstAborted,
    streamMismatch: stateWasStreamMismatch(state),
    forceGitRecapture,
    allowMassDelete: deps.allowMassDeletePush === true,
    onMassDeleteRefused: () => deps.telemetry?.record({ kind: "safety_event", eventType: "mass_delete_breaker", count: 1 }),
  };
  if (resolution) Object.assign(candidateOptions, { resolution });
  if (deps.massDeleteHint !== undefined) Object.assign(candidateOptions, { massDeleteHint: deps.massDeleteHint });
  const sealed = await preparePublishCandidate(
    { acceptedSequence: appliedSequence, appliedBase },
    {
      manifest: local,
      matcher,
      projected: attemptState.candidateProjected,
      caseCollisions: attemptState.caseCollisions,
      authority: attemptState.observationAuthority,
      recordProjection: async ({ manifest, caseCollisions, strandedIgnored }) => {
        attemptState.caseCollisions = caseCollisions;
        attemptState.local = manifest;
        attemptState.candidateProjected = true;
        try {
          deps.onStrandedIgnoredObserved?.(strandedIgnored);
        } catch {
          // Design 224 §2.3: a detector count can never change publication correctness.
        }
        try {
          await deps.onCaseCollisionObservation?.({
            authority: attemptState.observationAuthority,
            caseCollisions: cloneCollisionGroups(caseCollisions),
          });
        } catch (error) {
          try {
            deps.warningSink?.(`rbox: could not record path-collision warning: ${error instanceof Error ? error.message : String(error)}`);
          } catch {
            // The warning observer and its diagnostic are advisory by contract.
          }
        }
      },
    },
    capture,
    candidateOptions,
  );
  if (projectionSpans) {
    spans.note("projection_ms", projectionSpans.projection_ms);
    spans.note("projection_ignore_carry_ms", projectionSpans.projection_ignore_carry_ms);
    spans.note("projection_casefold_ms", projectionSpans.projection_casefold_ms);
    spans.note("projection_sort_ms", projectionSpans.projection_sort_ms);
    spans.note("projection_diff_ms", projectionSpans.projection_diff_ms);
  }
  spans.note("state_lineage_ms");
  spans.note("matcher_ms");
  const publication = sealed.publication;
  local = sealed.candidate;
  if (sealed.admission === "no-op") {
    if (cfg.encrypted) await pruneEncryptAddressCache(root, cfg, scannedFilePaths);
    const result: PushResult = { sequence: appliedSequence, manifest: local, committed: false, ...resultCollisionMetadata(attemptState) };
    if (publication.resolution) result.resolution = publication.resolution;
    return { done: true, result };
  }
  const gitUnchanged = sealed.gitUnchanged;

  // Upload missing blobs — ALWAYS convergently encrypted (by encSha, ciphertext).
  // E2EE is the only mode (design 12 D6): a non-encrypted config reaching the sync
  // core is a fail-closed error, BEFORE any byte is uploaded — never plaintext.
  if (!cfg.encrypted || !cfg.kek) throw new Error("E2EE required: refusing to sync without an encryption key (run `rbox init`/`rbox pair`/`rbox key recover`)");

  // Design 108: upload arms the operation sink; every unfinished exit disarms it.
  // Finalization disarms itself, so enabled in finally means unsuccessful exit.
  try {
    // Missing or scan-mismatched sources defer immediately; ciphertext upload
    // mismatches retry within a bounded per-file budget. Only the stable subset is
    // committed, and watcher/safety scans re-queue deferred paths once they settle.
    const uploadOptions: Parameters<typeof encryptAndUpload>[8] = {
      encryptFileToTemp: deps.encryptFileToTemp,
      encryptCacheFlushMs: deps.encryptCacheFlushMs,
      pruneLivePaths: scannedFilePaths,
      recoverAddresses,
      forceFullAudit,
    };
    if (deps.warningSink) uploadOptions.warningSink = deps.warningSink;
    const { deferred, retryLater, needsUpload } = await encryptAndUpload(api, root, cfg, local, appliedBase, report, deps.onProgress, backoff, uploadOptions);

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
        if (publication.filesFirstDeferred) {
          // Design 108 §3.2 anti-starvation: files-first committed nothing (every file
          // deferred) yet real repos were deferred. A terminal committed:false here would
          // leave the sequence at 0 and re-fire genesis every push, STARVING git. Return the
          // nonterminal fallback so the loop re-plans with ordinary git-inclusive planning
          // (best-effort, never a block). The uncommitted, idempotent ciphertext this attempt
          // uploaded is safe; the re-run reconstructs disk truth.
          return { done: false, action: { kind: "files-first-fallback" }, exhaustedError: "push: files-first fallback exceeded its independent cap" };
        }
        reportDeferred(deferred, deps.warningSink);
        const result: PushResult = { sequence: appliedSequence, manifest: committed, deferred: [...deferred], retryLater: [...retryLater], committed: false, ...resultCollisionMetadata(attemptState) };
        if (publication.resolution) result.resolution = publication.resolution;
        return { done: true, result };
      }
    }

    // Design 204 §4.2: the writer's policy decides this seam too — no raw env read
    // here, or the two seams could diverge in a way no wire assertion can see.
    // Under the master kill (or with deltas killed) NOTHING is reconstructed: the
    // meta validate + manifestFromMeta + O(N) validateManifest + O(N) canonical
    // hash below are pure waste for a base the writer would immediately discard.
    let deltaBase: { manifest: Manifest; meta: GlobalManifestMeta; validated?: true } | undefined;
    let deltaBaseRejection: "no-base" | "integrity" | undefined;
    spans.span("delta_base_ms", () => {
      if (mdeWritePolicy().delta && !forceSnapshot) {
        const manifestMeta = validManifestMeta(state.manifestMeta);
        // #816: this base is the manifest the PREVIOUS push committed, and that
        // push recorded the encoder's own `resultHash` for it against this exact
        // state object. When that attestation stands, both O(N) passes below —
        // the shape validation and the canonical re-hash — restate a proof we
        // already hold. Absent or mismatched, nothing is skipped.
        const attested = manifestMeta !== undefined && baseHashIsAttested(state, manifestMeta);
        const reconstructedBase = manifestMeta ? manifestFromMeta(state.lastSyncedManifest, manifestMeta) : undefined;
        if (!manifestMeta || !reconstructedBase || (!attested && !validateManifest(reconstructedBase).ok) || state.lastSyncedSequence !== appliedSequence) {
          deltaBaseRejection = "no-base";
        } else {
          const integrityKey = JSON.stringify([
            appliedSequence,
            manifestMeta.encManifestSha,
            manifestMeta.manifestHash,
          ]);
          let integrityOk = attested ? true : baseIntegrityByMeta.get(integrityKey);
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
            // The writer re-validates the base it is handed; this seam has just
            // established that validity (freshly, or by the standing attestation
            // which covers the same content), so say so and spare it the pass.
            deltaBase = { manifest: reconstructedBase, meta: manifestMeta, validated: true };
          }
        }
      }
    });
    const parentSequence = repair?.parentSequence ?? appliedSequence;
    let keepMineArm: GitResolutionPublicationReceipt | undefined;
    if (resolution && publication.resolution?.outcome === "published") {
      const candidate = committed.gitRepos?.[resolution.repo];
      if (!candidate || !publication.resolution.confirmedReportHash) {
        throw new Error("keep-mine planner admitted no exact publication candidate");
      }
      keepMineArm = {
        repo: resolution.repo,
        attemptedGitIncomingKey: gitIncomingKey(candidate),
        attemptedSequence: parentSequence + 1,
        confirmedReportHash: publication.resolution.confirmedReportHash,
      };
    }
    const commitPort: ManifestCommitPort = {
      armKeepMine: async (receipt) => {
        const boundary = await loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex);
        const record = repoRecordsForState(boundary)[receipt.repo];
        if (!record) throw new Error("keep-mine receipt repository disappeared before commit send");
        const installed = await applyStateSavePacket(root, {
          expectedStream: boundary.stream,
          expectedNonce: expectedStateNonce(boundary),
          sourceGlobalSeq: boundary.lastSyncedSequence,
          repos: [{
            relPath: receipt.repo,
            expectedRepoGen: record.repoGen,
            newRecord: { ...inputRecord(record), resolutionReceipt: receipt },
            baseProof: carriedLineageProof(recordOriginLineage(record.branchBaseOrigins)),
          }],
        });
        if (installed.status !== "accepted") throw new Error("keep-mine publication receipt could not be armed");
        // No failure-capable work may follow the durable arm before POST.
        // The accepted transaction already returns the exact installed state.
        state = installed.state;
      },
      commit: async ({ parentSequence: parent, manifest, options }) => {
        return spans.span("commit", () => api.commit(parent, cfg.deviceId, manifest, options));
      },
      reportCommitTimings: (timings) => report.recordDetails("commit", { ...timings }, formatCommitTimings(timings)),
      disarmKeepMine: async (receipt) => {
        await finishResolutionReceipt(root, state, receipt.repo, receipt, false);
        state = await loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex);
      },
      notifyConflict: () => { deps.onCommitConflict?.(); }, // tally 409 retry pressure (design 09 §3)
      reconcileKeepMine: async () => {
        const reconciled = await reconcileResolutionReceipt(root, cfg, deps, api);
        return reconciled.status === "none"
          ? { status: "none" }
          : { status: reconciled.status, sequence: reconciled.sequence, manifest: reconciled.manifest };
      },
      pullAndLoadAccepted: async () => {
        await pull(root, cfg, deps, undefined, "recovery");
        const postPull = await loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex);
        return { sequence: postPull.lastSyncedSequence, manifest: postPull.lastSyncedManifest };
      },
    };
    const commitPlan = {
      identity: sealed.identity,
      manifest: committed,
      parentSequence,
      // The 422 chain-link arm (`attemptState.forceSnapshot`) already withheld
      // deltaBase above; forwarding the flag is behaviour-neutral there and is
      // what lets the writer log §7's `force` instead of a misleading `no-base`.
      forceSnapshot: repair !== undefined || forceSnapshot,
      reportTimings: report.enabled,
      resolutionRider: resolution !== undefined,
    };
    if (deltaBase) Object.assign(commitPlan, { deltaBase });
    if (deltaBaseRejection) Object.assign(commitPlan, { deltaBaseRejection });
    if (deps.blockedFingerprint !== undefined) Object.assign(commitPlan, { blockedFingerprint: deps.blockedFingerprint });
    if (keepMineArm) Object.assign(commitPlan, { keepMineArm });
    const commitReceipt = await executeManifestCommit(commitPlan, commitPort);
    spans.note("delta_base_ms");
    if (commitReceipt.kind === "ack-uncertain") {
      return { done: true, result: {
        sequence: appliedSequence,
        manifest: committed,
        committed: false,
        ...resultCollisionMetadata(attemptState),
        resolution: { outcome: "ack-uncertain", reason: commitReceipt.reason },
      } };
    }
    if (commitReceipt.kind === "epoch-stale") {
      return { done: false, action: { kind: "epoch-stale" }, exhaustedError: "push: account epoch kept rotating under us" };
    }
    if (commitReceipt.kind === "resolution-transition") {
      const transition = commitReceipt.transition;
      if (transition.kind === "authentication-failed") {
        return { done: true, result: {
          sequence: appliedSequence,
          manifest: committed,
          committed: false,
          ...resultCollisionMetadata(attemptState),
          resolution: { outcome: "ack-uncertain", reason: transition.reason },
        } };
      }
      if (transition.kind === "published") await settleRepublish(root, cfg, deps, transition.manifest.gitRepos);
      return { done: true, result: {
        sequence: transition.sequence,
        manifest: transition.manifest,
        committed: false,
        ...resultCollisionMetadata(attemptState),
        resolution: transition.kind === "published"
          ? { outcome: "published", sequence: transition.sequence }
          : { outcome: "aborted-remote-moved", reason: transition.reason },
      } };
    }
    if (commitReceipt.kind === "conflict") {
      return repair
        ? { done: false, action: { kind: "repair-conflict" }, exhaustedError: "repair: verified head advanced during publication" }
        : { done: false, action: { kind: "pull-first" }, exhaustedError: "push: too many conflicts, remote is moving faster than we can reconcile" };
    }
    if (commitReceipt.kind === "unsatisfied") {
      // A missing GIT artifact can't be satisfied by a file re-upload, and an identity-carry
      // would re-reference the absent bundle (§28) — so force a RE-CAPTURE for
      // exactly the repos whose sections reference the missing encShas (see gitForceForMissingBlobs).
      // The reupload retry re-checks missingBlobs + re-uploads the missing FILE ciphertext with
      // the same per-file defer; the SAME manifest is retried (no pull, no re-scan).
      return reuploadOutcome(committed, commitReceipt.unsatisfiedBlobs, commitReceipt.unsatisfiedTotal, commitReceipt.attemptedManifestChain);
    }
    const acceptedSequence = commitReceipt.sequence;
    await settleRepublish(root, cfg, deps, committed.gitRepos);

    // Design 108 §3.6: init's command-wall KPI ends at the accepted response and
    // survives retries; ordinary pushes leave it zero and do not force rendering.
    if (spans.firstPublish.enabled && deps.filesFirstStartedAt !== undefined) {
      spans.firstPublish.stats.timeToFilesSyncedMs = Math.max(0, Math.round(performance.now() - deps.filesFirstStartedAt));
    }

    const transitionPort: RepoTransitionPort = {
      records: repoRecordsForState(state),
      observedRepos: (values) => observedRepoKeys(state, committed.gitRepos, values),
      announce: (line) => { (deps.onGitLog ?? ((l: string) => console.error(l)))(line); },
      save: async (write) => {
        const saved = await spans.span("state-save", () => saveStateSource(root, state, {
            expectedStream: syncStreamId(cfg),
            sourceGlobalSeq: write.acceptedSequence,
            globalManifest: write.globalManifest,
            manifestMeta: write.manifestMeta,
            // Push is structurally unscoped: `assertMayPublish` is its first
            // statement, so its base is always the unprojected remote manifest.
            baseIsUnscopedRemote: true,
            observedRepos: write.observedRepos,
            values: write.values,
            repoProofs: write.repoProofs,
            authoredCfgHashByRepo: write.authoredCfgHashByRepo,
          }, {
            allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
          }));
        // #816: the meta just persisted carries the encoder's own canonical hash
        // of `write.globalManifest`. Record that, so the next push reads the
        // proof instead of re-deriving it over every entry.
        if (write.manifestMeta) attestSavedBase(saved, write.globalManifest, write.manifestMeta, write.acceptedSequence);
      },
    };
    const acknowledgement = await spans.span("ack_ms", () => acknowledgePublishedGitTransitions(
      {
        identity: sealed.identity,
        manifest: committed,
        appliedBaseGit: appliedBase.gitRepos,
        transition: publication.transition,
      },
      commitReceipt,
      transitionPort,
    ));
    if (acknowledgement.kind === "accepted-state-pending") {
      // An unarmed publication keeps the pre-seam contract: the state-save error
      // is the caller's, not a soft "landed but unrecorded" result.
      if (!acknowledgement.reason.armed) throw acknowledgement.reason.cause;
      return { done: true, result: {
        sequence: acceptedSequence,
        manifest: committed,
        committed: true,
        ...resultCollisionMetadata(attemptState),
        resolution: { outcome: "ack-uncertain", reason: "the publish landed but local acknowledgement could not be saved; run rbox push or rbox pull" },
      } };
    }

    // Only a fully persisted commit finalizes and appends this operation's KPI.
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
    const result: PushResult = { sequence: acceptedSequence, manifest: committed, deferred: [...deferred], retryLater: [...retryLater], committed: true, ...resultCollisionMetadata(attemptState) };
    if (publication.filesFirstDeferred) result.gitDeferred = true;
    if (publication.resolution) {
      result.resolution = { outcome: publication.resolution.outcome, sequence: acceptedSequence };
      if (publication.resolution.reason) result.resolution.reason = publication.resolution.reason;
    }
    return { done: true, result };
  } finally {
    if (spans.firstPublish.enabled) beginFirstPublishTiming(false);
  }
}
