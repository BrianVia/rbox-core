import fs from "node:fs";
import path from "node:path";
import { daemonPidPath, daemonStatusPath } from "./rbox-paths.js";
import type { DaemonActivity } from "./activity.js";
import type { TransferPhase } from "./transfer-progress.js";
import { syncStreamId, type RepoRecord, type WorkspaceConfig } from "./config.js";
import { projectGitDeferralRepos } from "./status-view.js";
import {
  AMBIENT_STATUS_STALE_MS,
  hasFreshPopulateHeartbeat,
  isProcessAlive,
  parsePopulateStatus,
  populateStatusPath,
} from "./populate-marker.js";

export { AMBIENT_STATUS_HEARTBEAT_MS, AMBIENT_STATUS_STALE_MS } from "./populate-marker.js";

export type AmbientDaemonState = "synced" | "syncing" | "attention" | "paused";
export type AmbientAttentionReason = "halt" | "out-of-storage" | "watcher-degraded" | "ownership-lost" | "unknown-error";
export type AmbientOperationKind = "pull" | "push";

export interface AmbientDaemonStatusV1 {
  schemaVersion: 1;
  state: AmbientDaemonState;
  heartbeatAt: string;
  sequence: number | null;
  lastSyncedAt: string | null;
  operation?: {
    kind: AmbientOperationKind;
    phase?: TransferPhase;
    filesDone?: number;
    filesTotal?: number;
    bytesDone?: number;
    bytesTotal?: number;
    currentPath?: string;
  };
  attentionReason?: AmbientAttentionReason;
  deferredRepos?: number;
  oldestDeferralAgeSeconds?: number | null;
}

export type PromptAttentionReason = "dead" | "halt" | "quota" | "watcher" | "owner" | "error";

export type PromptStatusVerdict =
  | { kind: "outside-workspace" }
  | {
      kind: "workspace";
      state: AmbientDaemonState;
      reason?: PromptAttentionReason;
      operation?: {
        kind: AmbientOperationKind;
        phase?: TransferPhase;
        filesDone?: number;
        filesTotal?: number;
        bytesDone?: number;
        bytesTotal?: number;
      };
      sequence: number | null;
      lastSyncedAt: string | null;
      heartbeatAt: string | null;
      stale: boolean;
      pidfilePresent: boolean;
      inferred: boolean;
    };

type PumpOp = "pull" | "push" | "fullScan" | "deepScan";
type PromptWorkspaceIdentity = Pick<WorkspaceConfig, "remoteUrl" | "remoteWorkspaceId" | "projectId">;

export interface AmbientStatusProjectionInput {
  activity: DaemonActivity;
  settled: boolean;
  now: number;
  sequence?: number;
  activePumpOp?: PumpOp;
  want?: Partial<Record<PumpOp, boolean>>;
  watcherDegraded?: boolean;
  ownershipLost?: boolean;
  currentPath?: string;
  repoRecords?: Record<string, RepoRecord>;
}

const STATES = new Set<AmbientDaemonState>(["synced", "syncing", "attention", "paused"]);
const REASONS = new Set<AmbientAttentionReason>(["halt", "out-of-storage", "watcher-degraded", "ownership-lost", "unknown-error"]);
const PHASES = new Set<TransferPhase>(["scan", "gitcap", "encrypt", "upload", "download"]);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function newestIso(a: string | undefined, b: string | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

function cleanLocalPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const clean = p.replace(/\p{Cc}/gu, "?");
  return clean.length > 0 ? clean : undefined;
}

function attentionReason(input: AmbientStatusProjectionInput): AmbientAttentionReason | undefined {
  if (input.ownershipLost) return "ownership-lost";
  if (input.activity.halt) return "halt";
  if (input.activity.outOfStorage) return "out-of-storage";
  if (input.watcherDegraded) return "watcher-degraded";
  return undefined;
}

function operationKind(input: AmbientStatusProjectionInput): AmbientOperationKind {
  if (input.activePumpOp === "pull") return "pull";
  if (input.activity.active?.phase === "download") return "pull";
  if (input.want?.pull && !input.want.push) return "pull";
  return "push";
}

