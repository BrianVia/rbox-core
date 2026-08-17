/**
 * `rbox git resolve --under <folder> <verb>` — design 273 S4's batch.
 *
 * The defect: a fleet-scale unwedge was N hand-typed two-step commands. The
 * risk in fixing it: batch consent is weaker than per-repo consent, and saying
 * otherwise would be a lie. So this module is deliberately an ADAPTER over the
 * single-repo command and adds no mutation path of its own —
 * {@link gitResolveCmd} still owns the mutex, the refusals, and the
 * confirmation token. What batch adds is selection, one frozen preview, and a
 * summary.
 *
 * The safety property that survives verbatim: the preview captures each repo's
 * snapshot token, and execution passes THAT token back to the single-repo verb,
 * which recomputes it under the lock and refuses on any change. A repo whose
 * state moved between preview and execution is skipped and reported, never
 * silently resolved against a stale reading.
 *
 * The honest limit (named, accepted trade): this preserves the token's
 * state-change detection exactly; it does NOT bind consent to a per-repo
 * reviewed preview. Consent is bound to a COUNT — the reader types how many
 * repos, so a habit formed on three repos cannot quietly act on ninety-eight.
 *
 * Scope this PR: `show-me` and `keep-mine`. Batch `take-theirs` refuses, because
 * it is a one-way door and the command that undoes it has not shipped yet.
 */
import { isInteractive, promptInput } from "../prompt.js";
import type { GitDeferralRepoProjection } from "../status-view/git-projection.js";
import { gitDeferralEvidence } from "../status-view/git-evidence.js";
import { evidenceRisk } from "../status-view/git-evidence-model.js";
import type { GitRepoEvidence } from "../status-view/git-evidence-model.js";
import { sanitizeTerminalText } from "../status-view/text.js";
import type { RepoRecordsByPath } from "../sync-state-model.js";
import { repoDirOf } from "../sync-git/shared.js";
import { gitResolveCmd } from "./resolve-command.js";
import type { GitResolveDeps, GitResolveVerb } from "./resolve-contract.js";
import type { ResolveOutput } from "./resolve-presentation.js";

export interface GitResolveBatchOptions {
  /** Workspace-relative folder; "." means the whole workspace. */
  under: string;
  /** Story code, as an ADDITIONAL narrowing of `--under`. */
  group?: string;
  verb: GitResolveVerb;
  dryRun?: boolean;
  yes?: boolean;
  /** The repo count the caller believes it is acting on. Required beside `--yes`;
   * a mismatch refuses. */
  expectRepos?: number;
  forceDiscardIncoming?: boolean;
}

export interface GitResolveBatchInput {
  rows: readonly GitDeferralRepoProjection[];
  records: RepoRecordsByPath;
}

/** Every repo the selector names that batch may act on. `resolvable` is the
 * projection's ONE predicate for "may a surface print a resolve command here";
 * batch consults it rather than re-deriving the rule. */
export function selectBatchRepos(
  rows: readonly GitDeferralRepoProjection[],
  options: Pick<GitResolveBatchOptions, "under" | "group">,
): GitDeferralRepoProjection[] {
  const prefix = options.under === "." ? "" : `${options.under.replace(/\/+$/, "")}/`;
  return rows.filter((row) =>
    row.resolvable
    && (prefix === "" || row.repo === options.under || row.repo.startsWith(prefix))
    && (options.group === undefined || row.story.code === options.group));
}

const repos = (n: number): string => `${n} repo${n === 1 ? "" : "s"}`;

/**
 * One single-repo invocation, with its TYPED outcome observed rather than its
 * stdout parsed. The output is suppressed: batch composes its own summary from
 * the outcomes, so N per-repo reports never reach the terminal.
 *
 * The command resolves its repository argument against the PROCESS directory,
 * so batch hands it an absolute path — the workspace-relative name would resolve
 * against wherever the shell happens to be.
 */
async function runOne(
  root: string,
  repo: string,
  verb: GitResolveVerb,
  options: { confirm?: string },
  deps: GitResolveDeps,
): Promise<ResolveOutput | undefined> {
  let outcome: ResolveOutput | undefined;
  await gitResolveCmd(root, repoDirOf(root, repo), verb, options, {
    ...deps,
    observeOutput: (output) => { outcome = output; },
    stdout: () => {},
    stderr: () => {},
  });
  return outcome;
}

