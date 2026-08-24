import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, type FileEntry, type IgnoreMatcher, type Manifest } from "../engine/index.js";
import { loadActivity, type DaemonActivity } from "./activity.js";
import type { SyncState, WorkspaceConfig } from "./config.js";
import type { StatusMode, StatusProbePort, StatusReadPort } from "./status-contract.js";
import { projectWorkspaceStatusDetail } from "./status-projection.js";
import { renderStatusBrief, renderStatusJson } from "./status-render.js";
import type { StatusRefreshReceipt } from "./status-maintenance.js";
import {
  preparePublishCandidate,
  type GitCapturePort,
  type LocalObservation,
} from "./sync/publish-candidate.js";

const NOW = Date.parse("2026-07-29T12:00:00Z");
const AT = new Date(NOW - 1_000).toISOString();

/** Two strands with different provenance: one visible only through a nested
 *  `.gitignore` (design 224 §1.1's real-world shape), one through the builtin list. */
const STRANDS = ["pkg/build-out/artifact.bin", "pkg/node_modules/x.js"];

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-strand-"));
  await fs.mkdir(path.join(root, "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, "pkg", ".gitignore"), "build-out/\n");
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const entry = (p: string): FileEntry => ({ path: p, sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 0, type: "file" });
const manifest = (files: FileEntry[]): Manifest => ({ generatedAt: AT, files });
const base = (): Manifest => manifest([...STRANDS.map(entry), entry("pkg/keep.txt")]);
/** Disk truth: the strands are gone (or pruned); only the real file scans. */
const scanned = (): Manifest => manifest([entry("pkg/keep.txt")]);

const workspaceMatcher = (): IgnoreMatcher => buildIgnoreMatcher(root, { respectGitignore: true });

function cfg(): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_strand",
    projectId: "root",
    deviceId: "dev_strand",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    encrypted: true,
    respectGitignore: true,
  } as WorkspaceConfig;
}

function state(): SyncState {
  return { stream: "stream_strand", lastSyncedSequence: 7, lastSyncedManifest: base(), repoRecords: {} } as unknown as SyncState;
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

function readPort<M extends StatusMode>(mode: M = "json" as M): StatusReadPort<M> {
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
        ownership: "stopped" as const,
        running: false,
        stale: false,
        ownsRoot: false,
        ownsWorkspace: false,
        sidecarBinding: "absent" as const,
        ambient: { kind: "absent" as const },
        ambientTrust: "absent" as const,
      },
      readActivity: async () => undefined,
    }),
    inspectResetJournal: async () => ({ status: "none" as const }),
    readState: async () => state(),
    readPathWarnings: async () => undefined,
    readTrashStats: async () => undefined,
    readLockingHealth: async () => ({ status: "ok" as const }),
    readPopulateStatus: async () => undefined,
    readRemoteSequence: async () => undefined,
    readCryptoPoolStatus: () => ({ state: "off" as const, workers: 0, jobsRun: 0, workerExecutions: 0 }),
    // The real matcher, built exactly as the computed branch builds it.
    buildMatcher: (_root, opts) => buildIgnoreMatcher(root, opts),
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

/** Minimal capture port: this test exercises the projection seam, not git capture. */
function capturePort(): GitCapturePort {
  return {
    async execute(plan) {
      return {
        planId: plan.planId,
        plan: {
          changed: false, authoredCfgHashByRepo: {}, captured: [], carried: [], supersededPending: [],
          protectedPending: [], deferred: [], captureDeferrals: {}, configDeferrals: {}, captureObserved: [],
          configObserved: [], skipped: [], removed: [],
        },
      };
    },
    notifyBusyDeferred() {},
    async observe() {
      return { kind: "no-change" as const, acceptedSequence: 7, observedRepos: [], deferralUpdates: {} };
    },
    reportCapturePlan() {},
    async carryBaseOnNoOp() {},
    logPublicationLine() {},
  } as unknown as GitCapturePort;
}

