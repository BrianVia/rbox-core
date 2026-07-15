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
  DEFERRAL_LANES,
  loadConfig,
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
import { withWorkspaceSyncMutex, WorkspaceSyncBusyError, workspaceSyncMutexDegraded, type SyncMutexOptions } from "./sync-mutex.js";
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
import { ageBucket, hasGitResolutionIncoming, projectGitDeferralRepos, sanitizeTerminalText, type GitDeferralRepoProjection } from "./status-view.js";
import { serializeGitDeferralLanes } from "./git-deferral-json.js";
import { shQuote } from "./shell-quote.js";
import { RBOX_VERSION } from "./version.js";

type GitResolveVerb = "show-me" | "take-theirs" | "keep-mine";

interface ResolveEnvironment {
  cfg: WorkspaceConfig;
  store: BlobStore;
}

interface GitResolveDeps {
  build?: (root: string) => Promise<ResolveEnvironment>;
  capabilityProbe?: CheckoutCapabilityProbe;
  mutexOptions?: SyncMutexOptions;
  /** Test seam for the closed proof-refusal mapping after a real snapshot. */
  forceProofIndeterminate?: boolean;
  /** Test seam: runs inside checkout-txn's lock-bound second-proof callback. */
  beforeSecondProof?: () => Promise<void>;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface GitDeferralsCmdDeps {
  now?: () => Date;
  version?: string;
  /** Injection proves the brief never consults or renders host identity. */
  hostname?: string;
  loadConfig?: typeof loadConfig;
  loadState?: typeof loadState;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface GitDeferralsCmdOptions {
  brief?: boolean;
  json?: boolean;
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

export type ResolveRefusalCode =
  | "sync-busy" | "proof-indeterminate" | "journal-recovery" | "no-incoming" | "mutex-degraded" | "operation-failed"
  | GitDeferralReason;

type ResolveOutput =
  | GitResolveShow
  | { status: "resolved"; verb: "take-theirs"; repo: string; snapshot: string; quarantine: string }
  | { status: "snapshot-mismatch"; verb: "take-theirs"; repo: string; message: string; current: GitResolveShow }
  | { status: "refused"; verb: GitResolveVerb; repo: string; code: ResolveRefusalCode; message: string; current?: GitResolveShow }
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
  if (!hasGitResolutionIncoming(record)) return undefined;
  if (record?.pending) return record.pending;
  return record?.base;
}

function displayField(value: string): string {
  return value
    .replace(/[\r\n\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function briefField(value: string): string {
  return displayField(value)
    .replace(/([\\`*_\[\]<>|#])/g, "\\$1");
}

function checkoutBrief(checkout: GitDeferralRepoProjection["checkout"]): string {
  if (!checkout) return "checkout unavailable";
  if (checkout.kind === "detached") return "detached checkout";
  return checkout.label ? `branch ${briefField(checkout.label)}` : "branch (label unavailable)";
}

function remediationLines(repo: GitDeferralRepoProjection): string[] {
  const lines = [`Diagnosis: ${briefField(repo.reasonText)}`, `Repair: ${briefField(repo.repairText)}`];
  if (repo.remediationClass === "transient") {
    lines.push("Let normal sync retry while the repository is quiet. If both ages keep growing, inspect `rbox status` and the daemon logs.");
  } else if (repo.remediationClass === "capture") {
    lines.push("Make the repository quiet and readable so normal push capture can retry. Persistent failures require Git/version/repository-shape repair; resolver commands do not apply.");
  } else if (repo.remediationClass === "config") {
    lines.push("Normal sync keeps carrying the previous safe config. Use daemon logs to distinguish a transient read failure from publication-disabled config; resolver commands do not apply.");
  } else if (repo.remediationClass === "apply-unavailable") {
    lines.push("The resolver has no deferred incoming state. Let sync fetch or rebuild it; inspect `rbox status` and daemon logs if this persists.");
  }
  if (shouldOfferResolve(repo)) {
    lines.push("An incoming apply state is available. `keep-mine` is unavailable.");
    lines.push("`take-theirs` quarantines and reflog-pins local Git state and does not rewrite working files. First inspect the fresh snapshot, then substitute its token in the confirmation command:");
  }
  return lines;
}

function shouldOfferResolve(repo: GitDeferralRepoProjection): boolean {
  return repo.canResolve && (repo.displayLane === "apply" || repo.remediationClass === "transient");
}

function resolveCommand(root: string, repo: string, token?: string): string {
  const repoArg = repo.startsWith("-") ? `./${repo}` : repo;
  const argv = token === undefined
    ? ["rbox", "git", "resolve", repoArg]
    : ["rbox", "git", "resolve", repoArg, "take-theirs", "--confirm", token];
  return `cd ${shQuote(root)} && ${argv.map(shQuote).join(" ")}`;
}

/** Render the repo-level deferral list, complete fix brief, or raw lane JSON. */
export async function gitDeferralsCmd(
  root: string,
  options: GitDeferralsCmdOptions = {},
  deps: GitDeferralsCmdDeps = {},
): Promise<number> {
  const write = deps.stdout ?? console.log;
  const writeError = deps.stderr ?? console.error;
  try {
    const cfg = await (deps.loadConfig ?? loadConfig)(root);
    const state = await (deps.loadState ?? loadState)(root, syncStreamId(cfg));
    const records = repoRecordsForState(state);
    const laneEntries = Object.entries(records).flatMap(([repo, record]) =>
      Object.values(record.deferrals ?? {}).flatMap((deferral) => deferral ? [{ repo, deferral, record }] : [])
    ).sort((a, b) => Date.parse(a.deferral.deferredSince) - Date.parse(b.deferral.deferredSince)
      || a.repo.localeCompare(b.repo)
      || DEFERRAL_LANES.indexOf(a.deferral.lane) - DEFERRAL_LANES.indexOf(b.deferral.lane));
    const now = (deps.now ?? (() => new Date()))();
    if (options.json) {
      write(JSON.stringify({
        schemaVersion: 1,
        deferrals: serializeGitDeferralLanes(laneEntries, now.getTime()),
      }));
      return 0;
    }
    const repos = projectGitDeferralRepos(laneEntries, now.getTime());
    if (!options.brief) {
      if (!repos.length) write("no deferred repos");
      for (const repo of repos) {
        write(`${displayField(repo.repo)} — ${displayField(repo.reasonLabel)} · deferred ${ageBucket(repo.oldestDeferredSince, now.getTime())} · reason ${ageBucket(repo.reasonSince, now.getTime())}`);
      }
      return 0;
    }

    const version = deps.version ?? RBOX_VERSION;
    write("contains local repo paths and branch names — share accordingly");
    write("");
    write(`Workspace root: ${briefField(path.resolve(root))}`);
    write(`rbox version: ${briefField(version)}`);
    write(`Rendered at: ${now.toISOString()}`);
    write(`Deferred repos: ${repos.length}`);
    for (const repo of repos) {
      write("");
      write(`## ${briefField(repo.repo)}`);
      write(`Deferred for ${ageBucket(repo.oldestDeferredSince, now.getTime())} · current reason ${briefField(repo.reasonLabel)} since ${ageBucket(repo.reasonSince, now.getTime())}`);
      write(`Checkout: ${checkoutBrief(repo.checkout)}`);
      if (repo.alsoDeferred) write(briefField(repo.alsoDeferred));
      for (const line of remediationLines(repo)) write(line);
      if (shouldOfferResolve(repo)) {
        write(resolveCommand(path.resolve(root), repo.repo));
        write(resolveCommand(path.resolve(root), repo.repo, "<token-printed-by-show-me>"));
      }
    }
    write("");
    write(`-- end of brief · ${repos.length} repo(s)`);
    return 0;
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
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

export function safeResolveText(value: string, root: string): string {
  let out = sanitizeTerminalText(value.replace(/[\r\n\p{Cc}]+/gu, " "));
  const normalizedRoot = path.resolve(root).split(path.sep).join("/");
  out = out.split(path.resolve(root)).join(".").split(normalizedRoot).join(".");
  out = out.replace(/\b(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@");
  out = out.replace(/\b(authorization|bearer|access[_-]?token|api[_-]?key|password|secret)\b(?:\s*[:=]\s*|\s+)[^\s,;]+/gi, "$1 [redacted]");
  return out.replace(/\s+/g, " ").trim();
}

function safeResolveOutput<T>(value: T, root: string): T {
  if (typeof value === "string") return safeResolveText(value, root) as T;
  if (Array.isArray(value)) return value.map((entry) => safeResolveOutput(entry, root)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeResolveOutput(entry, root)])) as T;
  }
  return value;
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
  if (safe.status === "unsupported") {
    safeErr(`${safe.repo}: keep-mine is not yet supported in this build.`);
    for (const line of safe.recovery) safeErr(`  ${line}`);
    return;
  }
  safeErr(`${safe.repo}: ${safe.message}`);
  if (safe.current) printShow(safe.current, safeErr);
}

function refusalMessage(reason: GitDeferralReason): string {
  const messages: Record<GitDeferralReason, string> = {
    "local-edits": "local edits prevent the confirmed checkout from being published safely",
    "local-index": "local index changes prevent the confirmed checkout from being published safely",
    "local-operation": "a local Git operation prevents the confirmed checkout from being published safely",
    "local-commits": "local commits changed while the checkout was being confirmed",
    "local-stash": "the local stash changed while the checkout was being confirmed",
    conflict: "the confirmed checkout still conflicts with local Git state",
    artifact: "incoming Git artifacts could not be fetched and verified",
    unreadable: "Git metadata could not be read completely",
    unsupported: "this repository shape or Git version cannot perform the journaled checkout",
    "git-busy": "Git became busy during resolution; retry after the other Git operation finishes",
    containment: "the repository containment proof failed",
    "worktree-ownership": "another worktree owns a ref required by the confirmed checkout",
    "ignored-target": "the confirmed checkout targets an ignored repository",
    config: "Git configuration could not be published safely",
    other: "the confirmed checkout could not be published safely",
  };
  return messages[reason];
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
  const json = options.json === true;
  let rel = ".";
  try {
    rel = normalizedRepo(root, repoArg);
  } catch {
    emit({ status: "refused", verb, repo: rel, code: "operation-failed", message: "the Git resolution could not complete safely; no confirmation can be reused" }, json, deps, root);
    return 1;
  }
  const now = deps.now ?? (() => new Date());
  const run = withWorkspaceSyncMutex(root, async (mutex) => {
    const env = await (deps.build ?? defaultBuild)(root);
    let state = await loadState(root, syncStreamId(env.cfg));
    const repoDir = repoDirOf(root, rel);
    const ctx = await repoCtx(repoDir).catch(() => undefined);
    const recovered = await recoverFirst(root, rel, ctx, state);
    state = recovered.state;
    if (recovered.error || !ctx) {
      emit({ status: "refused", verb, repo: rel, code: "journal-recovery", message: "journal recovery could not complete; retry after Git state settles, or inspect the local recovery copy" }, json, deps, root);
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
      }, json, deps, root);
      return 1;
    }

    await assertGitTargetWithinRoot(root, rel);
    const record = repoRecordsForState(state)[rel];
    const incoming = incomingFor(record);
    if (!record || !incoming || !env.cfg.kek) {
      emit({ status: "refused", verb, repo: rel, code: "no-incoming", message: "no deferred incoming Git state is available for this repository" }, json, deps, root);
      return 1;
    }
    const takeSnapshot = () => buildSnapshot({
      root, rel, ctx, state, record, incoming, store: env.store, kek: env.cfg.kek!, cfg: env.cfg, now: now(),
    });
    let snapshot = await takeSnapshot();
    if (verb === "show-me") {
      emit(snapshot.public, json, deps, root);
      return 0;
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
        emit({ status: "snapshot-mismatch", verb, repo: rel, message: "snapshot changed at the locked checkout boundary; confirm the fresh snapshot", current: fresh.public }, json, deps, root);
      } else {
        emit({ status: "refused", verb, repo: rel, code: follow.reason, message: refusalMessage(follow.reason) }, json, deps, root);
      }
      return 1;
    }
    if (Object.keys(follow.heldRefs).length || !intended) throw new Error("manual resolution published an incomplete checkout");
    const landed = await recoverAndLandFollowJournal(root, rel, binding, state);
    if (landed.recovery.status !== "keep") throw new Error("published checkout journal could not be recovered");
    emit({ status: "resolved", verb, repo: rel, snapshot: snapshot.public.snapshot, quarantine }, json, deps, root);
    return 0;
  }, deps.mutexOptions);
  return run.catch((error) => {
    const busy = error instanceof WorkspaceSyncBusyError;
    emit({
      status: "refused",
      verb,
      repo: rel,
      code: busy ? "sync-busy" : "operation-failed",
      message: busy ? "daemon/CLI is syncing; retry, or run `rbox stop` first" : "the Git resolution could not complete safely; no confirmation can be reused",
    }, json, deps, root);
    return 1;
  });
}
