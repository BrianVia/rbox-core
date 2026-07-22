import { expect, test } from "bun:test";
import {
  RECOVERY_PROBE_CAP_MS,
  RECOVERY_PROBE_SERVICE_BOUND,
  recoveryProbeDelayMs,
  selectPumpOperation,
  type Wants,
} from "./policy.js";

const wants = (values: Partial<Wants> = {}): Wants => ({ pull: false, push: false, fullScan: false, deepScan: false, ...values });

test("design 178 B: recovery backoff is full-jitter exponential with a two-minute cap", () => {
  expect(recoveryProbeDelayMs(1, () => 0)).toBe(0);
  expect(recoveryProbeDelayMs(1, () => 0.5)).toBe(2_500);
  expect(recoveryProbeDelayMs(2, () => 0.5)).toBe(5_000);
  expect(recoveryProbeDelayMs(20, () => 0.999999999)).toBeLessThan(RECOVERY_PROBE_CAP_MS);
  expect(recoveryProbeDelayMs(20, () => 0.999999999)).toBeGreaterThanOrEqual(RECOVERY_PROBE_CAP_MS - 1);
});

test("design 178 B: a due coalesced probe gets one slot after eight dequeued ambient operations", () => {
  const continuous = wants({ deepScan: true, fullScan: true, pull: true, push: true });
  for (let dequeued = 0; dequeued < RECOVERY_PROBE_SERVICE_BOUND; dequeued++) {
    expect(selectPumpOperation(continuous, true, dequeued)).toBe("deepScan");
  }
  expect(selectPumpOperation(continuous, true, RECOVERY_PROBE_SERVICE_BOUND)).toBe("recoveryProbe");
  expect(selectPumpOperation(wants(), true, 0)).toBe("recoveryProbe");
  expect(selectPumpOperation(wants({ push: true }), false, 99)).toBe("push");
});
