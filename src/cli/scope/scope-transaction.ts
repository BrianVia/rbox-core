/**
 * Scope edits as a journaled transaction (design 212 §3.3).
 *
 * The dangerous part of changing a scope is not the change — it is being
 * interrupted halfway through one. So the intent is written down BEFORE anything
 * moves, the daemon is parked and acknowledged (never fire-and-forget), the scope
 * generation is bumped so every cached or watcher-fed observation made under the
 * old scope is fenced, and only then does disk change. A crash at any point resumes
 * from the intent; the accepted scope is committed atomically at the end.
 *
 * Materialization is deliberately NOT in the transaction: the accepted scope is
 * durable before any fetch, so an ordinary pull converges the new folders. Only
 * pruning has to be transactional, because it destroys local bytes.
 */
import path from "node:path";
import { openTrashBatch } from "../../engine/trash.js";
import { saveStateSource } from "../sync-state.js";
import { loadState } from "../sync-state-store.js";
import { syncStreamId } from "../workspace-config.js";
import { withWorkspaceSyncMutex } from "../sync-mutex.js";
import { loadConfig, saveConfig, type WorkspaceConfig } from "../workspace-config.js";
import { intentPhase, newMaintenanceId, planScopeIntent, sameIntent, type ScopeIntent } from "./scope-intent.js";
import { withinPrefix } from "./scope-record.js";

export { planScopeIntent, type ScopeIntent } from "./scope-intent.js";

export class ScopeEditInFlightError extends Error {
  constructor() {
    super("another change to the folders this machine syncs is still finishing — re-run this in a moment");
    this.name = "ScopeEditInFlightError";
  }
}

export interface ScopeTransitionResult {
  accepted: string[];
  materialized: string[];
  pruned: string[];
  generation: number;
  /** The daemon was running and has been restarted under the new scope. */
  daemonRestarted: boolean;
}

export interface ScopeTransactionDeps {
  /** Stop the daemon under a durable obligation to bring it back under `id`. */
  parkDaemon?: (root: string, id: string) => Promise<void>;
  /** Close the window opened by exactly `id`; resolves to whether it restarted. */
  resumeDaemon?: (root: string, id: string) => Promise<boolean>;
  daemonRunning?: (root: string) => boolean;
  /** The id of an open maintenance window, for a daemon whose intent is gone. */
  parkedMaintenanceId?: (root: string) => Promise<string | undefined>;
  recordWitness?: (root: string, workspaceId: string, scope: readonly string[] | undefined) => Promise<void>;
  newMaintenanceId?: () => string;
  now?: () => Date;
  log?: (line: string) => void;
}

async function defaultDeps(deps: ScopeTransactionDeps): Promise<Required<Omit<ScopeTransactionDeps, "log">> & { log: (line: string) => void }> {
  const autostart = await import("../autostart-cmd.js");
  const control = await import("../daemon-control.js");
  const registry = await import("../binding-registry.js");
  return {
    parkDaemon: deps.parkDaemon ?? ((root, id) => autostart.parkDaemonForMaintenance(root, id)),
    resumeDaemon: deps.resumeDaemon ?? ((root, id) => autostart.resumeDaemonAfterMaintenance(root, id)),
    daemonRunning: deps.daemonRunning ?? ((root) => control.readDaemonPidRecord(root).pid !== undefined),
    parkedMaintenanceId: deps.parkedMaintenanceId ?? (async (root) => (await autostart.readDaemonMaintenance(root))?.id),
    recordWitness: deps.recordWitness ?? registry.recordBindingScope,
    newMaintenanceId: deps.newMaintenanceId ?? newMaintenanceId,
    now: deps.now ?? (() => new Date()),
    log: deps.log ?? ((line) => console.log(line)),
  };
}

/** Rewrite the journaled intent in place, leaving everything else in the config as
 *  the caller last left it. */
async function journal(abs: string, intent: ScopeIntent): Promise<void> {
  await saveConfig(abs, { ...(await loadConfig(abs)), scopeIntent: intent });
}

/**
 * Run (or resume) one scope transition to completion. `target` is the fully
 * validated, normalized, accepted-set-to-be; passing the intent's own target is how
 * a resume re-enters.
 */
