import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "tilde-expansion",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", guest: "mkdir -p proj" },
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /Which folder do you want to sync\?/ },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /Which folder should rbox sync\?/ },
    { on: "a", assertScreen: [/Enter = this directory · type to filter · Tab completes/] },
    { on: "a", keys: ["~/pr", "Tab"] },
    { on: "a", waitFor: /Which folder should rbox sync\? ~\/proj\// },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Display name \(Enter accepts,[\s\S]*for none\)/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /How should rbox handle gitignored files\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Keep this folder syncing in the background\?/, timeout: 120 },
    {
      on: "a",
      guest: "test -d '/tmp/rbox-ux/{{RUN_ID}}/{{MACHINE}}/proj' && ! test -e '/tmp/rbox-ux/{{RUN_ID}}/{{MACHINE}}/~'",
    },
    {
      // status resolves the workspace from cwd, so the bound-root proof must run
      // from inside proj — the machine exec prefix pins cwd to HOME.
      on: "a",
      guest: "cd '/tmp/rbox-ux/{{RUN_ID}}/{{MACHINE}}/proj' && rbox status --verbose",
      assertStdout: [/^workspace\s+.*@\s+\/tmp\/rbox-ux\/[^/\s]+\/a\/proj(?:\s|$)/m],
    },
  ],
});
