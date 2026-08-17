import { beforeEach, describe, expect, test } from "bun:test";
import {
  BREADCRUMB_VETO_GATES,
  BREADCRUMB_VETO_ORDER,
  breadcrumbGateForReason,
  highestBreadcrumbVetoGate,
  logVetoOnce,
  resetBreadcrumbVetoLogForTests,
  type BreadcrumbVetoGate,
} from "./breadcrumb-veto.js";
import { GIT_DEFERRAL_REASONS, type GitDeferralReason } from "../sync-state-model.js";

const VERBATIM = [
  "held-refs", "tombstone-pruned-this-cycle", "in-progress-present",
  "reason-local-edits", "reason-local-index", "reason-local-operation",
  "reason-local-commits", "reason-local-stash", "reason-deletion-pending", "reason-worktree-ownership",
  "reason-git-busy", "reason-ref-read-unreadable", "reason-unreadable", "reason-artifact",
  "reason-containment", "reason-unsupported", "reason-other", "indeterminate", "boundary",
] as const satisfies readonly BreadcrumbVetoGate[];

describe("BreadcrumbVetoGate", () => {
  beforeEach(resetBreadcrumbVetoLogForTests);

  test("has the exact closed order required by designs 126 and 130", () => {
    expect(BREADCRUMB_VETO_GATES).toEqual(VERBATIM);
    for (let i = 1; i < VERBATIM.length; i++) {
      expect(BREADCRUMB_VETO_ORDER[VERBATIM[i - 1]!]).toBeGreaterThan(BREADCRUMB_VETO_ORDER[VERBATIM[i]!]);
    }
    expect(highestBreadcrumbVetoGate([...VERBATIM].reverse())).toBe("held-refs");
  });

  test("maps every deferral member without a free-form fallback", () => {
    // `assertNever` is the runtime gate; `Record<GitDeferralReason, …>` is the
    // compile-time one — a new reason cannot be omitted here the way the earlier
    // hand-written list silently omitted `stale-unattributed` and `conflict-copies`.
    const expected = {
      "local-edits": "reason-local-edits",
      "local-index": "reason-local-index",
      "local-operation": "reason-local-operation",
      "local-commits": "reason-local-commits",
      "local-stash": "reason-local-stash",
      "deletion-pending": "reason-deletion-pending",
      "worktree-ownership": "reason-worktree-ownership",
      "git-busy": "reason-git-busy",
      "stale-unattributed": "reason-git-busy",
      "ref-read-unreadable": "reason-ref-read-unreadable",
      unreadable: "reason-unreadable",
      artifact: "reason-artifact",
      containment: "reason-containment",
      unsupported: "reason-unsupported",
      conflict: "reason-other",
      "conflict-copies": "reason-other",
      "ignored-target": "reason-other",
      config: "reason-other",
      other: "reason-other",
    } satisfies Record<GitDeferralReason, BreadcrumbVetoGate>;
    expect(Object.fromEntries(GIT_DEFERRAL_REASONS.map((reason) => [reason, breadcrumbGateForReason(reason)])))
      .toEqual(expected);
  });

  test("logs once per workspace, repository, and gate", () => {
    const lines: string[] = [];
    expect(logVetoOnce("/w", "repo", "held-refs", (line) => lines.push(line))).toBe(true);
    expect(logVetoOnce("/w", "repo", "held-refs", (line) => lines.push(line))).toBe(false);
    expect(logVetoOnce("/w", "repo", "boundary", (line) => lines.push(line))).toBe(true);
    expect(logVetoOnce("/w2", "repo", "held-refs", (line) => lines.push(line))).toBe(true);
    expect(lines).toEqual([
      "git-sync: breadcrumb waiver vetoed for repo: held-refs",
      "git-sync: breadcrumb waiver vetoed for repo: boundary",
      "git-sync: breadcrumb waiver vetoed for repo: held-refs",
    ]);
  });
});
