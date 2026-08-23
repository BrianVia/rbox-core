/**
 * The evidence a resolve decision is made from.
 *
 * `buildSnapshot` stages the incoming bundle, proves which local commits the
 * publisher does not already own, compares working files, index, operation
 * state and stash, and reduces all of it to one {@link ResolveSnapshot}: a
 * public report for the human, a binding identity, the protected OIDs a
 * take-theirs must pin, and the reasons a manual resolution waives.
 *
 * The snapshot id derived here is the confirmation token every mutating verb
 * re-checks, so this module owns what "the same state I showed you" means.
 */
import { buildIgnoreMatcher, oracleFromState, type AppliedManifestOracle, type BlobStore, type GitSection } from "../../engine/index.js";
import { git } from "../../engine/git-spawn.js";
import { hashBytes } from "../../engine/hash.js";
import type { GitDeferralReason, GitResolutionBinding, RepoRecord, SyncState, WorkspaceConfig } from "../config.js";
import { branchesCheckedOutElsewhereStrict } from "../sync-git/git-state-apply.js";
import { type RepoCtx } from "../sync-git/git-state.js";
import { stageIncoming } from "../sync-git/follow.js";
import { incomingOwnershipRoots, partitionOwnedByIncoming } from "../sync-git/reachability.js";
import { resolutionBindingIdentity } from "../sync-git/resolution-intent.js";
import { checkoutLabel, sectionOpState } from "../sync-git/shared.js";
import { hasGitResolutionIncoming } from "../status-view/git-projection.js";
import type { GitResolveShow } from "./resolve-presentation.js";

export async function strictOwnedBranches(ctx: RepoCtx): Promise<Map<string, string>> {
  const result = await branchesCheckedOutElsewhereStrict(ctx);
  if (result.status === "unreadable") throw result.cause;
  return result.owned;
}

export type HumanReason = Extract<GitDeferralReason,
  "local-edits" | "local-index" | "local-operation" | "local-commits" | "local-stash">;

export type SnapshotIdentity = GitResolutionBinding;

export interface ResolveSnapshot {
  public: GitResolveShow;
  identity: SnapshotIdentity;
  protectedOids: string[];
  waivedReasons: HumanReason[];
  proofIndeterminate: boolean;
  oracle: AppliedManifestOracle;
}

function sortedEntries(value: Record<string, string>): Array<[string, string]> {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
}

function snapshotId(identity: SnapshotIdentity): string {
  return hashBytes(Buffer.from(JSON.stringify(identity)));
}

export function incomingFor(record: RepoRecord | undefined): GitSection | undefined {
  if (!hasGitResolutionIncoming(record)) return undefined;
  if (record?.pending) return record.pending;
  return record?.base;
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(sortedEntries(a)) === JSON.stringify(sortedEntries(b));
}

export async function buildSnapshot(args: {
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
    ignorePaths: args.cfg.ignorePaths ?? [],
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
