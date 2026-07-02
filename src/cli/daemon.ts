import os from "node:os";
import {
  applyWatchEvents,
  buildIgnoreMatcher,
  isIgnoreRuleFile,
  HashCache,
  scanManifest,
  type IgnoreMatcher,
  type Manifest,
  type WatchEvent,
} from "../engine/index.js";
import type { Action } from "../engine/reconcile.js";
import { renderShellLine, saveActivity, saveShellLine, shellStateOf, type DaemonActivity } from "./activity.js";
import { loadState, syncStreamId, trashConfig, type WorkspaceConfig } from "./config.js";
import { pruneTrash } from "../engine/trash.js";
import { recordDaemonBinding } from "./daemon-control.js";
import { pull, pushManifest, type SyncDeps } from "./sync.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { beginReport, loadMetrics, saveMetrics, type SyncMetrics } from "./metrics.js";
import { lowerIoPriority } from "./io-priority.js";
import { RboxApi } from "./remote.js";
import { startWatcher, type Watcher } from "./watcher.js";

const SAFETY_SYNC_MS = 60_000; // frequent stat-only reconcile (heals dropped events)
const SAFETY_SYNC_MAX_MS = 5 * 60_000; // idle-backoff cap for the safety scan (design 49)
const DEEP_SCAN_MS = 30 * 60_000; // infrequent cache-bypassing re-hash (heals mtime+size-stable drift)
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

/** How many changed paths a pull/push log line spells out before eliding. High on
 *  purpose: the daemon log is the ONLY forensic record of what sync did to the tree
 *  ("did rbox delete my files?" must be answerable from it), and pumps are rare. */
const LOG_PATHS_MAX = 50;

/** Control chars in a filename must not forge extra log lines — render them as `?`. */
const cleanPath = (p: string) => p.replace(/\p{Cc}/gu, "?");


/** One-line forensic summary of the actions a pull APPLIED to the local tree:
 *  counts by kind plus the paths themselves (`+`write `-`delete `!`conflict). */
export function summarizeActions(actions: Action[]): string {
  let writes = 0;
  let deletes = 0;
  let conflicts = 0;
  const paths: string[] = [];
  // Only the first LOG_PATHS_MAX paths are rendered at all (a huge pull stays cheap).
  const keep = (prefix: string, p: string) => {
    if (paths.length < LOG_PATHS_MAX) paths.push(prefix + cleanPath(p));
  };
  for (const a of actions) {
    if (a.kind === "write") {
      writes++;
      keep("+", a.entry.path);
    } else if (a.kind === "delete") {
      deletes++;
      keep("-", a.path);
    } else {
      conflicts++;
      keep("!", a.path);
    }
  }
  const more = actions.length > LOG_PATHS_MAX ? ` (+${actions.length - LOG_PATHS_MAX} more)` : "";
  return `${writes} write, ${deletes} delete, ${conflicts} conflict — ${paths.join(" ")}${more}`;
}

interface Wants {
  pull: boolean;
  push: boolean;
  fullScan: boolean;
  deepScan: boolean;
}

/**
 * The rbox daemon: passive, continuous, resource-disciplined sync.
 *
 *  - watcher → incremental manifest patch (O(changed)) → push   [hot path]
 *  - WS "committed" broadcast → pull                            [notification-only]
 *  - safety tick (60s) → stat-only full reconcile               [heals dropped events]
 *  - deep tick (30m) → cache-bypassing re-hash                  [heals silent drift]
 *
 * A single-flight pump serializes all of the above and coalesces redundant
 * requests, so the daemon never races itself into 409 storms.
 */
export class RboxDaemon {
  private readonly api: RboxApi;
  private matcher: IgnoreMatcher; // rebuilt when .gitignore/.rboxignore changes
  private cache!: HashCache;
  private manifest: Manifest = { generatedAt: "", files: [] };
  private pendingEvents: WatchEvent[] = [];

