/**
 * The human Git-pause surfaces (design 273 S1/S2/S3): the status headline, the
 * grouped `rbox status --git` listing, and doctor's summary block.
 *
 * All three read the SAME projection rows, so the headline count, the group
 * sums and the `--json` record count cannot disagree — that disagreement (103
 * vs 52) is the defect this module exists to close. Nothing here spawns git or
 * reads state; it is a pure function of rows the projection already decided.
 *
 * What each group OFFERS is story-table data (`story.action`), never a branch
 * here: this module renders a policy, it does not decide one. The single
 * question it may not answer for itself — may this repo be handed a resolve
 * command — is answered once by the projection's `resolvable`.
 *
 * Repo paths render in FULL here — the one identifier the reader needs — merely
 * sanitized. That is deliberately the opposite of the daemon log line in
 * `git-render.ts`, whose head-truncation is part of a frozen redaction contract.
 */
import type { GitDeferralRepoProjection } from "./git-projection.js";
import { evidenceRisk, type GitRepoEvidence } from "./git-evidence.js";
import { evidenceRowSuffix } from "./git-evidence-render.js";
import { storyHeadline } from "./git-stories.js";
import { boundedCuratedDetail, sanitizeTerminalText, truncateDetail } from "./text.js";

/** The evidence reading for one row, when the caller computed any. Absent for
 * every surface that must stay git-free, and for repos whose evidence degraded. */
export type EvidenceLookup = (row: GitDeferralRepoProjection) => GitRepoEvidence | undefined;

/** Rows a human surface shows: the quiet transients are still real, just not
 * worth interrupting anyone over (design 273 P5). */
export const loudRows = (rows: readonly GitDeferralRepoProjection[]): GitDeferralRepoProjection[] =>
  rows.filter((row) => !row.quiet);

export interface GitPauseCounts {
  needsYou: number;
  selfHealing: number;
  total: number;
}

export function gitPauseCounts(rows: readonly GitDeferralRepoProjection[]): GitPauseCounts {
  const needsYou = rows.filter((row) => row.story.needsYou).length;
  return { needsYou, selfHealing: rows.length - needsYou, total: rows.length };
}

const repos = (count: number): string => `${count} repo${count === 1 ? "" : "s"}`;

const DAY_MS = 86_400_000;

/** "paused 3 days" / "paused 2 hours" / "paused (since unknown)". The shared
 * `ageBucket` clips to coarse floors ("1d" for a three-day wait), which reads as
 * a measurement and understates every chronic pause. */
export function pausedFor(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at > now) return "paused (since unknown)";
  const seconds = Math.floor((now - at) / 1000);
  const say = (value: number, unit: string): string => `paused ${value} ${unit}${value === 1 ? "" : "s"}`;
  if (seconds < 90) return "paused just now";
  if (seconds < 5400) return say(Math.round(seconds / 60), "minute");
  if (seconds < 86_400) return say(Math.round(seconds / 3600), "hour");
  return say(Math.floor(seconds / 86_400), "day");
}

/**
 * S1: the two-number split every glance surface shows. `undefined` when nothing
 * is paused. Never claims "changes you made" for the self-healing family, and
 * never warns about a population that is only sorting itself out.
 */
export function gitPauseHeadline(
  { needsYou, selfHealing, listed }: Omit<GitPauseCounts, "total"> & { listed?: boolean },
): string[] {
  if (needsYou === 0 && selfHealing === 0) return [];
  // The pointer is for readers who cannot see the list. Printing it directly
  // above the list it points at is the surface telling someone to go where they
  // already are.
  const pointer = listed ? [] : ["  See them:  rbox status --git"];
  if (needsYou === 0) {
    return [`rbox paused git sync in ${repos(selfHealing)} and is sorting ${selfHealing === 1 ? "it" : "them"} out on its own.`, ...pointer];
  }
  const healing = selfHealing > 0
    ? ` ${selfHealing} more ${selfHealing === 1 ? "is" : "are"} sorting ${selfHealing === 1 ? "itself" : "themselves"} out.`
    : "";
  return [
    `⚠ ${repos(needsYou)} ${needsYou === 1 ? "is" : "are"} waiting on you — rbox paused git sync there so nothing you did gets overwritten.${healing}`,
    ...pointer,
  ];
}

// Resolvability is part of the key because a group prints only commands EVERY
// repo in it supports (design 273 S2). Keying without it made one unresolvable
// row silence the commands for the whole group; keying with it SPLITS the
// group, and the half that can act keeps its instructions.
const groupKey = (row: GitDeferralRepoProjection): string =>
  `${row.story.code}|${row.story.needsYou ? "you" : "rbox"}|${row.resolvable ? "can" : "cannot"}`;

interface StoryGroup {
  rows: GitDeferralRepoProjection[];
  story: GitDeferralRepoProjection["story"];
  resolvable: boolean;
}

