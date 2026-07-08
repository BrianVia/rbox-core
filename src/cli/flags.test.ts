import { expect, test } from "bun:test";
import { parseFlags } from "./flags.js";

test("--json is a boolean long flag before or after a status path", () => {
  expect(parseFlags(["--json", "."])).toEqual({ positional: ["."], flags: { json: "true" } });
  expect(parseFlags([".", "--json"])).toEqual({ positional: ["."], flags: { json: "true" } });
});

test("--json is a boolean long flag before or after a device subcommand", () => {
  expect(parseFlags(["--json", "list"])).toEqual({ positional: ["list"], flags: { json: "true" } });
  expect(parseFlags(["list", "--json"])).toEqual({ positional: ["list"], flags: { json: "true" } });
});

test("boolean long flags do not consume following positionals", () => {
  expect(parseFlags(["--follow", "."])).toEqual({ positional: ["."], flags: { follow: "true" } });
  expect(parseFlags(["--yes", "genesis"])).toEqual({ positional: ["genesis"], flags: { yes: "true" } });
  expect(parseFlags(["--annual", "solo"])).toEqual({ positional: ["solo"], flags: { annual: "true" } });
});

test("known value long flags still consume values", () => {
  expect(parseFlags(["--limit", "25", "--path", "."])).toEqual({ positional: [], flags: { limit: "25", path: "." } });
});

test("ignore respect-gitignore consumes on/off value", () => {
  expect(parseFlags(["--respect-gitignore", "on", "--path", "."])).toEqual({
    positional: [],
    flags: { "respect-gitignore": "on", path: "." },
  });
});
