import fs from "node:fs/promises";
import path from "node:path";
import { gitIdentity, gitIdentityKey, gitPreflight, inTreeWorktreeParentRelFromCtx, isGitBusy, repoCtxFromDisk, writeFileAtomic, type GitIdentity, type GitPreflightResult, type GitRepoKind, type GitSection, type IgnoreMatcher, type RepoCtx } from "../../engine/index.js";
import { repoCtx } from "../../engine/git/shared.js";
import { type GitConfigRunner } from "../../engine/git/config-txn.js";
import { repoDirOf, errMsg } from "./shared.js";
import { readLocalGitConfig, type CachedLocalCfg, type LocalCfgRead } from "./config-lane.js";
import { GIT_FINGERPRINT_VERSION, GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS, gitFingerprint, gitFingerprintRun, type GitFingerprint, type GitFingerprintRun } from "./fingerprint.js";
export const GIT_DIVERGENCE_CONCURRENCY = 8;
const GIT_DIVERGENCE_CACHE_REL = ".rbox/state/git-divergence.json";
// The file version shares the fingerprint version so stale entries are excluded
// from fast repo discovery as well as rejected by per-repo fingerprint checks.
const GIT_DIVERGENCE_CACHE_VERSION = GIT_FINGERPRINT_VERSION;
export interface CachedDivergenceProbe {
  busy: boolean;
  preflightOk: boolean;
  preflightStructural?: boolean;
  preflightKind?: GitRepoKind;
  identityKey: string;
  identityRefs?: Record<string, string>;
  parentRel?: string;
}

/** Opaque to this store; `pending-supersession.ts` owns what it means (#573). */
export interface GitSupersessionRefusal {
  pendingKey: string;
  baseKey: string;
  reason: string;
}

export interface GitDivergenceCacheEntry {
  fingerprint: string;
  writtenAtMs: number;
  identityKey: string;
  kind?: GitRepoKind;
  probe?: CachedDivergenceProbe;
  cachedLocalCfg?: CachedLocalCfg;
  supersessionRefusal?: GitSupersessionRefusal;
}

export interface GitDivergenceCache {
  repos: Map<string, GitDivergenceCacheEntry>;
  dirty: boolean;
}
export type GitDivergenceRepoHint = { relPath: string; kind?: GitRepoKind };
export type GitDivergenceRepoSource = readonly GitDivergenceRepoHint[] | AsyncIterable<GitDivergenceRepoHint>;

export const isGitRepoKind = (v: unknown): v is GitRepoKind => v === "dir" || v === "pointer";

const isString = (v: unknown): v is string => typeof v === "string";

