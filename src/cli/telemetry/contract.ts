import type { GitDeferralReason } from "../config.js";

export interface NumericDomain {
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
}

const MS_DOMAIN = { min: 0, max: 604_800_000, integer: true } as const;
const COUNT_DOMAIN = { min: 0, max: 10_000_000, integer: true } as const;
export const TRANSPORTS = ["batch", "pack", "single"] as const;
export type LaneTransport = (typeof TRANSPORTS)[number];
export const FILL_VERSIONS = ["v1", "v2"] as const;
export type FillVersion = (typeof FILL_VERSIONS)[number];
export const SAFETY_EVENT_TYPES = ["mass_delete_breaker", "scan_fault"] as const;
export type SafetyEventType = (typeof SAFETY_EVENT_TYPES)[number];
export const TELEMETRY_BATCH_CAP = 64;

export function telemetryEnabled(): boolean {
  return process.env.RBOX_TELEMETRY !== "0";
}

/** The client/server wire schema. Derived values (corpusBucket and mbps) are deliberately absent. */
// Constraint: field declaration order IS the positional AE doubles order and feeds
// normalizeSample positional reads (wireNumbers[2], the upload_lane destructure) and
// cockpit dashboard SQL. Append only; never reorder.
export const TELEMETRY_SAMPLE_SCHEMAS = {
  propagation: {
    numbers: { deliveryToApplyMs: MS_DOMAIN },
    enums: {},
  },
  first_publish: {
    numbers: {
      timeToFilesSyncedMs: MS_DOMAIN,
      pushWallMs: MS_DOMAIN,
      fileCount: COUNT_DOMAIN,
      uniqueBlobs: COUNT_DOMAIN,
    },
    enums: {},
  },
  upload_lane: {
    numbers: {
      bytes: { min: 0, max: 10_000_000_000_000, integer: true },
      uploadMs: MS_DOMAIN,
      opCount: COUNT_DOMAIN,
    },
    enums: {
      transport: TRANSPORTS,
      fillVersion: FILL_VERSIONS,
    },
  },
  capability: {
    numbers: { workerExecutions: { min: 0, max: 1_000_000_000, integer: true } },
    enums: {},
  },
  safety_event: {
    numbers: { count: COUNT_DOMAIN },
    enums: { eventType: SAFETY_EVENT_TYPES },
  },
} as const satisfies Record<string, {
  readonly numbers: Readonly<Record<string, NumericDomain>>;
  readonly enums: Readonly<Record<string, readonly string[]>>;
}>;

export type TelemetryKind = keyof typeof TELEMETRY_SAMPLE_SCHEMAS;
export const TELEMETRY_KINDS = Object.keys(TELEMETRY_SAMPLE_SCHEMAS) as TelemetryKind[];

export const CORPUS_BUCKETS = [
  { bucket: "xs", maxFileCount: 100 },
  { bucket: "s", maxFileCount: 1_000 },
  { bucket: "m", maxFileCount: 10_000 },
  { bucket: "l", maxFileCount: 100_000 },
  { bucket: "xl", maxFileCount: null },
] as const;
export type CorpusBucket = (typeof CORPUS_BUCKETS)[number]["bucket"];

export const GIT_DEFERRAL_REASONS = [
  "local-edits", "local-index", "local-operation", "local-commits", "local-stash",
  "conflict", "git-busy", "worktree-ownership", "ignored-target", "unreadable",
  "artifact", "config", "containment", "unsupported", "other",
] as const satisfies readonly GitDeferralReason[];
type MissingGitDeferralReason = Exclude<GitDeferralReason, (typeof GIT_DEFERRAL_REASONS)[number]>;
type Assert<T extends true> = T;
type _AllGitDeferralReasonsCovered = Assert<MissingGitDeferralReason extends never ? true : false>;

export const SYNC_STATE_NUMERIC_DOMAINS = {
  fileSeq: { min: 0, max: 2 ** 48, integer: true },
  reposTotal: { min: 0, max: 10_000, integer: true },
  reposDeferred: { min: 0, max: 10_000, integer: true },
  oldestDeferralAgeMs: { min: 0, max: 7_776_000_000, integer: true },
} as const satisfies Record<string, NumericDomain>;
export const BINDING_ID_RE = /^[0-9a-f]{16}$/;

export interface PropagationSample { kind: "propagation"; deliveryToApplyMs: number }
export interface FirstPublishSample { kind: "first_publish"; timeToFilesSyncedMs: number; pushWallMs: number; fileCount: number; uniqueBlobs: number }
export interface UploadLaneSample { kind: "upload_lane"; transport: LaneTransport; bytes: number; uploadMs: number; opCount: number; fillVersion: FillVersion }
export interface CapabilitySample { kind: "capability"; workerExecutions: number }
export interface SafetyEventSample { kind: "safety_event"; eventType: SafetyEventType; count: number }
export type TelemetrySample = PropagationSample | FirstPublishSample | UploadLaneSample | CapabilitySample | SafetyEventSample;
export interface TelemetryEnvelope { v: 1; samples: TelemetrySample[] }

export interface SyncState {
  workspaceId: string;
  projectId: string;
  bindingId: string;
  fileSeq: number;
  reposTotal: number;
  reposDeferred: number;
  oldestDeferralAgeMs: number | null;
  deferralReasons: GitDeferralReason[];
}
export interface SyncStateEnvelope { v: 1; states: SyncState[] }
