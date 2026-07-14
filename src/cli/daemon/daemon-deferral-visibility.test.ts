import { expect, test } from "bun:test";
import type { GitDeferral, SyncState } from "../config.js";
import { durableGitDeferralLines, type GitDeferralLogSeen } from "./daemon.js";

const START = Date.parse("2026-07-13T10:00:00Z");

function state(deferrals?: Partial<Record<GitDeferral["lane"], GitDeferral>>): SyncState {
  return {
    stream: "test",
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "", files: [] },
    repoRecords: deferrals ? { "repo\u001b[31m": { repoGen: 1, sourceSeq: 1, deferrals } } : {},
  };
}

function deferral(overrides: Partial<GitDeferral> = {}): GitDeferral {
  const at = new Date(START).toISOString();
  return {
    lane: "apply", reason: "local-edits", deferredSince: at, reasonSince: at, lastSeen: at,
    checkout: { kind: "branch", label: "release/0.9\nforged" }, ...overrides,
  };
}

test("durable git deferral lines dedup per repo, reason transition, and coarse age boundary", () => {
  const seen = new Map<string, GitDeferralLogSeen>();
  const initial = state({ apply: deferral() });
  expect(durableGitDeferralLines(initial, seen, START + 30 * 60_000)).toEqual([
    "git deferred 30m: local edits on branch release/0.9forged (repo)"
  ]);
  expect(durableGitDeferralLines(initial, seen, START + 31 * 60_000)).toEqual([]); // no minute spam
  expect(durableGitDeferralLines(initial, seen, START + 60 * 60_000)).toEqual([
    "git deferred 1h: local edits on branch release/0.9forged (repo)"
  ]);

  const transitioned = state({ apply: deferral({ reason: "git-busy", reasonSince: new Date(START + 61 * 60_000).toISOString() }) });
  expect(durableGitDeferralLines(transitioned, seen, START + 61 * 60_000)[0]).toContain("git busy");
  expect(durableGitDeferralLines(transitioned, seen, START + 62 * 60_000)).toEqual([]);

  const twoLanes = state({
    apply: transitioned.repoRecords!["repo\u001b[31m"]!.deferrals!.apply!,
    capture: deferral({ lane: "capture", reason: "local-commits", deferredSince: new Date(START + 62 * 60_000).toISOString() }),
  });
  const collapsed = durableGitDeferralLines(twoLanes, seen, START + 63 * 60_000);
  expect(collapsed).toHaveLength(1);
  expect(collapsed[0]).toContain("git deferred 1h: local commits");
  expect(durableGitDeferralLines(state(), seen, START + 64 * 60_000)).toEqual([]);
  expect(durableGitDeferralLines(initial, seen, START + 65 * 60_000)).toHaveLength(1); // new episode after clear
});
