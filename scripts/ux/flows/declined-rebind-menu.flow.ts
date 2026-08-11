import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "declined-rebind-menu",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", guest: "mkdir -p existing" },
    { on: "a", exec: ["track", "existing", "--no-interactive"] },
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /Which folder do you want to sync\?/ },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /Which folder should rbox sync\?/ },
    { on: "a", assertScreen: [/Enter = this directory · type to filter · Tab completes/] },
    { on: "a", keys: ["existing"] },
    { on: "a", waitFor: /use "[^"]*\/existing"/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Start it as a brand-new synced folder anyway\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Which folder do you want to sync\?/ },
    { on: "a", keys: ["Down", "Down", "Enter"] },
    { on: "a", waitFor: /Pick a folder to sync from another machine/ },
    { on: "a", assertScreen: [/never synced/] },
  ],
});
