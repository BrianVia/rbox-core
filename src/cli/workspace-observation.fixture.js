import { mock } from "bun:test";

const ROOT = "/tmp/workspace-observation";
const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const CONFIG = {
  schema: "e2ee/v1",
  remoteWorkspaceId: "ws_observed",
  projectId: "root",
  deviceId: "dev_observed",
  rootPath: ROOT,
  remoteUrl: "https://api.test",
  token: "",
};
const owned = (overrides = {}) => ({
  ownership: "owned",
  running: true,
  pid: 42,
  bootId: "boot-observed",
  boundWorkspaceId: CONFIG.remoteWorkspaceId,
  stale: false,
  ownsRoot: true,
  ownsWorkspace: true,
  sidecarBinding: "workspace",
  ambient: { kind: "absent" },
  ambientTrust: "absent",
  ...overrides,
});

let current = owned();
let currentId = CONFIG.remoteWorkspaceId;
let rebindDuringSidecars = false;
let counts;
const reset = (daemon = owned()) => {
  current = daemon;
  currentId = CONFIG.remoteWorkspaceId;
  rebindDuringSidecars = false;
  counts = { config: 0, daemon: 0, activity: 0, state: 0, adopt: 0, log: 0, metrics: 0 };
};

mock.module("./config.js", () => ({
  loadConfig: async () => { counts.config++; return CONFIG; },
  loadRawState: async () => { counts.state++; return undefined; },
  repoRecordsForState: () => ({}),
  syncStreamId: () => "stream-observed",
}));
mock.module("./activity.js", () => ({
  loadActivity: async () => {
    counts.activity++;
    return { at: new Date(NOW).toISOString() };
  },
}));
mock.module("./adopt-journal.js", () => ({
  inspectAdoptFence: async () => { counts.adopt++; return { status: "none" }; },
}));
mock.module("./daemon/runtime-state.js", () => ({
  currentWorkspaceId: () => currentId,
}));
mock.module("./daemon/observation.js", () => ({
  observeDaemon: () => { counts.daemon++; return current; },
}));
mock.module("./daemon-control.js", () => ({
  readMergedDaemonLogTail: async () => {
    counts.log++;
    if (rebindDuringSidecars) {
      current = owned({
        ownership: "wrong-workspace",
        ownsRoot: false,
        ownsWorkspace: false,
        stale: true,
        sidecarBinding: "other-workspace",
      });
    }
    return "private bytes from the previous workspace";
  },
}));
mock.module("./metrics.js", () => ({
  loadMetrics: async () => {
    counts.metrics++;
    return { syncs: 9, commitConflicts409: 0, fileConflicts: 0, lockStarved: 0 };
  },
}));
mock.module("./scope/projection.js", () => ({
  scopeProjectionFor: async () => { throw new Error("scope must not load without state"); },
}));
mock.module("./status-view/git-projection.js", () => ({
  projectGitDeferralRepos: () => { throw new Error("deferrals must not project without state"); },
}));

const { observeWorkspace } = await import("./workspace-observation.js");

reset();
const ambient = await observeWorkspace(ROOT, { depth: "ambient", now: NOW });
const ambientResult = {
  depth: ambient.depth,
  hasDiagnosticAuthority: "readDaemonSidecars" in ambient,
  counts: { ...counts },
};

reset(owned({ ownership: "wrong-workspace", ownsRoot: false, ownsWorkspace: false, stale: true, ambientTrust: "binding-untrusted" }));
const unowned = await observeWorkspace(ROOT, { depth: "ambient", now: NOW });
const rejectedActivity = await unowned.readActivity();
const unownedResult = { activity: rejectedActivity, counts: { ...counts } };

// A daemon still in startup has no binding record yet; its own activity is not
// residue, so the observation must admit it.
reset(owned({ ownership: "unbound", ownsWorkspace: false, boundWorkspaceId: undefined }));
const starting = await observeWorkspace(ROOT, { depth: "ambient", now: NOW });
const startingActivity = await starting.readActivity();
const startingResult = { activity: startingActivity?.at, counts: { ...counts } };

reset();
const local = await observeWorkspace(ROOT, { depth: "local", now: NOW });
const localResult = {
  depth: local.depth,
  activity: local.activity?.at,
  adopt: local.adopt,
  deferrals: local.deferrals,
  hasDiagnosticAuthority: typeof local.readDaemonSidecars === "function",
  counts: { ...counts },
};

reset();
const rebound = await observeWorkspace(ROOT, { depth: "local", now: NOW });
current = owned({ ownership: "wrong-workspace", ownsRoot: false, ownsWorkspace: false, stale: true, sidecarBinding: "other-workspace" });
const reboundSidecars = await rebound.readDaemonSidecars();
const reboundResult = { sidecars: reboundSidecars, counts: { ...counts } };

// The workspace itself was re-bound between capture and read: the daemon
// records still describe the PREVIOUS workspace's daemon, so nothing it owns
// may be handed to a report about this one.
reset();
const identityRebound = await observeWorkspace(ROOT, { depth: "local", now: NOW });
currentId = "ws_rebound";
const identityResult = {
  sidecars: await identityRebound.readDaemonSidecars(),
  activity: await identityRebound.readActivity(),
  counts: { ...counts },
};

reset();
const racing = await observeWorkspace(ROOT, { depth: "local", now: NOW });
rebindDuringSidecars = true;
const racingSidecars = await racing.readDaemonSidecars();
const raceResult = { sidecars: racingSidecars, counts: { ...counts } };

process.stdout.write(JSON.stringify({ ambientResult, unownedResult, startingResult, localResult, reboundResult, identityResult, raceResult }));
