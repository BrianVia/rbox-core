import { expect, test } from "bun:test";
import {
  GIT_DEFERRAL_REASONS,
  GIT_DEFERRAL_REASON_PRECEDENCE,
  GIT_DEFERRAL_REASON_RANK,
  type GitDeferralReason,
} from "../sync-state-model.js";
import { firstReason } from "./follow.js";

test("the precedence ranking is a total permutation of the deferral reasons", () => {
  expect([...GIT_DEFERRAL_REASON_PRECEDENCE].sort()).toEqual([...GIT_DEFERRAL_REASONS].sort());
  expect(Object.keys(GIT_DEFERRAL_REASON_RANK).sort()).toEqual([...GIT_DEFERRAL_REASONS].sort());
});

test("every deferral reason selects itself — no reason yields a fail-open safe verdict", () => {
  // classifyCheckout reads "no reason" as "safe to check out". A reason missing
  // from the ranking would therefore publish an incoming checkout over a
  // blocked repository, so selection must be total over the union.
  for (const reason of GIT_DEFERRAL_REASONS) {
    expect(firstReason(new Set<GitDeferralReason>([reason]))).toBe(reason);
  }
  expect(firstReason(new Set<GitDeferralReason>())).toBeUndefined();
});

test("a conflict-only reason set is never safe and never loses to a lower-precedence reason", () => {
  expect(firstReason(new Set<GitDeferralReason>(["conflict"]))).toBe("conflict");
  expect(firstReason(new Set<GitDeferralReason>(["other", "conflict"]))).toBe("conflict");
  expect(firstReason(new Set<GitDeferralReason>(["conflict", "local-edits"]))).toBe("local-edits");
});

test("deletion-pending ranks after human divergence and before structural blockers", () => {
  const winner = (reasons: GitDeferralReason[]): GitDeferralReason | undefined => firstReason(new Set(reasons));
  expect(winner(["deletion-pending", "local-commits"])).toBe("local-commits");
  expect(winner(["conflict", "deletion-pending"])).toBe("deletion-pending");
  expect(winner(["worktree-ownership", "deletion-pending"])).toBe("deletion-pending");
});

test("the shipped precedence of the original reasons is unchanged", () => {
  // Ordering is user-visible: it decides which reason a multi-blocker repo
  // reports. The four members added with the totality fix may only be inserted
  // BETWEEN these, never ahead of or behind one another's existing neighbours.
  const legacy: GitDeferralReason[] = [
    "local-edits", "local-index", "local-operation", "local-commits", "local-stash",
    "worktree-ownership", "git-busy", "unreadable", "artifact", "containment", "unsupported", "other",
  ];
  expect(GIT_DEFERRAL_REASON_PRECEDENCE.filter((reason) => legacy.includes(reason))).toEqual(legacy);
  const winner = (reasons: GitDeferralReason[]): GitDeferralReason | undefined => firstReason(new Set(reasons));
  for (let i = 0; i < legacy.length; i++) {
    for (let j = i + 1; j < legacy.length; j++) expect(winner([legacy[j]!, legacy[i]!])).toBe(legacy[i]!);
  }
});