async function pushTimeStrandedCount(): Promise<number> {
  const observed: number[] = [];
  const local: LocalObservation = {
    manifest: scanned(),
    matcher: workspaceMatcher(),
    projected: false,
    caseCollisions: [],
    authority: "authoritative",
    async recordProjection({ strandedIgnored }) {
      observed.push(strandedIgnored);
    },
  };
  await preparePublishCandidate(
    { acceptedSequence: 7, appliedBase: base() },
    local,
    capturePort(),
    {
      purgeIgnored: false, repairing: false, syncGit: false, filesFirstEnabled: false,
      filesFirstAborted: false, streamMismatch: false, forceGitRecapture: new Set<string>(),
      allowMassDelete: true, now: () => new Date(NOW),
    },
  );
  expect(observed).toHaveLength(1);
  return observed[0]!;
}

test("both strands are stranded under the workspace matcher", () => {
  const matcher = workspaceMatcher();
  for (const strand of STRANDS) expect([strand, matcher.ignores(strand)]).toEqual([strand, true]);
  expect(matcher.ignores("pkg/keep.txt")).toBe(false);
});

test("the computed status branch and the push-time producer report the SAME stranded count", async () => {
  const projection = await projectWorkspaceStatusDetail(root, { mode: "json" }, readPort(), {
    refresh: async (_c, next) => refreshed(next),
  });
  if (projection.kind !== "detail") throw new Error("expected a detail projection");

  const pushTime = await pushTimeStrandedCount();

  expect(projection.strandedIgnored).toBe(STRANDS.length);
  expect(pushTime).toBe(STRANDS.length);
  expect(projection.strandedIgnored).toBe(pushTime);
});

test("the count is emitted top-level in JSON, outside the daemon-only `local` block", async () => {
  const projection = await projectWorkspaceStatusDetail(root, { mode: "json" }, readPort(), {
    refresh: async (_c, next) => refreshed(next),
  });
  if (projection.kind !== "detail") throw new Error("expected a detail projection");

  const json = renderStatusJson(projection as never);
  expect(json.strandedIgnored).toBe(STRANDS.length);
  expect(json.local).toBeUndefined(); // computed source ⇒ no `local` block at all
});

test("a plain `rbox status` shows the count as a human line naming the purge command", async () => {
  const projection = await projectWorkspaceStatusDetail(root, { mode: "brief" }, readPort("brief"), {
    refresh: async (_c, next) => refreshed(next),
  });
  if (projection.kind !== "detail") throw new Error("expected a detail projection");

  const lines = renderStatusBrief(projection as never).join("\n");
  expect(lines).toContain("2 files match your ignore rules but are still synced");
  expect(lines).toContain("rbox ignore --purge");
});

test("a daemon activity.json without the field still validates, and omits the key", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-strand-act-"));
  try {
    const local: DaemonActivity["local"] = {
      at: AT, stream: "s", baseSequence: 7, trackedFiles: 3, added: 0, changed: 0, deleted: 0,
      settled: true, sourceVersion: 1,
    };
    await fs.mkdir(path.join(d, ".rbox", "state"), { recursive: true });
    const write = (activity: DaemonActivity) => fs.writeFile(path.join(d, ".rbox", "state", "activity.json"), JSON.stringify(activity));

    await write({ at: AT, local });
    const without = await loadActivity(d);
    expect(without?.local).toBeDefined();
    expect("strandedIgnored" in without!.local!).toBe(false);

    await write({ at: AT, local: { ...local!, strandedIgnored: 12 } });
    expect((await loadActivity(d))?.local?.strandedIgnored).toBe(12);

    // A malformed value drops the whole `local` slot rather than being handed on.
    await write({ at: AT, local: { ...local!, strandedIgnored: -1 } });
    expect((await loadActivity(d))?.local).toBeUndefined();
  } finally {
    await fs.rm(d, { recursive: true, force: true });
  }
});
