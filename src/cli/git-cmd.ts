import fs from "node:fs/promises";
import path from "node:path";
import {
  assertGitTargetWithinRoot,
  buildIgnoreMatcher,
  enumerateStashReflogOids,
  incomingOwnershipRoots,
  indexIdentityV2,
  oracleFromState,
  tipOwnedByIncoming,
  type AppliedManifestOracle,
  type BlobStore,
  type CheckoutCapabilityProbe,
  type GitSection,
} from "../engine/index.js";
import { enumerateRefReflogOids, pinDisplaced } from "../engine/git/keep-pins.js";
import { quarantineLocal } from "../engine/git/quarantine.js";
import { readAllRefs, readOpState } from "../engine/git/refs.js";
import { exists, git, repoCtx, type RepoCtx } from "../engine/git/shared.js";
import { hashBytes, hashFile } from "../engine/hash.js";
import {
  expectedStateNonce,
  loadState,
  repoRecordsForState,
  syncStreamId,
  type GitDeferralReason,
  type RepoRecord,
  type RepoRecordInput,
  type SyncState,
  type WorkspaceConfig,
} from "./config.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { inputRecord } from "./sync-state.js";
import { withWorkspaceSyncMutex, workspaceSyncMutexDegraded } from "./sync-mutex.js";
import {
  checkoutJournalBinding,
  followDivergedRepo,
  quarantineUnboundFollowJournal,
  recoverAndLandFollowJournal,
  stageIncoming,
  type FollowIntended,
  type FollowProgress,
} from "./sync-git/follow.js";
import { checkoutLabel, gitIncomingKey, repoDirOf, sectionOpState } from "./sync-git/shared.js";
import { sanitizeTerminalText } from "./status-view.js";

export type GitResolveVerb = "show-me" | "take-theirs" | "keep-mine";

interface ResolveEnvironment {
  cfg: WorkspaceConfig;
  store: BlobStore;
}

export interface GitResolveDeps {
  build?: (root: string) => Promise<ResolveEnvironment>;
  capabilityProbe?: CheckoutCapabilityProbe;
  /** Test seam: runs inside checkout-txn's lock-bound second-proof callback. */
  beforeSecondProof?: () => Promise<void>;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

type HumanReason = Extract<GitDeferralReason,
  "local-edits" | "local-index" | "local-operation" | "local-commits" | "local-stash">;

interface SnapshotIdentity {
  stream: string;
  stateNonce: string;
  incomingKey: string;
  repoGen: number;
  refs: Array<[string, string]>;
  reflogs: Array<[string, string[]]>;
  head: string;
  index: { kind: "absent" | "indeterminate" | "projected"; value?: string };
  opState: Array<[string, string]>;
  stash: string[];
  oracleReceipt: string | null;
}

export interface GitResolveShow {
  status: "show-me";
  repo: string;
  incomingCheckout: { kind: "branch" | "detached"; label?: string };
  localOnlyCommits: Array<{ labels: string[]; subject: string }>;
  oracle: "clean" | "dirty" | "indeterminate";
  index: "matches-incoming" | "diverged" | "absent" | "indeterminate";
  operationState: "matches-incoming" | "diverged";
  stash: "clean" | "diverged" | "not-owned";
  deferrals: Array<{ lane: string; reason: string; deferredSince: string; ageSeconds: number; bytesChanged?: boolean }>;
  snapshot: string;
}

interface ResolveSnapshot {
  public: GitResolveShow;
  identity: SnapshotIdentity;
  protectedOids: string[];
  waivedReasons: HumanReason[];
  proofIndeterminate: boolean;
  oracle: AppliedManifestOracle;
}

type ResolveOutput =
  | GitResolveShow
  | { status: "resolved"; verb: "take-theirs"; repo: string; snapshot: string; quarantine: string }
  | { status: "snapshot-mismatch"; verb: "take-theirs"; repo: string; message: string; current: GitResolveShow }
  | { status: "refused"; verb: GitResolveVerb; repo: string; code: string; message: string; current?: GitResolveShow }
  | { status: "unsupported"; verb: "keep-mine"; repo: string; code: "not-yet-supported"; message: string; recovery: string[] };

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
  if (record?.pending) return record.pending;
  if (record?.resolutionKey || record?.deferrals?.apply) return record?.base;
  return undefined;
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(sortedEntries(a)) === JSON.stringify(sortedEntries(b));
}

