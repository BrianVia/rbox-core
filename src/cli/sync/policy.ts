/** Never: I/O drivers, rendering. */
import { buildIgnoreMatcher, type IgnoreMatcher, type Manifest } from "../../engine/index.js";
import type { WorkspaceConfig } from "../config.js";
import { RboxApi, type SyncRemote } from "../remote.js";
import { envInt } from "../remote/resilient.js";
import type { SyncDeps } from "./deps.js";

export const apiFor = (cfg: WorkspaceConfig): SyncRemote =>
  new RboxApi(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId);

export const MAX_ATTEMPTS = 5;
/** Design 244 a2: an op stops re-entering the 409 pull-first loop once it has spent
 *  this long losing races, even with attempts left — long retry belongs to the daemon's
 *  recovery probe, not to one op holding the lane. Sync-owned; mirrors the daemon's
 *  RECOVERY_PROBE_CAP_MS by design so a surrendered op lands in the probe's cadence. */
export const PUSH_CONFLICT_SURRENDER_MS = 120_000;
/** Mass-delete guard (design 44): a pull that wants to delete this many files AND at
 *  least half the baseline is far more likely a poisoned baseline / wrong workspace /
 *  server-side accident than a real edit, so it fails closed until a human says
 *  otherwise. Normal dev churn (deleting a subtree) stays far under half the tree. */
export const MASS_DELETE_MIN_FILES = 100;

/** Push-side mass-delete breaker (design 108). Refuse a push that deletes
 *  >= max(PCT% of the last-synced file count, MIN) files BEFORE any upload/commit —
 *  a poisoned/empty scan or stray `rm -rf` must not propagate a fleet-wide wipe.
 *  Env-overridable; the MIN floor exempts small workspaces (blast radius is small),
 *  the PCT leg catches large ones before a full wipe. */
const PUSH_MASS_DELETE_PCT_DEFAULT = 20;
const PUSH_MASS_DELETE_MIN_DEFAULT = 1000;
/** Pure predicate (exported for unit tests): trips when deletes reach BOTH the
 *  absolute floor AND the percentage of the baseline. Integer-safe form of
 *  `deletes >= max(min, pct% * baseCount)`. */
export function pushMassDeleteTrips(
  deletes: number,
  baseCount: number,
  opts: { pct?: number; min?: number } = {}
): boolean {
  const pct = opts.pct ?? envInt("RBOX_MASS_DELETE_PCT", PUSH_MASS_DELETE_PCT_DEFAULT, 0, Number.MAX_SAFE_INTEGER);
  const min = opts.min ?? envInt("RBOX_MASS_DELETE_MIN", PUSH_MASS_DELETE_MIN_DEFAULT, 0, Number.MAX_SAFE_INTEGER);
  return deletes >= min && deletes * 100 >= pct * baseCount;
}

/** Producer-typed safety refusal. Status must never infer this class from the
 * human message persisted beside it. */
export class MassDeleteGuardError extends Error {
  constructor(public readonly op: "pull" | "push", message: string) {
    super(message);
    this.name = "MassDeleteGuardError";
  }
}

/** Founder ruling 2026-09-01: the flagship workspace measured 198K LEGIT
 * entries — 99.2% of the old 200K bound. Growth-only + one owner (#838/#848)
 * makes raising safe: this only gates what a push may AUTHOR; receivers never
 * size-judge. Plan-tied caps come in M7b. */
export const MAX_ENTRIES = 1_000_000;

/** THE entry-cap rule, and its only owner. #813 refuses a runaway workspace
 * before any spend; #838 makes that refusal growth-only, because the cap was
 * also blocking the only cure. A candidate trips only when it is over the cap
 * AND larger than the base it supersedes: shrinking or holding steady above the
 * cap is the workspace moving in the right direction (`rbox ignore --purge`,
 * a repair push) and always passes.
 *
 * Readers never apply this, and `validateManifest` therefore no longer bounds
 * entry count at all: a reader cannot see the base a manifest supersedes, so it
 * cannot tell a runaway from the shrink that cures one, and refusing to READ an
 * over-cap manifest makes recovery impossible from the client — the 212,846-entry
 * workspace in #838 could neither pull its own head nor run `rbox ignore --purge`.
 * The wire's own ceiling stays MAX_MANIFEST_PLAINTEXT at the envelope boundary. */
export function entryCapTrips(candidateEntries: number, baseEntries: number): boolean {
  return candidateEntries > MAX_ENTRIES && candidateEntries > baseEntries;
}

/** Producer-typed safety refusal (#813): the candidate carries more entries than
 * a manifest may hold, and more than the base it supersedes. Thrown at
 * composition, before any encrypt/upload spend. */
export class EntryCapGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntryCapGuardError";
  }
}

/** Design 202: the local view a pull's main line may consume INSTEAD of scanning
 *  the workspace. `manifest` is the daemon's watcher-maintained truth with every
 *  unsettled path already stripped (scan-omission semantics, design 108) and
 *  `deferred` is exactly that unsettled set — it feeds the git oracle's exemption
 *  list the way a scan's deferrals do. Constructed only by the daemon, and only for
 *  the single top-level `pull()` of an op. */
