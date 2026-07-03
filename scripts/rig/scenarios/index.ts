/** Scenario registry (design 56 §9). P0 ships the PR gate; P2 adds the suite. */
import type { Scenario } from "./types.js";
import { onboardSmoke } from "./onboard-smoke.js";

export const SCENARIOS: Record<string, Scenario> = {
  "onboard-smoke": onboardSmoke,
};

export function getScenario(name: string): Scenario | undefined {
  return SCENARIOS[name];
}

export function scenarioNames(): string[] {
  return Object.keys(SCENARIOS);
}
