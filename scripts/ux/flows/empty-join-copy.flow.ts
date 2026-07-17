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
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /Pick an existing workspace to sync/ },
    { on: "a", assertScreen: [/empty-join/, /never synced/] },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Which directory should rbox sync\?/ },
    { on: "a", keys: ["Enter"] },
    {
      on: "a",
      waitFor: /nothing was available to pull — this workspace had no prior snapshot/,
      timeout: 120,
    },
  ],
});
