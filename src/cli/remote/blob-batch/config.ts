import { envInt } from "../resilient.js";
import {
  PACK_MAX_BODY_BYTES,
  PACK_MAX_MEMBER_BYTES,
  PACK_MAX_MEMBERS,
  PACK_MIN_ACTIVATION_BYTES,
  PACK_MIN_ACTIVATION_COUNT,
  PACK_TARGET_PAYLOAD_BYTES,
} from "../../../engine/blob-pack.js";

export const DEFAULT_BATCH_RECORD_BYTES = 256 * 1024;
export const BATCH_RECORDS_FLOOR = 32;
export const BATCH_RECORDS_MAX_V2 = 64;
const DEFAULT_BATCH_BODY_BYTES = 8 * 1024 * 1024;
// measured 2026-07-08 (same subrequest-cap mechanism as PUT below): a batch GET's
// 32 parallel R2 reads serialize ~6-wide inside one invocation (~1s/batch), so GET
// slots scale linearly too — full-corpus wired join: 16 slots = 128s, 48 = 84s,
// 64 = 82s (flat past the knee; the floor moves to git apply + local decrypt).
const DEFAULT_BATCH_SLOTS = 48;
// measured 2026-07-08 — Workers cap parallel subrequests per invocation (~6),
// so one batch PUT settles in ~910ms regardless of records; slots scale linearly
// (8 slots = 83s publish, 24 slots = 39s on the A/B corpus; AE avg_ms constant at both).
const DEFAULT_BATCH_PUT_SLOTS = 24;
// Client slot ceilings (concurrency knobs). Raised well above the historical
// defaults so RBOX_UPLOAD_SLOTS / RBOX_DOWNLOAD_SLOTS can sweep; defaults unchanged.
// Peak transient framing scales as slots × bodyBytes (8 MiB), so the ceiling caps
// worst-case RSS at ~2 GiB; real small-file batches fill `records` (32) long before
// the 8 MiB cap, so typical per-slot bodies are far smaller. Only explicitly-set
// values above the historical 32/64 caps reach here.
const MAX_UPLOAD_SLOTS = 256;
const MAX_DOWNLOAD_SLOTS = 256;
export const FLUSH_DELAY_MS = 10;
export const FILL_QUIET_MS = 10;
export const FILL_ABSOLUTE_MS = 50;
export const PACK_FILL_QUIET_MS = 200;
export const PACK_FILL_ABSOLUTE_MS = 1000;
export const GRANT_REFRESH_AFTER_MS = 4 * 60 * 1000;
export const SINGLE_FALLBACK_CONCURRENCY = 128;
export const SINGLE_UPLOAD_FALLBACK_CONCURRENCY = 64;
export const DEFAULT_PULL_JOIN_WATCHDOG_MS = 90_000;
export const DEFAULT_PULL_JOIN_WATCHDOG_MAX_FIRINGS = 3;

export interface BatchConfig {
  enabled: boolean;
  fill: "v1" | "v2";
  records: number;
  recordBytes: number;
  bodyBytes: number;
  slots: number;
}

export interface PackConfig {
  enabled: boolean;
  streams: number;
  cutoffBytes: number;
  targetPayloadBytes: number;
  minActivationCount: number;
  minActivationBytes: number;
}

export function fillVersion(): "v1" | "v2" {
  return process.env.RBOX_BATCH_FILL === "v1" ? "v1" : "v2";
}

export function packUploadEnabled(): boolean {
  return process.env.RBOX_BLOB_PACK === "1";
}

