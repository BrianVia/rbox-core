/**
 * Crypto-worker registrations for one candidate owner (design 163 § "Early U0").
 *
 * This module never sees an owner control, a lease, or a mutation token. It
 * receives a narrow {@link WorkerOwnerPort} built by the coordinator, and the
 * apply callback it hands out returns a result WITHOUT a token — workers hold
 * no mutation authority, not even transitively.
 *
 * A registration is pending in EVERY state before `done`; promise settlement
 * alone never decrements `pendingResults`. Resource release runs off the queue,
 * inside the owner's release context, so a callback can neither deadlock behind
 * its own settlement nor silently start a cyclic terminal operation.
 */
import type { FileEntry } from "../types.js";
import { WorkerLifecycleError } from "./errors.js";
import type { EntryVersionToken, WorkerLifecycleState, WorkerReplacementResult, WorkerResultId } from "./tokens.js";

export interface WorkerRecord {
  readonly id: WorkerResultId;
  state: WorkerLifecycleState;
  discardOnReturn: boolean;
  readonly cancel?: () => void;
}

export interface WorkerOwnerPort {
  runOnQueue<T>(task: () => T | Promise<T>): Promise<T>;
  isLive(): boolean;
  /** Already on the queue; applies the coordinator's current token internally. */
  replace(path: string, expected: EntryVersionToken, next: Readonly<FileEntry>): WorkerReplacementResult;
  /** On-queue transition to `done`: deregister, decrement, settle any drain. */
  finishWorker(record: WorkerRecord): void;
  /** Runs a release callback inside the owner's release context. */
  runRelease<T>(run: () => T): T;
}

/** Single-use and queue-bound. Revoked the instant the apply callback returns,
 *  and it never exposes a token. */
export interface WorkerApplyContext {
  replace(path: string, expected: EntryVersionToken, next: Readonly<FileEntry>): WorkerReplacementResult;
}

export interface WorkerRegistration {
  readonly id: WorkerResultId;
  readonly state: WorkerLifecycleState;
  markRunning(): Promise<void>;
  /** `registered -> running -> result-returned -> applying|discarding ->
   *  resources-released -> done`. Requires `running`. */
  returnResult(
    apply: (context: WorkerApplyContext) => void,
    releaseResources?: () => void | Promise<void>,
  ): Promise<"applied" | "discarded">;
  /** Terminal without a result. Legal from `registered` too: a worker cancelled
   *  before it ran still has to reach `done` or teardown could never drain. */
  fail(releaseResources?: () => void | Promise<void>): Promise<"discarded">;
}

function runApply(port: WorkerOwnerPort, apply: (context: WorkerApplyContext) => void): void {
  let live = true;
  const context: WorkerApplyContext = {
    replace: (path, expected, next) => {
      if (!live) throw new WorkerLifecycleError("worker apply context is single-use and expires with its callback");
      return port.replace(path, expected, next);
    },
  };
  try {
    apply(context);
  } finally {
    live = false;
  }
}

export function createRegistration(port: WorkerOwnerPort, record: WorkerRecord): WorkerRegistration {
  const settle = async (
    apply: ((context: WorkerApplyContext) => void) | undefined,
    releaseResources: (() => void | Promise<void>) | undefined,
  ): Promise<"applied" | "discarded"> => {
    const phase = await port.runOnQueue(() => {
      const legal =
        apply === undefined ? record.state === "registered" || record.state === "running" : record.state === "running";
      if (!legal) throw new WorkerLifecycleError(`worker ${record.id} cannot settle from state ${record.state}`);
      record.state = "result-returned";
      const discard = apply === undefined || record.discardOnReturn || !port.isLive();
      record.state = discard ? "discarding" : "applying";
      let applyError: unknown;
      if (!discard) {
        try {
          runApply(port, apply!);
        } catch (error) {
          applyError = error;
        }
      }
      return { discard, applyError };
    });

    let releaseError: unknown;
    if (releaseResources) {
      let running: void | Promise<void> = undefined;
      try {
        running = port.runRelease(() => releaseResources());
      } catch (error) {
        releaseError = error;
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

    await port.runOnQueue(() => {
      record.state = "done";
      port.finishWorker(record);
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
      port.runOnQueue(() => {
        if (record.state !== "registered") {
          throw new WorkerLifecycleError(`worker ${record.id} cannot start from state ${record.state}`);
        }
        record.state = "running";
      }),
    returnResult: (apply, releaseResources) => settle(apply, releaseResources),
    fail: (releaseResources) => settle(undefined, releaseResources) as Promise<"discarded">,
  };
}
