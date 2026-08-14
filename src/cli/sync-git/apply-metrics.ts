import type { GitChainTimings } from "../../engine/index.js";

/**
 * The pull-side Git apply run's measurement record.
 *
 * One owner for everything the run counts: the per-result tally, the per-repo
 * timing rows, the common-dir group numbering, and the single-line rendering
 * the daemon logs. `applyGitSections` hands it observations and asks for the
 * finished record; it never reads or assembles the record's shape itself.
 */
export type GitApplyRunKind = "fresh" | "steady";
export type GitApplyRepoResult =
  | "unchanged"
  | "applied"
  | "deferred"
  | "conflict"
  | "removed"
  | "skipped";

/** The named owner contract for the per-result tally. */
export interface GitApplyResultCounts {
  unchanged: number;
  applied: number;
  deferred: number;
  conflict: number;
  removed: number;
  skipped: number;
}

export interface GitApplyRepoTiming {
  index: number;
  queueMs: number;
  wallMs: number;
  result: GitApplyRepoResult;
  commonDirGroup?: number;
  chain?: GitChainTimings;
}

export interface GitApplyMetrics {
  runKind: GitApplyRunKind;
  repos: number;
  commonDirGroups: number;
  results: GitApplyResultCounts;
  repoTimings: GitApplyRepoTiming[];
}

/** One run's live accumulator. Absent when the caller collects no metrics. */
export interface GitApplyRun {
  /** Stable 1-based group number for a resolved common dir, minted on first sight. */
  groupFor(commonDir: string): number;
  record(timing: GitApplyRepoTiming): void;
  /** The finished record, detached from the accumulator's mutable state. */
  snapshot(): GitApplyMetrics;
}

const emptyGitApplyResults = (): GitApplyResultCounts => ({
  unchanged: 0,
  applied: 0,
  deferred: 0,
  conflict: 0,
  removed: 0,
  skipped: 0,
});

const GIT_APPLY_RESULT_ABBR = {
  unchanged: "u",
  applied: "a",
  deferred: "d",
  conflict: "c",
  removed: "rm",
  skipped: "s",
} satisfies Record<GitApplyRepoResult, string>;

const GIT_APPLY_REPO_EXEMPLAR_CAP = 8;

function copyRepoTiming(timing: GitApplyRepoTiming): GitApplyRepoTiming {
  const copy = { ...timing };
  if (timing.chain) copy.chain = { ...timing.chain };
  return copy;
}

export function startGitApplyRun(runKind: GitApplyRunKind, repos: number): GitApplyRun {
  const commonDirGroups = new Map<string, number>();
  const metrics: GitApplyMetrics = {
    // "fresh" = no useful local/base git state (design 74 §3) — NOT sequence 0:
    // a file-synced workspace receiving its first remote.gitRepos is fresh for
    // git purposes even at a nonzero baseline (sequence-keyed
    // classification would poison the Phase-1 gate data).
    runKind,
    repos,
    commonDirGroups: 0,
    results: emptyGitApplyResults(),
    repoTimings: [],
  };
  return {
    groupFor(commonDir) {
      let group = commonDirGroups.get(commonDir);
      if (group === undefined) {
        group = commonDirGroups.size + 1;
        commonDirGroups.set(commonDir, group);
      }
      return group;
    },
    record(timing) {
      metrics.results[timing.result] += 1;
      metrics.repoTimings.push(timing);
    },
    snapshot() {
      return {
        ...metrics,
        commonDirGroups: commonDirGroups.size,
        results: { ...metrics.results },
        repoTimings: metrics.repoTimings.map(copyRepoTiming),
      };
    },
  };
}

interface GitApplyDistribution {
  p50: number;
  p95: number;
  max: number;
}

function gitApplyDistribution(values: number[]): GitApplyDistribution {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percentile: number) => sorted[Math.ceil(percentile * sorted.length) - 1]!;
  return { p50: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1]! };
}

function formatGitApplyDistribution(name: string, values: number[]): string {
  const distribution = gitApplyDistribution(values);
  return `${name} p50=${Math.round(distribution.p50)} p95=${Math.round(distribution.p95)} max=${Math.round(distribution.max)}`;
}

function gitApplyRepoExemplars(repoTimings: GitApplyRepoTiming[]): GitApplyRepoTiming[] {
  if (process.env.RBOX_DEBUG) return repoTimings;
  if (repoTimings.length <= GIT_APPLY_REPO_EXEMPLAR_CAP) {
    return [...repoTimings].sort((a, b) => a.index - b.index);
  }

  const byWall = [...repoTimings].sort((a, b) => b.wallMs - a.wallMs || a.index - b.index);
  const byQueue = [...repoTimings].sort((a, b) => b.queueMs - a.queueMs || a.index - b.index);
  const selected = new Map<number, GitApplyRepoTiming>();
  const add = (timing: GitApplyRepoTiming | undefined): void => {
    if (timing && selected.size < GIT_APPLY_REPO_EXEMPLAR_CAP) selected.set(timing.index, timing);
  };

  add(byWall[0]);
  add(byQueue[0]);
  for (const timing of [...repoTimings].sort((a, b) => a.index - b.index)) {
    if (timing.result !== "unchanged") add(timing);
  }

  let wallIndex = 0;
  let queueIndex = 0;
  const addNext = (ranked: GitApplyRepoTiming[], cursor: number): number => {
    while (cursor < ranked.length && selected.has(ranked[cursor]!.index)) cursor += 1;
    add(ranked[cursor]);
    return cursor + 1;
  };
  while (selected.size < GIT_APPLY_REPO_EXEMPLAR_CAP) {
    const sizeBefore = selected.size;
    wallIndex = addNext(byWall, wallIndex);
    if (selected.size < GIT_APPLY_REPO_EXEMPLAR_CAP) queueIndex = addNext(byQueue, queueIndex);
    if (selected.size === sizeBefore) break;
  }

  return [...selected.values()].sort((a, b) => a.index - b.index);
}