export function packUploadConfig(): PackConfig {
  return {
    enabled: packUploadEnabled(),
    // 16 streams, field-measured knee (2026-07-27 dev sweep, issue #504): the pack
    // lane is request-latency-bound (~0.7s per PUT settle), so 4 streams serialized
    // packs and lost to the 24-slot batch lane; at 16 the same corpus lands 0.88x
    // of batch wall with the full request-count win. Link-dependent tuning stays
    // available via RBOX_PACK_STREAMS.
    streams: envInt("RBOX_PACK_STREAMS", 16, 1, 64),
    cutoffBytes: envInt("RBOX_PACK_CUTOFF_BYTES", PACK_MAX_MEMBER_BYTES, 1, PACK_MAX_MEMBER_BYTES),
    targetPayloadBytes: envInt("RBOX_PACK_TARGET_BYTES", PACK_TARGET_PAYLOAD_BYTES, 64 * 1024, PACK_TARGET_PAYLOAD_BYTES),
    minActivationCount: envInt("RBOX_PACK_MIN_BLOBS", PACK_MIN_ACTIVATION_COUNT, 1, PACK_MAX_MEMBERS),
    minActivationBytes: envInt("RBOX_PACK_MIN_BYTES", PACK_MIN_ACTIVATION_BYTES, 1, PACK_MAX_BODY_BYTES),
  };
}

export function uploadBatchConfig(): BatchConfig {
  // Default ON (founder call 2026-07-13, single-user fleet — same as files-first):
  // fill-v2 + 64-record batches ship live; RBOX_BATCH_FILL=v1 is the kill switch
  // (the server cap is already 64 on both envs, and the 400 latch guards skew).
  const fill = fillVersion();
  return readBatchConfig(
    ["RBOX_UPLOAD_SLOTS", "RBOX_BATCH_PUT_SLOTS"],
    DEFAULT_BATCH_PUT_SLOTS,
    MAX_UPLOAD_SLOTS,
    DEFAULT_BATCH_RECORD_BYTES,
    fill,
  );
}

export function downloadBatchConfig(): BatchConfig {
  return readBatchConfig(
    ["RBOX_DOWNLOAD_SLOTS", "RBOX_BATCH_SLOTS"],
    DEFAULT_BATCH_SLOTS,
    MAX_DOWNLOAD_SLOTS,
    DEFAULT_BATCH_BODY_BYTES,
    "v1",
  );
}

function envIntFirst(names: string[], fallback: number, min: number, max: number): number {
  for (const name of names) {
    if (process.env[name]?.trim()) return envInt(name, fallback, min, max);
  }
  return fallback;
}

function readBatchConfig(
  slotsEnvs: string[],
  slotsDefault: number,
  slotsMax: number,
  recordBytesMax: number,
  fill: "v1" | "v2",
): BatchConfig {
  const recordsMax = fill === "v2" ? BATCH_RECORDS_MAX_V2 : BATCH_RECORDS_FLOOR;
  return {
    enabled: process.env.RBOX_BATCH_BLOBS !== "0",
    fill,
    // Wire twin: server RBOX_BLOB_BATCH_MAX_RECORDS defaults to 32, candidate 64.
    // The client may exceed 32 only under fill-v2 against a raised server; uploader's
    // 400 latch is the version-skew guard when rollout ordering is violated.
    // Default 32 even under fill-v2: the FM matched-cell sweep (2026-07-13) PASSED
    // fill-v2 at 32 records (−14.1% slot work) but FAILED the 64-record cap gate
    // (−7% — bigger settles beat the parallelism, echoing the #245 knee). 64 stays
    // reachable via RBOX_BATCH_RECORDS=64 for re-evaluation.
    records: envInt("RBOX_BATCH_RECORDS", BATCH_RECORDS_FLOOR, 1, recordsMax),
    recordBytes: envInt("RBOX_BATCH_RECORD_BYTES", DEFAULT_BATCH_RECORD_BYTES, 1, recordBytesMax),
    bodyBytes: envInt("RBOX_BATCH_BODY_BYTES", DEFAULT_BATCH_BODY_BYTES, 1, DEFAULT_BATCH_BODY_BYTES),
    slots: envIntFirst(slotsEnvs, slotsDefault, 1, slotsMax),
  };
}
