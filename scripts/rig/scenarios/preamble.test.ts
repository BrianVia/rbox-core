import { expect, test } from "bun:test";
import { GUEST } from "../lib/config.js";
import { rigLoginArgv } from "./preamble.js";

test("rig login argv pins scenario-specific device labels", () => {
  expect(rigLoginArgv("a", "onboard-smoke", true)).toEqual([
    GUEST.cliExecutable, "login", "--bootstrap", "$RIG_BOOT", "--label", "rig-a-onboard-smoke", "--remote", "$RBOX_API",
  ]);
  expect(rigLoginArgv("b", "chaos-restart")).toEqual([
    GUEST.cliExecutable, "login", "--label", "rig-b-chaos-restart", "--remote", "$RBOX_API",
  ]);
});
