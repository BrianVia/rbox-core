import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

/**
 * Design 176 §3 names every consumer whose detector makes the Git log grammar
 * load-bearing. Keep that inventory executable: removing or loosening one of
 * the existing exact assertions/parsers must be an intentional test change,
 * never an accidental side effect of improving the human wording in an
 * otherwise ignored suffix.
 */
const CONSUMER_FREEZE = [
  ["follow exact assertions", "src/cli/sync-git/follow.test.ts", ['toContain("git-sync followed repo")']],
  ["follow-matrix exact assertions", "src/cli/sync-git/follow-matrix.test.ts", ['toContain(`git-sync followed ${REL}`)']],
  ["git-sync scheduling/concurrency parser", "src/cli/sync-git/git-sync.test.ts", ["^git-sync applied (.+)$"]],
  ["sync-cmd routing", "src/cli/sync-cmd.ts", ['line.startsWith("git-sync CONFLICT")', 'line.startsWith("git-sync WARNING")']],
  ["status parser/rendering", "src/cli/status-view.test.ts", ['toBe("git deferred 1h: local commits on detached checkout (repo)")']],
  ["doctor redaction", "src/cli/doctor-cmd.ts", ["^git-sync deferred", "^git-sync CONFLICT", "^git-sync config skipped", "^git-sync applied"]],
  ["shared rig fixtures", "scripts/rig/lib/git-fixtures.ts", ['`git-sync applied ${rel}`', '`git-sync followed ${rel}`', "return `git-sync: captured"]],
  ["git-held-livelock", "scripts/rig/scenarios/git-held-livelock.ts", ["git-sync superseded pending ${REPO}: local history subsumes the unapplied remote section"]],
  ["git-commit-propagation", "scripts/rig/scenarios/git-commit-propagation.ts", ["git-sync: captured [1-9]", "git-sync (followed|applied) ${repo}"]],
  ["git-shapes", "scripts/rig/scenarios/git-shapes.ts", ['GIT_SHAPE_SURFACES.applied("s1-b")', "GIT_SHAPE_SURFACES.operationDeferredPrefix(rel)"]],
  ["daemon-control deferral collapse", "src/cli/daemon/daemon-deferral-visibility.test.ts", ['"git deferred 30m: local edits on branch release/0.9forged (repo)"']],
  // Design 273 rewrote the human --git listing to the pause-story grammar;
  // the scenario now pins that surface (the frozen `git deferred` line's
  // remaining parser-consumers are doctor + status-view, pinned above).
  ["git-entanglement", "scripts/rig/scenarios/git-entanglement.ts", ["/changed here/", "paused 11 minutes"]],
] as const;

for (const [consumer, relative, markers] of CONSUMER_FREEZE) {
  test(`design 176 grammar freeze: ${consumer}`, () => {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    for (const marker of markers) expect(source).toContain(marker);
  });
}

const LOG_LANGUAGE_SOURCES = [
  "src/cli/sync-git/apply.ts",
  "src/cli/sync-git/plan-accumulator.ts",
  "src/cli/sync-git/plan.ts",
  "src/cli/sync-git/received-git-config.ts",
  "src/cli/sync-git/remote-repository-deletion.ts",
  "src/cli/sync-git/repo-capture-attempt.ts",
  "src/cli/sync/push.ts",
  "src/cli/sync/publisher-ack-transition.ts",
] as const;

/**
 * The census counts EMISSIONS, not source copies. When five identical
 * config-ownership skips shared one sentence verbatim, five literals and five
 * emissions were the same number, so counting literals was enough.
 *
 * 2026-08-14 (#573): plan.ts's five config-ownership skips were deduped into one
 * `skipConfigOwnership(rel, why)` emitter — the composed sentence is byte-identical
 * (verified against every pre-dedup literal), but the literal now appears once for
 * five emissions. So the shared clause is pinned as literal × call sites, and the
 * total stays twelve. This is a re-pin, not a relaxation: adding, dropping or
 * rewording a skip site still fails, and the emitter's own template is pinned
 * whole below so the suffix cannot drift off the human clause.
 *
 * 2026-08-14 (#37): the three-owner git-plan decomposition moved config-skip
 * decisions into repo-capture-attempt.ts and the one-shot log sink into
 * plan-accumulator.ts. Two paired carry/capture decisions now share ternary
 * enqueue sites, so three command sites still represent the same five exact
 * reasons. The final template in plan.ts now consumes `command.reason`; all five
 * composed sentences remain byte-identical to the pre-decomposition emissions.
 */
const PLAN_CONFIG_SKIP_EMITTER =
  "`git-sync config skipped ${rel}: ${command.reason}. rbox left shared Git settings alone; Git history can still sync.`";

const PLAN_ACCUMULATOR_LOG_ONCE_EMITTER = `logOnce(seen: Set<string>, rel: string, line: string): void {
    const key = \`\${this.root}\\0\${rel}\`;
    if (seen.has(key)) return;
    seen.add(key);
    this.glog(line);
  }`;

const REPO_CAPTURE_CONFIG_SKIP_REASONS = [
  "`local ${repoKind} shape does not own the common config`",
  "`capture repository is ${repoKind}/scoped and does not own the common config`",
  "`capture ownership could not be proven (${errMsg(error)})`",
  '"local common config is outside workspace ownership"',
  '"capture common config is outside workspace ownership"',
] as const;

test("design 176 log-language pass is exactly twelve ignored-suffix additions", () => {
  const byFile = new Map(LOG_LANGUAGE_SOURCES.map((relative) =>
    [relative, fs.readFileSync(path.join(ROOT, relative), "utf8")] as const));
  const source = [...byFile.values()].join("\n");
  const occurrences = (clause: string, text = source): number => text.split(clause).length - 1;

  const plan = byFile.get("src/cli/sync-git/plan.ts")!;
  const accumulator = byFile.get("src/cli/sync-git/plan-accumulator.ts")!;
  const captureAttempt = byFile.get("src/cli/sync-git/repo-capture-attempt.ts")!;
  expect(plan).toContain(PLAN_CONFIG_SKIP_EMITTER);
  expect(accumulator).toContain(PLAN_ACCUMULATOR_LOG_ONCE_EMITTER);
  expect(occurrences('kind: "config-skip"', captureAttempt)).toBe(4); // 1 command variant + 3 enqueue sites
  for (const reason of REPO_CAPTURE_CONFIG_SKIP_REASONS) expect(captureAttempt).toContain(reason);
  const sharedClause = "rbox left shared Git settings alone; Git history can still sync.";
  expect(occurrences(sharedClause, plan)).toBe(1); // the one final template…
  expect(REPO_CAPTURE_CONFIG_SKIP_REASONS).toHaveLength(5); // …fed by five byte-frozen reasons
  expect(occurrences(sharedClause)).toBe(3); // 1 emitter + 2 direct, for 7 emissions

  expect(occurrences("Your local Git work is safe; inspect the preserved incoming state before resolving.")).toBe(2);
  expect(occurrences("Your local Git repository is safe.")).toBe(1);
  expect(occurrences("Your local Git work is safe while rbox retries.")).toBe(1);
  expect(occurrences("rbox will publish the local history instead.")).toBe(1);
});
