import path from "node:path";
import { type GitDeferralReason } from "../config.js";
import { gitDeferralReasonPresentation } from "../status-view/git-projection.js";
import { sanitizeTerminalText } from "../status-view/text.js";
import { shQuote } from "../shell-quote.js";
import type { ResolutionDiscardReport } from "../sync-git/resolution-intent.js";

export interface GitResolveShow {
  status: "show-me";
  repo: string;
  incomingCheckout: { kind: "branch" | "detached"; label?: string };
  localOnlyCommits: Array<{ labels: string[]; subject: string }>;
  oracle: "clean" | "dirty" | "indeterminate";
  index: "matches-incoming" | "diverged" | "absent" | "indeterminate";
  operationState: "matches-incoming" | "diverged";
  stash: "clean" | "diverged" | "not-owned";
  deferrals: Array<{ lane: string; reason: string; deferredSince: string; ageSeconds: number; bytesChanged?: boolean }>;
  snapshot: string;
}

const HUMAN_LOCAL_ONLY_CAP = 50;

function humanRefLabel(label: string): string {
  if (label === "stash reflog") return "the stash reflog";
  if (label === "detached HEAD") return "detached HEAD";
  const reflog = label.endsWith(" reflog");
  const ref = reflog ? label.slice(0, -(" reflog".length)) : label;
  const kind = ref.startsWith("heads/") ? `branch ${ref.slice("heads/".length)}`
    : ref.startsWith("tags/") ? `tag ${ref.slice("tags/".length)}`
    : ref;
  return reflog ? `${kind}'s reflog` : kind;
}

function humanResolveCommand(show: GitResolveShow, verb: "keep-mine" | "take-theirs"): string {
  const repoArg = show.repo.startsWith("-") ? `./${show.repo}` : show.repo;
  const argv = verb === "keep-mine"
    ? ["rbox", "git", "resolve", repoArg, verb]
    : ["rbox", "git", "resolve", repoArg, verb, "--confirm", show.snapshot];
  return argv.map(shQuote).join(" ");
}

/** This computer, named when the hostname is readable. Never enters `--json`
 *  or the shareable `--brief`: it is a human aid on this terminal only. */
export function thisComputer(machine?: string): string {
  return machine ? `this computer (${machine})` : "this computer";
}

/** "this computer's version (Brians-Desktop)" — the possessive form, kept
 *  separate so the machine name never lands inside an awkward genitive. */
export function thisComputersVersion(machine?: string): string {
  return machine ? `this computer's version (${machine})` : "this computer's version";
}

export function printShow(show: GitResolveShow, write: (line: string) => void, machine?: string): void {
  const checkout = show.incomingCheckout.kind === "branch" ? `branch ${show.incomingCheckout.label}` : "detached checkout";
  write(`What happened: rbox paused Git sync for ${show.repo} because ${thisComputer(machine)} and your other computer both changed Git state; the ${checkout} from your other computer is waiting.`);
  write("What is safe: Your repository is healthy; rbox has not changed your local Git state.");
  write(`What to do: to keep ${thisComputersVersion(machine)} and publish it to your other computers, preview with ${humanResolveCommand(show, "keep-mine")}; to use the version from your other computer and set aside this computer's Git changes, run ${humanResolveCommand(show, "take-theirs")}.`);
  write(`  Waiting from your other computer: ${checkout}`);
  const workingFiles = show.oracle === "clean" ? "match the last applied snapshot"
    : show.oracle === "dirty" ? "changed on this computer after the last applied snapshot"
    : "could not be compared safely";
  const index = show.index === "matches-incoming" ? "matches your other computer's version"
    : show.index === "diverged" ? "differs from your other computer's version"
    : show.index === "absent" ? "is absent on both computers"
    : "could not be compared safely";
  const operation = show.operationState === "matches-incoming" ? "matches your other computer's version" : "differs from your other computer's version";
  const stash = show.stash === "clean" ? "matches your other computer's version"
    : show.stash === "diverged" ? "contains history only on this computer"
    : "is not owned by this checkout";
  write(`  Working files ${workingFiles}; the index ${index}; Git operation state ${operation}; the stash ${stash}.`);
  if (show.localOnlyCommits.length === 0) write("  History only on this computer: none.");
  else {
    for (const commit of show.localOnlyCommits.slice(0, HUMAN_LOCAL_ONLY_CAP)) {
      const refs = commit.labels.map(humanRefLabel);
      write(`  ${refs.join(", ")} ${refs.length === 1 ? "contains" : "contain"} history that exists only on this computer: ${commit.subject}`);
    }
    if (show.localOnlyCommits.length > HUMAN_LOCAL_ONLY_CAP) write(`  …and ${show.localOnlyCommits.length - HUMAN_LOCAL_ONLY_CAP} more commits only on this computer.`);
  }
  for (const d of show.deferrals) {
    const reason = gitDeferralReasonPresentation(d.reason).label;
    write(`  rbox paused the ${d.lane} step because of ${reason} since ${d.deferredSince}${d.bytesChanged ? "; working files changed again since then" : ""}.`);
  }
  write(`  Confirmation token: ${show.snapshot}`);
}

