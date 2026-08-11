import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "typo-no-phantom",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /Which folder do you want to sync\?/ },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /Which folder should rbox sync\?/ },
    { on: "a", assertScreen: [/Enter = this directory · type to filter · Tab completes/] },
    { on: "a", keys: ["typo-project"] },
    { on: "a", waitFor: /use "[^"]*\/typo-project"/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /(?:does not exist[\s\S]*create|create[\s\S]*directory)/i },
    { on: "a", keys: ["n", "Enter"] },
    { on: "a", waitFor: /Which folder should rbox sync\?/ },
    { on: "a", keys: ["another-typo"] },
    { on: "a", waitFor: /use "[^"]*\/another-typo"/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /(?:does not exist[\s\S]*create|create[\s\S]*directory)/i },
    {
      on: "a",
      guest: "bun /app/scripts/ux/fresh-machine.ts workspaces --host --run-id {{RUN_ID}} --name a",
      assertStdout: [/^count=0$/m],
    },
  ],
});
