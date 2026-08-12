import type { WatcherBackend } from "./watcher.js";

export type PropagationClassification = "file" | "git";

export interface PropagationTrace {
  backendArmed(backend: WatcherBackend): void;
  eventSeen(classification: PropagationClassification): void;
  debouncerArmed(classification: PropagationClassification): void;
  debouncerFired(classification: PropagationClassification): void;
  schedulerWantArmed(): void;
  operationBegin(): void;
  publishReceipt(sequence: number | undefined): void;
  wsCommittedFrame(sequence: number): void;
  pullDequeue(sequence: number | undefined, notifyLatencyMs: number): void;
  applyComplete(sequence: number): void;
}

type TraceStage = "seen" | "armed" | "fired";
type TraceTimes = Partial<Record<`${PropagationClassification}_${TraceStage}` | "want" | "begin" | "receipt", number>>;

interface Cycle {
  readonly id: number;
  readonly times: TraceTimes;
}

/** Local, path-free propagation timing. Disabled creation is the entire hot-path gate. */
export function createPropagationTrace(log: (line: string) => void): PropagationTrace | undefined {
  if (process.env.RBOX_TRACE_PROPAGATION !== "1") return undefined;

  let backend: WatcherBackend | undefined;
  let nextId = 0;
  let pending: Cycle | undefined;
  let waiting: Cycle | undefined;
  let active: Cycle | undefined;
  const now = () => performance.now();
  const newCycle = (): Cycle => ({ id: ++nextId, times: {} });
  const inputCycle = (): Cycle => waiting ?? (pending ??= newCycle());
  const note = (classification: PropagationClassification, stage: TraceStage) => {
    const times = inputCycle().times;
    times[`${classification}_${stage}`] ??= now();
  };

  return {
    backendArmed(value) { backend = value; },
    eventSeen(classification) {
      // A write arriving before this cycle reaches the scheduler supersedes the
      // older pending origin; once waiting, further writes coalesce into it.
      if (!waiting) pending = newCycle();
      note(classification, "seen");
    },
    debouncerArmed(classification) { note(classification, "armed"); },
    debouncerFired(classification) { note(classification, "fired"); },
    schedulerWantArmed() {
      waiting ??= pending ?? newCycle();
      pending = undefined;
      waiting.times.want ??= now();
    },
    operationBegin() {
      active = waiting ?? pending ?? newCycle();
      waiting = undefined;
      pending = undefined;
      active.times.begin ??= now();
    },
    publishReceipt(sequence) {
      const cycle = active ?? waiting ?? pending ?? newCycle();
      active = undefined;
      if (waiting === cycle) waiting = undefined;
      if (pending === cycle) pending = undefined;
      cycle.times.receipt = now();
      const origin = Math.min(...Object.values(cycle.times));
      const ms = Object.fromEntries(Object.entries(cycle.times).map(([key, value]) => [key, Math.round((value - origin) * 10) / 10]));
      log(`propagation_trace ${JSON.stringify({ v: 1, cycle: cycle.id, backend, ms, sequence })}`);
    },
    wsCommittedFrame(sequence) {
      log(`propagation_receive ${JSON.stringify({ v: 1, event: "ws_committed", sequence })}`);
    },
    pullDequeue(sequence, notifyLatencyMs) {
      log(`propagation_receive ${JSON.stringify({ v: 1, event: "pull_dequeue", sequence, notify_latency_ms: notifyLatencyMs })}`);
    },
    applyComplete(sequence) {
      log(`propagation_receive ${JSON.stringify({ v: 1, event: "apply_complete", adopted_sequence: sequence })}`);
    },
  };
}
