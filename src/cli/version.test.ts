import { expect, test } from "bun:test";
import { RBOX_VERSION, resolveRboxVersion } from "./version.js";

test("defined compile-time version wins", () => {
  expect(resolveRboxVersion("0.9.1-dev+03ff993.dirty")).toBe("0.9.1-dev+03ff993.dirty");
});

test("undefined compile-time version falls back to checked-in version", () => {
  expect(resolveRboxVersion(undefined)).toBe(RBOX_VERSION);
});
