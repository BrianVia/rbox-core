/** Never: Git ref/checkout mutation, BASE/pending/deferral lane authority, state persistence, or push-side config capture (sync-git/config-lane.ts owns the capture model). */
import path from "node:path";
import type { GitSection } from "../../engine/index.js";
import type { RepoCtx } from "./git-state.js";
import { repoCtxFromDisk } from "./git-state.js";
import { validateCanonicalGitConfig, type GitConfig } from "./config-sync.js";
import {
  readConfigSnapshot,
  sameConfigStatToken,
  type ConfigStatToken,
  type ConfigTransactionResult,
} from "./config-txn.js";
import type { ConfigStoreIdentity, RepoRecordInput } from "../config.js";
import { completeConfigApply, configLaneState, type ConfigLaneState } from "../sync-state.js";
import { configReceiver, gitConfigHash, readLocalGitConfig, sameConfigStoreIdentity } from "./config-lane.js";
import {
  configInvalidSkipLogged,
  configOwnershipSkipLogged,
  type HeldChainLock,
} from "./shared.js";

interface ReceivedGitConfigInput {
  readonly root: string;
  readonly relPath: string;
  readonly repoDir: string;
  readonly wireSection: GitSection | undefined;
  readonly incoming: GitConfig | undefined;
  readonly laneDisabled: boolean;
  readonly commonDirLock: HeldChainLock;
  /** Live durable observation. Recovery may replace this record before prepare. */
  priorRecord(): RepoRecordInput;
  /** Live physical observation. Recovery may quarantine a partial fresh repo. */
  leftoverPresent(): boolean;
  repoContext(): Promise<RepoCtx | undefined>;
  materializeFresh(incoming: GitConfig): Promise<void>;
  inspectFreshInstall(): Promise<{
    storeIdentity: ConfigStoreIdentity;
    config: GitConfig;
    token: ConfigStatToken;
  }>;
  applyExisting(
    configPath: string,
    incoming: GitConfig,
    baseConfig: GitConfig | undefined,
  ): Promise<ConfigTransactionResult>;
  log(message: string): void;
}

interface ExistingTarget {
  readonly kind: "existing";
  readonly storeIdentity: ConfigStoreIdentity;
  readonly configPath: string;
  readonly commonDirKey: string;
}

interface FreshTarget {
  readonly kind: "fresh";
}

type ConfigTarget = ExistingTarget | FreshTarget;

interface ConfigReadiness {
  readonly due: boolean;
  readonly requiresMaterialization: boolean;
  readonly transition: ConfigLaneState | undefined;
}

function configFailure(result: Exclude<ConfigTransactionResult, { status: "completed" }>): Error {
  return new Error(`config ${result.status}: ${result.fault.reason}`);
}

function sanitationReason(
  input: Pick<ReceivedGitConfigInput, "root" | "relPath" | "wireSection" | "log">,
): string | undefined {
  if (input.wireSection?.config === undefined) return undefined;
  const config = validateCanonicalGitConfig(input.wireSection.config);
  const reason = !config.ok
    ? config.reason
    : input.wireSection.refScope === "scoped"
      ? "scoped git section cannot carry config"
      : undefined;
  if (reason) {
    const logKey = `${input.root}\0${input.relPath}`;
    if (!configInvalidSkipLogged.has(logKey)) {
      configInvalidSkipLogged.add(logKey);
      input.log(`git-sync WARNING ${input.relPath}: ignored invalid incoming config (${reason}); Git state continues`);
    }
  }
  return reason;
}

async function ownedDirReceiver(
  root: string,
  ctx: RepoCtx | undefined,
): Promise<{ storeIdentity: ConfigStoreIdentity; configPath: string } | undefined> {
  if (ctx?.kind !== "dir") return undefined;
  const receiver = await configReceiver(root, ctx).catch(() => undefined);
  return receiver?.owned ? { storeIdentity: receiver.storeIdentity, configPath: receiver.configPath } : undefined;
}