function operationPhase(input: AmbientStatusProjectionInput): TransferPhase | undefined {
  if (input.activity.active?.phase) return input.activity.active.phase;
  if (input.activePumpOp === "fullScan" || input.activePumpOp === "deepScan") return "scan";
  return undefined;
}

function isSyncing(input: AmbientStatusProjectionInput): boolean {
  return (
    input.activePumpOp === "pull" ||
    input.activePumpOp === "push" ||
    input.activePumpOp === "fullScan" ||
    input.activePumpOp === "deepScan" ||
    input.activity.active !== undefined ||
    input.want?.pull === true ||
    input.want?.push === true ||
    !input.settled
  );
}

export function projectAmbientDaemonStatus(input: AmbientStatusProjectionInput): AmbientDaemonStatusV1 {
  const reason = attentionReason(input);
  const state: AmbientDaemonState = reason ? "attention" : isSyncing(input) ? "syncing" : "synced";
  const active = input.activity.active;
  const op =
    state === "syncing"
      ? stripUndefined({
          kind: operationKind(input),
          phase: operationPhase(input),
          filesDone: active ? active.done : undefined,
          filesTotal: active ? active.total : undefined,
          bytesDone: active?.bytesDone,
          bytesTotal: active?.bytesTotal,
          currentPath: cleanLocalPath(input.currentPath),
        })
      : undefined;
  const projectedDeferrals = projectGitDeferralRepos(Object.entries(input.repoRecords ?? {}).flatMap(([repo, record]) =>
    Object.values(record.deferrals ?? {}).flatMap((deferral) => deferral ? [{ repo, deferral }] : [])
  ));
  const deferredRepos = projectedDeferrals.length;
  const oldestDeferredSince = Date.parse(projectedDeferrals[0]?.oldestDeferredSince ?? "");
  const oldestDeferralAgeSeconds = deferredRepos === 0
    ? null
    : Number.isFinite(oldestDeferredSince)
      ? Math.max(0, Math.floor((input.now - oldestDeferredSince) / 1_000))
      : null;

  return stripUndefined({
    schemaVersion: 1,
    state,
    heartbeatAt: new Date(input.now).toISOString(),
    sequence: input.sequence ?? null,
    lastSyncedAt: newestIso(input.activity.lastPush?.at, input.activity.lastPull?.at),
    operation: op,
    attentionReason: state === "attention" ? reason ?? "unknown-error" : undefined,
    deferredRepos,
    oldestDeferralAgeSeconds,
  }) as AmbientDaemonStatusV1;
}

export function pausedAmbientDaemonStatus(
  now = Date.now(),
  previous?: Pick<AmbientDaemonStatusV1, "sequence" | "lastSyncedAt" | "deferredRepos" | "oldestDeferralAgeSeconds">,
): AmbientDaemonStatusV1 {
  return {
    schemaVersion: 1,
    state: "paused",
    heartbeatAt: new Date(now).toISOString(),
    sequence: previous?.sequence ?? null,
    lastSyncedAt: previous?.lastSyncedAt ?? null,
    ...(previous?.deferredRepos === undefined ? {} : { deferredRepos: previous.deferredRepos }),
    ...(previous?.oldestDeferralAgeSeconds === undefined ? {} : { oldestDeferralAgeSeconds: previous.oldestDeferralAgeSeconds }),
  };
}

