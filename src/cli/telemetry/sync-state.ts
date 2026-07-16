import { ensureTelemetryBindingId, repoRecordsForState, type GitDeferralReason, type SyncState as LocalSyncState, type WorkspaceConfig } from "../config.js";
import { projectGitDeferralRepos } from "../status-view.js";
import { SYNC_STATE_NUMERIC_DOMAINS, type SyncState, type SyncStateEnvelope } from "./contract.js";
import type { TelemetryTransport } from "./queue.js";

const enabled = (): boolean => process.env.RBOX_TELEMETRY !== "0";

export function buildSyncStateSummary(
  cfg: Pick<WorkspaceConfig, "remoteWorkspaceId" | "projectId">,
  state: LocalSyncState,
  bindingId: string,
  now = Date.now(),
  records = repoRecordsForState(state),
): SyncState {
  const entries = Object.entries(records).flatMap(([repo, record]) =>
    Object.values(record.deferrals ?? {}).filter((value): value is NonNullable<typeof value> => value !== undefined)
      .map((deferral) => ({ repo, deferral, record })),
  );
  const projected = projectGitDeferralRepos(entries, now);
  const deferredRepos = new Set(projected.map((repo) => repo.repo));
  const reasons = new Set<GitDeferralReason>(
    entries.filter((entry) => deferredRepos.has(entry.repo)).map((entry) => entry.deferral.reason),
  );
  let oldestDeferralAgeMs: number | null = null;
  if (projected.length > 0) {
    const oldest = Math.min(...projected.map((repo) => Date.parse(repo.oldestDeferredSince)).filter(Number.isFinite));
    oldestDeferralAgeMs = Number.isFinite(oldest)
      ? Math.min(SYNC_STATE_NUMERIC_DOMAINS.oldestDeferralAgeMs.max, Math.max(0, Math.round(now - oldest)))
      : 0;
  }
  return {
    workspaceId: cfg.remoteWorkspaceId,
    projectId: cfg.projectId,
    bindingId,
    fileSeq: state.lastSyncedSequence,
    reposTotal: Object.keys(records).length,
    reposDeferred: projected.length,
    oldestDeferralAgeMs,
    deferralReasons: [...reasons].sort().slice(0, 15),
  };
}

export class SyncStateReporter {
  private lastFingerprint?: string;
  private chain: Promise<void> = Promise.resolve();
  private failures = 0;
  /** Resolved once per daemon lifetime: re-acquiring the state lock every pump op is
   *  wasted churn, and a concurrent sync save from a pre-write in-memory state can drop
   *  the persisted field — the cache keeps this daemon's identity stable regardless. */
  private bindingId?: string;

  constructor(
    private readonly root: string,
    private readonly cfg: Pick<WorkspaceConfig, "remoteWorkspaceId" | "projectId" | "remoteUrl">,
    private readonly transport: TelemetryTransport,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  afterSyncTick(state: LocalSyncState): void { this.enqueue(state, false); }
  heartbeat(state: LocalSyncState): void { this.enqueue(state, true); }

  private enqueue(state: LocalSyncState, force: boolean): void {
    if (!enabled()) return;
    this.chain = this.chain.then(() => this.send(state, force)).catch(() => {});
  }

  private async send(state: LocalSyncState, force: boolean): Promise<void> {
    if (!enabled()) return;
    try {
      this.bindingId ??= (await ensureTelemetryBindingId(this.root, state.stream)).bindingId;
      const records = repoRecordsForState(state);
      const summary = buildSyncStateSummary(this.cfg, state, this.bindingId, this.now(), records);
      // Ages advance continuously; they are refreshed by the hourly heartbeat, not a
      // reason to report every otherwise-unchanged sync tick. The persisted deferral
      // boundaries still make a new/restarted episode fingerprint differently.
      const deferralBoundaries = Object.values(records).flatMap((record) =>
        Object.values(record.deferrals ?? {}).filter((value): value is NonNullable<typeof value> => value !== undefined)
          .map((deferral) => `${deferral.lane}:${deferral.deferredSince}:${deferral.reason}`),
      ).sort();
      const fingerprint = JSON.stringify({
        fileSeq: summary.fileSeq,
        reposTotal: summary.reposTotal,
        reposDeferred: summary.reposDeferred,
        deferralReasons: summary.deferralReasons,
        deferralBoundaries,
      });
      if (!force && fingerprint === this.lastFingerprint) return;
      const envelope: SyncStateEnvelope = { v: 1, states: [summary] };
      const response = await this.transport.postJson("/v1/fleet/sync-state", envelope, {
        retries: 0,
        signal: AbortSignal.timeout(1500),
      });
      if (response.status !== 202) throw new Error(`HTTP ${response.status}`);
      this.lastFingerprint = fingerprint;
      this.failures = 0;
      try {
        const body = await response.json() as { dropped?: unknown };
        if (typeof body.dropped === "number" && body.dropped > 0) this.log(`sync-state server dropped ${body.dropped} state(s)`);
      } catch { /* optional diagnostics */ }
    } catch {
      this.failures++;
      if ((this.failures & (this.failures - 1)) === 0) this.log(`sync-state report failed (${this.failures} attempt${this.failures === 1 ? "" : "s"})`);
    }
  }
}
