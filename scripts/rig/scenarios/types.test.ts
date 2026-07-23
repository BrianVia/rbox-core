import { test, expect } from "bun:test";
import { finalizeReport, parsePairToken, renderReportTable, type AssertionResult, type StepResult } from "./types.js";

const steps: StepResult[] = [
  { name: "[A] login", ok: true, ms: 10 },
  { name: "[A] push", ok: true, ms: 20 },
];
const assertions: AssertionResult[] = [{ name: "trees identical", ok: true, detail: "101 files" }];

test("finalizeReport = PASS only when every step and assertion passed", () => {
  const pass = finalizeReport({ scenario: "onboard-smoke", startedAt: "2026-07-02T00:00:00.000Z", finishedAt: "2026-07-02T00:00:05.000Z", steps, assertions });
  expect(pass.verdict).toBe("PASS");
  expect(pass.durationMs).toBe(5000);

  const failStep = finalizeReport({ scenario: "s", startedAt: "2026-07-02T00:00:00.000Z", finishedAt: "2026-07-02T00:00:01.000Z", steps: [{ name: "x", ok: false, ms: 1 }], assertions: [] });
  expect(failStep.verdict).toBe("FAIL");

  const failAssert = finalizeReport({ scenario: "s", startedAt: "2026-07-02T00:00:00.000Z", finishedAt: "2026-07-02T00:00:01.000Z", steps, assertions: [{ name: "a", ok: false }] });
  expect(failAssert.verdict).toBe("FAIL");
});

test("renderReportTable includes verdict, each step, and each assertion", () => {
  const report = finalizeReport({ scenario: "onboard-smoke", startedAt: "2026-07-02T00:00:00.000Z", finishedAt: "2026-07-02T00:00:05.000Z", steps, assertions });
  const table = renderReportTable(report);
  expect(table).toContain("onboard-smoke :: PASS");
  expect(table).toContain("[PASS] [A] login");
  expect(table).toContain("[PASS] trees identical — 101 files");
});

test("parsePairToken extracts the token line from real pairCreate output", () => {
  const token = `rbox-pair_${"a".repeat(16)}.${"b".repeat(43)}`;
  const stdout = [
    "",
    "Pairing command (valid ~10 min, single use — carries your encryption key):",
    "",
    `    rbox connect ${token}`,
    "",
    "Run the command above on the new machine to authorize it and enroll encryption.",
  ].join("\n");
  expect(parsePairToken(stdout)).toBe(token);
});

test("parsePairToken rejects a bare token because the rig requires executable output", () => {
  expect(() => parsePairToken(`rbox-pair_${"a".repeat(16)}.${"b".repeat(43)}`)).toThrow(/pairing token/i);
});

test("parsePairToken throws when no token is present", () => {
  expect(() => parsePairToken("nothing token-shaped here\njust prose")).toThrow(/pairing token/i);
});
