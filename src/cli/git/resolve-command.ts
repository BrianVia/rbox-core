import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertGitTargetWithinRoot,
  buildIgnoreMatcher,
  checkoutJournalDir,
  incomingOwnershipRoots,
  isGitBusy,
  gitPreflight,
  oracleFromState,
  partitionOwnedByIncoming,
  receiverEquivalentCollisionNames,
  type AppliedManifestOracle,
  type BlobStore,
  type CheckoutCapabilityProbe,
  type GitSection,
  settleBaseAbsentArtifact,
  inspectLockedPRepairReceipt,
  persistPRepairTerminal,
  readBasePresentArtifact,
  refreshLockedAcceptedPRepair,
  resumeLockedAcceptedPRepair,
  runLockedPRepairAttempt,
} from "../../engine/index.js";
import { pinDisplaced } from "../../engine/git/keep-pins.js";
import { branchesCheckedOutElsewhereStrict } from "../../engine/git/apply.js";
import { quarantineLocal } from "../../engine/git/quarantine.js";
import { hasInProgressOpState, readAllRefs, readAllRefsStrict, readOpStateSnapshot } from "../../engine/git/refs.js";
import { git, headBranchOf, repoCtx, type RepoCtx } from "../../engine/git/shared.js";
import { hashBytes, hashFile } from "../../engine/hash.js";
import {
  expectedStateNonce,
  loadState,
  repoRecordsForState,
  syncStreamId,
  type GitDeferralReason,
  type GitResolutionBinding,
  type RepoRecord,
  type RepoRecordInput,
  type SyncState,
  type WorkspaceConfig,
} from "../config.js";
import { buildAuthedRemote } from "../e2ee-client.js";
import type { SyncRemote } from "../remote.js";
import { reconcileResolutionReceipt, scanManifestForPush } from "../sync/pull.js";
import { pushManifest, type PushResult } from "../sync/push.js";
import type { SyncDeps } from "../sync/deps.js";
import { inputRecord } from "../sync-state.js";
import { withWorkspaceSyncMutex, WorkspaceSyncBusyError, WorkspaceSyncTimeoutError, workspaceSyncMutexDegraded, type SyncMutexOptions } from "../sync-mutex.js";
import {
  checkoutJournalBinding,
  followDivergedRepo,
  quarantineUnboundFollowJournal,
  recoverAndLandFollowJournal,
  stageIncoming,
  type FollowIntended,
  type FollowProgress,
} from "../sync-git/follow.js";
import { checkoutLabel, gitIncomingKey, observePackedRefsIdentity, packedRefsMtimeRegressed, repoDirOf, sectionOpState } from "../sync-git/shared.js";
import { branchBaseOriginMatches, composeRepoBase, type ManualBranchDecision, type RepoBaseLockedProof, type RepoBaseProof } from "../sync-git/base-composer.js";
import { prepareFollowerBranchProtocol, type FollowerBranchProtocol } from "../sync-git/follower-protocol.js";
import { settleExactPresentArtifact } from "../sync-git/p-settlement.js";
import { createPRepairStatePort, createPRepairStatePortFromReceipt } from "../sync-git/p-repair-state.js";
import { hasGitResolutionIncoming, sanitizeTerminalText } from "../status-view.js";
import { preliminaryResolutionReport, resolutionBindingIdentity, type ResolutionDiscardReport } from "../sync-git/resolution-intent.js";
import { printShow, printDiscardReport, keepMineConfirmCommand, safeResolveOutput, refusalMessage, type GitResolveShow } from "./resolve-presentation.js";

type GitResolveVerb = "show-me" | "take-theirs" | "keep-mine";

async function strictOwnedBranches(ctx: RepoCtx): Promise<Map<string, string>> {
  const result = await branchesCheckedOutElsewhereStrict(ctx);
  if (result.status === "unreadable") throw result.cause;
  return result.owned;
}

interface ResolveEnvironment {
  cfg: WorkspaceConfig;
  store: BlobStore;
  remote?: SyncRemote;
}

interface ProgressScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

