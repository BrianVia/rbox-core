import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "typo-no-phantom",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Which directory should rbox sync\?/ },
    { on: "a", keys: ["typo-project", "Enter"] },
    { on: "a", waitFor: /(?:does not exist[\s\S]*create|create[\s\S]*directory)/i },
    { on: "a", keys: ["n", "Enter"] },
    { on: "a", waitFor: /Which directory should rbox sync\?/ },
    { on: "a", keys: ["another-typo", "Enter"] },
    { on: "a", waitFor: /(?:does not exist[\s\S]*create|create[\s\S]*directory)/i },
    {
      on: "a",
      guest: "bun /app/scripts/ux/fresh-machine.ts workspaces --host --run-id {{RUN_ID}} --name a",
      assertStdout: [/^count=0$/m],
    },
  ],
});
