import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher } from "./ignore.js";

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ign-"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("ignore matcher — .rbox hard exclusion (design 12 C8)", () => {
  test("`.rbox/` is excluded by default", () => {
    const m = buildIgnoreMatcher(root);
    expect(m.ignores(".rbox/")).toBe(true);
    expect(m.ignores(".rbox/state.json")).toBe(true);
    expect(m.ignores(".rbox/keys/ws1.key")).toBe(true);
  });

  test("a `!.rbox` negation in .rboxignore CANNOT re-include it", async () => {
    await fs.writeFile(path.join(root, ".rboxignore"), "!.rbox\n!.rbox/\n!.rbox/state.json\n");
    const m = buildIgnoreMatcher(root);
    expect(m.ignores(".rbox/state.json")).toBe(true); // still excluded — hard rule wins
    expect(m.ignores(".rbox")).toBe(true);
    await fs.rm(path.join(root, ".rboxignore"));
  });

  test("a `!.rbox` negation via the extra ruleset also cannot re-include it", () => {
    const m = buildIgnoreMatcher(root, ["!.rbox", "!.rbox/state.json"]);
    expect(m.ignores(".rbox/state.json")).toBe(true);
  });

  test("non-.rbox paths are unaffected (normal ignore still works)", () => {
    const m = buildIgnoreMatcher(root);
    expect(m.ignores("src/index.ts")).toBe(false);
    expect(m.ignores("node_modules/")).toBe(true); // a normal builtin
  });
});
