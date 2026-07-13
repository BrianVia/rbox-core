import { afterEach, beforeEach, expect, test } from "bun:test";
import { pushMassDeleteTrips } from "../sync.js";

let priorPct: string | undefined;
let priorMin: string | undefined;

beforeEach(() => {
  priorPct = process.env.RBOX_MASS_DELETE_PCT;
  priorMin = process.env.RBOX_MASS_DELETE_MIN;
  delete process.env.RBOX_MASS_DELETE_PCT;
  delete process.env.RBOX_MASS_DELETE_MIN;
});

afterEach(() => {
  if (priorPct === undefined) delete process.env.RBOX_MASS_DELETE_PCT; else process.env.RBOX_MASS_DELETE_PCT = priorPct;
  if (priorMin === undefined) delete process.env.RBOX_MASS_DELETE_MIN; else process.env.RBOX_MASS_DELETE_MIN = priorMin;
});

test("push mass-delete predicate uses the default two-leg threshold", () => {
  expect(pushMassDeleteTrips(126557, 126557)).toBe(true);
  expect(pushMassDeleteTrips(30, 50)).toBe(false);
  expect(pushMassDeleteTrips(120, 200)).toBe(false);
  expect(pushMassDeleteTrips(1000, 5000)).toBe(true);
  expect(pushMassDeleteTrips(999, 5000)).toBe(false);
  expect(pushMassDeleteTrips(1001, 10)).toBe(true);
});

test("push mass-delete predicate accepts explicit thresholds", () => {
  expect(pushMassDeleteTrips(100, 100, { pct: 50, min: 100 })).toBe(true);
  expect(pushMassDeleteTrips(60, 100, { pct: 50, min: 100 })).toBe(false);
  expect(pushMassDeleteTrips(49, 100, { pct: 50, min: 100 })).toBe(false);
});

test("push mass-delete predicate honors environment thresholds", () => {
  process.env.RBOX_MASS_DELETE_PCT = "50";
  process.env.RBOX_MASS_DELETE_MIN = "50";
  expect(pushMassDeleteTrips(60, 100)).toBe(true);
});
