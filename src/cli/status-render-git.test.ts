import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { projectGitDeferralRepos, type GitDeferralRepoProjection } from "./status-view/git-projection.js";
import { gitRepoFallbackNote, renderGitSingleRepo } from "./status-render-git.js";
import { workspaceRelativeRepo } from "./workspace-relative.js";
import type { StatusGitDetailSource } from "./status-contract.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NOW = Date.parse("2026-08-17T00:00:00.000Z");

const sourceFor = (rows: GitDeferralRepoProjection[]): StatusGitDetailSource => ({
  git: { deferrals: [], projectedRepos: rows, localRepoProjections: [], records: {}, deferredRepos: rows.length, bytesChangedDeferrals: 0 },
  hygieneDetails: {},
  now: NOW,
});

const rowsFor = (repo: string) => projectGitDeferralRepos([{
  repo,
  deferral: {
    lane: "apply", reason: "conflict", deferredSince: "2026-08-14T00:00:00.000Z",
    reasonSince: "2026-08-14T00:00:00.000Z", lastSeen: "2026-08-14T00:00:00.000Z",
  },
  record: { repoGen: 1, sourceSeq: 1, pending: {
    bundleSha: "0".repeat(64), bundleEncSha: "1".repeat(64), bundleCipherSize: 1,
    head: "ref: refs/heads/main", refs: {}, refScope: "all", generatedAt: "2026-08-16T00:00:00.000Z",
  } },
}], NOW);

test("the copy-pasteable command block never carries a peer's terminal escapes", () => {
  // Repo paths come from a peer's manifest: attacker-influenced bytes aimed at
  // the one surface whose whole purpose is to be pasted into a shell.
  const hostile = `acme/${ESC}[31mcheckout${BEL}`;
  const rows = rowsFor(hostile);
  const lines = renderGitSingleRepo(sourceFor(rows), hostile, {})!.join("\n");
  expect(lines).not.toContain(ESC);
  expect(lines).not.toContain(BEL);
  // The whole CSI sequence goes, not just the ESC byte, so the pasted command is
  // the path the reader can actually see.
  expect(lines).toContain("rbox git resolve acme/checkout show-me");
});

test("the destructive command names the real repo, not a placeholder to hand-edit", () => {
  const lines = renderGitSingleRepo(sourceFor(rowsFor("acme/checkout")), "acme/checkout", {})!.join("\n");
  expect(lines).toContain("rbox git resolve acme/checkout take-theirs --confirm <token from show-me>");
  expect(lines).not.toContain("resolve <repo> take-theirs");
});

test("a path that names no paused repo keeps the documented workspace meaning", () => {
  // `rbox status <path>` has always reported on that synced folder; --git must
  // not redefine it into ". — git sync is not paused here."
  expect(renderGitSingleRepo(sourceFor(rowsFor("acme/checkout")), "somewhere/else", {})).toBeUndefined();
  expect(gitRepoFallbackNote("somewhere/else")[0]).toContain("showing this whole synced folder instead");
});

test("workspaceRelativeRepo refuses everything outside the workspace", () => {
  const root = path.join(os.tmpdir(), "rbox-ws");
  expect(workspaceRelativeRepo(root, root)).toBe(".");
  expect(workspaceRelativeRepo(root, path.join(root, "acme", "checkout"))).toBe("acme/checkout");
  // Relative arguments resolve against the PROCESS directory, so a bare name is
  // only inside the workspace when the shell happens to be there.
  expect(workspaceRelativeRepo(process.cwd(), "src")).toBe("src");
  expect(() => workspaceRelativeRepo(root, path.dirname(root))).toThrow(/not inside this synced folder/);
  expect(() => workspaceRelativeRepo(root, path.join(root, "..", "other"))).toThrow(/not inside this synced folder/);
  expect(() => workspaceRelativeRepo(root, "/etc")).toThrow(/not inside this synced folder/);
  // A traversal that lands back inside is legitimate and normalizes.
  expect(workspaceRelativeRepo(root, path.join(root, "acme", "..", "beta"))).toBe("beta");
});