/** Groups by (story, actionability, resolvability). Within a group the repos
 * where BOTH computers touched the same files lead — that is the number a person
 * is actually deciding on — and age breaks the tie, which is the whole order for
 * a group whose repos carry no reading. */
export function groupByStory(
  rows: readonly GitDeferralRepoProjection[],
  now: number,
  evidence?: EvidenceLookup,
): StoryGroup[] {
  const groups = new Map<string, StoryGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key) ?? { rows: [], story: row.story, resolvable: row.resolvable };
    group.rows.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.rows.sort((a, b) =>
      evidenceRisk(evidence?.(b)) - evidenceRisk(evidence?.(a))
      || pausedAt(a, now) - pausedAt(b, now)
      || a.repo.localeCompare(b.repo));
  }
  return [...groups.values()].sort((a, b) =>
    Number(a.story.needsYou ? 0 : 1) - Number(b.story.needsYou ? 0 : 1)
    || b.rows.length - a.rows.length
    || a.story.code.localeCompare(b.story.code)
    || Number(a.resolvable ? 0 : 1) - Number(b.resolvable ? 0 : 1));
}

function pausedAt(row: GitDeferralRepoProjection, now: number): number {
  const at = Date.parse(row.oldestDeferredSince);
  return Number.isFinite(at) && at <= now ? at : Number.POSITIVE_INFINITY;
}

const REPOS_PER_GROUP = 5;
/** Where every command in the group action block starts, so a reader's eye
 * follows one column down the copy-pasteable half. */
const COMMAND_COLUMN = 46;

const commandLine = (label: string, command: string): string =>
  `   ${label}`.padEnd(COMMAND_COLUMN, " ") + command;

function resolveLines(group: StoryGroup): string[] {
  // The group key already split the unresolvable rows out; that half has no
  // command that would not refuse, so it prints its rows and says nothing.
  if (!group.resolvable) return [];
  const lines = [commandLine("To fix one, first see what's waiting:", "rbox git resolve <repo> show-me")];
  if (group.rows.every((row) => row.canKeepMine)) {
    lines.push(commandLine("then keep this computer's work:", "rbox git resolve <repo> keep-mine"));
    // `keep-mine` refuses on its own and prints the drop list first, so the
    // reader is not being asked to type a destructive command sight-unseen.
    lines.push(" ".repeat(COMMAND_COLUMN) + "(shows you what you'd drop, then gives you the confirm command)");
  }
  lines.push(commandLine("or take the other computer's version:", "rbox git resolve <repo> take-theirs --confirm <token from show-me>"));
  return lines;
}

/** rbox retrying for days is no longer "handling it", and saying so anyway is
 * how a self-healing group becomes a place problems go to be ignored. */
function selfHealingLines(group: StoryGroup, now: number): string[] {
  const oldest = Math.min(...group.rows.map((row) => pausedAt(row, now)));
  const stuck = !Number.isFinite(oldest) || now - oldest > DAY_MS;
  return stuck
    ? [
      "   rbox has been retrying these for over a day — that is longer than it should take.",
      commandLine("Get a closer look:", "rbox doctor"),
    ]
    : [
      "   rbox is handling these on its own — nothing to do",
      "   If any are still here tomorrow: rbox doctor",
    ];
}

function groupActionLines(group: StoryGroup, now: number): string[] {
  switch (group.story.action.kind) {
    case "resolve": return resolveLines(group);
    case "self-healing": return selfHealingLines(group, now);
    case "instruction": return [`   ${group.story.action.text}`];
    // Never a dead end: rbox cannot name this condition, so it names the person
    // who can read it.
    case "support": return [commandLine("Send this to support:", "rbox doctor --report")];
    // The fix depends on which read failed, and that sentence is already curated
    // per reason on each row — it prints beside the row, not for the group.
    case "repair-text": return [];
  }
}

/** The second line under a repo, printed ONLY when it carries something the
 * reader would otherwise have to run another command to learn. Everything here
 * was previously reachable through `status --verbose`'s companion line, which
 * the grouped listing replaced. */
function rowDetailLine(row: GitDeferralRepoProjection, options: GitPauseListingOptions): string | undefined {
  const parts: string[] = [];
  const locks = row.story.code === "busy" ? options.staleLocks?.(row) : undefined;
  if (locks) {
    const count = `${locks.lockCount} stable lock${locks.lockCount === 1 ? "" : "s"}`;
    parts.push(`${count} with no live owner, for example ${truncateDetail(locks.samplePath)}`);
  }
  if (row.story.action.kind === "repair-text") parts.push(sanitizeTerminalText(row.repairText));
  if (row.detail !== undefined) parts.push(boundedCuratedDetail(row.detail));
  // A detached checkout changes what resolving does; a branch name does not, and
  // printing one per row would bury the lines that matter.
  if (row.checkout?.kind === "detached") parts.push("detached checkout (no branch)");
  if (row.bytesChanged) parts.push("working files changed here since the pause");
  return parts.length > 0 ? `      ${parts.join(" · ")}` : undefined;
}

