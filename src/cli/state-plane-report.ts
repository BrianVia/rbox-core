/** Rendering for fresh SQLite genesis admission failures.
 *
 * Never: mutation, filesystem access, or migration outcomes.
 */
import {
  GENESIS_ADMISSION_REFUSAL_COPY,
  type OperatorCopy,
  type OperatorFinding,
} from "./state-plane-copy.js";
import type { GenesisAdmissionRefusal } from "./state-plane/authority-bootstrap.js";

export interface OperatorReport {
  readonly ok: boolean;
  readonly outcome: string;
  readonly finding: OperatorFinding;
  readonly facts: readonly string[];
}

const finding = (copy: OperatorCopy): OperatorFinding => {
  const result: OperatorFinding = {
    id: copy.machine.id,
    severity: copy.machine.severity,
    problem: copy.human.problem,
    safety: copy.human.safety,
  };
  if (copy.human.command !== undefined) result.command = copy.human.command;
  return result;
};

export function describeGenesisAdmissionRefusal(
  refusal: GenesisAdmissionRefusal,
): OperatorReport {
  const copy = GENESIS_ADMISSION_REFUSAL_COPY[refusal.reason];
  return {
    ok: false,
    outcome: `refused:${refusal.reason}`,
    finding: finding(copy),
    facts: [],
  };
}

export function renderOperatorReport(report: OperatorReport): string[] {
  const lines = [report.finding.problem, ...report.facts, report.finding.safety];
  if (report.finding.command) lines.push(`Next: ${report.finding.command}`);
  return lines;
}
