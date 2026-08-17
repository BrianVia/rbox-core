import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, type FileEntry, type Manifest } from "../engine/index.js";
import { loadActivity, type DaemonActivity } from "./activity.js";
import type { SyncState, WorkspaceConfig } from "./config.js";
import type { StatusMode, StatusProbePort, StatusReadPort } from "./status-contract.js";
import { projectWorkspaceStatusDetail } from "./status-projection.js";
import { renderStatusBrief, renderStatusJson } from "./status-render.js";
import type { StatusRefreshReceipt } from "./status-maintenance.js";

const NOW = Date.parse("2026-08-16T12:00:00Z");
const AT = new Date(NOW - 1_000).toISOString();
const TS = "20260816041610";

/** On disk: one real file and one rbox mint. */
const ON_DISK_COPY = `pkg/notes.dev_x.${TS}.conflict.md`;
/** In the BASE only, and matcher-ignored — `projectLocalManifest` carries it forward,
 *  which is exactly why the count reads the RAW scan instead of the post-carry manifest. */
const CARRIED_COPY = `pkg/node_modules/dep.dev_x.${TS}.conflict.js`;

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-conflict-copies-"));
  await fs.mkdir(path.join(root, "pkg"), { recursive: true });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const entry = (p: string): FileEntry => ({ path: p, sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 0, type: "file" });
const manifest = (files: FileEntry[]): Manifest => ({ generatedAt: AT, files });
const base = (): Manifest => manifest([entry("pkg/keep.txt"), entry(ON_DISK_COPY), entry(CARRIED_COPY)]);
const scanned = (): Manifest => manifest([entry("pkg/keep.txt"), entry(ON_DISK_COPY)]);

function cfg(): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_copies",
    projectId: "root",
    deviceId: "dev_copies",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    encrypted: true,
    respectGitignore: true,
  } as WorkspaceConfig;
}

function state(): SyncState {
  return { stream: "stream_copies", lastSyncedSequence: 7, lastSyncedManifest: base(), repoRecords: {} };
}

function probePort(mode: StatusMode): StatusProbePort {
  if (mode === "brief") {
    return {
      mode,
      readBriefAccount: async () => ({ state: "signed-out" as const }),
      readUpdateState: async () => undefined,
    } as StatusProbePort;
  }
  return { mode: "json", readAccountUsage: async () => ({ plan: null, usedBytes: null, capBytes: null }) } as StatusProbePort;
}

/** A live PULL-ONLY daemon: it has never pushed, so `strandedIgnored` — whose value
 *  rides the push lane — is absent, while `conflictCopies` is not. */
const pullOnlyLocal = (conflictCopies: number): NonNullable<DaemonActivity["local"]> => ({
  at: AT,
  stream: "stream_copies",
  baseSequence: 7,
  trackedFiles: 2,
  added: 0,
  changed: 0,
  deleted: 0,
  settled: true,
  conflictCopies,
  sourceVersion: 1,
});

