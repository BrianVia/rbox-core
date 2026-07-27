import { emitJson } from "./json.js";
import type { BriefIdentitySource } from "./status-view.js";
import { refreshStatusDeferralAssertions } from "./status-maintenance.js";
import { projectWorkspaceStatusDetail } from "./status-projection.js";
import { renderWorkspaceStatusSurface, type StatusSurfaceRender } from "./status-render.js";
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
  return emitStatusSurface(renderWorkspaceStatusSurface(await projectOnce(root, mode, deps)));
}

function emitStatusSurface(rendered: StatusSurfaceRender): StatusCmdResult {
  if (rendered.surface === "json") emitJson(rendered.payload);
  else for (const line of rendered.lines) console.log(line);
  return { daemonRunning: rendered.daemonRunning };
}
