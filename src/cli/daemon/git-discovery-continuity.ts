import type { DiscoveredGitRepo } from "../../engine/index.js";
import { errCode } from "./logger.js";
import {
  GitRefWatchRegistry,
  ownerOrder,
  type GitRefWatchRegistryOptions,
  type RepoCandidateWork,
} from "./git-ref-watch.js";

/**
 * Discovery continuity: the daemon's standing answer to "which Git repositories
 * exist under this workspace, and which observation is allowed to say one is
 * GONE". Three inputs feed it — additive plan discovery from a push, candidate
 * discovery from the ref side channel, and the tree walk's own repository
 * reports — and it derives the ref-backend arming input, the authoritative
 * topology, the single-use absence proof, and the Linux safety-cadence floor.
 */

/** The Linux ref side channel, as discovery is allowed to use it. Arming,
 * reconcile, and backoff belong to the registry; this owner only feeds it. */
export interface GitRefRegistryPort {
  /** The registry's own bounded claim on the safety floor. */
  readonly floorRequired: boolean;
  /** Input horizon captured before a walk starts; a later snapshot may only
   * shrink ownership that has not been re-armed since. */
  beginSnapshot(): number;
  upsert(repos: readonly DiscoveredGitRepo[]): Promise<void>;
  applySnapshot(repos: readonly DiscoveredGitRepo[], startEpoch: number, complete: boolean): Promise<void>;
  markCandidates(candidates: readonly RepoCandidateWork[]): Promise<void>;
  markAllCandidatesDirty(): Promise<void>;
  close(): Promise<void>;
}

export interface GitDiscoveryEffects {
  /** Full-plan discovery under the daemon's live matcher. */
  discoverAll(): Promise<readonly DiscoveredGitRepo[]>;
  /** Bounded discovery under one candidate owner. */
  discoverUnder(owner: string): Promise<readonly DiscoveredGitRepo[]>;
  /** Re-arm a backed-off safety timer at its floor now. */
  pinSafetyFloor(): void;
  log(line: string): void;
  /** Injected so floor gating is provable off the platform under test. */
  platform?: string;
  /** Injected so the continuity contract holds without a live inotify session. */
  createRefBackend?(options: GitRefWatchRegistryOptions): GitRefRegistryPort;
}

export type GitScanKind = "safety scan" | "deep scan";

/** The registry horizon sealed to the scan kind that captured it. A walk with no
 * scan kind has no horizon, so its report can only be additive. */
export interface ScanTopologySnapshot {
  readonly scanKind: GitScanKind | undefined;
  readonly registryEpoch: number | undefined;
}

export type CurrentGitTopologyObservation =
  | { readonly kind: "plan"; readonly repos: readonly DiscoveredGitRepo[] }
  | { readonly kind: "signal"; readonly discoverAll: boolean; readonly candidates: readonly RepoCandidateWork[] }
  | {
      readonly kind: "scan";
      readonly repos: readonly DiscoveredGitRepo[];
      readonly mode: "pruned" | "unpruned";
      readonly snapshot: ScanTopologySnapshot;
    };

export type GitRegistryAction =
  | { readonly kind: "mark-all-candidates-dirty" }
  | { readonly kind: "mark-candidates"; readonly owners: readonly string[] }
  | { readonly kind: "upsert"; readonly repos: readonly string[] }
  | { readonly kind: "apply-snapshot"; readonly repos: readonly string[]; readonly startEpoch: number; readonly complete: boolean }
  | { readonly kind: "discovery-failed"; readonly code: string };

/** A repository set an unpruned walk observed completely, consumable once per
 * absent repository by deferral hygiene (pr8). */
export interface DeferralDiscoveryAuthority {
  readonly epoch: number;
  readonly discoveredRepos: ReadonlySet<string>;
}

export interface CurrentGitTopologyReceipt {
  readonly kind: CurrentGitTopologyObservation["kind"];
  /** Whether this observation may testify that a repository is gone. */
  readonly absenceAuthority: "additive" | "authoritative";
  /** The proof in force after the observation; `undefined` once retracted. */
  readonly absenceProof?: DeferralDiscoveryAuthority;
  /** `seeded` adopts a first topology; `shrinking-snapshot` is the only
   * disposition permitted to retire earlier discoveries. */
  readonly topology: "additive" | "seeded" | "shrinking-snapshot";
  readonly registryActions: readonly GitRegistryAction[];
  readonly floorRequired: boolean;
}

