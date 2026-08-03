import {
  type Action,
  type CaseFoldCollisionGroup,
  type PhaseReport,
} from "../engine/index.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { beginReport } from "./metrics.js";
import { withWorkspaceSyncMutex } from "./sync-mutex.js";
import { type SyncDeps } from "./sync/deps.js";
import { pull } from "./sync/pull.js";
import { push } from "./sync/push.js";
import { sync } from "./sync/sync.js";
import type { TransferProgress } from "./transfer-progress.js";
import type { WorkspaceConfig } from "./workspace-config.js";

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
      const { cfg, deps: remoteDeps } = await buildAuthedRemote(
        this.root,
        Date.now,
        observer.warningSink,
      );
      const report = beginReport(reportKind);
      const deps: SyncDeps = {
        ...remoteDeps,
        syncMutex,
        report,
        ...(observer.onProgress ? { onProgress: observer.onProgress } : {}),
        ...(observer.onGitLog ? { onGitLog: observer.onGitLog } : {}),
        ...(observer.onGitProgress ? { onGitProgress: observer.onGitProgress } : {}),
        ...(observer.massDeleteHint ? { massDeleteHint: observer.massDeleteHint } : {}),
      };
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