export function findWorkspaceRootSync(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".rbox", "workspace.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function filePresent(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function parseStatus(raw: string): AmbientDaemonStatusV1 | undefined {
  try {
    const j = JSON.parse(raw) as Partial<AmbientDaemonStatusV1>;
    if (j.schemaVersion !== 1 || !STATES.has(j.state as AmbientDaemonState)) return undefined;
    if (typeof j.heartbeatAt !== "string" || Number.isNaN(Date.parse(j.heartbeatAt))) return undefined;
    if (!(j.sequence === null || uint(j.sequence))) return undefined;
    if (!(j.lastSyncedAt === null || typeof j.lastSyncedAt === "string")) return undefined;
    if (j.attentionReason !== undefined && !REASONS.has(j.attentionReason)) return undefined;
    if (j.deferredRepos !== undefined && !uint(j.deferredRepos)) return undefined;
    if (!(j.oldestDeferralAgeSeconds === undefined || j.oldestDeferralAgeSeconds === null || uint(j.oldestDeferralAgeSeconds))) return undefined;
    const out: AmbientDaemonStatusV1 = {
      schemaVersion: 1,
      state: j.state as AmbientDaemonState,
      heartbeatAt: j.heartbeatAt,
      sequence: j.sequence,
      lastSyncedAt: j.lastSyncedAt,
    };
    if (j.attentionReason !== undefined) out.attentionReason = j.attentionReason;
    if (j.deferredRepos !== undefined) out.deferredRepos = j.deferredRepos;
    if (j.oldestDeferralAgeSeconds !== undefined) out.oldestDeferralAgeSeconds = j.oldestDeferralAgeSeconds;
    const op = j.operation;
    if (op !== undefined) {
      if (op.kind !== "pull" && op.kind !== "push") return undefined;
      if (op.phase !== undefined && !PHASES.has(op.phase)) return undefined;
      if (op.filesDone !== undefined && !finite(op.filesDone)) return undefined;
      if (op.filesTotal !== undefined && !finite(op.filesTotal)) return undefined;
      if (op.bytesDone !== undefined && !uint(op.bytesDone)) return undefined;
      if (op.bytesTotal !== undefined && !uint(op.bytesTotal)) return undefined;
      if (op.currentPath !== undefined && typeof op.currentPath !== "string") return undefined;
      out.operation = stripUndefined({
        kind: op.kind,
        phase: op.phase,
        filesDone: op.filesDone,
        filesTotal: op.filesTotal,
        bytesDone: op.bytesDone,
        bytesTotal: op.bytesTotal,
        currentPath: op.currentPath,
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

function readStatusFile(root: string): { kind: "absent" } | { kind: "corrupt" } | { kind: "ok"; status: AmbientDaemonStatusV1 } {
  try {
    const status = parseStatus(fs.readFileSync(daemonStatusPath(root), "utf8"));
    return status ? { kind: "ok", status } : { kind: "corrupt" };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "corrupt" };
  }
}

function readWorkspaceIdentity(root: string): PromptWorkspaceIdentity | undefined {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, ".rbox", "workspace.json"), "utf8")) as Partial<PromptWorkspaceIdentity>;
    if (typeof cfg.remoteUrl !== "string" || typeof cfg.remoteWorkspaceId !== "string" || typeof cfg.projectId !== "string") {
      return undefined;
    }
    return {
      remoteUrl: cfg.remoteUrl,
      remoteWorkspaceId: cfg.remoteWorkspaceId,
      projectId: cfg.projectId,
    };
  } catch {
    return undefined;
  }
}

function readFreshPopulateVerdict(root: string, now: number): PromptStatusVerdict | undefined {
  let status = undefined as ReturnType<typeof parsePopulateStatus>;
  try {
    status = parsePopulateStatus(fs.readFileSync(populateStatusPath(root), "utf8"));
  } catch {
    return undefined;
  }
  if (!status) return undefined;
  const identity = readWorkspaceIdentity(root);
  if (!identity) return undefined;
  if (status.workspaceId !== identity.remoteWorkspaceId || status.projectId !== identity.projectId || status.stream !== syncStreamId(identity)) return undefined;
  if (!hasFreshPopulateHeartbeat(status, now)) return undefined;
  if (!isProcessAlive(status.pid)) return undefined;
  const op = status.operation;
  const pidfilePresent = filePresent(daemonPidPath(root));
  return {
    kind: "workspace",
    state: "syncing",
    operation: stripUndefined({
      kind: "pull" as const,
      phase: op.phase,
      filesDone: op.filesDone,
      filesTotal: op.filesTotal,
      bytesDone: op.bytesDone,
      bytesTotal: op.bytesTotal,
    }),
    sequence: null,
    lastSyncedAt: null,
    heartbeatAt: status.heartbeatAt,
    stale: false,
    pidfilePresent,
    inferred: true,
  };
}

