/**
 * Design 273: the story vocabulary and the surfaces built on it, replayed
 * against the real fleet captures in src/cli/fixtures/field-states/.
 *
 * The defect these pin is a legibility one, so the assertions are about what a
 * person reads: every record maps to a story, no banned jargon renders, and the
 * headline count, the group sums and the JSON record count are one number.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { GIT_DEFERRAL_REASONS, type GitDeferral, type RepoRecord } from "../sync-state-model.js";
import { projectGitDeferralRepos, type GitDeferralDisplayEntry, type GitDeferralRepoProjection } from "./git-projection.js";
import { BANNED_HUMAN_WORDS, detailProvesPostApplySettle, gitStoryFor } from "./git-stories.js";
import {
  gitPauseCounts,
  gitPauseHeadline,
  groupByStory,
  loudRows,
  renderGitPauseListing,
  renderGitPauseSummary,
} from "./git-story-render.js";

const NOW = Date.parse("2026-08-17T12:30:00.000Z");

// ---------------------------------------------------------------- vocabulary

test("every deferral reason resolves to a story, and unknown reasons fail safe", () => {
  for (const reason of GIT_DEFERRAL_REASONS) {
    const story = gitStoryFor(reason);
    expect(story.headline.length).toBeGreaterThan(10);
    // A raw reason code must never be the thing a person reads.
    expect(story.headline).not.toContain(reason);
  }
  expect(gitStoryFor("a-reason-from-a-newer-rbox").code).toBe("other");
});

test("the artifact row is fail-closed: 'was saved first' needs a typed post-apply settle AND a backup path", () => {
  expect(gitStoryFor("artifact").code).toBe("sync-download-failed");
  expect(gitStoryFor("artifact", "bundle verify failed").code).toBe("sync-download-failed");
  // A backup path alone is not proof the apply settled.
  expect(gitStoryFor("artifact", "wrote .rbox/git-quarantine/1f3a/1.bundle").code).toBe("sync-download-failed");
  // Nor is the typed prefix alone, without a backup that exists to point at.
  expect(gitStoryFor("artifact", "post-apply-settle-failed: ref update rejected").code).toBe("sync-download-failed");
  expect(detailProvesPostApplySettle("post-apply-settle-failed: saved .rbox/git-quarantine/1f3a/1.bundle")).toBe(true);
  expect(gitStoryFor("artifact", "post-apply-settle-failed: saved .rbox/git-quarantine/1f3a/1.bundle").code)
    .toBe("settle-failed");
});

test("only the settle story claims a backup was saved first", () => {
  for (const reason of GIT_DEFERRAL_REASONS) {
    const story = gitStoryFor(reason);
    if (story.code === "settle-failed") continue;
    expect(story.headline).not.toContain("saved first");
  }
});

// -------------------------------------------------------------------- rows

const PENDING: RepoRecord["pending"] = {
  bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
  head: "ref: refs/heads/main\n", refs: { "refs/heads/main": "3".repeat(40) }, refScope: "all",
};
const withPending: RepoRecord = { repoGen: 1, sourceSeq: 1, pending: PENDING };

const row = (over: Partial<GitDeferral> & { repo: string; ageMs: number }): GitDeferralDisplayEntry => {
  const since = new Date(NOW - over.ageMs).toISOString();
  const deferral: GitDeferral = {
    lane: over.lane ?? "apply",
    reason: over.reason ?? "local-edits",
    deferredSince: since,
    reasonSince: since,
    lastSeen: since,
  };
  if (over.detail !== undefined) deferral.detail = over.detail;
  return { repo: over.repo, deferral, record: withPending };
};

test("an ownership hold is visible, never escalated, and never handed a command", () => {
  const [hold] = projectGitDeferralRepos([row({ repo: "a", ageMs: 5 * 86_400_000, reason: "worktree-ownership" })], NOW);
  expect(hold!.remediationClass).toBe("ownership-hold");
  expect(hold!.quiet).toBe(false);
  expect(hold!.story.code).toBe("branch-in-use-elsewhere");
  expect(hold!.story.needsYou).toBe(false);
  // `canKeepMine` is TRUE here (the record carries `pending`), which is exactly
  // why the class must be consulted first.
  expect(hold!.canKeepMine).toBe(true);
  const listing = renderGitPauseListing([hold!], { now: NOW }).join("\n");
  expect(listing).not.toContain("keep-mine");
  expect(listing).not.toContain("take-theirs");
  expect(listing).toContain("no command needed");
});

test("quiet is one computation: young transients are quiet, a durable lane beside one is not", () => {
  const projected = projectGitDeferralRepos([
    row({ repo: "young", ageMs: 60_000, reason: "local-edits" }),
    row({ repo: "old", ageMs: 3600_000, reason: "local-edits" }),
    row({ repo: "mixed", ageMs: 60_000, reason: "local-edits" }),
    row({ repo: "mixed", ageMs: 60_000, reason: "conflict" }),
    row({ repo: "hold", ageMs: 60_000, reason: "worktree-ownership" }),
  ], NOW);
  const quiet = Object.fromEntries(projected.map((r) => [r.repo, r.quiet]));
  expect(quiet).toEqual({ young: true, old: false, mixed: false, hold: false });
  expect(loudRows(projected).map((r) => r.repo).sort()).toEqual(["hold", "mixed", "old"]);
});

test("a deferral re-set every 60s for an hour stays visible to the support flow", () => {
  // The flapping repo never ages past the quiet window, so it is absent from
  // the headline and the listing — and MUST still be counted and labelled in
  // doctor, or a permanently-broken repo is permanently unreportable.
  const flapping = projectGitDeferralRepos([row({ repo: "flapper", ageMs: 30_000, reason: "local-edits" })], NOW);
  expect(flapping[0]!.quiet).toBe(true);
  expect(gitPauseHeadline(gitPauseCounts(loudRows(flapping)))).toEqual([]);
  expect(renderGitPauseListing(flapping, { now: NOW })).toEqual(["No git repos are paused."]);
  const summary = renderGitPauseSummary(flapping, NOW).join("\n");
  expect(summary).toContain("1 repo paused");
  expect(summary).toContain("recently paused, usually self-heals");
});

const undatedConflict: GitDeferral = {
  lane: "apply", reason: "conflict", deferredSince: "not-a-date", reasonSince: "not-a-date", lastSeen: "not-a-date",
};

test("missing ages render 'paused (since unknown)' and sort last", () => {
  const projected = projectGitDeferralRepos([
    { ...row({ repo: "unknown-age", ageMs: 0, reason: "conflict" }), deferral: undatedConflict },
    row({ repo: "dated", ageMs: 3 * 86_400_000, reason: "conflict" }),
  ], NOW);
  const group = groupByStory(loudRows(projected), NOW)[0]!;
  expect(group.rows.map((r) => r.repo)).toEqual(["dated", "unknown-age"]);
  const listing = renderGitPauseListing(projected, { now: NOW }).join("\n");
  expect(listing).toContain("paused (since unknown)");
  expect(listing).toContain("paused 3 days");
});

test("full repo paths are sanitized, never length-truncated", () => {
  const long = `conductor-workspaces/acme/${"deeply-nested/".repeat(6)}checkout-flow`;
  const injected = `${long}[31m`;
  const projected = projectGitDeferralRepos([row({ repo: injected, ageMs: 86_400_000, reason: "conflict" })], NOW);
  const listing = renderGitPauseListing(projected, { now: NOW }).join("\n");
  expect(listing).toContain(long);
  expect(listing).not.toContain("…");
  expect(listing).not.toContain("");
});

test("a group prints only commands EVERY repo in it supports", () => {
  const resolvable = projectGitDeferralRepos([row({ repo: "a", ageMs: 86_400_000, reason: "conflict" })], NOW);
  expect(renderGitPauseListing(resolvable, { now: NOW }).join("\n")).toContain("rbox git resolve <repo> keep-mine");

  const mixed = projectGitDeferralRepos([
    row({ repo: "a", ageMs: 86_400_000, reason: "conflict" }),
    { ...row({ repo: "b", ageMs: 86_400_000, reason: "conflict" }), record: undefined },
  ], NOW);
  const listing = renderGitPauseListing(mixed, { now: NOW }).join("\n");
  expect(listing).toContain("b   paused 1 day");
  expect(listing).not.toContain("rbox git resolve");
});

test("--all drops the per-group cap", () => {
  const many = projectGitDeferralRepos(
    Array.from({ length: 9 }, (_, i) => row({ repo: `repo-${i}`, ageMs: (i + 1) * 86_400_000, reason: "conflict" })),
    NOW,
  );
  const capped = renderGitPauseListing(many, { now: NOW }).join("\n");
  expect(capped).toContain("… 4 more not shown");
  expect(capped).toContain("rbox status --git --all");
  const all = renderGitPauseListing(many, { now: NOW, all: true }).join("\n");
  expect(all).not.toContain("more not shown");
  for (let i = 0; i < 9; i++) expect(all).toContain(`repo-${i}`);
});

// -------------------------------------------------------- field-state replay

interface FieldRow {
  rel: string;
  deferrals: Record<string, GitDeferral | null> | null;
  hasPending?: number | null;
}

function loadFieldState(file: string): GitDeferralDisplayEntry[] {
  const raw = fs.readFileSync(path.join(import.meta.dir, "..", "fixtures", "field-states", file), "utf8");
  return raw.trimEnd().split("\n").flatMap((line) => {
    const parsed = JSON.parse(line) as FieldRow;
    const record: RepoRecord = { repoGen: 1, sourceSeq: 1 };
    if (parsed.hasPending) record.pending = PENDING;
    return Object.values(parsed.deferrals ?? {}).flatMap((deferral) =>
      deferral ? [{ repo: parsed.rel, deferral, record }] : []);
  });
}

const humanSurfaces = (rows: GitDeferralRepoProjection[], now: number): string =>
  [
    ...gitPauseHeadline(gitPauseCounts(loudRows(rows))),
    ...renderGitPauseListing(rows, { now, all: true }),
    ...renderGitPauseSummary(rows, now),
  ].join("\n");

for (const [file, expectedRepos] of [["2026-08-17-flat-meadow.jsonl", 52], ["2026-08-17-mac.jsonl", 3]] as const) {
  test(`field replay ${file}: every record maps to a story and the counts reconcile`, () => {
    const entries = loadFieldState(file);
    const rows = projectGitDeferralRepos(entries, NOW);
    // README: FM's 52 records render "52 git repos need attention" after the
    // #765 daemon restart, so the projection must reproduce 52 — the 103 was a
    // stale pre-restart projection, not a second population.
    expect(rows).toHaveLength(expectedRepos);
    for (const projected of rows) expect(projected.story.headline.length).toBeGreaterThan(10);

    // The population invariant: headline == group sums == JSON record count.
    const visible = loudRows(rows);
    const counts = gitPauseCounts(visible);
    expect(counts.needsYou + counts.selfHealing).toBe(visible.length);
    const groups = groupByStory(visible, NOW);
    expect(groups.reduce((sum, group) => sum + group.rows.length, 0)).toBe(visible.length);
    expect(rows.length).toBe(entries.length === 0 ? 0 : new Set(entries.map((e) => e.repo)).size);

    // None of these captures is inside the quiet window, so the human surfaces
    // show the whole population — the defect was the opposite.
    expect(visible).toHaveLength(expectedRepos);
  });

  test(`field replay ${file}: no banned jargon reaches the human surface`, () => {
    const surface = humanSurfaces(projectGitDeferralRepos(loadFieldState(file), NOW), NOW).toLowerCase();
    for (const banned of BANNED_HUMAN_WORDS) expect(surface).not.toContain(banned);
    for (const reason of GIT_DEFERRAL_REASONS) {
      if (reason === "conflict" || reason === "other") continue; // ordinary English words
      expect(surface).not.toContain(reason);
    }
    // "was saved first" may never render without a backup path to point at.
    expect(surface).not.toContain("saved first");
  });
}

test("field replay: the FM capture splits into needs-you and self-healing without losing a repo", () => {
  const rows = projectGitDeferralRepos(loadFieldState("2026-08-17-flat-meadow.jsonl"), NOW);
  const counts = gitPauseCounts(loudRows(rows));
  expect(counts.total).toBe(52);
  // 43 local-index + 2 local-edits + 2 unreadable need a person; the 5 artifact
  // pauses download-retry on their own.
  expect(counts.needsYou).toBe(47);
  expect(counts.selfHealing).toBe(5);
  const headline = gitPauseHeadline(counts).join("\n");
  expect(headline).toContain("47 repos are waiting on you");
  expect(headline).toContain("5 more are sorting themselves out.");
});

test("field replay: held ownership rows stay visible once P2 keeps their record", () => {
  // The FM capture predates P2, so its held rows carry local-commits. Restage
  // them as the ownership holds P2 now writes and prove they survive the trip.
  const entries = loadFieldState("2026-08-17-flat-meadow.jsonl").slice(0, 3)
    .map((entry) => ({ ...entry, deferral: { ...entry.deferral, reason: "worktree-ownership" as const } }));
  const rows = projectGitDeferralRepos(entries, NOW);
  expect(rows).toHaveLength(3);
  for (const projected of rows) {
    expect(projected.remediationClass).toBe("ownership-hold");
    expect(projected.quiet).toBe(false);
  }
  expect(gitPauseCounts(loudRows(rows))).toEqual({ needsYou: 0, selfHealing: 3, total: 3 });
});
