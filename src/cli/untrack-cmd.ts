/**
 * `rbox untrack [path]` (design 29 §"untrack") — cleanly stop syncing a directory.
 *
 * LOCAL-ONLY: it never touches remote data or the device (the `--purge-remote`
 * the founder wants is deferred to a separate backend design — remote deletion
 * needs a new authenticated API + authz + audit). Local files are left untouched;
 * only the `.rbox/` binding is removed, so the directory stops syncing on THIS
 * machine. Other machines keep syncing the workspace; delete it from the dashboard.
 *
 * Two safety guards the design mandates:
 *   1. If our daemon is running, SIGTERM it and POLL for actual exit (~5s) before
 *      touching `.rbox/` — `stopDaemon` removes the pidfile immediately, so a naive
 *      `rm` would race a daemon mid-write. `--force` escalates to SIGKILL on timeout.
 *   2. Before removing, `lstat` `.rbox`, REFUSE if it's a symlink, and confirm its
 *      realpath is exactly `<root>/.rbox`. Only then recursively remove the tree
 *      (the `.rbox/` layout is nested/evolving — workspace.json, state/metrics.json
 *      — so a guarded full remove beats brittle file enumeration). The daemon's
 *      pid/log live GLOBALLY under `~/.rbox/daemons/…`, so untrack also removes
 *      that per-workspace dir (`removeDaemonRuntime`) to avoid orphaning them.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { RBOX_DIR } from "./workspace-config.js";
import { forceKill, isDaemonRunning, removeDaemonRuntime, stopDaemon, waitForExit } from "./daemon-control.js";
import { style } from "./style.js";
import { loadAdoptJournal } from "./adopt-journal.js";
import { forgetBinding, isRegisteredRoot } from "./binding-registry.js";
import { ensureFolderAuthority } from "./folder-authority.js";
import { forgetFolder, inspectFolderCatalog, type FolderCatalogState } from "./folder-config.js";

const STOP_TIMEOUT_MS = 5000;
const KILL_TIMEOUT_MS = 2000;

export interface UntrackOptions {
  root: string;
  force: boolean;
  /** Interactive confirm (skipped when `force`). Returns true to proceed. */
  confirm?: () => Promise<boolean>;
}

export type UntrackStep = "daemon-stopped" | "binding-removed" | "runtime-removed" | "catalog-forgotten" | "registry-forgotten";

export interface UntrackDeps {
  /** Crash-injection/ordering observation seam; production callers omit it. */
  onStep?: (step: UntrackStep) => void | Promise<void>;
}

function catalogLists(state: FolderCatalogState, root: string): boolean {
  return state.kind === "authoritative"
    && state.snapshot.folders.some((folder) => folder.normalizedPath === path.resolve(root));
}