interface GitResolveDeps {
  build?: (root: string) => Promise<ResolveEnvironment>;
  capabilityProbe?: CheckoutCapabilityProbe;
  mutexOptions?: SyncMutexOptions;
  /** Test seam for the closed proof-refusal mapping after a real snapshot. */
  forceProofIndeterminate?: boolean;
  /** Test seam: runs inside checkout-txn's lock-bound second-proof callback. */
  beforeSecondProof?: () => Promise<void>;
  /** Test seam: runs immediately before keep-mine reloads every confirmed input. */
  beforeConfirmRecheck?: () => Promise<void>;
  /** Test seam around the ordinary in-process push pipeline. */
  confirmedPush?: (args: { cfg: WorkspaceConfig; deps: SyncDeps; resolution: import("../sync-git/resolution-intent.js").GitResolutionRider }) => Promise<PushResult>;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Test seam for heartbeat scheduling; production remains ten seconds. */
  progressIntervalMs?: number;
  /** Test seam for proving heartbeat lifecycle without waiting on wall time. */
  progressScheduler?: ProgressScheduler;
}

type HumanReason = Extract<GitDeferralReason,
  "local-edits" | "local-index" | "local-operation" | "local-commits" | "local-stash">;

type SnapshotIdentity = GitResolutionBinding;

interface ResolveSnapshot {
  public: GitResolveShow;
  identity: SnapshotIdentity;
  protectedOids: string[];
  waivedReasons: HumanReason[];
  proofIndeterminate: boolean;
  oracle: AppliedManifestOracle;
}

export type ResolveRefusalCode =
  | "sync-busy" | "proof-indeterminate" | "journal-recovery" | "no-incoming" | "mutex-degraded" | "operation-failed"
  | GitDeferralReason;

type ResolveOutput =
  | GitResolveShow
  | { status: "resolved"; verb: "take-theirs"; repo: string; snapshot: string; quarantine: string }
  | {
      status: "preview";
      verb: "keep-mine";
      repo: string;
      message: string;
      current: GitResolveShow;
      discardReport: ResolutionDiscardReport;
      confirm: { snapshot: string; forceDiscardIncoming: boolean };
    }
  | { status: "snapshot-mismatch"; verb: "take-theirs" | "keep-mine"; repo: string; message: string; current: GitResolveShow; discardReport?: ResolutionDiscardReport }
  | { status: "refused"; verb: GitResolveVerb; repo: string; code: ResolveRefusalCode; message: string; current?: GitResolveShow }
  | { status: "published"; verb: "keep-mine"; repo: string; sequence: number }
  | { status: "ack-uncertain"; verb: "keep-mine"; repo: string; message: string };

function sortedEntries(value: Record<string, string>): Array<[string, string]> {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
}

function snapshotId(identity: SnapshotIdentity): string {
  return hashBytes(Buffer.from(JSON.stringify(identity)));
}

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

function normalizedRepo(root: string, arg: string): string {
  const abs = path.resolve(arg);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) throw new Error("repository is outside this workspace");
  return rel;
}

function incomingFor(record: RepoRecord | undefined): GitSection | undefined {
  if (!hasGitResolutionIncoming(record)) return undefined;
  if (record?.pending) return record.pending;
  return record?.base;
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(sortedEntries(a)) === JSON.stringify(sortedEntries(b));
}