export interface RefBackendAttachment {
  readonly root: string;
  /** Discoveries already made by the watcher's own start-up walk. */
  readonly initial: readonly DiscoveredGitRepo[];
  onSignal(): void;
  onArmed(): void;
  onLog(message: string): void;
}

export class GitDiscoveryContinuity {
  private registry?: GitRefRegistryPort;
  private floorHeld = false;
  private backendFallbackPending = false;
  private authoritative: readonly DiscoveredGitRepo[] = [];
  /** Additive dir discoveries since the latest shrinking safety snapshot. */
  private planDiscoveredDirOwners = new Set<string>();
  private authoritativeSnapshotTaken = false;
  private absenceEpoch = 0;
  private proof?: DeferralDiscoveryAuthority;
  private readonly linux: boolean;

  constructor(private readonly effects: GitDiscoveryEffects) {
    this.linux = (effects.platform ?? process.platform) === "linux";
  }

  get floorRequired(): boolean { return this.floorHeld; }
  get absenceProof(): DeferralDiscoveryAuthority | undefined { return this.proof; }
  get authoritativeRepos(): readonly DiscoveredGitRepo[] { return this.authoritative; }
  get hasAuthoritativeSnapshot(): boolean { return this.authoritativeSnapshotTaken; }
  get refBackendAttached(): boolean { return this.registry !== undefined; }

  /** Adopt the Linux ref side channel for a watcher session. The caller decides
   * eligibility from the backend the watcher actually selected. */
  async attachRefBackend(input: RefBackendAttachment): Promise<void> {
    const create = this.effects.createRefBackend ?? ((options) => new GitRefWatchRegistry(options));
    this.registry = create({
      root: input.root,
      onSignal: input.onSignal,
      onArmed: () => input.onArmed(),
      onFloorChange: () => this.refreshFloor("registry"),
      onLog: input.onLog,
    });
    await this.registry.upsert(input.initial);
  }

  /** Linux without an eligible ref backend: this owner's claim is the only pin
   * holding the safety cadence at its floor until a complete snapshot lands. */
  noteRefBackendUnavailable(): void {
    if (!this.linux) return;
    this.backendFallbackPending = true;
    this.refreshFloor("backend-fallback");
  }

  /** A watcher session that failed to come up: the backend is gone and the
   * fallback claim replaces it exactly as an ineligible backend would. */
  async abandonRefBackend(): Promise<void> {
    await this.registry?.close();
    this.registry = undefined;
    this.backendFallbackPending = this.linux;
    this.refreshFloor("backend-fallback");
  }

  close(): Promise<void> {
    return this.registry?.close() ?? Promise.resolve();
  }

  /** Seal the registry horizon a walk is about to run under. Capturing it before
   * the walk is what makes the later snapshot unable to retire ownership armed
   * while the walk was in flight. */
  beginScanSnapshot(scanKind: GitScanKind | undefined): ScanTopologySnapshot {
    return { scanKind, registryEpoch: scanKind ? this.registry?.beginSnapshot() : undefined };
  }

  async observe(observation: CurrentGitTopologyObservation): Promise<CurrentGitTopologyReceipt> {
    switch (observation.kind) {
      case "plan": return this.observePlan(observation.repos);
      case "signal": return this.observeSignal(observation.discoverAll, observation.candidates);
      case "scan": return this.observeScan(observation.repos, observation.mode, observation.snapshot);
    }
  }

  /**
   * Backend-independent additive plan observation. A registry, when present,
   * owns arming; this owner's claim independently pins Chokidar/fallback until
   * the next complete safety snapshot is allowed to shrink it.
   */
  private async observePlan(repos: readonly DiscoveredGitRepo[]): Promise<CurrentGitTopologyReceipt> {
    const actions: GitRegistryAction[] = [];
    for (const repo of repos) if (repo.kind === "dir") this.planDiscoveredDirOwners.add(repo.relPath);
    await this.upsert(repos, actions);
    this.refreshFloor("plan-discovery");
    return this.receipt("plan", "additive", "additive", actions);
  }

