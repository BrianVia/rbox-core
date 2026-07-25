import path from "node:path";
import { type GitDeferralReason } from "../config.js";
import { gitDeferralReasonPresentation, sanitizeTerminalText } from "../status-view.js";
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

export function printShow(show: GitResolveShow, write: (line: string) => void): void {
  const checkout = show.incomingCheckout.kind === "branch" ? `branch ${show.incomingCheckout.label}` : "detached checkout";
  write(`What happened: rbox paused Git sync for ${show.repo} because local work and the incoming ${checkout} need a choice.`);
  write("What is safe: Your repository is healthy; rbox has not changed your local Git state.");
  write(`What to do: preview publishing my work with ${humanResolveCommand(show, "keep-mine")}; or use ${humanResolveCommand(show, "take-theirs")} to discard my local changes and follow incoming.`);
  write(`  Incoming checkout: ${checkout}`);
  const workingFiles = show.oracle === "clean" ? "match the last applied snapshot"
    : show.oracle === "dirty" ? "changed locally after the last applied snapshot"
    : "could not be compared safely";
  const index = show.index === "matches-incoming" ? "matches incoming"
    : show.index === "diverged" ? "differs from incoming"
    : show.index === "absent" ? "is absent on both sides"
    : "could not be compared safely";
  const operation = show.operationState === "matches-incoming" ? "matches incoming" : "differs from incoming";
  const stash = show.stash === "clean" ? "matches incoming"
    : show.stash === "diverged" ? "contains local-only history"
    : "is not owned by this checkout";
  write(`  Working files ${workingFiles}; the index ${index}; Git operation state ${operation}; the stash ${stash}.`);
  if (show.localOnlyCommits.length === 0) write("  Local-only history: none.");
  else {
    for (const commit of show.localOnlyCommits.slice(0, HUMAN_LOCAL_ONLY_CAP)) {
      const refs = commit.labels.map(humanRefLabel);
      write(`  ${refs.join(", ")} ${refs.length === 1 ? "contains" : "contain"} local-only history after the incoming snapshot: ${commit.subject}`);
    }
    if (show.localOnlyCommits.length > HUMAN_LOCAL_ONLY_CAP) write(`  …and ${show.localOnlyCommits.length - HUMAN_LOCAL_ONLY_CAP} more local-only commits.`);
  }
  for (const d of show.deferrals) {
    const reason = gitDeferralReasonPresentation(d.reason).label;
    write(`  rbox paused the ${d.lane} step because of ${reason} since ${d.deferredSince}${d.bytesChanged ? "; working files changed again since then" : ""}.`);
  }
  write(`  Confirmation token: ${show.snapshot}`);
}

function laneLabel(lane: string): string {
  if (lane.startsWith("branch:")) return `branch ${lane.slice("branch:".length).replace(/^refs\/heads\//, "")}`;
  if (lane.startsWith("tag:")) return `tag ${lane.slice("tag:".length).replace(/^refs\/tags\//, "")}`;
  const names: Record<string, string> = { stash: "stash", head: "checked-out branch", refscope: "sync scope", index: "staging area", opstate: "in-progress operation state", config: "repo settings" };
  return names[lane] ?? lane;
}

export function printDiscardReport(report: ResolutionDiscardReport, write: (line: string) => void): void {
  write("What the old synced snapshot has that your repo doesn't (final check happens at publish):");
  for (const lane of report.lanes) write(`  ${laneLabel(lane.lane)}: ${lane.disposition === "subsumed" ? "nothing would be lost" : lane.disposition === "not-subsumed" ? "would be discarded" : "couldn't be checked"} — ${lane.detail}`);
  if (report.forceRequired) write("  Some of the old snapshot would be discarded — confirming requires --force-discard-incoming. (Your local files, branches, and history are untouched either way.)");
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
  const messages: Record<GitDeferralReason, string> = {
    "local-edits": "local edits prevent the confirmed checkout from being published safely",
    "local-index": "local index changes prevent the confirmed checkout from being published safely",
    "local-operation": "a local Git operation prevents the confirmed checkout from being published safely",
    "local-commits": "local commits changed while the checkout was being confirmed",
    "local-stash": "the local stash changed while the checkout was being confirmed",
    "deletion-pending": "rbox is still finishing a branch deletion before the confirmed checkout can be published safely",
    conflict: "the confirmed checkout still conflicts with local Git state",
    artifact: "incoming Git artifacts could not be fetched and verified",
    unreadable: "Git metadata could not be read completely",
    unsupported: "this repository shape or Git version cannot perform the journaled checkout",
    "git-busy": "Git became busy during resolution; retry after the other Git operation finishes",
    "stale-unattributed": "stable Git locks remain without a known owner; inspect and repair the stale lock files first",
    containment: "the repository containment proof failed",
    "worktree-ownership": "another worktree owns a ref required by the confirmed checkout",
    "ignored-target": "the confirmed checkout targets an ignored repository",
    config: "Git configuration could not be published safely",
    other: "the confirmed checkout could not be published safely",
  };
  return messages[reason];
}