/**
 * One receive operation for one repository's config lane.
 *
 * Identity, prior state, wire input, effects, and the held common-directory
 * lock are bound once. The caller chooses only among the three real execution
 * windows and copies returned `ConfigLaneState` into its existing in-flight
 * map. Plans, phase tags, executors, receipts, and identity echoes stay absent.
 */
export function createReceivedGitConfig(input: ReceivedGitConfigInput) {
  let nextLane: ConfigLaneState | undefined;
  let target: ConfigTarget | undefined;
  let baseConfig: GitConfig | undefined;
  let due = false;

  const record = (): RepoRecordInput => {
    const prior = input.priorRecord();
    return {
      sourceSeq: prior.sourceSeq,
      ...(nextLane ?? configLaneState(prior)),
    };
  };

  const replace = (next: RepoRecordInput): ConfigLaneState => {
    nextLane = configLaneState(next);
    return configLaneState(nextLane);
  };

  const transition = (): ConfigLaneState | undefined =>
    nextLane === undefined ? undefined : configLaneState(nextLane);

  const invalidateStoreIdentity = (storeIdentity: ConfigStoreIdentity | undefined): RepoRecordInput => {
    const current = record();
    if (sameConfigStoreIdentity(current.cfgStore, storeIdentity)) return current;
    const reset: RepoRecordInput = {
      sourceSeq: current.sourceSeq,
      ...(storeIdentity === undefined ? {} : { cfgStore: storeIdentity }),
    };
    replace(reset);
    return reset;
  };

  const complete = (
    storeIdentity: ConfigStoreIdentity,
    hashes: {
      pre: string;
      post: string;
      incoming: string;
      basePre?: string;
      postToken: ConfigStatToken;
    },
  ): ConfigLaneState => replace({
    ...completeConfigApply(record(), hashes),
    cfgStore: storeIdentity,
  });

  const skipOnce = (message: string): void => {
    const logKey = `${input.root}\0${input.relPath}`;
    if (configOwnershipSkipLogged.has(logKey)) return;
    configOwnershipSkipLogged.add(logKey);
    input.log(message);
  };

  const applyExistingTarget = async (): Promise<ConfigLaneState | undefined> => {
    if (!due || target?.kind !== "existing" || input.incoming === undefined) return undefined;
    const result = await input.applyExisting(target.configPath, input.incoming, baseConfig);
    if (result.status !== "completed") throw configFailure(result);
    for (const warning of result.warnings) {
      try {
        input.log(`git-sync WARNING ${input.relPath}: config ${warning}`);
      } catch {
        // Observability after the rename commit point is strictly non-fatal.
      }
    }
    return complete(target.storeIdentity, {
      pre: result.preHash,
      post: result.postHash,
      incoming: result.incomingHash,
      ...(result.baseHash === undefined ? {} : { basePre: result.baseHash }),
      postToken: result.postToken,
    });
  };

  return {
    /**
     * Record the non-mutating sanitation/wire-absence baseline, if any.
     * This stays before physical Git recovery exactly as in the current apply
     * sequence.
     */
    async recordBaseline(): Promise<ConfigLaneState | undefined> {
      const sanitized = sanitationReason(input);
      if (input.laneDisabled || !input.leftoverPresent()) return transition();

      if (sanitized !== undefined) {
        const ctx = await input.repoContext();
        const receiver = await ownedDirReceiver(input.root, ctx);
        if (!receiver) return transition();
        const local = await readLocalGitConfig(
          input.root,
          input.relPath,
          ctx,
          undefined,
          () => {
            const logKey = `${input.root}\0${input.relPath}\0credential`;
            if (!configInvalidSkipLogged.has(logKey)) {
              configInvalidSkipLogged.add(logKey);
              input.log(`git-sync WARNING ${input.relPath}: skipped credential-bearing remote URL from config baseline`);
            }
          },
        );
        if (local.status !== "ok") return transition();
        const before = record();
        const lane = invalidateStoreIdentity(receiver.storeIdentity);
        const priorBaseline = before.cfgStore === undefined
          || sameConfigStoreIdentity(before.cfgStore, receiver.storeIdentity)
          ? before.cfgSynced
          : undefined;
        return replace({
          ...lane,
          cfgSynced: priorBaseline ?? local.cached.hash,
          cfgStore: receiver.storeIdentity,
        });
      }

      if (input.wireSection === undefined || input.wireSection.config !== undefined) return transition();
      const before = record();
      if (before.cfgSynced === undefined) return transition();
      if (!await ownedDirReceiver(input.root, await input.repoContext())) return transition();
      const { cfgSynced: _cfgSynced, ...withoutSynced } = before;
      return replace(withoutSynced);
    },

    /**
     * Resolve receiver ownership and whether config work is due. Shape
     * invalidation is returned immediately for the existing in-flight map.
     */
    async prepare(inheritedBase: GitConfig | undefined): Promise<ConfigReadiness> {
      target = undefined;
      baseConfig = inheritedBase;
      due = false;
      if (input.laneDisabled || input.incoming === undefined) {
        return { due, requiresMaterialization: false, transition: transition() };
      }
      if (!input.leftoverPresent()) {
        invalidateStoreIdentity(undefined);
        target = { kind: "fresh" };
        due = true;
        return { due, requiresMaterialization: true, transition: transition() };
      }
      const diskCtx = await repoCtxFromDisk(input.repoDir).catch(() => undefined);
      if (!diskCtx) {
        invalidateStoreIdentity(undefined);
        skipOnce(
          `git-sync config skipped ${input.relPath}: receiver repository shape is unreadable/non-owned. `
          + "rbox left shared Git settings alone; Git history can still sync.",
        );
        return { due, requiresMaterialization: false, transition: transition() };
      }
      const receiver = await configReceiver(input.root, diskCtx);
      const lane = invalidateStoreIdentity(receiver.storeIdentity);
      if (!receiver.owned) {
        skipOnce(
          `git-sync config skipped ${input.relPath}: receiver ${diskCtx.kind} shape does not own the common config. `
          + "rbox left shared Git settings alone; Git history can still sync.",
        );
        return { due, requiresMaterialization: false, transition: transition() };
      }
      const current = await readConfigSnapshot(receiver.configPath);
      const token = current.ok ? current.snapshot.token : undefined;
      target = {
        kind: "existing",
        storeIdentity: receiver.storeIdentity,
        configPath: receiver.configPath,
        commonDirKey: path.resolve(diskCtx.commonDir),
      };
      due = gitConfigHash(input.incoming) !== lane.cfgApplied || !sameConfigStatToken(token, lane.cfgToken);
      return { due, requiresMaterialization: false, transition: transition() };
    },

    /** Existing/config-only window. Fresh targets are structurally refused. */
    applyExisting: applyExistingTarget,

    /**
     * Follow window. This operation is available only on a receiver constructed
     * with the opaque scope minted by the surrounding `chainLock`.
     */
    async applyWhileCommonDirLocked(): Promise<ConfigLaneState | undefined> {
      input.commonDirLock.assertHeld();
      if (due && target?.kind === "existing" && input.commonDirLock.key !== target.commonDirKey) {
        throw new Error(
          `received git config common-directory lock mismatch: held ${input.commonDirLock.key}, `
          + `target ${target.commonDirKey}`,
        );
      }
      return applyExistingTarget();
    },

    /**
     * Clean Git-state window. Existing receivers use the same transaction as the
     * config-only window; fresh receivers derive state from the post-install read.
     */
    async applyAfterMaterialization(): Promise<ConfigLaneState | undefined> {
      if (!due || input.incoming === undefined) return undefined;
      if (target?.kind === "existing") return applyExistingTarget();
      if (target?.kind !== "fresh") return undefined;
      await input.materializeFresh(input.incoming);
      const installed = await input.inspectFreshInstall();
      return complete(installed.storeIdentity, {
        pre: gitConfigHash({}),
        post: gitConfigHash(installed.config),
        incoming: gitConfigHash(input.incoming),
        ...(baseConfig === undefined ? {} : { basePre: gitConfigHash(baseConfig) }),
        postToken: installed.token,
      });
    },

    transition,
  };
}
