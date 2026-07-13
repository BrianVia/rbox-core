import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { captureGitState, gitIdentityKey, gitSectionNewestLink, gitSectionTips, projectIdentity, repoCtxFromDisk, MAX_PACK_CHAIN, MAX_GIT_REPOS, type GitIdentity, type GitPackLink, type GitRepoKind, type GitRefScope, type GitSection } from "../../engine/index.js";
import { type GitDeferral, type GitDeferralReason, type WorkspaceConfig } from "../config.js";
import type { SyncRemote } from "../remote.js";
import { PER_FILE_UPLOAD_ATTEMPTS } from "../sync-recovery.js";
// ---- git-sync orchestration (design 43 §§6-7, 9, 13.5) ------------------------------
//
// Extracted from sync.ts so the FILE-sync flow there reads top-to-bottom: this module owns
// the per-repo git plan machinery (push), the per-repo apply loop (pull), and the git
// bookkeeping state transitions. Its interface is narrow and typed — planGitSections /
// applyGitSections take explicit inputs (root, cfg, state, …) and never reach back into
// sync.ts internals. Every [v2]…[v6] codex-rule citation is load-bearing and stays attached
// to the logic it governs.

/** Bundling is CPU/IO heavy — bound concurrent captures (design 43 §6.3). */
export const GIT_CAPTURE_CONCURRENCY = 4;
const GIT_APPLY_CONCURRENCY_DEFAULT = 6;
/** Cross-shape config skips are policy, not a per-tick error. Keep daemon logs
 * loud once per workspace/repo without repeating forever on every pull. */
export const configOwnershipSkipLogged = new Set<string>();
/** Invalid incoming config is an additive-field compatibility event. Keep it
 * loud once per workspace/repo while the independent Git lane continues. */
export const configInvalidSkipLogged = new Set<string>();
/** Credential-bearing URLs are a capture-side security event, not ordinary bad
 * grammar. Log them once per workspace/repo while continuing with the safe
 * projection so a daemon cannot flood its log on every tick. */
export const configCredentialSkipLogged = new Set<string>();

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

export const gitApplyConcurrency = (): number => envInt("RBOX_GIT_APPLY_CONCURRENCY", GIT_APPLY_CONCURRENCY_DEFAULT, 1, 16);

/** Design 116 rollout gate. Read on every decision so tests and long-lived
 * daemons never retain a stale environment value. Only the exact string "0"
 * disables automatic checkout follow; every other value is intentionally on. */
export const gitFollowEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.RBOX_GIT_FOLLOW !== "0";

/** The push-side new-repo admission cap (design 43 §3 [v2, M4]). Env-overridable for
 *  tests/tuning; the manifest-validation bound stays the hard MAX_GIT_REPOS. The cap
 *  bounds capture WORK for newly-discovered repos — base-carrying repos are ALWAYS
 *  carried, so over-cap can never read as mass deletion on receivers. */
export const gitRepoCap = (): number => {
  const n = Number(process.env.RBOX_GIT_REPO_CAP);
  return Number.isInteger(n) && n >= 1 && n <= MAX_GIT_REPOS ? n : MAX_GIT_REPOS;
};

export const repoDirOf = (root: string, relPath: string) => (relPath === "." ? root : path.join(root, relPath));
/** The narrower of two ref scopes ("scoped" ⊂ "all") — the projection target for every
 *  cross-scope identity comparison (design 43 §7). */
export const narrowerScope = (a: GitRefScope, b: GitRefScope | undefined): GitRefScope => (a === "scoped" || b === "scoped" ? "scoped" : "all");
export const projectedKey = (g: GitSection | GitIdentity | undefined, scope: GitRefScope): string => gitIdentityKey(g ? projectIdentity(g, scope) : undefined);
export const carryMatrixMatches = (baseSec: GitSection, pfKind: GitRepoKind, identityKey: string): boolean =>
  pfKind === "dir"
    ? baseSec.refScope === "all" && identityKey === gitIdentityKey(baseSec)
    : baseSec.refScope === "scoped"
      ? identityKey === gitIdentityKey(baseSec)
      : identityKey === projectedKey(baseSec, "scoped");
export const gitReposManifestSchema = (gitRepos: Record<string, GitSection> | undefined): 2 | 3 | undefined =>
  gitRepos ? (Object.values(gitRepos).some((s) => (s.packChain?.length ?? 0) > 0) ? 3 : 2) : undefined;
export const emptyToUndef = <T,>(o: Record<string, T>): Record<string, T> | undefined => (Object.keys(o).length ? o : undefined);
export const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);

const sortedRecord = <T>(record: Record<string, T> | undefined, value: (v: T) => unknown = (v) => v): unknown =>
  record === undefined ? undefined : Object.fromEntries(Object.keys(record).sort().map((key) => [key, value(record[key]!)]));

/** Local-only identity for every section field that can affect receiver mutation. */
export function gitIncomingKey(section: GitSection): string {
  const normalized = {
    head: section.head.trimEnd(),
    refs: sortedRecord(section.refs),
    indexSha: section.indexSha,
    indexTree: section.indexTree,
    opState: sortedRecord(section.opState, (artifact) => artifact.sha),
    config: sortedRecord(section.config, (values) => [...values]),
    refScope: section.refScope,
    bundleSha: section.bundleSha,
    packChain: (section.packChain ?? []).map((link) => link.sha),
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function nextDeferral(
  current: GitDeferral | undefined,
  reason: GitDeferralReason,
  now: string,
  subjectKey?: string,
  checkout?: GitDeferral["checkout"],
): GitDeferral {
  return {
    lane: current?.lane ?? "apply",
    deferredSince: current?.deferredSince ?? now,
    reasonSince: current?.reason === reason ? current.reasonSince : now,
    lastSeen: now,
    ...(subjectKey === undefined ? {} : { subjectKey }),
    reason,
    ...(checkout === undefined ? {} : { checkout }),
    ...(current?.bytesChanged === undefined ? {} : { bytesChanged: current.bytesChanged }),
    ...(current?.reproof === undefined || current.subjectKey !== subjectKey ? {} : { reproof: current.reproof }),
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

export function nestedRepoChains(keys: readonly string[]): string[][] {
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

export async function chainLock<T>(locks: Map<string, Promise<void>>, key: string, fn: () => Promise<T>): Promise<T> {
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

export async function gitApplyMutationKey(root: string, rel: string): Promise<string> {
  const repoDir = repoDirOf(root, rel);
  const ctx = await repoCtxFromDisk(repoDir).catch(() => undefined);
  if (ctx) return path.resolve(ctx.commonDir);
  const dotGit = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
  return dotGit ? path.resolve(repoDir, ".git") : path.resolve(repoDir);
}

export async function capturePlannedGitSection(
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