interface Frozen {
  repo: string;
  snapshot: string;
}

/** The overlap clause, spelled exactly as the `status --git` listing spells it —
 * two vocabularies for the same number is how a reader learns to distrust both. */
function evidenceCell(evidence: GitRepoEvidence | undefined): string {
  const local = evidence?.local;
  if (!local) return "not read";
  if (evidence?.overlap === undefined) return "can't compare";
  return evidence.overlap > 0 ? `${evidence.overlap} also changed on another computer ⚠` : "none changed elsewhere";
}

export interface PreviewRow {
  repo: string;
  evidence: GitRepoEvidence | undefined;
  why: string;
}

const previewRows = (
  rows: readonly GitDeferralRepoProjection[],
  readings: ReadonlyMap<string, GitRepoEvidence>,
): PreviewRow[] => rows
  .map((row) => ({ repo: row.repo, evidence: readings.get(row.repo), why: row.story.headline }))
  // Risk-first, matching the listing: the repos both computers touched lead, and
  // the ones rbox could not compare rank above the ones it proved safe.
  .sort((a, b) => evidenceRisk(b.evidence) - evidenceRisk(a.evidence) || a.repo.localeCompare(b.repo));

const HEADERS = ["repo", "your files", "also changed elsewhere", "why it's paused"] as const;

/** Test seam: the table is pure, and its honesty about partial reads is worth
 * pinning without standing up a workspace to produce one. */
export const previewTableForTest = (entries: readonly PreviewRow[]): string[] => previewTable(entries);

/** A four-column table sized from its own contents, headers included — padding to
 * a guessed constant misaligned the moment a count reached three digits. */
function previewTable(entries: readonly PreviewRow[]): string[] {
  const cells = entries.map((entry) => [
    sanitizeTerminalText(entry.repo),
    entry.evidence?.local === undefined ? "—" : String(entry.evidence.local.total),
    evidenceCell(entry.evidence),
    entry.why,
  ]);
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...cells.map((row) => row[column]!.length)));
  const line = (row: readonly string[]): string =>
    `   ${row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!, " "))).join("   ")}`.trimEnd();
  const lines = [line(HEADERS), ...cells.map(line), ""];
  const fileTotal = entries.reduce((total, entry) => total + (entry.evidence?.local?.total ?? 0), 0);
  const bothTotal = entries.reduce((total, entry) => total + (entry.evidence?.overlap ?? 0), 0);
  const uncompared = entries.filter((entry) => entry.evidence?.overlap === undefined).length;
  // A repo rbox could not read contributes 0 to the sum, and an unqualified
  // total presents that as a fact. Same defect as the dry run's "nothing to
  // save": the number is only as good as the reads behind it, so it says how
  // many it had.
  const unread = entries.filter((entry) => entry.evidence?.local === undefined).length;
  const across = unread === 0 ? "" : ` across the ${entries.length - unread} of them rbox could read`;
  lines.push(`Total: ${repos(entries.length)} · ${fileTotal} files you changed here get published${across}`);
  if (bothTotal > 0) lines.push(`       ${bothTotal} of those files also changed on another computer ⚠`);
  if (uncompared > 0) lines.push(`       ${repos(uncompared)} rbox could not compare with the other computer`);
  return lines;
}

const FORCE_FOREWARNING = [
  "In some repos the other computer's newer work can't be kept alongside yours —",
  "rbox lists them and asks separately. The other computer keeps its own copy",
  "either way. Run those one at a time:",
];

const takeTheirsRefusal = (selected: readonly GitDeferralRepoProjection[]): string[] => [
  "rbox will not take the other computer's version in bulk yet.",
  "Doing it one repo at a time saves a backup you can go back to; there is no",
  "command to put those backups back yet, so a bulk switch would be a one-way",
  "door across every repo at once. That command is being built — until it ships,",
  "run take-theirs one repo at a time:",
  // Real repo names, so the reader can copy a line rather than translate a
  // placeholder into the path they were never shown.
  ...selected.slice(0, 5).map((row) => `   rbox git resolve ${sanitizeTerminalText(row.repo)} take-theirs --dry-run`),
  ...(selected.length > 5 ? [`   … and ${selected.length - 5} more (see rbox status --git)`] : []),
];