function readPort<M extends StatusMode>(mode: M = "json" as M, activity?: DaemonActivity): StatusReadPort<M> {
  const live = activity !== undefined;
  return {
    mode,
    now: () => NOW,
    readCredentials: async () => ({ state: "absent" as const }),
    readPendingGenesis: async () => false,
    readWorkspaceObservation: async () => ({
      depth: "ambient" as const,
      root,
      observedAt: NOW,
      config: cfg(),
      daemon: {
        ownership: live ? ("owned" as const) : ("stopped" as const),
        running: live,
        stale: false,
        ownsRoot: live,
        ownsWorkspace: live,
        bootId: live ? "boot_copies" : undefined,
        sidecarBinding: "absent" as const,
        ambient: { kind: "absent" as const },
        ambientTrust: "absent" as const,
      },
      readActivity: async () => activity,
    }),
    inspectResetJournal: async () => ({ status: "none" as const }),
    readState: async () => state(),
    readPathWarnings: async () => undefined,
    readTrashStats: async () => undefined,
    readLockingHealth: async () => ({ status: "ok" as const }),
    readPopulateStatus: async () => undefined,
    readRemoteSequence: async () => undefined,
    readCryptoPoolStatus: () => ({ state: "off" as const, workers: 0, jobsRun: 0, workerExecutions: 0 }),
    buildMatcher: (_root, opts) => buildIgnoreMatcher(root, { respectGitignore: opts?.respectGitignore === true }),
    loadHashCache: async () => ({ prune: () => {}, save: async () => {} }) as never,
    scanManifest: (async () => scanned()) as StatusReadPort<M>["scanManifest"],
    gitDivergenceFastRepoSource: async () => [],
    gitDivergenceCount: (async () => 0) as StatusReadPort<M>["gitDivergenceCount"],
    readConflictSnapshotStatus: async () => ({ total: 0, prunable: 0 }),
    readCheckoutTransactionCapability: async () => ({}) as never,
    probes: probePort(mode) as StatusReadPort<M>["probes"],
  } as StatusReadPort<M>;
}

const refreshed = (next: SyncState): StatusRefreshReceipt => ({
  kind: "refreshed",
  root,
  state: next,
  displayDetails: new Map(),
  changed: false,
  accepted: false,
  recoveredLocks: 0,
  commonDirsInspected: 0,
});

async function project<M extends StatusMode>(mode: M, activity?: DaemonActivity) {
  const projection = await projectWorkspaceStatusDetail(root, { mode }, readPort(mode, activity), {
    refresh: async (_c, next) => refreshed(next),
  });
  if (projection.kind !== "detail") throw new Error("expected a detail projection");
  return projection;
}

test("the computed branch counts the RAW scan, never the base-carried manifest", async () => {
  // The post-carry manifest would report 2: `projectLocalManifest` carries the
  // matcher-ignored BASE copy forward even though it is not on this disk.
  expect(await project("json").then((p) => p.conflictCopies)).toBe(1);
});

test("a live PULL-ONLY daemon still reports the count — it never rode the push lane", async () => {
  const projection = await project("json", { at: AT, local: pullOnlyLocal(4), ws: { connected: true, at: AT, caughtUp: true, bootId: "boot_copies", pid: 1 } });
  expect(projection.conflictCopies).toBe(4);
  expect(projection.strandedIgnored).toBeUndefined();
  expect(projection.counts.source).toBe("daemon");
});

test("the count is emitted top-level in JSON, outside the daemon-only `local` block", async () => {
  const projection = await project("json");
  const json = renderStatusJson(projection as never);
  expect(json.conflictCopies).toBe(1);
  expect(json.local).toBeUndefined();
});

test("a plain `rbox status` names conflict COPIES, never the conflict-snapshot ref namespace", async () => {
  const projection = await project("brief");
  const lines = renderStatusBrief(projection as never).join("\n");
  expect(lines).toContain("1 conflict copy rbox saved is still here");
  expect(lines).not.toContain("conflict snapshots");
});

test("a v1 daemon that omits the field validates, and a malformed value drops the slot", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-copies-act-"));
  try {
    const local = pullOnlyLocal(3);
    const write = (activity: DaemonActivity) => fs.writeFile(path.join(d, ".rbox", "state", "activity.json"), JSON.stringify(activity));
    await fs.mkdir(path.join(d, ".rbox", "state"), { recursive: true });

    const { conflictCopies: _drop, ...without } = local;
    await write({ at: AT, local: without });
    expect("conflictCopies" in (await loadActivity(d))!.local!).toBe(false);

    await write({ at: AT, local });
    expect((await loadActivity(d))?.local?.conflictCopies).toBe(3);

    await write({ at: AT, local: { ...local, conflictCopies: -1 } });
    expect((await loadActivity(d))?.local).toBeUndefined();
  } finally {
    await fs.rm(d, { recursive: true, force: true });
  }
});
