import { expect, test } from "bun:test";
import { FAST_SUITE, getScenario, scenarioNames } from "./index.js";

test("SP-2.5 authority scenarios are registered in the FAST suite", () => {
  expect(FAST_SUITE).toContain("sqlite-fresh-install");
  expect(FAST_SUITE).toContain("json-upgrade-path");
  expect(getScenario("sqlite-fresh-install")?.name).toBe("sqlite-fresh-install");
  expect(getScenario("json-upgrade-path")?.name).toBe("json-upgrade-path");
  expect(getScenario("dual-binary-state")?.supportsDualBinary).toBeTrue();
  expect(new Set(scenarioNames()).size).toBe(scenarioNames().length);
});
