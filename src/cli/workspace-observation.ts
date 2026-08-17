/**
 * One bounded, read-only workspace observation. This is deliberately not an
 * atomic filesystem snapshot: each admitted sidecar read validates daemon
 * attribution immediately before and after it reads.
 *
 * `ambient` is the cheap default used by status: config identity and the closed
 * daemon verdict. The returned activity capability is the verdict-gated
 * enrichment status can defer until after its halt fast path. `local` adds it
 * plus doctor's non-mutating state/deferral and adoption inspection. No
 * operation performs maintenance, recovery, remote I/O, or rendering policy.
 */
import { loadActivity, type DaemonActivity } from "./activity.js";
import { inspectAdoptFence, type AdoptFenceInspection } from "./adopt-journal.js";
import {
  loadConfig,
  loadRawState,
  repoRecordsForState,
  syncStreamId,
  type WorkspaceConfig,
} from "./config.js";
import { observeDaemon, type DaemonObservation, type DaemonObservationDeps } from "./daemon/observation.js";
import { daemonProcessMatches } from "./daemon/process-identity.js";
import { currentWorkspaceId } from "./daemon/runtime-state.js";
import { readMergedDaemonLogTail } from "./daemon-control.js";
import { loadMetrics, type SyncMetrics } from "./metrics.js";
import { scopeProjectionFor } from "./scope/projection.js";
import { projectGitDeferralRepos, type GitDeferralRepoProjection } from "./status-view/git-projection.js";

const PROCESS_PROBE_TTL_MS = 1_000;

interface WorkspaceObservationBase {
  root: string;
  observedAt: number;
  config: WorkspaceConfig;
  daemon: DaemonObservation;
  readActivity: () => Promise<DaemonActivity | undefined>;
}

interface DaemonSidecars {
  daemonLogTail: string;
  metrics: SyncMetrics;
  activity?: DaemonActivity;
}

export interface AmbientWorkspaceObservation extends WorkspaceObservationBase {
  depth: "ambient";
}

export interface LocalWorkspaceObservation extends WorkspaceObservationBase {
  depth: "local";
  activity?: DaemonActivity;
  deferrals: GitDeferralRepoProjection[];
  adopt: AdoptFenceInspection;
  readDaemonSidecars: () => Promise<DaemonSidecars | undefined>;
}

type WorkspaceObservation = AmbientWorkspaceObservation | LocalWorkspaceObservation;

interface AmbientObservationRequest {
  depth?: "ambient";
  now?: number;
  /** The daemon record/process reads. Injecting them here — rather than around
   * the observation — keeps the authorization rule itself unstubbable. */
  daemon?: DaemonObservationDeps;
}

interface LocalObservationRequest {
  depth: "local";
  now?: number;
  daemon?: DaemonObservationDeps;
}

async function readDeferrals(
  root: string,
  config: WorkspaceConfig,
  now: number,
): Promise<GitDeferralRepoProjection[]> {
  try {
    const state = await loadRawState(root);
    if (!state) return [];
    if (state.stream !== undefined && state.stream !== syncStreamId(config)) return [];
    const records = repoRecordsForState(state);
    const scope = await scopeProjectionFor(root, Object.keys(records));
    return projectGitDeferralRepos(
      Object.entries(records)
        .filter(([repo]) => scope === undefined || scope.classifyRepo(repo) === "in")
        .flatMap(([repo, record]) => Object.values(record.deferrals ?? {})
          .flatMap((deferral) => (deferral ? [{ repo, deferral, record }] : []))),
      now,
    );
  } catch {
    return [];
  }
}

export async function observeWorkspace(
  root: string,
  request?: AmbientObservationRequest,
): Promise<AmbientWorkspaceObservation>;
export async function observeWorkspace(
  root: string,
  request: LocalObservationRequest,
): Promise<LocalWorkspaceObservation>;
export async function observeWorkspace(
  root: string,
  request: AmbientObservationRequest | LocalObservationRequest = {},
): Promise<WorkspaceObservation> {
  const observedAt = request.now ?? Date.now();
  const config = await loadConfig(root);
  const observedWorkspaceId = config.remoteWorkspaceId;
  // The only cached read: `daemonProcessMatches` runs a blocking `ps`, and a
  // doctor run revalidates up to ten times. Liveness cannot flip and flip back
  // within the window; workspace identity and the daemon records are re-read
  // every time, so nothing that decides attribution is cached.
  let probe: { at: number; pid: number; root: string; alive: boolean } | undefined;
  const probeProcess = request.daemon?.processMatches ?? daemonProcessMatches;
  const daemonDeps: DaemonObservationDeps = {
    ...request.daemon,
    processMatches: (pid, probedRoot) => {
      const at = Date.now();
      if (probe?.pid === pid && probe.root === probedRoot && at - probe.at < PROCESS_PROBE_TTL_MS) return probe.alive;
      const alive = probeProcess(pid, probedRoot);
      probe = { at, pid, root: probedRoot, alive };
      return alive;
    },
  };
  const daemon = observeDaemon(root, observedWorkspaceId, observedAt, daemonDeps);
  /** Re-observe against the workspace's identity AS IT IS NOW. `rbox init` can
   * rebind this root mid-run, and every daemon-owned byte then belongs to the
   * PREVIOUS workspace — a re-check against the captured id would admit it. */
  const reobserveDaemon = (): DaemonObservation | undefined =>
    currentWorkspaceId(root) === observedWorkspaceId
      ? observeDaemon(root, observedWorkspaceId, Date.now(), daemonDeps)
      : undefined;
  const activityAuthorized = (current: DaemonObservation | undefined) =>
    current !== undefined && (!current.running || current.ownsRoot);
  // Missing bindings are a supported legacy/stopped-residue case. Foreign and
  // unreadable bindings fail closed, both before and after the physical reads.
  const sidecarsAuthorized = (current: DaemonObservation | undefined) =>
    current !== undefined
    && current.sidecarBinding !== "other-workspace"
    && current.sidecarBinding !== "unreadable";
  const readActivity = async (): Promise<DaemonActivity | undefined> => {
    if (!activityAuthorized(reobserveDaemon())) return undefined;
    const activity = await loadActivity(root).catch(() => undefined);
    return activityAuthorized(reobserveDaemon()) ? activity : undefined;
  };
  const base: WorkspaceObservationBase = {
    root,
    observedAt,
    config,
    daemon,
    readActivity,
  };
  if (request.depth !== "local") return { ...base, depth: "ambient" };

  const localBase: AmbientWorkspaceObservation = { ...base, depth: "ambient" };
  const [activity, deferrals, adopt] = await Promise.all([
    localBase.readActivity(),
    readDeferrals(root, config, observedAt),
    inspectAdoptFence(root).catch((error: unknown) => ({
      status: "corrupt" as const,
      reason: error instanceof Error ? error.message : String(error),
    })),
  ]);
  const readDaemonSidecars = async (): Promise<DaemonSidecars | undefined> => {
    if (!sidecarsAuthorized(reobserveDaemon())) return undefined;
    const [daemonLogTail, metrics, sidecarActivity] = await Promise.all([
      readMergedDaemonLogTail(root, 64 * 1024),
      loadMetrics(root),
      loadActivity(root).catch(() => undefined),
    ]);
    return sidecarsAuthorized(reobserveDaemon())
      ? { daemonLogTail, metrics, activity: sidecarActivity }
      : undefined;
  };
  return { ...base, depth: "local", activity, deferrals, adopt, readDaemonSidecars };
}
