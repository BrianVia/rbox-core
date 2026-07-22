import { expect, test } from "bun:test";
import { parseFlags, unknownFlagError } from "./flags.js";

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
  expect(parseFlags(["deferrals", "--brief"])).toEqual({ positional: ["deferrals"], flags: { brief: "true" } });
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

test("unknown flags are rejected against command and subcommand help", () => {
  expect(unknownFlagError("start", [], { pullonly: "true" })).toContain("--pullonly");
  expect(unknownFlagError("start", [], { pullonly: "true" })).toContain("rbox start --help");
  expect(unknownFlagError("start", [], { "pull-only": "true" })).toBeUndefined();
  expect(unknownFlagError("start", [], { "read-write": "true" })).toBeUndefined();
  expect(unknownFlagError("key", ["materialize"], { "key-file": "x" })).toBeUndefined();
  expect(unknownFlagError("git", ["deferrals"], { brief: "true" })).toBeUndefined();
  expect(unknownFlagError("git", ["deferrals"], { confirm: "x" })).toContain("--confirm");
});

test("global and real undocumented flags remain allowed", () => {
  expect(unknownFlagError("track", [], { "no-interactive": "true" })).toBeUndefined();
  expect(unknownFlagError("status", [], { json: "true" })).toBeUndefined();
});
