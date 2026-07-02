import { test, expect } from "bun:test";
import { workspaceFlags, authorizePath } from "./setup-cmd.js";

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

test("Step 2 → runInit flags: a create carries the prompted name to the server", () => {
  // Setup drives runInit with --no-interactive, so runInit's OWN name prompt never
  // fires — the name MUST ride the flags or it's silently dropped (the v0.5.6 bug:
  // the founder typed a name and the workspace was still created unnamed).
  const f = workspaceFlags({ kind: "new", root: "/code/app", name: "Conductor Workspaces" });
  expect(f).toMatchObject({ new: "true", name: "Conductor Workspaces", "no-interactive": "true" });
});

// The new "Sign in via browser" method (design 47) must land on the SAME device-code
// grant as "Approve a code" — a friendlier front door, not a new backend. Only a
// pairing token takes the enroll-inline path. Pinning this stops a future edit from
// silently wiring "browser" to pairing (which would demand a token it doesn't have).
test("authorize routing: browser and approve are both the device-code grant; only pair redeems a token", () => {
  expect(authorizePath("pair")).toBe("pair-token");
  expect(authorizePath("approve")).toBe("device-code");
  expect(authorizePath("browser")).toBe("device-code");
});
