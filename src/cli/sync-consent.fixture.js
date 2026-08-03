import { mock } from "bun:test";

const captures = [];

mock.module("./local-runtime.js", () => ({
  LocalRuntime: class {
    async run(operation, observer, present) {
      captures.push({ operation, hint: observer?.massDeleteHint });
      const cfg = { noDrift: true };
      if (operation.kind === "push") {
        await present?.({ kind: "push", committed: false, sequence: 1, caseCollisions: [] }, cfg);
      } else if (operation.kind === "sync") {
        await present?.({
          kind: "sync",
          mode: operation.mode,
          pulled: [],
          pushCommitted: false,
          pushedSequence: 1,
          caseCollisions: [],
        }, cfg);
      }
    }
  },
}));
mock.module("./spinner.js", () => ({
  spinner: () => ({ update() {}, slowNote() {}, succeed() {}, fail() {}, stop() {} }),
}));
mock.module("./scope/binding-scope.js", () => ({
  assertCommandAllowedOnScopedBinding: async () => {},
  resolveBindingScope: async () => ({ kind: "unscoped" }),
  assertBindingUsable: () => {},
}));

const { runPushCommand, runSyncCommand } = await import("./sync-cmd.js");
const originalLog = console.log;
console.log = () => {};
try {
  delete process.env.RBOX_ALLOW_MASS_DELETE;
  await runPushCommand("/tmp/rbox-sync-consent");
  process.env.RBOX_ALLOW_MASS_DELETE = "1";
  await runPushCommand("/tmp/rbox-sync-consent");
  delete process.env.RBOX_ALLOW_MASS_DELETE;
  await runPushCommand("/tmp/rbox-sync-consent", { allowMassDelete: true });

  await runSyncCommand("/tmp/rbox-sync-consent");
  process.env.RBOX_ALLOW_MASS_DELETE = "1";
  await runSyncCommand("/tmp/rbox-sync-consent");
  delete process.env.RBOX_ALLOW_MASS_DELETE;
  await runSyncCommand("/tmp/rbox-sync-consent", { allowMassDelete: true });
} finally {
  delete process.env.RBOX_ALLOW_MASS_DELETE;
  console.log = originalLog;
}

process.stdout.write(JSON.stringify(captures));
