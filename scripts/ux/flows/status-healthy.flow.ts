import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "status-healthy",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", guest: "printf 'healthy fixture\\n' > README.md" },
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Which directory should rbox sync\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Workspace name \(Enter accepts,[\s\S]*for none\)/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /How should rbox handle gitignored files\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Keep this workspace syncing in the background\?/, timeout: 120 },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", pollUntil: { exec: ["status"], pattern: /background sync:\s+running/, timeout: 120 } },
    { on: "a", exec: ["status"], assertStdout: [/^workspace\s+/m], expectExit: 0 },
  ],
});
