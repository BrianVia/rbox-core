/**
 * What `rbox doctor`'s triage is ALLOWED to believe.
 *
 * `workspace-observation.ts` owns the reads and daemon trust gates; this module
 * adapts that closed observation to doctor's pure evidence vocabulary, while
 * `doctor-triage.ts` owns what is said. Three rules are load-bearing:
 *
 * - Inconclusive evidence suppresses only ITS OWN check. A lookup that never
 *   got an answer can neither prove a fault nor excuse one that another check
 *   did prove, so verdicts stay per-check and never become one shared veto.
 * - A daemon status record is evidence only for the incarnation that wrote it:
 *   live, bound to THIS root, fresh, and matching the live pidfile's boot id.
 * - Ownership comes from ONE observation taken at triage time. Combining a
 *   liveness verdict captured earlier with a pid read taken later can both
 *   suppress a live halt and resurrect dead residue.
 *
 * Every observation read is non-mutating. In particular local depth uses raw
 * state rather than the recovering `loadState` path.
 */
import type { AmbientDaemonStatusV1 } from "./daemon/ambient-status.js";
import type { DoctorCheck, DoctorChecks } from "./doctor-cmd.js";
import {
  observeWorkspace,
  type LocalWorkspaceObservation,
} from "./workspace-observation.js";

export type { DaemonObservation } from "./daemon/observation.js";

export type TriageInputs = Pick<
  LocalWorkspaceObservation,
  "root" | "deferrals" | "activity" | "daemon" | "adopt" | "observedAt"
> & {
  checks: DoctorChecks;
  cliVersion?: string;
};

export interface TriageReadDeps {
  observeWorkspace?: (
    root: string,
    request: { depth: "local"; now?: number },
  ) => Promise<LocalWorkspaceObservation>;
}

/** Read every triage input for `root`. Each read is best-effort: a diagnosis
 * surface must still render when one of the sidecars it reads is unavailable. */
export async function readTriageInputs(
  root: string,
  checks: DoctorChecks,
  now = Date.now(),
  deps: TriageReadDeps = {},
): Promise<TriageInputs> {
  const observation = await (deps.observeWorkspace ?? observeWorkspace)(root, { depth: "local", now });
  return { ...observation, checks };
}

/** This check failed, and the failure is evidence of a real fault. */
export function provenFailure(check: DoctorCheck | undefined): boolean {
  return check !== undefined && !check.ok && check.inconclusive !== true;
}

/** This check never got an answer. It proves nothing — in either direction. */
export function inconclusive(check: DoctorCheck | undefined): boolean {
  return check !== undefined && !check.ok && check.inconclusive === true;
}

const UNVERIFIED_LABELS: ReadonlyArray<readonly [keyof DoctorChecks, string]> = [
  ["credentials", "your sign-in"],
  ["chain", "your uploaded history"],
  ["version", "whether an update is available"],
];

/** Plain-English names of the checks that could not reach a verdict, so the
 * report can say what it did NOT learn. Deliberately a LIST, not a boolean
 * veto: each entry withholds only its own check's claim, and never suppresses
 * a different check that did prove something. */
export function unverifiedChecks(checks: DoctorChecks): string[] {
  const names = UNVERIFIED_LABELS.flatMap(([key, label]) => (inconclusive(checks[key]) ? [label] : []));
  // An unreachable service is WHY the rest could not answer; name it first and
  // only once, so the finding never reads as several separate outages.
  return provenFailure(checks.remote) ? ["the sync service", ...names] : names;
}

/** The daemon's activity sidecar is residue once its daemon is gone or has
 * rebound elsewhere: a restart re-evaluates every halt and quota refusal, so
 * status drops it (status-view.ts) and diagnosis must drop it too. */
export function daemonOwnsActivity(input: TriageInputs): boolean {
  return input.daemon.ownsWorkspace;
}

/** The status record describes ONE daemon incarnation, and is evidence only
 * while that incarnation is the live one: a live daemon bound to this root, a
 * heartbeat neither stale nor future-dated, and a boot id matching the live v2
 * pidfile (design 178). A record failing any of those is not downgraded to a
 * weaker claim — it is not used at all. */
export function liveAmbient(input: TriageInputs): AmbientDaemonStatusV1 | undefined {
  return input.daemon.trustedAmbient;
}