  private watcher?: Watcher;
  private ws?: WebSocket;
  private safetyTimer?: ReturnType<typeof setTimeout>;
  private deepTimer?: ReturnType<typeof setInterval>;
  /** Current safety-scan delay (60s floor, backs off to 5m while idle — design 49). */
  private safetyDelay = SAFETY_SYNC_MS;
  /** Watcher events seen since the last safety tick — churn pins the scan to its floor. */
  private churnSinceSafety = false;
  /** Flips false on ANY post-init backend error and stays false: a watcher that has
   *  errored once is no longer trusted to have delivered everything, so the safety
   *  scan never backs off again (fail-safe toward pre-design-49 behavior). */
  private watcherHealthy = true;
  private reconnectAttempt = 0;
  private stopped = false;
  /** Per-path retry counter for hot-path write-finish: a mid-write file is re-pushed a
   *  few times before falling back to the safety scan, so a large save isn't stalled 60s. */
  private readonly writeFinishRetries = new Map<string, number>();
  /** Pump-error dedup (see the pump catch) + last logged commit sequence (doPush). */
  private lastErrMsg = "";
  private errRepeat = 0;
  private lastLoggedSeq?: number;
  /** The watcher factory. Real native-backed `startWatcher` by default; an injectable seam
   *  so the "watcher init rejects → reconcile loops stay armed" invariant is testable without
   *  a process-global module mock (which leaks across test files). */
  private startWatcherFn: typeof startWatcher = startWatcher;

  private readonly want: Wants = { pull: false, push: false, fullScan: false, deepScan: false };
  private pumping = false;
  private metrics: SyncMetrics = { syncs: 0, commitConflicts409: 0, fileConflicts: 0 };
  /** In-memory activity record mirrored to `.rbox/state/activity.json` (design 45) —
   *  what `rbox status` reads for the health verdict, last-sync trail, live transfer
   *  progress, and (crucially) the mass-delete-guard halt warning. */
  private readonly activity: DaemonActivity = { at: new Date().toISOString() };
  private activityDirty = false; // a `last`/halt change that must persist un-throttled
  private lastActivityWrite = 0;
  private lastProgressWrite = 0;

  /** `e2ee` is the E2EE sync transport (deps.remote) — every push/pull goes
   *  through it so the daemon syncs encrypted, exactly like the one-shot commands. */
  constructor(private readonly root: string, private readonly cfg: WorkspaceConfig, private readonly e2ee: SyncDeps) {
    this.api = new RboxApi(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId);
    this.matcher = buildIgnoreMatcher(root);
  }

  async start(): Promise<void> {
    // Be a background citizen: lose the CPU race to the developer's own tools.
    try {
      os.setPriority(0, 10);
    } catch {
      /* setpriority may be denied; not fatal */
    }
    // ...and the DISK race too (design 49): macOS throttle tier / linux BE-7.
    log(`io priority: ${lowerIoPriority()}`);

    this.cache = await HashCache.load(this.root);
    this.metrics = await loadMetrics(this.root);
    log(`rbox daemon starting: ${this.root} → workspace ${this.cfg.remoteWorkspaceId} (device ${this.cfg.deviceId})`);
    // Record the binding so `rbox start` can tell a live daemon from a STALE one
    // (bound to a workspace this root was since re-initialized away from).
    await recordDaemonBinding(this.root, this.cfg.remoteWorkspaceId);
    // Seed the push log's sequence memory so the first no-op push (re-publishing
    // nothing) isn't logged as an advance.
    this.lastLoggedSeq = (await loadState(this.root, syncStreamId(this.cfg))).lastSyncedSequence;

    // Initial convergence: full scan, then a real pull+push cycle.
    this.manifest = await scanManifest(this.root, this.matcher, this.cache);
    this.pruneCache();
    await this.cache.save(this.root);
    this.want.pull = true;
    this.want.push = true;
    await this.pump();

    await this.startLiveWatch();
    this.connect();

    log(this.watcher ? "rbox daemon ready" : "rbox daemon ready (periodic-scan mode; no live watch)");
  }

