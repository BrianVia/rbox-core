import { describe, expect, test } from "vitest";
import { platformSecretMatches } from "../src/util.js";

describe("platformSecretMatches", () => {
  test("matches only a present header against a configured non-empty secret", () => {
    expect(platformSecretMatches("platform-secret", { RBOX_PLATFORM_SECRET: "platform-secret" })).toBe(true);
    expect(platformSecretMatches("wrong", { RBOX_PLATFORM_SECRET: "platform-secret" })).toBe(false);
    expect(platformSecretMatches(null, { RBOX_PLATFORM_SECRET: "platform-secret" })).toBe(false);
  });

  test("fails closed for missing or empty configured secrets", () => {
    expect(platformSecretMatches(null, {})).toBe(false);
    expect(platformSecretMatches("", {})).toBe(false);
    expect(platformSecretMatches(null, { RBOX_PLATFORM_SECRET: "" })).toBe(false);
    expect(platformSecretMatches("", { RBOX_PLATFORM_SECRET: "" })).toBe(false);
  });
});
