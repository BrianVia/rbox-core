import type { ScanStats } from "../../engine/index.js";
import type { Action } from "../../engine/reconcile.js";

export function scanStatsLine(kind: "safety scan" | "deep scan", stats: ScanStats, wallMs: number, deferred: number): string {
  const accounted = stats.readdirMs + stats.statMs + stats.matcherMs + stats.hashMs + stats.sortMs;
  return `${kind}: files=${stats.filesStatted} dirs=${stats.dirsWalked} wall=${wallMs}ms readdir=${stats.readdirMs} stat=${stats.statMs} matcher=${stats.matcherMs} hash=${stats.hashMs} sort=${stats.sortMs} residual=${wallMs - accounted} cacheHits=${stats.filesSkippedCacheHit} hashed=${stats.filesHashed} deferred=${deferred} reuse=${stats.dirsReusedFromCache} dc=${stats.dircacheOutcome}`;
}

/** How many changed paths a pull/push log line spells out before eliding. High on
 *  purpose: the daemon log is the ONLY forensic record of what sync did to the tree
 *  ("did rbox delete my files?" must be answerable from it), and pumps are rare. */
export const LOG_PATHS_MAX = 50;

/** Control chars in a filename must not forge extra log lines — render them as `?`. */
export const cleanPath = (p: string) => p.replace(/\p{Cc}/gu, "?");


/** One-line forensic summary of the actions a pull APPLIED to the local tree:
 *  counts by kind plus the paths themselves (`+`write `-`delete `!`conflict). */
export function summarizeActions(actions: Action[]): string {
  let writes = 0;
  let deletes = 0;
  let conflicts = 0;
  const paths: string[] = [];
  // Only the first LOG_PATHS_MAX paths are rendered at all (a huge pull stays cheap).
  const keep = (prefix: string, p: string) => {
    if (paths.length < LOG_PATHS_MAX) paths.push(prefix + cleanPath(p));
  };
  for (const a of actions) {
    if (a.kind === "write") {
      writes++;
      keep("+", a.entry.path);
    } else if (a.kind === "delete") {
      deletes++;
      keep("-", a.path);
    } else {
      conflicts++;
      keep("!", a.path);
    }
  }
  const more = actions.length > LOG_PATHS_MAX ? ` (+${actions.length - LOG_PATHS_MAX} more)` : "";
  return `${writes} write, ${deletes} delete, ${conflicts} conflict — ${paths.join(" ")}${more}`;
}
