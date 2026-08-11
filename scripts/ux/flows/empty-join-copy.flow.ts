import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "empty-join-copy",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    {
      on: "a",
      guest: "bun /app/scripts/ux/fresh-machine.ts workspaces-create --host --run-id {{RUN_ID}} --name a --label empty-join",
      assertStdout: [/^workspaceId=ws_[A-Za-z0-9_-]+$/m],
    },
    { on: "a", captureVar: { name: "WORKSPACE", pattern: /^workspaceId=(ws_[A-Za-z0-9_-]+)$/m } },
    { on: "a", guest: "mkdir -p node_modules" },
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /Which folder do you want to sync\?/ },
    { on: "a", keys: ["Down", "Down", "Enter"] },
    { on: "a", waitFor: /Pick a folder to sync from another machine/ },
    { on: "a", assertScreen: [/empty-join/, /never synced/] },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Which folder should rbox sync\?/ },
    { on: "a", assertScreen: [/Enter = this directory · type to filter · Tab completes/] },
    { on: "a", keys: ["node_modules"] },
    { on: "a", waitFor: /use "[^"]*\/node_modules"/ },
    { on: "a", keys: ["Enter"] },
    {
      on: "a",
      waitFor: /nothing was available to pull — this workspace had no prior snapshot/,
      timeout: 120,
    },
  ],
});
