import { describe, expect, test } from "vitest";
import { capBytesFor, planFor } from "../src/plans.js";

describe("plan lookup", () => {
  test("fails closed to none for missing or unknown plans", () => {
    expect(planFor(null)).toEqual(planFor("none"));
    expect(planFor(undefined)).toEqual(planFor("none"));
    expect(planFor("garbage")).toEqual(planFor("none"));
    expect(capBytesFor(null)).toBe(1);
    expect(capBytesFor("garbage")).toBe(1);
  });

  test("Pro retains one year of version history while Team stays at 90 days", () => {
    expect(planFor("pro").retentionDays).toBe(365);
    expect(planFor("team").retentionDays).toBe(90);
  });
});
