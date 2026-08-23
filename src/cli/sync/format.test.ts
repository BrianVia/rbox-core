import { describe, expect, test } from "bun:test";
import { formatCasSteps, formatPushSpan } from "./format.js";

describe("formatPushSpan", () => {
  test("does not render zero-value spans", () => {
    expect(formatPushSpan("ack_ms", 0)).toBeUndefined();
  });
});

test("state-CAS details append final lock and blocker counts", () => {
  expect(formatCasSteps({ acquire: 1_250 }, { locks: 140, blocked: 3 })).toBe("cas acquire1.3 locks140 blocked3");
  expect(formatCasSteps({})).toBeUndefined();
});
