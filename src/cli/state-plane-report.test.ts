import { expect, test } from "bun:test";
import { GENESIS_ADMISSION_REFUSAL_COPY } from "./state-plane-copy.js";
import {
  describeGenesisAdmissionRefusal,
  renderOperatorReport,
} from "./state-plane-report.js";

test("fresh-genesis refusals share exact machine and human copy", () => {
  const expected = {
    "lock-unsupported": "state-genesis/lock-unsupported",
    "lock-indeterminate": "state-genesis/lock-indeterminate",
    "lock-identity-unavailable": "state-genesis/lock-identity-unavailable",
    "lock-io": "state-genesis/lock-io",
  } as const;

  for (const [reason, id] of Object.entries(expected)) {
    const typedReason = reason as keyof typeof expected;
    const copy = GENESIS_ADMISSION_REFUSAL_COPY[typedReason];
    const report = describeGenesisAdmissionRefusal({
      reason: typedReason,
      layer: "workspace",
    });
    expect(report).toEqual({
      ok: false,
      outcome: `refused:${reason}`,
      finding: {
        id,
        severity: "blocked",
        problem: copy.human.problem,
        safety: copy.human.safety,
      },
      facts: [],
    });
    expect(renderOperatorReport(report)).toEqual([
      copy.human.problem,
      copy.human.safety,
    ]);
  }
});
