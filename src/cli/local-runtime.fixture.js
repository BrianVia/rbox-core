import { mock } from "bun:test";

const ROOT = "/tmp/rbox-local-runtime";
const mutex = { root: ROOT, incarnation: "fixture", released: false };
let trace = [];
let policy;
let failPull = false;
let admission = {
  kind: "admitted",
  generation: "catalog-1",
  policy: {
    syncGit: false,
    git: { incremental: false },
    respectGitignore: true,
    noDrift: true,
    trash: { days: 7, maxBytes: 99 },
  },
};
/** The exact function the fixture's observer supplies, so the remote builder can
 * prove the caller's sink reached it by identity rather than by category. */
const WARNING_SINK = () => {};
let authorityCalls = 0;
let admissionCalls = 0;

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

mock.module("./state-plane/authority-bootstrap.js", () => ({
  admitGenesisAuthority: async (root, heldMutex) => {
    if (root !== ROOT) throw new Error(`unexpected root: ${root}`);
    if (heldMutex !== mutex) throw new Error("genesis admission did not receive the held lease");
    trace.push("genesis:admitted");
    return { kind: "selected", authority: { kind: "sqlite-store", format: "authority-marker", authorityId: "fixture" } };
  },
  requireSelected: (result) => result.authority,
}));

mock.module("./e2ee-client.js", () => ({
  buildAuthedRemote: async (root, _now, warningSink) => {
    if (root !== ROOT || warningSink !== WARNING_SINK) throw new Error("observer wiring lost");
    trace.push("remote:built");
    return {
      cfg: {
        noDrift: false,
        encrypted: true,
        kek: Buffer.alloc(32, 7),
        remoteUrl: "https://credential.invalid",
        token: "runtime-token",
      },
      deps: {},
    };
  },
}));

mock.module("./folder-authority.js", () => ({
  ensureFolderAuthority: async () => {
    authorityCalls++;
    trace.push("authority:pinned");
    return { kind: "authoritative", revision: "catalog-1" };
  },
}));

mock.module("./folder-inventory.js", () => ({
  observeFolderAdmission: async () => {
    admissionCalls++;
    trace.push("admission:pinned");
    return admission;
  },
  applyFolderPolicy: (cfg, next) => ({
    ...cfg,
    syncGit: next.syncGit,
    git: { ...cfg.git, incremental: next.git.incremental },
    respectGitignore: next.respectGitignore,
    noDrift: next.noDrift,
    trash: { ...next.trash },
  }),
  runtimeRefusal: (refusal) => new Error(`refused:${refusal.kind}:${refusal.reason}`),
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

function captureCfg(cfg) {
  policy.cfg = {
    syncGit: cfg.syncGit,
    incremental: cfg.git?.incremental,
    respectGitignore: cfg.respectGitignore,
    noDrift: cfg.noDrift,
    trash: cfg.trash,
    encrypted: cfg.encrypted,
    kekByte: cfg.kek?.[0],
    remoteUrl: cfg.remoteUrl,
    token: cfg.token,
  };
}

mock.module("./sync/pull.js", () => ({
  pull: async (_root, cfg, deps) => {
    if (failPull) {
      trace.push("execute:pull:failed");
      throw new Error("pull failed");
    }
    captureCfg(cfg);
    capture("pull", deps);
    return [];
  },
}));

mock.module("./sync/push.js", () => ({
  push: async (_root, cfg, deps) => {
    captureCfg(cfg);
    capture("push", deps);
    return { sequence: 7, committed: true, caseCollisions: [] };
  },
}));

mock.module("./sync/sync.js", () => ({
  sync: async (_root, cfg, deps) => {
    captureCfg(cfg);
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
  warningSink: WARNING_SINK,
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
    if (cfg.noDrift !== true) throw new Error("completion context lost");
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
const failedTrace = trace;

trace = [];
failPull = false;
admission = { kind: "detached", reason: "run `rbox config add`" };
let refusal;
try {
  await runtime.run({ kind: "pull", massDelete: "guarded" }, observer);
} catch (error) {
  refusal = error instanceof Error ? error.message : String(error);
}

process.stdout.write(JSON.stringify({
  runs,
  failedTrace,
  refusalTrace: trace,
  refusal,
  authorityCalls,
  admissionCalls,
}));
