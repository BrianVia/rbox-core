import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  checkoutTransactionSupported,
  clearCheckoutJournal,
  commitCheckout,
  enumerateStashReflogOids,
  incomingOwnershipRoots,
  indexIdentityV2,
  markCheckoutJournalPublished,
  noDropProof,
  prepareDisplacedRefPins,
  prepareKeepPins,
  recoverJournal,
  tipOwnedByIncoming,
  validateGitSection,
  writeCheckoutJournal,
  type AppliedManifestOracle,
  type BlobStore,
  type CheckoutCapabilityProbe,
  type CheckoutJournal,
  type CheckoutJournalBinding,
  type CheckoutRefUpdate,
  type GitChainTimings,
  type GitSection,
} from "../../engine/index.js";
import { branchesCheckedOutElsewhere } from "../../engine/git/apply.js";
import { hashFile } from "../../engine/hash.js";
import { pruneStaleScratchRefs } from "../../engine/git/pins.js";
import { listRefs, readAllRefs, readOpState } from "../../engine/git/refs.js";
import {
  clearIndexResolveUndo,
  getGitArtifact,
  git,
  headBranchOf,
  importGitPackChain,
  repoCtx,
  type RepoCtx,
} from "../../engine/git/shared.js";
import type {
  GitDeferralReason,
  GitPartialApply,
  RepoRecord,
  RepoRecordInput,
} from "../config.js";
import { gitIncomingKey } from "./shared.js";

const ZERO_OID = "0".repeat(40);

export type FollowCrashPoint =
  | "after-safe-refs"
  | "after-journal-write"
  | "after-connectivity-proof"
  | "after-prepare"
  | "after-index-lock"
  | "after-head-commit"
  | "after-ref-commit"
  | "before-index-publish"
  | "after-index-publish"
  | "mid-op-state"
  | "after-published-flip"
  | "before-journal-clear";

/** Test-only process-death sentinel. Orchestration catches ordinary per-repo
 * errors, so this explicit type is the one exception allowed to escape. */
export class FollowCrashInjectedError extends Error {
  constructor(readonly point: FollowCrashPoint) { super(`injected follow crash at ${point}`); }
}

export interface FollowIntended {
  record: RepoRecordInput;
  expectedRepoGen: number;
  relPath: string;
  /** Pre-journal record used to merge a published recovery lane-by-lane. */
  previousRecord?: RepoRecordInput;
}

export interface FollowProgress {
  appliedRefs: GitPartialApply["appliedRefs"];
  heldRefs: GitPartialApply["heldRefs"];
  filteredRefs: string[];
  configApplied: boolean;
  incomingIndexProjection?: string;
  derivedBaseIndexProjection?: string;
}

export type FollowResult =
  | ({ status: "followed"; journalPendingClear: true } & FollowProgress)
  | ({ status: "defer"; reason: GitDeferralReason; detail: string } & FollowProgress)
  | ({ status: "legacy"; reason: GitDeferralReason; detail: string } & FollowProgress);

export interface FollowOptions {
  workspaceRoot: string;
  relPath: string;
  ctx: RepoCtx;
  base?: GitSection;
  incoming: GitSection;
  store: BlobStore;
  kek: Buffer;
  oracle: AppliedManifestOracle;
  record?: RepoRecord;
  binding: CheckoutJournalBinding;
  /** Exact false preserves the pre-follow conflict disposition. */
  followEnabled: boolean;
  runConfig?: () => Promise<boolean>;
  makeIntended: (progress: FollowProgress) => FollowIntended | Promise<FollowIntended>;
  chainTimings?: GitChainTimings;
  capabilityProbe?: CheckoutCapabilityProbe;
  crashAt?: (point: FollowCrashPoint) => void;
  /** A D2 applied-ref marker failed exact revalidation; human movement wins. */
  forcedHeldRefs?: GitPartialApply["heldRefs"];
  /** D6's explicit, snapshot-confirmed authorization. Automatic follow keeps
   * using the ordinary oracle gates; this narrow mode only waives the exact
   * human divergences enumerated by show-me. Exact ref-plane progress authored
   * by the normal pipeline is reported to the lock-bound snapshot verifier so
   * it can normalize only those known changes and reject every other delta. */
  manualResolution?: {
    snapshotId: string;
    waivedReasons: readonly Extract<GitDeferralReason,
      "local-edits" | "local-index" | "local-operation" | "local-commits" | "local-stash">[];
    protectedOids: readonly string[];
    secondProof: (authoredRefChanges: readonly { ref: string; before?: string; after?: string }[]) => Promise<boolean>;
  };
}

export interface StagedIncoming {
  tmpDir: string;
  incomingNs: string;
  candidateIndex?: string;
  incomingIndexProjection?: string;
  opState: Array<{ rel: string; tmp: string }>;
  opBytes: Record<string, Uint8Array>;
  cleanup(): Promise<void>;
}

export type StageIncomingOptions = Pick<FollowOptions, "ctx" | "incoming" | "store" | "kek" | "chainTimings">;

interface LiveMetadata {
  headContent: string;
  currentRef?: string;
  currentTip?: string;
  refs: Record<string, string>;
  indexPresent: boolean;
  indexProjection?: string;
  opState: Record<string, string>;
}