async function buildSnapshot(args: {
  root: string;
  rel: string;
  ctx: RepoCtx;
  state: SyncState;
  record: RepoRecord;
  incoming: GitSection;
  store: BlobStore;
  kek: Buffer;
  cfg: WorkspaceConfig;
  now: Date;
  progress?: (phase: "proving" | "found", count: number) => void;
}): Promise<ResolveSnapshot> {
  const matcher = buildIgnoreMatcher(args.root, {
    respectGitignore: args.cfg.respectGitignore === true,
    knownGitRepos: Object.keys(args.state.lastSyncedManifest.gitRepos ?? {}),
  });
  const oracle = oracleFromState({ base: args.state.lastSyncedManifest, matcher, root: args.root });
  const staged = await stageIncoming({ ctx: args.ctx, incoming: args.incoming, store: args.store, kek: args.kek });
  try {
    const identity = await resolutionBindingIdentity({ ...args, oracle, boundary: false });
    const roots = incomingOwnershipRoots(args.incoming, { prefix: staged.incomingNs, opState: staged.opBytes });
    const candidates = new Map<string, Set<string>>();
    const addCandidate = (oid: string | undefined, label: string) => {
      if (!oid) return;
      const labels = candidates.get(oid) ?? new Set<string>();
      labels.add(label);
      candidates.set(oid, labels);
    };
    for (const [ref, oid] of identity.refs) addCandidate(oid, ref.replace(/^refs\//, ""));
    for (const [ref, oids] of identity.reflogs) for (const oid of oids) addCandidate(oid, `${ref.replace(/^refs\//, "")} reflog`);
    for (const oid of identity.stash) addCandidate(oid, "stash reflog");
    const branch = /^ref:\s*(refs\/\S+)\s*$/.exec(identity.head)?.[1];
    if (!branch) addCandidate(await git(args.ctx.repoDir, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined), "detached HEAD");

    args.progress?.("proving", candidates.size);
    const localOnly: Array<{ oid: string; labels: string[]; subject: string }> = [];
    let proofIndeterminate = identity.index.kind === "indeterminate";
    const partition = await partitionOwnedByIncoming(args.ctx.repoDir, [...candidates.keys()], roots);
    const unowned = partition.filter((entry) => entry.proof.status === "unowned");
    const subjects = new Map<string, string>();
    if (unowned.length > 0) {
      const raw = await git(args.ctx.repoDir, ["log", "--no-walk=unsorted", "--format=%H%x00%s", "--stdin"], {
        env: { GIT_NO_LAZY_FETCH: "1" },
        stdin: unowned.map((entry) => entry.tip).join("\n") + "\n",
      }).catch(() => "");
      for (const line of raw.split("\n")) {
        const separator = line.indexOf("\0");
        if (separator > 0) subjects.set(line.slice(0, separator), line.slice(separator + 1).trim().replace(/[\r\n\t]+/g, " "));
      }
    }
    for (const entry of partition) {
      const { tip: oid, proof } = entry;
      const labels = candidates.get(oid)!;
      if (proof.status === "indeterminate") { proofIndeterminate = true; continue; }
      if (proof.status === "owned") continue;
      const subject = (entry.commit ? subjects.get(entry.commit) : undefined) ?? "unreadable commit";
      localOnly.push({ oid, labels: [...labels].sort(), subject });
    }
    localOnly.sort((a, b) => `${a.labels.join("\0")}\0${a.subject}`.localeCompare(`${b.labels.join("\0")}\0${b.subject}`));

    const oracleVerdict = await oracle.proveRepo(args.rel);
    const oracleClass = oracleVerdict.kind === "match" ? "clean" : oracleVerdict.kind === "mismatch" ? "dirty" : "indeterminate";
    if (oracleVerdict.kind === "indeterminate") proofIndeterminate = true;
    const liveIndex = identity.index.kind === "projected" ? identity.index.value : undefined;
    const incomingHasIndex = staged.candidateIndex !== undefined;
    const indexClass: GitResolveShow["index"] = identity.index.kind === "indeterminate"
      ? "indeterminate"
      : identity.index.kind === "absent" && !incomingHasIndex ? "absent"
      : liveIndex === staged.incomingIndexProjection ? "matches-incoming" : "diverged";
    const liveOp = Object.fromEntries(identity.opState);
    const opDiverged = !sameMap(liveOp, sectionOpState(args.incoming));
    const stashDiverged = args.ctx.kind === "dir" && identity.stash.some((oid) => candidates.has(oid) && localOnly.some((entry) => entry.oid === oid));
    const waived = new Set<HumanReason>();
    if (oracleVerdict.kind === "mismatch") waived.add("local-edits");
    if (indexClass === "diverged") waived.add("local-index");
    if (opDiverged) waived.add("local-operation");
    if (localOnly.length) waived.add("local-commits");
    if (stashDiverged) waived.add("local-stash");
    const deferrals = Object.values(args.record.deferrals ?? {}).filter((value): value is NonNullable<typeof value> => value !== undefined)
      .map((value) => ({
        lane: value.lane,
        reason: value.reason,
        deferredSince: value.deferredSince,
        ageSeconds: Math.max(0, Math.floor((args.now.getTime() - Date.parse(value.deferredSince)) / 1000)),
        ...(value.bytesChanged === undefined ? {} : { bytesChanged: value.bytesChanged }),
      })).sort((a, b) => a.lane.localeCompare(b.lane));
    const id = snapshotId(identity);
    args.progress?.("found", localOnly.length);
    return {
      public: {
        status: "show-me",
        repo: args.rel,
        incomingCheckout: checkoutLabel(args.incoming.head) ?? { kind: "detached" },
        localOnlyCommits: localOnly.map(({ labels, subject }) => ({ labels, subject })),
        oracle: oracleClass,
        index: indexClass,
        operationState: opDiverged ? "diverged" : "matches-incoming",
        stash: args.ctx.kind !== "dir" ? "not-owned" : stashDiverged ? "diverged" : "clean",
        deferrals,
        snapshot: id,
      },
      identity,
      protectedOids: [...new Set([...localOnly.map((entry) => entry.oid), ...identity.stash])].sort(),
      waivedReasons: [...waived],
      proofIndeterminate,
      oracle,
    };
  } finally {
    await staged.cleanup();
  }
}

function emit(output: ResolveOutput, json: boolean, deps: GitResolveDeps, root: string): void {
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  const safe = safeResolveOutput(output, root);
  if (json) {
    out(JSON.stringify(safe, (key, value) => typeof value === "string" && key !== "snapshot"
      ? value.replace(/\b[0-9a-f]{40}\b/gi, "[commit]")
      : value));
    return;
  }
  // Every human-readable field can ultimately contain local repository, ref,
  // worktree, subject, or error text. Sanitize once at the output boundary so
  // future verbs cannot accidentally introduce a terminal-control sink.
  const safeOut = (line: string): void => out(sanitizeTerminalText(line));
  const safeErr = (line: string): void => err(sanitizeTerminalText(line));
  if (safe.status === "show-me") { printShow(safe, safeOut); return; }
  if (safe.status === "resolved") {
    safeOut(`${safe.repo}: followed incoming checkout; local Git state quarantined at ${safe.quarantine}`);
    return;
  }
  if (safe.status === "published") {
    safeOut(`${safe.repo}: published; your repo is the synced truth now (sequence ${safe.sequence}).`);
    return;
  }
  if (safe.status === "ack-uncertain") {
    safeErr(`${safe.repo}: ${safe.message}`);
    return;
  }
  if (safe.status === "preview") {
    printShow(safe.current, safeOut);
    printDiscardReport(safe.discardReport, safeOut);
    safeOut(safe.message);
    safeOut(`Confirm exactly this preview with: ${keepMineConfirmCommand(safe.repo, safe.confirm.snapshot, safe.confirm.forceDiscardIncoming)}`);
    return;
  }
  safeErr(`${safe.repo}: ${safe.message}`);
  if (safe.status === "snapshot-mismatch" && safe.discardReport) printDiscardReport(safe.discardReport, safeErr);
  if (safe.current) printShow(safe.current, safeErr);
}

async function defaultBuild(root: string): Promise<ResolveEnvironment> {
  const built = await buildAuthedRemote(root);
  return { cfg: built.cfg, store: built.remote.blobStore(), remote: built.remote };
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

type ManualProtocolPreflight =
  | { status: "ready"; state: SyncState; record: RepoRecord; incoming: GitSection; protocol: FollowerBranchProtocol }
  | { status: "hold"; reason: string };

/** A confirmation snapshot is never taken while exact P authority stands. */
async function preflightManualPresentArtifacts(args: {
  root: string;
  rel: string;
  ctx: RepoCtx;
  state: SyncState;
  incoming?: GitSection;
}): Promise<ManualProtocolPreflight> {
  let state = args.state;
  for (let pass = 0; pass < 8; pass++) {
    const record = repoRecordsForState(state)[args.rel];
    const incoming = args.incoming ?? incomingFor(record);
    if (!record || !incoming) return { status: "hold", reason: "deferred incoming state disappeared during manual preflight" };
    let compacted = false;
    for (const [ref, receipt] of Object.entries(record.partial?.pRepaired ?? {})) {
      const inspected = await inspectLockedPRepairReceipt(args.ctx.repoDir, receipt);
      if (inspected.action === "compact-and-restart") {
        const port = createPRepairStatePortFromReceipt({
          root: args.root, stream: state.stream, relPath: args.rel, repoKind: args.ctx.kind,
          effectiveRefScope: record.base?.refScope ?? incoming.refScope, receipt,
        });
        const snapshot = await port.read();
        if (await persistPRepairTerminal(port, "compact", snapshot, receipt) !== "accepted") {
          return { status: "hold", reason: `P-repair terminal receipt CAS rejected for ${ref}` };
        }
        state = await loadState(args.root, state.stream);
        compacted = true;
        break;
      }
      if (inspected.action === "corruption-hold" || inspected.action === "artifact-contradiction-hold") {
        return { status: "hold", reason: `P-repair terminal inspection refused ${ref}: ${inspected.action}` };
      }
    }
    if (compacted) continue;
    const liveRefs = await readAllRefs(args.ctx.repoDir);
    const prepared = await prepareFollowerBranchProtocol({
      workspaceRoot: args.root, relPath: args.rel, state, ctx: args.ctx, record,
      base: record.base, incoming, liveRefs,
    });
    if (prepared.status === "hold") return prepared;
    for (const ref of new Set([...Object.keys(record.base?.refs ?? {}), ...Object.keys(incoming.refs), ...Object.keys(liveRefs)])) {
      if (!ref.startsWith("refs/heads/")) continue;
      const changesProtectedBase = (record.base?.refs[ref] ?? null) !== (incoming.refs[ref] ?? null);
      const changesPhysicalRef = (liveRefs[ref] ?? null) !== (incoming.refs[ref] ?? null);
      const disposition = prepared.protocol.artifacts[ref];
      const foreign = disposition?.absence === "active-foreign" || disposition?.present === "active-foreign"
        || disposition?.settledAbsence === "active-foreign" || disposition?.keeps === "mismatched";
      if (foreign && (changesProtectedBase || changesPhysicalRef)) {
        return { status: "hold", reason: `foreign BASE artifact vetoes confirmed mutation of ${ref}` };
      }
    }
    const p = prepared.protocol.presentArtifacts[0];
    if (!p) return { status: "ready", state, record, incoming, protocol: prepared.protocol };
    const exact = await settleExactPresentArtifact({
      root: args.root, stream: state.stream, state, relPath: args.rel, ctx: args.ctx,
      binding: prepared.protocol.binding, p,
    });
    if (exact.status === "settled") { state = exact.state; continue; }
    if (exact.status === "absent") {
      const reloaded = await loadState(args.root, state.stream);
      state = reloaded;
      continue;
    }
    if (exact.status === "moved") {
      const port = createPRepairStatePort({
        root: args.root, stream: state.stream, relPath: args.rel, repoKind: args.ctx.kind,
        effectiveRefScope: record.base?.refScope ?? incoming.refScope, p,
      });
      const disposition = prepared.protocol.artifacts[p.payload.ref];
      const validateArtifacts = async (): Promise<boolean> => {
        const fresh = await readBasePresentArtifact(args.ctx.repoDir, prepared.protocol.binding, p.payload.ref);
        return fresh.status === "valid" && fresh.artifact.targetOid === p.targetOid
          && disposition?.present === "valid-owning" && disposition.keeps === "exact"
          && disposition.absence === "absent" && disposition.settledAbsence === "absent";
      };
      const accepted = record.partial?.pRepaired?.[p.payload.ref];
      const repaired = accepted
        ? await resumeLockedAcceptedPRepair({ repoDir: args.ctx.repoDir, receipt: accepted, validateArtifacts }).then(async (resumed) =>
            resumed.status === "refresh-receipt"
              ? refreshLockedAcceptedPRepair({
                  repoDir: args.ctx.repoDir, p, state: port, repairAt: new Date().toISOString(), acceptedReceipt: accepted,
                  mismatches: { live: exact.reason === "live", reflog: exact.reason === "reflog", baseShape: exact.reason === "base-shape" },
                  validateArtifacts,
                })
              : resumed.status === "restart" ? { status: "restart" as const } : { status: "hold" as const, reason: resumed.reason })
        : await runLockedPRepairAttempt({
            repoDir: args.ctx.repoDir, p, state: port, repairAt: new Date().toISOString(),
            mismatches: { live: exact.reason === "live", reflog: exact.reason === "reflog", baseShape: exact.reason === "base-shape" },
            validateArtifacts,
          });
      if (repaired.status === "hold") return { status: "hold", reason: repaired.reason };
      state = await loadState(args.root, state.stream);
      continue;
    }
    return { status: "hold", reason: exact.reason };
  }
  return { status: "hold", reason: "P settlement did not stabilize before confirmation" };
}

async function settleCommittedManualPresentArtifacts(args: {
  root: string;
  rel: string;
  ctx: RepoCtx;
  state: SyncState;
  incoming: GitSection;
}): Promise<{ state: SyncState; error?: string }> {
  const preflight = await preflightManualPresentArtifacts({ ...args, incoming: args.incoming });
  if (preflight.status === "hold") return { state: args.state, error: preflight.reason };
  for (const [ref, disposition] of Object.entries(preflight.protocol.artifacts)) {
    if (disposition.absence === "valid-owning") {
      await settleBaseAbsentArtifact(args.ctx.repoDir, preflight.protocol.binding, ref);
    }
  }
  return { state: preflight.state };
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
  const confirmedKeepMine = verb === "keep-mine" && options.confirm !== undefined;
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
      emit({ status: "refused", verb, repo: rel, code: "journal-recovery", message: "journal recovery could not complete; retry after Git state settles, or inspect the local recovery copy" }, json, deps, root);
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
      let discardReport = await preliminaryResolutionReport({ ctx, pending: incoming, binding: snapshot.identity, store: env.store, kek: env.cfg.kek });
      if (snapshot.proofIndeterminate || deps.forceProofIndeterminate === true || discardReport.lanes.some((lane) => lane.disposition === "indeterminate")) {
        emit({ status: "refused", verb, repo: rel, code: "proof-indeterminate", message: "the incoming-versus-local comparison could not complete; retry after Git state settles", current: snapshot.public }, json, deps, root);
        return 1;
      }
      const strictRefs = await readAllRefsStrict(ctx!.repoDir);
      if (strictRefs.status === "unreadable") {
        emit({ status: "refused", verb, repo: rel, code: "proof-indeterminate", message: refusalMessage("ref-read-unreadable") }, json, deps, root);
        return 1;
      }
      const localRefs = new Map(Object.entries(strictRefs.refs));
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
        && localRefs.get(ref) === undefined
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
        && localRefs.has(lane.lane.slice("branch:".length)));
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
        discardReport = await preliminaryResolutionReport({ ctx, pending: incoming, binding: snapshot.identity, store: env.store, kek: env.cfg.kek });
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
      discardReport = await preliminaryResolutionReport({ ctx, pending: incoming, binding: snapshot.identity, store: env.store, kek: env.cfg.kek });
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
            store: env.store, kek: env.cfg.kek, cfg: env.cfg, now: now(),
          });
          const freshReport = await preliminaryResolutionReport({ ctx: freshCtx, pending: freshIncoming, binding: fresh.identity, store: env.store, kek: env.cfg.kek });
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
      if (!branchProtocol) throw new Error("manual lineage proof unavailable");
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
      if (composed.disposition !== "terminal") throw new Error("manual BASE proof is incomplete");
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
    const confirmedIdentity = JSON.stringify(snapshot.identity);
    const binding = await checkoutJournalBinding(state.stream, expectedStateNonce(state), ctx);
    const follow = await followDivergedRepo({
      workspaceRoot: root,
      relPath: rel,
      ctx,
      base: record.base,
      incoming,
      store: env.store,
      kek: env.cfg.kek,
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
        const fresh = await buildSnapshot({ root, rel, ctx, state: freshState, record: freshRecord, incoming: freshIncoming, store: env.store, kek: env.cfg.kek, cfg: env.cfg, now: now() });
        emit({ status: "snapshot-mismatch", verb, repo: rel, message: "snapshot changed at the locked checkout boundary; confirm the fresh snapshot", current: fresh.public }, json, deps, root);
      } else {
        emit({ status: "refused", verb, repo: rel, code: follow.reason, message: refusalMessage(follow.reason) }, json, deps, root);
      }
      return 1;
    }
    if (Object.keys(follow.heldRefs).length || !intended) throw new Error("manual resolution published an incomplete checkout");
    const landed = await recoverAndLandFollowJournal(root, rel, binding, state);
    if (landed.recovery.status !== "keep") throw new Error("published checkout journal could not be recovered");
    const pSettled = await settleCommittedManualPresentArtifacts({ root, rel, ctx, state: landed.state, incoming });
    if (pSettled.error) throw new Error(pSettled.error);
    emit({ status: "resolved", verb, repo: rel, snapshot: snapshot.public.snapshot, quarantine }, json, deps, root);
    return 0;
  }, mutexOptions);
  return run.catch((error) => {
    const busy = error instanceof WorkspaceSyncBusyError;
    const timedOut = error instanceof WorkspaceSyncTimeoutError;
    emit({
      status: "refused",
      verb,
      repo: rel,
      code: busy || timedOut ? "sync-busy" : "operation-failed",
      message: timedOut ? "timed out waiting for the current sync cycle to finish; try again"
        : busy ? "daemon/CLI is syncing; retry, or run `rbox stop` first"
        : "the Git resolution could not complete safely; no confirmation can be reused",
    }, json, deps, root);
    return 1;
  });
}
