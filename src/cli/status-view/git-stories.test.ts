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

test("the artifact headline is true for a failed download AND for an unusable local copy", () => {
  // Design 278: the connectivity class downloads the bundle successfully every
  // time and still cannot put it in place, so a headline that names downloading
  // would tell those repos something false.
  const headline = gitStoryFor("artifact").headline;
  expect(headline).toBe("rbox couldn't put the other computer's version in place here — nothing here changed");
  expect(headline).not.toContain("download");
  expect(gitStoryFor("artifact", "planned graph connectivity proof failed").headline).toBe(headline);
  expect(gitStoryFor("artifact", "git artifact fetch/decrypt/import failed: bundle verify failed").headline).toBe(headline);
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
  if (over.bytesChanged !== undefined) deferral.bytesChanged = over.bytesChanged;
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
  expect(renderGitPauseListing(flapping, { now: NOW }))
    .toEqual(["Nothing needs you — 1 repo paused in the last few minutes and usually sorts itself out."]);
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

test("a mixed group SPLITS: the half that can act keeps its commands, the other says nothing", () => {
  const resolvable = projectGitDeferralRepos([row({ repo: "a", ageMs: 86_400_000, reason: "conflict" })], NOW);
  expect(renderGitPauseListing(resolvable, { now: NOW }).join("\n")).toContain("rbox git resolve <repo> keep-mine");

  const mixed = projectGitDeferralRepos([
    row({ repo: "a", ageMs: 86_400_000, reason: "conflict" }),
    { ...row({ repo: "b", ageMs: 86_400_000, reason: "conflict" }), record: undefined },
  ], NOW);
  expect(mixed.map((r) => r.resolvable)).toEqual([true, false]);
  const lines = renderGitPauseListing(mixed, { now: NOW });
  // Two groups, one story: the design's "mixed groups split" (S2). Silencing
  // the whole group instead would deny "a" the commands it genuinely supports.
  expect(lines.filter((line) => line.startsWith("1 repo — this repo changed on two computers at once"))).toHaveLength(2);
  const text = lines.join("\n");
  const [canAct, cannot] = text.split("1 repo — this repo changed on two computers at once").slice(1);
  expect(canAct).toContain("   a   paused 1 day");
  expect(canAct).toContain("rbox git resolve <repo> keep-mine");
  expect(cannot).toContain("   b   paused 1 day");
  expect(cannot).not.toContain("rbox git resolve");
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

test("a self-healing group never also asks the reader to choose a side", () => {
  const healing = projectGitDeferralRepos([
    row({ repo: "a", ageMs: 86_400_000, reason: "artifact" }),
    row({ repo: "b", ageMs: 86_400_000, reason: "git-busy" }),
  ], NOW);
  // Both rows CAN resolve (the record carries `pending`), but their stories say
  // rbox is handling it — offering keep-mine beside "nothing here changed" is
  // exactly the contradiction that made the old surface unreadable.
  expect(healing.every((r) => r.canResolve)).toBe(true);
  const listing = renderGitPauseListing(healing, { now: NOW }).join("\n");
  expect(listing).not.toContain("rbox git resolve");
  expect(listing).toContain("rbox is handling these on its own — nothing to do");
  expect(listing).toContain("If any are still here tomorrow: rbox doctor");
});

test("the unreadable story carries its per-reason repair text on its own line, and never a resolve command", () => {
  const rows = projectGitDeferralRepos([
    row({ repo: "a", ageMs: 86_400_000, reason: "unreadable" }),
    row({ repo: "b", ageMs: 86_400_000, reason: "containment" }),
  ], NOW);
  const lines = renderGitPauseListing(rows, { now: NOW });
  expect(lines).toContain("2 repos — rbox can't read or manage them right now");
  // Own line, not concatenated onto the repo row.
  expect(lines).toContain("      Restore repository readability and permissions, then let sync retry.");
  expect(lines.join("\n")).toContain("so it stays within the workspace");
  // The design rule: a group prints only commands EVERY repo supports, and a
  // repo rbox cannot read would refuse every resolve verb.
  // The story's action is `repair-text`, so no surface even asks whether these
  // rows could resolve — the group offers the repair, never a verb.
  expect(lines.join("\n")).not.toContain("rbox git resolve");
  expect(rows.every((r) => r.story.action.kind === "repair-text")).toBe(true);
});

test("a group header agrees in number at one repo and at many", () => {
  const one = renderGitPauseListing(
    projectGitDeferralRepos([row({ repo: "a", ageMs: 86_400_000, reason: "unreadable" })], NOW),
    { now: NOW },
  );
  expect(one).toContain("1 repo — rbox can't read or manage this repo right now");
  for (const reason of GIT_DEFERRAL_REASONS) {
    const many = renderGitPauseListing(
      projectGitDeferralRepos([
        row({ repo: "a", ageMs: 86_400_000, reason }),
        row({ repo: "b", ageMs: 86_400_000, reason }),
      ], NOW),
      { now: NOW },
    ).join("\n");
    // No group header may say "this repo"/"it" about two of them.
    const header = many.split("\n").find((line) => line.startsWith("2 repos — "))!;
    expect(header).not.toContain("this repo");
    expect(header).not.toContain(" left it alone");
  }
});

test("the 'other' story hands the reader to support instead of dead-ending", () => {
  const rows = projectGitDeferralRepos([row({ repo: "a", ageMs: 86_400_000, reason: "other" })], NOW);
  const listing = renderGitPauseListing(rows, { now: NOW }).join("\n");
  expect(listing).toContain("Send this to support:");
  expect(listing).toContain("rbox doctor --report");
});

test("ages line up in a column whatever the path lengths are", () => {
  const listing = renderGitPauseListing(projectGitDeferralRepos([
    row({ repo: "short", ageMs: 86_400_000, reason: "conflict" }),
    row({ repo: "a/much/longer/repo/path", ageMs: 2 * 86_400_000, reason: "conflict" }),
  ], NOW), { now: NOW });
  const columns = listing.filter((line) => line.startsWith("   ") && line.includes("paused "))
    .map((line) => line.indexOf("paused "));
  expect(new Set(columns).size).toBe(1);
});

test("no rendered line carries a control character (the group key is not the separator)", () => {
  const listing = renderGitPauseListing(projectGitDeferralRepos([
    row({ repo: "a", ageMs: 86_400_000, reason: "conflict" }),
  ], NOW), { now: NOW }).join("\n");
  expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(listing)).toBe(false);
});

// ------------------------------------------------------------- lane-complete

test("an ownership hold beside an unreadable lane still needs a person", () => {
  const [mixed] = projectGitDeferralRepos([
    row({ repo: "a", ageMs: 5 * 86_400_000, reason: "worktree-ownership" }),
    row({ repo: "a", ageMs: 86_400_000, reason: "unreadable", lane: "capture" }),
  ], NOW);
  expect(mixed!.story.needsYou).toBe(true);
  expect(mixed!.story.code).toBe("repo-unreadable");
  expect(mixed!.remediationClass).not.toBe("ownership-hold");
  expect(mixed!.resolvable).toBe(false);
  // The oldest lane still owns the age the reader sees.
  expect(mixed!.oldestDeferredSince).toBe(new Date(NOW - 5 * 86_400_000).toISOString());
  expect(gitPauseCounts(loudRows([mixed!]))).toEqual({ needsYou: 1, selfHealing: 0, total: 1 });
});

test("an ownership hold beside a config lane is not an ownership hold", () => {
  const [mixed] = projectGitDeferralRepos([
    row({ repo: "a", ageMs: 5 * 86_400_000, reason: "worktree-ownership" }),
    row({ repo: "a", ageMs: 86_400_000, reason: "config", lane: "config" }),
  ], NOW);
  expect(mixed!.remediationClass).toBe("config");
  expect(mixed!.story.needsYou).toBe(true);
  expect(mixed!.resolvable).toBe(false);
});

test("a half-finished git operation outranks the index it necessarily dirtied", () => {
  const [repo] = projectGitDeferralRepos([
    row({ repo: "a", ageMs: 86_400_000, reason: "local-index" }),
    row({ repo: "a", ageMs: 86_400_000, reason: "local-operation", lane: "capture" }),
  ], NOW);
  expect(repo!.story.code).toBe("unfinished-git-operation");
});

test("the index story says uncommitted work, not staged work", () => {
  expect(gitStoryFor("local-index").headline).toBe("you have uncommitted work here");
});

// ------------------------------------------------------------------ actions

test("a self-healing group escalates once it has been retrying for over a day", () => {
  const young = projectGitDeferralRepos([row({ repo: "a", ageMs: 3600_000 * 3, reason: "git-busy" })], NOW);
  const youngLines = renderGitPauseListing(young, { now: NOW });
  expect(youngLines).toContain("   rbox is handling these on its own — nothing to do");
  expect(youngLines).toContain("   If any are still here tomorrow: rbox doctor");
  // The headline never also says it: one handling sentence per group.
  expect(youngLines.join("\n").match(/on its own/g)).toHaveLength(1);

  const old = renderGitPauseListing(
    projectGitDeferralRepos([row({ repo: "a", ageMs: 3 * 86_400_000, reason: "git-busy" })], NOW),
    { now: NOW },
  );
  expect(old).toContain("   rbox has been retrying these for over a day — that is longer than it should take.");
  expect(old.join("\n")).toContain("Get a closer look:");
  expect(old.join("\n")).not.toContain("nothing to do");
});

test("keep-mine says what it will show you before you commit to it", () => {
  const lines = renderGitPauseListing(
    projectGitDeferralRepos([row({ repo: "a", ageMs: 86_400_000, reason: "conflict" })], NOW),
    { now: NOW },
  );
  const keepMine = lines.findIndex((line) => line.includes("rbox git resolve <repo> keep-mine"));
  expect(keepMine).toBeGreaterThan(-1);
  const clarifier = lines[keepMine + 1]!;
  expect(clarifier.trimEnd()).toBe(
    `${" ".repeat(lines[keepMine]!.indexOf("rbox git resolve"))}(shows you what you'd drop, then gives you the confirm command)`,
  );
});

/** The indented second line under a repo row — six spaces, then content. */
const isDetailLine = (line: string): boolean => line.startsWith("      ") && !line.startsWith("       ");

test("a repo row carries its load-bearing companion detail, and nothing else", () => {
  const plain = projectGitDeferralRepos([row({ repo: "plain", ageMs: 86_400_000, reason: "conflict" })], NOW);
  expect(renderGitPauseListing(plain, { now: NOW }).filter(isDetailLine)).toEqual([]);

  const detailed = projectGitDeferralRepos([
    row({ repo: "copies", ageMs: 86_400_000, reason: "conflict-copies", detail: "only conflict-copies remain here, so the comparison was skipped." }),
  ], NOW);
  expect(renderGitPauseListing(detailed, { now: NOW }))
    .toContain("      only conflict-copies remain here, so the comparison was skipped.");

  const changed = projectGitDeferralRepos([row({ repo: "dirty", ageMs: 86_400_000, reason: "conflict", bytesChanged: true })], NOW);
  expect(renderGitPauseListing(changed, { now: NOW }))
    .toContain("      working files changed here since the pause");

  const busy = projectGitDeferralRepos([row({ repo: "busy", ageMs: 86_400_000, reason: "stale-unattributed" })], NOW);
  expect(renderGitPauseListing(busy, {
    now: NOW,
    staleLocks: () => ({ lockCount: 2, oldestAgeMs: 7200_000, samplePath: "busy/.git/index.lock" }),
  })).toContain("      2 stable locks with no live owner, for example busy/.git/index.lock");
});

// ----------------------------------------------------------------- headline

test("a population that only sorts itself out never warns", () => {
  expect(gitPauseHeadline({ needsYou: 0, selfHealing: 4 }))
    .toEqual(["rbox paused git sync in 4 repos and is sorting them out on its own.", "  See them:  rbox status --git"]);
  expect(gitPauseHeadline({ needsYou: 0, selfHealing: 1 })[0])
    .toBe("rbox paused git sync in 1 repo and is sorting it out on its own.");
});

test("the pointer to the listing is dropped when the listing follows", () => {
  expect(gitPauseHeadline({ needsYou: 2, selfHealing: 0, listed: true }))
    .toEqual(["⚠ 2 repos are waiting on you — rbox paused git sync there so nothing you did gets overwritten."]);
  expect(gitPauseHeadline({ needsYou: 0, selfHealing: 2, listed: true })).toHaveLength(1);
});

test("the dry-run surface keeps the same jargon bar as the listing", async () => {
  const { renderResolveDryRun } = await import("../git/resolve-dry-run.js");
  const surface = [
    ...renderResolveDryRun("acme/checkout", "take-theirs", undefined),
    ...renderResolveDryRun("acme/checkout", "keep-mine", undefined),
    ...renderResolveDryRun("acme/checkout", "show-me", undefined),
  ].join("\n").toLowerCase();
  for (const banned of BANNED_HUMAN_WORDS) {
    // The ONE declared exception (design 273 S4, verbatim): the preview names
    // the directory the reader will actually see on disk, and glosses it once —
    // "rbox calls this the git quarantine". Hiding the name of a folder the user
    // is being pointed at is worse than using the word.
    if (banned === "quarantine") {
      expect(surface).toContain("(rbox calls this the git quarantine)");
      expect(surface.split("quarantine").length - 1).toBe(surface.split(".rbox/git-quarantine").length);
      continue;
    }
    expect(surface).not.toContain(banned);
  }
  for (const reason of GIT_DEFERRAL_REASONS) {
    if (reason === "conflict" || reason === "other" || reason === "artifact") continue;
    expect(surface).not.toContain(reason);
  }
});