async function snapshotIdentityOnly(args: {
  root: string;
  rel: string;
  ctx: RepoCtx;
  state: SyncState;
  record: RepoRecord;
  incoming: GitSection;
  oracle: AppliedManifestOracle;
  boundary: boolean;
}): Promise<SnapshotIdentity> {
  const { rel, ctx, state, record, incoming, oracle } = args;
  const refs = await readAllRefs(ctx.repoDir);
  const reflogs: Array<[string, string[]]> = [];
  for (const ref of Object.keys(refs).filter((ref) => ref !== "refs/stash").sort()) {
    reflogs.push([ref, (await enumerateRefReflogOids(ctx.repoDir, ref)).sort()]);
  }
  const head = await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8");
  const indexPath = path.join(ctx.gitDir, "index");
  const indexPresent = await exists(indexPath);
  const indexProjection = indexPresent ? await indexIdentityV2(ctx.repoDir, indexPath) : undefined;
  const index: SnapshotIdentity["index"] = !indexPresent
    ? { kind: "absent" }
    : indexProjection === undefined ? { kind: "indeterminate" } : { kind: "projected", value: indexProjection };
  const opState = await readOpState(ctx.gitDir, hashFile);
  const stash = ctx.kind === "dir" ? (await enumerateStashReflogOids(ctx.repoDir)).sort() : [];
  if (args.boundary) await oracle.reproveRepo(rel); else await oracle.proveRepo(rel);
  return {
    stream: state.stream,
    stateNonce: expectedStateNonce(state),
    incomingKey: gitIncomingKey(incoming),
    repoGen: record.repoGen,
    refs: sortedEntries(refs),
    reflogs,
    head,
    index,
    opState: sortedEntries(opState),
    stash,
    oracleReceipt: oracle.receiptHash(rel) ?? null,
  };
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
}): Promise<ResolveSnapshot> {
  const matcher = buildIgnoreMatcher(args.root, {
    respectGitignore: args.cfg.respectGitignore === true,
    knownGitRepos: Object.keys(args.state.lastSyncedManifest.gitRepos ?? {}),
  });
  const oracle = oracleFromState({ base: args.state.lastSyncedManifest, matcher, root: args.root });
  const staged = await stageIncoming({ ctx: args.ctx, incoming: args.incoming, store: args.store, kek: args.kek });
  try {
    const identity = await snapshotIdentityOnly({ ...args, oracle, boundary: false });
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

    const localOnly: Array<{ oid: string; labels: string[]; subject: string }> = [];
    let proofIndeterminate = identity.index.kind === "indeterminate";
    for (const [oid, labels] of candidates) {
      const proof = await tipOwnedByIncoming(args.ctx.repoDir, oid, roots);
      if (proof.status === "indeterminate") { proofIndeterminate = true; continue; }
      if (proof.status === "owned") continue;
      const subject = (await git(args.ctx.repoDir, ["log", "-1", "--format=%s", oid]).catch(() => "unreadable commit"))
        .replace(/[\r\n\t]+/g, " ");
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

function printShow(show: GitResolveShow, write: (line: string) => void): void {
  const checkout = show.incomingCheckout.kind === "branch" ? `branch ${show.incomingCheckout.label}` : "detached checkout";
  write(`${show.repo}: incoming ${checkout}`);
  write(`  oracle: ${show.oracle}; index: ${show.index}; operation state: ${show.operationState}; stash: ${show.stash}`);
  if (show.localOnlyCommits.length === 0) write("  local-only commits: none");
  else for (const commit of show.localOnlyCommits) write(`  local-only ${commit.labels.join(", ")}: ${commit.subject}`);
  for (const d of show.deferrals) write(`  ${d.lane} deferred (${d.reason}) since ${d.deferredSince}${d.bytesChanged ? "; working bytes changed" : ""}`);
  write(`  snapshot: ${show.snapshot}`);
}

function emit(output: ResolveOutput, json: boolean, deps: GitResolveDeps): void {
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  if (json) {
    out(JSON.stringify(output, (key, value) => typeof value === "string" && key !== "snapshot"
      ? value.replace(/\b[0-9a-f]{40}\b/gi, "[commit]")
      : value));
    return;
  }
  // Every human-readable field can ultimately contain local repository, ref,
  // worktree, subject, or error text. Sanitize once at the output boundary so
  // future verbs cannot accidentally introduce a terminal-control sink.
  const safeOut = (line: string): void => out(sanitizeTerminalText(line));
  const safeErr = (line: string): void => err(sanitizeTerminalText(line));
  if (output.status === "show-me") { printShow(output, safeOut); return; }
  if (output.status === "resolved") {
    safeOut(`${output.repo}: followed incoming checkout; local Git state quarantined at ${output.quarantine}`);
    return;
  }
  if (output.status === "unsupported") {
    safeErr(`${output.repo}: keep-mine is not yet supported in this build.`);
    for (const line of output.recovery) safeErr(`  ${line}`);
    return;
  }
  safeErr(`${output.repo}: ${output.message}`);
  if (output.current) printShow(output.current, safeErr);
}

function refusalMessage(reason: GitDeferralReason, detail: string): string {
  if (reason === "worktree-ownership") return detail;
  const messages: Partial<Record<GitDeferralReason, string>> = {
    artifact: "incoming Git artifacts could not be fetched and verified",
    unreadable: "Git metadata could not be read completely",
    unsupported: "this repository shape or Git version cannot perform the journaled checkout",
    "git-busy": "Git became busy during resolution; retry after the other Git operation finishes",
    containment: "the repository containment proof failed",
  };
  return messages[reason] ?? "the confirmed checkout could not be published safely";
}

async function defaultBuild(root: string): Promise<ResolveEnvironment> {
  const built = await buildAuthedRemote(root);
  return { cfg: built.cfg, store: built.remote.blobStore() };
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

export async function gitResolveCmd(
  root: string,
  repoArg: string,
  verb: GitResolveVerb = "show-me",
  options: { json?: boolean; confirm?: string; forceDiscardIncoming?: boolean } = {},
  deps: GitResolveDeps = {},
): Promise<number> {
  const rel = normalizedRepo(root, repoArg);
  const json = options.json === true;
  const now = deps.now ?? (() => new Date());
  const run = withWorkspaceSyncMutex(root, async (mutex) => {
    const env = await (deps.build ?? defaultBuild)(root);
    let state = await loadState(root, syncStreamId(env.cfg));
    const repoDir = repoDirOf(root, rel);
    const ctx = await repoCtx(repoDir).catch(() => undefined);
    const recovered = await recoverFirst(root, rel, ctx, state);
    state = recovered.state;
    if (recovered.error || !ctx) {
      emit({ status: "refused", verb, repo: rel, code: "journal-recovery", message: recovered.error ?? "repository is unavailable" }, json, deps);
      return 1;
    }

    if (verb === "keep-mine") {
      const recovery = [
        "Run `rbox git resolve <repo> show-me` to inspect the incoming and local work.",
        "Use `take-theirs --confirm <snapshot>` to preserve local Git state and follow incoming.",
        "Otherwise merge/publish the local work manually, then let normal sync clear the deferral.",
      ];
      emit({
        status: "unsupported",
        verb,
        repo: rel,
        code: "not-yet-supported",
        message: "keep-mine is not yet supported in this build",
        recovery: options.forceDiscardIncoming
          ? [...recovery, "`--force-discard-incoming` cannot bypass this build-time safety boundary."]
          : recovery,
      }, json, deps);
      return 1;
    }

    await assertGitTargetWithinRoot(root, rel);
    const record = repoRecordsForState(state)[rel];
    const incoming = incomingFor(record);
    if (!record || !incoming || !env.cfg.kek) {
      emit({ status: "refused", verb, repo: rel, code: "no-incoming", message: "no deferred incoming Git state is available for this repository" }, json, deps);
      return 1;
    }
    const takeSnapshot = () => buildSnapshot({
      root, rel, ctx, state, record, incoming, store: env.store, kek: env.cfg.kek!, cfg: env.cfg, now: now(),
    });
    let snapshot = await takeSnapshot();
    if (verb === "show-me") {
      emit(snapshot.public, json, deps);
      return 0;
    }
    if (snapshot.proofIndeterminate) {
      emit({ status: "refused", verb, repo: rel, code: "indeterminate", message: "Git state could not be proven completely; no metadata was changed", current: snapshot.public }, json, deps);
      return 1;
    }
    if (!options.confirm || options.confirm !== snapshot.public.snapshot) {
      emit({
        status: "snapshot-mismatch",
        verb,
        repo: rel,
        message: options.confirm ? "snapshot changed; review the fresh summary and confirm again" : "--confirm <snapshot> is required",
        current: snapshot.public,
      }, json, deps);
      return 1;
    }
    if (workspaceSyncMutexDegraded(mutex)) {
      emit({ status: "refused", verb, repo: rel, code: "mutex-degraded", message: "workspace synchronization lock is degraded; refusing metadata mutation" }, json, deps);
      return 1;
    }

    // Confirmation is checked again immediately before the first mutation.
    snapshot = await takeSnapshot();
    if (options.confirm !== snapshot.public.snapshot) {
      emit({ status: "snapshot-mismatch", verb, repo: rel, message: "snapshot changed before resolution began; confirm the fresh snapshot", current: snapshot.public }, json, deps);
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
    const makeIntended = (progress: FollowProgress): FollowIntended => {
      const next: RepoRecordInput = { ...previousRecord, sourceSeq: Math.max(record.sourceSeq, state.lastSyncedSequence), base: incoming };
      delete next.pending;
      delete next.resolutionKey;
      delete next.partial;
      delete next.idxProj;
      const deferrals = { ...(next.deferrals ?? {}) };
      delete deferrals.apply;
      if (Object.keys(deferrals).length) next.deferrals = deferrals; else delete next.deferrals;
      if (progress.incomingIndexProjection !== undefined) next.idxProj = progress.incomingIndexProjection;
      intended = { record: next, expectedRepoGen: record.repoGen, relPath: rel, previousRecord };
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
          const currentIdentity = await snapshotIdentityOnly({
            root, rel, ctx, state: currentState, record: currentRecord, incoming: currentIncoming, oracle: snapshot.oracle, boundary: true,
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
        emit({ status: "snapshot-mismatch", verb, repo: rel, message: "snapshot changed at the locked checkout boundary; confirm the fresh snapshot", current: fresh.public }, json, deps);
      } else {
        emit({ status: "refused", verb, repo: rel, code: follow.reason, message: refusalMessage(follow.reason, follow.detail) }, json, deps);
      }
      return 1;
    }
    if (Object.keys(follow.heldRefs).length || !intended) throw new Error("manual resolution published an incomplete checkout");
    const landed = await recoverAndLandFollowJournal(root, rel, binding, state);
    if (landed.recovery.status !== "keep") throw new Error("published checkout journal could not be recovered");
    emit({ status: "resolved", verb, repo: rel, snapshot: snapshot.public.snapshot, quarantine }, json, deps);
    return 0;
  });
  return run.catch(() => {
    emit({ status: "refused", verb, repo: rel, code: "operation-failed", message: "the Git resolution could not complete safely; no confirmation can be reused" }, json, deps);
    return 1;
  });
}
