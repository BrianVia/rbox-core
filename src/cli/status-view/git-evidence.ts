/**
 * `evidence()` — the second operation of the Git-pause Module (design 273 P1).
 *
 * `project()` beside it decides WHAT is true from state alone and spawns no git,
 * because the daemon, the headline and doctor all run it on every cycle. This
 * module answers the question state cannot: what did each side actually change.
 * It reads git, so it is MANUAL-COMMAND ONLY — `status --git`, the single-repo
 * view, `--dry-run`. A `setGitSpawnObserver` test pins the daemon path at zero
 * spawns, and nothing here is reachable from it.
 *
 * Three rules the reads obey:
 * - never write `.git/index`. A refreshed index changes the design-270 held-skip
 *   fingerprint of every paused repo a status command touched, so a read surface
 *   would be invalidating the fast path it exists to explain. `--no-optional-locks`
 *   is on EVERY invocation, and the reads are additionally PLUMBING
 *   (`diff-index`, `diff-tree`) rather than porcelain. Porcelain `git diff
 *   <commit>` was observed rewriting the index despite the flag on at least one
 *   platform/version pair here; a second reviewer could not reproduce it on
 *   Linux git 2.54.0. The disagreement is itself the argument — plumbing is
 *   strictly safer and costs nothing, and the invariant is test-gated on the
 *   bytes and mtime rather than on which spelling anyone believes is safe.
 * - degrade field by field, per repo, never block. A repo whose evidence times
 *   out or whose pins are gone still renders its counts and its age.
 * - the projection is NOT a sanitized boundary. Commit subjects, branch labels
 *   and file paths here are remote-authored bytes; they are sanitized at the
 *   render edge with a declared bound, like every other untrusted string.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GitSection } from "../../engine/types.js";
import { git } from "../../engine/git-spawn.js";
import { HEX40 } from "../sync-git/git-state.js";
import { readPendingPins } from "../sync-git/pending-pins.js";
import { gitIncomingKey } from "../sync-git/shared.js";
import { repoDirOf } from "../sync-git/shared.js";
import type { RepoRecord } from "../sync-state-model.js";
import type { GitEvidenceTier, GitIncomingFacts, GitLocalFileChange, GitLocalWork, GitRepoEvidence } from "./git-evidence-model.js";

export type { GitEvidenceTier, GitIncomingFacts, GitLocalFileChange, GitLocalWork, GitRepoEvidence } from "./git-evidence-model.js";

/** How much of the other computer's work a single read will enumerate. Beyond
 * this the counts stay exact and the NAMES stop — a repo with 40k changed files
 * must not turn a status command into an unbounded allocation. */
export const MAX_FILES = 5_000;
/** Per-repo wall-clock budget. A repo on a stalled network filesystem degrades
 * to its counts instead of hanging the whole listing behind it. */
export const EVIDENCE_REPO_TIMEOUT_MS = 3_000;

/** A deadline shared by one repo's whole read. Each call is raced against the
 * remaining budget, so a single slow spawn cannot spend another repo's time. */