const FORCE_REFUSAL = [
  "--force-discard-incoming is never applied to a whole folder: it means throwing",
  "away work the other computer is waiting to send, and that decision belongs to",
  "one repo at a time.",
  "Run the same command WITHOUT it — rbox lists the repos that need it, and you",
  "run those individually.",
];

/**
 * The batch entry point. Returns a process exit code; it is non-zero only when
 * the selector or the confirmation refused, never because a single repo was
 * skipped — a skipped repo is reported and the rest still run.
 */
export async function gitResolveBatchCmd(
  root: string,
  options: GitResolveBatchOptions,
  input: GitResolveBatchInput,
  deps: GitResolveDeps = {},
): Promise<number> {
  const write = deps.stdout ?? console.log;
  const dryRun = options.dryRun === true;
  const under = sanitizeTerminalText(options.under);
  const selected = selectBatchRepos(input.rows, options);
  if (options.verb === "take-theirs") {
    for (const line of takeTheirsRefusal(selected)) write(line);
    return 1;
  }
  if (options.forceDiscardIncoming === true) {
    for (const line of FORCE_REFUSAL) write(line);
    return 1;
  }
  if (selected.length === 0) {
    write(`No paused repos under ${under} can be resolved this way.`);
    return 0;
  }
  if (options.verb === "show-me") {
    if (dryRun) {
      // Matches the single-repo verb's answer rather than inventing a
      // hypothetical — and, critically, does NOT stage every selected repo to
      // say so.
      write("`show-me` only reads; it never changes anything here, with or without --dry-run.");
      write(`It would show you ${repos(selected.length)} under ${under}.`);
      return 0;
    }
    for (const row of selected) await gitResolveCmd(root, repoDirOf(root, row.repo), "show-me", {}, deps);
    return 0;
  }

  const evidenceFor = async (rows: readonly GitDeferralRepoProjection[]): Promise<Map<string, GitRepoEvidence>> =>
    gitDeferralEvidence({
      root,
      records: new Map(rows.flatMap((row) => {
        const record = input.records[row.repo];
        return record ? [[row.repo, record] as const] : [];
      })),
    });

  // A preview must not be able to change what it describes. Freezing a
  // confirmation token per repo means STAGING each one — network fetches and
  // pack imports — so the dry run never reaches that loop and reads only what
  // `status --git` reads. Tokens are execution-only.
  if (dryRun) {
    write("This is a preview — nothing on this computer changed.");
    write(`Keeping this computer's work would publish ${repos(selected.length)} under ${under}:`);
    for (const line of previewTable(previewRows(selected, await evidenceFor(selected)))) write(line);
    write("");
    write("rbox re-checks each repo when you run it for real, and asks separately");
    write("about any repo whose incoming work cannot be kept alongside yours, so the");
    write("number it finally acts on can be smaller than the list above.");
    write("To actually do it, run the same command without --dry-run.");
    // Deliberately no number: `--expect-repos` is compared against the count
    // rbox will actually act on, and this preview cannot know that count without
    // staging every repo — which is exactly what a preview must not do. Printing
    // the selected count here would advise a value the gate then rejects.
    if (options.yes === true) {
      write("For a script, add --expect-repos <n> — run it once without --yes to see the number.");
    }
    return 0;
  }

  const frozen: Frozen[] = [];
  const needsForce: string[] = [];
  const refused: string[] = [];
  for (const row of selected) {
    // The unconfirmed keep-mine preview is read-only and already answers both
    // questions batch has: the confirmation token, and whether publishing here
    // would DISCARD incoming work.
    const preview = await runOne(root, row.repo, "keep-mine", {}, deps);
    // A repo whose preview refuses — busy, mid-operation, a moved snapshot —
    // used to be dropped here and appear NOWHERE: not in the table, not in the
    // count, not in the report. A repo silently missing from a batch is
    // indistinguishable from one rbox handled.
    if (preview?.status !== "preview") refused.push(row.repo);
    else if (preview.confirm.forceDiscardIncoming) needsForce.push(row.repo);
    else frozen.push({ repo: row.repo, snapshot: preview.confirm.snapshot });
  }
  const frozenRows = selected.filter((row) => frozen.some((entry) => entry.repo === row.repo));
  write(`About to keep this computer's work in ${repos(frozen.length)} under ${under}:`);
  for (const line of previewTable(previewRows(frozenRows, await evidenceFor(frozenRows)))) write(line);
  if (needsForce.length > 0) {
    write("");
    for (const line of FORCE_FOREWARNING) write(line);
    for (const repo of needsForce) write(`   rbox git resolve ${sanitizeTerminalText(repo)} keep-mine`);
  }
  if (refused.length > 0) {
    write("");
    write(`rbox cannot keep this computer's work in ${repos(refused.length)} right now — run`);
    write("each one on its own to see why:");
    for (const repo of refused) write(`   rbox git resolve ${sanitizeTerminalText(repo)} keep-mine`);
  }
  if (frozen.length === 0) return 0;
  // Consent is bound to the count that will actually be acted on, which is the
  // FROZEN count — the repos needing a separate command are not part of it.
  if (options.expectRepos !== undefined && options.expectRepos !== frozen.length) {
    write("");
    write(`--expect-repos ${options.expectRepos} does not match: rbox would act on ${repos(frozen.length)}.`);
    write("Nothing changed. Re-run with the right number once you have looked at the list.");
    return 1;
  }
  if (!await confirmedCount(frozen.length, options, write)) {
    write("Nothing changed.");
    return 1;
  }
  return await executeFrozen(root, frozen, deps, write);
}