export type TrustedLocalView = {
  manifest: Manifest;
  deferred: ReadonlySet<string>;
};

/** Design 202: the mass-delete guard tripped while the main line was reading a
 *  TRUSTED (unscanned) local view. Thrown strictly BEFORE any file action executes,
 *  so the caller may simply re-run the pull scan-backed; it is never a halt. Only
 *  the scan-backed re-run may halt with {@link MassDeleteGuardError}. */
export class TrustedViewRefusalError extends Error {
  constructor(public readonly reason: "mass-delete", message: string) {
    super(message);
    this.name = "TrustedViewRefusalError";
  }
}

/** Named owner for the deferral tally a scan hands its caller: one counter to
 *  feed, one flush that emits the batched line. */
export interface DeferErrnoReporter {
  onErrno: (code: string) => void;
  flush: () => void;
}

export function makeDeferErrnoReporter(
  sink: (line: string) => void = (l) => console.error(`rbox: ${l}`),
  onFault?: () => void,
): DeferErrnoReporter {
  const counts = new Map<string, number>();
  return {
    onErrno: (code) => counts.set(code, (counts.get(code) ?? 0) + 1),
    flush: () => {
      if (counts.size === 0) return;
      try { onFault?.(); } catch { /* observability cannot fail a scan */ }
      const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
      const tally = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `${code}×${count}`).join(", ");
      const body = `scan deferred ${total} file(s) on IO fault (${tally})`;
      sink(body);
    },
  };
}
/** The empty per-relPath 422 recapture set: the default force for a first attempt (design
 *  43 §6 [v2, M5]). Its `.size === 0` also marks "not a git-recapture retry" below. */
export const NO_GIT_FORCE: ReadonlySet<string> = new Set();


/** Design 108: files-first first publish. Default ON (founder call 2026-07-13 —
 *  single-user fleet, and the path is genesis-only so it is inert for every existing
 *  workspace). `RBOX_FILES_FIRST=0` is the kill switch: it restores the byte-identical
 *  legacy path, including init's report/metrics wiring, which gates on this same flag
 *  so a flag-off `rbox init` emits exactly the pre-108 output. */
export const filesFirstFlagEnabled = (): boolean => process.env.RBOX_FILES_FIRST !== "0";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Exponential backoff with jitter, so two hot daemons don't livelock retrying. */
export const defaultBackoff = (attempt: number) => sleep(Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random()));

/** Adapt `deps.onProgress` into the engine scan's discovery callback: the walk reports a
 *  running count with no known total, which surfaces as the indeterminate `scan` phase. */
export const scanTick = (deps: SyncDeps): ((discovered: number, bytesDiscovered: number) => void) | undefined =>
  deps.onProgress ? (discovered, bytesDiscovered) => deps.onProgress!(discovered, 0, "scan", undefined, { bytesDone: bytesDiscovered }) : undefined;

/** Plaintext byte total / file-entry count of a manifest (the §35 "plaintext bytes" basis
 *  + file count). Computed only on the metrics-enabled path (each is an O(files) pass). */
export const plaintextBytesOf = (m: Manifest): number => m.files.reduce((n, f) => n + (f.type === "file" ? f.size : 0), 0);
export const fileCountOf = (m: Manifest): number => m.files.reduce((n, f) => n + (f.type === "file" ? 1 : 0), 0);
export const matcherForState = (root: string, cfg: WorkspaceConfig, state?: { lastSyncedManifest: Manifest }, opts: { purgeSafety?: boolean } = {}) =>
  buildIgnoreMatcher(root, {
    respectGitignore: cfg.respectGitignore === true,
    // Machine-local ignores are forward-only and must never become fleet-wide purge deletes.
    ignorePaths: opts.purgeSafety === true ? [] : cfg.ignorePaths ?? [],
    forceTrackedEvaluation: opts.purgeSafety === true,
    protectTrackedPaths: opts.purgeSafety === true,
    knownGitRepos: Object.keys(state?.lastSyncedManifest.gitRepos ?? {}),
  });

/**
 * Purge safety: a repo whose tracked set could not be evaluated may hold committed
 * files among these deletions, and purge is the one flow that turns a local ignore
 * verdict into a fleet-wide delete. Refuse rather than guess.
 *
 * ONE copy, deliberately: the preview (`rbox ignore --purge`) and the enforcing
 * publish transition must refuse on the identical condition with the identical
 * message, or the dry-run stops predicting what the real run does.
 */
export function assertNoUnevaluatedPurgeDeletes(matcher: IgnoreMatcher, deleted: readonly string[]): void {
  for (const path of deleted) {
    const repo = matcher.unevaluatedGitRepoForPath?.(path);
    if (repo !== undefined) {
      throw new Error(
        `refusing purge: cannot evaluate tracked files for git repo ${repo} (first affected path ${path}). ` +
          `Fix that repo's .git/index and retry.`
      );
    }
  }
}
