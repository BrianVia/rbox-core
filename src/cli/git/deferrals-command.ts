import path from "node:path";
import {
  DEFERRAL_LANES,
  loadConfig,
  loadState,
  repoRecordsForState,
  syncStreamId,
} from "../config.js";
import { projectGitDeferralRepos, rowNeedsYou, rowStuck, type GitDeferralRepoProjection } from "../status-view/git-projection.js";
import type { GitDeferral, RepoRecord, RepoRecordsByPath } from "../sync-state-model.js";
import { storyInstruction } from "../status-view/git-stories.js";
import { ageBucket } from "../status-view/text.js";
import { serializeGitDeferralLanes } from "../sync-git/git-deferral-json.js";
import { shQuote } from "../shell-quote.js";
import { RBOX_VERSION } from "../version.js";

export interface GitDeferralsCmdDeps {
  now?: () => Date;
  version?: string;
  /** Injection proves the brief never consults or renders host identity. */
  hostname?: string;
  loadConfig?: typeof loadConfig;
  loadState?: typeof loadState;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface GitDeferralsCmdOptions {
  brief?: boolean;
  json?: boolean;
}

function displayField(value: string): string {
  return value
    .replace(/[\r\n\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function briefField(value: string): string {
  return displayField(value)
    .replace(/([\\`*_\[\]<>|#])/g, "\\$1");
}

function checkoutBrief(checkout: GitDeferralRepoProjection["checkout"]): string {
  if (!checkout) return "checkout unavailable";
  if (checkout.kind === "detached") return "detached checkout";
  return checkout.label ? `branch ${briefField(checkout.label)}` : "branch (label unavailable)";
}

function remediationLines(repo: GitDeferralRepoProjection): string[] {
  const lines = [`Diagnosis: ${briefField(repo.reasonText)}`, `Repair: ${briefField(repo.repairText)}`];
  if (repo.remediationClass === "ownership-hold") {
    lines.push(briefField(storyInstruction(repo.story) ?? repo.story.headline));
  } else if (repo.remediationClass === "transient") {
    lines.push("Let normal sync retry while the repository is quiet. If both ages keep growing, inspect `rbox status` and the daemon logs.");
  } else if (repo.remediationClass === "capture") {
    lines.push("Make the repository quiet and readable so normal push capture can retry. Persistent failures require Git/version/repository-shape repair; resolver commands do not apply.");
  } else if (repo.remediationClass === "config") {
    lines.push("Normal sync keeps carrying the previous safe config. Use daemon logs to distinguish a transient read failure from publication-disabled config; resolver commands do not apply.");
  } else if (repo.remediationClass === "apply-unavailable") {
    lines.push("The resolver has no deferred incoming state. Let sync fetch or rebuild it; inspect `rbox status` and daemon logs if this persists.");
  }
  if (repo.resolvable) {
    lines.push("Your repository is healthy; only rbox's bookkeeping is paused while Git state from your other computer waits.");
    lines.push(repo.canKeepMine
      ? "Choose `keep-mine` to keep this computer's version and publish it to your other computers, or `take-theirs` to use the version from your other computer and set aside this computer's Git changes."
      : "Nothing is waiting to publish with `keep-mine`; `take-theirs` uses the waiting version from your other computer and sets aside this computer's Git changes.");
    lines.push("First inspect the fresh snapshot, then substitute its token in the command that matches your choice:");
  }
  return lines;
}

/** Design 273 P5: this surface renders the FULL population and LABELS the quiet
 * rows rather than hiding them — a repo whose pause keeps flapping never ages
 * past the quiet window, and support has to be able to see it. */
const QUIET_LABEL = "recently paused, usually self-heals";

function resolveCommand(root: string, repo: string, token?: string, verb?: "take-theirs" | "keep-mine"): string {
  const repoArg = repo.startsWith("-") ? `./${repo}` : repo;
  const argv = verb === "keep-mine" && token === undefined
    ? ["rbox", "git", "resolve", repoArg, "keep-mine"]
    : token === undefined
      ? ["rbox", "git", "resolve", repoArg]
      : ["rbox", "git", "resolve", repoArg, verb ?? "take-theirs", "--confirm", token];
  return `cd ${shQuote(root)} && ${argv.map(shQuote).join(" ")}`;
}

export interface GitPauseReading {
  laneEntries: Array<{ repo: string; deferral: GitDeferral; record: RepoRecord }>;
  repos: GitDeferralRepoProjection[];
  records: RepoRecordsByPath;
  now: Date;
}

/**
 * THE whole-state read behind every paused-repo surface in this family.
 *
 * `rbox git deferrals` and `rbox git resolve --under` need exactly the same
 * reading, and design 163's ratchet says the whole-state adapter's production
 * reach may only shrink — so the batch borrows this one rather than opening a
 * second `loadState` site for the same rows.
 */
export async function readGitPauseRows(root: string, deps: GitDeferralsCmdDeps = {}): Promise<GitPauseReading> {
  const cfg = await (deps.loadConfig ?? loadConfig)(root);
  const state = await (deps.loadState ?? loadState)(root, syncStreamId(cfg));
  const records = repoRecordsForState(state);
  const laneEntries = Object.entries(records).flatMap(([repo, record]) =>
    Object.values(record.deferrals ?? {}).flatMap((deferral) => deferral ? [{ repo, deferral, record }] : [])
  ).sort((a, b) => Date.parse(a.deferral.deferredSince) - Date.parse(b.deferral.deferredSince)
    || a.repo.localeCompare(b.repo)
    || DEFERRAL_LANES.indexOf(a.deferral.lane) - DEFERRAL_LANES.indexOf(b.deferral.lane));
  const now = (deps.now ?? (() => new Date()))();
  return { laneEntries, repos: projectGitDeferralRepos(laneEntries, now.getTime()), records, now };
}

/** Render the repo-level deferral list, complete fix brief, or raw lane JSON. */
export async function gitDeferralsCmd(
  root: string,
  options: GitDeferralsCmdOptions = {},
  deps: GitDeferralsCmdDeps = {},
): Promise<number> {
  const write = deps.stdout ?? console.log;
  const writeError = deps.stderr ?? console.error;
  try {
    const { laneEntries, repos, now } = await readGitPauseRows(root, deps);
    if (options.json) {
      // Additive only: `deferrals` keeps its exact shape, and `reason` stays the
      // machine contract inside `repos`. `story` is a render-side label.
      write(JSON.stringify({
        schemaVersion: 1,
        deferrals: serializeGitDeferralLanes(laneEntries, now.getTime()),
        repos: repos.map((repo) => ({
          repo: repo.repo,
          reason: repo.displayReason,
          lane: repo.displayLane,
          story: repo.story.code,
          needsYou: rowNeedsYou(repo, now.getTime()),
          stuck: rowStuck(repo, now.getTime()),
          quiet: repo.quiet,
          remediationClass: repo.remediationClass,
          oldestDeferredSince: repo.oldestDeferredSince,
          reasonSince: repo.reasonSince,
          bytesChanged: repo.bytesChanged,
        })),
      }));
      return 0;
    }
    if (!options.brief) {
      if (!repos.length) write("no deferred repos");
      for (const repo of repos) {
        const quiet = repo.quiet ? ` · ${QUIET_LABEL}` : "";
        write(`${displayField(repo.repo)} — ${displayField(repo.reasonLabel)} · deferred ${ageBucket(repo.oldestDeferredSince, now.getTime())} · reason ${ageBucket(repo.reasonSince, now.getTime())}${quiet}`);
      }
      return 0;
    }

    const version = deps.version ?? RBOX_VERSION;
    write("contains local repo paths and branch names — share accordingly");
    write("");
    write(`Workspace root: ${briefField(path.resolve(root))}`);
    write(`rbox version: ${briefField(version)}`);
    write(`Rendered at: ${now.toISOString()}`);
    write(`Deferred repos: ${repos.length}`);
    for (const repo of repos) {
      write("");
      write(`## ${briefField(repo.repo)}`);
      write(`Deferred for ${ageBucket(repo.oldestDeferredSince, now.getTime())} · current reason ${briefField(repo.reasonLabel)} since ${ageBucket(repo.reasonSince, now.getTime())}${repo.quiet ? ` · ${QUIET_LABEL}` : ""}`);
      write(`Checkout: ${checkoutBrief(repo.checkout)}`);
      if (repo.alsoDeferred) write(briefField(repo.alsoDeferred));
      for (const line of remediationLines(repo)) write(line);
      if (repo.resolvable) {
        write(resolveCommand(path.resolve(root), repo.repo));
        if (repo.canKeepMine) write(resolveCommand(path.resolve(root), repo.repo, undefined, "keep-mine"));
        write(resolveCommand(path.resolve(root), repo.repo, "<token-printed-by-show-me>"));
      }
    }
    write("");
    write(`-- end of brief · ${repos.length} repo(s)`);
    return 0;
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