export async function runScopeTransition(
  root: string,
  target: readonly string[],
  deps: ScopeTransactionDeps = {},
): Promise<ScopeTransitionResult> {
  const wired = await defaultDeps(deps);
  const abs = path.resolve(root);
  const cfg = await loadConfig(abs);
  const accepted = cfg.scope ?? [];
  const journaled = cfg.scopeIntent?.target.join("\n") === target.join("\n") ? cfg.scopeIntent : undefined;
  // Someone else's unfinished edit. Planning over it would delete the only record
  // that says how to finish it.
  if (journaled === undefined && cfg.scopeIntent !== undefined) throw new ScopeEditInFlightError();
  let intent = journaled ?? planScopeIntent(accepted, target, (cfg.scopeGeneration ?? 0) + 1, wired.now().toISOString());
  const phase = intentPhase(intent, cfg.scope, cfg.scopeGeneration);
  // A recovered pre-`phase` intent carries no maintenance token, so nothing on disk
  // distinguishes "the interrupted edit parked the daemon" from "the user stopped
  // it". Guessing either way is wrong; §6 tells the user instead.
  const legacy = journaled !== undefined && journaled.phase === undefined && journaled.maintenanceId === undefined;

  // 1. Durable intent, before anything moves.
  if (journaled === undefined) await saveConfig(abs, { ...cfg, scopeIntent: intent });

  // 2. Park the daemon and WAIT for it: a watcher event queued under the old scope
  //    must not be applied against the new one. The obligation to bring it back is
  //    journaled BEFORE the daemon is touched and the park itself is durable, so a
  //    crash inside this window cannot leave background sync silently switched off:
  //    the liveness sample is never the only thing that remembers the restart.
  if (phase !== "committed" && wired.daemonRunning(abs)) {
    const id = intent.maintenanceId ?? wired.newMaintenanceId();
    if (intent.maintenanceId === undefined) {
      intent = { ...intent, maintenanceId: id };
      await journal(abs, intent);
    }
    await wired.parkDaemon(abs, id);
  }

  await withWorkspaceSyncMutex(abs, async () => {
    const current = await loadConfig(abs);
    if (phase !== "committed") {
      // 3. Prune first, under the mutex. Removed folders go to the trash, never
      //    straight to rm — a mistyped prefix must be undoable.
      if (intent.prune.length > 0) await pruneScopedSubtrees(abs, current, intent.prune, "trash");
      // Folders being TAKEN ON must forget what this machine last saw of them. A base
      // that still describes them, with nothing on disk, reconciles to "deleted here"
      // and would leave the newly added folder permanently empty.
      if (intent.materialize.length > 0) await pruneScopedSubtrees(abs, current, intent.materialize, "forget");
    }
    // 4. Commit the accepted scope, the generation, and the intent's new phase in ONE
    //    write. The generation fences every observation cached under the old scope;
    //    the phase stops a resume from re-trashing folders already pruned.
    intent = { ...intent, phase: "committed" };
    const committed: WorkspaceConfig = { ...current, scopeGeneration: intent.generation, scope: [...intent.target] };
    await saveConfig(abs, { ...committed, scopeIntent: intent });
    // 5. The redundant witness. Clearing the intent here would strand a witness-write
    //    failure as a permanent disagreement with nothing left on disk saying how to
    //    finish.
    await wired.recordWitness(abs, current.remoteWorkspaceId, intent.target);
  });

  // 6. Only an ATTEMPTED restart retires the intent: while a daemon is parked, the
  //    intent is the one record that owes it a return. A resume that throws leaves
  //    both records standing for the next command to finish.
  const daemonRestarted = intent.maintenanceId === undefined
    ? false
    : await wired.resumeDaemon(abs, intent.maintenanceId);
  if (legacy && !daemonRestarted && !wired.daemonRunning(abs)) {
    wired.log("background sync is off here — an interrupted change to your synced folders could not tell whether you turned it off on purpose. Turn it back on with: rbox start");
  }
  await withWorkspaceSyncMutex(abs, async () => {
    const settled: WorkspaceConfig = { ...(await loadConfig(abs)) };
    // Only ever retire OUR cursor: a concurrent edit may have journaled its own.
    if (!sameIntent(settled.scopeIntent, intent)) return;
    delete settled.scopeIntent;
    await saveConfig(abs, settled);
  });

  return {
    accepted: [...intent.target],
    materialized: [...intent.materialize],
    pruned: [...intent.prune],
    generation: intent.generation,
    daemonRestarted,
  };
}

/**
 * Move every file under `prefixes` to the local trash AND drop those entries from
 * the reconcile base. Dropping the base is what makes a later re-add materialize:
 * a base that still claims the files would read the empty disk as a local deletion
 * and quietly leave the re-added folder empty.
 */
async function pruneScopedSubtrees(
  root: string,
  cfg: WorkspaceConfig,
  prefixes: readonly string[],
  disk: "trash" | "forget",
): Promise<void> {
  const state = await loadState(root, syncStreamId(cfg));
  const inside = (rel: string) => prefixes.some((prefix) => withinPrefix(prefix, rel));
  if (disk === "trash") {
    const batch = openTrashBatch(root);
    try {
      for (const prefix of prefixes) await batch.put(prefix);
    } finally {
      await batch.finish();
    }
  }
  const retained = state.lastSyncedManifest.files.filter((entry) => !inside(entry.path));
  if (retained.length === state.lastSyncedManifest.files.length) return;
  await saveStateSource(root, state, {
    expectedStream: syncStreamId(cfg),
    sourceGlobalSeq: state.lastSyncedSequence,
    globalManifest: { ...state.lastSyncedManifest, files: retained },
    observedRepos: [],
    values: {},
  });
}

/**
 * Finish whatever an interrupted scope edit left behind: the journaled intent if
 * there is one, otherwise a daemon still parked under a window whose intent was
 * discarded — a `track --include` rollback, or a crash inside one. An open window
 * with no intent can only mean a stranded daemon: the intent is always durable
 * before the park, and settling always attempts the resume.
 */
export async function resumeScopeIntent(root: string, deps: ScopeTransactionDeps = {}): Promise<ScopeTransitionResult | undefined> {
  const abs = path.resolve(root);
  const cfg = await loadConfig(abs).catch(() => undefined);
  if (cfg?.scopeIntent) return runScopeTransition(root, cfg.scopeIntent.target, deps);
  if (cfg === undefined) return undefined;
  const wired = await defaultDeps(deps);
  const parked = await wired.parkedMaintenanceId(abs);
  if (parked !== undefined) await wired.resumeDaemon(abs, parked);
  return undefined;
}