function isCacheEntry(v: unknown): v is GitDivergenceCacheEntry {
  if (v === null || typeof v !== "object") return false;
  const e = v as GitDivergenceCacheEntry;
  if (!isString(e.fingerprint) || typeof e.writtenAtMs !== "number" || !isString(e.identityKey)) return false;
  if (e.kind !== undefined && !isGitRepoKind(e.kind)) return false;
  if (
    e.cachedLocalCfg !== undefined &&
    (e.cachedLocalCfg === null ||
      typeof e.cachedLocalCfg !== "object" ||
      !isString(e.cachedLocalCfg.hash) ||
      typeof e.cachedLocalCfg.nonEmpty !== "boolean")
  ) return false;
  if (e.probe !== undefined) {
    const p = e.probe as CachedDivergenceProbe;
    if (p === null || typeof p !== "object") return false;
    if (typeof p.busy !== "boolean" || typeof p.preflightOk !== "boolean" || !isString(p.identityKey)) return false;
  }
  const refusal = e.supersessionRefusal as GitSupersessionRefusal | null | undefined;
  if (refusal !== undefined
    && !(!!refusal && isString(refusal.pendingKey) && isString(refusal.baseKey) && isString(refusal.reason))) return false;
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

export async function loadGitDivergenceCache(root: string): Promise<GitDivergenceCache> {
  try {
    const raw = await fs.readFile(path.join(root, GIT_DIVERGENCE_CACHE_REL), "utf8");
    const parsed = JSON.parse(raw) as { version?: string; repos?: Record<string, Partial<GitDivergenceCacheEntry>> };
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

export async function saveGitDivergenceCache(root: string, cache: GitDivergenceCache): Promise<void> {
  if (!cache.dirty) return;
  const abs = path.join(root, GIT_DIVERGENCE_CACHE_REL);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const repos = Object.fromEntries([...cache.repos.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  await writeFileAtomic(abs, JSON.stringify({ version: GIT_DIVERGENCE_CACHE_VERSION, repos }));
  cache.dirty = false;
}
/** Whether an entry may be believed for `fresh`: same fingerprint, and outside
 *  git's racy-clean window. Every consumer of a cached decision goes through it. */
export function trustedGitFingerprintHit(fresh: GitFingerprint, entry: GitDivergenceCacheEntry): boolean {
  return entry.fingerprint === fresh.hash && fresh.maxTsMs < entry.writtenAtMs - GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS;
}
type PlanProbeBuild = {
  probe: CachedDivergenceProbe;
  identity?: GitIdentity;
  diskCtx?: RepoCtx;
  parentRel?: string;
};

export async function buildPlanProbe(root: string, rel: string, diskCtx: RepoCtx | undefined, pf?: GitPreflightResult): Promise<PlanProbeBuild> {
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
      ...(identity ? { identityRefs: identity.refs } : {}),
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
    ...(id ? { identityRefs: id.refs } : {}),
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
    JSON.stringify(a.identityRefs) === JSON.stringify(b.identityRefs) &&
    a.parentRel === b.parentRel
  );
}

export type FingerprintHitProbeResult =
  | { status: "hit"; fingerprint: GitFingerprint; probe: CachedDivergenceProbe; cachedLocalCfg?: CachedLocalCfg; kind?: GitRepoKind }
  | { status: "miss"; fingerprint: GitFingerprint; kind?: GitRepoKind }
  | { status: "untrusted"; fingerprint: GitFingerprint; kind?: GitRepoKind };

export type DivergenceCacheProbeSnapshot = {
  beforeFingerprint: GitFingerprint;
  probe: CachedDivergenceProbe;
  kind?: GitRepoKind;
};

export async function fingerprintHitProbe(
  run: GitFingerprintRun,
  root: string,
  rel: string,
  cache: GitDivergenceCache,
  hintKind?: GitRepoKind,
  requireConfigSummary = true
): Promise<FingerprintHitProbeResult> {
  const fresh = await gitFingerprint(run, root, rel);
  const cached = cache.repos.get(rel);
  const kind = cached?.kind ?? fresh.diskCtx?.kind ?? hintKind;
  // Missing cachedLocalCfg is a legacy/incomplete entry: force exactly one slow
  // bracketed pass so config presence can never disappear behind a git fast hit.
  if (cached?.fingerprint !== fresh.hash || !cached.probe || (requireConfigSummary && !cached.cachedLocalCfg)) {
    return { status: "miss", fingerprint: fresh, kind };
  }
  if (!trustedGitFingerprintHit(fresh, cached)) {
    return { status: "untrusted", fingerprint: fresh, kind };
  }
  return { status: "hit", fingerprint: fresh, probe: cached.probe, cachedLocalCfg: cached.cachedLocalCfg, kind };
}

export type DivergenceCacheWriteResult = { kind?: GitRepoKind; localCfg?: LocalCfgRead; stable: boolean };

export async function writeDivergenceCacheEntry(
  run: GitFingerprintRun,
  root: string,
  rel: string,
  cache: GitDivergenceCache,
  probe: CachedDivergenceProbe,
  hintKind: GitRepoKind | undefined,
  beforeFingerprint: GitFingerprint,
  recompute?: () => Promise<DivergenceCacheProbeSnapshot>,
  onCredentialSkip?: () => void,
  skipConfig = false
): Promise<DivergenceCacheWriteResult> {
  let before = beforeFingerprint;
  let currentProbe = probe;
  let currentKind = hintKind;
  for (let attempt = 0; attempt < 2; attempt++) {
    const localCfg = !skipConfig && !currentProbe.busy && currentProbe.preflightOk
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
      // Hygiene authority is bound to the original decision input. A stable
      // recomputed retry may populate the cache, but it cannot retroactively
      // authorize the carry chosen from the first probe.
      return { kind: afterKind, localCfg, stable: attempt === 0 };
    }
    if (!recompute || attempt === 1) return { kind: afterKind, stable: false };
    const next = await recompute();
    before = next.beforeFingerprint;
    currentProbe = next.probe;
    currentKind = next.kind;
  }
  return { kind: currentKind, stable: false };
}

async function probeAndCacheDivergenceRepo(
  run: GitFingerprintRun,
  root: string,
  rel: string,
  cache: GitDivergenceCache,
  before: GitFingerprint,
  hintKind?: GitRepoKind,
  gitConfigRunner?: GitConfigRunner
): Promise<{ kind?: GitRepoKind; probe?: CachedDivergenceProbe }> {
  const realCtx = (await repoCtx(repoDirOf(root, rel)).catch(() => undefined)) ?? null;
  const repoKind = before.diskCtx?.kind ?? realCtx?.kind ?? hintKind;
  let last: CachedDivergenceProbe | undefined;
  let previous: CachedDivergenceProbe | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await probeDivergenceRepo(root, rel, realCtx);
    const localCfg = !last.busy && last.preflightOk
      ? await readLocalGitConfig(root, rel, before.diskCtx ?? realCtx ?? undefined, gitConfigRunner)
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

export async function cachedDivergenceProbe(
  run: GitFingerprintRun,
  root: string,
  rel: string,
  cache: GitDivergenceCache,
  out: Map<string, CachedDivergenceProbe>,
  hintKind?: GitRepoKind,
  gitConfigRunner?: GitConfigRunner
): Promise<GitRepoKind | undefined> {
  const hit = await fingerprintHitProbe(run, root, rel, cache, hintKind);
  if (hit.status === "hit") {
    out.set(rel, hit.probe);
    return hit.kind;
  }
  const refreshed = await probeAndCacheDivergenceRepo(run, root, rel, cache, hit.fingerprint, hit.kind, gitConfigRunner);
  if (refreshed.probe) out.set(rel, refreshed.probe);
  return refreshed.kind;
}

/** The pull-side git outcome: the per-repo base to persist plus the updated local-only maps. */
