/** Never: ancestry proof, ref mutation, or persistence of the cache it consults. */
import { git, gitRaw } from "../../engine/git-spawn.js";
import { HEX40 } from "./git-state.js";
import { graphEnv } from "./reachability.js";

export interface ContentEquivalenceCache {
  get(tip: string, durableRoot: string): boolean | undefined;
  set(tip: string, durableRoot: string, equivalent: boolean): void;
}

export interface ContentEquivalenceOptions {
  /** Injectable only so the 5,000-commit production bound has a cheap test. */
  contentEquivalenceCommitCap?: number;
  contentEquivalenceCache?: ContentEquivalenceCache;
}

export const CONTENT_EQUIVALENCE_COMMIT_CAP = 5_000;

/** Historical patch equivalence: a tip whose single patch already appears in a durable
 * root's history counts as preserved (roadmap G7c reviews this policy on its own). */
function parsePatchIdOutput(raw: string): string[] | undefined {
  // Empty output is a legitimately empty commit range, not a parse failure —
  // a durable root sitting at the fork point must not abort the whole probe.
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const result: string[] = [];
  for (const line of trimmed.split("\n")) {
    const match = /^([0-9a-f]{40}) [0-9a-f]{40}$/.exec(line);
    if (!match) return undefined;
    result.push(match[1]!);
  }
  return result;
}

export async function contentEquivalenceProbe(
  repoDir: string,
  tip: string,
  durableRoots: readonly string[],
  options: ContentEquivalenceOptions,
): Promise<boolean> {
  const cap = options.contentEquivalenceCommitCap ?? CONTENT_EQUIVALENCE_COMMIT_CAP;
  if (!Number.isSafeInteger(cap) || cap < 0) return false;
  for (const durableRoot of durableRoots) {
    const cached = options.contentEquivalenceCache?.get(tip, durableRoot);
    if (cached !== undefined) {
      if (cached) return true;
      continue;
    }
    try {
      const base = await git(repoDir, ["merge-base", durableRoot, tip], { env: graphEnv });
      if (!HEX40.test(base)) return false;
      const countRaw = await git(repoDir, ["rev-list", "--count", `${base}..${durableRoot}`], { env: graphEnv });
      if (!/^(0|[1-9][0-9]*)$/.test(countRaw)) return false;
      const count = Number(countRaw);
      if (!Number.isSafeInteger(count) || count > cap) return false;

      const tipDiff = await gitRaw(repoDir, ["diff-tree", "-p", "--no-commit-id", base, tip], { env: graphEnv });
      const tipPatchIds = parsePatchIdOutput(await gitRaw(repoDir, ["patch-id", "--verbatim"], { env: graphEnv, stdin: tipDiff }));
      if (!tipPatchIds) return false;
      if (tipPatchIds.length !== 1) {
        options.contentEquivalenceCache?.set(tip, durableRoot, false);
        continue;
      }

      const durableLog = await gitRaw(repoDir, ["log", "-p", "--format=%H", "--no-merges", `${base}..${durableRoot}`], { env: graphEnv });
      const durablePatchIds = parsePatchIdOutput(await gitRaw(repoDir, ["patch-id", "--verbatim"], { env: graphEnv, stdin: durableLog }));
      if (!durablePatchIds) return false;
      const matched = durablePatchIds.includes(tipPatchIds[0]!);
      options.contentEquivalenceCache?.set(tip, durableRoot, matched);
      if (matched) return true;
    } catch {
      // This probe only improves an already-negative ancestry answer. Missing
      // objects, shallow/corrupt walks, and subprocess failures remain negative.
      return false;
    }
  }
  return false;
}
