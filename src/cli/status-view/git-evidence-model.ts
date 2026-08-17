/**
 * The SHAPE of a two-sided Git-pause reading, and nothing else.
 *
 * It exists as its own leaf so a renderer on the daemon path can name the
 * evidence it may be handed WITHOUT importing `git-evidence.ts`, which spawns
 * git. That is not a style preference: the import-cycle gate proved the
 * alternative wired the ambient status renderer to the git-spawning module, and
 * the zero-spawn discipline this design promises is only as good as the
 * dependency direction underneath it.
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
  /** Paths the incoming work touches. Bounded by {@link MAX_FILES}. */
  files?: string[];
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
  files: GitLocalFileChange[];
  total: number;
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

/** Sort key for every two-sided surface: the repos where both computers touched
 * the same files are the ones a person must look at first, and among equals the
 * oldest pause leads (design 273 S2, replacing PR-B's age-only order). */
export const evidenceRisk = (evidence: GitRepoEvidence | undefined): number => evidence?.overlap ?? -1;