/**
 * Confirmation scales with blast radius: the reader types the COUNT, so consent
 * cannot be a reflex.
 *
 * `--yes` alone is NOT the scriptable twin — a script written against three
 * repos would silently act on ninety-eight the day the fleet drifted. `--yes`
 * requires `--expect-repos <n>`, which is checked against the frozen count
 * before this is reached, so the scriptable path binds consent to a number the
 * script's author actually wrote down.
 */
async function confirmedCount(
  count: number,
  options: GitResolveBatchOptions,
  write: (line: string) => void,
): Promise<boolean> {
  if (options.yes === true) {
    if (options.expectRepos !== undefined) return true;
    write("");
    write(`--yes needs --expect-repos <n> so a script cannot act on a number nobody chose. Here that is --expect-repos ${count}.`);
    return false;
  }
  if (!isInteractive()) {
    write(`Add --yes --expect-repos ${count} to run this without a terminal.`);
    return false;
  }
  const typed = await promptInput({ message: `Type ${count} to keep this computer's work in ${repos(count)}:` });
  return typed.trim() === String(count);
}

async function executeFrozen(
  root: string,
  frozen: readonly Frozen[],
  deps: GitResolveDeps,
  write: (line: string) => void,
): Promise<number> {
  const published: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const entry of frozen) {
    // The token IS the re-verification: the single-repo verb recomputes the
    // snapshot under the lock and refuses when it moved.
    const outcome = await runOne(root, entry.repo, "keep-mine", { confirm: entry.snapshot }, deps);
    if (outcome?.status === "published") published.push(entry.repo);
    else if (outcome?.status === "snapshot-mismatch") skipped.push(entry.repo);
    else failed.push(entry.repo);
  }
  write("");
  write(`Published ${repos(published.length)}.`);
  if (skipped.length > 0) {
    const those = skipped.length === 1 ? "that one" : "those";
    write(`Skipped ${repos(skipped.length)} that changed while rbox was working — run the command again for ${those}:`);
    for (const repo of skipped) write(`   ${sanitizeTerminalText(repo)}`);
  }
  if (failed.length > 0) {
    write(`${repos(failed.length)} could not be published; run each one on its own to see why:`);
    for (const repo of failed) write(`   rbox git resolve ${sanitizeTerminalText(repo)} keep-mine`);
  }
  return failed.length > 0 ? 1 : 0;
}
