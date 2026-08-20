/**
 * The one authoritative reading of a repo's Git deferrals (design 116).
 *
 * Independent apply/capture/config lanes collapse into a single repo-level
 * projection here, and the closed reason table that names each condition in
 * human words lives beside it. Every local visibility surface — status, doctor,
 * the daemon log, `git deferrals`, telemetry — projects through this module, so
 * one repo can never read as two different problems depending on who asked.
 *
 * Deliberately render-free: it decides WHAT is true, never how a terminal says
 * it. The render module imports this one; this one imports no renderer.
 */
import type { GitDeferral, GitDeferralReason, RepoRecord } from "../sync-state-model.js";
import { gitStoryFor, type GitStory } from "./git-stories.js";

/**
 * Design 273 P5: a transient pause younger than this is real but not worth
 * interrupting anyone over. Peer echoes on an actively committed repo arrive
 * seconds behind local state and self-supersede on the next push; showing those
 * brief holds as attention trains users to ignore the banner or reach for
 * take-theirs. Computed ONCE here as a per-row flag so the headline, the
 * listing, the daemon count and the prompt sidecar cannot disagree.
 */
export const TRANSIENT_DEFERRAL_QUIET_MS = 10 * 60_000;

export interface GitDeferralReasonPresentation {
  label: string;
  text: string;
  repair: string;
  transient: boolean;
}

export const UNKNOWN_GIT_DEFERRAL_PRESENTATION: GitDeferralReasonPresentation = {
  label: "unrecognized Git issue",
  text: "Git sync is deferred for an unrecognized reason.",
  repair: "Inspect rbox status and the daemon logs before changing repository state.",
  transient: false,
};

const DEFERRAL_REASON_PRESENTATION = {
  "local-edits": { label: "local edits", text: "Working files changed here.", repair: "Stop Git and file changes, then let normal sync retry.", transient: true },
  "local-index": { label: "local index changes", text: "The Git index changed here.", repair: "Stop Git and file changes, then let normal sync retry.", transient: true },
  "local-operation": { label: "local Git operation", text: "A Git operation is active or changed here.", repair: "Finish or stop the Git operation, then let normal sync retry.", transient: true },
  "local-commits": { label: "local commits", text: "Local commits changed here.", repair: "Stop Git mutation, then let normal sync retry.", transient: true },
  "local-stash": { label: "local stash", text: "The local stash changed here.", repair: "Stop stash mutation, then let normal sync retry.", transient: true },
  "deletion-pending": { label: "finishing a branch deletion", text: "rbox is finishing a branch you deleted here.", repair: "rbox retries this on its own. If it stays, run `rbox doctor`.", transient: true },
  "conflict-copies": { label: "conflict copies", text: "Backup copies rbox made of conflicting files are the only thing left to compare here.", repair: "Remove the conflict-copy files (or resolve them), then let sync retry.", transient: false },
  conflict: { label: "conflict", text: "Incoming and local Git state conflict.", repair: "Repair the conflicting repository state, then let sync retry.", transient: false },
  "git-busy": { label: "git busy", text: "Another Git process is using this repository.", repair: "Let the other Git process finish, then let sync retry.", transient: false },
  "stale-unattributed": { label: "stale Git locks", text: "A stable lock cohort remains without a known live owner.", repair: "Run `rbox doctor`, confirm no Git process owns the reported locks, then remove only the stale lock files and let sync retry.", transient: false },
  "worktree-ownership": { label: "worktree ownership", text: "Another worktree owns a required Git ref.", repair: "Repair the worktree ownership conflict, then let sync retry.", transient: false },
  "ignored-target": { label: "ignored target", text: "The incoming checkout targets an ignored repository.", repair: "Correct the ignore rule or repository target, then let sync retry.", transient: false },
  "ref-read-unreadable": { label: "unreadable Git refs", text: "Git refs could not be read completely.", repair: "Restore ref-store readability and permissions, then let sync retry.", transient: false },
  unreadable: { label: "unreadable repository", text: "Git metadata could not be read completely.", repair: "Restore repository readability and permissions, then let sync retry.", transient: false },
  artifact: { label: "Git artifact", text: "Required Git artifacts could not be fetched or verified.", repair: "Repair artifact availability or integrity, then let sync retry.", transient: false },
  config: { label: "git config", text: "Common Git configuration could not be synchronized safely.", repair: "Correct the local common Git config so it is readable, supported, within wire bounds, and workspace-owned, then let sync retry.", transient: false },
  containment: { label: "repository containment", text: "Repository containment could not be proved.", repair: "Repair the repository or worktree layout so it stays within the workspace, then let sync retry.", transient: false },
  unsupported: { label: "unsupported git state", text: "This Git version or repository shape is unsupported.", repair: "Upgrade Git or repair the repository shape, then let sync retry.", transient: false },
  other: { label: "other git issue", text: "Git sync is deferred by another known condition.", repair: "Inspect rbox status and the daemon logs, repair the reported condition, then let sync retry.", transient: false },
} satisfies Record<GitDeferralReason, GitDeferralReasonPresentation>;

