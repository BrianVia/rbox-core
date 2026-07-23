import fs from "node:fs";
import path from "node:path";
import { daemonPidPath, daemonStatusPath } from "../rbox-paths.js";
import { isSafetyHaltReason, type DaemonActivity } from "../activity.js";
import type { TransferPhase } from "../transfer-progress.js";
import type { MutationPhase } from "../../engine/mutation-gate.js";
import { syncStreamId, type RepoRecord, type WorkspaceConfig } from "../config.js";
import {
  gitDeferralReasonPresentation,
  isKnownGitDeferralReason,
  projectGitDeferralRepos,
  type GitDeferralRemediationClass,
} from "../status-view.js";
import { parseSemver } from "../semver.js";
import { RBOX_VERSION } from "../version.js";
import {
  AMBIENT_STATUS_STALE_MS,
  hasFreshPopulateHeartbeat,
  isProcessAlive,
  parsePopulateStatus,
  populateStatusPath,
} from "../populate-marker.js";

export { AMBIENT_STATUS_HEARTBEAT_MS, AMBIENT_STATUS_STALE_MS } from "../populate-marker.js";

export type AmbientDaemonState = "synced" | "syncing" | "attention" | "paused";
export type AmbientAttentionReason = "halt" | "out-of-storage" | "watcher-degraded" | "ownership-lost" | "unknown-error";
export type AmbientOperationKind = "pull" | "push";
export type DaemonMode = "pull-only" | "read-write";

export interface AmbientGitDeferral {
  repo: string;
  reason: string;
  reasonLabel: string;
  reasonText: string;
  remediationClass: GitDeferralRemediationClass | string;
  deferredSince: string;
  reasonSince: string;
  checkout?: { kind: "detached" } | { kind: "branch"; label?: string };
}

export interface AmbientDaemonStatusV1 {
  schemaVersion: 1;
  daemonVersion?: string;
  /** Optional for compatibility with daemon.status.json records written before design 178. */
  mode?: DaemonMode;
  /** Mode is authoritative only when this incarnation equals the live v2 pidfile. */
  bootId?: string;
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
  deferrals?: AmbientGitDeferral[];
  /** Boot-bound graceful-stop proof consumed by `rbox stop`. */
  shutdown?: {
    gateClosed: true;
    phase?: MutationPhase;
    repository?: string;
    committed?: boolean;
  };
}

export function validDaemonVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  try {
    parseSemver(value);
    return true;
  } catch {
    return false;
  }
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

type PumpOp = "pull" | "push" | "fullScan" | "deepScan" | "recoveryProbe";
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
const MODES = new Set<DaemonMode>(["pull-only", "read-write"]);
const REASONS = new Set<AmbientAttentionReason>(["halt", "out-of-storage", "watcher-degraded", "ownership-lost", "unknown-error"]);
const PHASES = new Set<TransferPhase>(["scan", "gitcap", "encrypt", "upload", "download"]);
const MUTATION_PHASES = new Set<MutationPhase>(["file-apply", "git-prepare", "git-commit", "state-cas"]);

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

