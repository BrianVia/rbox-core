import { expect, test } from "bun:test";
import { API_HARNESS_ERROR, stateDrift, targetsApiTests } from "./test-preload.js";

test("detects direct Bun runs of apps/api tests", () => {
  expect(targetsApiTests(["apps/api/test/worker.test.ts"])).toBeTrue();
  expect(targetsApiTests(["./apps/api/test"])).toBeTrue();
  expect(targetsApiTests(["scripts"])).toBeFalse();
  expect(API_HARNESS_ERROR).toBe("apps/api tests need the Workers harness — run: bun run test:api");
});

test("shard-leak guard reports set, changed, cleared, and cwd drift — and stays quiet otherwise", () => {
  const before = { HOME: "/home/real", RBOX_HOME: "/tmp/a", RBOX_FILES_FIRST: "0" };
  expect(stateDrift(before, { ...before }, "/repo", "/repo")).toEqual([]);

  // The three shapes a leaking file actually produces (#660): a key it introduced,
  // one it overwrote, and one it deleted without putting back.
  expect(stateDrift(before, { HOME: "/home/real", RBOX_HOME: "/tmp/b", RBOX_BLOB_PACK: "0" }, "/repo", "/repo")).toEqual([
    '  RBOX_BLOB_PACK: undefined -> "0"',
    '  RBOX_FILES_FIRST: "0" -> undefined',
    '  RBOX_HOME: "/tmp/a" -> "/tmp/b"',
  ]);

  expect(stateDrift(before, { ...before }, "/repo", "/tmp/scratch")).toEqual(["  process.cwd(): /repo -> /tmp/scratch"]);
});
