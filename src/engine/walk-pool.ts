/** Bounded work pool for the manifest walk: one dynamic queue covers both
 * directory recursion and per-file stat batches, so a single concurrency
 * bound applies to the whole traversal. Absence scopes reproduce the serial
 * walker's contract that a directory vanishing mid-walk cancels exactly its
 * own subtree without failing the scan. */
import { isAbsent } from "./fsutil.js";

export const WALK_CONCURRENCY = 16;
export const FILE_STAT_BATCH_SIZE = 16;

export interface WalkAbsenceScope {
  parent?: WalkAbsenceScope;
  cancelled: boolean;
}

interface WalkTask {
  scope?: WalkAbsenceScope;
  work(): Promise<void>;
}

/** One dynamic queue per walk. Directory tasks may add descendants without
 * awaiting them, so the single bound covers both recursion and file stats. */
export class WalkPool {
  private readonly queue: WalkTask[] = [];
  private active = 0;
  private fatal: unknown;
  private settled = false;
  private readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;

  constructor(private readonly concurrency: number) {
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  enqueue(work: () => Promise<void>, scope?: WalkAbsenceScope): void {
    if (this.fatal !== undefined || this.scopeCancelled(scope)) return;
    this.queue.push({ work, scope });
    this.pump();
  }

  abort(error: unknown): void {
    if (this.fatal !== undefined) return;
    this.fatal = error;
    this.queue.length = 0;
    this.finishIfIdle();
  }

  drain(): Promise<void> {
    this.pump();
    this.finishIfIdle();
    return this.done;
  }

  canContinue(scope?: WalkAbsenceScope): boolean {
    return this.fatal === undefined && !this.scopeCancelled(scope);
  }

  private pump(): void {
    while (this.fatal === undefined && this.active < this.concurrency) {
      const task = this.queue.shift();
      if (!task) break;
      if (this.scopeCancelled(task.scope)) continue;
      this.active += 1;
      void task.work().catch((error) => {
        if (task.scope && isAbsent(error)) this.cancelScope(task.scope);
        else this.abort(error);
      }).finally(() => {
        this.active -= 1;
        this.pump();
        this.finishIfIdle();
      });
    }
    this.finishIfIdle();
  }

  private cancelScope(scope: WalkAbsenceScope): void {
    scope.cancelled = true;
    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (this.withinScope(this.queue[index]!.scope, scope)) this.queue.splice(index, 1);
    }
  }

  private scopeCancelled(scope?: WalkAbsenceScope): boolean {
    for (let current = scope; current; current = current.parent) {
      if (current.cancelled) return true;
    }
    return false;
  }

  private withinScope(candidate: WalkAbsenceScope | undefined, owner: WalkAbsenceScope): boolean {
    for (let current = candidate; current; current = current.parent) {
      if (current === owner) return true;
    }
    return false;
  }

  private finishIfIdle(): void {
    if (this.settled || this.active !== 0 || this.queue.length !== 0) return;
    this.settled = true;
    if (this.fatal !== undefined) this.rejectDone(this.fatal);
    else this.resolveDone();
  }
}
