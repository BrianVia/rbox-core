/**
 * The plain-English story a paused Git repo tells (design 273 §"Story
 * vocabulary").
 *
 * A `GitDeferralReason` is an internal cause code. A story is what a user
 * WITHOUT an LLM reads: what happened, what to do, and whether rbox is already
 * handling it. The map below is closed over every reason, so a future reason
 * cannot ship without a human sentence — the same discipline the reason
 * presentation table beside it uses.
 *
 * Story codes are render-side only. `reason` remains the machine contract on
 * every JSON surface; nothing here is persisted or sent on the wire.
 *
 * Banned on this surface (design 273 product bar): "index", "deferral", "held",
 * "quarantine", "dry run", unexplained "overlap", and raw reason codes. The
 * noun for a device is "computer".
 */
import type { GitDeferralReason } from "../sync-state-model.js";

export type GitStoryCode =
  | "local-edits"
  | "local-staged"
  | "local-commits"
  | "local-stash"
  | "unfinished-git-operation"
  | "branch-in-use-elsewhere"
  | "both-changed"
  | "conflict-copies"
  | "sync-interrupted"
  | "sync-download-failed"
  | "settle-failed"
  | "repo-unreadable"
  | "busy"
  | "other";

export interface GitStory {
  code: GitStoryCode;
  /** Group header copy: the whole answer to "what happened", in one clause. */
  headline: string;
  /** What the reader does about it. Absent when only rbox acts. */
  action?: string;
  /** false = rbox finishes this on its own and never asks for a decision. */
  needsYou: boolean;
}

const story = (code: GitStoryCode, headline: string, needsYou: boolean, action?: string): GitStory =>
  action === undefined ? { code, headline, needsYou } : { code, headline, action, needsYou };

const LOCAL_EDITS = story("local-edits", "you changed files here that were never synced", true);
const LOCAL_STAGED = story("local-staged", "you have work staged for a commit here", true);
const LOCAL_COMMITS = story("local-commits", "this computer has commits your other computers never got", true);
const LOCAL_STASH = story("local-stash", "you have stashed work here (git stash)", true);
const UNFINISHED = story(
  "unfinished-git-operation",
  "a git operation (like a rebase or merge) was left half-finished here",
  true,
);
const BRANCH_IN_USE = story(
  "branch-in-use-elsewhere",
  "another copy of this repo (a git worktree) is using the branch rbox needs to update, so rbox left it alone",
  false,
  "switch that other worktree to a different branch and rbox finishes on its own; no command needed",
);
const BOTH_CHANGED = story("both-changed", "this repo changed on two computers at once", true);
const CONFLICT_COPIES = story(
  "conflict-copies",
  "the only files left here are the backup copies rbox made when two computers changed the same file — there is nothing left to compare",
  true,
  "open or delete those conflict files, then rbox retries by itself",
);
const SYNC_INTERRUPTED = story("sync-interrupted", "a sync stopped partway through — rbox retries this on its own", false);
const SYNC_DOWNLOAD_FAILED = story(
  "sync-download-failed",
  "rbox couldn't finish downloading the other computer's version — nothing here changed",
  false,
);
const SETTLE_FAILED = story(
  "settle-failed",
  "the last sync got most of the way and then stopped — your earlier state was saved first",
  false,
);
const REPO_UNREADABLE = story("repo-unreadable", "rbox can't read or manage this repo right now", true);
const BUSY = story("busy", "git was busy here — rbox retries on its own", false);
const OTHER = story("other", "rbox stopped syncing this repo for an unusual reason", true);

/**
 * The one detail shape that upgrades an `artifact` pause to "your earlier state
 * was saved first". FAIL-CLOSED by construction: the claim is only ever printed
 * when the writing site typed BOTH that the failure happened after the apply
 * settled AND the backup directory it wrote. No site emits this today — the
 * fetch/verify failures that dominate `artifact` genuinely changed nothing —
 * so the reassuring sentence stays unreachable until a settle-lane writer earns
 * it. Owner: the artifact deferral sites. Deletion condition: the settle lane
 * gaining its own `GitDeferralReason`.
 */
const SETTLE_DETAIL_PREFIX = "post-apply-settle-failed: ";
const BACKUP_PATH = /(^|[^\w/])\.rbox\/git-quarantine\/[^\s"']+/;

export function detailProvesPostApplySettle(detail: string | undefined): boolean {
  return detail !== undefined && detail.startsWith(SETTLE_DETAIL_PREFIX) && BACKUP_PATH.test(detail);
}

/** Closed over `GitDeferralReason`: the compiler forces every future reason to
 * pick a story rather than fall silently into `other`. */
const GIT_STORIES = {
  "local-edits": LOCAL_EDITS,
  "local-index": LOCAL_STAGED,
  "local-commits": LOCAL_COMMITS,
  "local-stash": LOCAL_STASH,
  "local-operation": UNFINISHED,
  "worktree-ownership": BRANCH_IN_USE,
  conflict: BOTH_CHANGED,
  "conflict-copies": CONFLICT_COPIES,
  "deletion-pending": SYNC_INTERRUPTED,
  artifact: (detail?: string) => (detailProvesPostApplySettle(detail) ? SETTLE_FAILED : SYNC_DOWNLOAD_FAILED),
  unreadable: REPO_UNREADABLE,
  "ref-read-unreadable": REPO_UNREADABLE,
  config: REPO_UNREADABLE,
  containment: REPO_UNREADABLE,
  "ignored-target": REPO_UNREADABLE,
  unsupported: REPO_UNREADABLE,
  "git-busy": BUSY,
  "stale-unattributed": BUSY,
  other: OTHER,
} satisfies Record<GitDeferralReason, GitStory | ((detail?: string) => GitStory)>;

/** The story for a reason code. Unknown reasons — a record written by a newer
 * rbox — read as `other` rather than leaking the code to a human surface. */
export function gitStoryFor(reason: string, detail?: string): GitStory {
  const entry = (GIT_STORIES as Record<string, GitStory | ((detail?: string) => GitStory) | undefined>)[reason];
  if (entry === undefined) return OTHER;
  return typeof entry === "function" ? entry(detail) : entry;
}

/** Words that must never reach a human Git surface (design 273 product bar).
 * Exported so the fixture replay suite and any future surface share one list. */
export const BANNED_HUMAN_WORDS = [
  "deferral",
  "deferred",
  "quarantine",
  "dry run",
  "git index",
  "the index",
] as const;
