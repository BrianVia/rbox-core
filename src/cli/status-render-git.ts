/**
 * The Git-pause half of the status surface (design 273 S2).
 *
 * `status-render.ts` composes the workspace report; the two Git surfaces below
 * are the only part of it that reads a second Module's evidence, and they were
 * pushing that file past the module-size law. Splitting HERE keeps a real
 * boundary rather than an arbitrary one: everything in this file answers "what
 * does `rbox status --git` print", and nothing else in the status report
 * depends on it.
 */
import { renderGitRepoDetail } from "./status-view/git-evidence-render.js";
import { renderGitPauseListing, type GitPauseListingOptions } from "./status-view/git-story-render.js";
import { sanitizeTerminalText } from "./status-view/text.js";
import { statusStaleLockDetail } from "./status-maintenance.js";
import type { StatusGitDetailSource, StatusRenderOptions } from "./status-contract.js";

/**
 * `rbox status --git <repo>`. One repo, both sides, no group summary and no
 * per-group cap — the reader already narrowed the question.
 *
 * `undefined` when the argument does not name a paused repo: `rbox status <path>`
 * has always meant "report on that synced folder", and `--git` must not quietly
 * redefine it. The caller falls back to the listing and says why.
 */
export function renderGitSingleRepo(
  source: StatusGitDetailSource,
  repo: string,
  options: StatusRenderOptions,
): string[] | undefined {
  const row = source.git.projectedRepos.find((candidate) => candidate.repo === repo);
  if (!row) return undefined;
  const lines = renderGitRepoDetail(row, options.evidence?.(row), source.now);
  if (row.resolvable) {
    // Repo paths arrive from a peer's manifest, so they are attacker-influenced
    // bytes headed for a terminal. Interpolating one raw into a command line put
    // ANSI and BEL on the user's screen from the one surface whose whole job is
    // to be copied and pasted.
    const name = sanitizeTerminalText(row.repo);
    lines.push("");
    lines.push(`  See what's waiting:            rbox git resolve ${name} show-me`);
    lines.push(`  Keep this computer's work:     rbox git resolve ${name} keep-mine`);
    // The destructive command carries the REAL name too: making the reader
    // hand-edit exactly one command, and making it that one, is how a path gets
    // mistyped into a repo nobody meant to overwrite.
    lines.push(`  Take the other computer's:     rbox git resolve ${name} take-theirs --confirm <token from show-me>`);
    lines.push("  Preview either first:          add --dry-run");
  } else if (row.story.action.kind === "instruction") {
    lines.push(`  ${row.story.action.text}`);
  }
  return lines;
}

/** Said above the listing when `--git <path>` named something that is not a
 * paused repo, so the reader learns why they got the whole folder. */
export const gitRepoFallbackNote = (repo: string): string[] =>
  [`${sanitizeTerminalText(repo)} has no paused git sync — showing this whole synced folder instead.`, ""];

/** The grouped listing `rbox status --git` prints under the brief. */
export function renderGitPauseSection(
  source: StatusGitDetailSource,
  root: string,
  options: StatusRenderOptions,
): string[] {
  const listing: GitPauseListingOptions = {
    now: source.now,
    all: options.all === true,
    staleLocks: (row) => statusStaleLockDetail(root, source.hygieneDetails, row.repo, row.displayLane),
  };
  if (options.evidence) listing.evidence = options.evidence;
  return ["", ...renderGitPauseListing(source.git.projectedRepos, listing)];
}
