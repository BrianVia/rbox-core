/** Explicit, crash-convergent repair of a folder moved on the local filesystem. */
import fs from "node:fs/promises";
import path from "node:path";
import { fsyncDirectory, isAbsent } from "../engine/fsutil.js";
import { mutateDesiredRecord, desiredStatePath } from "./autostart/desired-state.js";
import { readPersistedEntries, relocateBinding } from "./binding-registry.js";
import { isDaemonRunning, stopDaemon } from "./daemon-control.js";
import { ensureFolderAuthority } from "./folder-authority.js";
import { listFolderInventory } from "./folder-inventory.js";
import { daemonRuntimeDir } from "./rbox-paths.js";
import { withScopeTransitionLock } from "./scope/scope-lock.js";
import { style } from "./style.js";
import { withWorkspaceSyncMutex } from "./sync-mutex.js";
import { loadConfig, saveConfig, type WorkspaceConfig } from "./workspace-config.js";

export type FolderRepairStep =
  | "daemons-stopped"
  | "runtime-renamed"
  | "runtime-parent-synced"
  | "desired-rebased"
  | "registry-relocated"
  | "binding-written"
  | "binding-parent-synced";

export interface FolderRepairDeps {
  onStep?: (step: FolderRepairStep) => void | Promise<void>;
  write?: (line: string) => void;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
}

function identity(config: WorkspaceConfig): string {
  return `${config.remoteWorkspaceId}\0${config.deviceId}`;
}

async function stopIfRunning(root: string): Promise<void> {
  if (isDaemonRunning(root).running) await stopDaemon(root);
}

async function relocateRuntime(
  oldRoot: string,
  newRoot: string,
  workspaceId: string,
  step: (value: FolderRepairStep) => Promise<void>,
): Promise<void> {
  const source = daemonRuntimeDir(oldRoot);
  const destination = daemonRuntimeDir(newRoot);
  const [hasSource, hasDestination] = await Promise.all([exists(source), exists(destination)]);
  if (hasSource && hasDestination) {
    throw new Error(`cannot repair the moved folder: daemon runtime exists at both ${source} and ${destination}`);
  }
  if (hasSource) {
    await fs.rename(source, destination);
    await step("runtime-renamed");
  }
  // A retry may observe only the destination after a crash immediately after
  // rename. Repeating the parent-directory barrier closes that durability gap.
  if (hasSource || hasDestination) {
    await fsyncDirectory(path.dirname(destination));
    await step("runtime-parent-synced");
  }
  if (await exists(desiredStatePath(newRoot))) {
    await mutateDesiredRecord(newRoot, (current) => {
      if (current === undefined) return undefined;
      if (current.workspaceId !== workspaceId) {
        throw new Error(`daemon state at ${destination} belongs to a different workspace`);
      }
      const recorded = path.resolve(current.rootPath);
      if (recorded !== oldRoot && recorded !== newRoot) {
        throw new Error(`daemon state at ${destination} names unexpected root ${recorded}`);
      }
      return { ...current, rootPath: newRoot };
    });
    await step("desired-rebased");
  }
}

function assertRegistryPreflight(
  entries: Awaited<ReturnType<typeof readPersistedEntries>>,
  oldRoot: string,
  newRoot: string,
  workspaceId: string,
): void {
  for (const root of [oldRoot, newRoot]) {
    const row = entries.find((entry) => entry.root === root);
    if (row !== undefined && row.workspaceId !== workspaceId) {
      throw new Error(`workspace registry ${root} belongs to a different workspace`);
    }
  }
}

/** Repair only a move proven by the full workspace/device binding identity. */
export async function repairFolderMove(newRootInput: string, deps: FolderRepairDeps = {}): Promise<void> {
  const newRoot = path.resolve(newRootInput);
  const state = await ensureFolderAuthority({ currentRoot: newRoot });
  const inventory = await listFolderInventory(state, { currentRoot: newRoot });
  const target = inventory.rows.find((row) => row.root === newRoot);
  if (target?.catalog === undefined) {
    throw new Error(`cannot repair ${newRoot}: the path is not listed in rbox configuration`);
  }
  const config = await loadConfig(newRoot);
  if (!config.remoteWorkspaceId || !config.deviceId || !path.isAbsolute(config.rootPath)) {
    throw new Error(`cannot repair ${newRoot}: its workspace binding has no usable workspace, device, and old-root identity`);
  }
  const oldRoot = path.resolve(config.rootPath);
  const duplicate = inventory.rows.find((row) =>
    row.root !== newRoot
    && row.binding !== undefined
    && !("unreadable" in row.binding)
    && `${row.binding.workspaceId}\0${row.binding.deviceId}` === identity(config));
  if (duplicate !== undefined) {
    throw new Error(`cannot repair ${newRoot}: the same workspace and device binding still exists at ${duplicate.root}`);
  }
  if (oldRoot === newRoot) {
    // rootPath is the last logical write, but a crash may have interrupted the
    // following directory barrier. Repeating it makes the idempotent success
    // path durable as well as logically complete.
    await fsyncDirectory(path.join(newRoot, ".rbox"));
    (deps.write ?? console.log)(`${style.sym.ok} ${newRoot} is already repaired`);
    return;
  }
  if (await exists(oldRoot)) {
    throw new Error(`cannot repair ${newRoot}: the old path still exists at ${oldRoot}; refusing to guess whether this is a copy`);
  }
  assertRegistryPreflight(await readPersistedEntries(), oldRoot, newRoot, config.remoteWorkspaceId);
  const [oldRuntime, newRuntime] = await Promise.all([
    exists(daemonRuntimeDir(oldRoot)),
    exists(daemonRuntimeDir(newRoot)),
  ]);
  if (oldRuntime && newRuntime) {
    throw new Error("cannot repair the moved folder while both old and new daemon runtime directories exist");
  }

  const step = async (value: FolderRepairStep): Promise<void> => deps.onStep?.(value);
  // Stops live between the two locks: inside the scope lock so a racing
  // `rbox start` (which takes it) cannot slip a daemon in behind them, but
  // BEFORE the sync mutex — a live daemon owns that mutex, so acquiring it
  // first would deadlock repair against the very process it must stop.
  await withScopeTransitionLock(newRoot, async () => {
    await stopIfRunning(oldRoot);
    await stopIfRunning(newRoot);
    await step("daemons-stopped");
    return withWorkspaceSyncMutex(newRoot, async () => {
    await relocateRuntime(oldRoot, newRoot, config.remoteWorkspaceId, step);
    await relocateBinding(oldRoot, newRoot, config.remoteWorkspaceId);
    await step("registry-relocated");

    // rootPath is the transaction's commit marker and therefore publishes last.
    // Re-read under the locks so a concurrent binding edit cannot be overwritten.
    const current = await loadConfig(newRoot);
    if (identity(current) !== identity(config)) throw new Error("the folder binding changed during repair");
    const recorded = path.resolve(current.rootPath);
    if (recorded !== oldRoot && recorded !== newRoot) throw new Error(`the folder binding now names unexpected root ${recorded}`);
    if (recorded !== newRoot) {
      await saveConfig(newRoot, { ...current, rootPath: newRoot });
      await step("binding-written");
      await fsyncDirectory(path.join(newRoot, ".rbox"));
      await step("binding-parent-synced");
    }
    });
  });

  (deps.write ?? console.log)(`${style.sym.ok} repaired moved folder ${oldRoot} → ${newRoot}`);
}
