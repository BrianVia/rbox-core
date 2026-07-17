import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "declined-rebind-menu",
  status: "pending-137",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", guest: "mkdir -p existing" },
    { on: "a", exec: ["track", "existing", "--no-interactive"] },
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Which directory should rbox sync\?/ },
    { on: "a", keys: ["existing", "Enter"] },
    { on: "a", waitFor: /Create a brand-new workspace for it anyway\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /Pick an existing workspace to sync/ },
    { on: "a", assertScreen: [/never synced/] },
  ],
});
