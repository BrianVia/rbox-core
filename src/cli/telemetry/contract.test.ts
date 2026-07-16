import { describe, expect, test } from "bun:test";
import {
  BINDING_ID_RE,
  CORPUS_BUCKETS,
  FILL_VERSIONS,
  GIT_DEFERRAL_REASONS,
  SAFETY_EVENT_TYPES,
  SYNC_STATE_NUMERIC_DOMAINS,
  TELEMETRY_KINDS,
  TELEMETRY_SAMPLE_SCHEMAS,
  TRANSPORTS,
} from "./contract.js";

describe("telemetry wire contract", () => {
  test("pins sample kinds, enum axes, and corpus thresholds", () => {
    expect(TELEMETRY_KINDS).toEqual(["propagation", "first_publish", "upload_lane", "capability", "safety_event"]);
    expect(TRANSPORTS).toEqual(["batch", "pack", "single"]);
    expect(FILL_VERSIONS).toEqual(["v1", "v2"]);
    expect(SAFETY_EVENT_TYPES).toEqual(["mass_delete_breaker", "scan_fault"]);
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
    expect(TELEMETRY_SAMPLE_SCHEMAS.propagation.numbers.deliveryToApplyMs).toEqual({ min: 0, max: 604_800_000, integer: true });
    expect(SYNC_STATE_NUMERIC_DOMAINS.fileSeq.max).toBe(2 ** 48);
    expect(GIT_DEFERRAL_REASONS).toHaveLength(15);
    expect(BINDING_ID_RE.test("0123456789abcdef")).toBe(true);
    expect(BINDING_ID_RE.test("0123456789abcdeF")).toBe(false);
  });
});
