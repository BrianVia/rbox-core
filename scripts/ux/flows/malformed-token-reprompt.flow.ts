import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "malformed-token-reprompt",
  status: "pending-137",
  machines: [{ name: "a", enrolled: false }],
  steps: [
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /Are you new here,[\s\S]*or do you already have an rbox account\?/ },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /How do you want to authorize this machine\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Paste pairing token/ },
    { on: "a", keys: ["not-a-pairing-token", "Enter"] },
    { on: "a", waitFor: /Paste pairing token/ },
    { on: "a", assertScreen: [/malformed pairing token/i] },
    { on: "a", keys: ["still-not-a-pairing-token", "Enter"] },
    { on: "a", waitFor: /Paste pairing token/ },
  ],
});
