import {
  type Action,
  type CaseFoldCollisionGroup,
  type PhaseReport,
} from "../engine/index.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { ensureFolderAuthority } from "./folder-authority.js";
import { applyFolderPolicy, observeFolderAdmission, runtimeRefusal } from "./folder-inventory.js";
import { beginReport } from "./metrics.js";
import { withWorkspaceSyncMutex } from "./sync-mutex.js";
import { type SyncDeps } from "./sync/deps.js";
import { pull } from "./sync/pull.js";
import { push } from "./sync/push.js";
import { sync } from "./sync/sync.js";
import type { TransferProgress } from "./transfer-progress.js";
import type { WorkspaceConfig } from "./workspace-config.js";
import {
  admitGenesisAuthority,
  requireSelected,
  type GenesisAdmissionRefusal,
} from "./state-plane/authority-bootstrap.js";

type MassDeleteConsent = "guarded" | "allow";
type SyncMassDeleteConsent = "guard-both" | "allow-push" | "allow-both";

/** The reachable foreground operations. A sync invocation owns one consent
 * policy whether it is explicitly pull-only, scoped down to pull-only, or runs
 * both phases; the impossible allow-pull/guard-push combination is absent. */
type ForegroundSyncOperation =
  | { kind: "pull"; massDelete: MassDeleteConsent }
  | { kind: "push"; massDelete: MassDeleteConsent }
  | { kind: "sync"; mode: "pull-only" | "pull-push"; massDelete: SyncMassDeleteConsent };

/** Observation/presentation seams only. CLI copy remains caller-owned; the
 * runtime merely carries an explicitly supplied guard hint into the sync core. */
interface ForegroundSyncObserver {
  onProgress?: TransferProgress;
  onGitLog?: (line: string) => void;
  onGitProgress?: (done: number, total: number) => void;
  warningSink?: (line: string) => void;
  massDeleteHint?: string;
}

interface RuntimeOutcomeBase {
  report: PhaseReport | undefined;
}

type ForegroundPullOutcome = RuntimeOutcomeBase & { kind: "pull"; actions: Action[] };
type ForegroundPushOutcome = RuntimeOutcomeBase & {
  kind: "push";
  sequence: number;
  committed: boolean;
  caseCollisions: CaseFoldCollisionGroup[];
};
type ForegroundSyncOutcome = RuntimeOutcomeBase & (
  | { kind: "sync"; mode: "pull-only"; pulled: Action[] }
  | {
      kind: "sync";
      mode: "pull-push";
      pulled: Action[];
      pushedSequence: number;
      pushCommitted: boolean;
      initialRemoteSequence: number;
      caseCollisions: CaseFoldCollisionGroup[];
    }
);
type ForegroundOperationOutcome = ForegroundPullOutcome | ForegroundPushOutcome | ForegroundSyncOutcome;

type CompletionContext = Pick<WorkspaceConfig, "noDrift">;
type ForegroundCompletion = (
  outcome: ForegroundOperationOutcome,
  context: CompletionContext,
) => void | Promise<void>;

/** Foreground workspace mutation composition.
 *
 * One runtime invocation acquires the workspace lease, admits recovery through
 * the mutex's adoption fence, constructs the authenticated report context, and
 * passes the same held lease through every nested pull/push/retry. Completion
 * presentation and advisory effects run before lease release through the
 * caller's callback; callers never receive writable state or journal authority. */
export class LocalRuntime {
  constructor(private readonly root: string) {}

