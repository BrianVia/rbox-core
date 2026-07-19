import { afterEach, describe, expect, test } from "bun:test";
import {
  main, parseScenarioArgs, renderPlan, renderReport,
} from "./git-ff-scenario.js";
import { DEV_API } from "./mint-account.js";

afterEach(() => {
  process.exitCode = 0;
});

test("argument parser exposes only help and dry-run", () => {
  expect(parseScenarioArgs([])).toEqual({ dryRun: false, help: false });
  expect(parseScenarioArgs(["--dry-run"])).toEqual({ dryRun: true, help: false });
  expect(parseScenarioArgs(["-h"])).toEqual({ dryRun: false, help: true });
  expect(() => parseScenarioArgs(["--api", DEV_API])).toThrow(/unknown option/);
});

test("dry-run is DEV-guarded, secret-free, and action-free", async () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((value: string) => { writes.push(value); return true; }) as typeof process.stdout.write;
  try { await main(["--dry-run"], { RBOX_API: DEV_API }); }
  finally { process.stdout.write = original; }
  expect(writes.join("")).toBe(`${renderPlan()}\n`);
  expect(writes.join("")).not.toMatch(/sk_(?:test|live)|Bearer|rbox-pair_/);

  for (const target of [undefined, "https://api.rbox.to", "http://localhost:8787", `${DEV_API}/v1`]) {
    await expect(main(["--dry-run"], { RBOX_API: target })).rejects.toThrow(/refus|must be set/i);
  }
});

describe("final report", () => {
  test("records exact SHAs, timing, reflog, cleanup, and PASS", () => {
    const oldHead = "1".repeat(40);
    const newHead = "2".repeat(40);
    const report = renderReport({
      target: DEV_API,
      verdict: "PASS",
      attempts: [{
        attempt: 1,
        runId: "e2e-git-ff-test",
        steps: {
          "machine-a": { label: "1. Machine A", outcome: "PASS", evidence: oldHead },
          "machine-b": { label: "2. Machine B", outcome: "PASS", evidence: oldHead },
          "a-commit": { label: "3. A commit", outcome: "PASS", evidence: newHead },
          "b-fast-forward": { label: "4. B fast-forward", outcome: "PASS", evidence: `${oldHead} -> ${newHead}` },
          "clean-state": { label: "5. Clean", outcome: "PASS", evidence: "porcelain empty" },
        },
        initialHead: oldHead,
        updatedHead: newHead,
        propagationMs: 750,
        reflog: `${newHead}\tmain@{0}\tepisode\n${oldHead}\tmain@{1}\tinitial`,
        scenarioPassed: true,
        cleanupPassed: true,
        cleanupEvidence: "account_inaccessible; zero scoped container/volume residue",
        wizardTimeout: false,
      }],
    });
    expect(report).toContain("Final verdict: **PASS**");
    expect(report).toContain(oldHead);
    expect(report).toContain(newHead);
    expect(report).toContain("**750 ms**");
    expect(report).toContain("account_inaccessible");
    expect(report).toContain("main@{1}");
  });
});
