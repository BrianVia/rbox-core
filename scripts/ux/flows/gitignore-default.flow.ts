import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "gitignore-default",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    {
      on: "a",
      guest: "git init -q && printf 'node_modules/\\n.env\\ndist/\\n' > .gitignore && mkdir -p node_modules dist && printf 'fixture\\n' > node_modules/ignored.txt",
    },
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Which directory should rbox sync\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Workspace name \(Enter accepts,[\s\S]*for none\)/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /How should rbox handle gitignored files\?/ },
    { on: "a", assertScreen: [/Skip gitignored untracked files \(recommended\)/] },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Keep this workspace syncing in the background\?/, timeout: 120 },
    {
      on: "a",
      exec: ["ignore", "--list"],
      assertStdout: [
        /^respectGitignore:\s+on$/m,
        /^ignore rules \(precedence: builtin → \.gitignore → \.rboxignore\):$/m,
        /^\s+\[\.gitignore ACTIVE\]\s+node_modules\/$/m,
      ],
    },
  ],
});
