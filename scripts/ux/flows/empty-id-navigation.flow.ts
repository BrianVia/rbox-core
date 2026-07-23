import { defineFlow } from "../flow.js";

// Post-137 (R3), an account with no workspaces never reaches manual id entry:
// choosing "Sync an existing workspace" reports the empty account and re-renders
// the menu instead of exiting (pre-137 this path ended the wizard). The
// blank-blank manual-entry navigation itself is pinned by setup-cmd unit tests;
// this flow guards the live empty-account short-circuit and wizard liveness.
export default defineFlow({
  name: "empty-id-navigation",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /no workspaces on this account yet/ },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Down"] },
    { on: "a", assertScreen: [/Create a new rbox workspace from a folder on this machine/, /Sync a workspace already in your rbox account/] },
  ],
});
