import { defineFlow } from "../flow.js";

export default defineFlow({
  name: "status-healthy",
  status: "pass",
  machines: [{ name: "a", enrolled: true }],
  steps: [
    { on: "a", guest: "printf 'healthy fixture\\n' > README.md" },
    { on: "a", tui: "setup" },
    { on: "a", waitFor: /What do you want to track here\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Which directory should rbox sync\?/ },
    { on: "a", assertScreen: [/Enter = this directory · type to filter · Tab completes/, /use this directory/] },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Workspace name \(Enter accepts,[\s\S]*for none\)/ },
    // Name the workspace "a" explicitly: the harness workspace IS $HOME, so
    // accepting the default name would collapseHome() to "~", not "a".
    { on: "a", keys: ["a", "Enter"] },
    { on: "a", waitFor: /How should rbox handle gitignored files\?/ },
    { on: "a", keys: ["Enter"] },
    { on: "a", waitFor: /Keep this workspace syncing in the background\?/, timeout: 120 },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /Set up another machine now/, timeout: 120 },
    { on: "a", keys: ["Down", "Enter"] },
    { on: "a", waitFor: /To pair more devices later, run `rbox pair` on an already-paired machine\./ },
    { on: "a", pollUntil: { exec: ["status"], pattern: /^a · syncing normally$/m, timeout: 120 } },
    {
      on: "a",
      exec: ["status"],
      // Brief identity uses the cached account plan with no live fetch (design 153);
      // the bootstrap fixture caches no plan, so the honest render is "plan
      // unavailable" (--verbose live-fetches "solo"). Reflects the parked
      // identity-cache self-heal item, not a regression.
      assertStdout: [/^a · syncing normally$/m, /^Signed in(?: as .+)? · plan unavailable$/m],
      assertNotStdout: [
        /background sync:/,
        /locking:/,
        /git-sync:/,
        /sync metrics:/,
        /commit-409/,
        /\d+ syncs/,
        /\b(?:ws|dev|acct)_[A-Za-z0-9_-]+\b/,
        /^\s*device\s+/m,
        /files on disk/,
        /sequence\s+\d+/,
      ],
      expectExit: 0,
    },
  ],
});