function reasonOf(status: AmbientDaemonStatusV1): PromptAttentionReason | undefined {
  if (status.state !== "attention") return undefined;
  switch (status.attentionReason) {
    case "halt":
      return "halt";
    case "out-of-storage":
      return "quota";
    case "watcher-degraded":
      return "watcher";
    case "ownership-lost":
      return "owner";
    default:
      return "error";
  }
}

function verdictFromStatus(status: AmbientDaemonStatusV1, opts: { stale: boolean; pidfilePresent: boolean; inferred?: boolean }): PromptStatusVerdict {
  return {
    kind: "workspace",
    state: status.state,
    reason: reasonOf(status),
    operation: status.operation
      ? stripUndefined({
          kind: status.operation.kind,
          phase: status.operation.phase,
          filesDone: status.operation.filesDone,
          filesTotal: status.operation.filesTotal,
          bytesDone: status.operation.bytesDone,
          bytesTotal: status.operation.bytesTotal,
        })
      : undefined,
    sequence: status.sequence,
    lastSyncedAt: status.lastSyncedAt,
    heartbeatAt: status.heartbeatAt,
    stale: opts.stale,
    pidfilePresent: opts.pidfilePresent,
    inferred: opts.inferred === true,
  };
}

function deadVerdict(pidfilePresent: boolean): PromptStatusVerdict {
  return {
    kind: "workspace",
    state: "attention",
    reason: "dead",
    sequence: null,
    lastSyncedAt: null,
    heartbeatAt: null,
    stale: true,
    pidfilePresent,
    inferred: true,
  };
}

function pausedVerdict(pidfilePresent: boolean): PromptStatusVerdict {
  return {
    kind: "workspace",
    state: "paused",
    sequence: null,
    lastSyncedAt: null,
    heartbeatAt: null,
    stale: false,
    pidfilePresent,
    inferred: true,
  };
}

export function readPromptStatus(start = process.cwd(), now = Date.now()): PromptStatusVerdict {
  const root = findWorkspaceRootSync(start);
  if (!root) return { kind: "outside-workspace" };

  const populate = readFreshPopulateVerdict(root, now);
  if (populate) return populate;

  const pidfilePresent = filePresent(daemonPidPath(root));
  const read = readStatusFile(root);
  if (read.kind === "absent") return pidfilePresent ? deadVerdict(true) : pausedVerdict(false);
  if (read.kind === "corrupt") return deadVerdict(pidfilePresent);

  const status = read.status;
  const stale = now - Date.parse(status.heartbeatAt) > AMBIENT_STATUS_STALE_MS;
  if (!stale) return verdictFromStatus(status, { stale: false, pidfilePresent });
  if (pidfilePresent) return deadVerdict(true);
  if (status.state === "paused") return verdictFromStatus(status, { stale: true, pidfilePresent: false, inferred: true });
  return deadVerdict(false);
}

export function formatPromptStatus(verdict: PromptStatusVerdict): string {
  if (verdict.kind === "outside-workspace") return "";
  switch (verdict.state) {
    case "synced":
      return "✓";
    case "paused":
      return "○";
    case "attention":
      return `! ${verdict.reason ?? "error"}`;
    case "syncing": {
      const arrow = verdict.operation?.kind === "pull" ? "↓" : "↑";
      const done = verdict.operation?.filesDone;
      const total = verdict.operation?.filesTotal;
      if (finite(done) && finite(total) && total > 0) return `${arrow}${Math.max(0, Math.ceil(total - done))}`;
      return arrow;
    }
  }
}

export function promptStatusJson(verdict: PromptStatusVerdict): string {
  if (verdict.kind === "outside-workspace") return "";
  return JSON.stringify(verdict);
}
