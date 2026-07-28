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
import path from "node:path";
import { loadConfig, loadRawState, saveConfig, syncStreamId, type WorkspaceConfig } from "./config.js";
import { style } from "./style.js";
import { withWorkspaceSyncMutex } from "./sync-mutex.js";
import { enrolledDeviceId } from "./e2ee-keystore.js";
import { resolveWorkspaceDeviceId } from "./init-plan.js";
import { RebindConsentRequiredError } from "./reset-consent.js";
import { assertNoPendingGenesis } from "./e2ee-client.js";
import { recordBindingScope, rememberBinding } from "./binding-registry.js";
import { flagValues } from "./flags.js";
import { saveStateSource } from "./sync-state.js";
import { loadState } from "./sync-state-store.js";
import { resolveBindingScope, type BindingScope } from "./scope/binding-scope.js";
import { withScopeTransitionLock } from "./scope/scope-lock.js";
import type { ScopeTransactionDeps } from "./scope/scope-transaction.js";

export interface TrackResult {
  cfg: WorkspaceConfig;
  root: string;
}

export interface TrackDeps {
  loadCredentials?: (typeof import("./credentials.js"))["loadCredentials"];
  isInteractive?: (typeof import("./prompt.js"))["isInteractive"];
  promptSelect?: (typeof import("./prompt.js"))["promptSelect"];
  promptWorkspacePick?: (typeof import("./workspace-picker.js"))["promptWorkspacePick"];
  createRemoteWorkspace?: (typeof import("./remote.js"))["createRemoteWorkspace"];
  scopeDeps?: ScopeTransactionDeps;
}

function sameScope(seal: BindingScope, scope: readonly string[] | undefined): boolean {
  if (!scope?.length) return seal.kind === "unscoped";
  return seal.kind === "scoped" && seal.prefixes.join("\n") === scope.join("\n");
}

