import { describe, expect, test } from "bun:test";
import { formatCasSteps, formatPushSpan } from "./format.js";

describe("formatPushSpan", () => {
  test("renders the push epilogue spans", () => {
    expect(formatPushSpan("ack_ms", 1_234)).toBe("ack=1.2s");
    expect(formatPushSpan("publish_transition_ms", 2_345)).toBe("publish_transition=2.3s");
    expect(formatPushSpan("drain_wait_ms", 3_456)).toBe("drain_wait=3.5s");
    expect(formatPushSpan("projection_ms", 2_901)).toBe("projection=2.9s");
  });

  test("does not render zero-value spans", () => {
    expect(formatPushSpan("ack_ms", 0)).toBeUndefined();
  });
});

test("state-CAS details append final lock and blocker counts", () => {
  expect(formatCasSteps({ acquire: 1_250 }, { locks: 140, blocked: 3 })).toBe("cas acquire1.3 locks140 blocked3");
  expect(formatCasSteps({})).toBeUndefined();
});
