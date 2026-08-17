import { emitJson } from "./json.js";
import type { BriefIdentitySource } from "./status-view/brief.js";
import { refreshStatusDeferralAssertions } from "./status-maintenance.js";
import { projectWorkspaceStatusDetail } from "./status-projection.js";
import { renderWorkspaceStatusSurface, type StatusRenderOptions, type StatusSurfaceRender } from "./status-render.js";
import { gitDeferralEvidence } from "./status-view/git-evidence.js";
import type { StatusCacheHint, StatusMode, WorkspaceStatusProjection } from "./status-contract.js";
import { createStatusReadPort, defaultStatusDeps, type StatusCmdDeps } from "./status-read-port.js";
import { reconcileGitDeferrals } from "./sync-git/deferral-hygiene.js";

export type { StatusCmdDeps } from "./status-read-port.js";
export type { StatusCacheHint } from "./status-contract.js";

export interface StatusCmdResult {
  daemonRunning: boolean;
}

export interface StatusCmdOptions {
  json?: boolean;
  verbose?: boolean;
  git?: boolean;
  /** With `--git`: print the one-line form for every paused repo. */
  all?: boolean;
  /** With `--git`: the uncapped two-sided view of ONE repo (design 273 S2),
   * workspace-relative. */
  gitRepo?: string;
  now?: Date;
}

function assertPresentationFlags(opts: StatusCmdOptions): void {
  const selected = [opts.json, opts.verbose, opts.git].filter((value) => value === true).length;
  if (selected > 1) throw new Error("choose only one status presentation flag: --json, --verbose, or --git");
}

export type StatusCacheWriteReceipt =
  | { kind: "written" }
  | { kind: "skipped-not-owner" }
  | { kind: "write-failed" };

/** Best-effort fallback writeback of the scan's hashcache. It changes no sync
 * authority, and only a status invocation that still owns the workspace may
 * write — including at rename, which the daemon may have claimed by then. */
export async function saveStatusHashCache(
  root: string,
  hint: StatusCacheHint,
  ownsCache: (root: string) => boolean,
): Promise<StatusCacheWriteReceipt> {
  if (!ownsCache(root)) return { kind: "skipped-not-owner" };
  hint.cache.prune(hint.livePaths());
  let failed = false;
  await hint.cache.save(root, { beforeRename: () => ownsCache(root) }).catch(() => { failed = true; });
  return failed ? { kind: "write-failed" } : { kind: "written" };
}

export async function statusCmd(root: string, opts: StatusCmdOptions = {}): Promise<StatusCmdResult> {
  assertPresentationFlags(opts);
  const deps = opts.now === undefined
    ? defaultStatusDeps
    : { ...defaultStatusDeps, now: () => opts.now!.getTime() };
  return statusCmdWithDeps(root, opts, deps);
}

/** Interactive front-door seam: render the brief from a just-fetched identity
 * while the fetch's existing asynchronous profile-cache write settles. */
export async function statusCmdWithBriefIdentity(root: string, identity: BriefIdentitySource): Promise<StatusCmdResult> {
  return statusCmdWithDeps(root, {}, {
    ...defaultStatusDeps,
    readBriefIdentity: async () => identity,
  });
}

/** Project once, then run the two effects cycle 1 left to this root: the
 * best-effort desired-mode promotion and the fallback hashcache writeback. */
async function projectOnce<M extends StatusMode>(
  root: string,
  mode: M,
  deps: StatusCmdDeps,
): Promise<WorkspaceStatusProjection<M>> {
  const projection = await projectWorkspaceStatusDetail(root, { mode }, createStatusReadPort(mode, deps), {
    refresh: (cfg, state) => refreshStatusDeferralAssertions(root, {
      cfg,
      state,
      reconcile: deps.reconcileGitDeferrals ?? reconcileGitDeferrals,
    }),
  });
  // The boot-bound witness remains authoritative; status must still render if
  // the desired-state side file is temporarily unavailable.
  if (projection.bookkeeping.promoteDaemonModeIntent) await deps.promotePendingModeIntent?.(root).catch(() => false);
  if (projection.kind === "detail" && projection.cacheHint) {
    await saveStatusHashCache(root, projection.cacheHint, (owned) => !deps.readDaemonPidRecord(owned).present);
  }
  return projection;
}

export async function statusCmdWithDeps(
  root: string,
  opts: Omit<StatusCmdOptions, "now"> = {},
  deps: StatusCmdDeps = defaultStatusDeps
): Promise<StatusCmdResult> {
  assertPresentationFlags(opts);
  const mode: StatusMode = opts.json ? "json" : opts.verbose ? "verbose" : opts.git === true ? "git" : "brief";
  const projection = await projectOnce(root, mode, deps);
  const options: StatusRenderOptions = await gitEvidenceOption(root, mode, projection, opts.gitRepo);
  if (opts.all === true) options.all = true;
  if (opts.gitRepo !== undefined) options.repo = opts.gitRepo;
  return emitStatusSurface(renderWorkspaceStatusSurface(projection, options));
}

/**
 * Design 273 P1: `evidence()` is the Module's MANUAL-ONLY operation, so it is
 * invoked here — on the `--git` surface a person typed — and never from
 * `projectOnce`, which the daemon, the headline and doctor also run.
 */
async function gitEvidenceOption(
  root: string,
  mode: StatusMode,
  projection: WorkspaceStatusProjection<StatusMode>,
  repo: string | undefined,
): Promise<StatusRenderOptions> {
  if (mode !== "git" || projection.kind !== "detail") return {};
  const rows = projection.git.projectedRepos;
  const wanted = repo === undefined ? rows : rows.filter((row) => row.repo === repo);
  const records = projection.git.records;
  const readings = await gitDeferralEvidence({
    root,
    records: new Map(wanted.flatMap((row) => {
      const record = records[row.repo];
      return record ? [[row.repo, record] as const] : [];
    })),
  });
  return { evidence: (row) => readings.get(row.repo) };
}

function emitStatusSurface(rendered: StatusSurfaceRender): StatusCmdResult {
  if (rendered.surface === "json") emitJson(rendered.payload);
  else for (const line of rendered.lines) console.log(line);
  return { daemonRunning: rendered.daemonRunning };
}
