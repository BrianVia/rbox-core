import fs from "node:fs/promises";
import path from "node:path";
import { discoverGitRepos, poolMap, repoCtxFromDisk, type GitRepoKind, type GitSection, type IgnoreMatcher } from "../../engine/index.js";
import { type GitConfigRunner } from "../../engine/git/config-txn.js";
import { DEFERRAL_LANES, repoRecordsForState, type GitDeferral, type SyncState, type WorkspaceConfig } from "../config.js";
import { repoDirOf, carryMatrixMatches } from "./shared.js";
import { readLocalGitConfig, shouldPublishGitConfig } from "./config-lane.js";
import { gitFingerprintRun } from "./fingerprint.js";
import { GIT_DIVERGENCE_CONCURRENCY, loadGitDivergenceCache, saveGitDivergenceCache, cachedDivergenceProbe, type CachedDivergenceProbe, type GitDivergenceRepoHint, type GitDivergenceRepoSource } from "./divergence-cache.js";
import { inspectConflictRefs } from "./conflict-retention.js";
/**
 * READ-ONLY advisory count of repos whose LOCAL git state a push would publish —
 * the `rbox status` verdict's git dimension (design 45). Mirrors
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
  /** Durable lane projection. Read-only and intentionally excludes opaque keys. */
  deferrals: Array<{
    relPath: string;
    lane: GitDeferral["lane"];
    reason: GitDeferral["reason"];
    deferredSince: string;
    bytesChanged?: boolean;
  }>;
  /** Repos whose config snapshot could not be stabilized/read. These count as
   * divergent and render as the explicit indeterminate `config: checking` state. */
  configChecking: string[];
  /** Permanently disabled or over-wire-bounds config lanes, surfaced loudly. */
  configDisabled: Array<{ relPath: string; reason: string }>;
  conflictSnapshots: { total: number; prunable: number };
}

export interface GitDivergenceStatusOptions {
  /** Deterministic §11 seam for forcing a config snapshot to remain unstable. */
  gitConfigRunner?: GitConfigRunner;
}

export async function conflictSnapshotStatus(root: string, relPaths: readonly string[]): Promise<{ total: number; prunable: number }> {
  const result = { total: 0, prunable: 0 };
  const repos = new Map<string, { rel: string; ctx: NonNullable<Awaited<ReturnType<typeof repoCtxFromDisk>>> }>();
  for (const rel of [...new Set(relPaths)].sort()) {
    const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    if (ctx) repos.set(path.resolve(ctx.commonDir), { rel, ctx });
  }
  await poolMap([...repos.values()], GIT_DIVERGENCE_CONCURRENCY, async ({ rel, ctx }) => {
    const inspected = await inspectConflictRefs(repoDirOf(root, rel), Date.now(), ctx).catch(() => undefined);
    if (!inspected) return;
    result.total += inspected.total;
    result.prunable += inspected.prunable.length;
  });
  return result;
}

export async function gitDivergenceStatus(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  matcher?: IgnoreMatcher,
  discoveredRepos?: GitDivergenceRepoSource,
  includeBaseRepos = true,
  options: GitDivergenceStatusOptions = {}
): Promise<GitDivergenceStatus> {
  const deferrals: GitDivergenceStatus["deferrals"] = [];
  for (const [relPath, record] of Object.entries(repoRecordsForState(state))) {
    for (const lane of DEFERRAL_LANES) {
      const deferral = record.deferrals?.[lane];
      if (!deferral) continue;
      deferrals.push({
        relPath,
        lane: deferral.lane,
        reason: deferral.reason,
        deferredSince: deferral.deferredSince,
        ...(deferral.bytesChanged === undefined ? {} : { bytesChanged: deferral.bytesChanged }),
      });
    }
  }
  deferrals.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0) || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
  const base = state.lastSyncedManifest.gitRepos ?? {};
  const pending = state.gitPendingRemote ?? {};
  if (!cfg.syncGit) {
    const known = new Set([...Object.keys(base), ...Object.keys(pending), ...Object.keys(repoRecordsForState(state))]);
    if (discoveredRepos) for await (const repo of discoveredRepos) known.add(repo.relPath);
    else if (matcher) for (const repo of await discoverGitRepos(root, matcher)) known.add(repo.relPath);
    return { count: 0, deferrals, configChecking: [], configDisabled: [], conflictSnapshots: await conflictSnapshotStatus(root, [...known]) };
  }
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
    const p = cachedDivergenceProbe(run, root, repo.relPath, cache, probes, repo.kind, options.gitConfigRunner)
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

  const keys = [...new Set([...kindByPath.keys(), ...sourcePaths, ...Object.keys(pending), ...(includeBaseRepos ? Object.keys(base) : [])])].sort();
  const conflictSnapshots = await conflictSnapshotStatus(root, keys);
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
    const localCfg = await readLocalGitConfig(root, rel, undefined, options.gitConfigRunner);
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
    // Suppressions FIRST, preflight second — planGitSections' exact order:
    // a needsResolution-suppressed repo that turns structurally unsyncable is CARRIED
    // by push, so counting it here would drift the verdict from the planner.
    if (!baseSec && removedMem[rel] !== undefined) {
      if (probe.identityKey === "none" || probe.identityKey === removedMem[rel]) continue; // untouched removal residue
    }
    if (needsRes[rel] !== undefined) {
      if (probe.identityKey === needsRes[rel]) continue; // conflict-suppressed until touched
    }
    if (!probe.preflightOk) {
      // A STRUCTURAL refusal (shallow/bare/…) over a synced base is not a skip:
      // planGitSections DROPS the section, and that drop is an unpublished change.
      // Transient failures defer-with-carry → genuinely nothing pending.
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
  return { count: n, deferrals, configChecking, configDisabled, conflictSnapshots };
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
