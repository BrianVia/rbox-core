/** Scenario registry (design 56 §9). P0 shipped the PR gate; P2 adds the suite. */
import type { Scenario } from "./types.js";
import { onboardSmoke } from "./onboard-smoke.js";
import { twoDeviceLive } from "./two-device-live.js";
import { massDeleteGuard } from "./mass-delete-guard.js";
import { typeFlip } from "./type-flip.js";
import { daemonIdleCpu } from "./daemon-idle-cpu.js";
import { conductorInitialSync } from "./conductor-initial-sync.js";
import { chaosRestart } from "./chaos-restart.js";
import { gitEntanglement } from "./git-entanglement.js";
import { gitConfigSync } from "./git-config-sync.js";

export const SCENARIOS: Record<string, Scenario> = {
  "onboard-smoke": onboardSmoke,
  "two-device-live": twoDeviceLive,
  "mass-delete-guard": massDeleteGuard,
  "type-flip": typeFlip,
  "daemon-idle-cpu": daemonIdleCpu,
  "git-entanglement": gitEntanglement,
  "git-config-sync": gitConfigSync,
  "conductor-initial-sync": conductorInitialSync,
  "chaos-restart": chaosRestart,
};

/**
 * The FAST suite (`rig run all`) — every scenario a PR should gate on, sequentially,
 * fresh account each. conductor-initial-sync is EXCLUDED (explicit-only: real workload,
 * minutes-long, plan-cap sensitive). chaos-restart is EXCLUDED too — not on wall time
 * (a live run lands ~30s) but on FLAKE POSTURE: it SIGKILLs + restarts a guest, and Apple
 * container 1.0.0 has a known tendency to wedge on kill/start. That risk does not belong
 * in the every-PR gate; run it explicitly + nightly instead (design 56 §11's fast/nightly
 * split also omits it). Its wall time is additionally network-variable (resume push + B
 * pull), so it's a poor fit for a tight PR loop regardless.
 */
export const FAST_SUITE = ["onboard-smoke", "two-device-live", "mass-delete-guard", "type-flip", "daemon-idle-cpu", "git-entanglement"] as const;

export function getScenario(name: string): Scenario | undefined {
  return SCENARIOS[name];
}

export function scenarioNames(): string[] {
  return Object.keys(SCENARIOS);
}
