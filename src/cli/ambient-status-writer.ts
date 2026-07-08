import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../engine/fsutil.js";
import { daemonRuntimeDir, daemonStatusPath } from "./rbox-paths.js";
import type { AmbientDaemonStatusV1 } from "./ambient-status.js";

export interface SaveAmbientDaemonStatusOptions {
  beforeRename?: () => boolean | Promise<boolean>;
}

/** Best-effort write: ambient visibility must never break sync. */
export async function saveAmbientDaemonStatus(root: string, status: AmbientDaemonStatusV1, opts: SaveAmbientDaemonStatusOptions = {}): Promise<void> {
  try {
    await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
    await writeFileAtomic(daemonStatusPath(root), `${JSON.stringify(status, null, 2)}\n`, { beforeRename: opts.beforeRename });
  } catch {
    /* best-effort by contract */
  }
}

export async function removeAmbientDaemonStatus(root: string): Promise<void> {
  try {
    await fs.rm(path.join(daemonRuntimeDir(root), "daemon.status.json"), { force: true });
  } catch {
    /* best-effort by contract */
  }
}
