/**
 * The SHAPE of a two-sided Git-pause reading, and nothing else.
 *
 * It exists as its own leaf so a renderer on the daemon path can name the
 * evidence it may be handed WITHOUT importing `git-evidence.ts`, which spawns
 * git. That is not a style preference: naming the type from the reader wired the
 * ambient status renderer to the git-spawning module, and the zero-spawn
 * discipline this design promises is only as good as the dependency direction
 * underneath it. The runtime guarantee is gated by the `setGitSpawnObserver`
 * test over `project()` and every surface it feeds (git-evidence.test.ts).
 *
 * Nothing here imports anything.
 */

export interface GitLocalFileChange {
  path: string;
  added: number;
  removed: number;
  /** Epoch ms of the working file's last write, when it is still on disk. */
  editedAt?: number;
}

export interface GitIncomingFacts {
  /** Branch the other computer published, or undefined for a detached head. */
  branch?: string;
  headOid?: string;
  /** When the other computer captured this — the tier-2 answer to "how old". */
  generatedAt?: string;
  commitsAhead?: number;
  newest?: { subject: string; date: string };
  oldest?: { subject: string; date: string };
  /** Paths the incoming work touches. PRESENT ONLY when the comparison actually
   * ran: an empty array must mean "they changed nothing", never "rbox could not
   * ask". Absent is the honest answer for an unrelated history, an exhausted
   * budget, or a failed read. */
  files?: string[];
  /** The name list was capped; `files.length` is not the count. */
  filesTruncated?: boolean;
}

/**
 * Which rung of the degrade ladder a repo's incoming facts came from:
 * - `pinned` — the objects are local, so subjects, counts and file lists are real;
 * - `record` — no pin (a pre-273 pause, or a lane that never had an incoming at
 *   all), so only branch, head oid and capture date are knowable offline;
 * - `none` — nothing to say about the other side.
 */
export type GitEvidenceTier = "pinned" | "record" | "none";

export interface GitLocalWork {
  /** The changed files this reading RETAINED names for; capped. */
  files: GitLocalFileChange[];
  /** The true count, which stays exact even when the name list is capped. */
  total: number;
  /** `files` is shorter than `total`. Any set operation over `files` is a
   * lower bound, so consumers must degrade rather than report a number. */
  truncated?: boolean;
  /** Commits on this computer the last sync never carried away. */
  commits: number;
  /** Files git does not track. The take-theirs backup CANNOT contain these, and
   * saying so is the whole point of the preview's "NOT copied" line. */
  untracked: number;
}

export interface GitRepoEvidence {
  repo: string;
  tier: GitEvidenceTier;
  localBranch?: string;
  local?: GitLocalWork;
  incoming?: GitIncomingFacts;
  /** Files changed on BOTH computers — the lead risk number on every surface
   * that shows two sides. Only meaningful at tier `pinned`. */
  overlap?: number;
  /** Set when this repo's budget ran out; its present fields are still true. */
  timedOut?: boolean;
}

/**
 * Sort key for every two-sided surface: the repos where both computers touched
 * the same files lead, and among equals the oldest pause does (design 273 S2,
 * replacing PR-B's age-only order).
 *
 * UNKNOWN outranks KNOWN-ZERO. A repo rbox could not compare might be the worst
 * one in the list, and sorting it below repos it has PROVEN safe would bury the
 * only rows a reader still has to check by hand.
 */
export const evidenceRisk = (evidence: GitRepoEvidence | undefined): number => {
  if (!evidence) return -1;
  return evidence.overlap ?? 0.5;
};
