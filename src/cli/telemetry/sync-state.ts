/** Never: alert evaluation or sync-state mutation. */
import { ensureTelemetryBindingId, repoRecordsForState, type GitDeferralReason, type SyncState as LocalSyncState, type WorkspaceConfig } from "../config.js";
import { projectGitDeferralRepos } from "../status-view/git-projection.js";
import { SYNC_STATE_NUMERIC_DOMAINS, telemetryEnabled, type SyncState, type SyncStateEnvelope } from "./contract.js";
import type { TelemetryTransport } from "./queue.js";

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
  // Design 273 P2 expects a step change here: ownership-only holds used to
  // delete their record, so they were never reported. They now stand, adding
  // `worktree-ownership` rows and raising `reposDeferred`. The SIZE is not
  // predicted: the captured fleet state (fixtures/field-states) carries zero
  // ownership deferrals, so it predicts a near-zero step; the real step is
  // whatever ownership holds stand at merge, measured on the fleet after the
  // dev build lands. Ownership holds ARE counted in `reposDeferred`, which is
  // what the deferral alert keys on — nothing here excludes them. Splitting the
  // count by actionability is a wire+ingest+alert change, tracked separately.
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
    deferralReasons: [...reasons].sort(),
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

  /** Await all reports enqueued so far. Tests use this instead of guessing when
   *  the deliberately fire-and-forget daemon path has drained. */
  flushForTests(): Promise<void> { return this.chain; }

  private enqueue(state: LocalSyncState, force: boolean): void {
    if (!telemetryEnabled()) return;
    this.chain = this.chain.then(() => this.send(state, force)).catch(() => {});
  }

  private async send(state: LocalSyncState, force: boolean): Promise<void> {
    if (!telemetryEnabled()) return;
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
