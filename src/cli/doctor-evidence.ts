/**
 * What `rbox doctor`'s triage is ALLOWED to believe.
 *
 * This module owns the reads and the trust gates; `doctor-triage.ts` owns what
 * is said about them. Keeping the two apart is what stops a plausible-looking
 * record from becoming a confident sentence. Three rules are load-bearing:
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
 * Every read here is non-mutating — `loadRawState` rather than `loadState`,
 * whose reset-journal recovery takes the workspace mutex and rewrites state.
 */
import { loadActivity, type DaemonActivity } from "./activity.js";
import { inspectAdoptFence, type AdoptFenceInspection } from "./adopt-journal.js";
import { loadConfig, loadRawState, repoRecordsForState, syncStreamId } from "./config.js";
import { currentWorkspaceId } from "./daemon-control.js";
import { DAEMON_HEARTBEAT_FUTURE_SKEW_MS, daemonBindingStatus } from "./daemon/process-control.js";
import { readAmbientDaemonStatusRecord, type AmbientDaemonStatusRecord, type AmbientDaemonStatusV1 } from "./daemon/ambient-status.js";
import { AMBIENT_STATUS_STALE_MS } from "./populate-marker.js";
import { projectGitDeferralRepos, type GitDeferralRepoProjection } from "./status-view.js";
import type { DoctorCheck, DoctorChecks } from "./doctor-cmd.js";
import { scopeProjectionFor } from "./scope/projection.js";

/** One point-in-time answer to "is a daemon running for THIS workspace root?".
 * Liveness is root-scoped — the daemon's own command line must name this root —
 * so a recycled pid, or another workspace's daemon that inherited it, is never
 * mistaken for ours. */
export interface DaemonObservation {
  /** A live rbox daemon whose own command line names this root. */
  running: boolean;
  pid?: number;
  bootId?: string;
  /** Live, but its startup binding names a different workspace than this root. */
  stale: boolean;
  /** Live AND bound to this root: the only state in which the daemon's sidecars
   * describe this workspace right now. */
  ownsRoot: boolean;
}

export interface TriageInputs {
  root: string;
  checks: DoctorChecks;
  deferrals: GitDeferralRepoProjection[];
  activity?: DaemonActivity;
  ambient: AmbientDaemonStatusRecord;
  daemon: DaemonObservation;
  adopt: AdoptFenceInspection;
  now: number;
  cliVersion?: string;
}

export interface TriageReadDeps {
  /** The single liveness/binding seam. Tests either drive it or drive the real
   * one by writing a pidfile — either way there is exactly one observation. */
  daemonBindingStatus?: typeof daemonBindingStatus;
  currentWorkspaceId?: typeof currentWorkspaceId;
}

/** Take the ONE ownership observation triage is allowed to use. */
export function observeDaemon(root: string, deps: TriageReadDeps = {}): DaemonObservation {
  const workspaceId = (deps.currentWorkspaceId ?? currentWorkspaceId)(root);
  // An unreadable workspace binding cannot prove ownership of anything; the
  // empty id makes any bound daemon read as stale, which is the safe answer.
  const status = (deps.daemonBindingStatus ?? daemonBindingStatus)(root, workspaceId ?? "");
  const running = status.alive.running;
  return {
    running,
    ...(status.alive.pid === undefined ? {} : { pid: status.alive.pid }),
    ...(status.alive.bootId === undefined ? {} : { bootId: status.alive.bootId }),
    stale: status.stale,
    ownsRoot: running && !status.stale && workspaceId !== undefined,
  };
}

/** Read every triage input for `root`. Each read is best-effort: a diagnosis
 * surface must still render when one of the sidecars it reads is unavailable. */
export async function readTriageInputs(
  root: string,
  checks: DoctorChecks,
  now = Date.now(),
  deps: TriageReadDeps = {},
): Promise<TriageInputs> {
  const [deferrals, activity, adopt] = await Promise.all([
    readDeferrals(root, now),
    loadActivity(root).catch(() => undefined),
    inspectAdoptFence(root).catch((error: unknown) => ({
      status: "corrupt" as const,
      reason: error instanceof Error ? error.message : String(error),
    })),
  ]);
  return {
    root,
    checks,
    deferrals,
    activity,
    adopt,
    ambient: readAmbientDaemonStatusRecord(root),
    daemon: observeDaemon(root, deps),
    now,
  };
}

/** Non-mutating deferral read. `loadState` would recover a standing reset
 * journal under the workspace mutex; a diagnosis must never do that. A state
 * file stamped for another stream describes another workspace and is ignored
 * rather than re-baselined. */
async function readDeferrals(root: string, now: number): Promise<GitDeferralRepoProjection[]> {
  try {
    const cfg = await loadConfig(root);
    const state = await loadRawState(root);
    if (!state) return [];
    if (state.stream !== undefined && state.stream !== syncStreamId(cfg)) return [];
    const records = repoRecordsForState(state);
    // Design 212 §3.2: doctor consumes the same projection. An out-of-scope repo's
    // deferral is not this machine's problem to report.
    const scope = await scopeProjectionFor(root, Object.keys(records));
    return projectGitDeferralRepos(
      Object.entries(records).filter(([repo]) => scope === undefined || scope.classifyRepo(repo) === "in").flatMap(([repo, record]) =>
        Object.values(record.deferrals ?? {}).flatMap((deferral) => (deferral ? [{ repo, deferral, record }] : []))),
      now,
    );
  } catch {
    return [];
  }
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
  return input.daemon.ownsRoot;
}

/** The status record describes ONE daemon incarnation, and is evidence only
 * while that incarnation is the live one: a live daemon bound to this root, a
 * heartbeat neither stale nor future-dated, and a boot id matching the live v2
 * pidfile (design 178). A record failing any of those is not downgraded to a
 * weaker claim — it is not used at all. */
export function liveAmbient(input: TriageInputs): AmbientDaemonStatusV1 | undefined {
  if (input.ambient.kind !== "ok" || !daemonOwnsActivity(input)) return undefined;
  const status = input.ambient.status;
  const age = input.now - Date.parse(status.heartbeatAt);
  if (!Number.isFinite(age) || age > AMBIENT_STATUS_STALE_MS || age < -DAEMON_HEARTBEAT_FUTURE_SKEW_MS) return undefined;
  if (status.bootId === undefined || input.daemon.bootId === undefined || status.bootId !== input.daemon.bootId) return undefined;
  return status;
}
