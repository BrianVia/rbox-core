/**
 * `--dry-run` — design 273 S4's honest preview.
 *
 * The complaint this answers is that "keep-mine / take-theirs meant nothing":
 * both verbs are one-way doors whose blast radius a reader could only discover
 * by walking through one. The preview says what would change, what would be
 * saved first, and — the part every previous copy omitted — what the save does
 * NOT cover.
 *
 * It performs ZERO writes. It never stages the incoming bundle and never runs
 * the artifact preflight; it composes the same {@link GitRepoEvidence} reading
 * the status surfaces use, so a preview cannot mutate the state it is
 * describing. The backup PATH it prints is computed by the same expression
 * take-theirs uses, so the pointer is real rather than illustrative.
 *
 * The copy is bounded by what `quarantineLocal` actually writes: syncable refs
 * plus a `git stash create` of tracked modified and staged content, plus index
 * and operation-state copies. Untracked and ignored files are not in it, and
 * this is the only surface that says so.
 */
import path from "node:path";
import { hashBytes } from "../../engine/hash.js";
import type { GitRepoEvidence } from "../status-view/git-evidence.js";
import type { GitResolveVerb } from "./resolve-contract.js";

/** The exact directory `resolve-take-theirs.ts` passes to `quarantineLocal`.
 * Workspace-relative for display: an absolute path in a preview is noise, and
 * the user runs their next command from the workspace anyway. */
export function backupDirFor(rel: string): string {
  return path.posix.join(".rbox", "git-quarantine", hashBytes(Buffer.from(rel)).slice(0, 16));
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function savedClause(evidence: GitRepoEvidence | undefined): string {
  const local = evidence?.local;
  if (!local || (local.total === 0 && local.commits === 0)) return "(there is nothing of yours here to save)";
  return `(${count(local.total, "file")}, ${count(local.commits, "commit")})`;
}

function notCopiedLine(evidence: GitRepoEvidence | undefined): string {
  const untracked = evidence?.local?.untracked ?? 0;
  const newFiles = untracked > 0
    ? `${count(untracked, "brand-new file")} you never added to git, and ignored files`
    : "brand-new files you never added to git, and ignored files";
  return `  - NOT copy: ${newFiles} — those stay where they are on disk, untouched`;
}

function takeTheirsLines(rel: string, evidence: GitRepoEvidence | undefined): string[] {
  const ahead = evidence?.incoming?.commitsAhead;
  const newer = ahead === undefined ? "" : ` (${count(ahead, "commit")} newer)`;
  const backup = backupDirFor(rel);
  return [
    `Taking the other computer's version would:`,
    `  - switch this repo to their version${newer}`,
    `  - first save a copy of your committed and work-in-progress changes to`,
    `    files git tracks ${savedClause(evidence)} here:`,
    `      ${backup}/  (rbox calls this the git quarantine)`,
    notCopiedLine(evidence),
    `To actually do it, run the same command without --dry-run.`,
    // Deliberately a DIRECTORY, not a command: `rbox git restore-backup` ships
    // with design 275, and printing a command that does not exist is worse than
    // printing none.
    `Your backup would be saved at ${backup}/ — keep it until you're sure.`,
  ];
}

function keepMineLines(evidence: GitRepoEvidence | undefined): string[] {
  const ahead = evidence?.incoming?.commitsAhead;
  const waiting = ahead === undefined
    ? "  - leave the other computer's waiting work unapplied here"
    : `  - leave the other computer's waiting work unapplied here (${count(ahead, "commit")})`;
  const overlap = evidence?.overlap ?? 0;
  return [
    `Keeping this computer's work would:`,
    `  - publish this computer's version, so your other computers follow it`,
    waiting,
    ...(overlap > 0
      ? [`  - ⚠ ${count(overlap, "file")} changed on BOTH computers; the other computer keeps its own copy either way`]
      : []),
    `The other computer's work is not deleted — it stays there, and rbox stops`,
    `trying to bring it here.`,
    `To actually do it, run the same command without --dry-run.`,
  ];
}

/**
 * The preview for one repo and one verb. `show-me` is already read-only, so its
 * preview states that plainly rather than inventing a hypothetical.
 */
export function renderResolveDryRun(
  rel: string,
  verb: GitResolveVerb,
  evidence: GitRepoEvidence | undefined,
): string[] {
  const lines = ["This is a preview — nothing on this computer changed."];
  if (verb === "take-theirs") lines.push(...takeTheirsLines(rel, evidence));
  else if (verb === "keep-mine") lines.push(...keepMineLines(evidence));
  else lines.push("`show-me` only reads; it never changes anything here, with or without --dry-run.");
  return lines;
}
