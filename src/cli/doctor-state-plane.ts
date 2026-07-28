/**
 * State-plane doctor policy.
 *
 * The checks and copy that speak for the local state plane — the `.rbox/state`
 * document today, and the migration halts design 163 §U3 adds — live here rather
 * than in `doctor-cmd.ts`, so the orchestrator stays orchestration and the
 * halt-copy contract has one home. Two things live in this file:
 *
 *   1. The current `state` and `upgrade reserve` doctor checks (moved verbatim).
 *   2. `MIGRATION_HALT_COPY`: an exhaustive `satisfies Record<MigrationHaltCode,
 *      …>` mapping of every migration halt to its plain-English AND machine copy.
 *      The `satisfies` is the merge gate — U3 cannot add a halt code (in
 *      `migration/health.ts`) without also giving it copy here, or this file
 *      stops compiling.
 *
 * `doctor-cmd.ts` wires these into its named check descriptors; nothing here
 * reaches back into orchestration or rendering.
 */
import path from "node:path";
import { loadRawState, syncStreamId, type WorkspaceConfig } from "./config.js";
import { ResetCorruptionError } from "./reset-io.js";
import { inspectStateReserve, StateFormatTooNewError } from "./state-plane/index.js";
import type { DoctorCheck } from "./doctor-cmd.js";
import type { TriageSeverity } from "./doctor-triage.js";
import type { MigrationHaltCode } from "./state-plane/migration/health.js";

export async function checkState(root: string, cfg: WorkspaceConfig): Promise<DoctorCheck> {
  const file = path.join(root, ".rbox", "state.json");
  try {
    const parsed = await loadRawState(root);
    if (!parsed) return { ok: true, label: "state", message: "no sync state yet" };
    const expected = syncStreamId(cfg);
    if (parsed.stream !== undefined && parsed.stream !== expected) {
      return { ok: false, status: "stream-mismatch", label: "state", message: ".rbox/state.json belongs to a different stream", hint: "run `rbox status` for the local re-baseline warning" };
    }
    return { ok: true, label: "state", message: "state file parses and matches this stream" };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (e instanceof StateFormatTooNewError) {
      return {
        ok: false, status: "format-too-new", label: "state",
        message: ".rbox/state.json was written by a newer version of rbox",
        hint: "run `rbox upgrade`; do not delete this file",
      };
    }
    if (e instanceof ResetCorruptionError
      && message.includes(file)
      && (message.includes("malformed JSON") || message.includes("JSON nesting exceeded"))) {
      return { ok: false, status: "malformed", label: "state", message: ".rbox/state.json is not valid JSON", hint: "inspect the file or delete it to intentionally re-baseline" };
    }
    return { ok: false, status: "unreadable", label: "state", message: "could not read .rbox/state.json" };
  }
}

/** The reserved 1 MiB of upgrade runway. Absent is normal (it is created by the
 * first state save); only a foreign occupant of the path is a finding, because
 * rbox will never adopt, shrink, or remove something it did not write. */
export async function checkStateReserve(root: string, cfg: WorkspaceConfig): Promise<DoctorCheck> {
  try {
    const outcome = await inspectStateReserve(root, syncStreamId(cfg));
    if (outcome.status === "reserve-foreign") {
      return {
        ok: false, status: "reserve-foreign", label: "upgrade reserve",
        message: `.rbox/state/reserve-1mib.bin is not rbox's own reserved space (${outcome.detail})`,
        hint: "move that file aside yourself, then run `rbox doctor` again",
      };
    }
    if (outcome.status === "unavailable") {
      return { ok: true, label: "upgrade reserve", message: outcome.detail === "absent" ? "not reserved yet" : `not reserved yet (${outcome.detail})` };
    }
    return { ok: true, label: "upgrade reserve", message: "1 MiB reserved for future upgrades" };
  } catch {
    return { ok: true, inconclusive: true, label: "upgrade reserve", message: "could not check the reserved space" };
  }
}

/**
 * Plain-English + machine copy for one migration halt (design 163 R4-ROLLOUT
 * M5): what happened, what is safe, the one next action — plus the structured
 * twin the non-interactive `--json` surface emits. Two of the four external
 * users are non-technical, so `human` is written for them; `machine` is written
 * for agents, CI, and the rig.
 */
export interface MigrationHaltCopy {
  /** What a non-technical user reads: the halt, the safety line, one command. */
  readonly human: {
    readonly problem: string;
    readonly safety: string;
    readonly command?: string;
  };
  /** The non-interactive twin: a stable id and severity mirroring the doctor
   * triage findings (see `TriageFinding` in `doctor-triage.ts`). */
  readonly machine: {
    readonly id: string;
    readonly severity: TriageSeverity;
  };
}

/**
 * Exhaustive halt-code → copy map. The `satisfies Record<MigrationHaltCode, …>`
 * is the gate the sweep asked for: the day U3 adds a code to `MigrationHaltCode`
 * without human + machine copy here, this file stops compiling. Empty today
 * because `MigrationHaltCode` is empty today; U3 fills one entry per code.
 */
export const MIGRATION_HALT_COPY = {
} satisfies Record<MigrationHaltCode, MigrationHaltCopy>;
