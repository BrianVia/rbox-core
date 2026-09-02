/** #832 shadow mode: the boring ff-only verdict, computed beside the proof
 * plane and recorded — never acted on.
 *
 * Design note `docs/design/notes/2026-09-01-832-git-plane-evaluation.md` §10
 * asks one question the corpus cannot answer from taste: how often would a
 * 29-line `merge-base --is-ancestor` + `merge --ff-only` plane have landed what
 * the proof plane deferred, and how often would it have moved a ref the proof
 * plane was right to hold? This module answers it by computing both verdicts
 * per pull and writing down the cross-tab.
 *
 * The note's §7.4 counter-argument is the load-bearing constraint here:
 * `git merge --ff-only` collapses "not a fast-forward" and "I could not tell"
 * into one non-zero exit, and a candidate that reads the second as the first
 * reintroduces the forever-defer loop `preflight.ts` exists to prevent. So this
 * shadow mirrors `reachability.ts:16-18`'s THREE-valued answer: an
 * indeterminate ancestry (shallow store, missing object, walk error) is
 * `hold`, a class of its own, and is never flattened into `adopt` or `defer`.
 *
 * Never: ref mutation, checkout, policy. Every function here is read-only
 * against the repository, and the only write is the counter file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../../engine/fsutil.js";
import { git, gitRaw } from "../../engine/git-spawn.js";
import { gitProcessExitCode, graphEnv, type GitProcessFailure, type OwnershipProofContext } from "./reachability.js";
import { branchesCheckedOutElsewhereStrict } from "./git-state-apply.js";
import { type RepoCtx } from "./git-state.js";
import { stateRootPath } from "../state-plane/paths.js";
import { OP_STATE_CLASSIFICATION } from "../../engine/manifest-validate.js";
import { opStateRootOf, type FollowResult, type LiveMetadata } from "./follow-types.js";

/** Default ON — the lane is read-only. Registered in `defaults-ledger.test.ts`
 * with its deletion condition. */
export const gitShadowEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_SHADOW !== "0";

export const GIT_SHADOW_COUNTER_FILE = "git-shadow.json";

export type ShadowIndeterminate = "shallow-store" | "missing-object" | "walk-error";

/** The four answers a boring plane can give for one repository.
 *  - `noop`   every incoming branch already equals the local one.
 *  - `adopt`  at least one branch fast-forwards and none blocks.
 *  - `defer`  a branch diverged, an operation is in progress, or the
 *             fast-forward would overwrite local work (git's own ff-only
 *             refusal, expressed as a predicate — never a simulated merge).
 *  - `hold`   the ancestry answer was INDETERMINATE. Distinct from `defer` on
 *             purpose (§7.4): a defer retries, a hold must not become one. */
export type ShadowVerdict =
  | { kind: "noop" }
  | { kind: "adopt" }
  | { kind: "defer"; why: "diverged" | "dirty-overlap" | "operation-in-progress" | "sibling-worktree" }
  | { kind: "hold"; why: ShadowIndeterminate };

export interface ShadowSnapshot {
  verdict: ShadowVerdict;
  /** Incoming branch refs the verdict considered. */
  refs: number;
}

export const shadowClass = (verdict: ShadowVerdict): string =>
  verdict.kind === "noop" || verdict.kind === "adopt" ? verdict.kind : `${verdict.kind}:${verdict.why}`;

/** Exactly `reachability.ts`'s mapping of a failed graph walk: 128 is a missing
 * object, anything else is a walk error. Neither is evidence of divergence. */
const markerForCode = (code: number | undefined): ShadowIndeterminate =>
  code === 128 ? "missing-object" : "walk-error";

const markerFor = (error: GitProcessFailure): ShadowIndeterminate => markerForCode(gitProcessExitCode(error));

type Ancestry = { status: "ancestor" | "diverged" } | { status: "indeterminate"; marker: ShadowIndeterminate };

/** One `merge-base --is-ancestor`: exit 0 = fast-forwardable, exit 1 = the only
 * exit that means diverged, everything else = indeterminate.
 * ponytail: one subprocess per moved branch. A repo that moves dozens of
 * branches in one pull pays dozens; batch into a single `rev-list` walk if
 * `shadowMs` ever shows that shape in the field. */
async function ancestry(repoDir: string, local: string, incoming: string): Promise<Ancestry> {
  try {
    await git(repoDir, ["merge-base", "--is-ancestor", local, incoming], { env: graphEnv });
    return { status: "ancestor" };
  } catch (error) {
    const code = gitProcessExitCode(error as GitProcessFailure);
    // Exit 1 is the ONLY exit that means "not an ancestor". Everything else is
    // indeterminate — this is §7.4's whole objection to `--ff-only`.
    if (code === 1) return { status: "diverged" };
    return { status: "indeterminate", marker: markerForCode(code) };
  }
}