export interface GitPauseListingOptions {
  now: number;
  /** `--all`: the one-line form for every repo, no per-group cap. */
  all?: boolean;
  /** Stale-lock evidence for the busy story. The hygiene sidecar it comes from
   * is read outside this pure module, so the caller lends the lookup. */
  staleLocks?: (row: GitDeferralRepoProjection) => { lockCount: number; oldestAgeMs: number; samplePath: string } | undefined;
  /** Two-sided evidence, when the caller is a manual command that may spawn git.
   * Rows without a reading keep the age-only form. */
  evidence?: EvidenceLookup;
}

/** S2: the summary-first grouped listing behind `rbox status --git`. */
export function renderGitPauseListing(
  rows: readonly GitDeferralRepoProjection[],
  options: GitPauseListingOptions,
): string[] {
  const visible = loudRows(rows);
  if (visible.length === 0) {
    const quiet = rows.length;
    return quiet === 0
      ? ["No git repos are paused."]
      : [`Nothing needs you — ${repos(quiet)} paused in the last few minutes and usually ${quiet === 1 ? "sorts itself" : "sort themselves"} out.`];
  }
  const lines = [
    `rbox paused git sync in ${repos(visible.length)}. Your files are safe — rbox stops`,
    "syncing a repo rather than overwrite work you did on this computer.",
  ];
  for (const group of groupByStory(visible, options.now, options.evidence)) {
    lines.push("");
    lines.push(`${repos(group.rows.length)} — ${storyHeadline(group.story, group.rows.length)}`);
    const shown = options.all ? group.rows : group.rows.slice(0, REPOS_PER_GROUP);
    // One age column per group: unaligned ages read as noise beside paths whose
    // lengths differ by 40 characters.
    const width = Math.max(...shown.map((row) => sanitizeTerminalText(row.repo).length));
    // The evidence column exists only when some row in the group has a reading;
    // an all-tier-2 group keeps PR-B's two-column shape rather than padding
    // every row around a column that is empty everywhere.
    const suffixes = new Map(shown.map((row) => [row.repo, evidenceRowSuffix(options.evidence?.(row))] as const));
    const evidenceWidth = Math.max(0, ...[...suffixes.values()].map((suffix) => suffix?.length ?? 0));
    for (const row of shown) {
      const suffix = suffixes.get(row.repo);
      const evidenceColumn = evidenceWidth === 0 ? "" : `${(suffix ?? "").padEnd(evidenceWidth, " ")}   `;
      lines.push(`   ${sanitizeTerminalText(row.repo).padEnd(width, " ")}   ${evidenceColumn}${pausedFor(row.oldestDeferredSince, options.now)}`);
      const detail = rowDetailLine(row, options);
      if (detail) lines.push(detail);
    }
    const hidden = group.rows.length - shown.length;
    if (hidden > 0) {
      lines.push(`   … ${hidden} more not shown`);
      lines.push("   the full list:        rbox status --git --all");
    }
    lines.push(...groupActionLines(group, options.now));
  }
  return lines;
}

/** S3: doctor's summary altitude over the same rows. Quiet rows are counted and
 * LABELLED here rather than dropped — a repo whose pause keeps flapping never
 * ages past the quiet window, and support has to be able to see it. */
export function renderGitPauseSummary(rows: readonly GitDeferralRepoProjection[], now: number): string[] {
  if (rows.length === 0) return [];
  const visible = loudRows(rows);
  const { needsYou, selfHealing } = gitPauseCounts(visible);
  const groups = groupByStory(visible, now);
  const lead = groups.find((group) => group.story.needsYou);
  const otherStories = groups.filter((group) => group.story.needsYou).length - 1;
  const lines = [`git · ${repos(rows.length)} paused`];
  if (needsYou > 0 && lead) {
    lines.push(`  ${needsYou} waiting on you — ${storyHeadline(lead.story, lead.rows.length)}${otherStories > 0 ? ` (and ${otherStories} more ${otherStories === 1 ? "story" : "stories"})` : ""}`);
  }
  if (selfHealing > 0) lines.push(`  ${selfHealing} sorting ${selfHealing === 1 ? "itself" : "themselves"} out`);
  const quiet = rows.length - visible.length;
  if (quiet > 0) lines.push(`  ${quiet} recently paused, usually self-heals`);
  const oldest = [...rows].sort((a, b) => Date.parse(a.oldestDeferredSince) - Date.parse(b.oldestDeferredSince))[0];
  if (oldest) lines.push(`  oldest ${pausedFor(oldest.oldestDeferredSince, now)} · full detail: rbox status --git`);
  return lines;
}