function boundedAmbientText(value: string, maxScalars: number): string {
  const clean = value.replace(/[\r\n\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return [...clean].slice(0, maxScalars).join("");
}

function ambientIso(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function ambientCheckout(value: unknown): AmbientGitDeferral["checkout"] | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checkout = value as Record<string, unknown>;
  if (checkout.kind === "detached") return { kind: "detached" };
  if (checkout.kind !== "branch") return null;
  if (checkout.label !== undefined && typeof checkout.label !== "string") return null;
  return {
    kind: "branch",
    ...(typeof checkout.label === "string" ? { label: boundedAmbientText(checkout.label, 512) } : {}),
  };
}

function parseAmbientDeferral(value: unknown): AmbientGitDeferral | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.repo !== "string" || typeof item.reason !== "string"
    || typeof item.reasonLabel !== "string" || typeof item.reasonText !== "string"
    || typeof item.remediationClass !== "string"
    || !ambientIso(item.deferredSince) || !ambientIso(item.reasonSince)) return undefined;
  const repo = boundedAmbientText(item.repo, 1_024);
  if (!repo) return undefined;
  const reason = boundedAmbientText(item.reason, 128);
  const suppliedLabel = boundedAmbientText(item.reasonLabel, 160);
  const suppliedText = boundedAmbientText(item.reasonText, 512);
  const suppliedClass = boundedAmbientText(item.remediationClass, 64);
  const checkout = ambientCheckout(item.checkout);
  if (checkout === null) return undefined;
  const known = isKnownGitDeferralReason(reason);
  const presentation = gitDeferralReasonPresentation(reason);
  return {
    repo,
    reason,
    reasonLabel: known ? suppliedLabel : presentation.label,
    reasonText: known ? suppliedText : presentation.text,
    remediationClass: known ? suppliedClass : "apply-unavailable",
    deferredSince: item.deferredSince,
    reasonSince: item.reasonSince,
    ...(checkout === undefined ? {} : { checkout }),
  };
}

function attentionReason(input: AmbientStatusProjectionInput): AmbientAttentionReason | undefined {
  if (input.ownershipLost) return "ownership-lost";
  if (input.activity.halt
    && input.activity.halt.recoveryState !== "suspended"
    && !(input.activity.halt.nextProbeAt
      && !input.activity.halt.terminal
      && !isSafetyHaltReason(input.activity.halt.typedReason?.kind))) return "halt";
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
    input.activePumpOp === "recoveryProbe" ||
    Boolean(input.activity.halt?.nextProbeAt
      && input.activity.halt.recoveryState !== "suspended"
      && !input.activity.halt.terminal
      && input.activity.halt.typedReason?.kind !== "mass-delete"
      && input.activity.halt.typedReason?.kind !== "chain-repair") ||
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
    Object.values(record.deferrals ?? {}).flatMap((deferral) => deferral ? [{ repo, deferral, record }] : [])
  ), input.now);
  const deferredRepos = projectedDeferrals.length;
  const oldestDeferredSince = Date.parse(projectedDeferrals[0]?.oldestDeferredSince ?? "");
  const oldestDeferralAgeSeconds = deferredRepos === 0
    ? null
    : Number.isFinite(oldestDeferredSince) && oldestDeferredSince <= input.now
      ? Math.floor((input.now - oldestDeferredSince) / 1_000)
      : null;

  return stripUndefined({
    schemaVersion: 1,
    daemonVersion: RBOX_VERSION,
    state,
    heartbeatAt: new Date(input.now).toISOString(),
    sequence: input.sequence ?? null,
    lastSyncedAt: newestIso(input.activity.lastPush?.at, input.activity.lastPull?.at),
    operation: op,
    attentionReason: state === "attention" ? reason ?? "unknown-error" : undefined,
    deferredRepos,
    oldestDeferralAgeSeconds,
    deferrals: projectedDeferrals.flatMap((deferral) => {
      const repo = boundedAmbientText(deferral.repo, 1_024);
      if (!repo || !ambientIso(deferral.oldestDeferredSince) || !ambientIso(deferral.reasonSince)) return [];
      const checkout = deferral.checkout?.kind === "detached"
        ? { kind: "detached" as const }
        : deferral.checkout?.kind === "branch"
          ? { kind: "branch" as const, ...(deferral.checkout.label === undefined ? {} : { label: boundedAmbientText(deferral.checkout.label, 512) }) }
          : undefined;
      return [{
        repo,
        reason: boundedAmbientText(deferral.displayReason, 128),
        reasonLabel: boundedAmbientText(deferral.reasonLabel, 160),
        reasonText: boundedAmbientText(deferral.reasonText, 512),
        remediationClass: boundedAmbientText(deferral.remediationClass, 64),
        deferredSince: deferral.oldestDeferredSince,
        reasonSince: deferral.reasonSince,
        ...(checkout === undefined ? {} : { checkout }),
      }];
    }).slice(0, 5),
  }) as AmbientDaemonStatusV1;
}

