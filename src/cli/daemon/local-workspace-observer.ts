import {
  applyWatchEvents,
  caseFoldCollisionGroups,
  coverageOf,
  DirCache,
  scanManifest,
  scanPruneEnabled,
  type DiscoveredGitRepo,
  type HashCache,
  type IgnoreMatcher,
  type Manifest,
  type ScanStats,
  type WatchEvent,
} from "../../engine/index.js";
import { makeDeferErrnoReporter } from "../sync.js";
import { deferManifest } from "../sync-recovery.js";
import { createScanProbe, loadScanProbe, saveScanProbe } from "../scan-probe.js";
import { GC_FENCE_RETRY_MS } from "./policy.js";
import { errCode } from "./logger.js";
import type { ManifestUpdate } from "./manifest-update.js";
import type { LineageSnapshot, LocalAuthorityPort, LocalObservationCommitIntent, LocalObservationCommitOutcome } from "./local-observation-transition.js";
import { sealLocalObservationIdentity } from "./local-observation-transition.js";
import type {
  CurrentGitTopologyObservation,
  CurrentGitTopologyReceipt,
  GitScanKind,
  ScanTopologySnapshot,
} from "./git-discovery-continuity.js";

/**
 * Local observation: the daemon's answer to "what does this workspace look like
 * on disk right now, and how much of that answer is allowed to be trusted". Two
 * plan shapes reach it — a full-workspace tree walk and a bounded watcher patch
 * over named paths — and each returns one sealed receipt carrying completeness,
 * the deferred cursor, collision evidence, the matcher generation the walk ran
 * under, the dircache coverage hint, and the topology observation
 * `GitDiscoveryContinuity` derived from the same walk.
 *
 * The observer does NOT advance LOCAL authority: it seals a commit intent against the
 * lineage the observation STARTED under and hands it to `CommitLocalObservation`
 * ({@link LocalAuthorityPort}), which alone owns head, revision, and completeness.
 */

/** The bounded per-path retry queue the observation executor alone arms. Deferred
 * paths are not a scheduler concern: the daemon receives typed wakeups only. */
export interface LocalRetryQueuePort {
  /** Paths currently holding a retry wakeup — write-finish or GC fence. */
  readonly deferredPaths: ReadonlySet<string>;
  /** Publication-fenced paths, base-carried until their hours-scale timer fires. */
  readonly gcFencedPaths: ReadonlySet<string>;
  scheduleWriteFinish(paths: Set<string>): void;
  scheduleGcFence(paths: Set<string>): void;
  /** A path that hashed cleanly this round: drop the retry budget it accrued. */
  settle(relPath: string): void;
  stop(): void;
}

export interface LocalRetryQueueEffects {
  /** Wake the pump for these paths as `change` events. */
  requeue(paths: readonly string[]): void;
  /** A path that exhausted its budget is still UNOBSERVED until the next scan. */
  markUnsettled(relPath: string): void;
  stopped(): boolean;
}

/**
 * ~3s of retrying at {@link RETRY_DELAY_MS} before deferring to the safety scan, so a
 * pathological never-settling file cannot hot-loop the pump forever.
 */
const MAX_RETRIES = 15;
const RETRY_DELAY_MS = 200;

export class LocalRetryQueue implements LocalRetryQueuePort {
  private readonly writeFinishRetries = new Map<string, number>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly deferred = new Set<string>();
  private readonly gcFenced = new Set<string>();

  constructor(private readonly effects: LocalRetryQueueEffects) {}

  get deferredPaths(): ReadonlySet<string> { return this.deferred; }
  get gcFencedPaths(): ReadonlySet<string> { return this.gcFenced; }

  settle(relPath: string): void { this.writeFinishRetries.delete(relPath); }