  /**
   * Arm the reconcile loops, then try the live watcher — in that order, so the
   * correctness floor exists BEFORE the watcher can fail. A rejected watcher init
   * (no native binding, inotify exhaustion, unsupported FS) is caught and degraded to
   * periodic full-scan reconciliation; sync is NEVER left silently dead. This ordering
   * is load-bearing and covered by a dedicated test.
   */
  private async startLiveWatch(): Promise<void> {
    this.scheduleSafetyScan();
    this.deepTimer = setInterval(() => this.request("deepScan"), jitter(DEEP_SCAN_MS));
    try {
      this.watcher = await this.startWatcherFn(
        this.root,
        this.matcher,
        (events) => {
          this.noteChurn();
          this.pendingEvents.push(...events);
          this.request("push");
        },
        {
          onError: (err) => {
            // One backend error and the watcher is no longer TRUSTED (codex R1): a
            // dead FSEvents/inotify stream must not let the safety scan — now the
            // only healer — sit backed off at 5m. Sync itself is unaffected. An
            // already-armed backed-off timer is pulled forward too (codex R2) —
            // the flag alone would wait out the remaining timeout.
            if (this.watcherHealthy) log(`watcher error: ${err.message} — safety scan pinned to its ${Math.round(SAFETY_SYNC_MS / 1000)}s floor`);
            this.watcherHealthy = false;
            this.pinSafetyFloor();
          },
        }
      );
    } catch (e) {
      log(`live watch unavailable: ${e instanceof Error ? e.message : String(e)} — degrading to periodic scan every ${Math.round(SAFETY_SYNC_MS / 1000)}s`);
    }
  }

  /** Record watcher churn AND pull a backed-off safety timer forward (codex R1):
   *  the flag alone would let a drop from THIS storm wait out an armed 5m timer —
   *  the scan must return to its 60s cadence the moment there is churn to protect. */
  private noteChurn(): void {
    this.churnSinceSafety = true;
    this.pinSafetyFloor();
  }

  /** Re-arm a backed-off safety timer at the 60s floor NOW. Shared by churn and
   *  watcher-error (codex R2): both mean "the next scan matters — don't wait out
   *  an armed 5m timeout". No-op at the floor, so it can never double-schedule. */
  private pinSafetyFloor(): void {
    if (this.safetyDelay > SAFETY_SYNC_MS && !this.stopped) {
      this.safetyDelay = SAFETY_SYNC_MS;
      if (this.safetyTimer) clearTimeout(this.safetyTimer);
      this.scheduleSafetyScan();
    }
  }

  /**
   * Self-rescheduling safety tick (design 49). The safety scan heals DROPPED
   * watcher events, and drops happen under churn — so quiet intervals (zero
   * watcher events since the previous tick) double the next delay up to 5m,
   * instead of stat-sweeping every tracked file each minute on an idle
   * machine, forever. Any event snaps the delay back to the 60s floor (armed
   * timers are pulled forward by noteChurn), and a missing OR unhealthy live
   * watcher never backs off (there, the scan IS the sync mechanism). The 30m
   * deep scan stays the unconditional floor beneath both.
   */
  private scheduleSafetyScan(): void {
    this.safetyTimer = setTimeout(() => {
      if (this.stopped) return;
      this.safetyDelay = nextSafetyDelay(this.safetyDelay, {
        watcherLive: this.watcher !== undefined && this.watcherHealthy,
        churned: this.churnSinceSafety,
      });
      this.churnSinceSafety = false;
      this.request("fullScan");
      this.scheduleSafetyScan();
    }, jitter(this.safetyDelay));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    if (this.deepTimer) clearInterval(this.deepTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    await this.watcher?.close();
    // DRAIN the in-flight pump before declaring stopped: SIGTERM shutdown awaits
    // stop(), so this is what makes termination actually graceful — the current
    // op (an applyGitState, a write, an upload) COMPLETES; only queued work is
    // skipped (the loop re-checks `stopped`). Without this, `rbox start`'s stale-
    // daemon restart could interrupt a mutation mid-flight.
    await this.pumpRun.catch(() => {});
    await this.activityWrite.catch(() => {}); // flush the final sidecar record (best-effort)
    await this.cache?.save(this.root).catch(() => {});
    log("rbox daemon stopped");
  }

  // ---- single-flight pump --------------------------------------------------

  private request(kind: keyof Wants): void {
    this.want[kind] = true;
    void this.pump();
  }

  /** The in-flight pump loop, if any — awaited by stop() so shutdown drains it. */
  private pumpRun: Promise<void> = Promise.resolve();

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    const run = this.pumpLoop();
    this.pumpRun = run;
    return run;
  }

