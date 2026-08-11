import { mock } from "bun:test";

const ROOT = "/tmp/rbox-ignore-consent";
const captures = [];
const base = {
  generatedAt: "2026-07-29T00:00:00.000Z",
  files: [{ path: "ignored.txt", sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 0, type: "file" }],
};

mock.module("../engine/index.js", () => ({
  buildIgnoreMatcher: () => ({ ignores: () => true }),
  effectiveIgnoreRules: () => [],
  HashCache: { load: async () => ({ save: async () => {} }) },
  scanManifest: async () => ({ generatedAt: "2026-07-29T00:00:00.000Z", files: [] }),
}));
mock.module("./config.js", () => ({
  loadConfig: async () => ({}),
  loadState: async () => ({ lastSyncedManifest: base }),
  saveConfig: async () => {},
  syncStreamId: () => "stream",
}));
mock.module("./e2ee-client.js", () => ({
  buildAuthedRemote: async () => ({ cfg: {}, deps: {} }),
}));
mock.module("./prompt.js", () => ({ confirmDestructive: async () => true }));
mock.module("./sync.js", () => ({
  localFileObservationForScan: (complete) => complete,
  makeDeferErrnoReporter: () => ({ onErrno: () => {}, flush: () => {} }),
  pushManifest: async (_root, _cfg, _local, deps) => {
    captures.push({ allow: deps.allowMassDeletePush, hint: deps.massDeleteHint });
    return { committed: true, sequence: 1, caseCollisions: [] };
  },
}));
mock.module("./sync-recovery.js", () => ({ deferManifest: (local) => local }));
mock.module("./sync-mutex.js", () => ({
  withWorkspaceSyncMutex: async (_root, run) => run({ root: ROOT, incarnation: "fixture", released: false }),
}));
mock.module("./style.js", () => ({ style: { dim: (value) => value } }));
mock.module("./path-warnings.js", () => ({ savePathWarnings: async () => {} }));
mock.module("./sync-cmd.js", () => ({ summarizeCaseCollisions: () => {} }));
mock.module("./scope/binding-scope.js", () => ({ assertCommandAllowedOnScopedBinding: async () => {} }));
mock.module("./sync/policy.js", () => ({ assertNoUnevaluatedPurgeDeletes: () => {} }));
mock.module("./folder-authority.js", () => ({ ensureFolderAuthority: async () => ({ kind: "authoritative" }) }));
mock.module("./folder-inventory.js", () => ({
  observeFolderAdmission: async () => ({ kind: "admitted", generation: "fixture", policy: { respectGitignore: false } }),
}));
mock.module("./folder-config.js", () => ({ setFolderOptions: async () => {} }));

const { purgeIgnored } = await import("./ignore-cmd.js");
const originalLog = console.log;
console.log = () => {};
try {
  delete process.env.RBOX_ALLOW_MASS_DELETE;
  await purgeIgnored(ROOT, { yes: true });
  process.env.RBOX_ALLOW_MASS_DELETE = "1";
  await purgeIgnored(ROOT, { yes: true });
  delete process.env.RBOX_ALLOW_MASS_DELETE;
  await purgeIgnored(ROOT, { yes: true, allowMassDelete: true });
} finally {
  delete process.env.RBOX_ALLOW_MASS_DELETE;
  console.log = originalLog;
}

process.stdout.write(JSON.stringify(captures));
