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
import { loadMetrics, saveMetrics, type SyncMetrics } from "./metrics.js";
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
    await this.cache.save(this.root);
    this.want.pull = true;
    this.want.push = true;
    await this.pump();

    this.watcher = startWatcher(this.root, this.matcher, (events) => {
      this.pendingEvents.push(...events);
      this.request("push");
    });

    this.connect();

    this.safetyTimer = setInterval(() => this.request("fullScan"), jitter(SAFETY_SYNC_MS));
    this.deepTimer = setInterval(() => this.request("deepScan"), jitter(DEEP_SCAN_MS));

    log("rbox daemon ready");
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
        this.manifest = await applyWatchEvents(this.manifest, this.root, this.matcher, events, this.cache);
      }
    }
    const res = await pushManifest(this.root, this.cfg, this.manifest, {
      ...this.e2ee,
      cache: this.cache,
      onCommitConflict: () => this.bumpConflict("commit"),
    });
    this.manifest = res.manifest; // stays fresh even across a conflict re-scan
    this.metrics.syncs += 1;
    await saveMetrics(this.root, this.metrics);
  }

  private async doPull(): Promise<void> {
    const actions = await pull(this.root, this.cfg, { ...this.e2ee, cache: this.cache });
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
  }

  /** Cache-bypassing re-hash — the ultimate authority against mtime+size-stable drift. */
  private async doDeepScan(): Promise<void> {
    const fresh = new HashCache();
    this.manifest = await scanManifest(this.root, this.matcher, fresh);
    this.cache = fresh; // replace cache with freshly-verified truth
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
