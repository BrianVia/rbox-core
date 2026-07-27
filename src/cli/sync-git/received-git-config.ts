import { repoCtxFromDisk, type GitSection, type RepoCtx } from "../../engine/index.js";
import { validateCanonicalGitConfig, type GitConfig } from "../../engine/git/config-sync.js";
import { readConfigSnapshot, sameConfigStatToken, type ConfigStatToken, type ConfigTransactionResult } from "../../engine/git/config-txn.js";
import { type ConfigShapeIdentity, type RepoRecordInput } from "../config.js";
import { completeConfigApply, configLaneState, type ConfigLaneState } from "../sync-state.js";
import { configReceiver, gitConfigHash, readLocalGitConfig, sameConfigShape } from "./config-lane.js";
import { configInvalidSkipLogged, configOwnershipSkipLogged } from "./shared.js";

/** The exact repository this config transition is bound to. */
export interface ReceivedGitConfigIdentity {
  readonly root: string;
  readonly relPath: string;
  readonly repoDir: string;
}

/**
 * Design 93 §6/§9 phases. They are distinct transitions, not dispatcher
 * branches: each is legal at exactly one point of the receive sequence, and
 * `inside-follow-lock` is additionally legal only while its common dir is
 * serialized. An executor is bound to one phase and refuses the others.
 */
export type ReceivedGitConfigPhase =
  | "sanitize-present"
  | "wire-absent"
  | "config-only"
  | "after-materialization"
  | "inside-follow-lock";

/** Receiver disposition chosen before either unchanged shortcut. A fresh target
 * has no config file yet and can only be written by the materialization step. */
export type ConfigApplyTarget =
  | { readonly fresh: true }
  | { readonly fresh: false; readonly shape: ConfigShapeIdentity; readonly configPath: string };

export interface ReceivedGitConfigDisposition {
  readonly due: boolean;
  readonly target: ConfigApplyTarget | undefined;
}

interface ConfigApplyPlanBody {
  readonly identity: ReceivedGitConfigIdentity;
  readonly target: ConfigApplyTarget;
  readonly incoming: GitConfig;
  readonly baseConfig: GitConfig | undefined;
}

export type ReceivedGitConfigPlan =
  | {
      readonly phase: "sanitize-present";
      readonly identity: ReceivedGitConfigIdentity;
      readonly shape: ConfigShapeIdentity;
      readonly localHash: string;
    }
  | { readonly phase: "wire-absent"; readonly identity: ReceivedGitConfigIdentity }
  | ({ readonly phase: "config-only" } & ConfigApplyPlanBody)
  | ({ readonly phase: "after-materialization" } & ConfigApplyPlanBody)
  | ({ readonly phase: "inside-follow-lock"; readonly commonDirToken: string } & ConfigApplyPlanBody);

export interface GitConfigExecutionReceipt {
  readonly identity: ReceivedGitConfigIdentity;
  readonly phase: ReceivedGitConfigPhase;
  readonly outcome: "baseline-recorded" | "baseline-cleared" | "baseline-unchanged" | "applied";
}

/**
 * The whole effect vocabulary of an executed plan. Nothing here reads or writes
 * sync state directly: every lane transition goes through the ledger, and every
 * filesystem mutation is one of the two injectable config adapters.
 */
export interface GitConfigExecutor {
  readonly identity: ReceivedGitConfigIdentity;
  /** The phase this executor is authorized for; a plan for another is refused. */
  readonly phase: ReceivedGitConfigPhase;
  /** Serialized common dir, present exactly for `inside-follow-lock`. */
  readonly commonDirToken?: string;
  readonly ledger: ConfigLaneLedger;
  materializeFresh(incoming: GitConfig): Promise<void>;
  /** Post-materialization receiver verification; throws when the fresh target
   * cannot be proven receiver-owned and readable. */
  inspectFreshInstall(): Promise<{ shape: ConfigShapeIdentity; config: GitConfig; token: ConfigStatToken }>;
  applyExisting(
    configPath: string,
    incoming: GitConfig,
    baseConfig: GitConfig | undefined,
  ): Promise<ConfigTransactionResult>;
  log(message: string): void;
}

export class ReceivedGitConfigPhaseMismatch extends Error {
  constructor(plan: ReceivedGitConfigPlan, executor: GitConfigExecutor) {
    super(
      `received git config plan (${plan.phase} ${plan.identity.root}/${plan.identity.relPath}) cannot execute against `
        + `${executor.phase} ${executor.identity.root}/${executor.identity.relPath}`,
    );
    this.name = "ReceivedGitConfigPhaseMismatch";
  }
}

