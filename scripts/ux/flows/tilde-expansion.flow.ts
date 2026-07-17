import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "tilde-expansion",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", guest: "mkdir -p proj" },
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Which directory should rbox sync\?/ },
    { on: "a", keys: ["~/proj", "Enter"] },
    { on: "a", waitFor: /Workspace name \(Enter accepts,[\s\S]*for none\)/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /How should rbox handle gitignored files\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Keep this workspace syncing in the background\?/, timeout: 120 },
    {
      on: "a",
      guest: "test -d '/tmp/rbox-ux/{{RUN_ID}}/{{MACHINE}}/proj' && ! test -e '/tmp/rbox-ux/{{RUN_ID}}/{{MACHINE}}/~'",
    },
    {
      // status resolves the workspace from cwd, so the bound-root proof must run
      // from inside proj — the machine exec prefix pins cwd to HOME.
      on: "a",
      guest: "cd '/tmp/rbox-ux/{{RUN_ID}}/{{MACHINE}}/proj' && rbox status",
      assertStdout: [/^workspace\s+.*@\s+\/tmp\/rbox-ux\/[^/\s]+\/a\/proj(?:\s|$)/m],
    },
  ],
});
