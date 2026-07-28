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
import { withinPrefix } from "./scope-record.js";

export interface ScopeIntent {
  generation: number;
  accepted: string[];
  target: string[];
  materialize: string[];
  prune: string[];
  at: string;
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
  stopDaemon?: (root: string) => Promise<void>;
  startDaemon?: (root: string) => Promise<void>;
  daemonRunning?: (root: string) => boolean;
  recordWitness?: (root: string, workspaceId: string, scope: readonly string[] | undefined) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

export const planScopeIntent = (accepted: readonly string[], target: readonly string[], generation: number, at: string): ScopeIntent => ({
  generation,
  accepted: [...accepted],
  target: [...target],
  materialize: target.filter((prefix) => !accepted.includes(prefix)),
  prune: accepted.filter((prefix) => !target.includes(prefix)),
  at,
});

async function defaultDeps(deps: ScopeTransactionDeps): Promise<Required<Omit<ScopeTransactionDeps, "log">> & { log: (line: string) => void }> {
  const autostart = await import("../autostart-cmd.js");
  const control = await import("../daemon-control.js");
  const registry = await import("../binding-registry.js");
  return {
    stopDaemon: deps.stopDaemon ?? ((root) => autostart.stopDaemonAndRecordDesired(root)),
    startDaemon: deps.startDaemon ?? ((root) => autostart.startDaemonAndRecordDesired(root)),
    daemonRunning: deps.daemonRunning ?? ((root) => control.readDaemonPidRecord(root).pid !== undefined),
    recordWitness: deps.recordWitness ?? registry.recordBindingScope,
    now: deps.now ?? (() => new Date()),
    log: deps.log ?? ((line) => console.log(line)),
  };
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
  const intent = cfg.scopeIntent?.target.join("\n") === target.join("\n")
    ? cfg.scopeIntent
    : planScopeIntent(accepted, target, (cfg.scopeGeneration ?? 0) + 1, wired.now().toISOString());

  // 1. Durable intent, before anything moves.
  if (cfg.scopeIntent === undefined) await saveConfig(abs, { ...cfg, scopeIntent: intent });

  // 2. Park the daemon and WAIT for it: a watcher event queued under the old scope
  //    must not be applied against the new one.
  const wasRunning = wired.daemonRunning(abs);
  if (wasRunning) await wired.stopDaemon(abs);

  await withWorkspaceSyncMutex(abs, async () => {
    const current = await loadConfig(abs);
    // 3. Prune first, under the mutex. Removed folders go to the trash, never
    //    straight to rm — a mistyped prefix must be undoable.
    if (intent.prune.length > 0) await pruneScopedSubtrees(abs, current, intent.prune, "trash");
    // Folders being TAKEN ON must forget what this machine last saw of them. A base
    // that still describes them, with nothing on disk, reconciles to "deleted here"
    // and would leave the newly added folder permanently empty.
    if (intent.materialize.length > 0) await pruneScopedSubtrees(abs, current, intent.materialize, "forget");
    // 4. Commit the accepted scope and the generation in ONE write, then clear the
    //    intent. The generation fences every observation cached under the old scope.
    const committed: WorkspaceConfig = { ...current, scopeGeneration: intent.generation, scope: [...intent.target] };
    await saveConfig(abs, { ...committed, scopeIntent: intent });
    // 5. The redundant witness, and only then the intent clear. Clearing first would
    //    strand a witness-write failure as a permanent disagreement with nothing left
    //    on disk saying how to finish.
    await wired.recordWitness(abs, current.remoteWorkspaceId, intent.target);
    const settled: WorkspaceConfig = { ...committed };
    delete settled.scopeIntent;
    await saveConfig(abs, settled);
  });

  if (wasRunning) await wired.startDaemon(abs);
  return {
    accepted: [...intent.target],
    materialized: [...intent.materialize],
    pruned: [...intent.prune],
    generation: intent.generation,
    daemonRestarted: wasRunning,
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

/** Resume an interrupted transition, if one is journaled. */
export async function resumeScopeIntent(root: string, deps: ScopeTransactionDeps = {}): Promise<ScopeTransitionResult | undefined> {
  const cfg = await loadConfig(path.resolve(root)).catch(() => undefined);
  if (!cfg?.scopeIntent) return undefined;
  return runScopeTransition(root, cfg.scopeIntent.target, deps);
}
