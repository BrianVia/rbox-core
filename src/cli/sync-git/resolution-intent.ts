import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes, type AppliedManifestOracle, type GitSection } from "../../engine/index.js";
import { gitIdentity } from "./identity.js";
import { indexIdentityV2 } from "./index-identity.js";
import { readRepoIdentityV1, repositoryIdentityHash } from "./repo-lineage.js";
import { type RepoCtx } from "./git-state.js";
import { canonicalString } from "../../engine/e2ee/index.js";
import { enumerateRefReflogOids } from "./keep-pins.js";
import { readAllRefs, readOpState } from "./refs.js";
import { exists, getGitArtifact, type GitArtifactReadStore } from "./git-state.js";
import { git } from "../../engine/git-spawn.js";
import { hashFile } from "../../engine/hash.js";
import {
  expectedStateNonce,
  type GitResolutionBinding,
  type GitResolutionLaneDisposition,
  type RepoRecord,
  type SyncState,
  type WorkspaceConfig,
} from "../config.js";
import { configReceiver, gitConfigHash, readLocalGitConfig } from "./config-lane.js";
import { gitCommitAncestry } from "./git-ancestry.js";
import { indexArtifact } from "./follow.js";
import { gitIncomingKey, sectionOpState } from "./shared.js";

export interface ResolutionLaneReport {
  lane: string;
  disposition: GitResolutionLaneDisposition;
  detail: string;
  incomingOids?: string[];
}

export interface ResolutionDiscardReport {
  lanes: ResolutionLaneReport[];
  forceRequired: boolean;
}

/** Ephemeral authority carried only by the foreground confirmed push. */
export interface GitResolutionRider {
  repo: string;
  verb: "keep-mine";
  confirmedReport: ResolutionDiscardReport;
  authorizedLanes: string[];
  forceDiscardIncoming: boolean;
}

export function resolutionReportHash(report: ResolutionDiscardReport): string {
  return hashBytes(Buffer.from(canonicalString(report)));
}

const sortedEntries = (value: Record<string, string>): Array<[string, string]> =>
  Object.entries(value).sort(([a], [b]) => a.localeCompare(b));

async function configBinding(root: string, rel: string, ctx: RepoCtx): Promise<GitResolutionBinding["config"]> {
  let receiver: Awaited<ReturnType<typeof configReceiver>>;
  try {
    receiver = await configReceiver(root, ctx);
  } catch {
    return { ownership: "indeterminate", read: "failed", detail: "ownership-read" };
  }
  const shape = canonicalString(receiver.storeIdentity);
  if (!receiver.owned) return { ownership: "unowned", read: "not-owned", shape };
  const local = await readLocalGitConfig(root, rel, ctx);
  if (local.status === "ok") return { ownership: "owned", read: "ok", hash: local.cached.hash, shape };
  if (local.status === "over-bounds") return { ownership: "owned", read: "over-bounds", detail: local.reason, shape };
  return { ownership: "owned", read: "failed", detail: `${local.fault.disposition}:${local.fault.reason}`, shape };
}

/** Recompute the complete show-me/intent binding. No mutation is permitted here. */
export async function resolutionBindingIdentity(args: {
  root: string;
  rel: string;
  ctx: RepoCtx;
  state: SyncState;
  record: RepoRecord;
  incoming: GitSection;
  oracle: AppliedManifestOracle;
  cfg: WorkspaceConfig;
  boundary: boolean;
}): Promise<GitResolutionBinding> {
  const refs = await readAllRefs(args.ctx.repoDir);
  const reflogs: Array<[string, string[]]> = [];
  for (const ref of Object.keys(refs).filter((ref) => ref !== "refs/stash").sort()) {
    reflogs.push([ref, (await enumerateRefReflogOids(args.ctx.repoDir, ref)).sort()]);
  }
  const head = await fs.readFile(path.join(args.ctx.gitDir, "HEAD"), "utf8");
  const indexPath = path.join(args.ctx.gitDir, "index");
  const indexPresent = await exists(indexPath);
  const indexProjection = indexPresent ? await indexIdentityV2(args.ctx.repoDir, indexPath) : undefined;
  const index: GitResolutionBinding["index"] = !indexPresent
    ? { kind: "absent" }
    : indexProjection === undefined ? { kind: "indeterminate" } : { kind: "projected", value: indexProjection };
  const opState = await readOpState(args.ctx.gitDir, hashFile);
  const stash = args.ctx.kind === "dir" ? (await enumerateRefReflogOids(args.ctx.repoDir, "refs/stash")).sort() : [];
  if (args.boundary) await args.oracle.reproveRepo(args.rel); else await args.oracle.proveRepo(args.rel);
  const identity = await gitIdentity(args.ctx.repoDir, args.ctx);
  if (!identity) throw new Error("repository identity is unavailable");
  const repoIdentity = await readRepoIdentityV1(args.rel, args.ctx.kind, {
    worktreeId: args.ctx.repoDir,
    gitDirReal: args.ctx.gitDir,
    commonDirReal: args.ctx.commonDir,
  });
  return {
    stream: args.state.stream,
    stateNonce: expectedStateNonce(args.state),
    incomingKey: gitIncomingKey(args.incoming),
    repoGen: args.record.repoGen,
    refs: sortedEntries(refs),
    reflogs,
    head,
    index,
    opState: sortedEntries(opState),
    stash,
    oracleReceipt: args.oracle.receiptHash(args.rel) ?? null,
    config: await configBinding(args.root, args.rel, args.ctx),
    effectiveRefScope: identity.refScope,
    capturePolicy: {
      syncGit: args.cfg.syncGit === true,
      respectGitignore: args.cfg.respectGitignore === true,
      ...(args.cfg.git?.incremental === undefined ? {} : { incremental: args.cfg.git.incremental }),
    },
    repoKind: args.ctx.kind,
    repositoryIdentity: repositoryIdentityHash(repoIdentity),
  };
}

