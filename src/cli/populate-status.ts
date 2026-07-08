import fs from "node:fs/promises";
import fsSync from "node:fs";
import { writeFileAtomic } from "../engine/fsutil.js";
import { renderShellLine, saveShellLine, type DaemonActivity } from "./activity.js";
import { daemonRuntimeDir } from "./rbox-paths.js";
import { syncStreamId, type WorkspaceConfig } from "./config.js";
import type { TransferPhase, TransferProgressBytes } from "./transfer-progress.js";
import {
  AMBIENT_STATUS_HEARTBEAT_MS,
  hasFreshPopulateHeartbeat,
  isProcessAlive,
  parsePopulateStatus,
  populateStatusPath,
  type PopulateOperation,
  type PopulateStatusV1,
} from "./populate-marker.js";

export { AMBIENT_STATUS_HEARTBEAT_MS, AMBIENT_STATUS_STALE_MS, populateStatusPath, type PopulateOperation, type PopulateStatusV1 } from "./populate-marker.js";

export async function readFreshPopulateStatus(
  root: string,
  cfg: Pick<WorkspaceConfig, "remoteUrl" | "remoteWorkspaceId" | "projectId">,
  now = Date.now(),
  alive: (pid: number) => boolean = isProcessAlive
): Promise<PopulateStatusV1 | undefined> {
  let status: PopulateStatusV1 | undefined;
  try {
    status = parsePopulateStatus(await fs.readFile(populateStatusPath(root), "utf8"));
  } catch {
    return undefined;
  }
  if (!status) return undefined;
  if (status.workspaceId !== cfg.remoteWorkspaceId || status.projectId !== cfg.projectId || status.stream !== syncStreamId(cfg)) return undefined;
  if (!hasFreshPopulateHeartbeat(status, now)) return undefined;
  if (!alive(status.pid)) return undefined;
  return status;
}

async function writePopulateStatus(root: string, status: PopulateStatusV1, cfg: WorkspaceConfig): Promise<void> {
  try {
    await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
    await writeFileAtomic(populateStatusPath(root), `${JSON.stringify(status, null, 2)}\n`);
  } catch {
    return;
  }

  // Also refresh the shell-line sidecar that powers prompt progress.
  const activity: DaemonActivity = {
    at: status.heartbeatAt,
    active: {
      at: status.heartbeatAt,
      phase: status.operation.phase,
      done: status.operation.filesDone,
      total: status.operation.filesTotal,
      ...(status.operation.bytesDone !== undefined ? { bytesDone: status.operation.bytesDone } : {}),
      ...(status.operation.bytesTotal !== undefined ? { bytesTotal: status.operation.bytesTotal } : {}),
    },
  };
  await saveShellLine(root, renderShellLine(activity, { settled: false, sequence: undefined, name: cfg.name ?? cfg.remoteWorkspaceId, now: Date.parse(status.heartbeatAt) }));
}

export async function removePopulateStatus(root: string): Promise<void> {
  await fs.rm(populateStatusPath(root), { force: true }).catch(() => {});
}

export function createPopulateStatusWriter(root: string, cfg: WorkspaceConfig, now: () => number = Date.now): {
  start: () => Promise<void>;
  update: (done: number, total: number, phase: TransferPhase, bytes?: TransferProgressBytes) => Promise<void>;
  stop: () => Promise<void>;
} {
  const startedAt = new Date(now()).toISOString();
  let lastWriteMs = 0;
  let last: PopulateOperation = { kind: "pull", phase: "scan", filesDone: 0, filesTotal: 0 };
  let chain = Promise.resolve();

  const enqueueAt = (t: number, operation: PopulateOperation) => {
    lastWriteMs = t;
    last = operation;
    const status: PopulateStatusV1 = {
      schemaVersion: 1,
      kind: "initial-populate",
      workspaceId: cfg.remoteWorkspaceId,
      projectId: cfg.projectId,
      stream: syncStreamId(cfg),
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date(t).toISOString(),
      operation,
    };
    chain = chain.then(() => writePopulateStatus(root, status, cfg)).catch(() => {});
  };

  return {
    start: async () => {
      enqueueAt(now(), last);
      await chain;
    },
    update: async (done, total, phase, bytes) => {
      const t = now();
      if (t - lastWriteMs < AMBIENT_STATUS_HEARTBEAT_MS) {
        await chain;
        return;
      }
      enqueueAt(t, {
        kind: "pull",
        phase,
        filesDone: Math.max(0, done),
        filesTotal: Math.max(0, total),
        ...(bytes?.bytesDone !== undefined ? { bytesDone: bytes.bytesDone } : {}),
        ...(bytes?.bytesTotal !== undefined ? { bytesTotal: bytes.bytesTotal } : {}),
      });
      await chain;
    },
    stop: async () => {
      await chain;
      await removePopulateStatus(root);
    },
  };
}

export function populateStatusExistsForTests(root: string): boolean {
  return fsSync.existsSync(populateStatusPath(root));
}
