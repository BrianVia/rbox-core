import { describe, expect, test } from "bun:test";
import { defineFlow } from "./flow.js";

const machine = [{ name: "a", enrolled: false }];

describe("flow schema", () => {
  test("accepts each discriminated step shape, including bare rbox argv", () => {
    expect(() => defineFlow({
      name: "schema-smoke", status: "pass", machines: machine,
      steps: [
        { on: "a", exec: [] },
        { on: "a", guest: "true" },
        { on: "a", pollUntil: { exec: ["status"], pattern: /running/, timeout: 1 } },
        { on: "a", captureVar: { name: "VALUE", pattern: /(running)/ } },
        { on: "a", tui: "setup" },
        { on: "a", keys: ["Enter"] },
        { on: "a", typeVar: "VALUE" },
        { on: "a", waitFor: /ready/, timeout: 2 },
        { on: "a", assertScreen: [/ready/], assertNotScreen: [/broken/] },
      ],
    })).not.toThrow();
  });

  test.each([
    [{ name: "bad", status: "pass", machines: machine, steps: [{ exec: ["status"] }] }, "flow.steps[0].on"],
    [{ name: "bad", status: "pass", machines: machine, steps: [{ on: "a", exec: [], guest: "true" }] }, "exactly one step discriminator"],
    [{ name: "bad", status: "pass", machines: machine, steps: [{ on: "missing", exec: [] }] }, "unknown machine"],
    [{ name: "bad", status: "pass", machines: machine, steps: [{ on: "a", keys: ["Enter"] }] }, "requires a live TUI session"],
    [{ name: "bad", status: "pass", machines: machine, steps: [{ on: "a", pollUntil: { pattern: /x/ } }] }, "pollUntil.exec"],
    [{ name: "bad", status: "pass", machines: machine, steps: [{ on: "a", captureVar: { name: "X", pattern: /x/ } }] }, "requires a previous step"],
  ] as const)("names useful validation errors %#", (flow, message) => {
    expect(() => defineFlow(flow as never)).toThrow(message);
  });
});