  run(
    operation: Extract<ForegroundSyncOperation, { kind: "pull" }>,
    observer?: ForegroundSyncObserver,
    complete?: ForegroundCompletion,
  ): Promise<ForegroundPullOutcome>;
  run(
    operation: Extract<ForegroundSyncOperation, { kind: "push" }>,
    observer?: ForegroundSyncObserver,
    complete?: ForegroundCompletion,
  ): Promise<ForegroundPushOutcome>;
  run(
    operation: Extract<ForegroundSyncOperation, { kind: "sync" }>,
    observer?: ForegroundSyncObserver,
    complete?: ForegroundCompletion,
  ): Promise<ForegroundSyncOutcome>;
  run(
    operation: ForegroundSyncOperation,
    observer?: ForegroundSyncObserver,
    complete?: ForegroundCompletion,
  ): Promise<ForegroundOperationOutcome>;
  run(
    operation: ForegroundSyncOperation,
    observer: ForegroundSyncObserver = {},
    complete?: ForegroundCompletion,
  ): Promise<ForegroundOperationOutcome> {
    const reportKind = operation.kind === "sync" && operation.mode === "pull-only"
      ? "pull"
      : operation.kind;
    return withWorkspaceSyncMutex(this.root, async (syncMutex) => {
      const genesisAdmission = await admitGenesisAuthority(this.root, syncMutex);
      if (genesisAdmission.kind === "refused") {
        await reportRefusalOccurrence(this.root, genesisAdmission.refusal);
      }
      requireSelected(genesisAdmission);
      const { cfg: remoteCfg, deps: remoteDeps } = await buildAuthedRemote(
        this.root,
        Date.now,
        observer.warningSink,
      );
      const state = await ensureFolderAuthority({ currentRoot: this.root });
      const admission = await observeFolderAdmission(this.root, state);
      if (admission.kind !== "admitted") throw runtimeRefusal(admission);
      const cfg = applyFolderPolicy(remoteCfg, admission.policy);
      const report = beginReport(reportKind);
      const deps: SyncDeps = { ...remoteDeps, syncMutex, report };
      if (observer.onProgress) deps.onProgress = observer.onProgress;
      if (observer.onGitLog) deps.onGitLog = observer.onGitLog;
      if (observer.onGitProgress) deps.onGitProgress = observer.onGitProgress;
      if (observer.massDeleteHint) deps.massDeleteHint = observer.massDeleteHint;
      const finish = async <T extends ForegroundOperationOutcome>(outcome: T): Promise<T> => {
        await complete?.(outcome, cfg);
        return outcome;
      };

      if (operation.kind === "pull") {
        deps.allowMassDelete = operation.massDelete === "allow";
        const actions = await pull(this.root, cfg, deps);
        return finish({ kind: "pull", report, actions });
      }

      if (operation.kind === "push") {
        // Push consent must never leak into the pull used by 409 recovery.
        deps.allowMassDeletePush = operation.massDelete === "allow";
        const result = await push(this.root, cfg, deps);
        return finish({ kind: "push", report, ...result });
      }

      deps.allowMassDelete = operation.massDelete === "allow-both";
      deps.allowMassDeletePush = operation.massDelete !== "guard-both";
      if (operation.mode === "pull-only") {
        const pulled = await pull(this.root, cfg, deps);
        return finish({ kind: "sync", mode: "pull-only", report, pulled });
      }
      const result = await sync(this.root, cfg, deps);
      return finish({ kind: "sync", mode: "pull-push", report, ...result });
    });
  }
}

/** Occurrence telemetry for a genesis refusal. A refusal is exceptional, so the
 * credential, config, and control-plane HTTP transport it needs load only on
 * that branch: the settled-state admission every ordinary run takes must not
 * drag the remote client into the foreground module graph. */
async function reportRefusalOccurrence(root: string, refusal: GenesisAdmissionRefusal): Promise<void> {
  try {
    const [{ loadConfigIfPresent }, { loadCredentials }, { RboxApi }, { reportGenesisLockUnsupported }] =
      await Promise.all([
        import("./workspace-config.js"),
        import("./credentials.js"),
        import("./remote.js"),
        import("./telemetry/queue.js"),
      ]);
    const [cfg, loaded] = await Promise.all([loadConfigIfPresent(root), loadCredentials()]);
    if (!cfg || loaded.state !== "valid") return;
    await reportGenesisLockUnsupported(
      refusal,
      new RboxApi(loaded.credentials.remoteUrl, loaded.credentials.token, cfg.remoteWorkspaceId, cfg.projectId),
    );
  } catch {
    // Telemetry is optional and never replaces the admission refusal.
  }
}
