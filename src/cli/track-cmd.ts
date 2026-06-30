/**
 * `rbox track <path>` (design 29) — a faithful, BIND-ONLY rename of the old
 * `rbox link`. It creates/joins a workspace and writes the `.rbox/` binding, then
 * stops: NO first sync (that happens via `setup`, `sync`, or `start`). The rename
 * also retires the `link` ↔ `account link` collision.
 *
 * The behavior is byte-for-byte the previous `link` case, lifted out of the
 * dispatcher so it has one tested home (and the `link` alias just forwards here).
 */
import crypto from "node:crypto";
import path from "node:path";
import { saveConfig, type WorkspaceConfig } from "./config.js";
import { style } from "./style.js";

export interface TrackResult {
  cfg: WorkspaceConfig;
  root: string;
}

/**
 * Bind `path` to a workspace and persist the per-device config. With `--workspace`
 * it adopts that id offline; without one it CREATES a workspace server-side (which
 * needs `rbox login` first). Returns the written config so callers/tests can assert
 * the binding without re-reading disk.
 */
export async function track(
  pathArg: string | undefined,
  flags: Record<string, string>,
  defaultRemote: string
): Promise<TrackResult> {
  const root = path.resolve(pathArg ?? process.cwd());
  const remoteUrl = flags.remote ?? defaultRemote;
  const projectId = flags.project ?? "root";

  // New workspace → create it server-side (ownership at creation, M7). Joining an
  // existing one (--workspace) requires the caller's account to own it; that's
  // enforced on first sync, so binding stays offline here.
  let workspaceId = flags.workspace;
  if (!workspaceId) {
    const { loadCredentials } = await import("./credentials.js");
    const { createRemoteWorkspace } = await import("./remote.js");
    const creds = await loadCredentials();
    if (!creds) throw new Error("run `rbox login` before creating a workspace");
    workspaceId = await createRemoteWorkspace(remoteUrl, creds.token, projectId);
  }

  const cfg: WorkspaceConfig = {
    schema: "e2ee/v1", // full end-to-end encryption (design 12) — the only mode
    remoteWorkspaceId: workspaceId,
    projectId,
    deviceId: flags.device ?? `dev_${crypto.randomUUID().slice(0, 8)}`,
    rootPath: root,
    remoteUrl,
    token: "", // token comes from `rbox login` (per-machine credential), never config
    // §28: git-sync defaults ON (git artifacts are E2EE-encrypted). No-ops on a
    // non-git root; pass --git false to opt out.
    syncGit: flags.git !== "false",
  };
  await saveConfig(root, cfg);
  return { cfg, root };
}

/** Print the human-facing summary for a successful `track`. */
export function printTrackResult({ cfg, root }: TrackResult): void {
  console.log(`tracking ${root}`);
  console.log(`  workspace: ${cfg.remoteWorkspaceId}`);
  console.log(`  device:    ${cfg.deviceId}`);
  console.log(`  remote:    ${cfg.remoteUrl}`);
  if (cfg.syncGit) console.log(`  git-sync:  on (default; encrypted — --git false to opt out)`);
  console.log(`\nFirst sync runs on \`rbox sync\` or \`rbox start\`. Track another machine with:`);
  console.log(`  rbox track <path> --workspace ${cfg.remoteWorkspaceId}`);
}
