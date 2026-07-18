import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "fresh-setup-to-handoff",
  status: "pass",
  machines: [{ name: "a", enrolled: false }],
  steps: [
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /Step\s+1\s+of\s+3[\s\S]*Account/ },
    {
      on: "a",
      assertScreen: [/Are you new here,[\s\S]*or do you already have an rbox account\?/, /Create a new account/, /Log into an existing account/],
    },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Press Enter to sign up in your browser/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Waiting for approval\s*\([\s\S]*expires in\s+\d+s[\s\S]*\)/, timeout: 60 },
    {
      on: "a",
      assertScreen: [
        /To authorize this device,[\s\S]*visit:/,
        /cli-login\?code=[A-Z0-9-]+/,
        /press \[c\] to copy the URL/,
        /expires in\s+\d+s/,
      ],
    },
  ],
});