const FIXED_LANE_LABELS = new Map([
  ["stash", "stash"],
  ["head", "checked-out branch"],
  ["refscope", "sync scope"],
  ["index", "staging area"],
  ["opstate", "in-progress operation state"],
  ["config", "repo settings"],
]);

function laneLabel(lane: string): string {
  if (lane.startsWith("branch:")) return `branch ${lane.slice("branch:".length).replace(/^refs\/heads\//, "")}`;
  if (lane.startsWith("tag:")) return `tag ${lane.slice("tag:".length).replace(/^refs\/tags\//, "")}`;
  return FIXED_LANE_LABELS.get(lane) ?? lane;
}

export function printDiscardReport(report: ResolutionDiscardReport, write: (line: string) => void): void {
  write("What your other computer's waiting version has that this computer doesn't (final check happens at publish):");
  for (const lane of report.lanes) write(`  ${laneLabel(lane.lane)}: ${lane.disposition === "subsumed" ? "nothing would be lost" : lane.disposition === "not-subsumed" ? "would be discarded" : "couldn't be checked"} — ${lane.detail}`);
  if (report.forceRequired) write("  Some of your other computer's waiting version would be discarded — confirming requires --force-discard-incoming. (This computer's files, branches, and history are untouched either way.)");
}

export function keepMineConfirmCommand(repo: string, snapshot: string, force: boolean): string {
  const repoArg = repo.startsWith("-") ? `./${repo}` : repo;
  return [
    "rbox", "git", "resolve", repoArg, "keep-mine", "--confirm", snapshot,
    ...(force ? ["--force-discard-incoming"] : []),
  ].map(shQuote).join(" ");
}

export function safeResolveText(value: string, root: string): string {
  let out = sanitizeTerminalText(value.replace(/[\r\n\p{Cc}]+/gu, " "));
  const normalizedRoot = path.resolve(root).split(path.sep).join("/");
  out = out.split(path.resolve(root)).join(".").split(normalizedRoot).join(".");
  out = out.replace(/\b(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@");
  out = out.replace(/\b(authorization|bearer|access[_-]?token|api[_-]?key|password|secret)\b(?:\s*[:=]\s*|\s+)[^\s,;]+/gi, "$1 [redacted]");
  return out.replace(/\s+/g, " ").trim();
}

export function safeResolveOutput<T>(value: T, root: string): T {
  if (typeof value === "string") return safeResolveText(value, root) as T;
  if (Array.isArray(value)) return value.map((entry) => safeResolveOutput(entry, root)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeResolveOutput(entry, root)])) as T;
  }
  return value;
}

export function refusalMessage(reason: GitDeferralReason): string {
  const messages = {
    "local-edits": "local edits prevent the confirmed checkout from being published safely",
    "local-index": "local index changes prevent the confirmed checkout from being published safely",
    "local-operation": "a local Git operation prevents the confirmed checkout from being published safely",
    "local-commits": "local commits changed while the checkout was being confirmed",
    "local-stash": "the local stash changed while the checkout was being confirmed",
    "deletion-pending": "rbox is still finishing a branch deletion before the confirmed checkout can be published safely",
    "conflict-copies": "rbox-made conflict copies are the only files left to compare in this repository",
    conflict: "the confirmed checkout still conflicts with local Git state",
    artifact: "incoming Git artifacts could not be fetched and verified",
    "ref-read-unreadable": "Git refs could not be read completely, so rbox refused ref authority",
    unreadable: "Git metadata could not be read completely",
    unsupported: "this repository shape or Git version cannot perform the journaled checkout",
    "git-busy": "Git became busy during resolution; retry after the other Git operation finishes",
    "stale-unattributed": "stable Git locks remain without a known owner; inspect and repair the stale lock files first",
    containment: "the repository containment proof failed",
    "worktree-ownership": "another worktree owns a ref required by the confirmed checkout",
    "ignored-target": "the confirmed checkout targets an ignored repository",
    config: "Git configuration could not be published safely",
    other: "the confirmed checkout could not be published safely",
  } satisfies Record<GitDeferralReason, string>;
  return messages[reason];
}
