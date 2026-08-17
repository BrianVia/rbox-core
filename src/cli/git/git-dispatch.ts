/**
 * `rbox git …` argument parsing — an Adapter, and only an Adapter.
 *
 * It lives outside `main-dispatch.ts` because design 273's batch grammar makes
 * the resolve verb's POSITION depend on a flag, and that decision needs room to
 * be stated once, in full, with the defect it fixes written beside it. No
 * orchestration happens here: every branch resolves a root, imports a command,
 * and returns its exit code.
 */
import { withWorkspaceSyncMutex } from "../sync-mutex.js";
import { workspaceRelativeRepo } from "../workspace-relative.js";
import type { GitResolveBatchOptions } from "./resolve-batch.js";

export interface GitDispatchInput {
  positional: string[];
  flags: Record<string, string>;
  jsonMode: boolean;
  resolveRoot: (arg: string | undefined) => Promise<string>;
  now?: () => Date;
}

export class GitUsageError extends Error {}

const VERBS = ["show-me", "take-theirs", "keep-mine"] as const;
type GitResolveVerbName = (typeof VERBS)[number];

const isVerb = (value: string): value is GitResolveVerbName =>
  (VERBS as readonly string[]).includes(value);

/** What the two spellings of `rbox git resolve` reduce to. Exactly one of `repo`
 * and `under` is ever present. */
export interface ResolveSelection {
  repo?: string;
  under?: string;
  expectRepos?: number;
  verb: GitResolveVerbName;
}

const RESOLVE_USAGE = [
  "usage: rbox git resolve <repo> [show-me|take-theirs|keep-mine] [--json] [--confirm <token>] [--force-discard-incoming] [--dry-run]",
  "   or: rbox git resolve --under <folder> [show-me|keep-mine] [--group <story>] [--dry-run] [--yes --expect-repos <n>]",
].join("\n");

/**
 * Design 273 S4, load-bearing: with `--under` the repo positional is GONE and
 * the verb slides into positional[1]. Before this,
 * `rbox git resolve --under X take-theirs` silently parsed `take-theirs` as the
 * REPO — the naive spelling of the batch grammar misparsed into a single-repo
 * resolve of a repository named after a verb. A repo positional BESIDE `--under`
 * is a usage error rather than a silent reinterpretation: the two selectors name
 * different populations, and guessing which one the user meant is how a batch
 * command acts on the wrong set.
 */
export function parseResolveArgs(positional: string[], flags: Record<string, string>): ResolveSelection {
  const under = flags.under;
  const batch = under !== undefined;
  const repo = batch ? undefined : positional[1];
  const verb = (batch ? positional[1] : positional[2]) ?? "show-me";
  const wellFormed = batch
    ? positional.length <= 2 && under !== "true" && under !== ""
    : Boolean(repo) && positional.length <= 3;
  if (!wellFormed || !isVerb(verb)) throw new GitUsageError(RESOLVE_USAGE);
  const parsed: ResolveSelection = { verb };
  if (repo !== undefined) parsed.repo = repo;
  if (under === undefined) {
    if (flags["expect-repos"] !== undefined) {
      throw new GitUsageError("--expect-repos only means something with --under: a single repo is always one repo.");
    }
    return parsed;
  }
  parsed.under = under;
  // Silently ignoring a flag is how a script believes it asked for something it
  // did not get. Batch has no per-repo token to confirm and composes its own
  // report, so neither of these has a batch meaning.
  if (flags.confirm !== undefined) {
    throw new GitUsageError("--confirm names one repo's snapshot; it cannot be used with --under. Batch re-checks each repo for you.");
  }
  if (flags.json !== undefined) {
    throw new GitUsageError("--json is not available with --under yet; run the repos individually for machine output.");
  }
  if (flags["expect-repos"] !== undefined) {
    const expected = Number(flags["expect-repos"]);
    if (!Number.isInteger(expected) || expected < 0) {
      throw new GitUsageError("--expect-repos takes a whole number of repos, e.g. --expect-repos 12.");
    }
    parsed.expectRepos = expected;
  }
  return parsed;
}

export async function dispatchGitCommand(input: GitDispatchInput): Promise<number> {
  const { positional, flags, jsonMode, resolveRoot } = input;
  const sub = positional[0];
  if (sub === "deferrals") {
    if (positional.length !== 1 || (flags.brief === "true" && jsonMode)) {
      throw new GitUsageError("usage: rbox git deferrals [--brief | --json]");
    }
    const root = await resolveRoot(undefined);
    const { gitDeferralsCmd } = await import("./deferrals-command.js");
    return gitDeferralsCmd(root, { brief: flags.brief === "true", json: jsonMode }, { now: input.now });
  }
  if (sub === "republish") {
    const target = positional[1];
    if (!target || positional.length !== 2) throw new GitUsageError("usage: rbox git republish <repo> [--json]");
    const root = await resolveRoot(target);
    const { gitRepublishCmd } = await import("./republish-command.js");
    return withWorkspaceSyncMutex(root, (syncMutex) =>
      gitRepublishCmd(root, target, syncMutex, { json: jsonMode }, { now: input.now }));
  }
  if (sub !== "resolve") throw new GitUsageError(RESOLVE_USAGE);
  const { repo, under, expectRepos, verb } = parseResolveArgs(positional, flags);
  if (under !== undefined) {
    const root = await resolveRoot(undefined);
    const { readGitPauseRows } = await import("./deferrals-command.js");
    const { gitResolveBatchCmd } = await import("./resolve-batch.js");
    const reading = await readGitPauseRows(root);
    const options: GitResolveBatchOptions = {
      under: workspaceRelativeRepo(root, under),
      verb,
      dryRun: flags["dry-run"] === "true",
      yes: flags.yes === "true",
      forceDiscardIncoming: flags["force-discard-incoming"] === "true",
    };
    if (flags.group !== undefined) options.group = flags.group;
    if (expectRepos !== undefined) options.expectRepos = expectRepos;
    return gitResolveBatchCmd(root, options, { rows: reading.repos, records: reading.records });
  }
  const root = await resolveRoot(repo);
  const { gitResolveCmd } = await import("./resolve-command.js");
  return gitResolveCmd(root, repo!, verb, {
    json: jsonMode,
    confirm: flags.confirm,
    forceDiscardIncoming: flags["force-discard-incoming"] === "true",
    dryRun: flags["dry-run"] === "true",
  });
}