  /**
   * Re-enqueue mid-write paths as `change` events after a short quiet, so a large save
   * that was still being written when we hashed gets picked up promptly rather than
   * waiting for the 60s safety scan. Bounded per path — after a few tries we give up and
   * let the safety/deep scan be the floor.
   */
  scheduleWriteFinish(paths: Set<string>): void {
    const retryable: string[] = [];
    for (const p of paths) {
      const n = (this.writeFinishRetries.get(p) ?? 0) + 1;
      if (n <= MAX_RETRIES) {
        this.writeFinishRetries.set(p, n);
        this.deferred.add(p);
        retryable.push(p);
      } else {
        this.writeFinishRetries.delete(p); // give up; the safety scan will heal it
        this.deferred.delete(p);
        this.effects.markUnsettled(p);
      }
    }
    if (retryable.length === 0 || this.effects.stopped()) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.effects.stopped()) return;
      for (const p of retryable) this.deferred.delete(p);
      this.effects.requeue(retryable);
    }, RETRY_DELAY_MS);
    this.timers.add(timer);
  }

  /** A GC publication fence is deliberately long-lived. Keep these paths in the
   * existing deferred set (so status remains unsettled), but requeue only on an
   * hours-scale timer; the ordinary 200ms write-finish loop would re-upload bytes
   * that the server has already accepted and deterministically receive another 503. */
  scheduleGcFence(paths: Set<string>): void {
    for (const p of paths) {
      this.deferred.add(p);
      this.gcFenced.add(p);
    }
    if (paths.size === 0 || this.effects.stopped()) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.effects.stopped()) return;
      for (const p of paths) {
        this.deferred.delete(p);
        this.gcFenced.delete(p);
      }
      this.effects.requeue([...paths]);
    }, GC_FENCE_RETRY_MS);
    timer.unref?.();
    this.timers.add(timer);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.deferred.clear();
    this.gcFenced.clear();
  }
}

/** A full-workspace tree walk. `scanKind` absent means the walk carries no
 * registry horizon, so its topology report can only be additive. */
export interface ScanGenerationPlan {
  readonly kind: "scan";
  /** The cache the walk hashes against — a deep scan supplies a fresh one. */
  readonly cache: HashCache;
  /** The manifest a deferred path carries its entry forward from. */
  readonly previous: Manifest;
  readonly scanStats?: ScanStats;
  readonly scanKind?: GitScanKind;
  readonly mode: "pruned" | "unpruned";
}

/** A bounded patch over exactly the paths the watcher named. */
export interface WatchBatchObservationPlan {
  readonly kind: "watch-batch";
  readonly events: WatchEvent[];
  readonly cache: HashCache;
}

export type LocalObservationPlan = ScanGenerationPlan | WatchBatchObservationPlan;

interface LocalObservationReceiptBase {
  /** Binds this receipt to the one plan execution that produced it. */
  readonly observationId: string;
  /** `deferred` withholds absence/collision authority: an unread path might be the
   * unseen case-variant of a path that did hash. */
  readonly completeness: "complete" | "deferred";
  /** The exact unread cursor — never a whole-workspace projection. */
  readonly deferredPaths: ReadonlySet<string>;
  /** Design 206 §2: the generation the observation STARTED under. */
  readonly matcherGeneration: number;
  /** Retry IDs this execution armed, in the order it armed them. */
  readonly retriesArmed: readonly string[];
  /** Retries this execution has NOT armed yet — see {@link LocalWorkspaceObserver.settleRetries}. */
  readonly retriesPending: readonly string[];
}

/** A walk may testify about paths it did not name; only it may claim absence. */
export interface ScanObservationReceipt extends LocalObservationReceiptBase {
  readonly kind: "scan";
  readonly scope: "full-workspace";
  /** Dircache hint, from the component that made the pruning decision. */
  readonly coverage: "full-tree" | "pruned";
  /** The walk's own manifest, before deferred entries carry `previous` forward. */
  readonly freshManifest: Manifest;
  /** What `MaintainGitDiscoveryContinuity` derived from this same walk. */
  readonly topology: CurrentGitTopologyReceipt;
  /** Only `advanced` installed this observation into LOCAL authority. */
  readonly commitDisposition: LocalObservationCommitOutcome;
}

export interface WatchBatchObservationReceipt extends LocalObservationReceiptBase {
  readonly kind: "watch-batch";
  readonly scope: "named-paths";
  /** The retained safe subset's independent-collision rescan, when it fired. It is
   * the only way a watcher patch may restore collision-warning authority, and it
   * carries its own full-workspace receipt rather than widening this one. */
  readonly collisionRescan?: ScanObservationReceipt;
}

export type SealedLocalObservationReceipt = ScanObservationReceipt | WatchBatchObservationReceipt;

export interface LocalObservationEffects {
  readonly root: string;
  currentManifest(): Manifest;
  currentMatcher(): IgnoreMatcher;
  /** Design 206 §2: read synchronously with the matcher the walk uses. */
  matcherGeneration(): number;
  /** Layer A may prune only while a live watcher is trusted. */
  scanMode(): "pruned" | "unpruned";
  beginTopologySnapshot(scanKind: GitScanKind | undefined): ScanTopologySnapshot;
  observeTopology(observation: CurrentGitTopologyObservation): Promise<CurrentGitTopologyReceipt>;
  /** The LOCAL-authority seam: the observer never assigns the manifest itself. */
  readonly authority: LocalAuthorityPort;
  log: (line: string) => void;
  recordScanFault(): void;
  /** Injected so the observation contract holds without a real tree walk. */
  scanTree?: typeof scanManifest;
  patchEvents?: typeof applyWatchEvents;
}

