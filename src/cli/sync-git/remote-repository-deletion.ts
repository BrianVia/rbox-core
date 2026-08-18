/** Never: local `.git` mutation, BASE minting, durable state persistence, or reading sync state directly. */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type GitRefScope, type GitSection } from "../../engine/index.js";
import { assertGitTargetWithinRoot } from "./containment.js";
import { gitIdentityKey, type GitIdentity } from "./identity.js";
import { openAdoptDirectory } from "../adopt-fs.js";
import { carryRepoBaseProof, type RepoBaseProof } from "./base-composer.js";
import { errMsg, localDivergedFromBase, projectedKey } from "./shared.js";

const directoryOpenFlags =
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

function directoryFdPath(fd: number, leaf?: string): string {
  const root = process.platform === "linux" ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`;
  return leaf === undefined ? root : path.join(root, leaf);
}

async function pinnedDirectoryStillBound(
  root: string,
  rel: string,
  held: fs.FileHandle,
): Promise<boolean> {
  const reopened = await openAdoptDirectory(root, rel, false).catch(() => undefined);
  if (!reopened) return false;
  try {
    const [expected, actual] = await Promise.all([
      held.stat({ bigint: true }),
      reopened.stat({ bigint: true }),
    ]);
    return expected.dev === actual.dev && expected.ino === actual.ino;
  } finally {
    await reopened.close().catch(() => {});
  }
}

export interface RepoSkeletonSweepOptions {
  /** Tests only: receives the already-pinned parent handle and a single safe leaf. */
  rmdir?: (parent: fs.FileHandle, leaf: string) => Promise<void>;
}

/**
 * Best-effort, bottom-up removal of directories that rmdir itself proves empty.
 * Every traversal component is opened no-follow and every rmdir is relative to a
 * verified pinned parent handle. Files, symlinks, and non-empty directories are
 * never removed.
 */
export async function sweepRemovedRepoSkeleton(
  root: string,
  rel: string,
  options: RepoSkeletonSweepOptions = {},
): Promise<void> {
  if (rel === ".") return;
  const parts = rel.split("/");
  if (
    path.isAbsolute(rel)
    || rel.includes("\\")
    || rel.includes("\0")
    || parts.some((part) => !part || part === "." || part === "..")
  ) return;

  const remove = options.rmdir
    ?? ((parent: fs.FileHandle, leaf: string) => fs.rmdir(directoryFdPath(parent.fd, leaf)));

  const sweepChild = async (
    parent: fs.FileHandle,
    parentRel: string,
    leaf: string,
  ): Promise<void> => {
    const childRel = parentRel ? `${parentRel}/${leaf}` : leaf;
    try {
      await assertGitTargetWithinRoot(root, childRel);
      if (!await pinnedDirectoryStillBound(root, parentRel, parent)) return;
      const child = await fs.open(directoryFdPath(parent.fd, leaf), directoryOpenFlags);
      try {
        const entries = await fs.readdir(directoryFdPath(child.fd), { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory()) continue;
          // Retained Git and rbox recovery state are opaque. Their presence
          // vetoes ancestor rmdir through ENOTEMPTY, and even empty internals
          // must remain byte-for-byte untouched.
          if (entry.name === ".git" || entry.name === ".rbox") continue;
          await sweepChild(child, childRel, entry.name);
        }
      } finally {
        await child.close().catch(() => {});
      }
      if (!await pinnedDirectoryStillBound(root, parentRel, parent)) return;
      await remove(parent, leaf);
    } catch {
      // A failed open/identity check/rmdir vetoes only this subtree. In
      // particular ENOTEMPTY, ENOTDIR, EACCES, and concurrent changes are
      // ordinary residue, not pull failures.
    }
  };

  try {
    await assertGitTargetWithinRoot(root, rel);
    const leaf = parts.pop()!;
    const parentRel = parts.join("/");
    const parent = await openAdoptDirectory(root, parentRel, false);
    try {
      await sweepChild(parent, parentRel, leaf);
    } finally {
      await parent.close().catch(() => {});
    }
  } catch {
    // Removal cleanup is deliberately best effort.
  }
}

/**
 * The exact repository and wire input this deletion is bound to. `incoming` is
 * the absence witness: a present remote section is never this transition, so a
 * plan can only ever authorize the removal path.
 */
export interface RemoteRepositoryDeletionIdentity {
  readonly root: string;
  readonly relPath: string;
  readonly repoDir: string;
  readonly incoming: "absent";
}

/** Everything the planner may observe. All of it is already-read evidence: the
 * planner performs no I/O and reaches no shared mutable state. */
export interface RemoteRepositoryDeletionInput {
  readonly identity: RemoteRepositoryDeletionIdentity;
  /** The in-flight incoming section this absence supersedes, if any. */
  readonly pendingSection: GitSection | undefined;
  /** The durable BASE section, if any. */
  readonly baseSection: GitSection | undefined;
  /** Live local Git identity; undefined for no/unreadable/empty repository. */
  readonly localIdentity: GitIdentity | undefined;
  /** Whether the receiver's Git was locked when `localIdentity` was read. */
  readonly gitBusy: boolean;
  /** Shape of the on-disk leftover, or undefined when nothing remains. */
  readonly leftover: GitRefScope | undefined;
  /** Whether a BASE section is currently applied for this repository. */
  readonly baseApplied: boolean;
  /** Retained branch-base lineage for the carry proof. */
  readonly originLineage: string | undefined;
}

/**
 * The complete repo transition remote absence produces. Every field is a final
 * value, not a delta: an executor applies all of them or none of them. Absence
 * is the newer truth, so each in-flight input is cleared unconditionally.
 */
export interface RemoteRepositoryDeletionTransition {
  /** The applied BASE slot for this repository; absent after deletion.
   * Named for the sidecar slot, not `base`, so the design-130 BASE-write
   * allowlist keeps flagging only genuine persisted BASE writes. */
  readonly appliedBase: null;
  readonly pending: null;
  readonly resolution: null;
  readonly deferrals: null;
  readonly partial: null;
  readonly heldAttempt: null;
  readonly indexProjection: null;
  /** Resurrection guard for an on-disk leftover; null when nothing remains. */
  readonly removedKey: string | null;
  readonly proof: RepoBaseProof;
}

export interface BoundRemoteRepositoryDeletionPlan {
  readonly identity: RemoteRepositoryDeletionIdentity;
  readonly transition: RemoteRepositoryDeletionTransition;
  /** Emitted exactly when a BASE section was dropped. */
  readonly removalAnnouncement: string | undefined;
  /** Fail-closed: a journal-clear failure reverts `transition` and rethrows. */
  readonly journalClear: "required";
  /** Attempted after the journal clear and never an input to the disposition. */
  readonly skeletonSweep: "best-effort";
  /** Design 43 §13.5 advisory preservation of the superseded pending section. */
  readonly conflictPreservation: { readonly section: GitSection } | undefined;
}

export interface RemoteRepositoryDeletionReceipt {
  readonly identity: RemoteRepositoryDeletionIdentity;
  readonly transition: RemoteRepositoryDeletionTransition;
  /** A receipt exists only for a successful required clear. */
  readonly journalCleared: true;
  readonly skeletonSweep: "attempted";
  readonly conflictPreservation: "not-required" | "preserved" | "failed";
  /** The transition may be committed by a later durable CAS. */
  readonly eligibleForCommit: true;
}

/** Undo handle returned by a commit; restores every touched key byte-exact. */
export type RemoteRepositoryDeletionRevert = () => void;

/**
 * The effect vocabulary of this transition. It is deliberately total: nothing
 * here can mutate the local repository's `.git`, which is the design-207
 * guarantee that a genuinely deleted remote repo leaves local Git untouched.
 */
export interface RemoteRepositoryDeletionEffects {
  /** The repository this port is bound to; a plan for another is refused. */
  readonly identity: RemoteRepositoryDeletionIdentity;
  /** Applies the whole transition to the sidecar lanes and returns its undo. */
  commit(transition: RemoteRepositoryDeletionTransition): RemoteRepositoryDeletionRevert;
  beforeCleanup?(): Promise<void>;
  clearJournal(): Promise<void>;
  sweepSkeleton(): Promise<void>;
  preservePending(section: GitSection): Promise<{ recoveryBundle?: string }>;
  log(message: string): void;
}

export class RemoteRepositoryDeletionIdentityMismatch extends Error {
  constructor(plan: RemoteRepositoryDeletionIdentity, port: RemoteRepositoryDeletionIdentity) {
    super(`remote repository deletion plan for ${plan.root}/${plan.relPath} cannot execute against ${port.root}/${port.relPath}`);
    this.name = "RemoteRepositoryDeletionIdentityMismatch";
  }
}

function sameDeletionIdentity(
  left: RemoteRepositoryDeletionIdentity,
  right: RemoteRepositoryDeletionIdentity,
): boolean {
  return left.root === right.root
    && left.relPath === right.relPath
    && left.repoDir === right.repoDir
    && left.incoming === right.incoming;
}

/**
 * Design 43 §9 removal plus [v6] absence-supersedes-pending. The divergence
 * examination is decided here, before any effect, so a removal memory is never
 * stamped over unexamined local divergence (§13.5).
 */
export function planRemoteRepositoryDeletion(
  input: RemoteRepositoryDeletionInput,
): BoundRemoteRepositoryDeletionPlan {
  const diverged = input.pendingSection !== undefined
    && localDivergedFromBase(input.localIdentity, input.baseSection);
  // Resurrection guard [v2, B4]: the leftover's identity at removal. On a BUSY
  // repo the live identity is the volatile raw-index fallback — record the base
  // section's identity instead (projected onto the leftover's shape), which is
  // lock-immune and equals the live identity whenever the leftover is untouched.
  const removedKey = input.leftover === undefined
    ? null
    : input.gitBusy && input.baseSection
      ? projectedKey(input.baseSection, input.leftover)
      : gitIdentityKey(input.localIdentity);
  return {
    identity: input.identity,
    transition: {
      appliedBase: null,
      pending: null,
      resolution: null,
      deferrals: null,
      partial: null,
      heldAttempt: null,
      indexProjection: null,
      removedKey,
      proof: carryRepoBaseProof(input.originLineage ?? "legacy-untrusted"),
    },
    removalAnnouncement: input.baseApplied
      ? `git-sync removed ${input.identity.relPath} (remote deleted; local .git untouched). Your local Git repository is safe.`
      : undefined,
    journalClear: "required",
    skeletonSweep: "best-effort",
    conflictPreservation: diverged && input.pendingSection ? { section: input.pendingSection } : undefined,
  };
}

/**
 * The transition applies UNCONDITIONALLY and before every effect: absence is
 * the newer truth no matter what else succeeds. Only the journal clear is
 * required — its failure reverts the whole transition and rethrows, so a crash
 * window can never leave a stale pending/base entry for the next push to
 * resurrect. The skeleton sweep still runs on that path (it is anchored,
 * rmdir-only, and independent of the journal), and advisory preservation does
 * not: there is no durable removal for it to accompany.
 */
export async function executeRemoteRepositoryDeletion(
  plan: BoundRemoteRepositoryDeletionPlan,
  effects: RemoteRepositoryDeletionEffects,
): Promise<RemoteRepositoryDeletionReceipt> {
  if (!sameDeletionIdentity(plan.identity, effects.identity)) {
    throw new RemoteRepositoryDeletionIdentityMismatch(plan.identity, effects.identity);
  }
  const revert = effects.commit(plan.transition);
  if (plan.removalAnnouncement !== undefined) effects.log(plan.removalAnnouncement);
  await effects.beforeCleanup?.();

  let journalClearError: unknown;
  try {
    await effects.clearJournal();
  } catch (error) {
    journalClearError = error;
  }
  await effects.sweepSkeleton();
  if (journalClearError) {
    revert();
    throw journalClearError;
  }

  // Best-effort — preserve never mutates local branches/index/identity, so a
  // failure loses only the convenience recovery bundle (logged loudly); the
  // user's diverged local work is untouched either way. (On a busy repo the
  // raw-index fallback can only over-trigger this — a safe, logged no-clobber.)
  let conflictPreservation: RemoteRepositoryDeletionReceipt["conflictPreservation"] = "not-required";
  const preserved = plan.conflictPreservation;
  if (preserved) {
    try {
      const { recoveryBundle } = await effects.preservePending(preserved.section);
      effects.log(
        `git-sync CONFLICT ${plan.identity.relPath} — remote deleted the repo while an apply was pending and local diverged; local kept, pending remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}. Your local Git work is safe; inspect the preserved incoming state before resolving.`
      );
      conflictPreservation = "preserved";
    } catch (error) {
      effects.log(`git-sync WARNING ${plan.identity.relPath}: could not preserve the pending remote section after the remote deletion (local work untouched): ${errMsg(error)}`);
      conflictPreservation = "failed";
    }
  }

  return {
    identity: plan.identity,
    transition: plan.transition,
    journalCleared: true,
    skeletonSweep: "attempted",
    conflictPreservation,
    eligibleForCommit: true,
  };
}
