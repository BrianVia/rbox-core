import { mock } from "bun:test";

const ROOT = "/tmp/rbox-local-runtime";
const mutex = { root: ROOT, incarnation: "fixture", released: false };
let trace = [];
let policy;
let failPull = false;

mock.module("./sync-mutex.js", () => ({
  withWorkspaceSyncMutex: async (root, run) => {
    if (root !== ROOT) throw new Error(`unexpected root: ${root}`);
    trace.push("lease:acquired");
    try {
      return await run(mutex);
    } finally {
      trace.push("lease:released");
    }
  },
}));

mock.module("./e2ee-client.js", () => ({
  buildAuthedRemote: async (root, _now, warningSink) => {
    if (root !== ROOT || typeof warningSink !== "function") throw new Error("observer wiring lost");
    trace.push("remote:built");
    return { cfg: { noDrift: false }, deps: {} };
  },
}));

mock.module("./metrics.js", () => ({
  beginReport: (kind) => {
    trace.push(`report:${kind}`);
    policy.report = kind;
    return { kind };
  },
}));

function capture(kind, deps) {
  if (deps.syncMutex !== mutex) throw new Error("operation did not receive held lease");
  if ("mutationBoundary" in deps) throw new Error("foreground runtime installed a shutdown gate");
  if (deps.report?.kind !== policy.report) throw new Error("report wiring lost");
  trace.push(`execute:${kind}`);
  policy.execute = kind;
  if (deps.allowMassDelete !== undefined) policy.allowPull = deps.allowMassDelete;
  if (deps.allowMassDeletePush !== undefined) policy.allowPush = deps.allowMassDeletePush;
  if (deps.massDeleteHint !== undefined) policy.hint = deps.massDeleteHint;
}

mock.module("./sync/pull.js", () => ({
  pull: async (_root, _cfg, deps) => {
    if (failPull) {
      trace.push("execute:pull:failed");
      throw new Error("pull failed");
    }
    capture("pull", deps);
    return [];
  },
}));

mock.module("./sync/push.js", () => ({
  push: async (_root, _cfg, deps) => {
    capture("push", deps);
    return { sequence: 7, committed: true, caseCollisions: [] };
  },
}));

mock.module("./sync/sync.js", () => ({
  sync: async (_root, _cfg, deps) => {
    capture("sync", deps);
    return {
      pulled: [],
      pushedSequence: 8,
      pushCommitted: false,
      initialRemoteSequence: 8,
      caseCollisions: [],
    };
  },
}));

const { LocalRuntime } = await import("./local-runtime.js");
const runtime = new LocalRuntime(ROOT);
const observer = {
  warningSink: () => {},
  onProgress: () => {},
  onGitLog: () => {},
  onGitProgress: () => {},
};
const operations = [
  ["pull:guarded", { kind: "pull", massDelete: "guarded" }],
  ["pull:allow", { kind: "pull", massDelete: "allow" }],
  ["push:guarded", { kind: "push", massDelete: "guarded" }],
  ["push:allow", { kind: "push", massDelete: "allow" }],
  ["sync:pull-only:guard-both", { kind: "sync", mode: "pull-only", massDelete: "guard-both" }],
  ["sync:pull-only:allow-push", { kind: "sync", mode: "pull-only", massDelete: "allow-push" }],
  ["sync:pull-only:allow-both", { kind: "sync", mode: "pull-only", massDelete: "allow-both" }],
  ["sync:pull-push:guard-both", { kind: "sync", mode: "pull-push", massDelete: "guard-both" }],
  ["sync:pull-push:allow-push", { kind: "sync", mode: "pull-push", massDelete: "allow-push" }],
  ["sync:pull-push:allow-both", { kind: "sync", mode: "pull-push", massDelete: "allow-both" }],
];

const runs = [];
for (const [label, operation] of operations) {
  trace = [];
  policy = { label };
  const runObserver = operation.kind === "sync"
    ? { ...observer, massDeleteHint: "SYNC_HINT" }
    : observer;
  await runtime.run(operation, runObserver, async (outcome, cfg) => {
    if (cfg.noDrift !== false) throw new Error("completion context lost");
    if (outcome.kind !== operation.kind) throw new Error("outcome kind mismatch");
    if (operation.kind === "sync" && outcome.mode !== operation.mode) throw new Error("outcome mode mismatch");
    trace.push("complete");
  });
  runs.push({ ...policy, trace });
}

trace = [];
failPull = true;
try {
  await runtime.run({ kind: "pull", massDelete: "guarded" }, observer);
} catch (error) {
  if (!(error instanceof Error) || error.message !== "pull failed") throw error;
}

process.stdout.write(JSON.stringify({ runs, failedTrace: trace }));