export function gitDeferralReasonPresentation(reason: string): GitDeferralReasonPresentation {
  return DEFERRAL_REASON_PRESENTATION[reason as GitDeferralReason] ?? UNKNOWN_GIT_DEFERRAL_PRESENTATION;
}

export function isKnownGitDeferralReason(reason: string): reason is GitDeferralReason {
  return Object.hasOwn(DEFERRAL_REASON_PRESENTATION, reason);
}


export function gitDeferralReasonText(reason: string): string {
  return gitDeferralReasonPresentation(reason).label;
}

/** Preserve the legacy operational tie while giving deletion-pending its deliberate display slot.
 *
 * `local-operation` outranks `local-index` (design 273 S2): a half-finished
 * rebase always dirties the index too, so index-first meant the unfinished-
 * operation story could never fire on the repo it was written for — the reader
 * was told "you have uncommitted work" about a repo stuck mid-rebase. */
function gitDeferralReasonPrecedence(reason: string): number {
  switch (reason) {
    case "local-edits": return 0;
    case "local-operation": return 1;
    case "local-index": return 2;
    case "local-commits": return 3;
    case "local-stash": return 4;
    case "deletion-pending": return 5;
    case "ref-read-unreadable": return 6;
    default: return 7;
  }
}

export interface GitDeferralDisplayEntry {
  repo: string;
  deferral: Pick<GitDeferral, "lane" | "reason" | "deferredSince" | "bytesChanged" | "checkout">
    & Partial<Pick<GitDeferral, "reasonSince" | "lastSeen" | "detail" | "code">>;
  record?: RepoRecord;
}

/** One authoritative display row per repo, shared by every local visibility surface.
 *
 * `ownership-hold` (design 273 P2) is the class for a repo rbox left alone
 * because another worktree owns the branch. It is consulted BEFORE
 * `canResolve`/`canKeepMine` on every command-emitting or severity-assigning
 * surface: the record carries `pending`, so `canKeepMine` is true and a naive
 * surface would print a resolve command for a repo whose story says "no command
 * needed", and an age-only severity rule would mark a multi-day hold blocked.
 * An `ownership-hold` emits NO resolve command and NO attention/blocked severity
 * anywhere. Owner: the hold/skip sites. Deletion condition: the 2.0 unified
 * pause record. */
export type GitDeferralRemediationClass =
  | "transient"
  | "capture"
  | "config"
  | "apply-resolvable"
  | "apply-unavailable"
  | "ownership-hold";

