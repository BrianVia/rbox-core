import {
  assertDistinctBinaryVersions,
  type RigBinaryIdentity,
  type RigBinarySelection,
} from "./binary.js";
import { finalizeReport, type ScenarioReport } from "../scenarios/types.js";

/** Pure command-policy seam: undefined means scenario setup may proceed. */
export function binaryVersionGuardError(
  selection: RigBinarySelection,
  identities: [RigBinaryIdentity, RigBinaryIdentity],
): string | undefined {
  try {
    assertDistinctBinaryVersions(selection, identities);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Pure FAIL envelope used before guest reset, secrets, or scenario assertions. */
export function binaryGuardReport(
  scenario: string,
  binaries: [RigBinaryIdentity, RigBinaryIdentity],
  detail: string,
  now = new Date().toISOString(),
): ScenarioReport {
  return {
    ...finalizeReport({
      scenario,
      startedAt: now,
      finishedAt: now,
      steps: [{ name: "dual-binary version identity", ok: false, ms: 0, detail }],
      assertions: [],
    }),
    binaries,
  };
}
