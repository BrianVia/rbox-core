/**
 * The standing mutation gate's own tests (design 222 §7.9, wave 5C).
 *
 * Two halves, deliberately separated by cost:
 *
 * - the **anchor and hygiene** half is pure text and runs in milliseconds;
 * - the **sweep** actually mutates a sandboxed copy of `src/` and runs the named
 *   test files, which costs about ten seconds for the current table.
 *
 * Both run in CI. The sweep is affordable only because the table is curated;
 * if it ever stops being affordable the answer is to shrink the table to the
 * guards a reviewer genuinely could not otherwise defend, not to stop running
 * it — a mutation gate that does not execute is a comment.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { checkAnchors, MUTATION_GUARDS, runMutationGate } from "./mutation-gate.js";

const REPO = path.resolve(import.meta.dir, "..");

test("every guard's anchor still matches exactly once", () => {
  const stale = checkAnchors().filter((v) => v.status !== "killed");
  expect(stale.map((v) => `${v.id}: ${v.detail}`)).toEqual([]);
});

test("every guard states why it is load-bearing", () => {
  for (const guard of MUTATION_GUARDS) {
    expect(guard.reason.length, `${guard.id} needs a real reason, not a label`).toBeGreaterThan(60);
  }
});

test("every guard names a source file and a test file that both exist", () => {
  for (const guard of MUTATION_GUARDS) {
    expect(fs.existsSync(path.join(REPO, "src", guard.file)), guard.file).toBe(true);
    expect(fs.existsSync(path.join(REPO, "src", guard.test)), guard.test).toBe(true);
  }
});

test("removing the guard is a different file than leaving it", () => {
  // A row whose `removed` text equals its anchor mutates nothing and would
  // report every guard as covered. The gate must not be able to pass vacuously.
  for (const guard of MUTATION_GUARDS) {
    expect(guard.removed, guard.id).not.toBe(guard.anchor);
  }
});

test("guard ids are unique", () => {
  const ids = MUTATION_GUARDS.map((g) => g.id);
  expect(ids.length).toBe(new Set(ids).size);
});

test("the table is not empty", () => {
  // A gate that sweeps nothing passes forever. If the table is ever emptied,
  // that is a decision to delete the gate, and it should fail here first.
  expect(MUTATION_GUARDS.length).toBeGreaterThan(4);
});

test("a mutant that cannot build is not reported as a covered guard", () => {
  // The gate's own vacuity check. Any non-zero exit would otherwise read as
  // "killed", so a row whose `removed` text does not parse would report a
  // HEALTHY guard — the gate asserting nothing, which is the failure mode it
  // exists to catch. Verified against the real sweep in `vacuity` mode rather
  // than asserted in prose.
  const guard = MUTATION_GUARDS[0]!;
  const broken = [{ ...guard, removed: "if (((((( " }];
  const verdicts = runMutationGate(broken);
  expect(verdicts.map((v) => v.status)).toEqual(["mutant-unbuildable"]);
}, { timeout: 300_000 });

/**
 * The expensive sweep has ONE authority: `bun run gate:mutation` in CI's checks
 * leg. It is opt-in here so the same minutes are not spent twice — running it
 * from both places was pure duplication, not defence in depth. Set
 * `RBOX_MUTATION_GATE_SWEEP=1` to run it locally.
 */
const sweep = process.env.RBOX_MUTATION_GATE_SWEEP === "1" ? test : test.skip;
sweep(
  "every named guard's removal breaks its named test",
  () => {
    const verdicts = runMutationGate();
    const failed = verdicts.filter((v) => v.status !== "killed");
    expect(failed.map((v) => `${v.status} ${v.id}: ${v.detail}`)).toEqual([]);
  },
  { timeout: 300_000 },
);