  private async pumpLoop(): Promise<void> {
    try {
      while (!this.stopped && (this.want.pull || this.want.push || this.want.fullScan || this.want.deepScan)) {
        // Resolve WHICH op this iteration runs up front — the halt bookkeeping below
        // is keyed on it (a halt is only healed by a success of the SAME kind).
        const op: keyof Wants = this.want.deepScan ? "deepScan" : this.want.fullScan ? "fullScan" : this.want.pull ? "pull" : "push";
        try {
          this.want[op] = false;
          if (op === "deepScan") {
            await this.doDeepScan();
            this.want.push = true;
          } else if (op === "fullScan") {
            await this.doFullScan();
            this.want.push = true;
          } else if (op === "pull") {
            await this.doPull();
            this.want.push = true; // publish any local divergence after taking remote
          } else {
            await this.doPush();
          }
          // Op completed: any live progress is over. A standing halt is healed ONLY by
          // a success of the op kind that recorded it — a mass-delete-guard halt from a
          // pull must survive the queued push's no-op success and every safety scan
          // (codex R1 BLOCKER: anything less flaps the warning off within seconds).
          // Persist when something visible changed (or as a throttled heartbeat, so
          // `rbox status` can say "last checked: Ns ago" without idle disk churn).
          const heals = this.activity.halt !== undefined && this.activity.halt.op === op;
          const cleared = this.activity.active !== undefined || heals;
          this.activity.active = undefined;
          if (heals) {
            this.activity.halt = undefined;
            // The healed failure's dedup streak ends with it: a LATER failure with the
            // same message is a new episode that must log and persist a fresh halt —
            // not silently count as repeat 2..9 and leave activity.json healed (codex R4).
            this.lastErrMsg = "";
            this.errRepeat = 0;
          }
          if (cleared || this.activityDirty || Date.now() - this.lastActivityWrite > 30_000) this.writeActivity();
        } catch (e) {
          // Dedup a persistent error (e.g. a dead workspace 404s on EVERY op): log the
          // first hit and every 10th after, with the running count — so the log stays
          // readable while still showing exactly how long the failure has persisted.
          const msg = e instanceof Error ? e.message : String(e);
          this.errRepeat = msg === this.lastErrMsg ? this.errRepeat + 1 : 1;
          this.lastErrMsg = msg;
          // The halt record is the failure's user-visible surface (design 45): without
          // it a mass-delete-guard refusal (design 44) stalls background sync with no
          // indicator anywhere but this log. Persisted on the log-line schedule.
          this.activity.active = undefined;
          this.activity.halt = { at: new Date().toISOString(), reason: msg, count: this.errRepeat, op };
          if (this.errRepeat === 1 || this.errRepeat % 10 === 0) {
            log(`pump op error: ${msg}${this.errRepeat > 1 ? ` (x${this.errRepeat})` : ""}`);
            this.writeActivity();
          }
          await sleep(jitter(1000)); // brief backoff so a persistent error can't hot-loop
        }
      }
      await this.cache.save(this.root);
      // Settle the sidecar (codex R4 P1): all wants are drained here, so re-render if
      // the state CHANGED from the last write — the mid-pump write said `pending`
      // (push still queued) and the no-op push wrote nothing; an idle workspace must
      // read `ok`. State-compared, so a truly unchanged pump writes nothing extra.
      const settledNow =
        !this.want.pull && !this.want.push && !this.want.fullScan && !this.want.deepScan && this.pendingEvents.length === 0;
      if (shellStateOf(this.activity, settledNow) !== this.lastShellState) this.writeActivity();
    } finally {
      this.pumping = false;
    }
  }

