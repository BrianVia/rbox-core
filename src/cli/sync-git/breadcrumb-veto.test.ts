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

const VERBATIM = [
  "held-refs", "tombstone-pruned-this-cycle", "in-progress-present",
  "reason-local-edits", "reason-local-index", "reason-local-operation",
  "reason-local-commits", "reason-local-stash", "reason-deletion-pending", "reason-worktree-ownership",
  "reason-git-busy", "reason-unreadable", "reason-artifact",
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
    expect([
      breadcrumbGateForReason("local-edits"), breadcrumbGateForReason("local-index"),
      breadcrumbGateForReason("local-operation"), breadcrumbGateForReason("local-commits"),
      breadcrumbGateForReason("local-stash"), breadcrumbGateForReason("deletion-pending"),
      breadcrumbGateForReason("worktree-ownership"),
      breadcrumbGateForReason("git-busy"), breadcrumbGateForReason("unreadable"),
      breadcrumbGateForReason("artifact"), breadcrumbGateForReason("containment"),
      breadcrumbGateForReason("unsupported"), breadcrumbGateForReason("conflict"),
      breadcrumbGateForReason("ignored-target"), breadcrumbGateForReason("config"),
      breadcrumbGateForReason("other"),
    ]).toEqual([
      "reason-local-edits", "reason-local-index", "reason-local-operation", "reason-local-commits",
      "reason-local-stash", "reason-deletion-pending", "reason-worktree-ownership", "reason-git-busy", "reason-unreadable",
      "reason-artifact", "reason-containment", "reason-unsupported", "reason-other",
      "reason-other", "reason-other", "reason-other",
    ]);
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
