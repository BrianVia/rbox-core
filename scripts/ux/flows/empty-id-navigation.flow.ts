import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "empty-id-navigation",
  status: "pending-137",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /Workspace id to sync/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /Workspace id to sync/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", assertScreen: [/Create a new workspace from a directory/, /Sync an existing workspace/] },
  ],
});
