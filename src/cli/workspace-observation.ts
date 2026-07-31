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
import { observeDaemon, type DaemonObservation } from "./daemon/observation.js";
import { readMergedDaemonLogTail } from "./daemon-control.js";
import { loadMetrics, type SyncMetrics } from "./metrics.js";
import { scopeProjectionFor } from "./scope/projection.js";
import { projectGitDeferralRepos, type GitDeferralRepoProjection } from "./status-view.js";

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
}

interface LocalObservationRequest {
  depth: "local";
  now?: number;
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
  const daemon = observeDaemon(root, config.remoteWorkspaceId, observedAt);
  const reobserveDaemon = () => observeDaemon(root, config.remoteWorkspaceId, Date.now());
  const activityAuthorized = (current: DaemonObservation) => !current.running || current.ownsWorkspace;
  // Missing bindings are a supported legacy/stopped-residue case. Foreign and
  // unreadable bindings fail closed, both before and after the physical reads.
  const sidecarsAuthorized = (current: DaemonObservation) =>
    current.sidecarBinding !== "other-workspace" && current.sidecarBinding !== "unreadable";
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
