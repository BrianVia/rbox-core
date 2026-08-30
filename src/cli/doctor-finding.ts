/**
 * What a `rbox doctor` finding IS, and the copy invariants every finding obeys.
 *
 * Extracted so the triage modules that AUTHOR findings (`doctor-triage.ts` and
 * the halt remedies in `doctor-triage-halt.ts`) share one contract instead of
 * importing each other. It owns the shape and the two sentences that must read
 * identically everywhere; it never decides what is wrong with a workspace.
 */
import path from "node:path";
import { shQuoteIfNeeded } from "./shell-quote.js";

export type TriageSeverity = "blocked" | "attention" | "info";

export interface TriageFinding {
  /** Stable machine id for `--json` consumers (agents, CI, the rig). */
  id: string;
  severity: TriageSeverity;
  /** What is wrong, in the words a non-developer would use. */
  problem: string;
  /** Whether their data is safe. Always answered — never left implied. */
  safety: string;
  /** One copy-pasteable command, carrying its own workspace when the command is
   * workspace-scoped. Omitted only when no command can honestly fix the state. */
  command?: string;
}

/** The two reassurances that recur across findings. Single copies, because a
 *  user who sees the same state twice must not read two different promises. */
export const SAFE_LOCAL_FILES = "Your files on this machine are untouched.";
export const SAFE_NOTHING_LOST = "Nothing is lost — changes are just waiting instead of syncing.";

/** A remedy is pasted from wherever the reader is standing — `rbox doctor <path>`
 * runs from anywhere, and the machine view hands out workspaces by path. Every
 * workspace-scoped command therefore carries its own workspace. */
export function scoped(root: string, command: string): string {
  return `cd ${shQuoteIfNeeded(path.resolve(root))} && ${command}`;
}
