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
import { gitDeferralEvidence, type GitRepoEvidence } from "../status-view/git-evidence.js";
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

/** Runs one single-repo invocation with `--json` captured, whatever the caller's
 * own output mode is. The batch needs the machine answer to classify outcomes;
 * the human summary is composed here from those answers. */
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

function evidenceCell(evidence: GitRepoEvidence | undefined): string {
  const local = evidence?.local;
  if (!local) return "";
  const both = evidence?.overlap ?? 0;
  const mine = `${local.total} yours`;
  return both > 0 ? `${mine}, ${both} on both ⚠` : mine;
}

function previewTable(
  frozen: readonly Frozen[],
  rows: readonly GitDeferralRepoProjection[],
  readings: ReadonlyMap<string, GitRepoEvidence>,
): string[] {
  const width = Math.max(0, ...frozen.map((entry) => sanitizeTerminalText(entry.repo).length));
  const lines: string[] = [];
  let bothTotal = 0;
  let fileTotal = 0;
  for (const entry of frozen) {
    const evidence = readings.get(entry.repo);
    bothTotal += evidence?.overlap ?? 0;
    fileTotal += evidence?.local?.total ?? 0;
    const waiting = rows.find((row) => row.repo === entry.repo)?.story.headline ?? "";
    lines.push(`   ${sanitizeTerminalText(entry.repo).padEnd(width, " ")}   ${evidenceCell(evidence).padEnd(20, " ")} ${waiting}`);
  }
  lines.push("");
  lines.push(`Total: ${repos(frozen.length)} · ${fileTotal} files you changed here get published`);
  if (bothTotal > 0) lines.push(`       ${bothTotal} of those files also changed on another computer ⚠`);
  return lines;
}

const FORCE_FOREWARNING = [
  "In some repos the other computer's newer work can't be kept alongside yours —",
  "rbox lists them and asks separately. The other computer keeps its own copy",
  "either way. Run those one at a time:",
];

const TAKE_THEIRS_REFUSAL = [
  "rbox will not take the other computer's version in bulk yet.",
  "Doing it one repo at a time saves a backup you can go back to; there is no",
  "command to put those backups back yet, so a bulk switch would be a one-way",
  "door across every repo at once. That command is being built — until it ships,",
  "run take-theirs per repo:",
  "  rbox git resolve <repo> take-theirs --dry-run",
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
  if (options.verb === "take-theirs") {
    for (const line of TAKE_THEIRS_REFUSAL) write(line);
    return 1;
  }
  if (options.forceDiscardIncoming === true) {
    write("--force-discard-incoming can only be given to one repo at a time; rbox lists the repos that need it.");
    return 1;
  }
  const selected = selectBatchRepos(input.rows, options);
  if (selected.length === 0) {
    write(`No paused repos under ${sanitizeTerminalText(options.under)} can be resolved this way.`);
    return 0;
  }
  if (options.verb === "show-me") {
    for (const row of selected) await gitResolveCmd(root, repoDirOf(root, row.repo), "show-me", {}, deps);
    return 0;
  }

  const frozen: Frozen[] = [];
  const needsForce: string[] = [];
  for (const row of selected) {
    // The unconfirmed keep-mine preview is read-only and already answers both
    // questions batch has: the confirmation token, and whether publishing here
    // would DISCARD incoming work.
    const preview = await runOne(root, row.repo, "keep-mine", {}, deps);
    if (preview?.status !== "preview") continue;
    if (preview.confirm.forceDiscardIncoming) needsForce.push(row.repo);
    else frozen.push({ repo: row.repo, snapshot: preview.confirm.snapshot });
  }

  const readings = await gitDeferralEvidence({
    root,
    records: new Map(frozen.flatMap((entry) => {
      const record = input.records[entry.repo];
      return record ? [[entry.repo, record] as const] : [];
    })),
  });
  write(`Keeping this computer's work in ${repos(frozen.length)} under ${sanitizeTerminalText(options.under)}:`);
  for (const line of previewTable(frozen, selected, readings)) write(line);
  if (needsForce.length > 0) {
    write("");
    for (const line of FORCE_FOREWARNING) write(line);
    for (const repo of needsForce) write(`   rbox git resolve ${sanitizeTerminalText(repo)} keep-mine`);
  }
  if (options.dryRun === true) {
    write("");
    write("This is a preview — nothing on this computer changed.");
    write("To actually do it, run the same command without --dry-run.");
    return 0;
  }
  if (frozen.length === 0) return 0;
  if (!await confirmedCount(frozen.length, options.yes === true, write)) {
    write("Nothing changed.");
    return 1;
  }
  return await executeFrozen(root, frozen, deps, write);
}

/** Confirmation scales with blast radius: the reader types the COUNT, so consent
 * cannot be a reflex, and `--yes` is its scriptable twin. */
async function confirmedCount(count: number, yes: boolean, write: (line: string) => void): Promise<boolean> {
  if (yes) return true;
  if (!isInteractive()) {
    write(`Add --yes to run this without a terminal (${repos(count)}).`);
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
    write(`Skipped ${repos(skipped.length)} that changed while rbox was working — run the command again for those:`);
    for (const repo of skipped) write(`   ${sanitizeTerminalText(repo)}`);
  }
  if (failed.length > 0) {
    write(`${repos(failed.length)} could not be published; run each one on its own to see why:`);
    for (const repo of failed) write(`   rbox git resolve ${sanitizeTerminalText(repo)} keep-mine`);
  }
  return failed.length > 0 ? 1 : 0;
}
