import { describe, expect, test } from "bun:test";
import { createPatToken, isValidPatToken, patDisplayPrefix } from "./pat-token.js";

describe("PAT token format", () => {
  test("valid generated PATs verify and expose a safe display prefix", () => {
    const token = createPatToken(new Uint8Array(32).fill(7));
    expect(token.startsWith("rbox_pat_")).toBe(true);
    expect(isValidPatToken(token)).toBe(true);
    expect(patDisplayPrefix(token)).toMatch(/^rbox_pat_.+\.\.\.$/);
  });

  test("malformed and checksum-corrupted PATs are rejected", () => {
    const token = createPatToken(new Uint8Array(32).fill(8));
    const bad = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(isValidPatToken("rbox_pat_short")).toBe(false);
    expect(isValidPatToken(bad)).toBe(false);
  });
});
