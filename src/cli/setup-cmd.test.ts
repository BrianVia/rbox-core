import { test, expect } from "bun:test";
import { workspaceFlags } from "./setup-cmd.js";

// The guided flow's menus are now arrow-key `@inquirer` `select`s (thin widgets we
// don't unit-test). The one pure step-transition left is `workspaceFlags` — the
// map from a Step-2 workspace decision to the exact `runInit` flags.

test("Step 2 → runInit flags: new workspace creates + pushes; both stay non-interactive", () => {
  const f = workspaceFlags({ kind: "new", root: "/code/app" });
  expect(f).toMatchObject({ new: "true", root: "/code/app", "no-interactive": "true" });
  expect(f.workspace).toBeUndefined();
});

test("Step 2 → runInit flags: joining an existing workspace passes its id, not --new", () => {
  const f = workspaceFlags({ kind: "join", root: "/code/app", workspace: "ws_abc" });
  expect(f).toMatchObject({ workspace: "ws_abc", root: "/code/app", "no-interactive": "true" });
  expect(f.new).toBeUndefined();
  expect(f.name).toBeUndefined(); // no picked name → status falls back to the id
});

test("Step 2 → runInit flags: a picked name rides along as a LOCAL cache label on join", () => {
  const f = workspaceFlags({ kind: "join", root: "/code/app", workspace: "ws_abc", name: "savvy-core" });
  expect(f).toMatchObject({ workspace: "ws_abc", name: "savvy-core", "no-interactive": "true" });
});

test("Step 2 → runInit flags: a name is NOT attached to a new-workspace create here", () => {
  // (create names are prompted inside runInit, not passed via workspaceFlags)
  const f = workspaceFlags({ kind: "new", root: "/code/app", name: "ignored" });
  expect(f.name).toBeUndefined();
  expect(f.new).toBe("true");
});
