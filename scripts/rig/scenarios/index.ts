/** Scenario registry (design 56 §9). P0 shipped the PR gate; P2 adds the suite. */
import type { Scenario } from "./types.js";
import { onboardSmoke } from "./onboard-smoke.js";
import { twoDeviceLive } from "./two-device-live.js";
import { massDeleteGuard } from "./mass-delete-guard.js";
import { typeFlip } from "./type-flip.js";
import { daemonIdleCpu } from "./daemon-idle-cpu.js";
import { conductorInitialSync } from "./conductor-initial-sync.js";

export const SCENARIOS: Record<string, Scenario> = {
  "onboard-smoke": onboardSmoke,
  "two-device-live": twoDeviceLive,
  "mass-delete-guard": massDeleteGuard,
  "type-flip": typeFlip,
  "daemon-idle-cpu": daemonIdleCpu,
  "conductor-initial-sync": conductorInitialSync,
};

/**
 * The FAST suite (`rig run all`) — every scenario a PR should gate on, sequentially,
 * fresh account each. conductor-initial-sync is EXCLUDED (explicit-only: real workload,
 * minutes-long, plan-cap sensitive).
 */
export const FAST_SUITE = ["onboard-smoke", "two-device-live", "mass-delete-guard", "type-flip", "daemon-idle-cpu"] as const;

export function getScenario(name: string): Scenario | undefined {
  return SCENARIOS[name];
}

export function scenarioNames(): string[] {
  return Object.keys(SCENARIOS);
}
