import { type GitSection } from "../../engine/index.js";
import { gitIdentity, gitIdentityKey } from "./identity.js";
import { gitPreflight, isGitBusy } from "./preflight.js";
import { repoCtxFromDisk, type GitRepoKind, type RepoCtx } from "./git-state.js";
import { type OwnedRefMutationBoundary } from "./pins.js";
import type { PendingGitUpload } from "./git-state.js";
import type { GitConfigRunner } from "./config-txn.js";
import type { GitDeferralReason, WorkspaceConfig } from "../config.js";
import type { SyncRemote } from "../remote.js";
import { configReceiver, gitConfigHash, readLocalGitConfig, shouldPublishGitConfig, type LocalCfgRead } from "./config-lane.js";
import {
  buildPlanProbe,
  isGitRepoKind,
  writeDivergenceCacheEntry,
  type DivergenceCacheProbeSnapshot,
  type DivergenceCacheWriteResult,
  type FingerprintHitProbeResult,
  type GitDivergenceCache,
} from "./divergence-cache.js";
import { gitFingerprint, type GitFingerprint, type GitFingerprintRun } from "./fingerprint.js";
import { capturePlannedGitSection, carryMatrixMatches, errMsg, repoDirOf, type ResolutionCaptureTestHooks } from "./shared.js";

export type RepoAttemptCommand =
  | { kind: "carry"; section: GitSection }
  | { kind: "defer"; reason: string; typedReason?: GitDeferralReason; forced: boolean }
  | { kind: "clear-removal" }
  | { kind: "clear-resolution" }
  | { kind: "structural-refusal"; reason: string; removed: boolean; repoAbsent: boolean }
  | { kind: "config-observed" }
  | { kind: "config-defer"; reason: string; transient: boolean }
  | { kind: "config-skip"; reason: string }
  | { kind: "config-authored"; hash: string };

export interface RepoAttemptSnapshot {
  root: string;
  relPath: string;
  kind?: GitRepoKind;
  base?: GitSection;
  pending?: GitSection;
  removedKey?: string;
  resolutionKey?: string;
  recordExists: boolean;
  cfgSynced?: string;
  forced: boolean;
  mustCapture: boolean;
  repoCap: number;
  disableConfigLane: boolean;
  cache: GitDivergenceCache;
  fingerprintRun: GitFingerprintRun;
  gitConfigRunner?: GitConfigRunner;
  preCaptureRepoCtx(): Promise<RepoCtx | undefined>;
  onCredentialSkip(): void;
}

export interface RepoClassifyOptions {
  admissionAlreadyCounted?: boolean;
  admissionAvailable: boolean;
  forceCapture?: boolean;
  resolution?: boolean;
}

export interface RepoClassifyResult {
  queued: boolean;
  admissionUsed: boolean;
  parentRelKnown: boolean;
  parentRel?: string;
  stableCarry: boolean;
}

export interface RepoSupersessionEvidence {
  fingerprint: GitFingerprint;
  identityKey: string;
  kind: GitRepoKind | undefined;
}

export interface RepoCaptureInput {
  cfg: WorkspaceConfig;
  api: SyncRemote;
  kek: Buffer;
  uploadsDir: string;
  backoff?: (attempt: number) => Promise<void>;
  onBytes(absoluteBytes: number): void;
  resolution: boolean;
  resolutionHooks?: ResolutionCaptureTestHooks;
  retainDir?: string;
  ownedRefMutationBoundary?: OwnedRefMutationBoundary;
}

type ConfigMode = "carry" | "capture";

export class RepoCaptureAttempt {
  readonly relPath: string;
  private readonly commands: RepoAttemptCommand[] = [];
  private supersessionEvidence: RepoSupersessionEvidence | undefined;

  constructor(private readonly snapshot: RepoAttemptSnapshot) {
    this.relPath = snapshot.relPath;
  }

  drainCommands(): RepoAttemptCommand[] {
    return this.commands.splice(0);
  }

  rememberSupersessionEvidence(evidence: RepoSupersessionEvidence): void {
    this.supersessionEvidence = evidence;
  }

  supersessionRefusalEvidence(): RepoSupersessionEvidence | undefined {
    return this.supersessionEvidence;
  }

