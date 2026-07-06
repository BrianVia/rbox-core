import { expect, test } from "bun:test";
import { resolveRboxVersion } from "./version.js";
import pkg from "../../package.json";

test("defined compile-time version wins", () => {
  expect(resolveRboxVersion("0.9.1-dev+03ff993.dirty")).toBe("0.9.1-dev+03ff993.dirty");
});

test("undefined compile-time version falls back to the checked-in version (== package.json, per the release gate)", () => {
  // Compare against package.json, not RBOX_VERSION — RBOX_VERSION is computed
  // through the same helper, so asserting against it would be a tautology.
  expect(resolveRboxVersion(undefined)).toBe(pkg.version);
});
