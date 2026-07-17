import { describe, expect, test } from "bun:test";
import { ResetHaltLogGate } from "./reset-halt-policy.js";

describe("reset halt log suppression", () => {
  test("suppresses A/B/A independently until each message reaches an hour", () => {
    const gate = new ResetHaltLogGate(60 * 60 * 1000, 8);
    expect(gate.shouldLog("A", 0)).toBe(true);
    expect(gate.shouldLog("B", 1)).toBe(true);
    expect(gate.shouldLog("A", 2)).toBe(false);
    expect(gate.shouldLog("B", 60 * 60 * 1000)).toBe(false);
    expect(gate.shouldLog("A", 60 * 60 * 1000)).toBe(true);
    expect(gate.shouldLog("B", 60 * 60 * 1000 + 1)).toBe(true);
  });

  test("evicts least-recently-used messages at the fixed bound", () => {
    const gate = new ResetHaltLogGate(100, 2);
    expect(gate.shouldLog("A", 0)).toBe(true);
    expect(gate.shouldLog("B", 1)).toBe(true);
    expect(gate.shouldLog("A", 2)).toBe(false); // A becomes most recently used
    expect(gate.shouldLog("C", 3)).toBe(true); // evicts B
    expect(gate.size).toBe(2);
    expect(gate.shouldLog("B", 4)).toBe(true);
  });
});