function sameConfigIdentity(left: ReceivedGitConfigIdentity, right: ReceivedGitConfigIdentity): boolean {
  return left.root === right.root && left.relPath === right.relPath && left.repoDir === right.repoDir;
}

export interface ConfigLaneLedgerBinding {
  /** The pull's in-flight config-lane transition map, keyed by repo path. */
  readonly lane: Record<string, ConfigLaneState>;
  sourceSeq(relPath: string): number;
  /** The durable lane fields this pull started from. */
  storedLane(relPath: string): ConfigLaneState;
}

/**
 * Sole owner of the config-lane arithmetic for one pull. It records only
 * local-only lane fields; base/pending/deferral lanes are never touched here.
 */
export class ConfigLaneLedger {
  constructor(private readonly binding: ConfigLaneLedgerBinding) {}

  record(relPath: string): RepoRecordInput {
    return {
      sourceSeq: this.binding.sourceSeq(relPath),
      ...(this.binding.lane[relPath] ?? this.binding.storedLane(relPath)),
    };
  }

  replace(relPath: string, record: RepoRecordInput): void {
    this.binding.lane[relPath] = configLaneState(record);
  }

  /** A receiver shape change makes every recorded hash/token meaningless: reset
   * to the new identity alone rather than carrying a foreign shape's markers. */
  invalidateShape(relPath: string, shape: ConfigShapeIdentity | undefined): RepoRecordInput {
    const current = this.record(relPath);
    if (sameConfigShape(current.cfgShape, shape)) return current;
    const reset: RepoRecordInput = {
      sourceSeq: current.sourceSeq,
      ...(shape === undefined ? {} : { cfgShape: shape }),
    };
    this.replace(relPath, reset);
    return reset;
  }

  complete(
    relPath: string,
    shape: ConfigShapeIdentity,
    hashes: { pre: string; post: string; incoming: string; basePre?: string; postToken: ConfigStatToken },
  ): void {
    this.replace(relPath, {
      ...completeConfigApply(this.record(relPath), {
        pre: hashes.pre,
        post: hashes.post,
        incoming: hashes.incoming,
        ...(hashes.basePre === undefined ? {} : { basePre: hashes.basePre }),
        postToken: hashes.postToken,
      }),
      cfgShape: shape,
    });
  }
}

function configFailure(result: Exclude<ConfigTransactionResult, { status: "completed" }>): Error {
  return new Error(`config ${result.status}: ${result.fault.reason}`);
}

/**
 * Design 93 §6: a wire config that is not canonical, or that rides a scoped
 * section, is ignored while Git state continues. The reason is returned so the
 * caller can take the sanitation baseline phase instead of an apply phase.
 */
export function classifyIncomingConfigSanitation(
  identity: ReceivedGitConfigIdentity,
  wireSection: GitSection | undefined,
  log: (message: string) => void,
): string | undefined {
  if (wireSection?.config === undefined) return undefined;
  const config = validateCanonicalGitConfig(wireSection.config);
  const reason = !config.ok
    ? config.reason
    : wireSection.refScope === "scoped"
      ? "scoped git section cannot carry config"
      : undefined;
  if (reason) {
    const logKey = `${identity.root}\0${identity.relPath}`;
    if (!configInvalidSkipLogged.has(logKey)) {
      configInvalidSkipLogged.add(logKey);
      log(`git-sync WARNING ${identity.relPath}: ignored invalid incoming config (${reason}); Git state continues`);
    }
  }
  return reason;
}

export interface ReceivedGitConfigBaselineInput {
  readonly identity: ReceivedGitConfigIdentity;
  /** Non-undefined exactly when the incoming config was sanitized away. */
  readonly sanitizedReason: string | undefined;
  /** The raw wire section, before persistence sanitation. */
  readonly wireSection: GitSection | undefined;
  readonly laneDisabled: boolean;
  readonly leftoverPresent: boolean;
  repoContext(): Promise<RepoCtx | undefined>;
  readonly ledger: ConfigLaneLedger;
  log(message: string): void;
}

/**
 * The two non-mutating phases. Sanitation must not make the next push author a
 * corrective echo, and genuine wire absence must be able to heal an old writer
 * that stripped a valid config field — opposite lane transitions that share no
 * conditional with each other.
 */