  private async doPush(): Promise<void> {
    if (this.pendingEvents.length > 0) {
      const events = this.pendingEvents;
      this.pendingEvents = [];
      // If the ignore rules themselves changed, rebuild the matcher and full-rescan
      // so newly-ignored paths are dropped (and re-included ones picked up) — the
      // incremental matcher would otherwise be stale until restart. [M3b]
      if (events.some((e) => isIgnoreRuleFile(e.relPath))) {
        this.matcher = buildIgnoreMatcher(this.root);
        this.manifest = await scanManifest(this.root, this.matcher, this.cache);
      } else {
        const deferred = new Set<string>();
        this.manifest = await applyWatchEvents(this.manifest, this.root, this.matcher, events, this.cache, deferred);
        // A path that hashed cleanly this round is settled — clear any retry it accrued.
        for (const e of events) if (!deferred.has(e.relPath)) this.writeFinishRetries.delete(e.relPath);
        if (deferred.size > 0) this.scheduleWriteFinishRetry(deferred);
      }
    }
    const report = beginReport("push");
    const res = await pushManifest(this.root, this.cfg, this.manifest, {
      ...this.e2ee,
      cache: this.cache,
      onCommitConflict: () => this.bumpConflict("commit"),
      report,
      onGitLog: log, // design 43 §10: capture/carry/defer/remove forensics in the daemon log
      onProgress: (done, total, phase) => this.onTransferProgress(done, total, phase), // design 45: live % in `rbox status`
      onPullApplied: (a) => this.recordPullApplied(a), // design 45: the 409-recovery pull mutates the tree too
      onTypeFlip: (rel) => this.noteTypeFlip(rel), // design 50: 409-recovery pull can evict a dir too
    });
    this.manifest = res.manifest; // stays fresh even across a conflict re-scan (committed subset)
    // Forensic record: every ADVANCE of the remote sequence this daemon caused, with the
    // resulting tree size and anything it had to defer. Gated on `committed` (design 44):
    // a push whose internal 409-recovery PULLED a remote sequence and then no-opped must
    // not be logged as if THIS daemon published it — and the steady-state no-op stays
    // silent so it doesn't fill the log.
    if (res.committed && res.sequence !== this.lastLoggedSeq) {
      const deferredNote =
        res.deferred && res.deferred.length > 0
          ? `; deferred ${res.deferred.length}: ${res.deferred.slice(0, LOG_PATHS_MAX).map(cleanPath).join(" ")}`
          : "";
      log(`push: published sequence ${res.sequence} (${res.manifest.files.length} files${deferredNote})`);
    }
    this.lastLoggedSeq = res.sequence;
    if (res.committed) {
      // The status trail: "last push: 2m ago — N files → sequence S" (design 45).
      // Its own slot — it must never mask what a recovery pull applied (codex R2).
      this.activity.lastPush = { at: new Date().toISOString(), files: res.manifest.files.length, sequence: res.sequence };
      this.activityDirty = true;
    }
    // Files deferred because they were still changing under the push: re-enqueue them
    // promptly (bounded) rather than waiting for the 60s safety scan. Reuses the same
    // per-path retry budget as mid-write files — a pathologically-churning file gives up
    // to the safety/deep scan instead of hot-looping. res.manifest already carries their
    // base (or omits them), so a genuine settle is re-detected by the change event's re-hash.
    if (res.deferred && res.deferred.length > 0) this.scheduleWriteFinishRetry(new Set(res.deferred));
    this.metrics.syncs += 1;
    await saveMetrics(this.root, this.metrics);
    report?.logSummaryTo(log); // §35: silent on a no-op tick (nothing recorded)
  }

