import { defineFlow } from "../flow.js";

// Post-137 (R3), an account with no synced folders never reaches manual id entry:
// choosing "Sync a folder from another machine" reports the empty account and re-renders
// the menu instead of exiting (pre-137 this path ended the wizard). The
// blank-blank manual-entry navigation itself is pinned by setup-cmd unit tests;
// this flow guards the live empty-account short-circuit and wizard liveness.
export default defineFlow({
  name: "empty-id-navigation",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /Which folder do you want to sync\?/ },
    { on: "a", keys: ["Down", "Down", "Enter"] },
    { on: "a", waitFor: /no synced folders on this account yet/ },
    { on: "a", waitFor: /Which folder do you want to sync\?/ },
    { on: "a", keys: ["Down"] },
    { on: "a", assertScreen: [/Sync ~\/rbox \(recommended\)/, /Sync another folder on this machine/, /Sync a folder from another machine/] },
  ],
});
