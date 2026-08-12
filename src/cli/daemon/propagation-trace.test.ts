import { expect, test } from "bun:test";
import { createPropagationTrace } from "./propagation-trace.js";

test("a new write replaces an unclaimed pending propagation cycle", () => {
  const previous = process.env.RBOX_TRACE_PROPAGATION;
  process.env.RBOX_TRACE_PROPAGATION = "1";
  try {
    const lines: string[] = [];
    const trace = createPropagationTrace((line) => lines.push(line))!;
    trace.eventSeen("file");
    trace.debouncerArmed("file");
    trace.eventSeen("git");
    trace.debouncerArmed("git");
    trace.schedulerWantArmed();
    trace.operationBegin();
    trace.publishReceipt(7);

    const record = JSON.parse(lines[0]!.slice("propagation_trace ".length)) as {
      cycle: number;
      ms: Record<string, number>;
    };
    expect(record.cycle).toBe(2);
    expect(record.ms.git_seen).toBeDefined();
    expect(record.ms.file_seen).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.RBOX_TRACE_PROPAGATION;
    else process.env.RBOX_TRACE_PROPAGATION = previous;
  }
});

test("apply completion preserves the bare record and optionally carries phase milliseconds", () => {
  const previous = process.env.RBOX_TRACE_PROPAGATION;
  process.env.RBOX_TRACE_PROPAGATION = "1";
  try {
    const lines: string[] = [];
    const trace = createPropagationTrace((line) => lines.push(line))!;
    trace.applyComplete(7);
    trace.applyComplete(8, { validate: 1.25, reconcile: 2, "git-apply": 3.5 });

    expect(lines).toEqual([
      'propagation_receive {"v":1,"event":"apply_complete","adopted_sequence":7}',
      'propagation_receive {"v":1,"event":"apply_complete","adopted_sequence":8,"phase_ms":{"validate":1.25,"reconcile":2,"git-apply":3.5}}',
    ]);
  } finally {
    if (previous === undefined) delete process.env.RBOX_TRACE_PROPAGATION;
    else process.env.RBOX_TRACE_PROPAGATION = previous;
  }
});
