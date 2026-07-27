/**
 * What `rbox doctor`'s triage is ALLOWED to believe.
 *
 * This module owns the reads and the trust gates; `doctor-triage.ts` owns what
 * is said about them. Keeping the two apart is what stops a plausible-looking
 * record from becoming a confident sentence: a status record is evidence only
 * while its daemon is live and the record belongs to that incarnation, and a
 * failed remote check is evidence of nothing at all when it never got an answer.
 *
 * Every read here is non-mutating — `loadRawState` rather than `loadState`,
 * whose reset-journal recovery takes the workspace mutex and rewrites state.
 */
import { loadActivity, type DaemonActivity } from "./activity.js";
import { inspectAdoptFence, type AdoptFenceInspection } from "./adopt-journal.js";
import { loadConfig, loadRawState, repoRecordsForState, syncStreamId } from "./config.js";
import { readDaemonPidRecord, type DaemonPidRecord } from "./daemon-control.js";
import { DAEMON_HEARTBEAT_FUTURE_SKEW_MS, isDaemonProcess } from "./daemon/process-control.js";
import { readAmbientDaemonStatusRecord, type AmbientDaemonStatusRecord, type AmbientDaemonStatusV1 } from "./daemon/ambient-status.js";
import { AMBIENT_STATUS_STALE_MS } from "./populate-marker.js";
import { projectGitDeferralRepos, type GitDeferralRepoProjection } from "./status-view.js";
import type { DoctorChecks } from "./doctor-cmd.js";

export interface TriageInputs {
  root: string;
  checks: DoctorChecks;
  deferrals: GitDeferralRepoProjection[];
  activity?: DaemonActivity;
  ambient: AmbientDaemonStatusRecord;
  pid: DaemonPidRecord;
  daemonRunning: boolean;
  adopt: AdoptFenceInspection;
  now: number;
  cliVersion?: string;
}

export interface TriageReadDeps {
  /** Liveness seam: the only input a test cannot produce by writing files. */
  isDaemonProcess?: typeof isDaemonProcess;
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
  const pid = readDaemonPidRecord(root);
  const alive = deps.isDaemonProcess ?? isDaemonProcess;
  return {
    root,
    checks,
    deferrals,
    activity,
    adopt,
    ambient: readAmbientDaemonStatusRecord(root),
    pid,
    daemonRunning: pid.pid !== undefined && alive(pid.pid),
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
    return projectGitDeferralRepos(
      Object.entries(records).flatMap(([repo, record]) =>
        Object.values(record.deferrals ?? {}).flatMap((deferral) => (deferral ? [{ repo, deferral, record }] : []))),
      now,
    );
  } catch {
    return [];
  }
}

/** True when a remote-dependent check failed WITHOUT proving anything about the
 * account, the keys, or the uploaded history — an outage, a timeout, or a 5xx.
 * Nothing downstream of the service may be called broken on this evidence. */
export function serviceUnverified(checks: DoctorChecks): boolean {
  return !checks.remote.ok
    || checks.credentials.inconclusive === true
    || checks.chain?.inconclusive === true
    || checks.version.inconclusive === true;
}

/** The daemon's activity sidecar is residue once its daemon is gone or has
 * rebound elsewhere: a restart re-evaluates every halt and quota refusal, so
 * status drops it (status-view.ts) and diagnosis must drop it too. */
export function daemonOwnsActivity(input: TriageInputs): boolean {
  return input.daemonRunning && input.checks.daemon.status !== "stale";
}

export interface LiveAmbient {
  status: AmbientDaemonStatusV1;
  /** The record provably came from the live v2 pidfile's incarnation, which
   * design 178 requires before `mode` is authoritative. */
  bootBound: boolean;
}

/** The status record describes ONE daemon incarnation. It is evidence only
 * while that incarnation is the live one: the process is alive and bound to
 * this workspace, and the heartbeat is neither stale nor future-dated. */
export function liveAmbient(input: TriageInputs): LiveAmbient | undefined {
  if (input.ambient.kind !== "ok" || !daemonOwnsActivity(input)) return undefined;
  const status = input.ambient.status;
  const age = input.now - Date.parse(status.heartbeatAt);
  if (!Number.isFinite(age) || age > AMBIENT_STATUS_STALE_MS || age < -DAEMON_HEARTBEAT_FUTURE_SKEW_MS) return undefined;
  return {
    status,
    bootBound: status.bootId !== undefined && input.pid.bootId !== undefined && status.bootId === input.pid.bootId,
  };
}