  /**
   * Re-enqueue mid-write paths as `change` events after a short quiet, so a large save
   * that was still being written when we hashed gets picked up promptly rather than
   * waiting for the 60s safety scan. Bounded per path — after a few tries we give up and
   * let the safety/deep scan be the floor, so a pathological never-settling file can't
   * hot-loop the pump forever.
   */
  private scheduleWriteFinishRetry(paths: Set<string>): void {
    const MAX_RETRIES = 15; // ~3s of retrying at RETRY_DELAY_MS before deferring to safety scan
    const RETRY_DELAY_MS = 200;
    const retryable: string[] = [];
    for (const p of paths) {
      const n = (this.writeFinishRetries.get(p) ?? 0) + 1;
      if (n <= MAX_RETRIES) {
        this.writeFinishRetries.set(p, n);
        retryable.push(p);
      } else {
        this.writeFinishRetries.delete(p); // give up; the safety scan will heal it
      }
    }
    if (retryable.length === 0 || this.stopped) return;
    setTimeout(() => {
      if (this.stopped) return;
      for (const p of retryable) this.pendingEvents.push({ relPath: p, kind: "change" });
      this.request("push");
    }, RETRY_DELAY_MS);
  }

  private async doPull(): Promise<void> {
    const report = beginReport("pull");
    // onGitLog: per-repo apply/conflict/defer forensics (design 43 §10) land in the daemon log.
    // onPullApplied carries BOTH the forensic log line and the status trail — wired
    // here and in doPush's deps so the pull inside push's 409 recovery is recorded
    // identically (codex R2: its actions are discarded by the retry loop).
    const actions = await pull(this.root, this.cfg, {
      ...this.e2ee,
      cache: this.cache,
      report,
      onGitLog: log,
      onProgress: (done, total, phase) => this.onTransferProgress(done, total, phase), // design 45
      onPullApplied: (a) => this.recordPullApplied(a),
      onTypeFlip: (rel) => this.noteTypeFlip(rel), // design 50 §3: forensic line + conflict count
    });
    report?.logSummaryTo(log);
    const fileConflicts = actions.filter((a) => a.kind === "conflict").length;
    if (fileConflicts > 0) {
      this.metrics.fileConflicts += fileConflicts;
      this.metrics.lastConflictAt = new Date().toISOString();
      await saveMetrics(this.root, this.metrics);
    }
    // A pull that WROTE an ignore-rule file must refresh the matcher before the rescan
    // below and the pump's follow-up push — otherwise that push publishes files the
    // freshly pulled rules exclude (same hazard doPush guards on watcher events).
    if (actions.some((a) => isIgnoreRuleFile(a.kind === "write" ? a.entry.path : a.path))) {
      this.matcher = buildIgnoreMatcher(this.root);
    }
    // The pull advanced the local base sequence; remember it so the follow-up no-op
    // push isn't logged as if THIS daemon published the remotely-produced sequence.
    this.lastLoggedSeq = (await loadState(this.root, syncStreamId(this.cfg))).lastSyncedSequence;
    // Refresh in-memory truth from disk (cache-warm: pull invalidated written paths).
    this.manifest = await scanManifest(this.root, this.matcher, this.cache);
  }

  private bumpConflict(_kind: "commit"): void {
    this.metrics.commitConflicts409 += 1;
    this.metrics.lastConflictAt = new Date().toISOString();
  }

