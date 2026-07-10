import fs from "node:fs/promises";
import path from "node:path";
import {
  applyGitState,
  assertGitTargetWithinRoot,
  captureGitState,
  GitCaptureDeferredError,
  discoverGitRepos,
  gitIdentity,
  gitIdentityKey,
  gitPreflight,
  hashBytes,
  inTreeWorktreeParentRel,
  inTreeWorktreeParentRelFromCtx,
  isGitBusy,
  gitSectionBlobRefs,
  gitSectionNewestLink,
  gitSectionTips,
  preserveGitConflict,
  projectIdentity,
  quarantineAndWipeGitState,
  repoCtxFromDisk,
  poolMap,
  MAX_PACK_CHAIN,
  MAX_GIT_REPOS,
  writeFileAtomic,
  type DiscoveredGitRepo,
  type GitIdentity,
  type GitPackLink,
  type GitPreflightResult,
  type GitRepoKind,
  type GitRefScope,
  type GitSection,
  type IgnoreMatcher,
  type Manifest,
  type BlobStore,
  type RepoCtx,
} from "../engine/index.js";
import { repoCtx } from "../engine/git/shared.js";
import { OP_STATE_DIRS, OP_STATE_FILES } from "../engine/manifest-validate.js";
import { canonicalizeGitConfig, type GitConfig } from "../engine/git/config-sync.js";
import {
  applyConfigTransaction,
  materializeFreshGitConfig,
  readConfigSnapshot,
  readParsedConfigSnapshot,
  readStableParsedConfigSnapshot,
  type ConfigFault,
  type ConfigStatToken,
  type ConfigTransactionResult,
  type GitConfigRunner,
} from "../engine/git/config-txn.js";
import { repoRecordsForState, type ConfigShapeIdentity, type RepoRecordInput, type SyncState, type WorkspaceConfig } from "./config.js";
import type { SyncRemote } from "./remote.js";
import { completeConfigApply, type ConfigLaneState } from "./sync-state.js";
import type { TransferProgress } from "./transfer-progress.js";
import { PER_FILE_UPLOAD_ATTEMPTS } from "./sync-recovery.js";

// ---- git-sync orchestration (design 43 §§6-7, 9, 13.5) ------------------------------
//
// Extracted from sync.ts so the FILE-sync flow there reads top-to-bottom: this module owns
// the per-repo git plan machinery (push), the per-repo apply loop (pull), and the git
// bookkeeping state transitions. Its interface is narrow and typed — planGitSections /
// applyGitSections take explicit inputs (root, cfg, state, …) and never reach back into
// sync.ts internals. Every [v2]…[v6] codex-rule citation is load-bearing and stays attached
// to the logic it governs.

/** Bundling is CPU/IO heavy — bound concurrent captures (design 43 §6.3). */
const GIT_CAPTURE_CONCURRENCY = 4;
const GIT_APPLY_CONCURRENCY_DEFAULT = 6;
/** Cross-shape config skips are policy, not a per-tick error. Keep daemon logs
 * loud once per workspace/repo without repeating forever on every pull. */
const configOwnershipSkipLogged = new Set<string>();
/** Credential-bearing URLs are a capture-side security event, not ordinary bad
 * grammar. Log them once per workspace/repo while continuing with the safe
 * projection so a daemon cannot flood its log on every tick. */
const configCredentialSkipLogged = new Set<string>();

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw || !/^-?\d+$/.test(raw)) return fallback;
  try {
    const n = BigInt(raw);
    if (n < BigInt(min)) return min;
    if (n > BigInt(max)) return max;
    return Number(n);
  } catch {
    return fallback;
  }
};

const gitApplyConcurrency = (): number => envInt("RBOX_GIT_APPLY_CONCURRENCY", GIT_APPLY_CONCURRENCY_DEFAULT, 1, 16);

/** The push-side new-repo admission cap (design 43 §3 [v2, M4]). Env-overridable for
 *  tests/tuning; the manifest-validation bound stays the hard MAX_GIT_REPOS. The cap
 *  bounds capture WORK for newly-discovered repos — base-carrying repos are ALWAYS
 *  carried, so over-cap can never read as mass deletion on receivers. */
const gitRepoCap = (): number => {
  const n = Number(process.env.RBOX_GIT_REPO_CAP);
  return Number.isInteger(n) && n >= 1 && n <= MAX_GIT_REPOS ? n : MAX_GIT_REPOS;
};

const repoDirOf = (root: string, relPath: string) => (relPath === "." ? root : path.join(root, relPath));
/** The narrower of two ref scopes ("scoped" ⊂ "all") — the projection target for every
 *  cross-scope identity comparison (design 43 §7). */
const narrowerScope = (a: GitRefScope, b: GitRefScope | undefined): GitRefScope => (a === "scoped" || b === "scoped" ? "scoped" : "all");
const projectedKey = (g: GitSection | GitIdentity | undefined, scope: GitRefScope): string => gitIdentityKey(g ? projectIdentity(g, scope) : undefined);
const carryMatrixMatches = (baseSec: GitSection, pfKind: GitRepoKind, identityKey: string): boolean =>
  pfKind === "dir"
    ? baseSec.refScope === "all" && identityKey === gitIdentityKey(baseSec)
    : baseSec.refScope === "scoped"
      ? identityKey === gitIdentityKey(baseSec)
      : identityKey === projectedKey(baseSec, "scoped");
export const gitReposManifestSchema = (gitRepos: Record<string, GitSection> | undefined): 2 | 3 | undefined =>
  gitRepos ? (Object.values(gitRepos).some((s) => (s.packChain?.length ?? 0) > 0) ? 3 : 2) : undefined;
const emptyToUndef = <T,>(o: Record<string, T>): Record<string, T> | undefined => (Object.keys(o).length ? o : undefined);
const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);

export interface CachedLocalCfg {
  hash: string;
  nonEmpty: boolean;
}

type LocalCfgRead =
  | { status: "ok"; config: GitConfig; cached: CachedLocalCfg }
  | { status: "over-bounds"; reason: string }
  | { status: "failed"; fault: ConfigFault };

/** Hash the canonical wire value, including the meaningful empty `{}` value. */
export function gitConfigHash(config: GitConfig): string {
  return hashBytes(Buffer.from(JSON.stringify(config)));
}

/** Design 93 §6 presence/edit predicate. Base presence is intentionally distinct
 * from an empty base config, and an unset sync point never equals a real hash. */
export function shouldPublishGitConfig(
  baseConfig: GitConfig | undefined,
  local: CachedLocalCfg,
  cfgSynced: string | undefined
): boolean {
  if (baseConfig === undefined) return local.nonEmpty;
  const baseHash = gitConfigHash(baseConfig);
  return local.hash !== baseHash && local.hash !== cfgSynced;
}

async function readLocalGitConfig(
  root: string,
  rel: string,
  diskCtx?: RepoCtx,
  runGit?: GitConfigRunner,
  onCredentialSkip?: () => void
): Promise<LocalCfgRead> {
  const repoDir = repoDirOf(root, rel);
  const ctx = diskCtx ?? (await repoCtxFromDisk(repoDir).catch(() => undefined));
  if (!ctx) {
    return {
      status: "failed",
      fault: { disposition: "transient", reason: "read-error", error: new Error("git repository context unavailable") },
    };
  }
  const configPath = path.join(ctx.commonDir, "config");
  let lastFault: ConfigFault | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await readStableParsedConfigSnapshot(repoDir, configPath, "initial", runGit);
    if (!read.ok) {
      lastFault = read.fault;
      if (read.fault.disposition === "permanent") return { status: "failed", fault: read.fault };
      continue;
    }
    const canonical = canonicalizeGitConfig(read.snapshot.entries);
    if (canonical.rejected.some((item) => item.credential)) onCredentialSkip?.();
    if (!canonical.ok) {
      if (canonical.overBounds) return { status: "over-bounds", reason: canonical.reason };
      return {
        status: "failed",
        fault: { disposition: "permanent", reason: "parse-error", error: new Error(canonical.reason) },
      };
    }
    return {
      status: "ok",
      config: canonical.config,
      cached: { hash: gitConfigHash(canonical.config), nonEmpty: Object.keys(canonical.config).length > 0 },
    };
  }
  return {
    status: "failed",
    fault: lastFault ?? { disposition: "transient", reason: "read-error" },
  };
}