export async function planReceivedGitConfigBaseline(
  input: ReceivedGitConfigBaselineInput,
): Promise<Extract<ReceivedGitConfigPlan, { phase: "sanitize-present" | "wire-absent" }> | undefined> {
  const { identity, ledger } = input;
  if (input.laneDisabled || !input.leftoverPresent) return undefined;

  if (input.sanitizedReason !== undefined) {
    const configCtx = await input.repoContext();
    const receiver = await ownedDirReceiver(identity, configCtx);
    if (!receiver) return undefined;
    const local = await readLocalGitConfig(identity.root, identity.relPath, configCtx, undefined, () => {
      const logKey = `${identity.root}\0${identity.relPath}\0credential`;
      if (!configInvalidSkipLogged.has(logKey)) {
        configInvalidSkipLogged.add(logKey);
        input.log(`git-sync WARNING ${identity.relPath}: skipped credential-bearing remote URL from config baseline`);
      }
    });
    if (local.status !== "ok") return undefined;
    return { phase: "sanitize-present", identity, shape: receiver.shape, localHash: local.cached.hash };
  }

  if (input.wireSection === undefined || input.wireSection.config !== undefined) return undefined;
  // Ordinary wire absence only consumes an existing authorship baseline. Keep
  // the context/ownership realpath cluster behind that pure marker: an
  // otherwise empty lane has nothing to clear.
  if (ledger.record(identity.relPath).cfgSynced === undefined) return undefined;
  if (!await ownedDirReceiver(identity, await input.repoContext())) return undefined;
  return { phase: "wire-absent", identity };
}

async function ownedDirReceiver(
  identity: ReceivedGitConfigIdentity,
  ctx: RepoCtx | undefined,
): Promise<{ shape: ConfigShapeIdentity; configPath: string } | undefined> {
  if (ctx?.kind !== "dir") return undefined;
  const receiver = await configReceiver(identity.root, ctx).catch(() => undefined);
  return receiver?.owned ? { shape: receiver.shape, configPath: receiver.configPath } : undefined;
}

export interface ReceivedGitConfigTargetInput {
  readonly identity: ReceivedGitConfigIdentity;
  readonly laneDisabled: boolean;
  readonly incoming: GitConfig | undefined;
  readonly leftoverPresent: boolean;
  readonly ledger: ConfigLaneLedger;
  log(message: string): void;
}

/**
 * Design 93 §6/§9. The due predicate is deliberately decided before EITHER
 * unchanged shortcut. Receiver ownership is local shape, not sender shape;
 * cross-shape rows skip config loudly once while Git keeps its existing
 * disposition. A shape mismatch first clears the old lane markers and records
 * the new identity in this pull's atomic repo transition.
 */
export async function planReceivedGitConfigTarget(
  input: ReceivedGitConfigTargetInput,
): Promise<ReceivedGitConfigDisposition> {
  const { identity, ledger } = input;
  if (input.laneDisabled || input.incoming === undefined) return { due: false, target: undefined };
  if (!input.leftoverPresent) {
    ledger.invalidateShape(identity.relPath, undefined);
    return { due: true, target: { fresh: true } };
  }
  const diskCtx = await repoCtxFromDisk(identity.repoDir).catch(() => undefined);
  if (!diskCtx) {
    ledger.invalidateShape(identity.relPath, undefined);
    skipOnce(identity, input.log, `git-sync config skipped ${identity.relPath}: receiver repository shape is unreadable/non-owned. rbox left shared Git settings alone; Git history can still sync.`);
    return { due: false, target: undefined };
  }
  const receiver = await configReceiver(identity.root, diskCtx);
  const lane = ledger.invalidateShape(identity.relPath, receiver.shape);
  if (!receiver.owned) {
    skipOnce(identity, input.log, `git-sync config skipped ${identity.relPath}: receiver ${diskCtx.kind} shape does not own the common config. rbox left shared Git settings alone; Git history can still sync.`);
    return { due: false, target: undefined };
  }
  const current = await readConfigSnapshot(receiver.configPath);
  const token = current.ok ? current.snapshot.token : undefined;
  return {
    due: gitConfigHash(input.incoming) !== lane.cfgApplied || !sameConfigStatToken(token, lane.cfgToken),
    target: { fresh: false, shape: receiver.shape, configPath: receiver.configPath },
  };
}

function skipOnce(identity: ReceivedGitConfigIdentity, log: (message: string) => void, message: string): void {
  const logKey = `${identity.root}\0${identity.relPath}`;
  if (configOwnershipSkipLogged.has(logKey)) return;
  configOwnershipSkipLogged.add(logKey);
  log(message);
}