  /** Pending activity persistence — writes CHAIN on this promise so overlapping
   *  saves can never land out of order (an older record must not win). NEVER awaited
   *  on the sync path (a slow sidecar write must not delay a single op — codex R1);
   *  drained only by stop() so graceful shutdown flushes the final record. */
  private activityWrite: Promise<void> = Promise.resolve();
  /** The shell.line state most recently WRITTEN — compared at pump exit so an idle
   *  workspace settles back to `ok` (codex R4 P1: the last op's write can render
   *  `pending` because the follow-up push was still queued, and the no-op push
   *  never writes — without the settle pass the glyph reads pending forever). */
  private lastShellState?: string;

  /** Persist the in-memory activity record. Non-blocking for the caller, and
   *  saveActivity swallows all errors by contract — visibility must never break
   *  (or slow) sync. Snapshot-shallow-copied: `last`/`active`/`halt` are always
   *  replaced wholesale (never mutated in place), so a later mutation of
   *  `this.activity` can't bleed into an in-flight write. */
  private writeActivity(): void {
    this.activity.at = new Date().toISOString();
    this.activityDirty = false;
    this.lastActivityWrite = Date.now();
    const snapshot = { ...this.activity };
    // Design 46: the same record ALSO renders the one-line prompt sidecar, chained
    // onto the same promise so BOTH files preserve write ordering and neither is ever
    // awaited on the sync path. `settled` = nothing queued and no watcher events left.
    const settled =
      !this.want.pull && !this.want.push && !this.want.fullScan && !this.want.deepScan && this.pendingEvents.length === 0;
    this.lastShellState = shellStateOf(snapshot, settled);
    const line = renderShellLine(snapshot, {
      settled,
      sequence: this.lastLoggedSeq,
      name: this.cfg.name ?? this.cfg.remoteWorkspaceId,
      now: Date.now(),
    });
    this.activityWrite = this.activityWrite
      .then(() => saveActivity(this.root, snapshot))
      .then(() => saveShellLine(this.root, line));
  }

  /** Type-flip evictions seen since the last recorded pull (design 50 §3, review M2).
   *  onTypeFlip fires DURING applyActions (before the pull's onPullApplied), so it
   *  accumulates here and recordPullApplied folds it into `lastPull.conflicts` and resets. */
  private typeFlipsSincePull = 0;

  /** A pull moved an obstructing local directory to trash so an incoming file/symlink
   *  could land (the EISDIR-flip heal). Forensic log line + folded into the conflict
   *  count so `rbox status`'s last-pull trail surfaces it. */
  private noteTypeFlip(relPath: string): void {
    log(`pull type-flip conflict: ${cleanPath(relPath)} — local directory moved to trash`);
    this.typeFlipsSincePull++;
  }

  /** Every pull that mutated the local tree — whichever path ran it (doPull, or the
   *  409-recovery pull inside pushManifest). Forensic log line + status trail: this
   *  is the record that answers "did sync change/delete my files?" after the fact. */
  private recordPullApplied(actions: Action[]): void {
    log(`pull applied: ${summarizeActions(actions)}`);
    let writes = 0;
    let deletes = 0;
    let conflicts = 0;
    for (const a of actions) {
      if (a.kind === "write") writes++;
      else if (a.kind === "delete") deletes++;
      else conflicts++;
    }
    // Type-flip evictions are conflicts too (a local dir was moved aside), but they arrive
    // out-of-band via onTypeFlip rather than as `conflict` actions — fold + reset the tally.
    this.activity.lastPull = { at: new Date().toISOString(), writes, deletes, conflicts: conflicts + this.typeFlipsSincePull };
    this.typeFlipsSincePull = 0;
    this.activityDirty = true;
  }

  /** Live transfer progress → activity sidecar, throttled to ~2 writes/s (plus the
   *  final tick) so a big upload isn't bottlenecked on progress bookkeeping. */
  private onTransferProgress(done: number, total: number, phase: "encrypt" | "upload" | "download"): void {
    const now = Date.now();
    if (done < total && now - this.lastProgressWrite < 500) return;
    this.lastProgressWrite = now;
    this.activity.active = { at: new Date().toISOString(), phase, done, total };
    this.writeActivity();
  }