export interface GitDeferralRepoProjection {
  repo: string;
  oldestDeferredSince: string;
  displayReason: string;
  displayLane: GitDeferral["lane"];
  reasonSince: string;
  reasonLabel: string;
  reasonText: string;
  repairText: string;
  remediationClass: GitDeferralRemediationClass;
  /** What a human is told happened here, and whether they must decide anything.
   * Render-side only; `displayReason` stays the machine contract. */
  story: GitStory;
  /** Design 273 P5: a young transient pause that self-heals. Headline, listing,
   * ambient count and prompt sidecar OMIT these rows; doctor and
   * `git deferrals --json` render them LABELLED, so a flapping repo whose
   * `deferredSince` keeps resetting stays visible to the support flow. */
  quiet: boolean;
  /** THE predicate for "may a surface print a resolve command for this repo?".
   * `remediationClass` is consulted first, then the incoming state — one owner,
   * so doctor and the listing cannot disagree about the same repo. */
  resolvable: boolean;
  canResolve: boolean;
  canKeepMine: boolean;
  alsoDeferred?: string;
  bytesChanged: boolean;
  checkout?: GitDeferral["checkout"];
  /** The displayed lane's curated detail, verbatim. Never a composed string. */
  detail?: string;
  /** The displayed lane's last re-observation. The stuck predicate's wake guard
   * reads it; absence (a record written before design 280) reads as unknown. */
  lastSeen?: string;
  /** The displayed lane's durable typed code (design 280). The ONE thing that
   * distinguishes the two `artifact` sub-classes. No surface acts on it: the
   * repair it was going to gate was falsified in the rig (2026-08-20 — see
   * `selfHealingLines`), so it is carried as honest classification for support
   * reads and for whatever remedy #775's journal work lands. */
  code?: GitDeferral["code"];
}

/**
 * Design 280: rbox promised in the story table that a self-healing pause
 * "escalates when the retrying has gone on too long". This is that promise, in
 * one predicate every surface reads.
 *
 * The clock is `reasonSince`, not `deferredSince`: `deferredSince` survives a
 * reason change, so a month-old episode that became a download failure this
 * morning must not read as a month-old download failure. The guard is
 * `lastSeen`: the same-reason arm never restamps `reasonSince`, so a laptop
 * asleep for three days would otherwise wake straight into escalation. A row
 * escalates only while its cause is still being actively re-observed.
 *
 * Unparseable or future timestamps are never evidence of age — they read as NOT
 * stuck.
 */
export const STUCK_SELF_HEALING_MS = 24 * 60 * 60_000;
export const STUCK_WAKE_GUARD_MS = 6 * 60 * 60_000;

const elapsedSince = (iso: string | undefined, now: number): number | undefined => {
  if (iso === undefined) return undefined;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at <= now ? now - at : undefined;
};

export function rowStuck(row: GitDeferralRepoProjection, now: number): boolean {
  if (row.story.action.kind !== "self-healing") return false;
  const causeAge = elapsedSince(row.reasonSince, now);
  const sinceSeen = elapsedSince(row.lastSeen, now);
  return causeAge !== undefined && causeAge > STUCK_SELF_HEALING_MS
    && sinceSeen !== undefined && sinceSeen < STUCK_WAKE_GUARD_MS;
}

/** THE actionability predicate. A story that asks for a decision needs you; so
 * does one that promised to sort itself out and then did not. */
export function rowNeedsYou(row: GitDeferralRepoProjection, now: number): boolean {
  return row.story.needsYou || rowStuck(row, now);
}

const parsedDeferralTime = (iso: string, now: number): number => {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed <= now ? parsed : Number.POSITIVE_INFINITY;
};

/** The exact truthiness gate used by `rbox git resolve` to select incoming state. */
export function hasGitResolutionIncoming(record: RepoRecord | undefined): boolean {
  return Boolean(record?.pending || ((record?.resolutionKey || record?.deferrals?.apply) && record?.base));
}

/**
 * Collapse independent apply/capture/config lanes into the single repo-level
 * projection promised by design 116. The chronic age is the oldest standing
 * lane, while the reason is selected independently by display precedence.
 */
