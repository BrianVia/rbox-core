import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "pairing-second-device",
  status: "pass",
  machines: [
    { name: "a", enrolled: true },
    { name: "b", enrolled: false },
  ],
  steps: [
    {
      on: "a",
      exec: ["pair"],
      assertStdout: [/Pairing command \(valid ~10 min, single use/, /rbox connect rbox-pair_/, /Run the command above on the new machine/],
    },
    { on: "a", captureVar: { name: "TOKEN", pattern: /(rbox-pair_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/ } },
    { on: "b", tui: "setup" },
    { on: "b", waitFor: /Are you new here,[\s\S]*or do you already have an rbox account\?/ },
    { on: "b", keys: ["Down", "Enter"] },
    { on: "b", waitFor: /How do you want to authorize this machine\?/ },
    { on: "b", keys: ["Down", "Enter"] },
    { on: "b", waitFor: /Paste pairing token/ },
    { on: "b", typeVar: "TOKEN" },
    { on: "b", keys: ["Enter"] },
    { on: "b", waitFor: /encryption enrolled/, timeout: 60 },
    { on: "b", waitFor: /What do you want to track here\?/, timeout: 60 },
    { on: "b", assertScreen: [/Create a new rbox workspace from a folder on this machine/, /Sync a workspace already in your rbox account/] },
  ],
});
