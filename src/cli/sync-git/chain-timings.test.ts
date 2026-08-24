import { expect, test } from "bun:test";
import { addFollowTimedMs, addTimedMs, finalizeGitChainTimings, zeroGitChainTimings } from "./chain-timings.js";

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

test("a repo that never follows attributes nothing to followMs", async () => {
  const timings = zeroGitChainTimings();
  await addTimedMs(timings, "heldInputMs", () => sleep(10));
  finalizeGitChainTimings(timings, timings.heldInputMs);
  expect(timings.followMs).toBe(0);
  expect(timings.residualMs).toBe(0);
});
