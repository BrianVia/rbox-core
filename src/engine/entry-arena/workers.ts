/**
 * Crypto-worker registrations for one candidate owner (design 163 § "Early U0").
 *
 * A registration is pending in EVERY state before `done`; promise settlement
 * alone never decrements `pendingResults`. The apply callback receives a
 * single-use, queue-bound context and no token at all, and resource release
 * runs off the queue so a callback can never deadlock behind its own settlement.
 */
import type { FileEntry } from "../types.js";
import { GenerationReplacementConflict, WorkerLifecycleError } from "./errors.js";
import {
  controlOfOwner,
  replaceOnOwnerQueue,
  requireOwnerLive,
  settleOwnerDrain,
  type GenerationOwnerLease,
  type OwnerControl,
  type ReplaceInternedEntryResult,
  type WorkerRecord,
} from "./owner.js";
import type { EntryVersionToken, WorkerLifecycleState, WorkerResultId } from "./tokens.js";

/** Single-use and queue-bound. Revoked the instant the apply callback returns,
 *  so a saved context can never mutate the candidate or advance a token later. */
export interface WorkerApplyContext {
  replace(path: string, expected: EntryVersionToken, next: Readonly<FileEntry>): ReplaceInternedEntryResult;
}

export interface WorkerRegistration {
  readonly id: WorkerResultId;
  readonly state: WorkerLifecycleState;
  markRunning(): Promise<void>;
  /** `registered -> running -> result-returned -> applying|discarding ->
   *  resources-released -> done`. Pending in every state before `done`; promise
   *  settlement alone never decrements `pendingResults`. Requires `running`. */
  returnResult(
    apply: (context: WorkerApplyContext) => void,
    releaseResources?: () => void | Promise<void>,
  ): Promise<"applied" | "discarded">;
  /** Terminal without a result. Legal from `registered` too: a worker cancelled
   *  before it ran still has to reach `done` or teardown could never drain. */
  fail(releaseResources?: () => void | Promise<void>): Promise<"discarded">;
}

export function registerWorker(
  owner: GenerationOwnerLease,
  options: { cancel?: () => void } = {},
): Promise<WorkerRegistration> {
  const control = controlOfOwner(owner);
  return control.queue.run(() => {
    requireOwnerLive(control);
    if (control.workerIntake !== "open") throw new GenerationReplacementConflict("intake-closed");
    const record: WorkerRecord = {
      id: control.nextWorkerId++,
      state: "registered",
      discardOnReturn: false,
      cancel: options.cancel,
    };
    control.workerResults.set(record.id, record);
    control.pendingResults++;
    return makeRegistration(control, record);
  });
}

function runApply(control: OwnerControl, apply: (context: WorkerApplyContext) => void): void {
  let live = true;
  const context: WorkerApplyContext = {
    replace: (path, expected, next) => {
      if (!live) throw new WorkerLifecycleError("worker apply context is single-use and expires with its callback");
      if (!control.currentToken) throw new GenerationReplacementConflict("stale-token");
      return replaceOnOwnerQueue(control, { token: control.currentToken, path, expected, next }, true);
    },
  };
  try {
    apply(context);
  } finally {
    live = false;
  }
}

function makeRegistration(control: OwnerControl, record: WorkerRecord): WorkerRegistration {
  const settle = async (
    apply: ((context: WorkerApplyContext) => void) | undefined,
    releaseResources: (() => void | Promise<void>) | undefined,
  ): Promise<"applied" | "discarded"> => {
    const phase = await control.queue.run(() => {
      const legal =
        apply === undefined ? record.state === "registered" || record.state === "running" : record.state === "running";
      if (!legal) throw new WorkerLifecycleError(`worker ${record.id} cannot settle from state ${record.state}`);
      record.state = "result-returned";
      const discard = apply === undefined || record.discardOnReturn || control.terminalState !== "live";
      record.state = discard ? "discarding" : "applying";
      let applyError: unknown;
      if (!discard) {
        try {
          runApply(control, apply!);
        } catch (error) {
          applyError = error;
        }
      }
      return { discard, applyError };
    });

    // Release runs OFF the queue: a callback that touches the owner cannot
    // deadlock behind its own settlement, and a throw still reaches `done`.
    let releaseError: unknown;
    if (releaseResources) {
      let running: void | Promise<void> = undefined;
      control.releaseCallbackDepth++;
      try {
        running = releaseResources();
      } catch (error) {
        releaseError = error;
      } finally {
        control.releaseCallbackDepth--;
      }
      if (releaseError === undefined) {
        try {
          await running;
        } catch (error) {
          releaseError = error;
        }
      }
    }
    record.state = "resources-released";

    await control.queue.run(() => {
      record.state = "done";
      control.workerResults.delete(record.id);
      control.pendingResults--;
      settleOwnerDrain(control);
    });

    if (phase.applyError !== undefined) throw phase.applyError;
    if (releaseError !== undefined) throw releaseError;
    return phase.discard ? "discarded" : "applied";
  };

  return {
    id: record.id,
    get state(): WorkerLifecycleState {
      return record.state;
    },
    markRunning: () =>
      control.queue.run(() => {
        if (record.state !== "registered") {
          throw new WorkerLifecycleError(`worker ${record.id} cannot start from state ${record.state}`);
        }
        record.state = "running";
      }),
    returnResult: (apply, releaseResources) => settle(apply, releaseResources),
    fail: (releaseResources) => settle(undefined, releaseResources) as Promise<"discarded">,
  };
}