  async classify(
    fastLookup: FingerprintHitProbeResult | undefined,
    options: RepoClassifyOptions,
  ): Promise<RepoClassifyResult> {
    const { root, relPath: rel, kind, base: baseSection } = this.snapshot;
    const before = fastLookup?.fingerprint ?? await gitFingerprint(this.snapshot.fingerprintRun, root, rel);
    const recompute = async (): Promise<DivergenceCacheProbeSnapshot> => {
      const beforeFingerprint = await gitFingerprint(this.snapshot.fingerprintRun, root, rel);
      if (await isGitBusy(repoDirOf(root, rel))) {
        const { probe } = await buildPlanProbe(root, rel, beforeFingerprint.diskCtx);
        return { beforeFingerprint, probe, kind };
      }
      const preflight = await gitPreflight(repoDirOf(root, rel));
      const { probe } = await buildPlanProbe(root, rel, beforeFingerprint.diskCtx, preflight);
      return { beforeFingerprint, probe, kind: preflight.kind ?? kind };
    };
    if (await isGitBusy(repoDirOf(root, rel))) {
      const { probe } = await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx);
      await this.writeCache(probe, kind, before, recompute);
      this.defer("git busy (lock present)");
      return this.settled();
    }
    if (!baseSection && this.snapshot.removedKey !== undefined && !options.resolution) {
      const identity = await gitIdentity(repoDirOf(root, rel));
      if (!identity || gitIdentityKey(identity) === this.snapshot.removedKey) return this.settled();
      this.commands.push({ kind: "clear-removal" });
    }
    if (this.snapshot.resolutionKey !== undefined && !options.resolution) {
      const identity = await gitIdentity(repoDirOf(root, rel));
      if (gitIdentityKey(identity) === this.snapshot.resolutionKey) {
        const section = this.snapshot.pending ?? baseSection;
        if (section) this.commands.push({ kind: "carry", section });
        return this.settled();
      }
      this.commands.push({ kind: "clear-resolution" });
    }
    const cachedProbe = options.forceCapture && fastLookup?.status === "hit"
      && fastLookup.probe.preflightOk && !fastLookup.probe.preflightStructural
      ? fastLookup.probe
      : undefined;
    const preflight = cachedProbe
      ? { ok: true as const, kind: cachedProbe.preflightKind }
      : await gitPreflight(repoDirOf(root, rel));
    if (!preflight.ok) {
      const built = await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx, preflight);
      await this.writeCache(built.probe, preflight.kind ?? kind, before, recompute);
      if (preflight.structural) {
        if (this.snapshot.pending) {
          this.defer(`${preflight.reason ?? "structural preflight refusal"} — carrying pending section`);
        } else {
          this.commands.push({
            kind: "structural-refusal",
            reason: `${preflight.reason} — section ${baseSection ? "dropped" : "not captured"}`,
            removed: baseSection !== undefined,
            repoAbsent: baseSection !== undefined || this.snapshot.recordExists,
          });
        }
      } else {
        this.defer(preflight.reason ?? "preflight failed");
      }
      return this.settled(built);
    }
    const built = cachedProbe && fastLookup
      ? { probe: cachedProbe, diskCtx: fastLookup.fingerprint.diskCtx, parentRel: cachedProbe.parentRel }
      : await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx, preflight);
    const liveKind = preflight.kind ?? kind;
    const cacheWrite = await writeDivergenceCacheEntry(
      this.snapshot.fingerprintRun,
      root,
      rel,
      this.snapshot.cache,
      built.probe,
      liveKind,
      before,
      recompute,
      this.snapshot.onCredentialSkip,
      this.snapshot.disableConfigLane,
    ).catch((): DivergenceCacheWriteResult => ({ kind: liveKind, stable: false }));
    if (built.probe.identityKey === "none") {
      const section = this.snapshot.pending ?? baseSection;
      if (section) this.commands.push({ kind: "carry", section });
      return this.settled(built);
    }
    if (baseSection && !this.snapshot.mustCapture && !options.forceCapture) {
      if (!isGitRepoKind(liveKind)) {
        this.defer("preflight did not report a usable git repo kind");
        return this.settled(built);
      }
      if (carryMatrixMatches(baseSection, liveKind, built.probe.identityKey)) {
        const section = await this.withConfig("carry", baseSection, cacheWrite.localCfg, built.diskCtx);
        this.commands.push({ kind: "carry", section });
        return {
          ...this.settled(built),
          stableCarry: cacheWrite.stable,
        };
      }
    }
    if (!baseSection && !options.admissionAlreadyCounted && !options.admissionAvailable) {
      this.commands.push({
        kind: "defer",
        reason: `over the ${this.snapshot.repoCap}-repo cap — new repo not captured this cycle`,
        forced: false,
      });
      return this.settled(built);
    }
    return {
      queued: true,
      admissionUsed: !baseSection && !options.admissionAlreadyCounted,
      parentRelKnown: built.diskCtx?.kind === "pointer",
      parentRel: built.diskCtx?.kind === "pointer" ? built.parentRel : undefined,
      stableCarry: false,
    };
  }

  async capture(input: RepoCaptureInput): Promise<{
    section?: GitSection;
    reason?: string;
    pendingUploads?: PendingGitUpload[];
  }> {
    const captured = await capturePlannedGitSection(
      this.snapshot.root,
      this.relPath,
      input.cfg,
      this.snapshot.base,
      input.api,
      input.kek,
      input.uploadsDir,
      this.snapshot.mustCapture,
      input.backoff,
      input.onBytes,
      input.resolution,
      input.resolutionHooks,
      input.retainDir,
      input.ownedRefMutationBoundary,
    );
    if (!captured.section) return captured;
    return { ...captured, section: await this.withConfig("capture", captured.section) };
  }

  private async withConfig(
    mode: ConfigMode,
    section: GitSection,
    bracketed?: LocalCfgRead,
    knownCtx?: RepoCtx,
  ): Promise<GitSection> {
    const base = this.snapshot.base;
    if (this.snapshot.disableConfigLane) return mode === "carry" ? section : this.carryBaseConfig(section, base);
    this.commands.push({ kind: "config-observed" });
    const diskCtx = mode === "carry"
      ? knownCtx ?? await this.snapshot.preCaptureRepoCtx()
      : await repoCtxFromDisk(repoDirOf(this.snapshot.root, this.relPath)).catch(() => undefined);
    if (!diskCtx || diskCtx.kind !== "dir" || (mode === "capture" && section.refScope !== "all")) {
      const repoKind = diskCtx?.kind ?? "unreadable";
      const reason = mode === "carry"
        ? `local ${repoKind} shape does not own the common config`
        : `capture repository is ${repoKind}/scoped and does not own the common config`;
      this.commands.push({ kind: "config-skip", reason });
      return mode === "carry" ? section : this.carryBaseConfig(section, undefined);
    }
    let receiver: Awaited<ReturnType<typeof configReceiver>> | undefined;
    try {
      receiver = await configReceiver(this.snapshot.root, diskCtx);
    } catch (error) {
      if (mode === "capture") {
        this.commands.push({ kind: "config-skip", reason: `capture ownership could not be proven (${errMsg(error)})` });
        return this.carryBaseConfig(section, undefined);
      }
    }
    if (!receiver?.owned) {
      const reason = mode === "carry"
        ? "local common config is outside workspace ownership"
        : "capture common config is outside workspace ownership";
      this.commands.push({ kind: "config-skip", reason });
      return mode === "carry" ? section : this.carryBaseConfig(section, undefined);
    }
    const localConfig = await this.readConfig(mode, bracketed, diskCtx);
    if (localConfig.status === "over-bounds") {
      const reason = mode === "carry"
        ? `git config over wire bounds — publication disabled; carrying base verbatim (${localConfig.reason})`
        : `git config over wire bounds — capture config suppressed; carrying base config (${localConfig.reason})`;
      this.commands.push({ kind: "config-defer", reason, transient: false });
      return mode === "carry" ? section : this.carryBaseConfig(section, base);
    }
    if (localConfig.status === "failed") {
      const { disposition, reason: faultReason } = localConfig.fault;
      const state = disposition === "permanent" ? "disabled" : "deferred";
      const reason = mode === "carry"
        ? `git config ${state} (${faultReason}) — carrying base verbatim`
        : `git config ${state} during capture (${faultReason}) — carrying base config`;
      this.commands.push({ kind: "config-defer", reason, transient: disposition === "transient" });
      return mode === "carry" ? section : this.carryBaseConfig(section, base);
    }
    if (mode === "carry") {
      if (!shouldPublishGitConfig(section.config, localConfig.cached, this.snapshot.cfgSynced)) return section;
      this.commands.push({ kind: "config-authored", hash: localConfig.cached.hash });
      return { ...section, config: localConfig.config };
    }
    const embedded = { ...section, config: localConfig.config };
    this.commands.push({ kind: "config-authored", hash: gitConfigHash(embedded.config) });
    return embedded;
  }

  private async readConfig(mode: ConfigMode, bracketed: LocalCfgRead | undefined, diskCtx: RepoCtx): Promise<LocalCfgRead> {
    if (bracketed) return bracketed;
    try {
      return await readLocalGitConfig(
        this.snapshot.root,
        this.relPath,
        mode === "capture" ? diskCtx : undefined,
        this.snapshot.gitConfigRunner,
        this.snapshot.onCredentialSkip,
      );
    } catch (error) {
      if (mode === "carry") throw error;
      return { status: "failed", fault: { disposition: "transient", reason: "read-error", error } };
    }
  }

  private carryBaseConfig(section: GitSection, base: GitSection | undefined): GitSection {
    const carried = { ...section };
    delete carried.config;
    if (base?.config !== undefined) carried.config = base.config;
    return carried;
  }

  private defer(reason: string, typedReason?: GitDeferralReason): void {
    const command: RepoAttemptCommand = { kind: "defer", reason, forced: this.snapshot.forced };
    if (typedReason !== undefined) command.typedReason = typedReason;
    this.commands.push(command);
  }

  private writeCache(
    probe: Parameters<typeof writeDivergenceCacheEntry>[4],
    kind: GitRepoKind | undefined,
    before: Parameters<typeof writeDivergenceCacheEntry>[6],
    recompute: () => Promise<DivergenceCacheProbeSnapshot>,
  ): Promise<DivergenceCacheWriteResult | undefined> {
    return writeDivergenceCacheEntry(
      this.snapshot.fingerprintRun,
      this.snapshot.root,
      this.relPath,
      this.snapshot.cache,
      probe,
      kind,
      before,
      recompute,
      this.snapshot.onCredentialSkip,
      this.snapshot.disableConfigLane,
    ).catch(() => undefined);
  }

  private settled(built?: { diskCtx?: RepoCtx; parentRel?: string }): RepoClassifyResult {
    return {
      queued: false,
      admissionUsed: false,
      parentRelKnown: built?.diskCtx?.kind === "pointer",
      parentRel: built?.diskCtx?.kind === "pointer" ? built.parentRel : undefined,
      stableCarry: false,
    };
  }
}
