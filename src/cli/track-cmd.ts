/**
 * `rbox track <path>` (design 29) — BIND-ONLY: it creates/joins a workspace and
 * writes the `.rbox/` binding, then stops (NO first sync — that's `setup`, `sync`,
 * or `start`). A rename of the old `rbox link` (retiring the `link` ↔ `account
 * link` collision); the `link` alias just forwards here.
 *
 * With `--workspace` it adopts that id offline. Without one, on a TTY it now ASKS
 * (create a new workspace, or pick an existing one by name) rather than silently
 * creating — `--no-interactive` (or a non-TTY) keeps the unattended create-new path.
 */
import crypto from "node:crypto";
import path from "node:path";
import { loadConfig, resetSyncState, saveConfig, syncStreamId, type WorkspaceConfig } from "./config.js";
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
  let pickedName: string | undefined; // picker-supplied label, cached locally for `rbox status`
  if (!workspaceId) {
    const { loadCredentials } = await import("./credentials.js");
    const creds = await loadCredentials();

    // On a TTY (and not explicitly --no-interactive), ASK before creating: a bare
    // `rbox track <dir>` used to silently create a brand-new workspace even when you
    // meant to attach an existing one. Now it offers create-or-pick-by-name.
    const { isInteractive } = await import("./prompt.js");
    if (isInteractive() && flags["no-interactive"] !== "true") {
      const { promptSelect } = await import("./prompt.js");
      const { promptWorkspacePick } = await import("./workspace-picker.js");
      const choice = await promptSelect<"new" | "existing">({
        message: "Track a new workspace, or an existing one?",
        choices: [
          { name: "Create a new workspace", value: "new" },
          { name: "Track an existing workspace", value: "existing", description: "pick one you've already synced" },
        ],
      });
      if (choice === "existing") {
        // Picker degrades to a manual id prompt offline / no-creds / empty account;
        // backing out (blank) falls through to the create-new path below.
        const picked = await promptWorkspacePick({ baseUrl: creds?.remoteUrl ?? remoteUrl, token: creds?.token });
        if (picked) {
          workspaceId = picked.workspaceId;
          pickedName = picked.name;
        }
      }
    }

    if (!workspaceId) {
      // Create-new — also the non-interactive default. Needs a login.
      const { createRemoteWorkspace } = await import("./remote.js");
      if (!creds) throw new Error("run `rbox login` before creating a workspace");
      workspaceId = await createRemoteWorkspace(remoteUrl, creds.token, projectId, flags.name);
    }
  }

  // REBIND (design 44 §2): if this root was already bound to a DIFFERENT workspace,
  // its sync baseline describes the OLD stream — reset it or the next reconcile reads
  // every old file as remotely deleted (the loadState ownership stamp also guards
  // this, but a LEGACY unstamped baseline would be adopted by the new binding, so
  // track must reset explicitly). A re-track of the SAME workspace keeps both the
  // baseline and the existing device id (re-tracking must not mint a new device).
  const prev = await loadConfig(root).catch(() => undefined);
  if (prev && syncStreamId(prev) !== syncStreamId({ remoteUrl, remoteWorkspaceId: workspaceId, projectId })) {
    await resetSyncState(root);
    console.error(
      `${style.yellow("!")} this directory was bound to workspace ${prev.remoteWorkspaceId} — ` +
        `rebinding to ${workspaceId}. Local sync baseline reset; files on disk untouched.`
    );
  }
  const cfg: WorkspaceConfig = {
    schema: "e2ee/v1", // full end-to-end encryption (design 12) — the only mode
    remoteWorkspaceId: workspaceId,
    projectId,
    deviceId: flags.device ?? prev?.deviceId ?? `dev_${crypto.randomUUID().slice(0, 8)}`,
    rootPath: root,
    remoteUrl,
    token: "", // token comes from `rbox login` (per-machine credential), never config
    // §28: git-sync defaults ON (git artifacts are E2EE-encrypted). No-ops on a
    // non-git root; pass --git false to opt out.
    syncGit: flags.git !== "false",
    respectGitignore: flags["respect-gitignore"] === "true",
    // Cache a picker-supplied workspace name LOCALLY so `rbox status` shows it with
    // no round-trip (manual-id / --workspace entry has none → status falls back to id).
    ...(pickedName ? { name: pickedName } : {}),
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
