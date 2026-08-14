import { describe, expect, test } from "bun:test";
import { formatPushSpan } from "./format.js";

describe("formatPushSpan", () => {
  test("renders the push epilogue spans", () => {
    expect(formatPushSpan("ack_ms", 1_234)).toBe("ack_ms=1.2");
    expect(formatPushSpan("publish_transition_ms", 2_345)).toBe("publish_transition_ms=2.3");
    expect(formatPushSpan("drain_wait_ms", 3_456)).toBe("drain_wait_ms=3.5");
  });

  test("does not render zero-value spans", () => {
    expect(formatPushSpan("ack_ms", 0)).toBeUndefined();
  });
});