async function restoreTrackScope(
  root: string,
  baseline: WorkspaceConfig,
  baselineState: Awaited<ReturnType<typeof loadRawState>>,
  lockWaitMs?: number,
): Promise<void> {
  // Restoring the baseline deletes whatever intent is journaled. Only the scope
  // transition lock's holder is allowed to do that.
  await withScopeTransitionLock(root, () => withWorkspaceSyncMutex(root, async () => {
    if (baselineState) {
      const current = await loadState(root, syncStreamId(baseline));
      await saveStateSource(root, current, {
        expectedStream: syncStreamId(baseline),
        sourceGlobalSeq: baselineState.lastSyncedSequence,
        globalManifest: baselineState.lastSyncedManifest,
        observedRepos: [],
        values: {},
      });
    }
    // A temporary disagreement halts safely. Publishing an unscoped config before
    // clearing its witness would instead create a window that looks read-write.
    await recordBindingScope(root, baseline.remoteWorkspaceId, baseline.scope);
    await saveConfig(root, baseline);
  }), lockWaitMs);
  const restored = await resolveBindingScope(root);
  if (!sameScope(restored, baseline.scope)) {
    throw new Error("scope rollback did not restore the binding's previous include state");
  }
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
  defaultRemote: string,
  deps: TrackDeps = {}
): Promise<TrackResult> {
  const root = path.resolve(pathArg ?? process.cwd());
  const includes = flagValues(flags, "include");
  if (includes.length > 0 && flags.workspace === undefined) {
    throw new Error("--include chooses folders of an existing workspace — use it with --workspace <id>");
  }
  const remoteUrl = flags.remote ?? defaultRemote;
  const projectId = flags.project ?? "root";
  const { credentialsForStrictFlow, loadCredentials } = await import("./credentials.js");
  const creds = credentialsForStrictFlow(await (deps.loadCredentials ?? loadCredentials)());
  if (creds?.accountId) await assertNoPendingGenesis(creds.accountId);
  const initialPrev = await loadConfig(root).catch(() => undefined);
  const initialState = await loadRawState(root);
  const initialStream = initialState?.stream ?? (initialPrev ? syncStreamId(initialPrev) : undefined);

  // New workspace → create it server-side (ownership at creation, M7). Joining an
  // existing one (--workspace) requires the caller's account to own it; that's
  // enforced on first sync, so binding stays offline here.
  let workspaceId = flags.workspace;
  let pickedName: string | undefined; // picker-supplied label, cached locally for `rbox status`
  if (!workspaceId) {
    // On a TTY (and not explicitly --no-interactive), ASK before creating: a bare
    // `rbox track <dir>` used to silently create a brand-new workspace even when you
    // meant to attach an existing one. Now it offers create-or-pick-by-name.
    const { isInteractive } = await import("./prompt.js");
    if ((deps.isInteractive ?? isInteractive)() && flags["no-interactive"] !== "true") {
      const { promptSelect } = await import("./prompt.js");
      const { promptWorkspacePick } = await import("./workspace-picker.js");
      const choice = await (deps.promptSelect ?? promptSelect)<"new" | "existing">({
        message: "Track a new workspace, or an existing one?",
        choices: [
          { name: "Create a new workspace", value: "new" },
          { name: "Track an existing workspace", value: "existing", description: "pick one you've already synced" },
        ],
      });
      if (choice === "existing") {
        // Picker degrades to a manual id prompt offline / no-creds / empty account;
        // backing out (blank) falls through to the create-new path below.
        const picked = await (deps.promptWorkspacePick ?? promptWorkspacePick)({ baseUrl: creds?.remoteUrl ?? remoteUrl, token: creds?.token, mode: "legacy" });
        if (picked) {
          workspaceId = picked.workspaceId;
          pickedName = picked.name;
        }
      }
    }

    if (!workspaceId) {
      if (initialStream) throw new RebindConsentRequiredError(root);
      // Create-new — also the non-interactive default. Needs a login.
      const { createRemoteWorkspace } = await import("./remote.js");
      if (!creds) throw new Error("run `rbox login` before creating a workspace");
      workspaceId = await (deps.createRemoteWorkspace ?? createRemoteWorkspace)(remoteUrl, creds.token, projectId, flags.name);
    }
  }

  const selectedStream = syncStreamId({ remoteUrl, remoteWorkspaceId: workspaceId, projectId });
  if (initialStream && initialStream !== selectedStream) {
    throw new RebindConsentRequiredError(root);
  }

  // REBIND (design 44 §2): if this root was already bound to a DIFFERENT workspace,
  // its sync baseline describes the OLD stream — reset it or the next reconcile reads
  // every old file as remotely deleted (the loadState ownership stamp also guards
  // this, but a LEGACY unstamped baseline would be adopted by the new binding, so
  // track must reset explicitly). A re-track of the SAME workspace keeps both the
  // baseline and the existing device id (re-tracking must not mint a new device).
  const nextStream = syncStreamId({ remoteUrl, remoteWorkspaceId: workspaceId, projectId });
  // This write carries the scope cursor forward — including the journaled intent it
  // deliberately preserves — so it is a scope-cursor writer like any other.
  const cfg = await withScopeTransitionLock(root, () => withWorkspaceSyncMutex(root, async (syncMutex): Promise<WorkspaceConfig> => {
    const prev = await loadConfig(root).catch(() => undefined);
    const currentState = await loadRawState(root);
    const currentStream = currentState?.stream ?? (prev ? syncStreamId(prev) : undefined);
    if (currentStream && currentStream !== nextStream) {
      throw new RebindConsentRequiredError(root);
    }
    const next: WorkspaceConfig = {
      schema: "e2ee/v1", // full end-to-end encryption (design 12) — the only mode
      remoteWorkspaceId: workspaceId,
      projectId,
      deviceId: resolveWorkspaceDeviceId({
        forceNew: flags["new-device"] === "true",
        override: flags.device,
        prevDeviceId: prev?.deviceId,
        enrolledDeviceId: await enrolledDeviceId(creds?.accountId),
        credsDeviceId: creds?.deviceId,
      }),
      rootPath: root,
      remoteUrl,
      token: "", // token comes from `rbox login` (per-machine credential), never config
      // §28: git-sync defaults ON (git artifacts are E2EE-encrypted). No-ops on a
      // non-git root; pass --git false to opt out.
      syncGit: flags.git !== "false",
      respectGitignore: flags["respect-gitignore"] === "true",
      ...(prev?.scope ? {
        scope: [...prev.scope],
        ...(prev.scopeGeneration === undefined ? {} : { scopeGeneration: prev.scopeGeneration }),
        ...(prev.scopeIntent === undefined ? {} : { scopeIntent: prev.scopeIntent }),
      } : {}),
      // Cache a picker-supplied workspace name LOCALLY so `rbox status` shows it with
      // no round-trip (manual-id / --workspace entry has none → status falls back to id).
      ...(pickedName ? { name: pickedName } : {}),
    };
    await saveConfig(root, next);
    return next;
  }), deps.scopeDeps?.lockWaitMs);
  // Design 211: this machine's durable record of the binding, so `rbox status
  // --all` can find a tracked folder that never started background sync.
  await rememberBinding(root, {
    remoteWorkspaceId: cfg.remoteWorkspaceId,
    ...(cfg.name ? { name: cfg.name } : {}),
    ...(creds?.accountId ? { accountId: creds.accountId } : {}),
    ...(cfg.scope ? { scope: cfg.scope } : {}),
  });
  if (includes.length === 0) return { cfg, root };
  const control = await import("./daemon-control.js");
  const daemonRunning = deps.scopeDeps?.daemonRunning
    ?? ((workspaceRoot: string) => control.readDaemonPidRecord(workspaceRoot).pid !== undefined);
  const scopeDeps = { ...deps.scopeDeps, daemonRunning };
  try {
    const { scopeCmd } = await import("./scope/scope-cmd.js");
    await scopeCmd(root, "add", includes, { quiet: true }, scopeDeps);
  } catch (error) {
    try {
      await restoreTrackScope(root, cfg, initialState, deps.scopeDeps?.lockWaitMs);
      // The restore deletes the intent, so the daemon's own maintenance window is
      // the surviving cursor — and it survives a crash here too, because the next
      // `rbox include` closes any window it finds with no intent behind it.
      const { resumeScopeIntent } = await import("./scope/scope-transaction.js");
      await resumeScopeIntent(root, scopeDeps);
    } catch (rollbackError) {
      throw new Error(
        `workspace binding succeeded, but its include setup failed and rollback could not be verified: ${String(rollbackError)}`,
        { cause: error },
      );
    }
    const previous = cfg.scope?.length
      ? "the workspace remains bound with its previous included folders"
      : "the workspace was bound unscoped";
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\n${previous} — run \`rbox include add <folder>\` to finish choosing folders`, { cause: error });
  }
  return { cfg: await loadConfig(root), root };
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
