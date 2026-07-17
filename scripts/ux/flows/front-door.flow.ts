import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "front-door",
  status: "pass",
  machines: [{ name: "a", enrolled: false }],
  steps: [
    {
      on: "a",
      exec: [],
      assertStdout: [
        /^rbox — dev-aware sync/m,
        /^GETTING STARTED$/m,
        /^SYNCING$/m,
        /^Run `rbox <command> --help` for details on any command\.$/m,
      ],
      expectExit: 0,
    },
  ],
});
