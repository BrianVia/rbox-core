import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "front-door",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    {
      on: "a",
      exec: ["track", ".", "--no-interactive"],
      expectExit: 0,
    },
    { on: "a", tui: " " },
    { on: "a", waitFor: /What would you like to do\?/ },
    {
      on: "a",
      assertScreen: [
        /Sync now[\s\S]*Add another synced folder[\s\S]*Pair another device[\s\S]*View usage[\s\S]*View logs[\s\S]*Exit/,
      ],
      assertNotScreen: [/Pause syncing/, /Nothing, I'm good/, /Start syncing/],
    },
    { on: "a", keys: ["Down", "Down", "Down", "Down", "Down", "Enter"] },
  ],
});