export async function untrack(opts: UntrackOptions, deps: UntrackDeps = {}): Promise<void> {
  const { root, force } = opts;
  const step = async (completed: UntrackStep): Promise<void> => deps.onStep?.(completed);

  // Preserve untrack's established, specific refusal for a swapped workspace
  // binding before the adoption-journal reader performs its broader control-path
  // validation.  This is only an early refusal; removeRboxDir repeats the check
  // at the destructive boundary.
  const earlyRboxPath = path.join(root, RBOX_DIR);
  const earlyRboxStat = await fsp.lstat(earlyRboxPath).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error),
  );
  if (earlyRboxStat?.isSymbolicLink()) {
    throw new Error(`${earlyRboxPath} is a symlink — refusing to remove it (resolve it manually)`);
  }

  if (await loadAdoptJournal(root)) {
    throw new Error("retained adoption data can be removed only with `rbox adopt clean`; untrack refused");
  }

  let catalogState = await inspectFolderCatalog();
  const damagedCatalog = catalogState.kind === "damaged";
  if (damagedCatalog) {
    process.stderr.write(`warning: rbox folder configuration is damaged; untracking the explicit workspace root and leaving its catalog entry for \`rbox config regenerate\`\n`);
  } else if (earlyRboxStat !== undefined && catalogState.kind !== "authoritative") {
    catalogState = await ensureFolderAuthority({ currentRoot: root });
  }
  // Capture compatibility evidence before deleting either exact-root locator.
  // This snapshot controls only the already-gone UX; the final strict forget is
  // unconditional so a concurrent best-effort registry writer cannot survive.
  const registryKnows = await isRegisteredRoot(root);

  if (!force && opts.confirm) {
    const ok = await opts.confirm();
    if (!ok) {
      process.stderr.write("untrack cancelled — nothing changed.\n");
      return;
    }
  }

  // 1. Stop the daemon and wait for the process to actually exit before we touch
  //    `.rbox/` (it may be mid-write). `--force` escalates after the timeout.
  const daemon = isDaemonRunning(root);
  if (daemon.running && daemon.pid !== undefined) {
    await stopDaemon(root);
    const exited = await waitForExit(daemon.pid, STOP_TIMEOUT_MS);
    if (!exited) {
      if (force) {
        forceKill(daemon.pid);
        if (!(await waitForExit(daemon.pid, KILL_TIMEOUT_MS))) {
          throw new Error("daemon exit could not be confirmed after SIGKILL — runtime retained");
        }
      } else {
        throw new Error("daemon still running — stop it and retry (or pass --force to kill it)");
      }
    }
  }
  await step("daemon-stopped");

  // 2. Remove the binding, but only after proving the path is exactly <root>/.rbox
  //    and not a symlink (defeats a swapped/symlinked `.rbox` pointing elsewhere).
  const rboxPath = path.join(root, RBOX_DIR);
  const bindingGone = !(await fsp.lstat(rboxPath).then(() => true, () => false));
  if (bindingGone) {
    // The binding is already gone (the folder was deleted, moved, or cleaned by
    // hand) but the local registry still lists it. This is the ONLY way to clear
    // the `missing` rows `rbox status --all` / `doctor --all` report, so untrack
    // forgets the entry instead of dead-ending on "nothing to untrack".
    const catalogKnows = catalogLists(catalogState, root);
    const known = registryKnows || catalogKnows;
    await step("binding-removed");
    await removeDaemonRuntime(root);
    await step("runtime-removed");
    if (catalogKnows && !damagedCatalog) await forgetFolder(root);
    await step("catalog-forgotten");
    await forgetBinding(root);
    await step("registry-forgotten");
    if (!known) throw new Error(`no rbox binding at ${rboxPath} — nothing to untrack`);
    console.log(`${style.sym.ok} forgot ${root}`);
    console.log(style.dim("  its rbox binding was already gone; this machine no longer lists it."));
    return;
  }
  await removeRboxDir(root, rboxPath);
  await step("binding-removed");

  // The daemon's pid/log live globally under ~/.rbox — remove them too so untrack
  // leaves nothing orphaned outside the workspace.
  await removeDaemonRuntime(root);
  await step("runtime-removed");
  if (!damagedCatalog) await forgetFolder(root);
  await step("catalog-forgotten");
  // Design 211: drop the durable binding record so the aggregate views stop
  // listing this root at all (rather than listing it as a stale binding).
  await forgetBinding(root);
  await step("registry-forgotten");

  console.log(`${style.sym.ok} untracked ${root}`);
  console.log(style.dim("  local files are untouched."));
  console.log(style.dim("  the remote workspace still exists — other machines keep syncing it."));
  console.log(style.dim("  manage or delete the workspace from the dashboard."));
}

/** Guarded recursive remove of `<root>/.rbox`: refuse a symlink, confirm realpath. */
async function removeRboxDir(root: string, rboxPath: string): Promise<void> {
  let st;
  try {
    st = await fsp.lstat(rboxPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no rbox binding at ${rboxPath} — nothing to untrack`);
    }
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`${rboxPath} is a symlink — refusing to remove it (resolve it manually)`);
  }
  // realpath both sides and require an exact match: the workspace's own .rbox, not
  // a path that resolves elsewhere through a parent symlink.
  const [realRoot, realRbox] = await Promise.all([fsp.realpath(root), fsp.realpath(rboxPath)]);
  if (realRbox !== path.join(realRoot, RBOX_DIR)) {
    throw new Error(`${rboxPath} resolves to ${realRbox} (not ${path.join(realRoot, RBOX_DIR)}) — refusing to remove it`);
  }
  await fsp.rm(rboxPath, { recursive: true, force: true });
}