const splitZ = (raw: string): string[] => raw.split("\0").filter((entry) => entry !== "");

type Overlap = { status: "clean" | "overlap" } | { status: "indeterminate"; marker: ShadowIndeterminate };

const ABSENT = "0".repeat(40);

/** Above this many written paths the predicate stops reading and HOLDS. A cap
 * that guessed either way would be a silent bias in the one number this whole
 * lane exists to produce. */
const OVERLAP_PATH_CAP = 5_000;

/** git's own ff-only refusal, as a predicate — with one deliberate correction
 * for the world the candidate plane would actually run in.
 *
 * ONE RULE. For every path the fast-forward would write, let `h` be the working
 * tree's content (absent counts as its own value). The path blocks iff
 * `h !== src && h !== dst`, where src and dst are the local and incoming blobs
 * the `--raw` diff already carries.
 *
 *  - `h === src`  the receiver never touched it; git overwrites it freely.
 *  - `h === dst`  THE CORRECTION, below.
 *  - otherwise    the receiver authored content there, and git refuses.
 *
 * That single comparison covers modifications, additions over untracked files
 * (which `diff-index` cannot see at all), deletions blocked by local edits, and
 * a locally-deleted file the incoming updates — with no second git call.
 *
 * THE CORRECTION (`h === dst`). Under the shipped plane, rbox's FILE plane has
 * usually already written the incoming content into the working tree by the
 * time the git plane runs. Literal `merge --ff-only` refuses there — it starts
 * from index entries, not content — so a content-blind predicate would report
 * `dirty-overlap` on very nearly every pull, and the week's table would measure
 * rbox's own file plane instead of the candidate. In the world §10 describes,
 * git owns the checkout and that content would never have been pre-written, so
 * a path already holding the incoming blob is not receiver work.
 * `git-shadow.test.ts` pins both readings side by side.
 *
 * NOT `git diff-index --name-only`, which was the first thing written here and
 * was wrong: its raw output is STAT-dirty, so a file rbox rewrote with
 * identical content reads as modified and the shadow deferred a repository git
 * would have fast-forwarded. Content is the only sound input.
 *
 * ponytail: one hash per written path, and only when the checked-out branch
 * really fast-forwards — the same files the file plane just wrote. Past
 * `OVERLAP_PATH_CAP` paths the answer is a hold rather than a guess.
 * Mode-only changes (100644 → 100755) also make real ff-only refuse and are not
 * modelled. */
async function dirtyOverlap(repoDir: string, local: string, incoming: string): Promise<Overlap> {
  // `--raw` carries the incoming blob oid, so the content comparison below
  // needs no second tree read.
  let records: string[];
  try {
    records = splitZ(await gitRaw(repoDir, ["diff", "--raw", "-z", "--no-renames", "--abbrev=40", local, incoming], { env: graphEnv }));
  } catch (error) {
    return { status: "indeterminate", marker: markerFor(error as GitProcessFailure) };
  }
  const written = new Map<string, { src: string; dst: string }>();
  for (let i = 0; i + 1 < records.length; i += 2) {
    // ":<srcmode> <dstmode> <srcsha> <dstsha> <status>"
    const fields = records[i]!.split(" ");
    written.set(records[i + 1]!, { src: fields[2] ?? ABSENT, dst: fields[3] ?? ABSENT });
  }
  if (written.size === 0) return { status: "clean" };
  if (written.size > OVERLAP_PATH_CAP) return { status: "indeterminate", marker: "walk-error" };

  // `hash-object --stdin-paths` fails the whole batch on a missing path, so an
  // absent file is settled here rather than sent to git.
  const present: string[] = [];
  for (const [file, { src, dst }] of written) {
    if (await fs.access(path.join(repoDir, file)).then(() => true, () => false)) present.push(file);
    else if (src !== ABSENT && dst !== ABSENT) return { status: "overlap" };   // locally deleted, incoming updates
  }
  if (present.length === 0) return { status: "clean" };

  let hashes: string[];
  try {
    hashes = (await gitRaw(repoDir, ["hash-object", "--stdin-paths"], {
      env: graphEnv,
      stdin: present.join("\n") + "\n",
    })).split("\n").map((line) => line.trim()).filter((line) => line !== "");
  } catch (error) {
    return { status: "indeterminate", marker: markerFor(error as GitProcessFailure) };
  }
  if (hashes.length !== present.length) return { status: "indeterminate", marker: "walk-error" };
  for (const [index, file] of present.entries()) {
    const { src, dst } = written.get(file)!;
    if (hashes[index] !== src && hashes[index] !== dst) return { status: "overlap" };
  }
  return { status: "clean" };
}

