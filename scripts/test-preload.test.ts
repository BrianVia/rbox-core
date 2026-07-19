import { expect, test } from "bun:test";
import { API_HARNESS_ERROR, targetsApiTests } from "./test-preload.js";

test("detects direct Bun runs of apps/api tests", () => {
  expect(targetsApiTests(["apps/api/test/worker.test.ts"])).toBeTrue();
  expect(targetsApiTests(["./apps/api/test"])).toBeTrue();
  expect(targetsApiTests(["scripts"])).toBeFalse();
  expect(API_HARNESS_ERROR).toBe("apps/api tests need the Workers harness — run: bun run test:api");
});