async function equalOrDescendant(repoDir: string, pendingOid: string, candidateOid: string): Promise<GitResolutionLaneDisposition> {
  try {
    const ancestry = await gitCommitAncestry(repoDir, pendingOid, candidateOid);
    return ancestry === "not-ancestor" ? "not-subsumed" : "subsumed";
  } catch {
    return "indeterminate";
  }
}

async function pendingIndexProjection(ctx: RepoCtx, pending: GitSection, store: GitArtifactReadStore, kek: Buffer): Promise<
  | { kind: "absent" }
  | { kind: "projected"; value: string; oids: string[] }
  | { kind: "indeterminate" }
> {
  let artifact;
  try { artifact = indexArtifact(pending, { strict: true }); } catch { return { kind: "indeterminate" }; }
  if (!artifact) return { kind: "absent" };
  const tmpDir = await fs.mkdtemp(path.join(ctx.gitDir, ".rbox-resolution-index-"));
  try {
    const target = path.join(tmpDir, "index");
    await getGitArtifact(store, kek, artifact, target, tmpDir);
    const value = await indexIdentityV2(ctx.repoDir, target);
    if (value === undefined) return { kind: "indeterminate" };
    const staged = await git(ctx.repoDir, ["ls-files", "--stage"], { env: { GIT_INDEX_FILE: target } });
    const oids = [...new Set(staged.split("\n").flatMap((line) => {
      const match = /^\d+\s+([0-9a-f]{40})\s+\d+\t/.exec(line);
      return match ? [match[1]!] : [];
    }))].sort();
    return { kind: "projected", value, oids };
  } catch {
    return { kind: "indeterminate" };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function pendingOpStateOids(ctx: RepoCtx, pending: GitSection, store: GitArtifactReadStore, kek: Buffer): Promise<string[] | undefined> {
  const entries = Object.entries(pending.opState ?? {});
  if (entries.length === 0) return [];
  const tmpDir = await fs.mkdtemp(path.join(ctx.gitDir, ".rbox-resolution-opstate-"));
  try {
    const roots = new Set<string>();
    for (const [rel, artifact] of entries) {
      const target = path.join(tmpDir, artifact.encSha);
      await getGitArtifact(store, kek, artifact, target, tmpDir);
      const text = await fs.readFile(target, "utf8");
      for (const match of text.matchAll(/\b[0-9a-f]{40}\b/g)) roots.add(match[0]!);
    }
    return [...roots].sort();
  } catch {
    return undefined;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** What one exact lane compares: the projection each side canonicalizes — an oid
 * or hash, an op-state map, or the index lane's projected value. */
type ExactLaneValue = string | Record<string, string> | { kind: string; value?: string };

function exactLane(lane: string, pending: ExactLaneValue | undefined, candidate: ExactLaneValue | undefined, incomingOids?: string[]): ResolutionLaneReport {
  const pendingCanonical = canonicalString(pending === undefined ? null : pending);
  const candidateCanonical = canonicalString(candidate === undefined ? null : candidate);
  const equal = pendingCanonical === candidateCanonical;
  return {
    lane,
    disposition: equal ? "subsumed" : "not-subsumed",
    detail: equal ? "incoming value is retained" : "incoming value would be replaced",
    ...(incomingOids?.length ? { incomingOids } : {}),
  };
}

function indexLaneValue(index: { kind: "absent" | "indeterminate" | "projected"; value?: string }): { kind: string; value?: string } {
  return index.kind === "projected" ? { kind: index.kind, value: index.value } : { kind: index.kind };
}

async function reportCore(args: {
  ctx: RepoCtx;
  pending: GitSection;
  candidateRefs: Record<string, string>;
  candidateHead: string;
  candidateScope: string;
  candidateOpState: Record<string, string>;
  candidateConfig: GitResolutionBinding["config"];
}): Promise<ResolutionDiscardReport> {
  const lanes: ResolutionLaneReport[] = [];
  for (const [ref, pendingOid] of Object.entries(args.pending.refs).sort(([a], [b]) => a.localeCompare(b))) {
    if (ref === "refs/stash") continue;
    const candidateOid = args.candidateRefs[ref];
    if (ref.startsWith("refs/heads/")) {
      const disposition = candidateOid === undefined ? "not-subsumed" : await equalOrDescendant(args.ctx.repoDir, pendingOid, candidateOid);
      lanes.push({ lane: `branch:${ref}`, disposition, detail: disposition === "subsumed" ? "incoming branch is an ancestor of local history" : disposition === "not-subsumed" ? "incoming branch would be replaced" : "branch ancestry could not be proven", incomingOids: [pendingOid] });
    } else if (ref.startsWith("refs/tags/")) {
      lanes.push(exactLane(`tag:${ref}`, pendingOid, candidateOid, [pendingOid]));
    } else {
      lanes.push({ lane: `ref:${ref}`, disposition: "indeterminate", detail: "unsupported incoming ref class", incomingOids: [pendingOid] });
    }
  }
  const pendingStash = args.pending.refs["refs/stash"];
  lanes.push(pendingStash === undefined
    ? { lane: "stash", disposition: "subsumed", detail: "no incoming stash lane" }
    : exactLane("stash", pendingStash, args.candidateRefs["refs/stash"], [pendingStash]));
  const detachedIncoming = /^[0-9a-f]{40}\s*$/.test(args.pending.head) ? [args.pending.head.trim()] : undefined;
  lanes.push(exactLane("head", args.pending.head.trim(), args.candidateHead.trim(), detachedIncoming));
  lanes.push(exactLane("ref-scope", args.pending.refScope, args.candidateScope));
  const pendingOp = args.pending.opState === undefined ? undefined : sectionOpState(args.pending);
  lanes.push(pendingOp === undefined
    ? { lane: "op-state", disposition: "subsumed", detail: "no incoming operation-state lane" }
    : exactLane("op-state", pendingOp, args.candidateOpState));
  if (args.pending.config === undefined) {
    lanes.push({ lane: "config", disposition: "subsumed", detail: "no incoming config lane" });
  } else if (args.candidateConfig.ownership === "indeterminate" || args.candidateConfig.read === "failed" || args.candidateConfig.read === "over-bounds") {
    lanes.push({ lane: "config", disposition: "indeterminate", detail: "local config could not be read and owned completely" });
  } else {
    lanes.push(exactLane("config", gitConfigHash(args.pending.config), args.candidateConfig.read === "ok" ? args.candidateConfig.hash : undefined));
  }
  return { lanes, forceRequired: lanes.some((lane) => lane.disposition === "not-subsumed") };
}

/** Best-effort preliminary P→LIVE report used only for confirmation UX. */
export async function preliminaryResolutionReport(args: {
  ctx: RepoCtx;
  pending: GitSection;
  binding: GitResolutionBinding;
  store: GitArtifactReadStore;
  kek: Buffer;
}): Promise<ResolutionDiscardReport> {
  const pendingIndex = await pendingIndexProjection(args.ctx, args.pending, args.store, args.kek);
  const candidateIndex = args.binding.index;
  // The binding deliberately retains the full show-me ref/reflog evidence. The
  // preliminary candidate must instead match captureGitState's exact namespace:
  // dir/all sees every syncable ref; pointer/scoped sees only its HEAD branch.
  const liveRefs = Object.fromEntries(args.binding.refs);
  const candidateRefs = args.binding.effectiveRefScope === "all"
    ? liveRefs
    : (() => {
        const current = /^ref:\s*(refs\/heads\/\S+)\s*$/.exec(args.binding.head)?.[1];
        const oid = current === undefined ? undefined : liveRefs[current];
        return current !== undefined && oid !== undefined ? { [current]: oid } : {};
      })();
  const preliminary = await reportCore({
    ctx: args.ctx,
    pending: args.pending,
    candidateRefs,
    candidateHead: args.binding.head,
    candidateScope: args.binding.effectiveRefScope,
    candidateOpState: Object.fromEntries(args.binding.opState),
    candidateConfig: args.binding.config,
  });
  const indexLane: ResolutionLaneReport = pendingIndex.kind === "absent"
    ? { lane: "index", disposition: "subsumed", detail: "no incoming index lane" }
    : pendingIndex.kind === "indeterminate" || candidateIndex.kind === "indeterminate"
      ? { lane: "index", disposition: "indeterminate", detail: "index content could not be proven" }
      : exactLane("index", indexLaneValue(pendingIndex), indexLaneValue(candidateIndex));
  preliminary.lanes.push(indexLane);
  preliminary.forceRequired ||= indexLane.disposition === "not-subsumed";
  return preliminary;
}

/** Authoritative report over the exact final normalized publish candidate. */
export async function finalResolutionReport(args: {
  ctx: RepoCtx;
  pending: GitSection;
  candidate: GitSection;
  store: GitArtifactReadStore;
  kek: Buffer;
}): Promise<ResolutionDiscardReport> {
  const [pendingIndex, candidateIndex, opStateOids] = await Promise.all([
    pendingIndexProjection(args.ctx, args.pending, args.store, args.kek),
    pendingIndexProjection(args.ctx, args.candidate, args.store, args.kek),
    pendingOpStateOids(args.ctx, args.pending, args.store, args.kek),
  ]);
  const config: GitResolutionBinding["config"] = args.candidate.config === undefined
    ? { ownership: "owned", read: "not-owned" }
    : { ownership: "owned", read: "ok", hash: gitConfigHash(args.candidate.config) };
  const report = await reportCore({
    ctx: args.ctx,
    pending: args.pending,
    candidateRefs: args.candidate.refs,
    candidateHead: args.candidate.head,
    candidateScope: args.candidate.refScope,
    candidateOpState: sectionOpState(args.candidate),
    candidateConfig: config,
  });
  const indexLane: ResolutionLaneReport = pendingIndex.kind === "absent"
    ? { lane: "index", disposition: "subsumed", detail: "no incoming index lane" }
    : pendingIndex.kind === "indeterminate" || candidateIndex.kind === "indeterminate"
      ? { lane: "index", disposition: "indeterminate", detail: "index content could not be proven" }
      : exactLane("index", indexLaneValue(pendingIndex), indexLaneValue(candidateIndex), [
          ...pendingIndex.oids,
          ...(/^[0-9a-f]{40}$/.test(args.pending.indexTree ?? "") ? [args.pending.indexTree!] : []),
        ]);
  report.lanes.push(indexLane);
  const opStateLane = report.lanes.find((lane) => lane.lane === "op-state");
  if (opStateLane && args.pending.opState !== undefined) {
    if (opStateOids === undefined) {
      opStateLane.disposition = "indeterminate";
      opStateLane.detail = "incoming operation-state roots could not be verified";
    } else if (opStateOids.length > 0) {
      opStateLane.incomingOids = opStateOids;
    }
  }
  report.forceRequired ||= indexLane.disposition === "not-subsumed";
  return report;
}

export function reportAuthorized(authorizedLanes: readonly string[], report: ResolutionDiscardReport): boolean {
  const authorized = new Set(authorizedLanes);
  // An indeterminate branch lane (ancestry unprovable because the incoming oid
  // no longer resolves anywhere) is acceptable only when the user already
  // confirmed discarding that exact lane in the preview; branch lanes always
  // carry their pending oid, so preservation via discardedIncomingOids still
  // holds. Index/op-state indeterminacy loses the oid enumeration entirely, so
  // those lanes keep refusing — preservation completeness cannot be shown.
  return report.lanes.every((lane) => lane.disposition === "subsumed"
    || (lane.disposition === "not-subsumed" && authorized.has(lane.lane))
    || (lane.disposition === "indeterminate" && lane.lane.startsWith("branch:refs/heads/") && authorized.has(lane.lane)));
}

export function discardedIncomingOids(report: ResolutionDiscardReport): string[] {
  return [...new Set(report.lanes
    .filter((lane) => lane.disposition === "not-subsumed" || lane.disposition === "indeterminate")
    .flatMap((lane) => lane.incomingOids ?? []))].sort();
}