function sameConfigToken(a: ConfigStatToken | undefined, b: ConfigStatToken | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function sameConfigShape(a: ConfigShapeIdentity | undefined, b: ConfigShapeIdentity | undefined): boolean {
  return a !== undefined && b !== undefined && a.shape === b.shape &&
    a.commonDir.realpath === b.commonDir.realpath && a.commonDir.dev === b.commonDir.dev &&
    a.commonDir.ino === b.commonDir.ino && a.commonDir.birthtime === b.commonDir.birthtime;
}

/** Design 93 §9 receiver ownership: only a standalone dir repo whose common
 * store is contained by this workspace owns its local config lane. */
async function configReceiver(root: string, ctx: RepoCtx): Promise<{ owned: boolean; shape: ConfigShapeIdentity; configPath: string }> {
  const [rootReal, gitReal, commonReal, stat] = await Promise.all([
    fs.realpath(root),
    fs.realpath(ctx.gitDir),
    fs.realpath(ctx.commonDir),
    fs.stat(ctx.commonDir, { bigint: true }),
  ]);
  const relative = path.relative(rootReal, commonReal);
  const contained = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  const shape: ConfigShapeIdentity = {
    shape: ctx.kind,
    commonDir: {
      realpath: commonReal,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      birthtime: stat.birthtimeNs > 0n ? stat.birthtimeNs.toString() : "0",
    },
  };
  return { owned: ctx.kind === "dir" && gitReal === commonReal && contained, shape, configPath: path.join(ctx.commonDir, "config") };
}

function configLaneOnly(record: RepoRecordInput): ConfigLaneState {
  return {
    ...(record.cfgSynced === undefined ? {} : { cfgSynced: record.cfgSynced }),
    ...(record.cfgApplied === undefined ? {} : { cfgApplied: record.cfgApplied }),
    ...(record.cfgToken === undefined ? {} : { cfgToken: record.cfgToken }),
    ...(record.cfgShape === undefined ? {} : { cfgShape: record.cfgShape }),
  };
}

function incrementalCapturePlan(cfg: WorkspaceConfig, baseSec: GitSection | undefined, forced: boolean): { basisTips: string[]; chain: GitPackLink[] } | undefined {
  if (cfg.git?.incremental === false || !baseSec || forced) return undefined;
  const basisTips = gitSectionTips(baseSec);
  if (basisTips.length === 0) return undefined;
  const chain = [...(baseSec.packChain ?? []), gitSectionNewestLink(baseSec)];
  if (chain.length + 1 > MAX_PACK_CHAIN) return undefined;
  return { basisTips, chain };
}

function exceedsPackChainByteBound(chain: GitPackLink[], newestCipherSize: number): boolean {
  if (chain.length === 0) return false;
  const incrementBytes = chain.slice(1).reduce((n, l) => n + l.cipherSize, 0) + newestCipherSize;
  return incrementBytes >= chain[0]!.cipherSize;
}

function isStrictPathAncestor(ancestor: string, rel: string): boolean {
  if (ancestor === rel) return false;
  if (ancestor === ".") return rel !== ".";
  return rel.startsWith(`${ancestor}/`);
}

function nestedRepoChains(keys: readonly string[]): string[][] {
  const chains: string[][] = [];
  const chainByRel = new Map<string, string[]>();
  const seen: string[] = [];
  for (const rel of keys) {
    let nearestAncestor: string | undefined;
    for (let i = seen.length - 1; i >= 0; i--) {
      const candidate = seen[i]!;
      if (isStrictPathAncestor(candidate, rel)) {
        nearestAncestor = candidate;
        break;
      }
    }
    const chain = nearestAncestor ? chainByRel.get(nearestAncestor)! : [];
    if (!nearestAncestor) chains.push(chain);
    chain.push(rel);
    chainByRel.set(rel, chain);
    seen.push(rel);
  }
  return chains;
}

async function chainLock<T>(locks: Map<string, Promise<void>>, key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  locks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

async function gitApplyMutationKey(root: string, rel: string): Promise<string> {
  const repoDir = repoDirOf(root, rel);
  const ctx = await repoCtxFromDisk(repoDir).catch(() => undefined);
  if (ctx) return path.resolve(ctx.commonDir);
  const dotGit = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
  return dotGit ? path.resolve(repoDir, ".git") : path.resolve(repoDir);
}

async function capturePlannedGitSection(
  root: string,
  rel: string,
  cfg: WorkspaceConfig,
  baseSec: GitSection | undefined,
  api: SyncRemote,
  kek: Buffer,
  uploadsDir: string,
  forced: boolean,
  backoff?: (attempt: number) => Promise<void>,
  onBytes?: (absoluteBytes: number) => void
): Promise<{ section?: GitSection; reason?: string }> {
  const repoDir = repoDirOf(root, rel);
  const capture = (opts: { basis?: { tips: string[] }; onBasisFallback?: (reason: string) => void } = {}) =>
    captureGitState(repoDir, api.blobStore(), kek, {
      workspaceRoot: root,
      uploadsDir,
      uploadAttempts: PER_FILE_UPLOAD_ATTEMPTS,
      backoff,
      onBytes,
      ...opts,
    });

  const incremental = incrementalCapturePlan(cfg, baseSec, forced);
  let basisFellBack = false;
  const section = await capture(
    incremental
      ? {
          basis: { tips: incremental.basisTips },
          onBasisFallback: () => {
            basisFellBack = true;
          },
        }
      : {}
  );
  if (!section || !incremental || basisFellBack) return { section };
  if (!exceedsPackChainByteBound(incremental.chain, section.bundleCipherSize)) {
    return { section: { ...section, packChain: incremental.chain } };
  }

  const full = await capture();
  return full ? { section: full } : { reason: "capture returned nothing during git pack recompaction" };
}

/** Local-vs-base divergence, projected onto the narrower of the two scopes (§7).
 *  No base → ANY local git identity is divergence-from-nothing (an independently
 *  created local repo must never be clobbered). No local identity (no repo, empty
 *  repo, deleted/unusable `.git`) → never diverged: there is no committed local work
 *  to preserve, so a clean (re)materialization loses nothing. */
function localDivergedFromBase(localId: GitIdentity | undefined, base: GitSection | undefined): boolean {
  if (!localId) return false;
  if (!base) return true;
  const n = narrowerScope(localId.refScope, base.refScope);
  return projectedKey(localId, n) !== projectedKey(base, n);
}

/** The outcome of push-side git orchestration: the outbound `gitRepos` map, whether it
 *  differs from what the last commit carried, the local-only state after this cycle
 *  (persisted only on a successful commit — recomputed idempotently otherwise), and
 *  the forensic counts for the §10 log line. */
export interface GitPushPlan {
  gitRepos?: Record<string, GitSection>;
  changed: boolean;
  gitReposRemoved?: Record<string, string>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
  /** Config hashes authored by this exact plan. Step 4 deliberately initializes
   * this empty; publication/capture rows add entries in steps 5 and 7. */
  authoredCfgHashByRepo: Record<string, string>;
  captured: string[];
  carried: string[];
  deferred: Array<{ relPath: string; reason: string }>;
  /** Design 68 §3.3 — in-tree linked-worktree pointers whose full-store capture was
   *  policy-skipped because the owning main clone is captured in this same cycle (history
   *  travels with the parent bundle). Base-carry, never a drop — so no removal memory. */
  skipped: Array<{ relPath: string; reason: string }>;
  removed: string[];
  gitPlanStats?: GitPlanStats;
}

export interface GitPlanStats {
  repos: number;
  fpHits: number;
  fpMisses: number;
  fpUntrusted: number;
  spawnedRepos: number;
  pointerPreSkips: number;
  parentRelCached: number;
  carried: number;
  captured: number;
}

export interface GitPlanOptions {
  /** Forensic sink shared with the surrounding sync operation. */
  onGitLog?: (line: string) => void;
  /** Deterministic test seam for the snapshot-only config subprocess. */
  gitConfigRunner?: GitConfigRunner;
}

/**
 * Push-side git orchestration (design 43 §6): discover every repo in the tree, then per
 * repo either CARRY (pending section, needs-resolution checkpoint, or unchanged identity
 * per the §7 shape×scope matrix), CAPTURE (bounded pool), DEFER with base carry (any
 * per-repo failure — never abort the push), or REMOVE (repo dir gone entirely, §9).
 * `force` is the per-relPath 422 recapture set [v2, M5]: forced repos skip the carry
 * fast-path; a forced repo that cannot recapture is DROPPED from this commit (the
 * non-looping failure path [v3]) rather than re-referencing blobs the server lost.
 */
export async function planGitSections(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  api: SyncRemote,
  force: ReadonlySet<string>,
  matcher: IgnoreMatcher,
  /** Per-repo capture progress (the `gitcap` phase): the longest silent phase on a
   *  repo-heavy first push — one `git bundle` per repo, minutes each. Emits after each
   *  capture settles so `done` is a truthful completed-count under bounded concurrency;
   *  `detail` is the repo just captured. Display-only. */
  onProgress?: TransferProgress,
  backoff?: (attempt: number) => Promise<void>,
  options: GitPlanOptions = {}
): Promise<GitPushPlan> {
  const base = state.lastSyncedManifest.gitRepos ?? {};
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  const pending = { ...(state.gitPendingRemote ?? {}) };
  const captured: string[] = [];
  let carried: string[] = [];
  const authoredCfgHashByRepo: Record<string, string> = {};
  const removed: string[] = [];
  const deferred: Array<{ relPath: string; reason: string }> = [];
  const configLaneDefers = new Set<(typeof deferred)[number]>();
  const skipped: Array<{ relPath: string; reason: string }> = [];
  const out: Record<string, GitSection> = {};
  const cache = await loadGitDivergenceCache(root);
  const fingerprintRun = gitFingerprintRun("per-decision");
  const fastPathParentRel = new Map<string, string | undefined>();
  const stats: GitPlanStats = {
    repos: 0,
    fpHits: 0,
    fpMisses: 0,
    fpUntrusted: 0,
    spawnedRepos: 0,
    pointerPreSkips: 0,
    parentRelCached: 0,
    carried: 0,
    captured: 0,
  };
  const glog = options.onGitLog ?? ((line: string) => console.error(line));
  const logOnce = (seen: Set<string>, rel: string, line: string) => {
    const key = `${root}\0${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    glog(line);
  };
  const noteCredentialSkip = (rel: string) =>
    logOnce(configCredentialSkipLogged, rel, `git-sync WARNING ${rel}: skipped credential-bearing remote URL from config capture`);
  const readConfigForPush = (rel: string, diskCtx?: RepoCtx) =>
    readLocalGitConfig(root, rel, diskCtx, options.gitConfigRunner, () => noteCredentialSkip(rel));
  const plan = (): GitPushPlan => {
    // Changed = the outbound map differs from what the LAST COMMIT carried. For a
    // pending repo the last commit carried the pending section itself (see the per-repo
    // base-advance in pushManifest), so the expected-previous map is base ∪ pending —
    // a steady pending carry is NOT a change (no echo-commit storm).
    const prev: Record<string, GitSection> = { ...base, ...(state.gitPendingRemote ?? {}) };
    let changed = false;
    for (const k of new Set([...Object.keys(out), ...Object.keys(prev)])) {
      if (!out[k] || !prev[k] || (out[k] !== prev[k] && JSON.stringify(out[k]) !== JSON.stringify(prev[k]))) {
        changed = true;
        break;
      }
    }
    return {
      gitRepos: emptyToUndef(out),
      changed,
      gitReposRemoved: emptyToUndef(removedMem),
      gitNeedsResolution: emptyToUndef(needsRes),
      gitPendingRemote: emptyToUndef(pending),
      authoredCfgHashByRepo,
      captured,
      carried,
      deferred,
      skipped,
      removed,
      gitPlanStats: { ...stats, carried: carried.length, captured: captured.length },
    };
  };
  if (!cfg.syncGit) {
    // Opt-out: out stays empty → any base entries read as removal (the opt-out
    // propagates), and the local-only bookkeeping is abandoned with it — a surviving
    // pending entry would otherwise re-trigger the per-repo base restore every push
    // (changed forever → echo-commit loop).
    for (const k of Object.keys(pending)) delete pending[k];
    for (const k of Object.keys(needsRes)) delete needsRes[k];
    for (const k of Object.keys(removedMem)) delete removedMem[k];
    return plan();
  }
  if (!cfg.kek) throw new Error("git-sync requires an encryption key (E2EE)"); // §28: artifacts are encrypted
  const kek = cfg.kek;

  const discovered = await discoverGitRepos(root, matcher);
  const kindByPath = new Map(discovered.map((d) => [d.relPath, d.kind]));

  // §9: removal memories are pruned ONLY when the local `.git` genuinely disappears —
  // never on mere discovery absence (an ignored-but-present leftover is undiscoverable
  // yet must keep its resurrection guard for when it is unignored; codex step-3 MAJOR).
  for (const rel of Object.keys(removedMem)) {
    if (kindByPath.has(rel)) continue;
    const dotGit = await fs.lstat(path.join(repoDirOf(root, rel), ".git")).catch(() => undefined);
    if (!dotGit) delete removedMem[rel];
  }

  const keys = [...new Set([...kindByPath.keys(), ...Object.keys(base), ...Object.keys(pending)])].sort();
  stats.repos = keys.length;
  // New-repo admission budget [v2, M4]: base/pending repos never count as new work.
  const cap = gitRepoCap();
  let admitted = new Set([...Object.keys(base), ...Object.keys(pending)]).size;

  let toCapture: string[] = [];
  const carryOwnedWithConfig = async (rel: string, baseSec: GitSection, bracketed?: LocalCfgRead, knownCtx?: RepoCtx): Promise<void> => {
    out[rel] = baseSec;
    carried.push(rel);
    const diskCtx = knownCtx ?? (await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined));
    if (!diskCtx || diskCtx.kind !== "dir") {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: local ${diskCtx?.kind ?? "unreadable"} shape does not own the common config`);
      return;
    }
    const receiver = await configReceiver(root, diskCtx).catch(() => undefined);
    if (!receiver?.owned) {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: local common config is outside workspace ownership`);
      return;
    }
    const localCfg = bracketed ?? (await readConfigForPush(rel));
    if (localCfg.status === "over-bounds") {
      const item = {
        relPath: rel,
        reason: `git config over wire bounds — publication disabled; carrying base verbatim (${localCfg.reason})`,
      };
      deferred.push(item);
      configLaneDefers.add(item);
      return;
    }
    if (localCfg.status === "failed") {
      const item = {
        relPath: rel,
        reason: `git config ${localCfg.fault.disposition === "permanent" ? "disabled" : "deferred"} (${localCfg.fault.reason}) — carrying base verbatim`,
      };
      deferred.push(item);
      configLaneDefers.add(item);
      return;
    }
    if (!shouldPublishGitConfig(baseSec.config, localCfg.cached, state.repoRecords?.[rel]?.cfgSynced)) return;
    out[rel] = { ...baseSec, config: localCfg.config };
    authoredCfgHashByRepo[rel] = localCfg.cached.hash;
  };
  const carryBaseConfig = (section: GitSection, baseSec: GitSection | undefined): GitSection => {
    const carried = { ...section };
    delete carried.config;
    if (baseSec?.config !== undefined) carried.config = baseSec.config;
    return carried;
  };
  const captureWithConfig = async (rel: string, section: GitSection): Promise<GitSection> => {
    const repoDir = repoDirOf(root, rel);
    const diskCtx = await repoCtxFromDisk(repoDir).catch(() => undefined);
    if (!diskCtx || diskCtx.kind !== "dir" || section.refScope !== "all") {
      logOnce(
        configOwnershipSkipLogged,
        rel,
        `git-sync config skipped ${rel}: capture repository is ${diskCtx?.kind ?? "unreadable"}/scoped and does not own the common config`
      );
      const unowned = { ...section };
      delete unowned.config;
      return unowned;
    }
    let receiver: Awaited<ReturnType<typeof configReceiver>>;
    try {
      receiver = await configReceiver(root, diskCtx);
    } catch (error) {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: capture ownership could not be proven (${errMsg(error)})`);
      return carryBaseConfig(section, undefined);
    }
    if (!receiver.owned) {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: capture common config is outside workspace ownership`);
      return carryBaseConfig(section, undefined);
    }

    let localCfg: LocalCfgRead;
    try {
      localCfg = await readConfigForPush(rel, diskCtx);
    } catch (error) {
      localCfg = {
        status: "failed",
        fault: { disposition: "transient", reason: "read-error", error },
      };
    }
    if (localCfg.status === "over-bounds") {
      const item = {
        relPath: rel,
        reason: `git config over wire bounds — capture config suppressed; carrying base config (${localCfg.reason})`,
      };
      deferred.push(item);
      configLaneDefers.add(item);
      return carryBaseConfig(section, base[rel]);
    }
    if (localCfg.status === "failed") {
      const item = {
        relPath: rel,
        reason: `git config ${localCfg.fault.disposition === "permanent" ? "disabled" : "deferred"} during capture (${localCfg.fault.reason}) — carrying base config`,
      };
      deferred.push(item);
      configLaneDefers.add(item);
      return carryBaseConfig(section, base[rel]);
    }
    const embedded = { ...section, config: localCfg.config };
    authoredCfgHashByRepo[rel] = gitConfigHash(embedded.config);
    return embedded;
  };
  /** Per-repo failure → defer. Forced (422) repos take the M5 non-looping DROP instead:
   *  their base section references exactly the blobs the server lost, so carrying it
   *  would 422 forever — drop from THIS commit; the daemon re-captures when possible. */
  const deferOne = (rel: string, reason: string) => {
    if (force.has(rel)) {
      deferred.push({ relPath: rel, reason: `${reason} — section dropped from this commit (its blobs are missing server-side)` });
      return;
    }
    const b = base[rel];
    if (b) out[rel] = b; // defer-with-base-carry: never regress a synced repo (§6.4)
    deferred.push({ relPath: rel, reason });
  };
  const pendingPointerPreSkips: Array<{ relPath: string; parentRel: string; admissionAlreadyCounted: boolean }> = [];
  const processRepoSlowPath = async (
    rel: string,
    kind: GitRepoKind | undefined,
    baseSec: GitSection | undefined,
    fastLookup?: FingerprintHitProbeResult,
    opts: { admissionAlreadyCounted?: boolean } = {}
  ): Promise<void> => {
    stats.spawnedRepos++;
    const probeBeforeFingerprint = fastLookup?.fingerprint ?? (await gitFingerprint(fingerprintRun, root, rel));
    const recomputeCacheProbe = async (): Promise<DivergenceCacheProbeSnapshot> => {
      const beforeFingerprint = await gitFingerprint(fingerprintRun, root, rel);
      if (await isGitBusy(repoDirOf(root, rel))) {
        const { probe } = await buildPlanProbe(root, rel, beforeFingerprint.diskCtx);
        return { beforeFingerprint, probe, kind };
      }
      const pf = await gitPreflight(repoDirOf(root, rel));
      const { probe } = await buildPlanProbe(root, rel, beforeFingerprint.diskCtx, pf);
      return { beforeFingerprint, probe, kind: pf.kind ?? kind };
    };

    // Quiescence before ANY identity-based decision (mirrors the pull side): a lock
    // makes write-tree fail → raw-index identity fallback, which would spuriously
    // CLEAR a needsResolution suppression (republishing the conflicted state — the
    // exact [v2, M2] hazard) or a removal memory (resurrection), or re-capture a
    // mid-operation repo. Busy → defer with base carry; next cycle re-examines.
    if (await isGitBusy(repoDirOf(root, rel))) {
      const { probe } = await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx);
      await writeDivergenceCacheEntry(
        fingerprintRun,
        root,
        rel,
        cache,
        probe,
        kind,
        probeBeforeFingerprint,
        recomputeCacheProbe,
        () => noteCredentialSkip(rel)
      ).catch(() => undefined);
      deferOne(rel, "git busy (lock present)");
      return;
    }

    // Removal memory [v2, B4]: a leftover whose identity still equals the memory is the
    // untouched residue of a remote deletion — NOT re-added. Identity changed → the
    // user worked there → re-adding is intentional; clear the memory and fall through.
    // An UNREADABLE leftover (dangling pointer, transient) keeps its guard and is
    // skipped — clearing on a transient would re-add unchanged git once it heals.
    if (!baseSec && removedMem[rel] !== undefined) {
      const id = await gitIdentity(repoDirOf(root, rel));
      if (!id || gitIdentityKey(id) === removedMem[rel]) return;
      delete removedMem[rel];
    }

    // needsResolution [v2, M2]: carry the checkpointed base until the local identity
    // CHANGES from the recorded conflict-time value (republish must be intentional).
    if (needsRes[rel] !== undefined) {
      const id = await gitIdentity(repoDirOf(root, rel));
      if (gitIdentityKey(id) === needsRes[rel]) {
        if (baseSec) {
          out[rel] = baseSec;
          carried.push(rel);
        }
        return;
      }
      delete needsRes[rel];
    }

    const pf = await gitPreflight(repoDirOf(root, rel));
    if (!pf.ok) {
      const builtProbe = await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx, pf);
      if (builtProbe.diskCtx?.kind === "pointer") fastPathParentRel.set(rel, builtProbe.parentRel);
      const probe = builtProbe.probe;
      await writeDivergenceCacheEntry(
        fingerprintRun,
        root,
        rel,
        cache,
        probe,
        pf.kind ?? kind,
        probeBeforeFingerprint,
        recomputeCacheProbe,
        () => noteCredentialSkip(rel)
      ).catch(() => undefined);
      // STRUCTURAL refusal (shallow/bare/alternates/…): the shape can't sync and won't
      // heal by waiting — DROP the section instead of carrying it. Carrying would be
      // permanent poison: identity can't see the structural property, so a base section
      // authored before the shape was detected (e.g. a shallow clone's incomplete
      // bundle, found by live validation) would carry — and fail-close on every
      // receiver — forever. Dropping self-heals: receivers clean their bookkeeping via
      // absence (never touching local .git), and when the user fixes the shape a fresh
      // preflight passes with no base tie to the old bad section.
      if (pf.structural) {
        if (baseSec) removed.push(rel);
        deferred.push({ relPath: rel, reason: `${pf.reason} — section ${baseSec ? "dropped" : "not captured"}` });
        delete needsRes[rel];
        return;
      }
      deferOne(rel, pf.reason ?? "preflight failed");
      return;
    }
    const builtProbe = await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx, pf);
    if (builtProbe.diskCtx?.kind === "pointer") fastPathParentRel.set(rel, builtProbe.parentRel);
    const id = builtProbe.identity;
    const idKey = builtProbe.probe.identityKey;
    const liveKind = pf.kind ?? kind;
    const probe = builtProbe.probe;
    const cacheWrite = await writeDivergenceCacheEntry(
      fingerprintRun,
      root,
      rel,
      cache,
      probe,
      liveKind,
      probeBeforeFingerprint,
      recomputeCacheProbe,
      () => noteCredentialSkip(rel)
    ).catch((): DivergenceCacheWriteResult => ({ kind: liveKind }));
    if (!id) {
      // empty repo (no commits yet): nothing to capture; keep any synced base.
      if (baseSec) {
        out[rel] = baseSec;
        carried.push(rel);
      }
      return;
    }

    // §7 capture-side carry-forward — the normative shape×scope matrix [v3; v4]:
    //   dir/all-base      → carry on full-identity match (design-02 semantics)
    //   dir/scoped-base   → ALWAYS capture fresh (a projected compare would hide a
    //                       genuinely new local branch forever)
    //   pointer/scoped    → carry on scoped-identity match
    //   pointer/all-base  → the explicit wider-carry exception: carry when the base's
    //                       SCOPED PROJECTION matches (terminates the convergence loop)
    if (baseSec && !force.has(rel)) {
      if (!isGitRepoKind(liveKind)) {
        deferOne(rel, "preflight did not report a usable git repo kind");
        return;
      }
      const carry = carryMatrixMatches(baseSec, liveKind, idKey);
      if (carry) {
        await carryOwnedWithConfig(rel, baseSec, cacheWrite.localCfg, builtProbe.diskCtx);
        return;
      }
    }
    if (!baseSec) {
      if (!opts.admissionAlreadyCounted) {
        if (admitted >= cap) {
          deferred.push({ relPath: rel, reason: `over the ${cap}-repo cap — new repo not captured this cycle` });
          return;
        }
        admitted++;
      }
    }
    toCapture.push(rel);
  };

  for (const rel of keys) {
    const kind = kindByPath.get(rel);
    const baseSec = base[rel];
    const pend = pending[rel];
    let fastLookup: FingerprintHitProbeResult | undefined;

    // Pending unapplied remote [v5]: carry THE PENDING SECTION (the newest known truth),
    // capture suppressed. 422-while-pending [v6] → M5 drop; the pending entry stays for
    // the next pull to refresh (remote re-establishes it or absence-supersedes clears it).
    if (pend) {
      if (force.has(rel)) {
        deferred.push({ relPath: rel, reason: "pending remote section's blobs are missing server-side — dropped this commit; the next pull refreshes it" });
      } else {
        out[rel] = pend;
        carried.push(rel);
      }
      continue;
    }

    if (!kind) {
      if (!baseSec) continue; // never synced, nothing local → nothing to do
      const dirPresent = await fs
        .lstat(repoDirOf(root, rel))
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (!dirPresent) {
        // §9: repo dir GONE ENTIRELY → the pusher drops the section (receivers drop
        // their base entry but never touch local .git).
        removed.push(rel);
        delete needsRes[rel];
        continue;
      }
      const dotGit = await fs.lstat(path.join(repoDirOf(root, rel), ".git")).catch(() => undefined);
      if (dotGit && rel !== "." && (matcher.prunesForGitDiscovery?.(`${rel}/`) ?? false)) {
        out[rel] = baseSec;
        skipped.push({ relPath: rel, reason: "gitignored by discovery pruning — carrying base" });
        continue;
      }
      deferOne(rel, "no usable .git (deleted or unsupported shape) — carrying base");
      continue;
    }

    // §3.3 fast-path guards:
    // 1 !force.has(rel)
    // 2 no pending, needs-resolution, or removed-memory suppression
    // 3 repo was discovered this run
    // 4 base section exists
    // 5 trusted fingerprint hit with a probe
    // 6 probe is plannable-clean with a valid preflight kind
    // 7 design-43 §7 carry matrix reaches carry
    if (!force.has(rel) && !pend && needsRes[rel] === undefined && removedMem[rel] === undefined && kindByPath.has(rel) && baseSec) {
      fastLookup = await fingerprintHitProbe(fingerprintRun, root, rel, cache, kind);
      if (fastLookup.status === "untrusted") {
        stats.fpUntrusted++;
      } else if (fastLookup.status === "hit") {
        const probe = fastLookup.probe;
        const pfKind = probe.preflightKind;
        if (!probe.busy && probe.preflightOk && !probe.preflightStructural && isGitRepoKind(pfKind) && carryMatrixMatches(baseSec, pfKind, probe.identityKey)) {
          // A trusted summary can prove a verbatim carry. If publication is due,
          // fall through: the wire needs the canonical config, not merely its hash.
          if (!shouldPublishGitConfig(baseSec.config, fastLookup.cachedLocalCfg, state.repoRecords?.[rel]?.cfgSynced)) {
            out[rel] = baseSec;
            carried.push(rel);
            fastPathParentRel.set(rel, probe.parentRel);
            stats.fpHits++;
            continue;
          }
        }
        stats.fpMisses++;
      } else {
        stats.fpMisses++;
      }
    }

    // §3.8 post-gate extension: a baseless in-tree worktree pointer can only be
    // skipped after `sectioned` is known, but a trusted cached parentRel lets us
    // defer that decision without paying the identity/preflight spawn floor.
    if (!force.has(rel) && !pend && needsRes[rel] === undefined && removedMem[rel] === undefined && kind === "pointer" && !baseSec) {
      fastLookup = await fingerprintHitProbe(fingerprintRun, root, rel, cache, kind);
      if (fastLookup.status === "untrusted") {
        stats.fpUntrusted++;
      } else if (fastLookup.status === "hit") {
        const probe = fastLookup.probe;
        const pfKind = probe.preflightKind;
        if (!probe.busy && probe.preflightOk && !probe.preflightStructural && isGitRepoKind(pfKind) && probe.parentRel) {
          if (admitted < cap) {
            admitted++;
            pendingPointerPreSkips.push({ relPath: rel, parentRel: probe.parentRel, admissionAlreadyCounted: true });
            continue;
          }
          stats.fpMisses++;
        } else {
          stats.fpMisses++;
        }
      } else {
        stats.fpMisses++;
      }
    }

    await processRepoSlowPath(rel, kind, baseSec, fastLookup);
  }

  // Design 68 §3.3 — base-carry POLICY SKIP for in-tree linked-worktree pointers. A pointer
  // whose owning main clone is (a) an in-tree linked-worktree parent AND (b) itself authored
  // a section THIS cycle skips its own full-store capture: the shared history already rides
  // the main clone's `--single-worktree --all` bundle, so capturing the pointer would upload
  // the same object store again. Skip is BASE-CARRY, never a drop (codex M4): an existing
  // section is carried forward unchanged (the remote never observes an absence → no removal
  // memory is stamped, sync-git.ts:443/:231 untouched), and a repo with no base is simply
  // never authored. `sectioned` is snapshotted BEFORE mutating toCapture — parents are dir
  // repos, never pointers, so removing a pointer can't change any parent's membership.
  const sectioned = new Set([...Object.keys(out), ...toCapture]);
  const skippedRelPaths = new Set<string>();
  const skipLinkedWorktreePointer = (rel: string, parentRel: string) => {
    skippedRelPaths.add(rel);
    // Ownership is known only now. Undo any provisional slow-carry lane result:
    // linked pointers are non-owned and therefore carry their base verbatim.
    delete authoredCfgHashByRepo[rel];
    for (let i = deferred.length - 1; i >= 0; i--) {
      if (deferred[i]!.relPath === rel && configLaneDefers.has(deferred[i]!)) deferred.splice(i, 1);
    }
    const b = base[rel];
    if (b) out[rel] = b; // base-carry: never a remote absence, never a removal memory
    else delete out[rel]; // fresh pointer: never authored
    skipped.push({ relPath: rel, reason: `linked worktree of in-tree repo ${parentRel} — history travels with the main clone` });
  };
  for (const { relPath: rel, parentRel, admissionAlreadyCounted } of pendingPointerPreSkips) {
    if (sectioned.has(parentRel)) {
      skipLinkedWorktreePointer(rel, parentRel);
      stats.pointerPreSkips++;
    } else {
      stats.fpMisses++;
      await processRepoSlowPath(rel, kindByPath.get(rel), base[rel], undefined, { admissionAlreadyCounted });
    }
  }
  for (const rel of [...toCapture, ...carried]) {
    if (force.has(rel)) continue; // 422 recapture must capture, not base-carry via policy skip
    if (kindByPath.get(rel) !== "pointer" || pending[rel] || needsRes[rel] !== undefined) continue;
    let parentRel: string | undefined;
    if (fastPathParentRel.has(rel)) {
      parentRel = fastPathParentRel.get(rel);
      stats.parentRelCached++;
    } else {
      parentRel = await inTreeWorktreeParentRel(root, repoDirOf(root, rel));
    }
    if (!parentRel || !sectioned.has(parentRel)) continue; // out-of-tree/submodule/uncaptured parent → unchanged
    skipLinkedWorktreePointer(rel, parentRel);
  }
  if (skippedRelPaths.size > 0) {
    toCapture = toCapture.filter((rel) => !skippedRelPaths.has(rel));
    carried = carried.filter((rel) => !skippedRelPaths.has(rel));
  }

  // Changed repos: bounded-concurrency capture. Any per-repo failure defers THAT repo
  // (base carry) — the push itself always proceeds (PR #38 churn discipline). Progress
  // is a monotonic completed-count (captures run concurrently, so a settle counter is
  // the only truthful "done") with the just-settled repo's name as the display detail.
  const repoCount = toCapture.length;
  let captureDone = 0;
  let gitBytesDone = 0;
  const repoByteAbs = new Map<string, number>();
  const noteRepoBytes = (rel: string, abs: number) => {
    const prev = repoByteAbs.get(rel) ?? 0;
    if (abs < prev) {
      repoByteAbs.set(rel, abs);
      return;
    }
    gitBytesDone += abs - prev;
    repoByteAbs.set(rel, abs);
    onProgress?.(captureDone, repoCount, "gitcap", rel === "." ? path.basename(root) : path.basename(rel), { bytesDone: gitBytesDone });
  };
  const uploadsDir = path.join(root, ".rbox", "state", "uploads");
  await poolMap(toCapture, GIT_CAPTURE_CONCURRENCY, async (rel) => {
    try {
      const { section: sec, reason } = await capturePlannedGitSection(
        root, rel, cfg, base[rel], api, kek, uploadsDir, force.has(rel), backoff,
        (abs) => noteRepoBytes(rel, abs)
      );
      if (sec) {
        out[rel] = await captureWithConfig(rel, sec);
        captured.push(rel);
      } else {
        deferOne(rel, reason ?? "capture returned nothing (repo vanished mid-capture or failed self-validation)");
      }
    } catch (e) {
      deferOne(rel, e instanceof GitCaptureDeferredError ? errMsg(e) : `capture failed: ${errMsg(e)}`);
    } finally {
      // Root repo (rel ".") shows the workspace folder name rather than a bare ".".
      onProgress?.(
        ++captureDone,
        repoCount,
        "gitcap",
        rel === "." ? path.basename(root) : path.basename(rel),
        gitBytesDone > 0 ? { bytesDone: gitBytesDone } : undefined
      );
    }
  });

  const liveKeys = new Set(keys);
  for (const rel of [...cache.repos.keys()]) {
    if (!liveKeys.has(rel)) {
      cache.repos.delete(rel);
      cache.dirty = true;
    }
  }
  await saveGitDivergenceCache(root, cache).catch(() => {});

  return plan();
}

/** Format the §10 forensic push line:
 *  `git-sync: captured N (a, b) · carried N · skipped N (p: reason) · deferred N (p: reason) · removed N (x)`
 *  Skipped (design 68 §3.3 in-tree worktree pointers) is its own category — distinct from a
 *  failure defer — so the summary reads honestly instead of hiding N× redundant captures. */
export function formatGitPushLine(plan: GitPushPlan): string {
  const names = (xs: string[]) => (xs.length ? ` (${xs.join(", ")})` : "");
  const reasons = (xs: Array<{ relPath: string; reason: string }>) => (xs.length ? ` (${xs.map((d) => `${d.relPath}: ${d.reason}`).join("; ")})` : "");
  return (
    `git-sync: captured ${plan.captured.length}${names(plan.captured)} · carried ${plan.carried.length}` +
    ` · skipped ${plan.skipped.length}${reasons(plan.skipped)}` +
    ` · deferred ${plan.deferred.length}${reasons(plan.deferred)} · removed ${plan.removed.length}${names(plan.removed)}`
  );
}

export function formatGitPlanStats(stats: GitPlanStats): string {
  return `hit${stats.fpHits}m${stats.fpMisses}u${stats.fpUntrusted} pps${stats.pointerPreSkips} sp${stats.spawnedRepos} prc${stats.parentRelCached}`;
}

/** Per-repo base advance (design 43 §7 [v5]): a PENDING repo's committed section is the
 *  remote's own unapplied truth — the saved git BASE must keep the OLD entry (or none)
 *  so the next pull still sees remote != base and retries the apply. Advancing the base
 *  to the pending section would make that pull read "unchanged" and clear pending
 *  without ever applying — silently regressing the other machine's work. */
export function gitBaseAfterCommit(
  committedGit: Record<string, GitSection> | undefined,
  pending: Record<string, GitSection> | undefined,
  baseGit: Record<string, GitSection> | undefined
): Record<string, GitSection> | undefined {
  const stateGit = { ...(committedGit ?? {}) };
  for (const rel of Object.keys(pending ?? {})) {
    const old = baseGit?.[rel];
    if (old) stateGit[rel] = old;
    else delete stateGit[rel];
  }
  return emptyToUndef(stateGit);
}

/** The per-relPath 422 recapture set [v2, M5]: ONLY the repos whose sections reference a
 *  missing (unsatisfied) encSha are force-recaptured — a missing GIT artifact can't be
 *  satisfied by a file re-upload, and the identity-carry would re-reference the absent
 *  bundle (§28, codex M3). A naive "recapture everything" would drop exactly the repos the
 *  defer machinery is protecting. */
export function gitForceForMissingBlobs(committedGit: Record<string, GitSection> | undefined, missing: Set<string>): Set<string> {
  const gitForce = new Set<string>();
  for (const [rel, sec] of Object.entries(committedGit ?? {})) {
    if (gitSectionBlobRefs(sec).some((ref) => missing.has(ref.encSha))) gitForce.add(rel);
  }
  return gitForce;
}

const GIT_DIVERGENCE_CONCURRENCY = 8;
const GIT_DIVERGENCE_CACHE_REL = ".rbox/state/git-divergence.json";
// File-level bump: v3 entries have no config summary and must take one slow,
// bracketed pass before any fast carry can be trusted for design 93.
const GIT_DIVERGENCE_CACHE_VERSION = 4;
// Release-internal until design 83 ships; shape-only rewrites can stay on v4.
const GIT_FINGERPRINT_VERSION = 4;
const PACKED_REFS_HASH_MAX_BYTES = 1024 * 1024;
const LOOSE_REF_HASH_MAX_BYTES = 4096;
// Large indexes fall back to stat+ctime under the racy-clean margin. Real index
// rewrites change stat and content, so the bracket converges identically; hashing
// multi-MB indexes per tick bought nothing.
const INDEX_HASH_MAX_BYTES = 1024 * 1024;
// Mirrors git's racy-clean discipline: timestamps inside this granularity window
// are not trusted for publish-grade cache hits.
export const GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS = 2000;

interface CachedDivergenceProbe {
  busy: boolean;
  preflightOk: boolean;
  preflightStructural?: boolean;
  preflightKind?: GitRepoKind;
  identityKey: string;
  parentRel?: string;
}

interface GitDivergenceCacheEntry {
  fingerprint: string;
  writtenAtMs: number;
  identityKey: string;
  kind?: GitRepoKind;
  probe?: CachedDivergenceProbe;
  cachedLocalCfg?: CachedLocalCfg;
}

interface GitDivergenceCache {
  repos: Map<string, GitDivergenceCacheEntry>;
  dirty: boolean;
}

interface GitFingerprint {
  hash: string;
  maxTsMs: number;
  diskCtx?: RepoCtx;
}

type StatToken =
  | { exists: false }
  | { exists: true; type: "file" | "dir" | "symlink" | "other"; mtimeMs: number; ctimeMs: number; size: number; ino: number; target?: string; contentSha256?: string };
type DotGitToken =
  | { exists: false }
  | { exists: true; type: "dir" }
  | { exists: true; type: "file"; size: number; pointerTarget?: string; contentSha256?: string; mtimeMs?: number; ctimeMs?: number }
  | { exists: true; type: "symlink" | "other"; target?: string };
type TreeToken =
  | { exists: false }
  | { exists: true; type: "dir"; mtimeMs: number; ctimeMs: number; size: number }
  | { exists: true; type: "file"; size: number; mtimeMs: number; ctimeMs: number; contentSha256?: string }
  | { exists: true; type: "symlink" | "other"; size: number; mtimeMs: number; ctimeMs: number; target?: string };
type IndexToken =
  | { exists: false }
  | { exists: true; type: "dir" | "symlink" | "other"; mtimeMs: number; ctimeMs: number; size: number; target?: string }
  | { exists: true; type: "file"; size: number; contentSha256?: string; mtimeMs?: number; ctimeMs?: number };
type ExistenceToken = { exists: false } | { exists: true; type: "file" | "dir" | "symlink" | "other" };
type WorktreesToken =
  | { exists: false }
  | { exists: true; type: "file"; size: number; contentSha256?: string; mtimeMs?: number; ctimeMs?: number }
  | { exists: true; type: "symlink" | "other"; target?: string }
  | {
      exists: true;
      type: "dir";
      entries: Array<
        | { name: string; type: "dir" }
        | { name: string; type: "file"; size: number; contentSha256?: string; mtimeMs?: number; ctimeMs?: number }
        | { name: string; type: "symlink" | "other"; target?: string }
      >;
    };

interface GitFingerprintRun {
  commonDirFingerprints: Map<string, Promise<unknown>>;
  memoPolicy: "cross-repo" | "per-decision";
  decisionRel?: string;
}

export type GitDivergenceRepoHint = { relPath: string; kind?: GitRepoKind };
type GitDivergenceRepoSource = readonly GitDivergenceRepoHint[] | AsyncIterable<GitDivergenceRepoHint>;

const isGitRepoKind = (v: unknown): v is GitRepoKind => v === "dir" || v === "pointer";

function isCacheEntry(v: unknown): v is GitDivergenceCacheEntry {
  if (v === null || typeof v !== "object") return false;
  const e = v as GitDivergenceCacheEntry;
  if (typeof e.fingerprint !== "string" || typeof e.writtenAtMs !== "number" || typeof e.identityKey !== "string") return false;
  if (e.kind !== undefined && !isGitRepoKind(e.kind)) return false;
  if (
    e.cachedLocalCfg !== undefined &&
    (e.cachedLocalCfg === null ||
      typeof e.cachedLocalCfg !== "object" ||
      typeof e.cachedLocalCfg.hash !== "string" ||
      typeof e.cachedLocalCfg.nonEmpty !== "boolean")
  ) return false;
  if (e.probe !== undefined) {
    const p = e.probe as CachedDivergenceProbe;
    if (p === null || typeof p !== "object") return false;
    if (typeof p.busy !== "boolean" || typeof p.preflightOk !== "boolean" || typeof p.identityKey !== "string") return false;
  }
  return true;
}

export async function gitDivergenceFastRepoSource(
  root: string,
  baseGitRepos: Record<string, GitSection> | undefined,
  matcher: IgnoreMatcher
): Promise<GitDivergenceRepoHint[]> {
  const cache = await loadGitDivergenceCache(root);
  const byPath = new Map<string, GitDivergenceRepoHint>();
  for (const [rel, entry] of cache.repos) {
    if (entry.kind && (await fastRepoAdmitted(root, matcher, rel))) {
      byPath.set(rel, { relPath: rel, kind: entry.kind });
    }
  }
  for (const rel of Object.keys(baseGitRepos ?? {})) {
    if (!(await fastRepoAdmitted(root, matcher, rel))) continue;
    byPath.set(rel, byPath.get(rel) ?? { relPath: rel });
  }
  return [...byPath.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

async function fastRepoAdmitted(root: string, matcher: IgnoreMatcher, rel: string): Promise<boolean> {
  if (rel !== "." && (matcher.prunesForGitDiscovery?.(`${rel}/`) ?? matcher.ignores(`${rel}/`))) return false;
  return fs
    .lstat(repoDirOf(root, rel))
    .then((s) => s.isDirectory())
    .catch(() => false);
}

async function loadGitDivergenceCache(root: string): Promise<GitDivergenceCache> {
  try {
    const raw = await fs.readFile(path.join(root, GIT_DIVERGENCE_CACHE_REL), "utf8");
    const parsed = JSON.parse(raw) as { version?: number; repos?: Record<string, unknown> };
    if (parsed.version !== GIT_DIVERGENCE_CACHE_VERSION) return { repos: new Map(), dirty: true };
    const repos = new Map<string, GitDivergenceCacheEntry>();
    for (const [rel, entry] of Object.entries(parsed.repos ?? {})) {
      if (isCacheEntry(entry)) repos.set(rel, entry);
    }
    return { repos, dirty: false };
  } catch {
    return { repos: new Map(), dirty: true };
  }
}

async function saveGitDivergenceCache(root: string, cache: GitDivergenceCache): Promise<void> {
  if (!cache.dirty) return;
  const abs = path.join(root, GIT_DIVERGENCE_CACHE_REL);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const repos = Object.fromEntries([...cache.repos.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  await writeFileAtomic(abs, JSON.stringify({ version: GIT_DIVERGENCE_CACHE_VERSION, repos }));
  cache.dirty = false;
}

function statKind(st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): "file" | "dir" | "symlink" | "other" {
  return st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "other";
}

async function fileContentSha256(abs: string, size: number, maxBytes: number | undefined): Promise<string | undefined> {
  if (maxBytes === undefined || size >= maxBytes) return undefined;
  const bytes = await fs.readFile(abs).catch(() => undefined);
  return bytes ? hashBytes(bytes) : undefined;
}

async function contentOrStatFields(abs: string, size: number, maxBytes: number): Promise<{ contentSha256: string } | { mtimeMs: number; ctimeMs: number }> {
  const contentSha256 = await fileContentSha256(abs, size, maxBytes);
  if (contentSha256) return { contentSha256 };
  const st = await fs.lstat(abs).catch(() => undefined);
  return { mtimeMs: st?.mtimeMs ?? 0, ctimeMs: st?.ctimeMs ?? 0 };
}

async function statToken(abs: string, opts: { hashFileMaxBytes?: number } = {}): Promise<StatToken> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { exists: false };
  const type = statKind(st);
  const token: StatToken = { exists: true, type, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino };
  if (type === "symlink") token.target = await fs.readlink(abs).catch(() => "");
  if (type === "file") token.contentSha256 = await fileContentSha256(abs, st.size, opts.hashFileMaxBytes);
  return token;
}

async function existenceToken(abs: string): Promise<ExistenceToken> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { exists: false };
  return { exists: true, type: statKind(st) };
}

async function indexToken(abs: string): Promise<IndexToken> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { exists: false };
  const type = statKind(st);
  if (type === "file") {
    return { exists: true, type, size: st.size, ...(await contentOrStatFields(abs, st.size, INDEX_HASH_MAX_BYTES)) };
  }
  if (type === "symlink") return { exists: true, type, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, target: await fs.readlink(abs).catch(() => "") };
  return { exists: true, type, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size };
}

async function dotGitToken(abs: string, diskCtx: RepoCtx | undefined): Promise<DotGitToken> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { exists: false };
  if (st.isDirectory()) return { exists: true, type: "dir" };
  if (st.isFile()) {
    return {
      exists: true,
      type: "file",
      size: st.size,
      pointerTarget: diskCtx?.kind === "pointer" ? diskCtx.gitDir : undefined,
      ...(await contentOrStatFields(abs, st.size, LOOSE_REF_HASH_MAX_BYTES)),
    };
  }
  if (st.isSymbolicLink()) return { exists: true, type: "symlink", target: await fs.readlink(abs).catch(() => "") };
  return { exists: true, type: "other" };
}

async function treeToken(abs: string, opts: { hashFileMaxBytes?: number } = {}): Promise<TreeToken> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { exists: false };
  if (st.isDirectory()) return { exists: true, type: "dir", size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
  if (st.isFile()) return { exists: true, type: "file", size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, contentSha256: await fileContentSha256(abs, st.size, opts.hashFileMaxBytes) };
  if (st.isSymbolicLink()) return { exists: true, type: "symlink", size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, target: await fs.readlink(abs).catch(() => "") };
  return { exists: true, type: "other", size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
}

async function statTree(abs: string, base = "", opts: { hashFileMaxBytes?: number } = {}): Promise<Array<{ rel: string; stat: TreeToken }>> {
  const rootStat = await treeToken(path.join(abs, base), opts);
  const out: Array<{ rel: string; stat: TreeToken }> = [{ rel: base || ".", stat: rootStat }];
  if (!rootStat.exists || rootStat.type !== "dir") return out;
  const entries = await fs.readdir(path.join(abs, base), { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await statTree(abs, rel, opts)));
    else out.push({ rel, stat: await treeToken(path.join(abs, rel), opts) });
  }
  return out;
}

async function worktreesToken(abs: string): Promise<WorktreesToken> {
  const root = await statToken(abs);
  if (!root.exists) return { exists: false };
  if (root.type === "file") {
    return { exists: true, type: "file", size: root.size, ...(await contentOrStatFields(abs, root.size, LOOSE_REF_HASH_MAX_BYTES)) };
  }
  if (root.type === "symlink" || root.type === "other") {
    return root.type === "symlink" ? { exists: true, type: "symlink", target: root.target } : { exists: true, type: "other" };
  }
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shallow = await Promise.all(
    entries.map(async (entry) => {
      const st = await fs.lstat(path.join(abs, entry.name)).catch(() => undefined);
      const type = st ? statKind(st) : statKind(entry);
      if (type === "dir") return { name: entry.name, type: "dir" as const };
      if (type === "file" && st) {
        return { name: entry.name, type: "file" as const, size: st.size, ...(await contentOrStatFields(path.join(abs, entry.name), st.size, LOOSE_REF_HASH_MAX_BYTES)) };
      }
      return type === "symlink"
        ? { name: entry.name, type: "symlink" as const, target: await fs.readlink(path.join(abs, entry.name)).catch(() => "") }
        : { name: entry.name, type: "other" as const };
    })
  );
  return { exists: true, type: "dir", entries: shallow };
}

async function opStateFingerprint(gitDir: string): Promise<unknown> {
  const files = await Promise.all(OP_STATE_FILES.map(async (rel) => [rel, await statToken(path.join(gitDir, rel))] as const));
  const dirs = await Promise.all(OP_STATE_DIRS.map(async (rel) => [rel, await statTree(path.join(gitDir, rel))] as const));
  return { files, dirs };
}

async function commonDirFingerprint(ctx: RepoCtx): Promise<unknown> {
  const [shallow, alternates, config, modules, worktrees, gcPid, packedRefs, refs] = await Promise.all([
    statToken(path.join(ctx.commonDir, "shallow")),
    statToken(path.join(ctx.commonDir, "objects", "info", "alternates")),
    statToken(path.join(ctx.commonDir, "config")),
    existenceToken(path.join(ctx.commonDir, "modules")),
    worktreesToken(path.join(ctx.commonDir, "worktrees")),
    statToken(path.join(ctx.commonDir, "gc.pid")),
    statToken(path.join(ctx.commonDir, "packed-refs"), { hashFileMaxBytes: PACKED_REFS_HASH_MAX_BYTES }),
    statTree(path.join(ctx.commonDir, "refs"), "", { hashFileMaxBytes: LOOSE_REF_HASH_MAX_BYTES }),
  ]);
  return {
    shallow,
    alternates,
    config,
    modules,
    worktrees,
    gcPid,
    packedRefs,
    refs,
  };
}

function memoizedCommonDirFingerprint(run: GitFingerprintRun, ctx: RepoCtx): Promise<unknown> {
  const key = path.resolve(ctx.commonDir);
  let p = run.commonDirFingerprints.get(key);
  if (!p) {
    p = commonDirFingerprint(ctx);
    run.commonDirFingerprints.set(key, p);
  }
  return p;
}

function gitFingerprintRun(memoPolicy: GitFingerprintRun["memoPolicy"]): GitFingerprintRun {
  return { commonDirFingerprints: new Map(), memoPolicy };
}

function beginFingerprintDecision(run: GitFingerprintRun, rel: string): void {
  if (run.memoPolicy !== "per-decision" || run.decisionRel === rel) return;
  run.commonDirFingerprints.clear();
  run.decisionRel = rel;
}

function maxFingerprintTimestampMs(v: unknown): number {
  let max = 0;
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const item of x) visit(item);
      return;
    }
    if (x === null || typeof x !== "object") return;
    for (const [key, value] of Object.entries(x)) {
      if ((key === "mtimeMs" || key === "ctimeMs" || key === "maxMtimeMs" || key === "maxCtimeMs") && typeof value === "number") {
        max = Math.max(max, value);
      } else {
        visit(value);
      }
    }
  };
  visit(v);
  return max;
}

function trustedGitFingerprintHit(fresh: GitFingerprint, entry: GitDivergenceCacheEntry): boolean {
  return entry.fingerprint === fresh.hash && fresh.maxTsMs < entry.writtenAtMs - GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS;
}

async function gitDirFingerprint(gitDir: string): Promise<unknown> {
  const [head, index, indexLock, headLock, configWorktree, opState] = await Promise.all([
    statToken(path.join(gitDir, "HEAD"), { hashFileMaxBytes: LOOSE_REF_HASH_MAX_BYTES }),
    indexToken(path.join(gitDir, "index")),
    statToken(path.join(gitDir, "index.lock")),
    statToken(path.join(gitDir, "HEAD.lock")),
    statToken(path.join(gitDir, "config.worktree")),
    opStateFingerprint(gitDir),
  ]);
  return { head, index, indexLock, headLock, configWorktree, opState };
}

async function gitFingerprint(run: GitFingerprintRun, root: string, rel: string): Promise<GitFingerprint> {
  beginFingerprintDecision(run, rel);
  const repoDir = repoDirOf(root, rel);
  const dotGit = path.join(repoDir, ".git");
  const diskCtx = await repoCtxFromDisk(repoDir).catch(() => undefined);
  const [dotGitPart, gitDirPart, commonDirPart] = await Promise.all([
    dotGitToken(dotGit, diskCtx),
    diskCtx ? gitDirFingerprint(diskCtx.gitDir) : Promise.resolve(null),
    diskCtx ? memoizedCommonDirFingerprint(run, diskCtx) : Promise.resolve(null),
  ]);
  const parts = {
    version: GIT_FINGERPRINT_VERSION,
    dotGit: dotGitPart,
    ctx: diskCtx ? { kind: diskCtx.kind, gitDir: diskCtx.gitDir, commonDir: diskCtx.commonDir } : null,
    gitDir: gitDirPart,
    commonDir: commonDirPart,
  };
  return { hash: hashBytes(Buffer.from(JSON.stringify(parts))), maxTsMs: maxFingerprintTimestampMs(parts), diskCtx };
}

type PlanProbeBuild = {
  probe: CachedDivergenceProbe;
  identity?: GitIdentity;
  diskCtx?: RepoCtx;
  parentRel?: string;
};

async function buildPlanProbe(root: string, rel: string, diskCtx: RepoCtx | undefined, pf?: GitPreflightResult): Promise<PlanProbeBuild> {
  if (!pf) {
    return { probe: { busy: true, preflightOk: false, identityKey: "none" } };
  }
  const repoDir = repoDirOf(root, rel);
  const resolvedDiskCtx = diskCtx ?? (await repoCtxFromDisk(repoDir).catch(() => undefined));
  const identity = pf.ok
    ? await gitIdentity(repoDir, resolvedDiskCtx).catch(() => undefined)
    : resolvedDiskCtx
      ? await gitIdentity(repoDir, resolvedDiskCtx).catch(() => undefined)
      : undefined;
  const parentRel = resolvedDiskCtx?.kind === "pointer" ? await inTreeWorktreeParentRelFromCtx(root, resolvedDiskCtx).catch(() => undefined) : undefined;
  return {
    probe: {
      busy: false,
      preflightOk: pf.ok,
      preflightStructural: pf.structural === true,
      preflightKind: pf.kind,
      identityKey: gitIdentityKey(identity),
      parentRel,
    },
    identity,
    diskCtx: resolvedDiskCtx,
    parentRel,
  };
}

async function probeDivergenceRepo(root: string, rel: string, ctx: RepoCtx | null): Promise<CachedDivergenceProbe> {
  const repoDir = repoDirOf(root, rel);
  const busy = await isGitBusy(repoDir, ctx).catch(() => false);
  if (busy) return { busy: true, preflightOk: false, identityKey: "none" };
  const pf = (await gitPreflight(repoDir, ctx).catch(
    (e): GitPreflightResult => ({ ok: false, reason: errMsg(e) })
  )) as GitPreflightResult;
  const id = ctx ? await gitIdentity(repoDir, ctx).catch(() => undefined) : undefined;
  const parentRel = ctx?.kind === "pointer" ? await inTreeWorktreeParentRelFromCtx(root, ctx).catch(() => undefined) : undefined;
  return {
    busy: false,
    preflightOk: pf.ok,
    preflightStructural: pf.structural === true,
    preflightKind: pf.kind,
    identityKey: gitIdentityKey(id),
    parentRel,
  };
}

async function freshDivergenceProbeForTooling(root: string, rel: string): Promise<CachedDivergenceProbe> {
  const realCtx = (await repoCtx(repoDirOf(root, rel)).catch(() => undefined)) ?? null;
  return probeDivergenceRepo(root, rel, realCtx);
}

export async function classifyDivergenceCacheEntry(root: string, rel: string, entry: unknown): Promise<
  | { verdict: "hit-ok"; cachedIdentityKey: string; freshIdentityKey: string; cachedParentRel?: string; freshParentRel?: string }
  | {
      verdict: "hit-mismatch";
      identityMatches: boolean;
      parentRelMatches: boolean;
      cachedIdentityKey: string;
      freshIdentityKey: string;
      cachedParentRel?: string;
      freshParentRel?: string;
    }
  | { verdict: "stale"; cachedHash: string; freshHash: string }
  | { verdict: "untrusted"; maxTsMs: number; writtenAtMs: number }
  | { verdict: "skipped"; reason: string }
> {
  if (!isCacheEntry(entry)) return { verdict: "skipped", reason: "invalid-cache-entry" };
  const run = gitFingerprintRun("per-decision");
  let freshFingerprint: GitFingerprint;
  try {
    freshFingerprint = await gitFingerprint(run, root, rel);
  } catch (e) {
    return { verdict: "skipped", reason: `fingerprint-error=${JSON.stringify(errMsg(e))}` };
  }

  if (entry.fingerprint !== freshFingerprint.hash) {
    return { verdict: "stale", cachedHash: entry.fingerprint, freshHash: freshFingerprint.hash };
  }
  if (!entry.probe) return { verdict: "skipped", reason: "no-probe" };
  if (!trustedGitFingerprintHit(freshFingerprint, entry)) {
    return { verdict: "untrusted", maxTsMs: freshFingerprint.maxTsMs, writtenAtMs: entry.writtenAtMs };
  }

  let freshProbe: CachedDivergenceProbe;
  try {
    freshProbe = await freshDivergenceProbeForTooling(root, rel);
  } catch (e) {
    return { verdict: "skipped", reason: `fresh-probe-error=${JSON.stringify(errMsg(e))}` };
  }

  const cachedIdentityKey = entry.probe.identityKey;
  const freshIdentityKey = freshProbe.identityKey;
  const cachedParentRel = entry.probe.parentRel;
  const freshParentRel = freshProbe.parentRel;
  const identityMatches = cachedIdentityKey === freshIdentityKey;
  const parentRelMatches = cachedParentRel === freshParentRel;
  if (identityMatches && parentRelMatches) {
    return { verdict: "hit-ok", cachedIdentityKey, freshIdentityKey, cachedParentRel, freshParentRel };
  }
  return {
    verdict: "hit-mismatch",
    identityMatches,
    parentRelMatches,
    cachedIdentityKey,
    freshIdentityKey,
    cachedParentRel,
    freshParentRel,
  };
}

function sameDivergenceProbe(a: CachedDivergenceProbe | undefined, b: CachedDivergenceProbe): boolean {
  return (
    a !== undefined &&
    a.busy === b.busy &&
    a.preflightOk === b.preflightOk &&
    a.preflightStructural === b.preflightStructural &&
    a.preflightKind === b.preflightKind &&
    a.identityKey === b.identityKey &&
    a.parentRel === b.parentRel
  );
}

type FingerprintHitProbeResult =
  | { status: "hit"; fingerprint: GitFingerprint; probe: CachedDivergenceProbe; cachedLocalCfg: CachedLocalCfg; kind?: GitRepoKind }
  | { status: "miss"; fingerprint: GitFingerprint; kind?: GitRepoKind }
  | { status: "untrusted"; fingerprint: GitFingerprint; kind?: GitRepoKind };

type DivergenceCacheProbeSnapshot = {
  beforeFingerprint: GitFingerprint;
  probe: CachedDivergenceProbe;
  kind?: GitRepoKind;
};

async function fingerprintHitProbe(
  run: GitFingerprintRun,
  root: string,
  rel: string,
  cache: GitDivergenceCache,
  hintKind?: GitRepoKind
): Promise<FingerprintHitProbeResult> {
  const fresh = await gitFingerprint(run, root, rel);
  const cached = cache.repos.get(rel);
  const kind = cached?.kind ?? fresh.diskCtx?.kind ?? hintKind;
  // Missing cachedLocalCfg is a legacy/incomplete entry: force exactly one slow
  // bracketed pass so config presence can never disappear behind a git fast hit.
  if (cached?.fingerprint !== fresh.hash || !cached.probe || !cached.cachedLocalCfg) {
    return { status: "miss", fingerprint: fresh, kind };
  }
  if (!trustedGitFingerprintHit(fresh, cached)) {
    return { status: "untrusted", fingerprint: fresh, kind };
  }
  return { status: "hit", fingerprint: fresh, probe: cached.probe, cachedLocalCfg: cached.cachedLocalCfg, kind };
}

type DivergenceCacheWriteResult = { kind?: GitRepoKind; localCfg?: LocalCfgRead };

async function writeDivergenceCacheEntry(
  run: GitFingerprintRun,
  root: string,
  rel: string,
  cache: GitDivergenceCache,
  probe: CachedDivergenceProbe,
  hintKind: GitRepoKind | undefined,
  beforeFingerprint: GitFingerprint,
  recompute?: () => Promise<DivergenceCacheProbeSnapshot>,
  onCredentialSkip?: () => void
): Promise<DivergenceCacheWriteResult> {
  let before = beforeFingerprint;
  let currentProbe = probe;
  let currentKind = hintKind;
  for (let attempt = 0; attempt < 2; attempt++) {
    const localCfg = !currentProbe.busy && currentProbe.preflightOk
      ? await readLocalGitConfig(root, rel, before.diskCtx, undefined, onCredentialSkip)
      : undefined;
    if (before.diskCtx) run.commonDirFingerprints.delete(path.resolve(before.diskCtx.commonDir));
    const after = await gitFingerprint(run, root, rel);
    const afterKind = after.diskCtx?.kind ?? currentKind;
    if (after.hash === before.hash) {
      cache.repos.set(rel, {
        fingerprint: after.hash,
        writtenAtMs: Date.now(),
        identityKey: currentProbe.identityKey,
        ...(afterKind ? { kind: afterKind } : {}),
        probe: currentProbe,
        ...(localCfg?.status === "ok" ? { cachedLocalCfg: localCfg.cached } : {}),
      });
      cache.dirty = true;
      return { kind: afterKind, localCfg };
    }
    if (!recompute || attempt === 1) return { kind: afterKind };
    const next = await recompute();
    before = next.beforeFingerprint;
    currentProbe = next.probe;
    currentKind = next.kind;
  }
  return { kind: currentKind };
}

async function probeAndCacheDivergenceRepo(
  run: GitFingerprintRun,
  root: string,
  rel: string,
  cache: GitDivergenceCache,
  before: GitFingerprint,
  hintKind?: GitRepoKind
): Promise<{ kind?: GitRepoKind; probe?: CachedDivergenceProbe }> {
  const realCtx = (await repoCtx(repoDirOf(root, rel)).catch(() => undefined)) ?? null;
  const repoKind = before.diskCtx?.kind ?? realCtx?.kind ?? hintKind;
  let last: CachedDivergenceProbe | undefined;
  let previous: CachedDivergenceProbe | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await probeDivergenceRepo(root, rel, realCtx);
    const localCfg = !last.busy && last.preflightOk
      ? await readLocalGitConfig(root, rel, before.diskCtx ?? realCtx ?? undefined)
      : undefined;
    if (before.diskCtx) run.commonDirFingerprints.delete(path.resolve(before.diskCtx.commonDir));
    const after = await gitFingerprint(run, root, rel);
    const exactFingerprint = after.hash === before.hash;
    if (exactFingerprint || sameDivergenceProbe(previous, last)) {
      const afterKind = after.diskCtx?.kind ?? repoKind;
      cache.repos.set(rel, {
        fingerprint: after.hash,
        writtenAtMs: Date.now(),
        identityKey: last.identityKey,
        ...(afterKind ? { kind: afterKind } : {}),
        probe: last,
        ...(exactFingerprint && localCfg?.status === "ok" ? { cachedLocalCfg: localCfg.cached } : {}),
      });
      cache.dirty = true;
      return { kind: afterKind, probe: last };
    }
    previous = last;
    before = after;
  }
  return { kind: repoKind, probe: last };
}

async function cachedDivergenceProbe(
  run: GitFingerprintRun,
  root: string,
  rel: string,
  cache: GitDivergenceCache,
  out: Map<string, CachedDivergenceProbe>,
  hintKind?: GitRepoKind
): Promise<GitRepoKind | undefined> {
  const hit = await fingerprintHitProbe(run, root, rel, cache, hintKind);
  if (hit.status === "hit") {
    out.set(rel, hit.probe);
    return hit.kind;
  }
  const refreshed = await probeAndCacheDivergenceRepo(run, root, rel, cache, hit.fingerprint, hit.kind);
  if (refreshed.probe) out.set(rel, refreshed.probe);
  return refreshed.kind;
}

/** The pull-side git outcome: the per-repo base to persist plus the updated local-only maps. */
export interface GitPullOutcome {
  gitRepos?: Record<string, GitSection>;
  gitReposRemoved?: Record<string, string>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
  /** Completed/invalidation config-lane updates, saved atomically with this
   * pull's base and pending transitions by the step-4 packet composer. */
  configLane?: Record<string, ConfigLaneState>;
  gitApplyMetrics?: GitApplyMetrics;
}

export type GitApplyRunKind = "fresh" | "steady";
export type GitApplyRepoResult =
  | "unchanged"
  | "applied"
  | "deferred"
  | "conflict"
  | "removed"
  | "skipped";

export interface GitApplyRepoTiming {
  index: number;
  queueMs: number;
  wallMs: number;
  result: GitApplyRepoResult;
  commonDirGroup?: number;
}

export interface GitApplyMetrics {
  runKind: GitApplyRunKind;
  repos: number;
  commonDirGroups: number;
  results: Record<GitApplyRepoResult, number>;
  repoTimings: GitApplyRepoTiming[];
}

const emptyGitApplyResults = (): Record<GitApplyRepoResult, number> => ({
  unchanged: 0,
  applied: 0,
  deferred: 0,
  conflict: 0,
  removed: 0,
  skipped: 0,
});

const GIT_APPLY_RESULT_ABBR: Record<GitApplyRepoResult, string> = {
  unchanged: "u",
  applied: "a",
  deferred: "d",
  conflict: "c",
  removed: "rm",
  skipped: "s",
};

function finishGitApplyMetrics(
  metrics: GitApplyMetrics | undefined,
  commonDirGroups: Map<string, number> | undefined
): GitApplyMetrics | undefined {
  if (!metrics) return undefined;
  return {
    ...metrics,
    commonDirGroups: commonDirGroups?.size ?? 0,
    results: { ...metrics.results },
    repoTimings: metrics.repoTimings.map((timing) => ({ ...timing })),
  };
}

export function formatGitApplyMetrics(metrics: GitApplyMetrics): string {
  const resultBits = (Object.entries(metrics.results) as Array<[GitApplyRepoResult, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(",");
  const repoBits = metrics.repoTimings
    .map((t) => {
      const group = t.commonDirGroup === undefined ? "" : `g${t.commonDirGroup}`;
      return `i${t.index}q${t.queueMs}w${t.wallMs}${GIT_APPLY_RESULT_ABBR[t.result]}${group}`;
    })
    .join(",");
  return `mode=${metrics.runKind} repos=${metrics.repos} commonDirs=${metrics.commonDirGroups} results=${resultBits || "none"} repoMs=${repoBits || "none"}`;
}

/**
 * Pull-side git orchestration (design 43 §7, §9, §13.5): iterate
 * `remote.gitRepos ∪ base.gitRepos ∪ gitPendingRemote` per key. Per repo:
 *  - remote ABSENT → conflict-precedence first if a pending repo's local diverged
 *    (§13.5), then clear pending ([v6] absence supersedes pending), record a removal
 *    memory when the local `.git` survives, drop the base entry — NEVER touch local .git.
 *  - unchanged (projected onto the narrower scope) → base advances, no apply.
 *  - local diverged from base → per-repo CONFLICT: preserve remote, checkpoint base to
 *    remote, record `needsResolution` with the conflict-time local identity [v2, M2].
 *  - clean → applyGitState (containment + ignored-subtree refusal BEFORE any mutation);
 *    a removal-memory-matching leftover is treated as ABSENT → clean materialization
 *    (dir: quarantine + ref-wipe first; pointer: NEVER ref-wipe — guarded update-only).
 *  - deferred apply → record `gitPendingRemote`; that repo's base does not advance;
 *    every other repo advances independently.
 */
export async function applyGitSections(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  remote: Manifest,
  store: BlobStore,
  matcher: IgnoreMatcher,
  glog: (line: string) => void,
opts: {
    collectMetrics?: boolean;
    onProgress?: (done: number, total: number) => void;
    /** Deterministic fault injection for §11 pull-lane tests. */
    applyConfig?: typeof applyConfigTransaction;
    materializeFreshConfig?: typeof materializeFreshGitConfig;
  } = {}
): Promise<GitPullOutcome> {
  const baseRepos = state.lastSyncedManifest.gitRepos ?? {};
  const applied: Record<string, GitSection> = { ...baseRepos };
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  const pending = { ...(state.gitPendingRemote ?? {}) };
  const records = repoRecordsForState(state);
  const configLane: Record<string, ConfigLaneState> = {};
  let commonDirGroups: Map<string, number> | undefined;
  let metrics: GitApplyMetrics | undefined;
  const pack = (): GitPullOutcome => ({
    gitRepos: emptyToUndef(applied),
    gitReposRemoved: emptyToUndef(removedMem),
    gitNeedsResolution: emptyToUndef(needsRes),
    gitPendingRemote: emptyToUndef(pending),
    configLane: emptyToUndef(configLane),
    gitApplyMetrics: finishGitApplyMetrics(metrics, commonDirGroups),
  });
  if (!cfg.syncGit) return pack();
  const keys = [...new Set([...Object.keys(remote.gitRepos ?? {}), ...Object.keys(baseRepos), ...Object.keys(pending)])].sort();
  if (opts.collectMetrics) {
    commonDirGroups = new Map();
    metrics = {
      // "fresh" = no useful local/base git state (design 74 §3) — NOT sequence 0:
      // a file-synced workspace receiving its first remote.gitRepos is fresh for
      // git purposes even at a nonzero baseline (review finding: sequence-keyed
      // classification would poison the Phase-1 gate data).
      runKind: Object.keys(baseRepos).length === 0 && Object.keys(pending).length === 0 ? "fresh" : "steady",
      repos: keys.length,
      commonDirGroups: 0,
      results: emptyGitApplyResults(),
      repoTimings: [],
    };
  }
  if (keys.length === 0) return pack();
  // Fail closed ONCE, before any per-repo work: git sections (incl. pending ones) are
  // E2EE artifacts — without the key nothing below can decrypt-verify.
  if (!cfg.kek && keys.some((k) => remote.gitRepos?.[k] !== undefined || pending[k] !== undefined)) {
    throw new Error("E2EE required: remote has git state but no key on this device — run `rbox pair`/`rbox key recover`.");
  }

  const commonDirGroupFor = async (repoDir: string, hasDotGit: boolean): Promise<number | undefined> => {
    if (!commonDirGroups || !hasDotGit) return undefined;
    const ctx = await repoCtxFromDisk(repoDir).catch(() => undefined);
    if (!ctx) return undefined;
    const key = path.resolve(ctx.commonDir);
    let group = commonDirGroups.get(key);
    if (group === undefined) {
      group = commonDirGroups.size + 1;
      commonDirGroups.set(key, group);
    }
    return group;
  };

  const laneRecord = (rel: string): RepoRecordInput => ({
    sourceSeq: records[rel]?.sourceSeq ?? state.lastSyncedSequence,
    ...(configLane[rel] ?? configLaneOnly(records[rel] ?? { repoGen: 0, sourceSeq: state.lastSyncedSequence })),
  });
  const replaceLane = (rel: string, record: RepoRecordInput): void => {
    configLane[rel] = configLaneOnly(record);
  };
  const invalidateLaneShape = (rel: string, shape: ConfigShapeIdentity | undefined): RepoRecordInput => {
    const current = laneRecord(rel);
    if (sameConfigShape(current.cfgShape, shape)) return current;
    const reset: RepoRecordInput = { sourceSeq: current.sourceSeq, ...(shape === undefined ? {} : { cfgShape: shape }) };
    replaceLane(rel, reset);
    return reset;
  };
  const completeLane = (
    rel: string,
    shape: ConfigShapeIdentity,
    hashes: { pre: string; post: string; incoming: string; basePre?: string; postToken: ConfigStatToken }
  ): void => {
    replaceLane(rel, {
      ...completeConfigApply(laneRecord(rel), {
        pre: hashes.pre,
        post: hashes.post,
        incoming: hashes.incoming,
        ...(hashes.basePre === undefined ? {} : { basePre: hashes.basePre }),
        postToken: hashes.postToken,
      }),
      cfgShape: shape,
    });
  };
  const configFailure = (result: Exclude<ConfigTransactionResult, { status: "completed" }>): Error =>
    new Error(`config ${result.status}: ${result.fault.reason}`);

  /** Run the config mutation only after the caller has selected the correct Git
   * disposition. Existing repos use the optimistic locked transaction; a truly
   * fresh repo uses the step-3 private-target helper. */
  const runConfigApply = async (
    rel: string,
    repoDir: string,
    incoming: GitConfig,
    baseConfig: GitConfig | undefined,
    receiver: { fresh: true } | { fresh: false; shape: ConfigShapeIdentity; configPath: string }
  ): Promise<void> => {
    if (receiver.fresh) {
      await (opts.materializeFreshConfig ?? materializeFreshGitConfig)(repoDir, incoming, path.join(repoDir, ".git"));
      const ctx = await repoCtxFromDisk(repoDir);
      if (!ctx) throw new Error("fresh config apply lost repository context");
      const owned = await configReceiver(root, ctx);
      if (!owned.owned) throw new Error("fresh config target is not receiver-owned");
      const installed = await readParsedConfigSnapshot(repoDir, owned.configPath, "locked");
      if (!installed.ok) throw new Error(`fresh config post-read: ${installed.fault.reason}`);
      const post = canonicalizeGitConfig(installed.snapshot.entries);
      if (!post.ok) throw new Error(`fresh config post-parse: ${post.reason}`);
      completeLane(rel, owned.shape, {
        pre: gitConfigHash({}),
        post: gitConfigHash(post.config),
        incoming: gitConfigHash(incoming),
        ...(baseConfig === undefined ? {} : { basePre: gitConfigHash(baseConfig) }),
        postToken: installed.snapshot.token,
      });
      return;
    }

    const result = await (opts.applyConfig ?? applyConfigTransaction)(repoDir, receiver.configPath, incoming, { baseConfig });
    if (result.status !== "completed") throw configFailure(result);
    for (const warning of result.warnings) {
      try {
        glog(`git-sync WARNING ${rel}: config ${warning}`);
      } catch {
        // Observability after the rename commit point is strictly non-fatal.
      }
    }
    completeLane(rel, receiver.shape, {
      pre: result.preHash,
      post: result.postHash,
      incoming: result.incomingHash,
      ...(result.baseHash === undefined ? {} : { basePre: result.baseHash }),
      postToken: result.postToken,
    });
  };

  const processRepo = async (rel: string): Promise<{ result: GitApplyRepoResult; commonDirGroup?: number }> => {
    const remoteSec = remote.gitRepos?.[rel];
    const baseSec = baseRepos[rel];
    const pend = pending[rel];
    const repoDir = repoDirOf(root, rel);
    const dotGit = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
    const commonDirGroup = await commonDirGroupFor(repoDir, dotGit !== undefined);

    // Receiver quiescence (design 43 §7): a busy repo defers only itself, and the busy
    // check must run BEFORE any identity comparison — a lock makes write-tree fail,
    // flipping gitIdentity onto the raw-index fallback, which would read as FALSE
    // divergence (spurious conflict) or poison a removal memory with a transient key.
    const busy = dotGit !== undefined && (await isGitBusy(repoDir));
    if (busy && remoteSec) {
      pending[rel] = remoteSec; // apply needs quiescence — retry next pull; outbound carries newest truth
      glog(`git-sync deferred ${rel}: receiver git busy`);
      return { result: "deferred", commonDirGroup };
    }
    // NOTE: remote ABSENCE is processed even when busy — it never mutates local .git,
    // and skipping it would leave gitPendingRemote/base carrying a section the remote
    // deleted, which the next file-only push would resurrect (codex step-3 BLOCKER).
    const localId = dotGit ? await gitIdentity(repoDir) : undefined;

    if (!remoteSec) {
      // §9 removal + [v6] absence-supersedes-pending. The DIVERGENCE EXAMINATION runs
      // first (§13.5: never stamp a removal memory over unexamined local divergence),
      // then the pure state transitions apply UNCONDITIONALLY — absence is the newer
      // truth no matter what else succeeds — and only then the best-effort recovery
      // preserve. Ordering is crash-safety (codex step-3 round-3 MAJOR): if the
      // preserve throws (blob/fs failure), the per-repo catch must not leave a stale
      // pending/base entry for the next push to resurrect.
      const diverged = pend !== undefined && localDivergedFromBase(localId, baseSec);
      delete pending[rel];
      delete needsRes[rel];
      if (rel in applied) {
        delete applied[rel];
        glog(`git-sync removed ${rel} (remote deleted; local .git untouched)`);
      }
      if (dotGit) {
        // Resurrection guard [v2, B4]: the leftover's identity at removal. On a BUSY
        // repo the live identity is the volatile raw-index fallback — record the base
        // section's identity instead (projected onto the leftover's shape), which is
        // lock-immune and equals the live identity whenever the leftover is untouched.
        removedMem[rel] =
          busy && baseSec ? projectedKey(baseSec, dotGit.isFile() ? "scoped" : "all") : gitIdentityKey(localId);
      }
      // §13.5 conflict precedence: the pending remote section is preserved for manual
      // recovery. Best-effort — preserve never mutates local branches/index/identity,
      // so a failure loses only the convenience recovery bundle (logged loudly); the
      // user's diverged local work is untouched either way. (On a busy repo the
      // raw-index fallback can only over-trigger this — a safe, logged no-clobber.)
      if (diverged && pend) {
        try {
          const { recoveryBundle } = await preserveGitConflict(repoDir, pend, store, cfg.kek!);
          glog(
            `git-sync CONFLICT ${rel} — remote deleted the repo while an apply was pending and local diverged; local kept, pending remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}`
          );
        } catch (e) {
          glog(`git-sync WARNING ${rel}: could not preserve the pending remote section after the remote deletion (local work untouched): ${errMsg(e)}`);
        }
      }
      return { result: "removed", commonDirGroup };
    }

    // Removal memory: a leftover whose identity still EQUALS the memory is treated as
    // ABSENT (clean materialization target [v3/v4]); a leftover that CHANGED re-enters
    // the normal rules (conflict path) with the memory cleared. An UNREADABLE pointer
    // leftover (dangling gitfile — identity unknowable) defers instead: guessing would
    // either wipe the guard or mis-run the conflict path.
    let cleanMaterialize = false;
    if (removedMem[rel] !== undefined) {
      if (!dotGit) {
        delete removedMem[rel]; // leftover gone → memory pruned; plain fresh target
      } else if (gitIdentityKey(localId) === removedMem[rel]) {
        cleanMaterialize = true;
      } else if (!localId && dotGit.isFile()) {
        pending[rel] = remoteSec;
        glog(`git-sync deferred ${rel}: leftover pointer repo unreadable — keeping removal memory`);
        return { result: "deferred", commonDirGroup };
      } else {
        delete removedMem[rel]; // identity genuinely changed (incl. a re-init'd empty dir repo)
      }
    }

    const defer = (reason: string) => {
      pending[rel] = remoteSec; // [v5]: outbound pushes carry newest unapplied truth
      glog(`git-sync deferred ${rel}: ${reason}`);
    };

    // Design 93 §6/§9. The config predicate is deliberately decided before
    // EITHER unchanged shortcut. Receiver ownership is local shape, not sender
    // shape; cross-shape rows skip config loudly once while Git keeps its existing
    // disposition. A shape mismatch first clears the old lane markers and records
    // the new identity in this pull's atomic repo transition.
    let configDue = false;
    let configTarget: { fresh: true } | { fresh: false; shape: ConfigShapeIdentity; configPath: string } | undefined;
    if (remoteSec.config !== undefined) {
      if (!dotGit) {
        invalidateLaneShape(rel, undefined);
        configDue = true;
        configTarget = { fresh: true };
      } else {
        const diskCtx = await repoCtxFromDisk(repoDir).catch(() => undefined);
        if (!diskCtx) {
          invalidateLaneShape(rel, undefined);
          const logKey = `${root}\0${rel}`;
          if (!configOwnershipSkipLogged.has(logKey)) {
            configOwnershipSkipLogged.add(logKey);
            glog(`git-sync config skipped ${rel}: receiver repository shape is unreadable/non-owned`);
          }
        } else {
          const receiver = await configReceiver(root, diskCtx);
          const lane = invalidateLaneShape(rel, receiver.shape);
          if (!receiver.owned) {
            const logKey = `${root}\0${rel}`;
            if (!configOwnershipSkipLogged.has(logKey)) {
              configOwnershipSkipLogged.add(logKey);
              glog(`git-sync config skipped ${rel}: receiver ${diskCtx.kind} shape does not own the common config`);
            }
          } else {
            configTarget = { fresh: false, shape: receiver.shape, configPath: receiver.configPath };
            const current = await readConfigSnapshot(receiver.configPath);
            const token = current.ok ? current.snapshot.token : undefined;
            configDue = gitConfigHash(remoteSec.config) !== lane.cfgApplied || !sameConfigToken(token, lane.cfgToken);
          }
        }
      }
    }

    // A conflict checkpoint owns the Git disposition until the user changes the
    // recorded local identity. Config waits; after that change the same due
    // predicate above feeds either the converged shortcut or a new conflict/apply.
    let resolutionChanged = false;
    if (needsRes[rel] !== undefined) {
      if (gitIdentityKey(localId) === needsRes[rel]) {
        return { result: "unchanged", commonDirGroup };
      }
      delete needsRes[rel];
      resolutionChanged = true;
    }

    const applyConfigOnly = async (): Promise<boolean> => {
      if (!configDue || !configTarget || configTarget.fresh) return !configDue;
      try {
        await runConfigApply(rel, repoDir, remoteSec.config!, baseSec?.config, configTarget);
        return true;
      } catch (error) {
        defer(errMsg(error));
        return false;
      }
    };

    // Projected identity comparison on the NARROWER of the two scopes (§7) — what makes
    // worktree→standalone→worktree round-trips converge without apply ping-pong.
    const cmpScope = narrowerScope(remoteSec.refScope, baseSec?.refScope);
    const remoteChanged = projectedKey(remoteSec, cmpScope) !== (baseSec ? projectedKey(baseSec, cmpScope) : "none");
    if (!remoteChanged && !pend && !resolutionChanged && !(configDue && configTarget?.fresh)) {
      if (!(await applyConfigOnly())) return { result: "deferred", commonDirGroup };
      applied[rel] = remoteSec; // unchanged → base advances (possibly across scopes)
      return { result: "unchanged", commonDirGroup };
    }

    // Already converged? (e.g. a pending retry finding the user manually resolved, or a
    // remote change that equals local work) → advance base, clear pending, no mutation.
    // A removal-memory leftover never takes this shortcut: it must go through the §9
    // clean-materialization path (wipe on dir targets) so stale refs can't survive.
    if (localId && !cleanMaterialize) {
      const n = narrowerScope(localId.refScope, remoteSec.refScope);
      if (projectedKey(localId, n) === projectedKey(remoteSec, n)) {
        if (!(await applyConfigOnly())) return { result: "deferred", commonDirGroup };
        applied[rel] = remoteSec;
        delete pending[rel];
        delete removedMem[rel];
        return { result: "unchanged", commonDirGroup };
      }
    }

    const kek = cfg.kek!; // guaranteed by the fail-closed gate above
    if (!cleanMaterialize && localDivergedFromBase(localId, baseSec)) {
      // Per-repo conflict: never auto-clobber local. Preserve remote for manual merge,
      // checkpoint base to remote (stop pull-conflict-looping), and suppress capture
      // until the local identity changes from this recorded value [v2, M2].
      const { recoveryBundle } = await preserveGitConflict(repoDir, remoteSec, store, kek);
      applied[rel] = remoteSec;
      needsRes[rel] = gitIdentityKey(localId);
      delete pending[rel];
      glog(`git-sync CONFLICT ${rel} — local kept; remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}. Resolve manually.`);
      return { result: "conflict", commonDirGroup };
    }

    // Clean apply. Refusals and containment run BEFORE any mutation [v2, B5].
    if (rel !== "." && (matcher.ignores(rel) || matcher.ignores(`${rel}/`))) {
      defer("target is inside an ignored subtree — refusing to materialize");
      return { result: "deferred", commonDirGroup };
    }
    try {
      await assertGitTargetWithinRoot(root, rel);
    } catch (e) {
      defer(errMsg(e));
      return { result: "deferred", commonDirGroup };
    }

    // Dir leftover clean materialization [v5]: quarantine (capture-grade pinning +
    // index/op-state copies) then wipe syncable refs/index/op-state, so the leftover's
    // old refs can never re-enter a later all-scope capture. Runs as applyGitState's
    // beforeMutate hook — i.e. ONLY after every remote artifact has been fetched,
    // decrypted, and verified — so a missing/corrupt bundle can never strand a wiped
    // repo (codex step-3 MAJOR). Hook/quarantine failure → defer, nothing wiped.
    // Pointer leftover: NEVER ref-wipe (shared main-clone store) — the guarded
    // update-only apply is the whole treatment; the memory clears on success.
    const wipeLeftover = cleanMaterialize && dotGit !== undefined && dotGit.isDirectory();
    const configAfterGit = configDue && configTarget && remoteSec.config !== undefined
      ? async () => runConfigApply(rel, repoDir, remoteSec.config!, baseSec?.config, configTarget!)
      : undefined;
    const res = await applyGitState(
      repoDir,
      remoteSec,
      store,
      kek,
      {
        ...(wipeLeftover
          ? {
            beforeMutateWipesRefs: true,
            beforeMutate: async () => {
              await quarantineAndWipeGitState(repoDir);
              delete removedMem[rel]; // leftover quarantined + wiped — the memory served its purpose
            },
          }
          : {}),
        ...(configAfterGit ? { afterGitMutate: configAfterGit } : {}),
      }
    );
    if (res.applied) {
      // Belt-and-braces post-init containment re-verify (§7 [v2, B5; v3]).
      try {
        await assertGitTargetWithinRoot(root, rel);
      } catch (e) {
        glog(`git-sync WARNING ${rel}: post-apply containment check failed: ${errMsg(e)}`);
      }
      applied[rel] = remoteSec;
      delete pending[rel];
      delete removedMem[rel];
      glog(`git-sync applied ${rel}${res.filteredRefs?.length ? ` (filtered refs: ${res.filteredRefs.join(" ")})` : ""}`);
      return { result: "applied", commonDirGroup };
    } else {
      defer(res.reason ?? "apply deferred");
      return { result: "deferred", commonDirGroup };
    }
  };

  const queuedAt = Date.now();
  const commonDirLocks = new Map<string, Promise<void>>();
  const indexes = new Map(keys.map((rel, i) => [rel, i]));
  let progressDone = 0;
  const runRepo = async (rel: string): Promise<void> => {
    const i = indexes.get(rel)!;
    let startedAt = Date.now();
    let result: GitApplyRepoResult = "deferred";
    let commonDirGroup: number | undefined;
    try {
      const lockKey = await gitApplyMutationKey(root, rel);
      await chainLock(commonDirLocks, lockKey, async () => {
        startedAt = Date.now();
        const processed = await processRepo(rel);
        result = processed.result;
        commonDirGroup = processed.commonDirGroup;
      });
    } catch (e) {
      // Per-repo failures defer only THAT repo — one bad repo (a blob missing mid
      // conflict-preserve, an ENOTDIR/hostile target, an fs error) must never abort
      // the whole pull or block the other repos' base advance.
      const remoteSec = remote.gitRepos?.[rel];
      if (remoteSec) pending[rel] = remoteSec;
      glog(`git-sync deferred ${rel}: ${errMsg(e)}`);
      result = "deferred";
    } finally {
      if (metrics) {
        metrics.results[result] += 1;
        metrics.repoTimings.push({
          index: i,
          queueMs: startedAt - queuedAt,
          wallMs: Date.now() - startedAt,
          result,
          commonDirGroup,
        });
      }
      opts.onProgress?.(++progressDone, keys.length);
    }
  };
  await poolMap(nestedRepoChains(keys), gitApplyConcurrency(), async (chain) => {
    for (const rel of chain) await runRepo(rel);
  });
  return pack();
}

/**
 * READ-ONLY advisory count of repos whose LOCAL git state a push would publish —
 * the `rbox status` verdict's git dimension (design 45, codex R1). Mirrors
 * {@link planGitSections}'s per-repo capture decision (pending carry, removal
 * memories, needs-resolution suppression, preflight, the §7 shape×scope carry
 * matrix) without any of its work or side effects: no bundling, no state
 * mutation, no memory pruning. Two accepted approximations, both toward
 * UNDER-claiming "in sync" never over-claiming it: repos beyond the new-repo
 * admission cap still count (push defers them, but they ARE unpublished local
 * work), and a busy (locked) repo counts zero (indeterminate — status must not
 * guess). Identity reads use `git write-tree`, which may add unreferenced tree
 * objects — the same "harmless, like `git status`" footprint sync itself has.
 */
export interface GitDivergenceStatus {
  count: number;
  /** Repos whose config snapshot could not be stabilized/read. These count as
   * divergent and render as the explicit indeterminate `config: checking` state. */
  configChecking: string[];
  /** Permanently disabled or over-wire-bounds config lanes, surfaced loudly. */
  configDisabled: Array<{ relPath: string; reason: string }>;
}

export async function gitDivergenceStatus(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  matcher?: IgnoreMatcher,
  discoveredRepos?: GitDivergenceRepoSource,
  includeBaseRepos = true
): Promise<GitDivergenceStatus> {
  if (!cfg.syncGit) return { count: 0, configChecking: [], configDisabled: [] };
  const base = state.lastSyncedManifest.gitRepos ?? {};
  const pending = state.gitPendingRemote ?? {};
  const needsRes = state.gitNeedsResolution ?? {};
  const removedMem = state.gitReposRemoved ?? {};
  const cache = await loadGitDivergenceCache(root);
  const probes = new Map<string, CachedDivergenceProbe>();
  const run = gitFingerprintRun("cross-repo");
  const kindByPath = new Map<string, GitRepoKind>();
  const sourcePaths = new Set<string>();
  const scheduled = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let repoSource: GitDivergenceRepoSource;
  if (discoveredRepos) {
    repoSource = discoveredRepos;
  } else {
    if (!matcher) throw new Error("gitDivergenceCount requires an ignore matcher unless a repo source is supplied");
    repoSource = (await discoverGitRepos(root, matcher)).sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  }

  const scheduleProbe = async (repo: GitDivergenceRepoHint): Promise<void> => {
    sourcePaths.add(repo.relPath);
    if (repo.kind) kindByPath.set(repo.relPath, repo.kind);
    if (pending[repo.relPath] || scheduled.has(repo.relPath)) return;
    scheduled.add(repo.relPath);
    const p = cachedDivergenceProbe(run, root, repo.relPath, cache, probes, repo.kind)
      .then((kind) => {
        if (kind) kindByPath.set(repo.relPath, kind);
      })
      .catch(() => {})
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= GIT_DIVERGENCE_CONCURRENCY) await Promise.race(inFlight);
  };

  for await (const repo of repoSource) await scheduleProbe(repo);
  await Promise.all(inFlight);

  const keys = [...new Set([...kindByPath.keys(), ...sourcePaths, ...(includeBaseRepos ? Object.keys(base) : [])])].sort();
  const liveKeys = new Set(keys);
  for (const rel of [...cache.repos.keys()]) {
    if (!liveKeys.has(rel)) {
      cache.repos.delete(rel);
      cache.dirty = true;
    }
  }
  await saveGitDivergenceCache(root, cache).catch(() => {});

  // Would the main clone at `parentRel` author a section this cycle (design 68
  // §3.3 eligibility)? Mirrors planGitSections' disposition using the already
  // cached/probed parent outcome, so warm status never spawns git just to skip a
  // linked worktree pointer.
  const parentIsSectioned = (parentRel: string): boolean => {
    if (kindByPath.get(parentRel) !== "dir") return base[parentRel] !== undefined || pending[parentRel] !== undefined; // undiscoverable-but-based → carried
    const probe = probes.get(parentRel);
    if (!probe) return base[parentRel] !== undefined || pending[parentRel] !== undefined;
    if (probe.busy) return base[parentRel] !== undefined; // busy push defers with base carry only
    if (!probe.preflightOk) return !probe.preflightStructural && base[parentRel] !== undefined; // structural drop = no section
    return base[parentRel] !== undefined || pending[parentRel] !== undefined || probe.identityKey !== "none";
  };

  let n = 0;
  const configChecking: string[] = [];
  const configDisabled: Array<{ relPath: string; reason: string }> = [];
  const countConfigDisposition = async (rel: string, baseSec: GitSection): Promise<void> => {
    const cachedLocalCfg = cache.repos.get(rel)?.cachedLocalCfg;
    if (cachedLocalCfg) {
      if (shouldPublishGitConfig(baseSec.config, cachedLocalCfg, state.repoRecords?.[rel]?.cfgSynced)) n++;
      return;
    }
    const localCfg = await readLocalGitConfig(root, rel);
    if (localCfg.status === "ok") {
      if (shouldPublishGitConfig(baseSec.config, localCfg.cached, state.repoRecords?.[rel]?.cfgSynced)) n++;
      return;
    }
    n++; // conservative: the lane must never report zero on an unreadable decision
    if (localCfg.status === "over-bounds") {
      configDisabled.push({ relPath: rel, reason: localCfg.reason });
    } else if (localCfg.fault.disposition === "permanent") {
      configDisabled.push({ relPath: rel, reason: localCfg.fault.reason });
    } else {
      configChecking.push(rel);
    }
  };
  for (const rel of keys) {
    if (pending[rel]) continue; // unapplied remote truth is carried, never local divergence
    const kind = kindByPath.get(rel);
    const baseSec = base[rel];
    if (!kind) {
      if (!baseSec) continue;
      // Repo dir gone entirely → push would publish the removal. Present-but-
      // undiscoverable (ignored leftover) → push carries; not divergence.
      const dirPresent = await fs
        .lstat(repoDirOf(root, rel))
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (!dirPresent) n++;
      continue;
    }
    const probe = probes.get(rel);
    if (!probe || probe.busy) continue; // indeterminate this instant
    // Suppressions FIRST, preflight second — planGitSections' exact order (codex R4:
    // a needsResolution-suppressed repo that turns structurally unsyncable is CARRIED
    // by push, so counting it here would drift the verdict from the planner).
    if (!baseSec && removedMem[rel] !== undefined) {
      if (probe.identityKey === "none" || probe.identityKey === removedMem[rel]) continue; // untouched removal residue
    }
    if (needsRes[rel] !== undefined) {
      if (probe.identityKey === needsRes[rel]) continue; // conflict-suppressed until touched
    }
    if (!probe.preflightOk) {
      // A STRUCTURAL refusal (shallow/bare/…) over a synced base is not a skip:
      // planGitSections DROPS the section, and that drop is an unpublished change
      // (codex R2). Transient failures defer-with-carry → genuinely nothing pending.
      if (probe.preflightStructural && baseSec) n++;
      continue;
    }
    if (probe.identityKey === "none") continue; // empty repo: nothing to capture, base (if any) carries
    // Design 68 §3.3 policy skip: an in-tree linked-worktree pointer whose owning main clone
    // is itself syncable does not publish its own state (it rides the parent bundle) — the
    // planner base-carries/never-authors it, so it is not pending work. Mirrors planGitSections.
    if (kind === "pointer") {
      if (probe.parentRel && parentIsSectioned(probe.parentRel)) continue;
    }
    if (!baseSec) {
      n++; // never-synced local repo → a push would publish it
      continue;
    }
    // The §7 capture-side carry matrix (see planGitSections for the normative copy).
    const key = probe.identityKey;
    const pfKind = probe.preflightKind ?? kind;
    const carry = carryMatrixMatches(baseSec, pfKind, key);
    if (!carry) n++;
    else await countConfigDisposition(rel, baseSec);
  }
  return { count: n, configChecking, configDisabled };
}

export async function gitDivergenceCount(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  matcher?: IgnoreMatcher,
  discoveredRepos?: GitDivergenceRepoSource,
  includeBaseRepos = true
): Promise<number> {
  return (await gitDivergenceStatus(root, cfg, state, matcher, discoveredRepos, includeBaseRepos)).count;
}