export interface ReceivedGitConfigApplyRequest {
  readonly identity: ReceivedGitConfigIdentity;
  readonly phase: "config-only" | "after-materialization" | "inside-follow-lock";
  readonly disposition: ReceivedGitConfigDisposition;
  readonly incoming: GitConfig | undefined;
  readonly baseConfig: GitConfig | undefined;
  readonly commonDirToken?: string;
}

/**
 * Mints the plan for one apply phase, or nothing when that phase may not run.
 * A fresh target exists only because materialization created the repository, so
 * no earlier phase is allowed to write it.
 */
export function planReceivedGitConfigApply(
  request: ReceivedGitConfigApplyRequest,
): ReceivedGitConfigPlan | undefined {
  const { disposition, incoming } = request;
  if (!disposition.due || disposition.target === undefined || incoming === undefined) return undefined;
  if (disposition.target.fresh && request.phase !== "after-materialization") return undefined;
  const body: ConfigApplyPlanBody = {
    identity: request.identity,
    target: disposition.target,
    incoming,
    baseConfig: request.baseConfig,
  };
  if (request.phase === "inside-follow-lock") {
    return { phase: "inside-follow-lock", commonDirToken: request.commonDirToken!, ...body };
  }
  return { phase: request.phase, ...body };
}

/**
 * Executes one bound phase. Every failure path throws: config faults are the
 * caller's independent-retry signal and must never be recorded as a completed
 * lane transition, so the ledger is written only after the mutation succeeds.
 */
export async function applyReceivedGitConfig(
  plan: ReceivedGitConfigPlan,
  executor: GitConfigExecutor,
): Promise<GitConfigExecutionReceipt> {
  if (plan.phase !== executor.phase || !sameConfigIdentity(plan.identity, executor.identity)) {
    throw new ReceivedGitConfigPhaseMismatch(plan, executor);
  }
  if (plan.phase === "inside-follow-lock" && plan.commonDirToken !== executor.commonDirToken) {
    throw new ReceivedGitConfigPhaseMismatch(plan, executor);
  }
  const relPath = plan.identity.relPath;
  const ledger = executor.ledger;

  if (plan.phase === "sanitize-present") {
    const beforeLane = ledger.record(relPath);
    const lane = ledger.invalidateShape(relPath, plan.shape);
    const priorBaseline = beforeLane.cfgShape === undefined || sameConfigShape(beforeLane.cfgShape, plan.shape)
      ? beforeLane.cfgSynced
      : undefined;
    ledger.replace(relPath, {
      ...lane,
      // Preserve an existing same-shape baseline: if the user changed A→B before
      // this pull, B must remain publishable. Seed the current hash only for the
      // first sanitation observation.
      cfgSynced: priorBaseline ?? plan.localHash,
      cfgShape: plan.shape,
    });
    return { identity: plan.identity, phase: plan.phase, outcome: "baseline-recorded" };
  }

  if (plan.phase === "wire-absent") {
    const beforeLane = ledger.record(relPath);
    if (beforeLane.cfgSynced === undefined) {
      return { identity: plan.identity, phase: plan.phase, outcome: "baseline-unchanged" };
    }
    const { cfgSynced: _cfgSynced, ...withoutSynced } = beforeLane;
    ledger.replace(relPath, withoutSynced);
    return { identity: plan.identity, phase: plan.phase, outcome: "baseline-cleared" };
  }

  if (plan.target.fresh) {
    await executor.materializeFresh(plan.incoming);
    const installed = await executor.inspectFreshInstall();
    ledger.complete(relPath, installed.shape, {
      pre: gitConfigHash({}),
      post: gitConfigHash(installed.config),
      incoming: gitConfigHash(plan.incoming),
      ...(plan.baseConfig === undefined ? {} : { basePre: gitConfigHash(plan.baseConfig) }),
      postToken: installed.token,
    });
    return { identity: plan.identity, phase: plan.phase, outcome: "applied" };
  }

  const result = await executor.applyExisting(plan.target.configPath, plan.incoming, plan.baseConfig);
  if (result.status !== "completed") throw configFailure(result);
  for (const warning of result.warnings) {
    try {
      executor.log(`git-sync WARNING ${relPath}: config ${warning}`);
    } catch {
      // Observability after the rename commit point is strictly non-fatal.
    }
  }
  ledger.complete(relPath, plan.target.shape, {
    pre: result.preHash,
    post: result.postHash,
    incoming: result.incomingHash,
    ...(result.baseHash === undefined ? {} : { basePre: result.baseHash }),
    postToken: result.postToken,
  });
  return { identity: plan.identity, phase: plan.phase, outcome: "applied" };
}