/** Compute the boring plane's verdict for one repository.
 *
 * Reads only: the receiver's refs as the proof plane already read them, the
 * incoming ref map, and — when the checked-out branch fast-forwards — git's own
 * would-this-overwrite-local-work answer. No bundle fetch, no ref writes. */
export async function shadowVerdict(args: {
  ctx: RepoCtx;
  live: LiveMetadata;
  incomingRefs: Readonly<Record<string, string>>;
  ownershipContext: OwnershipProofContext;
}): Promise<ShadowSnapshot> {
  const repoDir = args.ctx.repoDir;
  const branches = Object.entries(args.incomingRefs).filter(([ref]) => ref.startsWith("refs/heads/"));
  const refs = branches.length;

  /** §7.2(4): the rig's CAS arm would corrupt a linked worktree, because
   * `update-ref` silently moves a branch a sibling has checked out where
   * `git branch -f` refuses. A candidate that ignores this scores flatteringly,
   * and this lane exists to produce an honest score — so a sibling-owned branch
   * defers, and an unreadable registry HOLDS rather than being read as "no
   * sibling owns it" (`branchesCheckedOutElsewhereStrict`'s own rule).
   * Enumerated at most once, and only when a non-current branch really moves. */
  let siblings: Map<string, string> | "unreadable" | undefined;
  const siblingOwned = async (ref: string): Promise<boolean | "unreadable"> => {
    if (siblings === undefined) {
      const strict = await branchesCheckedOutElsewhereStrict(args.ctx).catch(() => ({ status: "unreadable" as const }));
      siblings = strict.status === "ok" ? strict.owned : "unreadable";
    }
    return siblings === "unreadable" ? "unreadable" : siblings.has(ref);
  };

  // Rig W7 (§7.1): a repository mid-merge or mid-rebase defers wholesale. The
  // proof plane's own net predicate is the same one.
  const inProgress = Object.keys(args.live.opState).some((rel) => OP_STATE_CLASSIFICATION[opStateRootOf(rel)] === "in-progress")
    || args.live.opStateRootsPresent.some((rel) => OP_STATE_CLASSIFICATION[rel] === "in-progress");
  if (inProgress) return { verdict: { kind: "defer", why: "operation-in-progress" }, refs };

  // A shallow store cannot answer ancestry at all. Three-valued, so: hold.
  if (args.ownershipContext.shallow !== false) {
    return {
      verdict: { kind: "hold", why: args.ownershipContext.shallow ? "shallow-store" : "walk-error" },
      refs,
    };
  }

  let adoptable = false;
  let diverged = false;
  for (const [ref, incoming] of branches) {
    const local = args.live.refs[ref];
    if (local === undefined) { adoptable = true; continue; }   // new branch: a plain create
    if (local === incoming) continue;                          // equal
    const result = await ancestry(repoDir, local, incoming);
    // Indeterminate wins outright and immediately: it must never be reported as
    // a divergence the plane could retry away (§7.4).
    if (result.status === "indeterminate") return { verdict: { kind: "hold", why: result.marker }, refs };
    if (result.status === "diverged") { diverged = true; continue; }
    adoptable = true;
    if (ref === args.live.currentRef) {
      const overlap = await dirtyOverlap(repoDir, local, incoming);
      if (overlap.status === "indeterminate") return { verdict: { kind: "hold", why: overlap.marker }, refs };
      if (overlap.status === "overlap") return { verdict: { kind: "defer", why: "dirty-overlap" }, refs };
    } else {
      const owned = await siblingOwned(ref);
      if (owned === "unreadable") return { verdict: { kind: "hold", why: "walk-error" }, refs };
      if (owned) return { verdict: { kind: "defer", why: "sibling-worktree" }, refs };
    }
  }
  if (diverged) return { verdict: { kind: "defer", why: "diverged" }, refs };
  return { verdict: { kind: adoptable ? "adopt" : "noop" }, refs };
}

/** Held-ref reasons, most-specific first, so one repo's class is deterministic. */
const HELD_REASONS = ["local-commits", "local-stash", "ownership"] as const;

/** The proof plane's own verdict for this repo, as one class string:
 * `applied` / `held:<reason>` / `deferred:<reason>`. A `legacy` result is a
 * deferral by another name — the checkout did not land. */
export function planeVerdictClass(result: FollowResult): string {
  if (result.status !== "followed") return `deferred:${result.reason}`;
  const held = new Set(Object.values(result.heldRefs));
  const reason = HELD_REASONS.find((candidate) => held.has(candidate));
  return reason ? `held:${reason}` : "applied";
}

export interface ShadowCounters {
  version: 1;
  firstSeen: string;
  lastSeen: string;
  agree: number;
  disagree: number;
  /** The full cross-tab, keyed `<plane class>|<shadow class>`. The doctor line
   * is one reading of it; the week-end table is another. Keeping the raw pairs
   * means a rule chosen today cannot foreclose the analysis. */
  pairs: Record<string, number>;
}