interface CheckoutClassification {
  safe: boolean;
  reason?: GitDeferralReason;
  detail?: string;
}

async function prepareDisplacementPins(
  repoDir: string,
  ref: string,
  oldOid: string,
  plannedRoots: readonly string[],
  origin: Parameters<typeof prepareDisplacedRefPins>[3],
) {
  const reflog = await prepareDisplacedRefPins(repoDir, ref, plannedRoots, origin);
  if (reflog.status === "indeterminate" || reflog.oids.includes(oldOid)) return reflog;
  const tip = await prepareKeepPins(repoDir, [oldOid], origin);
  return {
    ...reflog,
    oids: [...reflog.oids, oldOid],
    transactionLines: [...reflog.transactionLines, ...tip.transactionLines],
  };
}

export async function checkoutJournalBinding(stream: string, stateNonce: string, ctx: RepoCtx): Promise<CheckoutJournalBinding> {
  return {
    stream,
    stateNonce,
    gitDirReal: await fs.realpath(ctx.gitDir),
    commonDirReal: await fs.realpath(ctx.commonDir),
    worktreeId: await fs.realpath(ctx.repoDir).catch(() => path.resolve(ctx.repoDir)),
  };
}

export async function recoverFollowJournal(
  workspaceRoot: string,
  relPath: string,
  binding: CheckoutJournalBinding,
) {
  return recoverJournal<FollowIntended>(workspaceRoot, relPath, binding);
}

/** No usable repo context means recovery must never touch Git. Supplying an
 * impossible path binding makes a valid journal retire through the engine's
 * ordinary binding-mismatch path; corrupt journals remain visible/deferred. */
export async function quarantineUnboundFollowJournal(workspaceRoot: string, relPath: string, stream: string, stateNonce: string) {
  return recoverJournal<FollowIntended>(workspaceRoot, relPath, {
    stream,
    stateNonce,
    gitDirReal: "",
    commonDirReal: "",
    worktreeId: "",
  });
}

export async function clearFollowJournal(workspaceRoot: string, relPath: string, crashAt?: FollowOptions["crashAt"]): Promise<void> {
  crashAt?.("before-journal-clear");
  await clearCheckoutJournal(workspaceRoot, relPath);
}

function indexArtifact(section: GitSection | undefined) {
  if (!section || !section.indexSha || !section.indexEncSha || section.indexCipherSize === undefined) return undefined;
  return {
    sha: section.indexSha,
    encSha: section.indexEncSha,
    cipherSize: section.indexCipherSize,
    ...(section.indexComp ? { comp: section.indexComp, payloadSha: section.indexPayloadSha } : {}),
  };
}

async function normalizedIndexProjection(repoDir: string, source: string, dest: string): Promise<string | undefined> {
  await fs.copyFile(source, dest);
  try {
    await clearIndexResolveUndo(repoDir, dest);
  } catch {
    return undefined;
  }
  return indexIdentityV2(repoDir, dest);
}

