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

/**
 * What a group of repos telling this story offers the reader — story-table DATA,
 * so no renderer carries a per-story branch. Each kind is a complete policy:
 *
 * - `resolve` — the keep-mine / take-theirs command block, printed only when
 *   EVERY repo in the group is `resolvable` (the projection's one predicate).
 * - `repair-text` — the fix depends on which read failed, so the row's own
 *   curated repair sentence is the action. NEVER a resolve command: a repo rbox
 *   cannot read would refuse one.
 * - `self-healing` — rbox retries by itself; the surface says so once, and
 *   escalates when the retrying has gone on too long.
 * - `support` — rbox cannot name the condition, so the honest action is to hand
 *   it to a human who can read the report. Never a dead end.
 * - `instruction` — one literal sentence that fully answers "what do I do".
 */
export type GitStoryAction =
  | { kind: "resolve" }
  | { kind: "repair-text" }
  | { kind: "self-healing" }
  | { kind: "support" }
  | { kind: "instruction"; text: string };

export interface GitStory {
  code: GitStoryCode;
  /** Group header copy: the whole answer to "what happened", in one clause. */
  headline: string;
  /** The same clause about more than one repo. Absent when `headline` already
   * reads correctly for any count. */
  headlinePlural?: string;
  action: GitStoryAction;
  /** false = rbox finishes this on its own and never asks for a decision. */
  needsYou: boolean;
}

const RESOLVE: GitStoryAction = { kind: "resolve" };
const SELF_HEALING: GitStoryAction = { kind: "self-healing" };

interface StoryInput {
  headline: string;
  plural?: string;
  needsYou: boolean;
  action: GitStoryAction;
}

const story = (code: GitStoryCode, input: StoryInput): GitStory => ({
  code,
  headline: input.headline,
  ...(input.plural === undefined ? {} : { headlinePlural: input.plural }),
  action: input.action,
  needsYou: input.needsYou,
});

/** The one literal sentence a story hands the reader, when it has one. Stories
 * whose action is a command block or a per-row repair have none. */
export const storyInstruction = (story: GitStory): string | undefined =>
  story.action.kind === "instruction" ? story.action.text : undefined;

/** The header a group of `count` repos prints. Every story reads correctly at
 * one repo and at many — a header that disagrees in number is the tell that a
 * surface is showing a count it never really understood. */
export function storyHeadline(story: GitStory, count: number): string {
  return count === 1 ? story.headline : story.headlinePlural ?? story.headline;
}

const LOCAL_EDITS = story("local-edits", {
  headline: "you changed files here that were never synced",
  needsYou: true,
  action: RESOLVE,
});
// FOUNDER-SET copy (2026-08-17): "staged for a commit" named a git concept most
// readers do not hold, and the same pause fires for a half-finished rebase.
const LOCAL_STAGED = story("local-staged", {
  headline: "you have uncommitted work here",
  needsYou: true,
  action: RESOLVE,
});
const LOCAL_COMMITS = story("local-commits", {
  headline: "this computer has commits your other computers never got",
  needsYou: true,
  action: RESOLVE,
});
const LOCAL_STASH = story("local-stash", {
  headline: "you have stashed work here (git stash)",
  needsYou: true,
  action: RESOLVE,
});
const UNFINISHED = story("unfinished-git-operation", {
  headline: "a git operation (like a rebase or merge) was left half-finished here",
  plural: "git operations (like a rebase or merge) were left half-finished here",
  needsYou: true,
  action: RESOLVE,
});
const BRANCH_IN_USE = story("branch-in-use-elsewhere", {
  headline: "another copy of this repo (a git worktree) is using the branch rbox needs to update, so rbox left it alone",
  plural: "other copies of these repos (git worktrees) are using the branches rbox needs to update, so rbox left them alone",
  needsYou: false,
  action: { kind: "instruction", text: "switch that other worktree to a different branch and rbox finishes on its own; no command needed" },
});
const BOTH_CHANGED = story("both-changed", {
  headline: "this repo changed on two computers at once",
  plural: "each of these changed on two computers at once",
  needsYou: true,
  action: RESOLVE,
});
const CONFLICT_COPIES = story("conflict-copies", {
  headline: "the only files left here are the backup copies rbox made when two computers changed the same file — there is nothing left to compare",
  needsYou: true,
  action: { kind: "instruction", text: "open or delete those conflict files, then rbox retries by itself" },
});
// The "rbox retries this on its own" reassurance belongs to the group's one
// handling line, not to every headline that would then say it twice.
const SYNC_INTERRUPTED = story("sync-interrupted", {
  headline: "a sync stopped partway through",
  plural: "syncs stopped partway through",
  needsYou: false,
  action: SELF_HEALING,
});
const SYNC_DOWNLOAD_FAILED = story("sync-download-failed", {
  headline: "rbox couldn't finish downloading the other computer's version — nothing here changed",
  needsYou: false,
  action: SELF_HEALING,
});
const SETTLE_FAILED = story("settle-failed", {
  headline: "the last sync got most of the way and then stopped — your earlier state was saved first",
  needsYou: false,
  action: SELF_HEALING,
});
const REPO_UNREADABLE = story("repo-unreadable", {
  headline: "rbox can't read or manage this repo right now",
  plural: "rbox can't read or manage them right now",
  needsYou: true,
  action: { kind: "repair-text" },
});
const BUSY = story("busy", {
  headline: "git was busy here",
  needsYou: false,
  action: SELF_HEALING,
});
const OTHER = story("other", {
  headline: "rbox stopped syncing this repo for an unusual reason",
  plural: "rbox stopped syncing these for an unusual reason",
  needsYou: true,
  action: { kind: "support" },
});

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

const isStoriedReason = (reason: string): reason is keyof typeof GIT_STORIES =>
  Object.hasOwn(GIT_STORIES, reason);

/** The story for a reason code. Unknown reasons — a record written by a newer
 * rbox — read as `other` rather than leaking the code to a human surface. */
export function gitStoryFor(reason: string, detail?: string): GitStory {
  if (!isStoriedReason(reason)) return OTHER;
  const entry = GIT_STORIES[reason];
  return entry instanceof Function ? entry(detail) : entry;
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