export function pausedAmbientDaemonStatus(
  now = Date.now(),
  previous?: Pick<AmbientDaemonStatusV1, "sequence" | "lastSyncedAt" | "deferredRepos" | "oldestDeferralAgeSeconds" | "deferrals">,
): AmbientDaemonStatusV1 {
  return {
    schemaVersion: 1,
    daemonVersion: RBOX_VERSION,
    state: "paused",
    heartbeatAt: new Date(now).toISOString(),
    sequence: previous?.sequence ?? null,
    lastSyncedAt: previous?.lastSyncedAt ?? null,
    ...(previous?.deferredRepos === undefined ? {} : { deferredRepos: previous.deferredRepos }),
    ...(previous?.oldestDeferralAgeSeconds === undefined ? {} : { oldestDeferralAgeSeconds: previous.oldestDeferralAgeSeconds }),
    ...(previous?.deferrals === undefined ? {} : { deferrals: previous.deferrals.slice(0, 5) }),
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
    if (!ambientIso(j.heartbeatAt)) return undefined;
    if (!(j.sequence === null || uint(j.sequence))) return undefined;
    if (!(j.lastSyncedAt === null || ambientIso(j.lastSyncedAt))) return undefined;
    if (j.daemonVersion !== undefined && !validDaemonVersion(j.daemonVersion)) return undefined;
    if (j.mode !== undefined && !MODES.has(j.mode as DaemonMode)) return undefined;
    if (j.bootId !== undefined && (typeof j.bootId !== "string" || j.bootId.length < 1 || j.bootId.length > 128 || /[\r\n\p{Cc}]/u.test(j.bootId))) return undefined;
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
    if (j.daemonVersion !== undefined) out.daemonVersion = j.daemonVersion;
    if (j.mode !== undefined) out.mode = j.mode as DaemonMode;
    if (j.bootId !== undefined) out.bootId = j.bootId;
    if (j.attentionReason !== undefined) out.attentionReason = j.attentionReason;
    if (j.deferredRepos !== undefined) out.deferredRepos = j.deferredRepos;
    if (j.oldestDeferralAgeSeconds !== undefined) out.oldestDeferralAgeSeconds = j.oldestDeferralAgeSeconds;
    if (j.deferrals !== undefined) {
      const items = Array.isArray(j.deferrals) ? j.deferrals : [];
      out.deferrals = items.slice(0, 5).flatMap((item) => {
        const parsed = parseAmbientDeferral(item);
        return parsed ? [parsed] : [];
      });
    }
    if (j.shutdown !== undefined) {
      if (!j.shutdown || typeof j.shutdown !== "object" || j.shutdown.gateClosed !== true) return undefined;
      if (j.shutdown.phase !== undefined && !MUTATION_PHASES.has(j.shutdown.phase as MutationPhase)) return undefined;
      if (j.shutdown.repository !== undefined && typeof j.shutdown.repository !== "string") return undefined;
      if (j.shutdown.committed !== undefined && typeof j.shutdown.committed !== "boolean") return undefined;
      out.shutdown = stripUndefined({
        gateClosed: true as const,
        phase: j.shutdown.phase as MutationPhase | undefined,
        repository: j.shutdown.repository,
        committed: j.shutdown.committed,
      });
    }
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

export type AmbientDaemonStatusRecord = { kind: "absent" } | { kind: "corrupt" } | { kind: "ok"; status: AmbientDaemonStatusV1 };

export function readAmbientDaemonStatusRecord(root: string): AmbientDaemonStatusRecord {
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
  const read = readAmbientDaemonStatusRecord(root);
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
