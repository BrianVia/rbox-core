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
import { gitShapes } from "./git-shapes.js";
import { gitFf } from "./git-ff.js";
import { gitJoinAhead } from "./git-join-ahead.js";
import { gitCommitPropagation } from "./git-commit-propagation.js";
import { gitHeldLivelock } from "./git-held-livelock.js";
import { gitStaleOpstate } from "./git-stale-opstate.js";
import { worktreeSquashLifecycle } from "./worktree-squash-lifecycle.js";
import { webPairing } from "./web-pairing.js";
import { sqliteFreshInstall } from "./sqlite-fresh-install.js";
import { jsonUpgradePath } from "./json-upgrade-path.js";

export const SCENARIOS = {
  "onboard-smoke": onboardSmoke,
  "two-device-live": twoDeviceLive,
  "web-pairing": webPairing,
  "mass-delete-guard": massDeleteGuard,
  "type-flip": typeFlip,
  "daemon-idle-cpu": daemonIdleCpu,
  "git-entanglement": gitEntanglement,
  "git-config-sync": gitConfigSync,
  "git-shapes": gitShapes,
  "git-ff": gitFf,
  "git-join-ahead": gitJoinAhead,
  "git-commit-propagation": gitCommitPropagation,
  "git-held-livelock": gitHeldLivelock,
  "git-stale-opstate": gitStaleOpstate,
  "worktree-squash-lifecycle": worktreeSquashLifecycle,
  "conductor-initial-sync": conductorInitialSync,
  "chaos-restart": chaosRestart,
  "sqlite-fresh-install": sqliteFreshInstall,
  "json-upgrade-path": jsonUpgradePath,
} satisfies Record<string, Scenario>;

/**
 * The FAST suite (`rig run all`) — every scenario a PR should gate on, sequentially,
 * fresh account each. conductor-initial-sync is EXCLUDED (explicit-only: real workload,
 * minutes-long, plan-cap sensitive). chaos-restart is EXCLUDED too — not on wall time
 * (a live run lands ~30s) but on FLAKE POSTURE: it SIGKILLs + restarts a guest, and Apple
 * container 1.0.0 has a known tendency to wedge on kill/start. That risk does not belong
 * in the every-PR gate; run it explicitly + nightly instead (design 56 §11's fast/nightly
 * split also omits it). Its wall time is additionally network-variable (resume push + B
 * pull), so it's a poor fit for a tight PR loop regardless. git-commit-propagation is
 * EXCLUDED too (explicit/nightly): it runs a change-shape matrix (commits, file-plane
 * edits, and a ~200MB repo moved through the dev API) and, until design 172 lands, its
 * empty-commit rounds wait out the 60s safety scan — too slow and red-by-design for the
 * every-PR gate. Run it explicitly to guard design 172. git-held-livelock is likewise
 * EXCLUDED (explicit/pre-merge): it stops/starts a live daemon mid-scenario and runs
 * several propagation rounds — the design-174 guard, run explicitly like its sibling.
 * git-stale-opstate is EXCLUDED as well (explicit/pre-merge): it is the guard for the
 * MERGE_MSG/AUTO_MERGE op-state reclassification, and it stages a multi-round divergence
 * wedge plus a real in-progress merge on a live device — an explicit-only pre-merge run
 * like its `git-*` siblings, never an every-PR gate.
 * web-pairing is EXCLUDED too (explicit/pre-merge): the design-189/192 auto-key-delivery
 * validation runs a real device-code `rbox login`, waits out the daemon fulfillment +
 * enroll window (~1-2 min), and drives the dev-only scriptable approve — too slow and
 * daemon-timing-variable for the every-PR gate. Run it explicitly to guard 189.
 * worktree-squash-lifecycle is EXCLUDED and additionally kept out of every CI workflow:
 * it is design 200's acceptance gate and is **RED BY CONSTRUCTION** until 200 lands (the
 * founder's zero-surviving-deferral ruling for the create-worktree → squash-merge →
 * delete lifecycle). Registering it in FAST_SUITE — or in `.github/workflows/e2e.yml`'s
 * `all` — would wire a known failure into the gate. Run it on demand:
 * `bun run rig run worktree-squash-lifecycle`.
 */
export const FAST_SUITE = [
  "sqlite-fresh-install",
  "json-upgrade-path",
  "onboard-smoke",
  "two-device-live",
  "mass-delete-guard",
  "type-flip",
  "daemon-idle-cpu",
  "git-entanglement",
  "git-join-ahead",
] as const;

export function getScenario(name: string): Scenario | undefined {
  return Object.values(SCENARIOS).find((scenario) => scenario.name === name);
}

export function scenarioNames(): string[] {
  return Object.keys(SCENARIOS);
}