class Budget {
  private readonly until: number;
  timedOut = false;
  constructor(ms: number, now: number) { this.until = now + ms; }
  expired(): boolean { return Date.now() >= this.until; }
  /** Takes a THUNK, not a promise: an exhausted budget must not start the work
   * at all, and a started promise nobody awaits is an unhandled rejection. */
  async run<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    if (this.expired()) { this.timedOut = true; return fallback; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<T>((resolve) => {
      timer = setTimeout(() => { this.timedOut = true; resolve(fallback); }, Math.max(1, this.until - Date.now()));
    });
    try {
      return await Promise.race([work().catch(() => fallback), guard]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

const read = (repoDir: string, args: string[]): Promise<string> =>
  git(repoDir, ["--no-optional-locks", ...args]);

/** Counts EVERY changed file and retains names for the first {@link MAX_FILES}.
 * Stopping the parse at the cap would have made `total` the capped number while
 * the header promised an exact count — a repo with 6,000 changed files would
 * have reported 5,000. */
export interface NumstatReading {
  /** Names retained, capped at {@link MAX_FILES}. */
  files: GitLocalFileChange[];
  /** Every changed file, counted whether or not its name was retained. */
  total: number;
}

export function parseNumstat(out: string): NumstatReading {
  const files: GitLocalFileChange[] = [];
  let total = 0;
  for (const line of out.split("\n")) {
    const [added, removed, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (!file || added === undefined || removed === undefined) continue;
    total++;
    // "-" is git's marker for a binary file; it changed, it just has no lines.
    if (files.length < MAX_FILES) {
      files.push({ path: file, added: Number.parseInt(added, 10) || 0, removed: Number.parseInt(removed, 10) || 0 });
    }
  }
  return { files, total };
}

function parseSubject(out: string): { subject: string; date: string } | undefined {
  const separator = out.indexOf("\0");
  if (separator < 0) return undefined;
  return { subject: out.slice(0, separator), date: out.slice(separator + 1).trim() };
}

/** The commit this repo's local work is measured against: the anchor rbox last
 * synced, so "your work here" means "never left this computer" rather than
 * "uncommitted". Falls back to HEAD when no BASE was ever recorded. */
function baseAnchor(base: GitSection | undefined, localBranch: string | undefined): string | undefined {
  if (!base) return undefined;
  const byBranch = localBranch ? base.refs[`refs/heads/${localBranch}`] : undefined;
  if (byBranch && HEX40.test(byBranch)) return byBranch;
  const head = base.head.trim();
  return HEX40.test(head) ? head : undefined;
}

interface IncomingTip {
  oid?: string;
  branch?: string;
}

/** The tip the other computer published for the branch it published. */
function incomingTip(incoming: GitSection): IncomingTip {
  const branch = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(incoming.head)?.[1];
  const oid = branch ? incoming.refs[`refs/heads/${branch}`] : incoming.head.trim();
  const tip: IncomingTip = {};
  if (branch !== undefined) tip.branch = branch;
  if (oid !== undefined && HEX40.test(oid)) tip.oid = oid;
  return tip;
}

interface LocalSide {
  localBranch?: string;
  local: GitLocalWork;
}

async function localSide(repoDir: string, base: GitSection | undefined, budget: Budget): Promise<LocalSide> {
  const branch = (await budget.run(() => read(repoDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]), "")).trim();
  const anchor = baseAnchor(base, branch || undefined) ?? "HEAD";
  const numstat = await budget.run(() => read(repoDir, ["diff-index", "--numstat", anchor]), "");
  const { files, total } = parseNumstat(numstat);
  // mtimes answer "when did I last touch this" on the single-repo view. A repo
  // with thousands of changed files never shows thousands of rows, so only the
  // head of the list pays for a stat.
  await Promise.all(files.slice(0, 50).map(async (file) => {
    const stat = await fs.stat(path.join(repoDir, file.path)).catch(() => undefined);
    if (stat) file.editedAt = stat.mtimeMs;
  }));
  const commits = Number.parseInt(
    (await budget.run(() => read(repoDir, ["rev-list", "--count", `${anchor}..HEAD`]), "")).trim(), 10);
  const untracked = (await budget.run(() => read(repoDir, ["ls-files", "--others", "--exclude-standard"]), ""))
    .split("\n").filter(Boolean).length;
  const local: GitLocalWork = { files, total, commits: Number.isFinite(commits) ? commits : 0, untracked };
  if (files.length < total) local.truncated = true;
  const side: LocalSide = { local };
  if (branch) side.localBranch = branch;
  return side;
}

async function incomingSide(
  repoDir: string,
  relPath: string,
  incoming: GitSection,
  budget: Budget,
): Promise<{ tier: GitEvidenceTier; incoming: GitIncomingFacts }> {
  const { oid, branch } = incomingTip(incoming);
  const offline: GitIncomingFacts = { generatedAt: incoming.generatedAt };
  if (branch !== undefined) offline.branch = branch;
  if (oid !== undefined) offline.headOid = oid;
  if (!oid) return { tier: "record", incoming: offline };
  const pins = await budget.run(() => readPendingPins(repoDir, relPath, gitIncomingKey(incoming)), []);
  if (!pins.includes(oid)) return { tier: "record", incoming: offline };
  const range = `HEAD..${oid}`;
  const ahead = Number.parseInt((await budget.run(() => read(repoDir, ["rev-list", "--count", range]), "")).trim(), 10);
  const newest = parseSubject(await budget.run(() => read(repoDir, ["log", "-1", "--format=%s%x00%aI", oid]), ""));
  const oldest = parseSubject(
    (await budget.run(() => read(repoDir, ["log", "--reverse", "--format=%s%x00%aI", range]), "")).split("\n")[0] ?? "",
  );
  const facts: GitIncomingFacts = { ...offline };
  if (Number.isFinite(ahead)) facts.commitsAhead = ahead;
  if (newest) facts.newest = newest;
  if (oldest) facts.oldest = oldest;
  // Tree-to-tree from the fork point, so the file list is what the other computer
  // ADDED rather than everything the two histories differ by. Plumbing again: the
  // porcelain three-dot spelling reads the worktree index on the way past.
  //
  // `files` is set ONLY when this comparison ran. `merge-base` exits non-zero on
  // unrelated histories and the budget can expire between the pin read and here;
  // either way the fallback is an empty string, and treating that as an empty
  // FILE LIST printed "none changed elsewhere" next to "1 commit newer" — an
  // unknown rendered as a reassurance.
  const forkPoint = (await budget.run(() => read(repoDir, ["merge-base", "HEAD", oid]), "")).trim();
  if (HEX40.test(forkPoint)) {
    const names = await budget.run(
      () => read(repoDir, ["diff-tree", "-r", "--name-only", "--no-commit-id", forkPoint, oid]).then((out) => ({ out })),
      undefined,
    );
    if (names !== undefined) {
      const all = names.out.split("\n").map((line) => line.trim()).filter(Boolean);
      facts.files = all.slice(0, MAX_FILES);
      if (all.length > MAX_FILES) facts.filesTruncated = true;
    }
  }
  return { tier: "pinned", incoming: facts };
}

export interface GitEvidenceRequest {
  root: string;
  /** repo path → its record. Only repos present here are read. */
  records: ReadonlyMap<string, RepoRecord>;
  timeoutMs?: number;
}

/**
 * Read both sides of every named repo. Never throws: a repo that cannot be read
 * is simply absent from the result, and every surface treats absence as "show
 * the age-only form", which is what a pre-273 pause renders anyway.
 */
export async function gitDeferralEvidence(request: GitEvidenceRequest): Promise<Map<string, GitRepoEvidence>> {
  const out = new Map<string, GitRepoEvidence>();
  for (const [repo, record] of request.records) {
    const budget = new Budget(request.timeoutMs ?? EVIDENCE_REPO_TIMEOUT_MS, Date.now());
    const repoDir = repoDirOf(request.root, repo);
    const { localBranch, local } = await localSide(repoDir, record.base, budget);
    const held = record.pending;
    const side = held ? await incomingSide(repoDir, repo, held, budget) : undefined;
    const evidence: GitRepoEvidence = { repo, tier: side?.tier ?? "none" };
    if (localBranch !== undefined) evidence.localBranch = localBranch;
    if (local) evidence.local = local;
    if (side) evidence.incoming = side.incoming;
    if (budget.timedOut) evidence.timedOut = true;
    // Overlap is the lead risk NUMBER on every two-sided surface, so it is only
    // ever set when it is exact. A truncated set on either side, or a budget that
    // expired mid-read, makes it a lower bound — and a lower bound printed as a
    // number is the same lie as the false zero above.
    const theirFiles = side?.incoming.files;
    if (side?.tier === "pinned" && local && theirFiles
      && !budget.timedOut && local.truncated !== true && side.incoming.filesTruncated !== true) {
      const theirs = new Set(theirFiles);
      evidence.overlap = local.files.filter((file) => theirs.has(file.path)).length;
    }
    out.set(repo, evidence);
  }
  return out;
}