export function projectGitDeferralRepos(entries: Iterable<GitDeferralDisplayEntry>, now = Date.now()): GitDeferralRepoProjection[] {
  const grouped = new Map<string, { lanes: GitDeferralDisplayEntry["deferral"][]; record?: RepoRecord }>();
  for (const { repo, deferral, record } of entries) {
    const group = grouped.get(repo) ?? { lanes: [] };
    group.lanes.push(deferral);
    if (record) group.record = record;
    grouped.set(repo, group);
  }
  const projected: GitDeferralRepoProjection[] = [];
  for (const [repo, { lanes, record }] of grouped) {
    const ordered = [...lanes].sort((a, b) =>
      gitDeferralReasonPrecedence(a.reason) - gitDeferralReasonPrecedence(b.reason)
      || parsedDeferralTime(a.deferredSince, now) - parsedDeferralTime(b.deferredSince, now)
      || a.lane.localeCompare(b.lane)
      || a.reason.localeCompare(b.reason)
    );
    // Actionability is LANE-COMPLETE. A repo whose oldest lane is a quiet
    // ownership hold and whose second lane is an unreadable repo needs a person,
    // so display precedence picks among the lanes that need one first —
    // otherwise the repo renders under a story that says "nothing to do" and
    // disappears from every attention surface.
    const display = (ordered.find((lane) => gitStoryFor(lane.reason, lane.detail).needsYou) ?? ordered[0])!;
    const oldest = [...lanes].sort((a, b) =>
      parsedDeferralTime(a.deferredSince, now) - parsedDeferralTime(b.deferredSince, now)
      || a.lane.localeCompare(b.lane)
    )[0]!;
    const checkout = display.checkout ?? ordered.find((lane) => lane.checkout !== undefined)?.checkout;
    const presentation = gitDeferralReasonPresentation(display.reason);
    const knownReason = isKnownGitDeferralReason(display.reason);
    const canResolve = knownReason && hasGitResolutionIncoming(record);
    const canKeepMine = knownReason && Boolean(record?.pending);
    // `ownership-hold` is a claim about the WHOLE repo ("rbox left this alone
    // and nobody needs to act"), so one non-ownership lane disqualifies it.
    const remediationClass: GitDeferralRemediationClass = !knownReason
      ? "apply-unavailable"
      : lanes.every((lane) => lane.reason === "worktree-ownership")
      ? "ownership-hold"
      : presentation.transient
      ? "transient"
      : display.lane === "capture"
        ? "capture"
        : display.lane === "config"
          ? "config"
          : canResolve ? "apply-resolvable" : "apply-unavailable";
    // A repo is quiet only when EVERY standing lane is a young transient. One
    // durable lane (a conflict beside a busy capture) makes the whole repo loud,
    // whichever lane display precedence happens to name.
    const quiet = lanes.every((lane) => {
      if (!gitDeferralReasonPresentation(lane.reason).transient) return false;
      const at = parsedDeferralTime(lane.deferredSince, now);
      return Number.isFinite(at) && now - at < TRANSIENT_DEFERRAL_QUIET_MS;
    });
    const additional = ordered.slice(1).map((lane) => `${lane.lane} — ${gitDeferralReasonPresentation(lane.reason).label}`);
    const row: GitDeferralRepoProjection = {
      repo,
      oldestDeferredSince: oldest.deferredSince,
      displayReason: display.reason,
      displayLane: display.lane,
      reasonSince: display.reasonSince ?? display.deferredSince,
      reasonLabel: presentation.label,
      reasonText: presentation.text,
      repairText: presentation.repair,
      remediationClass,
      story: gitStoryFor(display.reason, display.detail),
      quiet,
      resolvable: remediationClass !== "ownership-hold"
        && remediationClass !== "capture"
        && remediationClass !== "config"
        && canResolve,
      canResolve,
      canKeepMine,
      bytesChanged: lanes.some((lane) => lane.bytesChanged === true),
    };
    if (additional.length) row.alsoDeferred = `Also deferred: ${additional.join("; ")}.`;
    if (checkout !== undefined) row.checkout = checkout;
    if (display.detail !== undefined) row.detail = display.detail;
    // Both read from the DISPLAYED lane, exactly like `reasonSince` and
    // `detail`: the row speaks for one cause, and its clock, its curated text
    // and its typed code must all describe that same cause.
    if (display.lastSeen !== undefined) row.lastSeen = display.lastSeen;
    if (display.code !== undefined) row.code = display.code;
    projected.push(row);
  }
  return projected.sort((a, b) =>
    parsedDeferralTime(a.oldestDeferredSince, now) - parsedDeferralTime(b.oldestDeferredSince, now)
    || gitDeferralReasonPrecedence(a.displayReason) - gitDeferralReasonPrecedence(b.displayReason)
    || a.repo.localeCompare(b.repo)
  );
}