  private async observeSignal(
    discoverAll: boolean,
    candidates: readonly RepoCandidateWork[],
  ): Promise<CurrentGitTopologyReceipt> {
    const actions: GitRegistryAction[] = [];
    try {
      if (this.registry) {
        if (discoverAll) {
          await this.registry.markAllCandidatesDirty();
          actions.push({ kind: "mark-all-candidates-dirty" });
        } else {
          await this.registry.markCandidates(candidates);
          actions.push({ kind: "mark-candidates", owners: candidates.map((candidate) => candidate.owner) });
        }
        let discovered: DiscoveredGitRepo[] = [];
        if (discoverAll) {
          discovered = [...await this.effects.discoverAll()];
        } else {
          const owners = [...new Set(candidates.filter((candidate) => candidate.discover).map((candidate) => candidate.owner))].sort();
          for (const owner of owners) discovered.push(...await this.effects.discoverUnder(owner));
        }
        if (discovered.length > 0) await this.upsert(discovered, actions);
      }
    } catch (error) {
      const code = errCode(error);
      actions.push({ kind: "discovery-failed", code });
      this.effects.log(`git ref candidate discovery failed: ${code}`);
    }
    return this.receipt("signal", "additive", "additive", actions);
  }

  private async observeScan(
    reported: readonly DiscoveredGitRepo[],
    mode: "pruned" | "unpruned",
    snapshot: ScanTopologySnapshot,
  ): Promise<CurrentGitTopologyReceipt> {
    const actions: GitRegistryAction[] = [];
    const repos = [...reported].sort(ownerOrder);
    if (mode === "unpruned") {
      this.proof = { epoch: ++this.absenceEpoch, discoveredRepos: new Set(repos.map((repo) => repo.relPath)) };
    } else {
      // Pruned discovery is additive and cannot testify that a missing repo is gone.
      this.proof = undefined;
    }
    let topology: CurrentGitTopologyReceipt["topology"] = "additive";
    if (snapshot.scanKind && mode === "unpruned") {
      topology = "shrinking-snapshot";
      this.authoritative = repos;
      this.planDiscoveredDirOwners.clear();
      this.authoritativeSnapshotTaken = true;
      this.backendFallbackPending = false;
      if (snapshot.registryEpoch !== undefined) {
        await this.registry?.applySnapshot(repos, snapshot.registryEpoch, true);
        if (this.registry) actions.push({ kind: "apply-snapshot", repos: repos.map((repo) => repo.relPath), startEpoch: snapshot.registryEpoch, complete: true });
      } else await this.upsert(repos, actions);
      this.refreshFloor(`${snapshot.scanKind}-snapshot`);
    } else if (!snapshot.scanKind && mode === "unpruned" && !this.authoritativeSnapshotTaken) {
      topology = "seeded";
      this.authoritative = repos;
      this.authoritativeSnapshotTaken = true;
      await this.upsert(repos, actions);
      this.refreshFloor("initial-snapshot");
    } else {
      // Pruned scans are additive evidence only: discovery-pruned subtrees do
      // not report repositories, so their absence can never authorize pr8
      // gone-directory cleanup or shrink the ref registry.
      await this.upsert(repos, actions);
      this.refreshFloor(mode === "pruned" ? "pruned-additive-scan" : "additive-scan");
    }
    return this.receipt("scan", mode === "unpruned" ? "authoritative" : "additive", topology, actions);
  }

  /** Re-evaluate the Linux safety-cadence floor. Public because the ref backend
   * reports its own claim asynchronously. */
  refreshFloor(reason: string): void {
    const next = this.linux && (
      this.backendFallbackPending
      || this.authoritative.some((repo) => repo.kind === "dir")
      || this.planDiscoveredDirOwners.size > 0
      || this.registry?.floorRequired === true
    );
    if (next === this.floorHeld) return;
    this.floorHeld = next;
    if (next) this.effects.pinSafetyFloor();
    this.effects.log(`git safety floor ${next ? "required" : "released"}: ${reason}`);
  }

  private async upsert(repos: readonly DiscoveredGitRepo[], actions: GitRegistryAction[]): Promise<void> {
    if (!this.registry) return;
    await this.registry.upsert(repos);
    actions.push({ kind: "upsert", repos: repos.map((repo) => repo.relPath) });
  }

  private receipt(
    kind: CurrentGitTopologyObservation["kind"],
    absenceAuthority: CurrentGitTopologyReceipt["absenceAuthority"],
    topology: CurrentGitTopologyReceipt["topology"],
    registryActions: readonly GitRegistryAction[],
  ): CurrentGitTopologyReceipt {
    return {
      kind,
      absenceAuthority,
      ...(this.proof ? { absenceProof: this.proof } : {}),
      topology,
      registryActions,
      floorRequired: this.floorHeld,
    };
  }
}
