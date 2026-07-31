import {
  AMBIENT_STATUS_STALE_MS,
  readAmbientDaemonStatusRecord,
  validDaemonVersion,
  type AmbientDaemonStatusRecord,
  type AmbientDaemonStatusV1,
  type DaemonMode,
} from "./ambient-status.js";
import { daemonProcessMatches } from "./process-identity.js";
import {
  readDaemonBindingRecord,
  readDaemonPidRecord,
  type DaemonBindingRecord,
  type DaemonPidRecord,
} from "./runtime-state.js";

export const DAEMON_HEARTBEAT_FUTURE_SKEW_MS = 2 * 60_000;

export type DaemonOwnership =
  | "stopped"
  | "unbound"
  | "wrong-workspace"
  | "record-format-mismatch"
  | "binding-boot-mismatch"
  | "owned";

export type DaemonAmbientTrust =
  | "trusted"
  | "absent"
  | "corrupt"
  | "daemon-stopped"
  | "binding-untrusted"
  | "pid-boot-unbound"
  | "ambient-boot-unbound"
  | "boot-mismatch"
  | "invalid-heartbeat"
  | "stale"
  | "future";

/**
 * The single read-only answer about a workspace daemon.
 *
 * `running` proves an exact root-scoped process. `ownsWorkspace` additionally
 * proves its startup binding. `trustedAmbient` is present only when the ambient
 * record belongs to that live incarnation and its heartbeat is current.
 */
export interface DaemonObservation {
  ownership: DaemonOwnership;
  running: boolean;
  pid?: number;
  bootId?: string;
  boundWorkspaceId?: string;
  /** Compatibility/user-facing meaning: a live daemon explicitly bound to a
   * different workspace. Missing or boot-untrusted binding remains unknown. */
  stale: boolean;
  ownsWorkspace: boolean;
  ambient: AmbientDaemonStatusRecord;
  ambientTrust: DaemonAmbientTrust;
  trustedAmbient?: AmbientDaemonStatusV1;
  version?: string;
  mode?: DaemonMode;
}

export interface DaemonObservationDeps {
  readPid?: (root: string) => DaemonPidRecord;
  readBinding?: (root: string) => DaemonBindingRecord;
  readAmbient?: (root: string) => AmbientDaemonStatusRecord;
  processMatches?: (pid: number, root: string) => boolean;
}

interface DaemonObservationSnapshot {
  pid: DaemonPidRecord;
  binding: DaemonBindingRecord;
  ambient: AmbientDaemonStatusRecord;
  processMatches: boolean;
  expectedWorkspaceId?: string;
  now: number;
}

function ownershipOf(snapshot: DaemonObservationSnapshot): DaemonOwnership {
  const { pid, binding, expectedWorkspaceId } = snapshot;
  if (pid.pid === undefined || !snapshot.processMatches) return "stopped";
  if (binding.workspaceId === undefined) return "unbound";
  if (expectedWorkspaceId === undefined || binding.workspaceId !== expectedWorkspaceId) return "wrong-workspace";
  if ((pid.version === "v2") !== (binding.version === "v2")) return "record-format-mismatch";
  if (pid.version === "v2" && binding.version === "v2"
    && (pid.bootId === undefined || binding.bootId === undefined || binding.bootId !== pid.bootId)) {
    return "binding-boot-mismatch";
  }
  return "owned";
}

function ambientTrustOf(
  ownership: DaemonOwnership,
  pid: DaemonPidRecord,
  ambient: AmbientDaemonStatusRecord,
  now: number,
): { trust: DaemonAmbientTrust; status?: AmbientDaemonStatusV1 } {
  if (ambient.kind === "absent") return { trust: "absent" };
  if (ambient.kind === "corrupt") return { trust: "corrupt" };
  if (ownership === "stopped") return { trust: "daemon-stopped" };
  if (ownership !== "owned") return { trust: "binding-untrusted" };
  if (pid.bootId === undefined) return { trust: "pid-boot-unbound" };
  if (ambient.status.bootId === undefined) return { trust: "ambient-boot-unbound" };
  if (ambient.status.bootId !== pid.bootId) return { trust: "boot-mismatch" };
  const heartbeat = Date.parse(ambient.status.heartbeatAt);
  if (!Number.isFinite(heartbeat)) return { trust: "invalid-heartbeat" };
  const age = now - heartbeat;
  if (age > AMBIENT_STATUS_STALE_MS) return { trust: "stale" };
  if (age < -DAEMON_HEARTBEAT_FUTURE_SKEW_MS) return { trust: "future" };
  return { trust: "trusted", status: ambient.status };
}

/** Pure core kept private so adapters cannot assemble a parallel trust path. */
function classifyDaemonObservation(snapshot: DaemonObservationSnapshot): DaemonObservation {
  const ownership = ownershipOf(snapshot);
  const ambient = ambientTrustOf(ownership, snapshot.pid, snapshot.ambient, snapshot.now);
  const running = ownership !== "stopped";
  const stale = ownership === "wrong-workspace";
  const trusted = ambient.status;
  return {
    ownership,
    running,
    ...(running && snapshot.pid.pid !== undefined ? { pid: snapshot.pid.pid } : {}),
    ...(running && snapshot.pid.bootId !== undefined ? { bootId: snapshot.pid.bootId } : {}),
    ...(running && snapshot.binding.workspaceId !== undefined
      ? { boundWorkspaceId: snapshot.binding.workspaceId }
      : {}),
    stale,
    ownsWorkspace: ownership === "owned",
    ambient: snapshot.ambient,
    ambientTrust: ambient.trust,
    ...(trusted === undefined ? {} : { trustedAmbient: trusted }),
    ...(trusted !== undefined && validDaemonVersion(trusted.daemonVersion)
      ? { version: trusted.daemonVersion }
      : {}),
    ...(trusted?.mode === undefined ? {} : { mode: trusted.mode }),
  };
}

export function observeDaemon(
  root: string,
  expectedWorkspaceId: string | undefined,
  now = Date.now(),
  deps: DaemonObservationDeps = {},
): DaemonObservation {
  const pid = (deps.readPid ?? readDaemonPidRecord)(root);
  const binding = (deps.readBinding ?? readDaemonBindingRecord)(root);
  const ambient = (deps.readAmbient ?? readAmbientDaemonStatusRecord)(root);
  const processMatches = pid.pid !== undefined
    && (deps.processMatches ?? daemonProcessMatches)(pid.pid, root);
  return classifyDaemonObservation({
    pid,
    binding,
    ambient,
    processMatches,
    expectedWorkspaceId,
    now,
  });
}

/**
 * Compatibility projection for process-control callers. The truth calculation
 * remains in `observeDaemon`; this shape is retained for supported imports.
 */
export function daemonBindingStatus(root: string, workspaceId: string): {
  alive: { running: boolean; pid?: number; bootId?: string };
  bound?: string;
  stale: boolean;
} {
  const observation = observeDaemon(root, workspaceId);
  return {
    alive: observation.running
      ? { running: true, ...(observation.pid === undefined ? {} : { pid: observation.pid }), ...(observation.bootId === undefined ? {} : { bootId: observation.bootId }) }
      : { running: false },
    ...(observation.running && observation.boundWorkspaceId !== undefined
      ? { bound: observation.boundWorkspaceId }
      : {}),
    stale: observation.stale,
  };
}
