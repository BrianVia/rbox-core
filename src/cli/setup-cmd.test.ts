import { test, expect } from "bun:test";
import {
  accountChoiceFor,
  authMethodFor,
  isYes,
  workspaceChoiceFor,
  workspaceFlags,
} from "./setup-cmd.js";

// The guided flow's STEP TRANSITIONS live in these pure input→intent mappers; the
// readline/no-echo I/O around them is a thin shell. We test the transitions.

test("Step 1 account choice: create vs existing, invalid reprompts", () => {
  expect(accountChoiceFor("1")).toBe("create");
  expect(accountChoiceFor("create")).toBe("create");
  expect(accountChoiceFor("2")).toBe("existing");
  expect(accountChoiceFor("Log in")).toBe("existing");
  expect(accountChoiceFor("9")).toBeNull();
  expect(accountChoiceFor("")).toBeNull();
});

test("Step 1 auth method: pairing token (enrolls) vs approve code (hard-stop path)", () => {
  expect(authMethodFor("p")).toBe("pair");
  expect(authMethodFor("paste")).toBe("pair");
  expect(authMethodFor("a")).toBe("approve");
  expect(authMethodFor("code")).toBe("approve");
  expect(authMethodFor("x")).toBeNull();
});

test("Step 2 workspace choice: new vs existing", () => {
  expect(workspaceChoiceFor("1")).toBe("new");
  expect(workspaceChoiceFor("2")).toBe("existing");
  expect(workspaceChoiceFor("track")).toBe("existing");
  expect(workspaceChoiceFor("")).toBeNull();
});

test("Step 2 → runInit flags: new workspace creates + pushes; both stay non-interactive", () => {
  const f = workspaceFlags({ kind: "new", root: "/code/app" });
  expect(f).toMatchObject({ new: "true", root: "/code/app", "no-interactive": "true" });
  expect(f.workspace).toBeUndefined();
});

test("Step 2 → runInit flags: joining an existing workspace passes its id, not --new", () => {
  const f = workspaceFlags({ kind: "join", root: "/code/app", workspace: "ws_abc" });
  expect(f).toMatchObject({ workspace: "ws_abc", root: "/code/app", "no-interactive": "true" });
  expect(f.new).toBeUndefined();
});

test("Step 3 [Y/n] / [y/N]: blank takes the default, explicit answers win", () => {
  expect(isYes("", true)).toBe(true); // [Y/n] default
  expect(isYes("", false)).toBe(false); // [y/N] default
  expect(isYes("n", true)).toBe(false);
  expect(isYes("yes", false)).toBe(true);
  expect(isYes("nope", true)).toBe(false); // anything non-yes is a no
});
