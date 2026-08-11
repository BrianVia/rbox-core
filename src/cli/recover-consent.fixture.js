import { mock } from "bun:test";

const captures = [];

const realEngine = await import("../engine/index.js");
mock.module("../engine/index.js", () => ({
  ...realEngine,
  ManifestChainError: class ManifestChainError extends Error {},
}));
const realConfig = await import("./config.js");
mock.module("./config.js", () => ({
  ...realConfig,
  findRoot: async () => undefined,
  loadConfig: async () => ({}),
}));
mock.module("./folder-authority.js", () => ({ ensureFolderAuthority: async () => ({ kind: "authoritative" }) }));
mock.module("./folder-inventory.js", () => ({
  observeFolderAdmission: async () => ({
    kind: "admitted",
    generation: "fixture",
    policy: { syncGit: false, git: { incremental: true }, respectGitignore: false, noDrift: false, trash: { days: 30, maxBytes: 2147483648 } },
  }),
  runtimeRefusal: (admission) => new Error(`rbox cannot run this folder (${admission.kind}): ${admission.reason}`),
  applyFolderPolicy: (cfg) => cfg,
}));
mock.module("./scope/binding-scope.js", () => ({ assertCommandAllowedOnScopedBinding: async () => {} }));
mock.module("./credentials.js", () => ({
  loadCredentials: async () => ({}),
  credentialsForStrictFlow: (loaded) => loaded,
}));
mock.module("./e2ee-keystore.js", () => ({ keystorePinStore: () => ({ load: async () => undefined }) }));
mock.module("./e2ee-client.js", () => ({ buildAuthedRemote: async () => ({}) }));
mock.module("./metrics.js", () => ({ beginReport: () => ({}), logDebugSummary: () => {} }));
mock.module("./prompt.js", () => ({ confirmDestructive: async () => true, promptConfirm: async () => true }));
mock.module("./remote.js", () => ({ NeedsRebaselineError: class NeedsRebaselineError extends Error {} }));
mock.module("./sync.js", () => ({ pull: async () => [], push: async () => ({ committed: false, sequence: 1 }) }));
mock.module("./sync-cmd.js", () => ({ postSyncNudge: async () => {}, summarize: () => {} }));
mock.module("./style.js", () => ({ style: { bold: String, cyan: String, dim: String, sym: { arrow: "->" } } }));
mock.module("./sync-mutex.js", () => ({
  withWorkspaceSyncMutex: async (_root, run) => run({ root: "/tmp/rbox-recover-consent", incarnation: "fixture", released: false }),
}));
mock.module("./chain-repair.js", () => ({ repairChain: async () => ({ kind: "declined" }) }));

const { recoverWorkspaceCmd } = await import("./recover-cmd.js");
const deps = {
  findRoot: async () => "/tmp/rbox-recover-consent",
  loadConfig: async () => ({ remoteWorkspaceId: "ws_fixture" }),
  loadCredentials: async () => ({ accountId: "acct_fixture" }),
  buildAuthedRemote: async () => ({
    cfg: { noDrift: true },
    deps: {},
    remote: { rebaselinePinToRetainedHead: async () => {} },
  }),
  pinStore: () => ({ load: async () => undefined }),
  pull: async (_root, _cfg, builtDeps) => {
    captures.push({
      allow: builtDeps.allowMassDelete,
      allowPush: builtDeps.allowMassDeletePush,
    });
    return [];
  },
  push: async () => ({ committed: false, sequence: 1 }),
  beginReport: () => ({}),
  summarize: () => {},
  postSyncNudge: async () => {},
  log: () => {},
};

try {
  delete process.env.RBOX_ALLOW_MASS_DELETE;
  await recoverWorkspaceCmd(undefined, { yes: true }, deps);
  process.env.RBOX_ALLOW_MASS_DELETE = "1";
  await recoverWorkspaceCmd(undefined, { yes: true }, deps);
  delete process.env.RBOX_ALLOW_MASS_DELETE;
  await recoverWorkspaceCmd(undefined, { yes: true, allowMassDelete: true }, deps);
} finally {
  delete process.env.RBOX_ALLOW_MASS_DELETE;
}

process.stdout.write(JSON.stringify(captures));
