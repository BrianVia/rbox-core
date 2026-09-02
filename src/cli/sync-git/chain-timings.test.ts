import { expect, test } from "bun:test";
import { addClassifyTimedMs, addFollowTimedMs, addTimedMs, countRefCleanup, finalizeGitChainTimings, zeroGitChainTimings } from "./chain-timings.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("followMs bills only the follow's own cost, never its named leaves", async () => {
  const timings = zeroGitChainTimings();
  await addFollowTimedMs(timings, async () => {
    await addTimedMs(timings, "gitImportMs", () => sleep(40));
    await sleep(40);
  });
  // The leaf keeps its full cost; the parent keeps only the remainder, so the
  // two never sum past the follow's wall time.
  expect(timings.gitImportMs).toBeGreaterThanOrEqual(35);
  expect(timings.followMs).toBeGreaterThanOrEqual(20);
  expect(timings.followMs + timings.gitImportMs).toBeLessThan(200);

  // #814: the follow's unattributed cost is now named, not residual.
  finalizeGitChainTimings(timings, timings.gitImportMs + timings.followMs + 5);
  expect(timings.residualMs).toBeLessThanOrEqual(6);
});

test("classifyExclusiveMs excludes refCleanupMs — the leaf is never billed twice", async () => {
  const timings = zeroGitChainTimings();
  await addClassifyTimedMs(timings, async () => {
    await addTimedMs(timings, "refCleanupMs", () => sleep(40));
    await sleep(40);
  });
  // The child keeps its full cost and the exclusive figure keeps only the
  // remainder. Without refCleanupMs in CLASSIFY_CHILD_FIELDS the classifier's
  // ~80ms would be billed whole AND the 40ms leaf billed again beside it.
  expect(timings.refCleanupMs).toBeGreaterThanOrEqual(35);
  expect(timings.classifyExclusiveMs).toBeGreaterThanOrEqual(20);
  expect(timings.classifyExclusiveMs + timings.refCleanupMs).toBeLessThanOrEqual(timings.classifyMs + 5);

  // The parent is reported in full; only the exclusive partition is net.
  expect(timings.classifyMs).toBeGreaterThanOrEqual(70);
});

test("refCleanupRefs is a tally the leaf partition never sums", async () => {
  const timings = zeroGitChainTimings();
  countRefCleanup(timings, 3);
  countRefCleanup(timings, 4);
  expect(timings.refCleanupRefs).toBe(7);
  // A count must not leak into residual accounting as if it were milliseconds.
  finalizeGitChainTimings(timings, 0);
  expect(timings.residualMs).toBe(0);
  countRefCleanup(undefined, 5); // tolerated, exactly like addTimedMs
});

test("a repo that never follows attributes nothing to followMs", async () => {
  const timings = zeroGitChainTimings();
  await addTimedMs(timings, "heldInputMs", () => sleep(10));
  finalizeGitChainTimings(timings, timings.heldInputMs);
  expect(timings.followMs).toBe(0);
  expect(timings.residualMs).toBe(0);
});
