import type { GitDeferralReason } from "../config.js";

/**
 * Closed §126/§130 reasons that can veto adoption of a stale checkout
 * breadcrumb.  This is deliberately separate from GitDeferralReason: adding a
 * deferral reason must not silently create (or omit) deletion authority.
 */
export type BreadcrumbVetoGate =
  | "held-refs"
  | "tombstone-pruned-this-cycle"
  | "in-progress-present"
  | "reason-local-edits"
  | "reason-local-index"
  | "reason-local-operation"
  | "reason-local-commits"
  | "reason-local-stash"
  | "reason-worktree-ownership"
  | "reason-git-busy"
  | "reason-unreadable"
  | "reason-artifact"
  | "reason-containment"
  | "reason-unsupported"
  | "reason-other"
  | "indeterminate"
  | "boundary";

export const BREADCRUMB_VETO_GATES = [
  "held-refs",
  "tombstone-pruned-this-cycle",
  "in-progress-present",
  "reason-local-edits",
  "reason-local-index",
  "reason-local-operation",
  "reason-local-commits",
  "reason-local-stash",
  "reason-worktree-ownership",
  "reason-git-busy",
  "reason-unreadable",
  "reason-artifact",
  "reason-containment",
  "reason-unsupported",
  "reason-other",
  "indeterminate",
  "boundary",
] as const satisfies readonly BreadcrumbVetoGate[];

/** Larger ranks win.  Values intentionally encode the verbatim design order. */
export const BREADCRUMB_VETO_ORDER: Record<BreadcrumbVetoGate, number> =
  Object.fromEntries(BREADCRUMB_VETO_GATES.map((gate, index) => [gate, BREADCRUMB_VETO_GATES.length - index])) as
    Record<BreadcrumbVetoGate, number>;

function assertNever(value: never): never {
  throw new Error(`unhandled breadcrumb veto value: ${String(value)}`);
}

export function breadcrumbGateForReason(reason: GitDeferralReason): BreadcrumbVetoGate {
  switch (reason) {
    case "local-edits": return "reason-local-edits";
    case "local-index": return "reason-local-index";
    case "local-operation": return "reason-local-operation";
    case "local-commits": return "reason-local-commits";
    case "local-stash": return "reason-local-stash";
    case "worktree-ownership": return "reason-worktree-ownership";
    case "git-busy": return "reason-git-busy";
    case "unreadable": return "reason-unreadable";
    case "artifact": return "reason-artifact";
    case "containment": return "reason-containment";
    case "unsupported": return "reason-unsupported";
    case "conflict":
    case "ignored-target":
    case "config":
    case "other": return "reason-other";
    default: return assertNever(reason);
  }
}

export function highestBreadcrumbVetoGate(gates: Iterable<BreadcrumbVetoGate>): BreadcrumbVetoGate | undefined {
  let selected: BreadcrumbVetoGate | undefined;
  for (const gate of gates) {
    if (selected === undefined || BREADCRUMB_VETO_ORDER[gate] > BREADCRUMB_VETO_ORDER[selected]) selected = gate;
  }
  return selected;
}

const loggedVetoes = new Set<string>();

/** Centralized bounded logger: once per workspace/repository/gate per daemon boot. */
export function logVetoOnce(
  workspaceRoot: string,
  repo: string,
  gate: BreadcrumbVetoGate,
  sink: (line: string) => void = (line) => console.error(line),
): boolean {
  const key = `${workspaceRoot}\0${repo}\0${gate}`;
  if (loggedVetoes.has(key)) return false;
  loggedVetoes.add(key);
  sink(`git-sync: breadcrumb waiver vetoed for ${repo}: ${gate}`);
  return true;
}

/** Test isolation only; production callers never reset the boot-scoped bound. */
export function resetBreadcrumbVetoLogForTests(): void {
  loggedVetoes.clear();
}

/** Compile-only proof that the rank table remains closed when the union grows. */
function breadcrumbVetoExhaustivenessTypecheckOnly(): void {
  type HypotheticalFutureGate = BreadcrumbVetoGate | "future-unranked-gate";
  // @ts-expect-error a new gate must be deliberately ranked above.
  const incomplete: Record<HypotheticalFutureGate, number> = BREADCRUMB_VETO_ORDER;
  void incomplete;
}
void breadcrumbVetoExhaustivenessTypecheckOnly;