  private async doFullScan(): Promise<void> {
    this.manifest = await scanManifest(this.root, this.matcher, this.cache);
    this.pruneCache();
  }

  /** Cache-bypassing re-hash — the ultimate authority against mtime+size-stable drift. */
  private async doDeepScan(): Promise<void> {
    const fresh = new HashCache();
    this.manifest = await scanManifest(this.root, this.matcher, fresh);
    this.cache = fresh; // replace cache with freshly-verified truth (already tight)
    // Trash retention (design 50 §2): the daemon owns pruning, on the infrequent deep tick
    // ONLY — never the sync hot path. Fire-and-forget: a prune failure must never surface as
    // a pump error. `.active`/young-batch protection (B3) lives in pruneTrash itself.
    void pruneTrash(this.root, trashConfig(this.cfg))
      .then((r) => {
        if (r.removedBatches) log(`trash pruned: ${r.removedBatches} batch${r.removedBatches === 1 ? "" : "es"}, ${r.freedBytes} bytes freed`);
      })
      .catch(() => {});
  }

  /**
   * Bound the on-disk HashCache: after a full scan the manifest is the complete set
   * of live paths, so drop cache entries for anything no longer present (deleted,
   * renamed, branch-switched-away). Without this the cache grows monotonically over
   * a workspace's lifetime — real disk bloat on fast-churning monorepos.
   */
  private pruneCache(): void {
    this.cache.prune(new Set(this.manifest.files.map((f) => f.path)));
  }

  // ---- live notification channel (optional; correctness never depends on it) ----

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.api.wsConnectUrl()}?device=${encodeURIComponent(this.cfg.deviceId)}`;
    let ws: WebSocket;
    try {
      // Bun's WebSocket client accepts a `{ headers }` option (verified) that the
      // standard lib types omit; declare that signature rather than cast to a lie.
      const BunWebSocket = WebSocket as unknown as {
        new (url: string, opts: { headers: Record<string, string> }): WebSocket;
      };
      ws = new BunWebSocket(url, { headers: { Authorization: `Bearer ${this.cfg.token}` } });
    } catch (e) {
      log(`ws connect failed: ${e instanceof Error ? e.message : String(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      log("ws connected");
      this.request("pull"); // catch up on anything missed while disconnected
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type?: string; deviceId?: string | null };
        if (m.type === "committed" && m.deviceId !== this.cfg.deviceId) this.request("pull");
      } catch {
        /* ignore malformed */
      }
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = undefined;
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* will fire close */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = jitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt));
    this.reconnectAttempt++;
    setTimeout(() => this.connect(), delay);
  }
}

/** Run the daemon until SIGTERM/SIGINT. Used by the hidden `__daemon-run` command. */
export async function runDaemon(root: string): Promise<void> {
  const { cfg, deps } = await buildAuthedRemote(root); // E2EE transport + injected KEK
  await loadState(root, syncStreamId(cfg)); // surfaces corrupt-state errors loudly before we go live
  const daemon = new RboxDaemon(root, cfg, deps);
  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await daemon.start();
  // start() returns after initial convergence; timers/watcher/ws keep the loop alive.
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ± up to 50% jitter so a fleet of daemons never aligns its ticks/reconnects. */
const jitter = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));

/**
 * Next safety-scan delay (design 49), decided when a tick fires. Quiet interval
 * with a live watcher → double, capped at 5m. Churn, or no live watcher (the
 * scan is the sync mechanism there), → back to the 60s floor. Pure — the
 * doubling/cap/reset table is unit-tested without timers.
 */
export function nextSafetyDelay(current: number, opts: { watcherLive: boolean; churned: boolean }): number {
  if (!opts.watcherLive || opts.churned) return SAFETY_SYNC_MS;
  return Math.min(current * 2, SAFETY_SYNC_MAX_MS);
}