let observationSeq = 0;

export class LocalWorkspaceObserver {
  constructor(
    private readonly effects: LocalObservationEffects,
    readonly retries: LocalRetryQueuePort,
  ) {}

  observe(plan: ScanGenerationPlan): Promise<ScanObservationReceipt>;
  observe(plan: WatchBatchObservationPlan): Promise<WatchBatchObservationReceipt>;
  observe(plan: LocalObservationPlan): Promise<SealedLocalObservationReceipt> {
    return plan.kind === "scan" ? this.observeScan(plan) : this.observeWatchBatch(plan);
  }

  /**
   * The trailing half of a watcher patch: a path that hashed cleanly is settled,
   * and only the still-unread remainder arms a retry. Split from
   * {@link observe} because the current daemon resolves drift against the
   * receipt's deferred cursor BEFORE this schedule lands, and that order is
   * observable through the drift sidecar.
   */
  settleRetries(receipt: SealedLocalObservationReceipt): void {
    for (const p of receipt.retriesPending) this.retries.settle(p);
    if (receipt.deferredPaths.size > 0) this.retries.scheduleWriteFinish(new Set(receipt.deferredPaths));
  }

  /** Seal this execution's payload against the lineage it started under and hand it to
   *  `CommitLocalObservation`. A refusal is fail-closed by construction — LOCAL simply
   *  does not advance — so it is named in the log rather than left as a silent no-op. */
  private commit(
    payload: Omit<LocalObservationCommitIntent, "identity">,
    observationId: string,
    lineage: LineageSnapshot,
  ): LocalObservationCommitOutcome {
    const receipt = this.effects.authority.commitObservation({
      ...payload,
      identity: sealLocalObservationIdentity(observationId, lineage, payload),
    });
    if (receipt.outcome !== "advanced") {
      this.effects.log(`local observation ${observationId} not committed: ${receipt.outcome}`);
    }
    return receipt.outcome;
  }

  /** Install a coherent full-scan result. A path that changed under its deferred
   *  hash carries `previous`'s entry (never a torn tuple, never a deletion) and
   *  enters the existing write-finish retry loop. */
  private async observeScan(plan: ScanGenerationPlan): Promise<ScanObservationReceipt> {
    const { root } = this.effects;
    const deferred = new Set<string>();
    const discoveredGitRepos: DiscoveredGitRepo[] = [];
    const topologySnapshot = this.effects.beginTopologySnapshot(plan.scanKind);
    const probeOn = process.env.RBOX_SCAN_PROBE === "1" && plan.scanKind !== undefined;
    const scanStartMs = Date.now();
    const priorProbe = probeOn ? await loadScanProbe(root) : undefined;
    const probe = probeOn ? createScanProbe(priorProbe) : undefined;
    const dircache = scanPruneEnabled() ? await DirCache.load(root) : undefined;
    const deferErrnos = makeDeferErrnoReporter(this.effects.log, () => this.effects.recordScanFault());
    // Design 206 §2: the generation this observation STARTS under, captured with the
    // same synchronous read of the matcher the walk uses. Stamping at install time
    // instead would credit a rebuild that landed during the (seconds-long) walk to a
    // manifest observed under the old matcher; capturing here leaves the stamp stale
    // so P7 keeps trusted off until the next clean observation.
    const observedUnder = this.effects.matcherGeneration();
    // …and the lineage it starts under, sealed in the same synchronous read, so the
    // commit can refuse a receipt whose LOCAL moved underneath the walk.
    const lineage = this.effects.authority.snapshot();
    const observationId = `obs-${++observationSeq}`;
    const walk = this.effects.scanTree ?? scanManifest;
    const fresh = await walk(root, this.effects.currentMatcher(), plan.cache, undefined, (repo) => discoveredGitRepos.push(repo), plan.scanStats, deferred, probe, dircache, plan.mode,
      deferErrnos.onErrno, this.effects.log);
    deferErrnos.flush();
    await dircache?.save(root);
    const topology = await this.effects.observeTopology({ kind: "scan", repos: discoveredGitRepos, mode: plan.mode, snapshot: topologySnapshot });
    // Design 202: a scan is a FULL WORKSPACE observation (pruned scans reuse cached
    // listings, they do not omit paths), so it re-derives the unsettled set outright —
    // every previously unsettled path it read cleanly is settled again. `deferred` is
    // stamped by reference: this function is its only writer and it is done writing.
    // Any deferred path also makes collision evidence incomplete (it might be the
    // unseen case-variant of a path that did hash), so the completeness claim and the
    // head it describes are ONE transition — no window carries one without the other.
    const coverage = coverageOf(dircache?.lastOutcome ?? "off");
    const payload = {
      next: deferred.size > 0 ? deferManifest(fresh, plan.previous, deferred) : fresh,
      update: { kind: "full-workspace", coverage, deferred } as const,
      unsettled: { rebuildFrom: deferred },
      observedUnderMatcherGeneration: observedUnder,
      completeness: (deferred.size === 0 ? "complete" : "deferred") as "complete" | "deferred",
    };
    const commitDisposition = this.commit(payload, observationId, lineage);
    if (deferred.size > 0) this.retries.scheduleWriteFinish(deferred);
    if (probe) {
      const summary = probe.summary();
      this.effects.log(`scan probe: dirs=${summary.dirs} eligible=${summary.eligible} eligibleReaddirMs=${summary.eligibleReaddirMs} totalReaddirMs=${summary.totalReaddirMs} projectedDircacheBytes=${summary.projectedDircacheBytes} probeOverheadMs=${summary.probeOverheadMs}`);
      // Measurement only — a probe sidecar write failure must never fail the scan op.
      await saveScanProbe(root, scanStartMs, probe).catch((e) => this.effects.log(`scan probe sidecar write failed: ${errCode(e)}`));
    }
    // Coverage originates HERE — the function that invokes the tree walker. It is
    // read from the DIRCACHE (the component that made the pruning decision), never
    // from the optional metrics struct: a pruned scan can heal but must never
    // testify to watcher re-trust (design 104 R1 F8). No dircache ⇒ unpruned walk ⇒
    // "full-tree". Callers forward this value unchanged.
    return {
      kind: "scan",
      observationId,
      scope: "full-workspace",
      completeness: deferred.size === 0 ? "complete" : "deferred",
      deferredPaths: deferred,
      matcherGeneration: observedUnder,
      coverage,
      freshManifest: fresh,
      topology,
      commitDisposition,
      retriesArmed: [...deferred],
      retriesPending: [],
    };
  }

