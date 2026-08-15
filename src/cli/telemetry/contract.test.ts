import { describe, expect, test } from "bun:test";
import {
  BINDING_ID_RE,
  CORPUS_BUCKETS,
  FILL_VERSIONS,
  GIT_DEFERRAL_REASONS,
  SAFETY_EVENT_TYPES,
  SYNC_PHASE_NAMES,
  SYNC_STATE_NUMERIC_DOMAINS,
  TELEMETRY_KINDS,
  TELEMETRY_SAMPLE_SCHEMAS,
  TRANSPORTS,
} from "./contract.js";

describe("telemetry wire contract", () => {
  test("pins sample kinds, enum axes, and corpus thresholds", () => {
    expect(TELEMETRY_KINDS).toEqual(["propagation", "first_publish", "upload_lane", "capability", "safety_event", "git_capture", "ws_health", "sync_phase"]);
    expect(TRANSPORTS).toEqual(["batch", "pack", "single"]);
    expect(FILL_VERSIONS).toEqual(["v1", "v2"]);
    expect(SAFETY_EVENT_TYPES).toEqual(["mass_delete_breaker", "scan_fault", "genesis_lock_unsupported"]);
    expect(SYNC_PHASE_NAMES).toHaveLength(15);
    expect(CORPUS_BUCKETS).toEqual([
      { bucket: "xs", maxFileCount: 100 },
      { bucket: "s", maxFileCount: 1_000 },
      { bucket: "m", maxFileCount: 10_000 },
      { bucket: "l", maxFileCount: 100_000 },
      { bucket: "xl", maxFileCount: null },
    ]);
  });

  test("pins numeric domains and all fifteen deferral reasons", () => {
    expect(TELEMETRY_SAMPLE_SCHEMAS.upload_lane.numbers.bytes.max).toBe(10_000_000_000_000);
    expect(Object.keys(TELEMETRY_SAMPLE_SCHEMAS.git_capture.numbers)).toEqual(["signalPushes", "candidatePushes", "scanPushes"]);
    expect(TELEMETRY_SAMPLE_SCHEMAS.propagation.numbers.deliveryToApplyMs).toEqual({ min: 0, max: 604_800_000, integer: true });
    expect(Object.keys(TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers)).toEqual([
      "windowMs", "wsConnectedMs", "wsReconnects", "wsHalfOpenDetected", "backstopAttempts",
      "backstopAppliedPulls", "cursorAppliedPulls", "notifyAppliedPulls", "notifyLatencyCount",
      "notifyLatencySumMs", "notifyLatencyMaxMs",
    ]);
    expect(TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers.windowMs.max).toBe(604_800_000);
    expect(TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers.wsReconnects.max).toBe(1_000_000_000);
    for (const field of ["wsReconnects", "wsHalfOpenDetected", "backstopAttempts", "backstopAppliedPulls", "cursorAppliedPulls", "notifyAppliedPulls", "notifyLatencyCount"] as const) {
      expect(TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers[field]).toEqual({ min: 0, max: 1_000_000_000, integer: true });
    }
    expect(TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers.notifyLatencySumMs.max).toBe(1_000_000_000_000);
    expect(TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers.notifyLatencyMaxMs.max).toBe(604_800_000);
    expect(SYNC_STATE_NUMERIC_DOMAINS.fileSeq.max).toBe(2 ** 48);
    expect(GIT_DEFERRAL_REASONS).toHaveLength(18);
    expect(BINDING_ID_RE.test("0123456789abcdef")).toBe(true);
    expect(BINDING_ID_RE.test("0123456789abcdeF")).toBe(false);
  });
});
