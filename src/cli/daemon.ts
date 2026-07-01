import os from "node:os";
import {
  applyWatchEvents,
  buildIgnoreMatcher,
  HashCache,
  scanManifest,
  type IgnoreMatcher,
  type Manifest,
  type WatchEvent,
} from "../engine/index.js";
import { loadState, type WorkspaceConfig } from "./config.js";
import { pull, pushManifest, type SyncDeps } from "./sync.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { beginReport, loadMetrics, saveMetrics, type SyncMetrics } from "./metrics.js";
import { RboxApi } from "./remote.js";
import { startWatcher, type Watcher } from "./watcher.js";

const SAFETY_SYNC_MS = 60_000; // frequent stat-only reconcile (heals dropped events)
const DEEP_SCAN_MS = 30 * 60_000; // infrequent cache-bypassing re-hash (heals mtime+size-stable drift)
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

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
  private safetyTimer?: ReturnType<typeof setInterval>;
  private deepTimer?: ReturnType<typeof setInterval>;
  private reconnectAttempt = 0;
  private stopped = false;
  /** Per-path retry counter for hot-path write-finish: a mid-write file is re-pushed a
   *  few times before falling back to the safety scan, so a large save isn't stalled 60s. */
  private readonly writeFinishRetries = new Map<string, number>();
  /** The watcher factory. Real native-backed `startWatcher` by default; an injectable seam
   *  so the "watcher init rejects → reconcile loops stay armed" invariant is testable without
   *  a process-global module mock (which leaks across test files). */
  private startWatcherFn: typeof startWatcher = startWatcher;

  private readonly want: Wants = { pull: false, push: false, fullScan: false, deepScan: false };
  private pumping = false;
  private metrics: SyncMetrics = { syncs: 0, commitConflicts409: 0, fileConflicts: 0 };

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
    // (ionice for IO priority on Linux is a follow-up; CPU nice is the main lever.)

    this.cache = await HashCache.load(this.root);
    this.metrics = await loadMetrics(this.root);
    log(`rbox daemon starting: ${this.root} → workspace ${this.cfg.remoteWorkspaceId} (device ${this.cfg.deviceId})`);

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
    this.safetyTimer = setInterval(() => this.request("fullScan"), jitter(SAFETY_SYNC_MS));
    this.deepTimer = setInterval(() => this.request("deepScan"), jitter(DEEP_SCAN_MS));
    try {
      this.watcher = await this.startWatcherFn(this.root, this.matcher, (events) => {
        this.pendingEvents.push(...events);
        this.request("push");
      });
    } catch (e) {
      log(`live watch unavailable: ${e instanceof Error ? e.message : String(e)} — degrading to periodic scan every ${Math.round(SAFETY_SYNC_MS / 1000)}s`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    if (this.deepTimer) clearInterval(this.deepTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    await this.watcher?.close();
    await this.cache?.save(this.root).catch(() => {});
    log("rbox daemon stopped");
  }

  // ---- single-flight pump --------------------------------------------------

  private request(kind: keyof Wants): void {
    this.want[kind] = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (this.want.pull || this.want.push || this.want.fullScan || this.want.deepScan) {
        try {
          if (this.want.deepScan) {
            this.want.deepScan = false;
            await this.doDeepScan();
            this.want.push = true;
          } else if (this.want.fullScan) {
            this.want.fullScan = false;
            await this.doFullScan();
            this.want.push = true;
          } else if (this.want.pull) {
            this.want.pull = false;
            await this.doPull();
            this.want.push = true; // publish any local divergence after taking remote
          } else if (this.want.push) {
            this.want.push = false;
            await this.doPush();
          }
        } catch (e) {
          log(`pump op error: ${e instanceof Error ? e.message : String(e)}`);
          await sleep(jitter(1000)); // brief backoff so a persistent error can't hot-loop
        }
      }
      await this.cache.save(this.root);
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
      if (events.some((e) => e.relPath === ".rboxignore" || e.relPath.endsWith("/.rboxignore") || e.relPath === ".gitignore" || e.relPath.endsWith("/.gitignore"))) {
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
    });
    this.manifest = res.manifest; // stays fresh even across a conflict re-scan (committed subset)
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
    const actions = await pull(this.root, this.cfg, { ...this.e2ee, cache: this.cache, report });
    report?.logSummaryTo(log);
    const fileConflicts = actions.filter((a) => a.kind === "conflict").length;
    if (fileConflicts > 0) {
      this.metrics.fileConflicts += fileConflicts;
      this.metrics.lastConflictAt = new Date().toISOString();
      await saveMetrics(this.root, this.metrics);
    }
    // Refresh in-memory truth from disk (cache-warm: pull invalidated written paths).
    this.manifest = await scanManifest(this.root, this.matcher, this.cache);
  }

  private bumpConflict(_kind: "commit"): void {
    this.metrics.commitConflicts409 += 1;
    this.metrics.lastConflictAt = new Date().toISOString();
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
  await loadState(root); // surfaces corrupt-state errors loudly before we go live
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