  private async observeWatchBatch(plan: WatchBatchObservationPlan): Promise<WatchBatchObservationReceipt> {
    const { events } = plan;
    const deferred = new Set<string>();
    const patch = this.effects.patchEvents ?? applyWatchEvents;
    const observedUnder = this.effects.matcherGeneration();
    const lineage = this.effects.authority.snapshot();
    const observationId = `obs-${++observationSeq}`;
    const patched = await patch(this.effects.currentManifest(), this.effects.root, this.effects.currentMatcher(), events, plan.cache, deferred);
    // Design 202: ONE partial update per settled drain (never per file). A path
    // this drain read cleanly is re-observed and leaves the unsettled set; a path
    // it deferred joins it. Installing HERE — before the collision rescan below —
    // is what makes the ordering do the bookkeeping: a rescan simply installs
    // full-workspace provenance and its own unsettled set on top, so no "did we
    // rescan?" flag is needed to stop a partial stamp from overwriting it.
    const payload = {
      next: patched,
      update: { kind: "partial", source: "watch-events", paths: new Set(events.map((e) => e.relPath)) } as const,
      unsettled: {
        settle: events.filter((e) => !deferred.has(e.relPath)).map((e) => e.relPath),
        add: deferred,
      },
    };
    this.commit(payload, observationId, lineage);
    let nested: ScanObservationReceipt | undefined;
    if (!this.effects.authority.observationComplete && caseFoldCollisionGroups(this.effects.currentManifest().files).length > 0) {
      // The retained safe subset discovered an independent new collision.
      // Re-scan to reunite it with every still-active omitted group before
      // the next push authors warning truth.
      nested = await this.observeScan({ kind: "scan", cache: plan.cache, previous: this.effects.currentManifest(), mode: this.effects.scanMode() });
      for (const path of nested.deferredPaths) deferred.add(path);
    }
    return {
      kind: "watch-batch",
      observationId,
      scope: "named-paths",
      completeness: deferred.size === 0 ? "complete" : "deferred",
      deferredPaths: deferred,
      matcherGeneration: observedUnder,
      ...(nested ? { collisionRescan: nested } : {}),
      retriesArmed: nested ? [...nested.retriesArmed] : [],
      retriesPending: events.filter((e) => !deferred.has(e.relPath)).map((e) => e.relPath),
    };
  }
}
