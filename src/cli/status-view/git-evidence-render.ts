/**
 * Design 273 S2 — saying what each computer actually changed.
 *
 * PR-B's listing could name a paused repo and its age. That answers "what
 * happened" but not "what could I lose", so a reader still had to run a command
 * per repo to find out whether the two computers touched the same files. This
 * module turns one {@link GitRepoEvidence} reading into the two sentences that
 * close that gap: the one-line risk suffix the grouped listing puts beside each
 * repo, and the two-sided detail `rbox status --git <repo>` prints.
 *
 * THE sanitization boundary for the other computer's bytes. Commit subjects,
 * branch labels and file paths arrive from a peer; the evidence reader hands
 * them over raw on purpose, and every one of them is bounded and stripped here
 * before it reaches a terminal.
 *
 * The overlap count is never printed bare — "3" means nothing on its own, and
 * "overlap" is a banned word on a human surface. It is always spelled as the
 * thing a person is deciding about: files you also changed here.
 */
import type { GitDeferralRepoProjection } from "./git-projection.js";
import type { GitIncomingFacts, GitLocalFileChange, GitRepoEvidence } from "./git-evidence-model.js";
import { pausedFor, sanitizeTerminalText } from "./text.js";

/** Longest peer-authored commit subject rendered. A subject is one line of
 * prose; a longer one is an authoring accident or an attack, and either way the
 * head is the informative half. */
const SUBJECT_MAX = 100;
/** Longest peer- or disk-authored path rendered. Paths read from their tail
 * (the basename is the identifier), but a repo-relative path this long is
 * already pathological, so the head is kept for a stable, greppable prefix. */
const PATH_MAX = 160;
/** Files listed in the single-repo view before it summarizes the rest. */
const DETAIL_FILES = 25;

const bounded = (text: string, max: number): string => {
  const points = Array.from(sanitizeTerminalText(text));
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
};

export const safeSubject = (subject: string): string => bounded(subject, SUBJECT_MAX);
export const safePath = (file: string): string => bounded(file, PATH_MAX);

const files = (count: number): string => `${count} file${count === 1 ? "" : "s"}`;

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Aug 14", or undefined when the instant is unusable. */
const shortDate = (at: number | undefined): string | undefined =>
  at !== undefined && Number.isFinite(at) ? MONTH_DAY.format(new Date(at)) : undefined;

/** The same, for a peer-authored timestamp: parsed here, never trusted as text. */
const shortDateOf = (iso: string | undefined): string | undefined =>
  iso === undefined ? undefined : shortDate(Date.parse(iso));

/**
 * The listing's per-repo risk clause: "12 files changed here, 3 also changed on
 * another computer ⚠". `undefined` when this repo has no reading, which is how a
 * pre-273 pause keeps the age-only row PR-B shipped.
 */
export function evidenceRowSuffix(evidence: GitRepoEvidence | undefined): string | undefined {
  const local = evidence?.local;
  if (!local || local.total === 0) return undefined;
  const here = `${files(local.total)} changed here`;
  if (evidence.tier !== "pinned" || evidence.overlap === undefined) return here;
  return evidence.overlap > 0
    ? `${here}, ${evidence.overlap} also changed on another computer ⚠`
    : `${here}, none changed elsewhere`;
}

function localFileLine(file: GitLocalFileChange): string {
  const parts: string[] = [];
  if (file.added > 0) parts.push(`${file.added} line${file.added === 1 ? "" : "s"} added`);
  if (file.removed > 0) parts.push(`${file.removed} removed`);
  const edited = shortDate(file.editedAt);
  const when = edited ? `edited ${edited}` : "";
  const change = parts.length > 0 ? `(${parts.join(", ")})` : "";
  return `    - ${[safePath(file.path), when, change].filter(Boolean).join("  ")}`;
}

function incomingHeading(incoming: GitIncomingFacts): string {
  const where = incoming.branch ? `branch ${bounded(incoming.branch, 80)}` : "no branch (a detached checkout)";
  const ahead = incoming.commitsAhead !== undefined
    ? `, ${incoming.commitsAhead} commit${incoming.commitsAhead === 1 ? "" : "s"} newer than yours`
    : "";
  return `  Waiting from another computer (${where}${ahead}):`;
}

function incomingLines(evidence: GitRepoEvidence): string[] {
  const incoming = evidence.incoming;
  if (!incoming) return [];
  const lines = [incomingHeading(incoming)];
  if (incoming.newest) {
    const when = shortDateOf(incoming.newest.date);
    lines.push(`    most recent: "${safeSubject(incoming.newest.subject)}"${when ? `  (${when})` : ""}`);
  }
  if (incoming.oldest && incoming.oldest.subject !== incoming.newest?.subject) {
    const when = shortDateOf(incoming.oldest.date);
    lines.push(`    oldest waiting: "${safeSubject(incoming.oldest.subject)}"${when ? `  (${when})` : ""}`);
  }
  if (incoming.files) {
    const overlap = evidence.overlap ?? 0;
    lines.push(overlap > 0
      ? `    changes ${files(incoming.files.length)} — ${overlap} of them ${overlap === 1 ? "is a file" : "are files"} you also changed here ⚠`
      : `    changes ${files(incoming.files.length)} — none of them are files you changed here`);
  } else {
    // Tier 2: the objects are gone, so the honest offering is the date it was
    // made and the command that fetches the rest on demand.
    const captured = shortDateOf(incoming.generatedAt);
    lines.push(`    rbox no longer has a local copy of this to compare${captured ? ` (it was made ${captured})` : ""}`);
  }
  return lines;
}

/** The one warning that changes what resolving MEANS: the two computers are not
 * even on the same branch, so "take the other computer's version" switches
 * branches rather than fast-forwarding one. */
function branchMismatchLine(evidence: GitRepoEvidence): string[] {
  const mine = evidence.localBranch;
  const theirs = evidence.incoming?.branch;
  if (!mine || !theirs || mine === theirs) return [];
  return [`  ⚠ You are on branch ${bounded(mine, 80)} here; the other computer is on ${bounded(theirs, 80)}.`];
}

/**
 * `rbox status --git <repo>` — one repo, both sides, nothing summarized away.
 * Falls back to the story line alone when there is no reading to show, so the
 * command always answers rather than printing an empty frame.
 */
export function renderGitRepoDetail(
  row: GitDeferralRepoProjection,
  evidence: GitRepoEvidence | undefined,
  now: number,
): string[] {
  const lines = [`${sanitizeTerminalText(row.repo)} — ${pausedFor(row.oldestDeferredSince, now)}`];
  lines.push(`  ${row.story.headline}`);
  const local = evidence?.local;
  if (local && local.total > 0) {
    const where = evidence?.localBranch ? `this computer, branch ${bounded(evidence.localBranch, 80)}` : "this computer";
    lines.push(`  Your work here (${where}):`);
    for (const file of local.files.slice(0, DETAIL_FILES)) lines.push(localFileLine(file));
    const hidden = local.total - Math.min(local.total, DETAIL_FILES);
    if (hidden > 0) lines.push(`    … and ${hidden} more file${hidden === 1 ? "" : "s"}`);
  } else if (evidence) {
    lines.push("  Your work here: nothing changed on this computer since the last sync.");
  }
  lines.push(...incomingLines(evidence ?? { repo: row.repo, tier: "none" }));
  if (evidence) lines.push(...branchMismatchLine(evidence));
  if (evidence?.timedOut) lines.push("  (rbox ran out of time reading this repo — some detail above may be missing.)");
  return lines;
}
