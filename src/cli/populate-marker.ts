import path from "node:path";
import { daemonRuntimeDir } from "./rbox-paths.js";
import type { TransferPhase } from "./transfer-progress.js";

export const AMBIENT_STATUS_HEARTBEAT_MS = 5_000;
export const AMBIENT_STATUS_STALE_MS = AMBIENT_STATUS_HEARTBEAT_MS * 3;
export const POPULATE_STATUS_SCHEMA_VERSION = 1 as const;

export interface PopulateOperation {
  kind: "pull";
  phase: TransferPhase;
  filesDone: number;
  filesTotal: number;
  bytesDone?: number;
  bytesTotal?: number;
}

export interface PopulateStatusV1 {
  schemaVersion: typeof POPULATE_STATUS_SCHEMA_VERSION;
  kind: "initial-populate";
  workspaceId: string;
  projectId: string;
  stream: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  operation: PopulateOperation;
}

export const populateStatusPath = (root: string): string => path.join(daemonRuntimeDir(root), "populate.status.json");

export const PHASES = new Set<TransferPhase>(["scan", "gitcap", "encrypt", "upload", "download"]);
export const uint = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function parsePopulateStatus(raw: string): PopulateStatusV1 | undefined {
  try {
    const j = JSON.parse(raw) as Partial<PopulateStatusV1>;
    const op = j.operation as Partial<PopulateOperation> | undefined;
    if (
      j.schemaVersion !== POPULATE_STATUS_SCHEMA_VERSION ||
      j.kind !== "initial-populate" ||
      typeof j.workspaceId !== "string" ||
      typeof j.projectId !== "string" ||
      typeof j.stream !== "string" ||
      !uint(j.pid) ||
      typeof j.startedAt !== "string" ||
      Number.isNaN(Date.parse(j.startedAt)) ||
      typeof j.heartbeatAt !== "string" ||
      Number.isNaN(Date.parse(j.heartbeatAt)) ||
      !op ||
      op.kind !== "pull" ||
      !PHASES.has(op.phase as TransferPhase) ||
      !uint(op.filesDone) ||
      !uint(op.filesTotal) ||
      (op.bytesDone !== undefined && !uint(op.bytesDone)) ||
      (op.bytesTotal !== undefined && !uint(op.bytesTotal))
    ) {
      return undefined;
    }
    return {
      schemaVersion: POPULATE_STATUS_SCHEMA_VERSION,
      kind: "initial-populate",
      workspaceId: j.workspaceId,
      projectId: j.projectId,
      stream: j.stream,
      pid: j.pid,
      startedAt: j.startedAt,
      heartbeatAt: j.heartbeatAt,
      operation: {
        kind: "pull",
        phase: op.phase as TransferPhase,
        filesDone: op.filesDone,
        filesTotal: op.filesTotal,
        ...(op.bytesDone !== undefined ? { bytesDone: op.bytesDone } : {}),
        ...(op.bytesTotal !== undefined ? { bytesTotal: op.bytesTotal } : {}),
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Deliberate guard asymmetry: the prompt asks "is a populate running?" and
 * treats any fresh live marker for this stream as syncing. `rbox status` asks
 * "should local-change counts be hidden?" and additionally requires
 * lastSyncedSequence === 0 before suppressing counts. Different questions,
 * intentionally different gates.
 */
export function hasFreshPopulateHeartbeat(status: Pick<PopulateStatusV1, "heartbeatAt">, now = Date.now()): boolean {
  const age = now - Date.parse(status.heartbeatAt);
  return Number.isFinite(age) && age >= 0 && age <= AMBIENT_STATUS_STALE_MS;
}
