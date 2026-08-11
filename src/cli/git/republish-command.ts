import path from "node:path";
import type { GitSection } from "../../engine/types.js";
import { loadConfig, loadState, repoRecordsForState, syncStreamId, type SyncState } from "../config.js";
import { recordRepublishRequest } from "../sync-git/republish-requests.js";
import type { WorkspaceSyncMutex } from "../sync-mutex.js";
import { ensureFolderAuthority } from "../folder-authority.js";
import { applyFolderPolicy, observeFolderAdmission, runtimeRefusal } from "../folder-inventory.js";

export interface GitRepublishCmdDeps {
  now?: () => Date;
  loadConfig?: typeof loadConfig;
  loadState?: typeof loadState;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface GitRepublishCmdOptions {
  json?: boolean;
}

/** Same workspace-relative normalization `rbox git resolve` uses. */
function normalizedRepo(root: string, arg: string): string {
  const abs = path.resolve(arg);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) throw new Error("repository is outside this workspace");
  return rel;
}

/**
 * A pending request is only worth recording if the next push can actually
 * consume it. The planner returns early — never reaching capture — for
 * repositories under removal memory, needs-resolution, protected pending, or
 * publisher-absence dispositions, so those are refused here with the reason
 * rather than parked as an intent that never settles.
 */
function admit(state: SyncState, rel: string): { base: GitSection } | { refusal: string } {
  const record = repoRecordsForState(state)[rel];
  const base = record?.base ?? state.lastSyncedManifest.gitRepos?.[rel];
  if (!base) return { refusal: `no published Git state for ${rel} yet — there is no pack chain to restart` };
  if (record?.repoAbsent === true) return { refusal: `${rel} is currently omitted from publication — see \`rbox git deferrals\` first` };
  if (record?.removedKey !== undefined) return { refusal: `${rel} is recorded as removed — re-add it before requesting a chain restart` };
  if (record?.resolutionKey !== undefined) return { refusal: `${rel} is waiting on \`rbox git resolve\` — settle that first` };
  if (record?.pending !== undefined) return { refusal: `${rel} has protected incoming Git state waiting to apply — let it settle, or resolve it, first` };
  return { base };
}

/**
 * #526: mark one repository so its next publish restarts the Git pack chain —
 * a fresh full bundle with no `packChain`, abandoning a link lineage that
 * from-scratch receivers cannot replay. Records an intent only: no capture, no
 * upload, no repository mutation, and no prompt.
 */
export async function gitRepublishCmd(
  root: string,
  repoArg: string,
  syncMutex: WorkspaceSyncMutex,
  options: GitRepublishCmdOptions = {},
  deps: GitRepublishCmdDeps = {},
): Promise<number> {
  const write = deps.stdout ?? console.log;
  const writeError = deps.stderr ?? console.error;
  try {
    const rel = normalizedRepo(root, repoArg);
    const folderState = await ensureFolderAuthority({ currentRoot: root });
    const folderAdmission = await observeFolderAdmission(root, folderState);
    if (folderAdmission.kind !== "admitted") throw runtimeRefusal(folderAdmission);
    const cfg = applyFolderPolicy(await (deps.loadConfig ?? loadConfig)(root), folderAdmission.policy);
    if (cfg.syncGit !== true) throw new Error("Git syncing is off for this workspace, so there is no pack chain to restart");
    const stream = syncStreamId(cfg);
    const state = await (deps.loadState ?? loadState)(root, stream);
    const admission = admit(state, rel);
    if ("refusal" in admission) throw new Error(admission.refusal);
    const { base } = admission;
    const result = await recordRepublishRequest(
      root,
      stream,
      rel,
      { bundleSha: base.bundleSha, generatedAt: base.generatedAt },
      (deps.now ?? (() => new Date()))(),
      syncMutex,
    );
    if (options.json) {
      write(JSON.stringify({ schemaVersion: 1, repo: rel, status: result.status, requestedAt: result.requestedAt, pending: result.pending }));
      return 0;
    }
    write(result.status === "recorded"
      ? `${rel}: the next publish will restart this repository's Git pack chain`
      : `${rel}: a pack-chain restart is already pending (requested ${result.requestedAt})`);
    write("Run `rbox sync` to publish it now, or let the next sync cycle pick it up.");
    write("Machines stranded on this repo recover on their next pull after that publish.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) writeError(JSON.stringify({ schemaVersion: 1, error: message }));
    else writeError(`rbox: ${message}`);
    return 1;
  }
}