const EMPTY: ShadowCounters = { version: 1, firstSeen: "", lastSeen: "", agree: 0, disagree: 0, pairs: {} };

export const gitShadowCounterPath = (workspaceRoot: string): string =>
  path.join(stateRootPath(workspaceRoot), GIT_SHADOW_COUNTER_FILE);

/** Parse the counter document at its I/O boundary, field by field. The file is
 * human-editable by design (that is the point of a JSON tally someone reads at
 * week's end), so a hand-mangled field must degrade to a default rather than
 * reach the doctor line as `undefined` or `NaN`. */
function parseCounters(text: string): ShadowCounters | undefined {
  const doc = JSON.parse(text) as Partial<ShadowCounters>;
  if (doc.version !== 1) return undefined;
  const count = (value: number | undefined) => Number.isFinite(value) ? value! : 0;
  const stamp = (value: string | undefined) => value ?? "";
  const pairs: Record<string, number> = {};
  // `?? {}` also catches a null; `Object.entries` of a non-object is empty.
  for (const [key, value] of Object.entries(doc.pairs ?? {})) pairs[key] = count(value);
  return {
    version: 1,
    firstSeen: stamp(doc.firstSeen),
    lastSeen: stamp(doc.lastSeen),
    agree: count(doc.agree),
    disagree: count(doc.disagree),
    pairs,
  };
}

export async function readShadowCounters(workspaceRoot: string): Promise<ShadowCounters | undefined> {
  try {
    return parseCounters(await fs.readFile(gitShadowCounterPath(workspaceRoot), "utf8"));
  } catch {
    return undefined;
  }
}

/** The plane moved refs; the shadow would have. `noop` is neither — the shadow
 * had nothing to move, so it cannot disagree with anything. */
const agrees = (planeClass: string, shadow: ShadowVerdict): boolean =>
  shadow.kind === "noop" || (shadow.kind === "adopt") === (planeClass === "applied");

/** Accumulate one repo's pull into the counter file. Read-modify-write of a
 * small JSON, rewritten atomically — it is meant to be read by a human at
 * week's end, so it stays legible rather than becoming a table.
 * ponytail: last-writer-wins if repos are ever followed concurrently; batch per
 * pull if that lands. */
export async function recordShadow(args: {
  workspaceRoot: string;
  relPath: string;
  planeClass: string;
  snapshot: ShadowSnapshot;
  now?: string;
  log?: (line: string) => void;
}): Promise<void> {
  const shadow = shadowClass(args.snapshot.verdict);
  const agree = agrees(args.planeClass, args.snapshot.verdict);
  if (!agree) {
    args.log?.(`git-shadow disagree ${args.relPath}: plane=${args.planeClass} shadow=${shadow} refs=${args.snapshot.refs}`);
  }
  const at = args.now ?? new Date().toISOString();
  const current = await readShadowCounters(args.workspaceRoot) ?? EMPTY;
  const key = `${args.planeClass}|${shadow}`;
  const next: ShadowCounters = {
    version: 1,
    firstSeen: current.firstSeen || at,
    lastSeen: at,
    agree: current.agree + (agree ? 1 : 0),
    disagree: current.disagree + (agree ? 0 : 1),
    pairs: { ...current.pairs, [key]: (current.pairs[key] ?? 0) + 1 },
  };
  await fs.mkdir(stateRootPath(args.workspaceRoot), { recursive: true });
  await writeFileAtomic(gitShadowCounterPath(args.workspaceRoot), JSON.stringify(next, null, 2));
}

const sumPairs = (counters: ShadowCounters, match: (plane: string, shadow: string) => boolean): number => {
  let total = 0;
  for (const [key, count] of Object.entries(counters.pairs)) {
    const split = key.indexOf("|");
    if (split > 0 && match(key.slice(0, split), key.slice(split + 1))) total += count;
  }
  return total;
};

/** The `rbox doctor` line. Not a status line: shadow mode is a measurement, and
 * nothing here is user-actionable. */
export function shadowDoctorLine(counters: ShadowCounters): string {
  const n = (value: number) => value.toLocaleString("en-US");
  const wouldAdopt = sumPairs(counters, (plane, shadow) => plane.startsWith("deferred:") && shadow === "adopt");
  const wouldHold = sumPairs(counters, (plane, shadow) => shadow.startsWith("hold:") && plane === "applied");
  const detail = counters.disagree === 0
    ? ""
    : ` (plane deferred, shadow would adopt: ${n(wouldAdopt)}; shadow would hold, plane applied: ${n(wouldHold)})`;
  return `  git shadow: ${n(counters.agree)} agree · ${n(counters.disagree)} disagree${detail}`;
}