export async function stageIncoming(opts: StageIncomingOptions): Promise<StagedIncoming> {
  const { ctx, incoming, store, kek } = opts;
  await fs.mkdir(path.join(ctx.repoDir, ".rbox"), { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(ctx.repoDir, ".rbox", "git-follow-"));
  const incomingNs = `refs/rbox-incoming/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const cleanup = async () => {
    for (const ref of await listRefs(ctx.repoDir, incomingNs).catch(() => [])) await git(ctx.repoDir, ["update-ref", "-d", ref]).catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    let candidateIndex: string | undefined;
    let incomingIndexProjection: string | undefined;
    const artifact = indexArtifact(incoming);
    if (artifact) {
      const raw = path.join(tmpDir, "incoming-index.raw");
      candidateIndex = path.join(tmpDir, "incoming-index");
      await getGitArtifact(store, kek, artifact, raw, tmpDir);
      incomingIndexProjection = await normalizedIndexProjection(ctx.repoDir, raw, candidateIndex);
    }
    const opState: Array<{ rel: string; tmp: string }> = [];
    const opBytes: Record<string, Uint8Array> = {};
    for (const [rel, artifactRef] of Object.entries(incoming.opState ?? {})) {
      const tmp = path.join(tmpDir, "op", rel);
      await getGitArtifact(store, kek, artifactRef, tmp, tmpDir);
      opState.push({ rel, tmp });
      opBytes[rel] = await fs.readFile(tmp);
    }
    await pruneStaleScratchRefs(ctx.repoDir, "refs/rbox-incoming");
    await importGitPackChain(ctx.repoDir, incoming, store, kek, tmpDir, incomingNs, opts.chainTimings);
    return { tmpDir, incomingNs, candidateIndex, incomingIndexProjection, opState, opBytes, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function readLive(ctx: RepoCtx): Promise<LiveMetadata | undefined> {
  try {
    const headContent = await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8");
    const currentRef = /^ref:\s*(refs\/\S+)\s*$/.exec(headContent)?.[1];
    const refs = await readAllRefs(ctx.repoDir);
    const currentTip = currentRef
      ? refs[currentRef] ?? await git(ctx.repoDir, ["rev-parse", "--verify", currentRef]).catch(() => undefined)
      : await git(ctx.repoDir, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
    const indexPath = path.join(ctx.gitDir, "index");
    const indexPresent = await fs.lstat(indexPath).then((stat) => stat.isFile(), (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    const indexProjection = indexPresent ? await indexIdentityV2(ctx.repoDir, indexPath) : undefined;
    const opState = await readOpState(ctx.gitDir, hashFile);
    return { headContent, currentRef, currentTip, refs, indexPresent, indexProjection, opState };
  } catch {
    return undefined;
  }
}

function sectionOpState(section: GitSection | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(section?.opState ?? {}).map(([rel, artifact]) => [rel, artifact.sha]));
}

function firstReason(reasons: Set<GitDeferralReason>): GitDeferralReason | undefined {
  const precedence: GitDeferralReason[] = [
    "local-edits", "local-index", "local-operation", "local-commits", "local-stash",
    "worktree-ownership", "git-busy", "unreadable", "artifact", "containment", "unsupported", "other",
  ];
  return precedence.find((reason) => reasons.has(reason));
}

async function classifyCheckout(args: {
  opts: FollowOptions;
  live: LiveMetadata | undefined;
  incomingProjection?: string;
  baseProjection?: string;
  roots: readonly string[];
  boundary: boolean;
  checkoutRefReason?: GitDeferralReason;
  checkoutRefDetail?: string;
}): Promise<CheckoutClassification> {
  const reasons = new Set<GitDeferralReason>();
  const details: string[] = [];
  const oracle = args.boundary ? await args.opts.oracle.reproveRepo(args.opts.relPath) : await args.opts.oracle.proveRepo(args.opts.relPath);
  if (oracle.kind === "mismatch") { reasons.add("local-edits"); details.push("working tree differs from applied manifest"); }
  else if (oracle.kind === "indeterminate") { reasons.add("unreadable"); details.push(oracle.why); }

  const live = args.live;
  if (!live) {
    reasons.add("unreadable");
    details.push("git metadata could not be read");
  } else {
    const baseHasIndex = indexArtifact(args.opts.base) !== undefined;
    const incomingHasIndex = indexArtifact(args.opts.incoming) !== undefined;
    const projectionFailed = (live.indexPresent && live.indexProjection === undefined)
      || (baseHasIndex && args.baseProjection === undefined)
      || (incomingHasIndex && args.incomingProjection === undefined);
    if (projectionFailed) {
      reasons.add("unreadable");
      details.push("semantic index projection indeterminate");
    } else {
      const liveValue = live.indexPresent ? live.indexProjection : null;
      const baseValue = baseHasIndex ? args.baseProjection : null;
      const incomingValue = incomingHasIndex ? args.incomingProjection : null;
      if (liveValue !== baseValue && liveValue !== incomingValue) {
        reasons.add("local-index");
        details.push("index differs from both base and incoming");
      }
    }

    const baseOp = sectionOpState(args.opts.base);
    const incomingOp = sectionOpState(args.opts.incoming);
    for (const rel of new Set([...Object.keys(live.opState), ...Object.keys(baseOp), ...Object.keys(incomingOp)])) {
      const value = live.opState[rel] ?? null;
      if (value !== (baseOp[rel] ?? null) && value !== (incomingOp[rel] ?? null)) {
        reasons.add("local-operation");
        details.push(`operation state differs at ${rel}`);
      }
    }

    if (!live.currentTip) {
      reasons.add("unreadable");
      details.push("current checkout tip is unreadable");
    } else {
      const proof = await tipOwnedByIncoming(args.opts.ctx.repoDir, live.currentTip, args.roots);
      if (proof.status === "unowned") { reasons.add("local-commits"); details.push("current tip has receiver-only commits"); }
      else if (proof.status === "indeterminate") {
        reasons.add(proof.marker === "shallow-store" ? "unsupported" : "unreadable");
        details.push(`current-tip reachability ${proof.marker}`);
      }
    }

    if (args.opts.ctx.kind === "dir") {
      try {
        for (const oid of await enumerateStashReflogOids(args.opts.ctx.repoDir)) {
          const proof = await tipOwnedByIncoming(args.opts.ctx.repoDir, oid, args.roots);
          if (proof.status === "unowned") { reasons.add("local-stash"); details.push("stash reflog contains receiver-only work"); }
          else if (proof.status === "indeterminate") { reasons.add("unreadable"); details.push(`stash reachability ${proof.marker}`); }
        }
      } catch {
        reasons.add("unreadable");
        details.push("stash reflog could not be read");
      }
    }
  }
  if (args.checkoutRefReason) {
    reasons.add(args.checkoutRefReason);
    details.push(args.checkoutRefDetail ?? "incoming checkout ref could not be published safely");
  }
  for (const reason of args.opts.manualResolution?.waivedReasons ?? []) reasons.delete(reason);
  const reason = firstReason(reasons);
  return reason ? { safe: false, reason, detail: details.join("; ") } : { safe: true };
}

async function runRefTransaction(repoDir: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable for ref transaction");
  const inputPath = path.join(ctx.commonDir, `.rbox-follow-ref-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  await fs.writeFile(inputPath, ["start", ...lines, "prepare", "commit", ""].join("\n"));
  const input = await fs.open(inputPath, "r");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["-C", repoDir, "update-ref", "--stdin"], {
        env: { ...process.env, GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } as NodeJS.ProcessEnv,
        stdio: [input.fd, "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 && !/\bfatal:/i.test(stderr) ? resolve() : reject(new Error(`git update-ref failed (${code}): ${stderr.trim()}`)));
    });
  } finally {
    await input.close();
    await fs.rm(inputPath, { force: true });
  }
}

