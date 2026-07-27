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
  ["git-entanglement", "scripts/rig/scenarios/git-entanglement.ts", ["/git deferred\\s+\\d+[smhd]:/"]],
] as const;

for (const [consumer, relative, markers] of CONSUMER_FREEZE) {
  test(`design 176 grammar freeze: ${consumer}`, () => {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    for (const marker of markers) expect(source).toContain(marker);
  });
}

test("design 176 log-language pass is exactly twelve ignored-suffix additions", () => {
  const source = [
    "src/cli/sync-git/apply.ts",
    "src/cli/sync-git/plan.ts",
    "src/cli/sync-git/remote-repository-deletion.ts",
    "src/cli/sync/push.ts",
    "src/cli/sync/publisher-ack-transition.ts",
  ].map((relative) => fs.readFileSync(path.join(ROOT, relative), "utf8")).join("\n");
  const occurrences = (clause: string): number => source.split(clause).length - 1;

  expect(occurrences("rbox left shared Git settings alone; Git history can still sync.")).toBe(7);
  expect(occurrences("Your local Git work is safe; inspect the preserved incoming state before resolving.")).toBe(2);
  expect(occurrences("Your local Git repository is safe.")).toBe(1);
  expect(occurrences("Your local Git work is safe while rbox retries.")).toBe(1);
  expect(occurrences("rbox will publish the local history instead.")).toBe(1);
});
