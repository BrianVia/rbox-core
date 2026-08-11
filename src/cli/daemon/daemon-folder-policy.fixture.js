import { mock } from "bun:test";

const ROOT = "/tmp/rbox-daemon-folder-policy";
const policy = {
  syncGit: false,
  git: { incremental: false },
  respectGitignore: true,
  noDrift: true,
  trash: { days: 0, maxBytes: 0 },
};
let scenario = "admitted";
let trace = [];
let remoteCalls = 0;

mock.module("../folder-authority.js", () => ({
  ensureFolderAuthority: async () => {
    trace.push("authority");
    if (scenario === "damaged") {
      throw new Error("rbox folder configuration is damaged: exact parse failure. Copy config.json somewhere safe, then run `rbox config regenerate`.");
    }
    return { kind: "authoritative", revision: "catalog-1" };
  },
}));

mock.module("../folder-inventory.js", () => ({
  observeFolderAdmission: async () => {
    trace.push("admission");
    return scenario === "detached"
      ? { kind: "detached", reason: "run `rbox config add`" }
      : { kind: "admitted", generation: "catalog-1", policy };
  },
  applyFolderPolicy: (cfg, next) => ({
    ...cfg,
    syncGit: next.syncGit,
    git: { ...cfg.git, incremental: next.git.incremental },
    respectGitignore: next.respectGitignore,
    noDrift: next.noDrift,
    trash: { ...next.trash },
  }),
  folderPolicyFields: (next) => next,
  runtimeRefusal: (refusal) => new Error(`refused:${refusal.kind}:${refusal.reason}`),
}));

mock.module("../e2ee-client.js", () => ({
  buildAuthedRemote: async () => {
    remoteCalls++;
    trace.push("remote");
    return {
      cfg: {
        remoteWorkspaceId: "ws",
        projectId: "root",
        deviceId: "dev",
        rootPath: ROOT,
        remoteUrl: "https://credential.invalid",
        token: "runtime-token",
        encrypted: true,
        kek: Buffer.alloc(32, 7),
      },
      deps: {},
      remote: { fixture: true },
    };
  },
}));

const { buildAdmittedDaemonRuntime } = await import("./daemon.js");
const admitted = await buildAdmittedDaemonRuntime(ROOT);
const admittedTrace = trace;

scenario = "detached";
trace = [];
const detached = await buildAdmittedDaemonRuntime(ROOT).catch((error) => error.message);
const detachedTrace = trace;

scenario = "damaged";
trace = [];
const damaged = await buildAdmittedDaemonRuntime(ROOT).catch((error) => error.message);

process.stdout.write(JSON.stringify({
  admittedTrace,
  detachedTrace,
  damagedTrace: trace,
  detached,
  damaged,
  remoteCalls,
  cfg: {
    syncGit: admitted.cfg.syncGit,
    incremental: admitted.cfg.git?.incremental,
    respectGitignore: admitted.cfg.respectGitignore,
    noDrift: admitted.cfg.noDrift,
    trash: admitted.cfg.trash,
    encrypted: admitted.cfg.encrypted,
    kekByte: admitted.cfg.kek?.[0],
    remoteUrl: admitted.cfg.remoteUrl,
    token: admitted.cfg.token,
  },
}));