async function ensureStashReflog(repoDir: string, oid: string): Promise<void> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while creating stash reflog");
  const logPath = path.join(ctx.commonDir, "logs", "refs", "stash");
  const stat = await fs.stat(logPath).catch(() => undefined);
  if (stat && stat.size > 0) return;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const subject = (await git(repoDir, ["log", "-1", "--format=%s", oid]).catch(() => "rbox: synced stash"))
    .replace(/[\r\n\t]+/g, " ") || "rbox: synced stash";
  const ident = (await git(repoDir, ["var", "GIT_COMMITTER_IDENT"])).replace(/[\r\n]+/g, " ");
  const handle = await fs.open(logPath, "a");
  try {
    await handle.write(`${oid} ${oid} ${ident}\t${subject}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function effectiveRefs(ctx: RepoCtx, incoming: GitSection): { refs: Record<string, string>; filtered: string[]; deleteAbsent: boolean } {
  if (ctx.kind === "dir") return { refs: { ...incoming.refs }, filtered: [], deleteAbsent: incoming.refScope === "all" };
  const refs: Record<string, string> = {};
  const filtered: string[] = [];
  for (const [ref, oid] of Object.entries(incoming.refs)) {
    if (ref.startsWith("refs/heads/")) refs[ref] = oid;
    else filtered.push(ref);
  }
  return { refs, filtered, deleteAbsent: false };
}

async function publishRefPlane(
  opts: FollowOptions,
  live: LiveMetadata,
  roots: readonly string[],
): Promise<FollowProgress & {
  checkoutRefReason?: GitDeferralReason;
  checkoutRefDetail?: string;
  authoredRefChanges: Array<{ ref: string; before?: string; after?: string }>;
}> {
  const effective = effectiveRefs(opts.ctx, opts.incoming);
  const owned = await branchesCheckedOutElsewhere(opts.ctx);
  const appliedRefs: GitPartialApply["appliedRefs"] = {};
  const heldRefs: GitPartialApply["heldRefs"] = {};
  const plannedRoots = [...new Set(Object.values(effective.refs))];
  const forcedCurrent = live.currentRef ? opts.forcedHeldRefs?.[live.currentRef] : undefined;
  let checkoutRefReason: GitDeferralReason | undefined = forcedCurrent === "ownership" ? "worktree-ownership" : forcedCurrent;
  let checkoutRefDetail: string | undefined;
  const authoredRefChanges: Array<{ ref: string; before?: string; after?: string }> = [];
  const manualProtected = new Set(opts.manualResolution?.protectedOids ?? []);
  const incomingHeadRef = headBranchOf(opts.incoming.head);
  if (incomingHeadRef && owned.has(incomingHeadRef)) {
    checkoutRefReason = "worktree-ownership";
    checkoutRefDetail = `branch ${incomingHeadRef.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${owned.get(incomingHeadRef)}`;
  }
  const candidates = new Set(Object.keys(effective.refs));
  if (effective.deleteAbsent) for (const ref of Object.keys(live.refs)) candidates.add(ref);

  const classifiedHolds = new Map<string, GitPartialApply["heldRefs"][string]>();
  const protectedByRef = new Map<string, string[]>();
  for (const ref of candidates) {
    if (ref === live.currentRef) continue;
    const oldOid = live.refs[ref];
    const newOid = effective.refs[ref];
    if (oldOid === newOid) continue;
    let hold = opts.forcedHeldRefs?.[ref];
    if (!hold && owned.has(ref)) {
      hold = "ownership";
      if (opts.manualResolution) checkoutRefReason ??= "worktree-ownership";
      checkoutRefDetail ??= `branch ${ref.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${owned.get(ref)}`;
    }
    if (oldOid) {
      const protectedOids = ref === "refs/stash" && opts.ctx.kind === "dir"
        ? [...new Set([oldOid, ...await enumerateStashReflogOids(opts.ctx.repoDir)])]
        : [oldOid];
      protectedByRef.set(ref, protectedOids);
      if (!hold) for (const oid of protectedOids) {
        const proof = await tipOwnedByIncoming(opts.ctx.repoDir, oid, roots);
        if (proof.status === "unowned") {
          if (opts.manualResolution && manualProtected.has(oid)) continue;
          hold = ref === "refs/stash" ? "local-stash" : "local-commits";
          break;
        }
        if (proof.status === "indeterminate") {
          hold = ref === "refs/stash" ? "local-stash" : "local-commits";
          checkoutRefReason ??= proof.marker === "shallow-store" ? "unsupported" : "unreadable";
          break;
        }
      }
    }
    if (hold) classifiedHolds.set(ref, hold);
  }

  // Recompute until stable: a ref may be called safe only from roots that will
  // actually remain durable after every already-classified hold. The current
  // checkout ref is deliberately a held root here because checkout may defer.
  let plannedRefs: Record<string, string> = {};
  let heldDurable: Record<string, string> = {};
  for (;;) {
    plannedRefs = {};
    for (const ref of candidates) {
      if (ref === live.currentRef || classifiedHolds.has(ref)) continue;
      const oid = effective.refs[ref];
      if (oid) plannedRefs[ref] = oid;
    }
    if (live.currentRef && effective.refs[live.currentRef]) plannedRefs[live.currentRef] = effective.refs[live.currentRef]!;
    heldDurable = {};
    for (const [ref, oid] of Object.entries(live.refs)) {
      if (ref === live.currentRef || classifiedHolds.has(ref) || !candidates.has(ref)) heldDurable[ref] = oid;
    }
    let changed = false;
    for (const ref of candidates) {
      if (ref === live.currentRef || classifiedHolds.has(ref)) continue;
      const protectedOids = protectedByRef.get(ref);
      if (!protectedOids?.length) continue;
      if (opts.manualResolution && protectedOids.every((oid) => manualProtected.has(oid))) continue;
      const proof = await noDropProof(opts.ctx.repoDir, plannedRefs, heldDurable, {}, protectedOids);
      if (proof.status === "proven") continue;
      classifiedHolds.set(ref, ref === "refs/stash" ? "local-stash" : "local-commits");
      if (proof.status === "indeterminate") checkoutRefReason ??= proof.marker === "shallow-store" ? "unsupported" : "unreadable";
      changed = true;
    }
    if (!changed) break;
  }

  for (const ref of [...candidates].sort()) {
    if (ref === live.currentRef) continue; // current branch belongs to checkout txn.
    const oldOid = live.refs[ref];
    const newOid = effective.refs[ref];
    if (oldOid === newOid) {
      if (newOid) appliedRefs[ref] = { kind: "direct", oid: newOid };
      if (!opts.manualResolution && ref === "refs/stash" && newOid) await ensureStashReflog(opts.ctx.repoDir, newOid);
      continue;
    }
    const hold = classifiedHolds.get(ref);
    if (hold) {
      heldRefs[ref] = hold;
      if (opts.manualResolution) checkoutRefReason ??= hold === "ownership" ? "worktree-ownership" : hold;
      if (ref === incomingHeadRef) checkoutRefReason = hold === "ownership" ? "worktree-ownership" : hold;
      continue;
    }
    try {
      if ((await branchesCheckedOutElsewhere(opts.ctx)).has(ref)) {
        heldRefs[ref] = "ownership";
        const sibling = (await branchesCheckedOutElsewhere(opts.ctx)).get(ref);
        checkoutRefDetail ??= `branch ${ref.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${sibling}`;
        if (opts.manualResolution || ref === incomingHeadRef) checkoutRefReason = "worktree-ownership";
        continue;
      }
      if (!oldOid && !newOid) continue;

      const lines: string[] = [];
      if (oldOid && (!newOid || (await tipOwnedByIncoming(opts.ctx.repoDir, oldOid, [newOid])).status !== "owned")) {
        const durableNow = await readAllRefs(opts.ctx.repoDir);
        delete durableNow[ref];
        const pins = await prepareDisplacementPins(opts.ctx.repoDir, ref, oldOid, [...Object.values(durableNow), ...(newOid ? [newOid] : [])], {
          ref,
          episode: opts.incoming.generatedAt || String(Date.now()),
          time: new Date().toISOString(),
          class: "human",
        });
        if (pins.status === "indeterminate") {
          heldRefs[ref] = ref === "refs/stash" ? "local-stash" : "local-commits";
          if (ref === incomingHeadRef) checkoutRefReason = ref === "refs/stash" ? "local-stash" : "local-commits";
          continue;
        }
        lines.push(...pins.transactionLines);
      }
      if (oldOid && newOid) lines.push(`update ${ref} ${newOid} ${oldOid}`);
      else if (newOid) lines.push(`create ${ref} ${newOid}`);
      else lines.push(`delete ${ref} ${oldOid}`);
      await runRefTransaction(opts.ctx.repoDir, lines);
      if (opts.manualResolution) authoredRefChanges.push({ ref, ...(oldOid ? { before: oldOid } : {}), ...(newOid ? { after: newOid } : {}) });
      if (newOid) appliedRefs[ref] = { kind: "direct", oid: newOid };
      if (!opts.manualResolution && ref === "refs/stash" && newOid) await ensureStashReflog(opts.ctx.repoDir, newOid);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      checkoutRefReason ??= /lock|busy|transaction/i.test(message) ? "git-busy" : "other";
    }
  }

  const configApplied = await opts.runConfig?.().catch(() => false) ?? true;
  return {
    appliedRefs,
    heldRefs,
    filteredRefs: effective.filtered,
    configApplied,
    checkoutRefReason,
    checkoutRefDetail,
    authoredRefChanges,
  };
}

export async function deriveBaseIndexProjection(
  opts: Pick<FollowOptions, "ctx" | "base" | "store" | "kek" | "record">,
  tmpDir: string,
  ignoreCache = false,
): Promise<string | undefined> {
  if (!indexArtifact(opts.base)) return undefined;
  if (!ignoreCache && opts.record?.idxProj) return opts.record.idxProj;
  const artifact = indexArtifact(opts.base);
  if (!artifact) return undefined;
  const raw = path.join(opts.ctx.gitDir, `.rbox-base-index-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await getGitArtifact(opts.store, opts.kek, artifact, raw, tmpDir);
    await clearIndexResolveUndo(opts.ctx.repoDir, raw);
    // `return await`, not `return`: the finally's rm would otherwise race the
    // projection's own read of `raw` (observed as a flaky false-indeterminate).
    return await indexIdentityV2(opts.ctx.repoDir, raw);
  } finally {
    await fs.rm(raw, { force: true });
  }
}

function expectedHead(section: GitSection): string {
  return section.head.endsWith("\n") ? section.head : `${section.head}\n`;
}

export async function followDivergedRepo(opts: FollowOptions): Promise<FollowResult> {
  const valid = validateGitSection(opts.incoming);
  const emptyProgress: FollowProgress = { appliedRefs: {}, heldRefs: {}, filteredRefs: [], configApplied: true };
  if (!valid.ok) return { status: "defer", reason: "unsupported", detail: `invalid git section: ${valid.reason}`, ...emptyProgress };

  let staged: StagedIncoming;
  try {
    staged = await stageIncoming(opts);
  } catch (error) {
    return { status: "defer", reason: "artifact", detail: `git artifact fetch/decrypt/import failed: ${String((error as Error)?.message ?? error)}`, ...emptyProgress };
  }

  try {
    const liveBefore = await readLive(opts.ctx);
    if (!liveBefore) return { status: "defer", reason: "unreadable", detail: "git metadata could not be read", ...emptyProgress };
    const baseProjection = opts.record?.idxProj ?? await deriveBaseIndexProjection(opts, staged.tmpDir).catch(() => undefined);
    const effective = effectiveRefs(opts.ctx, opts.incoming);
    const ownershipSection = { ...opts.incoming, refs: effective.refs };
    const roots = incomingOwnershipRoots(ownershipSection, { prefix: staged.incomingNs, opState: staged.opBytes });
    const refProgress = await publishRefPlane(opts, liveBefore, roots);
    const progress: FollowProgress = {
      appliedRefs: refProgress.appliedRefs,
      heldRefs: refProgress.heldRefs,
      filteredRefs: refProgress.filteredRefs,
      configApplied: refProgress.configApplied,
      ...(staged.incomingIndexProjection === undefined ? {} : { incomingIndexProjection: staged.incomingIndexProjection }),
      ...(opts.record?.idxProj || baseProjection === undefined ? {} : { derivedBaseIndexProjection: baseProjection }),
    };
    opts.crashAt?.("after-safe-refs");

    // The design kill switch disables oracle-authorized checkout only. Safe
    // refs/config and their partial markers remain active in both flag arms.
    if (!opts.followEnabled && !opts.manualResolution) return { status: "legacy", reason: "conflict", detail: "automatic checkout follow disabled", ...progress };
    const capabilitySupported = opts.capabilityProbe
      ? await opts.capabilityProbe(await git(opts.ctx.repoDir, ["--version"]))
      : await checkoutTransactionSupported(opts.ctx.repoDir);
    if (!capabilitySupported) return { status: "legacy", reason: "unsupported", detail: "git lacks prepared transactional symref-update", ...progress };

    // Scratch refs and held incoming values are not durable roots. Authorize
    // checkout only from incoming refs that are already published (plus the
    // current ref value that this checkout transaction itself will publish).
    const incomingHeadRef = headBranchOf(opts.incoming.head);
    const durableIncomingRefs = Object.fromEntries(Object.entries(progress.appliedRefs)
      .filter((entry): entry is [string, { kind: "direct"; oid: string }] => entry[1].kind === "direct")
      .map(([ref, value]) => [ref, value.oid]));
    if (incomingHeadRef && effective.refs[incomingHeadRef]) {
      durableIncomingRefs[incomingHeadRef] = effective.refs[incomingHeadRef]!;
    }
    const checkoutRoots = incomingOwnershipRoots(
      { ...opts.incoming, refs: durableIncomingRefs },
      { prefix: staged.incomingNs, opState: staged.opBytes },
    );

    const first = await classifyCheckout({
      opts,
      live: liveBefore,
      incomingProjection: staged.incomingIndexProjection,
      baseProjection,
      roots: checkoutRoots,
      boundary: false,
      checkoutRefReason: refProgress.checkoutRefReason,
      checkoutRefDetail: refProgress.checkoutRefDetail,
    });
    if (!first.safe) return { status: "defer", reason: first.reason!, detail: first.detail ?? "checkout follow proof failed", ...progress };

    const refUpdates: CheckoutRefUpdate[] = [];
    const postHeadRefUpdates: CheckoutRefUpdate[] = [];
    const postHeadExtraTransactionLines: string[] = [];
    const refReservations: Array<{ ref: string; expectedOid: string }> = [];
    const extraTransactionLines: string[] = [];
    const expectedRefs: Record<string, string> = {};
    if (liveBefore.currentRef) {
      const oldOid = liveBefore.currentTip;
      const newOid = effective.refs[liveBefore.currentRef];
      let pinLines: string[] = [];
      if (oldOid && (!newOid || (await tipOwnedByIncoming(opts.ctx.repoDir, oldOid, [newOid])).status !== "owned")) {
        const durableNow = await readAllRefs(opts.ctx.repoDir);
        delete durableNow[liveBefore.currentRef];
        const pins = await prepareDisplacementPins(opts.ctx.repoDir, liveBefore.currentRef, oldOid, [...Object.values(durableNow), ...(newOid ? [newOid] : [])], {
          ref: liveBefore.currentRef,
          episode: opts.incoming.generatedAt || String(Date.now()),
          time: new Date().toISOString(),
          class: "human",
        });
        if (pins.status === "indeterminate") {
          return { status: "defer", reason: "unreadable", detail: `current-ref reflog reachability ${pins.marker}`, ...progress };
        }
        pinLines = pins.transactionLines;
      }
      if (oldOid && newOid && oldOid !== newOid) {
        if (incomingHeadRef === liveBefore.currentRef) {
          extraTransactionLines.push(...pinLines);
          refUpdates.push({ kind: "update", ref: liveBefore.currentRef, oldOid, newOid });
          expectedRefs[liveBefore.currentRef] = newOid;
        } else {
          postHeadExtraTransactionLines.push(...pinLines);
          postHeadRefUpdates.push({ kind: "update", ref: liveBefore.currentRef, oldOid, newOid });
          expectedRefs[liveBefore.currentRef] = newOid;
        }
      } else if (oldOid && !newOid && effective.deleteAbsent) {
        if (incomingHeadRef === liveBefore.currentRef) {
          extraTransactionLines.push(...pinLines);
          refUpdates.push({ kind: "delete", ref: liveBefore.currentRef, oldOid });
        } else {
          postHeadExtraTransactionLines.push(...pinLines);
          postHeadRefUpdates.push({ kind: "delete", ref: liveBefore.currentRef, oldOid });
        }
      }
    }
    const head = incomingHeadRef
      ? { kind: "symbolic" as const, newTarget: incomingHeadRef, ...(liveBefore.currentRef ? { oldTarget: liveBefore.currentRef } : { oldOid: liveBefore.currentTip }) }
      : { kind: "detached" as const, newOid: opts.incoming.head.trim(), oldOid: liveBefore.currentTip! };
    if (incomingHeadRef && incomingHeadRef !== liveBefore.currentRef) {
      const targetOid = effective.refs[incomingHeadRef];
      if (!targetOid) return { status: "defer", reason: "unsupported", detail: "incoming HEAD branch is filtered or absent", ...progress };
      refReservations.push({ ref: incomingHeadRef, expectedOid: targetOid });
    }

    const postProgress: FollowProgress = {
      ...progress,
      appliedRefs: { ...progress.appliedRefs },
    };
    if (incomingHeadRef && effective.refs[incomingHeadRef]) {
      postProgress.appliedRefs[incomingHeadRef] = { kind: "direct", oid: effective.refs[incomingHeadRef]! };
    }
    if (liveBefore.currentRef && incomingHeadRef === liveBefore.currentRef && effective.refs[liveBefore.currentRef]) {
      postProgress.appliedRefs[liveBefore.currentRef] = { kind: "direct", oid: effective.refs[liveBefore.currentRef]! };
    }

    const oldOp = Object.fromEntries(Object.keys(liveBefore.opState).map((rel) => [rel, true as const]));
    const newOp = Object.fromEntries(Object.entries(opts.incoming.opState ?? {}).map(([rel, artifact]) => [rel, artifact.sha]));
    const intended = await opts.makeIntended(postProgress);
    const journal: CheckoutJournal<FollowIntended> = {
      phase: "intent",
      incomingKey: gitIncomingKey(opts.incoming),
      incomingSection: opts.incoming,
      old: {
        ...(liveBefore.currentRef ? { currentRefName: liveBefore.currentRef, currentRefOid: liveBefore.currentTip } : {}),
        headContent: liveBefore.headContent,
        indexPresent: liveBefore.indexPresent,
        opState: oldOp,
      },
      expectedNew: {
        opState: newOp,
        refs: expectedRefs,
        head: expectedHead(opts.incoming),
        ...(refReservations.length ? { reservedRefs: Object.fromEntries(refReservations.map(({ ref, expectedOid }) => [ref, expectedOid])) } : {}),
      },
      binding: opts.binding,
      createdFresh: false,
      intended,
      ...(opts.manualResolution ? { episode: { verb: "take-theirs" as const, snapshotId: opts.manualResolution.snapshotId } } : {}),
    };
    await writeCheckoutJournal(opts.workspaceRoot, opts.relPath, journal, {
      indexPath: path.join(opts.ctx.gitDir, "index"),
      gitDir: opts.ctx.gitDir,
    });
    opts.crashAt?.("after-journal-write");

    let boundaryFailure: CheckoutClassification | undefined;
    const noteBoundaryFailure = (reason: GitDeferralReason, detail: string): void => {
      const chosen = firstReason(new Set([...(boundaryFailure?.reason ? [boundaryFailure.reason] : []), reason]));
      if (!boundaryFailure || chosen === reason) boundaryFailure = { safe: false, reason, detail };
    };
    const result = await commitCheckout(opts.ctx, {
      ...(staged.candidateIndex ? { candidateIndexPath: staged.candidateIndex } : { removeIndex: true }),
      refUpdates,
      postHeadRefUpdates,
      postHeadExtraTransactionLines,
      refReservations,
      head,
      extraTransactionLines,
      plannedGraphRoots: roots,
      opState: staged.opState,
    }, {
      capabilityProbe: opts.capabilityProbe,
      capabilitySupported: true,
      journal: { workspaceRoot: opts.workspaceRoot, relPath: opts.relPath, value: journal },
      secondProof: async () => {
        const freshCtx = await repoCtx(opts.ctx.repoDir);
        const freshBinding = freshCtx ? await checkoutJournalBinding(opts.binding.stream, opts.binding.stateNonce, freshCtx) : undefined;
        const sameIncarnation = freshCtx !== undefined && freshBinding !== undefined
          && freshBinding.gitDirReal === opts.binding.gitDirReal
          && freshBinding.commonDirReal === opts.binding.commonDirReal
          && freshBinding.worktreeId === opts.binding.worktreeId
          && freshCtx.kind === opts.ctx.kind;
        const live = sameIncarnation ? await readLive(freshCtx) : undefined;
        if (opts.manualResolution) {
          try {
            if (!(await opts.manualResolution.secondProof(refProgress.authoredRefChanges))) {
              noteBoundaryFailure("other", "confirmed snapshot changed at checkout boundary");
              return false;
            }
          } catch {
            noteBoundaryFailure("unreadable", "confirmed snapshot could not be revalidated at checkout boundary");
            return false;
          }
        }
        const proof = await classifyCheckout({
          opts,
          live,
          incomingProjection: staged.incomingIndexProjection,
          baseProjection,
          roots: checkoutRoots,
          boundary: true,
          checkoutRefReason: refProgress.checkoutRefReason,
          checkoutRefDetail: refProgress.checkoutRefDetail,
        });
        if (!proof.safe) boundaryFailure = proof;
        if (!sameIncarnation) { noteBoundaryFailure("unreadable", "repository incarnation changed at checkout boundary"); return false; }
        if (!live) { noteBoundaryFailure("unreadable", "git metadata became unreadable"); return false; }
        const boundaryOwned = await branchesCheckedOutElsewhere(opts.ctx);
        for (const [ref, expected] of Object.entries(progress.appliedRefs)) {
          if (boundaryOwned.has(ref) && liveBefore.refs[ref] !== (expected.kind === "direct" ? expected.oid : undefined)) {
            noteBoundaryFailure("worktree-ownership", `worktree ownership changed for ${ref}`);
            return false;
          }
        }
        if (incomingHeadRef && boundaryOwned.has(incomingHeadRef)) {
          noteBoundaryFailure("worktree-ownership", "incoming checkout branch became sibling-owned");
          return false;
        }
        for (const bad of opts.ctx.kind === "dir" ? ["modules", "objects/info/alternates"] : ["objects/info/alternates"]) {
          const root = opts.ctx.kind === "dir" ? opts.ctx.gitDir : opts.ctx.commonDir;
          if (await fs.access(path.join(root, bad)).then(() => true, () => false)) {
            noteBoundaryFailure("unsupported", `repository structure changed at ${bad}`);
            return false;
          }
        }
        for (const [ref, expected] of Object.entries(progress.appliedRefs)) {
          if (expected.kind === "direct" && live.refs[ref] !== expected.oid) {
            noteBoundaryFailure("local-commits", `published ref changed at ${ref}`);
            return false;
          }
        }
        for (const ref of Object.keys(progress.heldRefs)) if (live.refs[ref] !== liveBefore.refs[ref]) {
          noteBoundaryFailure("local-commits", `held ref changed at ${ref}`);
          return false;
        }
        return proof.safe;
      },
      crashAt: (point) => opts.crashAt?.(point),
    });
    if (result.status !== "committed") {
      await clearCheckoutJournal(opts.workspaceRoot, opts.relPath);
      const reason: GitDeferralReason = result.status === "unsupported" ? "unsupported"
        : /became busy/.test(result.reason) ? "git-busy"
        : /connectivity/.test(result.reason) ? "artifact"
        : boundaryFailure?.reason ?? "other";
      return {
        status: result.status === "unsupported" ? "legacy" : "defer",
        reason,
        detail: boundaryFailure?.detail ?? result.reason,
        ...progress,
      };
    }
    await markCheckoutJournalPublished(opts.workspaceRoot, opts.relPath);
    if (opts.manualResolution && effective.refs["refs/stash"]) await ensureStashReflog(opts.ctx.repoDir, effective.refs["refs/stash"]!);
    opts.crashAt?.("after-published-flip");
    return { status: "followed", journalPendingClear: true, ...postProgress };
  } finally {
    await staged.cleanup();
  }
}