export function formatGitApplyMetrics(metrics: GitApplyMetrics): string {
  const resultBits = (Object.entries(metrics.results) as Array<[GitApplyRepoResult, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(",");
  const repoBits = gitApplyRepoExemplars(metrics.repoTimings)
    .map((t) => {
      const group = t.commonDirGroup === undefined ? "" : `g${t.commonDirGroup}`;
      const chain = t.chain && hasGitChainTiming(t.chain)
        ? ` L${t.chain.chainLength}fd${Math.round(chainMetric(t.chain.fetchDecryptMs))}bv${Math.round(chainMetric(t.chain.bundleVerifyMs))}gi${Math.round(chainMetric(t.chain.gitImportMs))}io${Math.round(chainMetric(t.chain.indexOpStateMs))}jr${Math.round(chainMetric(t.chain.journalMs))}rt${Math.round(chainMetric(t.chain.refTxnExclusiveMs))}ow${Math.round(chainMetric(t.chain.ownershipMs))}rl${Math.round(chainMetric(t.chain.reflogMs))}cp${Math.round(chainMetric(t.chain.connectivityProofMs))}cx${Math.round(chainMetric(t.chain.classifyExclusiveMs))}hi${Math.round(chainMetric(t.chain.heldInputMs))}sp${Math.round(chainMetric(t.chain.standingProofMs))}cl${Math.round(chainMetric(t.chain.classifyMs))}rs${Math.round(chainMetric(t.chain.residualMs))}`
        : "";
      return `i${t.index}q${t.queueMs}w${t.wallMs}${GIT_APPLY_RESULT_ABBR[t.result]}${group}${chain}`;
    })
    .join(",");
  const distributions = [
    formatGitApplyDistribution("queueMs", metrics.repoTimings.map((timing) => timing.queueMs)),
    formatGitApplyDistribution("wallMs", metrics.repoTimings.map((timing) => timing.wallMs)),
  ];
  const chainTimings = metrics.repoTimings
    .map((timing) => timing.chain)
    .filter((chain): chain is GitChainTimings => chain !== undefined && hasGitChainTiming(chain));
  if (chainTimings.length > 0) {
    distributions.push(
      formatGitApplyDistribution("fetchDecryptMs", chainTimings.map((chain) => chain.fetchDecryptMs)),
      formatGitApplyDistribution("bundleVerifyMs", chainTimings.map((chain) => chain.bundleVerifyMs)),
      formatGitApplyDistribution("gitImportMs", chainTimings.map((chain) => chain.gitImportMs)),
      formatGitApplyDistribution("indexOpStateMs", chainTimings.map((chain) => chain.indexOpStateMs)),
      formatGitApplyDistribution("journalMs", chainTimings.map((chain) => chainMetric(chain.journalMs))),
      formatGitApplyDistribution("refTxnExclusiveMs", chainTimings.map((chain) => chainMetric(chain.refTxnExclusiveMs))),
      formatGitApplyDistribution("ownershipMs", chainTimings.map((chain) => chainMetric(chain.ownershipMs))),
      formatGitApplyDistribution("reflogMs", chainTimings.map((chain) => chainMetric(chain.reflogMs))),
      formatGitApplyDistribution("connectivityProofMs", chainTimings.map((chain) => chainMetric(chain.connectivityProofMs))),
      formatGitApplyDistribution("classifyExclusiveMs", chainTimings.map((chain) => chainMetric(chain.classifyExclusiveMs))),
      formatGitApplyDistribution("heldInputMs", chainTimings.map((chain) => chainMetric(chain.heldInputMs))),
      formatGitApplyDistribution("standingProofMs", chainTimings.map((chain) => chainMetric(chain.standingProofMs))),
      formatGitApplyDistribution("classifyMs", chainTimings.map((chain) => chainMetric(chain.classifyMs))),
      formatGitApplyDistribution("residualMs", chainTimings.map((chain) => chainMetric(chain.residualMs))),
    );
  }
  return `mode=${metrics.runKind} repos=${metrics.repos} commonDirs=${metrics.commonDirGroups} skippedHeld=${metrics.results.skipped} results=${resultBits || "none"} ${distributions.join(" ")} repoMs=${repoBits || "none"}`;
}

function hasGitChainTiming(chain: GitChainTimings): boolean {
  return chain.chainLength > 0 || chain.fetchDecryptMs > 0 || chain.bundleVerifyMs > 0
    || chain.gitImportMs > 0 || chain.refTxnExclusiveMs > 0 || chain.ownershipMs > 0
    || chain.reflogMs > 0 || chain.connectivityProofMs > 0 || chain.indexOpStateMs > 0
    || chain.journalMs > 0 || chain.classifyMs > 0 || chainMetric(chain.classifyExclusiveMs) > 0
    || chainMetric(chain.heldInputMs) > 0 || chainMetric(chain.standingProofMs) > 0;
}

function chainMetric(value: number | undefined): number {
  return Number.isFinite(value) ? value! : 0;
}
