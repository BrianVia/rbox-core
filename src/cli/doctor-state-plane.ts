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
import { syncStreamId, type WorkspaceConfig } from "./config.js";
// Deliberately the JSON reader, not the selecting whole-state seam: this check
// and its triage copy speak the legacy document's vocabulary, so on `Q` it must
// keep saying "written by a newer rbox" rather than reporting the store. Design
// 163 §C4 owns making doctor authority-aware; it is not this adapter's lane.
import { loadRawLegacyJsonState } from "./state-plane/adapters/legacy-json-store.js";
import { ResetCorruptionError } from "./reset-io.js";
import { inspectStateReserve, StateFormatTooNewError } from "./state-plane/index.js";
import type { DoctorCheck } from "./doctor-cmd.js";
import type { TriageSeverity } from "./doctor-triage.js";
import type { MigrationHalt, MigrationHaltCode } from "./state-plane/migration/health.js";

export async function checkState(root: string, cfg: WorkspaceConfig): Promise<DoctorCheck> {
  const file = path.join(root, ".rbox", "state.json");
  try {
    const parsed = await loadRawLegacyJsonState(root);
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
    /**
     * The exact numbers 163:3300 requires this halt to print, rendered from the
     * durable halt record and appended after `problem`. Only the two numeric
     * facts the record carries are available here; the halts that must name a
     * PATH (`verification`'s backup, `reserved-path`'s occupant) and
     * `memory-admission`'s `RBOX_RESET_PARSE_BUDGET_BYTES` value read them from
     * the control witness and the environment, which is wave 5B's renderer.
     * Deferral recorded in design 222 §6.3.
     */
    readonly measured?: (halt: MigrationHalt) => string | undefined;
  };
  /** The non-interactive twin: a stable id and severity mirroring the doctor
   * triage findings (see `TriageFinding` in `doctor-triage.ts`). */
  readonly machine: {
    readonly id: string;
    readonly severity: TriageSeverity;
  };
}

/** 163:3300 requires the refusals to print what was measured, not just that a
 * limit was hit. Rendered from the durable record's own two numeric facts. */
const bytesMeasured = (halt: MigrationHalt): string | undefined =>
  halt.required === null && halt.available === null
    ? undefined
    : `measured ${halt.available ?? "unknown"} bytes available against ${halt.required ?? "unknown"} required`;

/**
 * Exhaustive halt-code → copy map (design 222 §6.3). The
 * `satisfies Record<MigrationHaltCode, …>` is the gate: a code added to
 * `MigrationHaltCode` without human + machine copy here stops this file
 * compiling. Never advise deleting `Q` and never advise restoring a backup.
 *
 * The commands are the ones design 222 §3.2 and §5B introduce (`rbox migrate`,
 * `rbox doctor --retry-state-migration`); neither exists yet, and no halt is
 * reachable until they do. Wave 5B owns the final copy pass and the `--json`
 * twin, and is the gate for "every command is real".
 */
export const MIGRATION_HALT_COPY = {
  "source-oversize": {
    human: {
      problem: "This workspace's state file is larger than rbox can convert.",
      safety: "Nothing changed; the workspace keeps working on the old format.",
      command: "run the conversion once on a machine with more memory, or re-adopt this workspace",
      measured: bytesMeasured,
    },
    machine: { id: "state-migration/source-oversize", severity: "blocked" },
  },
  "memory-admission": {
    human: {
      problem: "Converting this workspace needs more memory than this machine can spare.",
      safety: "Nothing changed.",
      command: "run the conversion once on a machine with more memory, or re-adopt this workspace",
      measured: bytesMeasured,
    },
    machine: { id: "state-migration/memory-admission", severity: "blocked" },
  },
  "record-oversize": {
    human: {
      problem: "One entry in this workspace's state is too large to convert.",
      safety: "Nothing changed.",
      command: "rbox doctor",
    },
    machine: { id: "state-migration/record-oversize", severity: "blocked" },
  },
  "disk-preflight": {
    human: {
      problem: "There isn't enough free disk space to convert safely.",
      safety: "Nothing changed.",
      command: "free up space, then run `rbox migrate`",
      measured: bytesMeasured,
    },
    machine: { id: "state-migration/disk-preflight", severity: "blocked" },
  },
  "filesystem-full": {
    human: {
      problem: "The disk filled up partway through. rbox stopped instead of leaving a half-converted workspace.",
      safety: "Your old state is still the one in use and is intact.",
      command: "free up space, then run `rbox doctor --retry-state-migration`",
      measured: bytesMeasured,
    },
    machine: { id: "state-migration/filesystem-full", severity: "blocked" },
  },
  "source-changed": {
    human: {
      problem: "Cleaning up after an interrupted conversion didn't finish.",
      safety: "Your current state is untouched and still in use.",
      command: "rbox doctor --retry-state-migration",
    },
    machine: { id: "state-migration/retirement-source-changed", severity: "attention" },
  },
  verification: {
    human: {
      problem: "The converted state didn't match the original exactly, so rbox refused to switch to it.",
      safety: "Your original state is untouched and still in use. A copy of it is saved.",
      command: "rbox doctor",
    },
    machine: { id: "state-migration/verification", severity: "blocked" },
  },
  "reserved-path": {
    human: {
      problem: "rbox found an unexpected file where it keeps its state and won't touch it.",
      safety: "Nothing was deleted. Your state is unaffected.",
      command: "rbox doctor",
    },
    machine: { id: "state-migration/reserved-path", severity: "blocked" },
  },
  "durability-indeterminate": {
    human: {
      problem: "rbox can't confirm the last write reached the disk, so it has paused writing to this workspace.",
      safety: "No data was lost; rbox is being cautious.",
      command: "rbox doctor --retry-state-migration",
    },
    machine: { id: "state-migration/durability-indeterminate", severity: "blocked" },
  },
  "cleanup-deferred": {
    human: {
      problem: "The conversion finished; tidying up one leftover file didn't.",
      safety: "Your workspace is fully working on the new format and syncing normally.",
      command: "rbox doctor --retry-state-migration",
    },
    machine: { id: "state-migration/cleanup-deferred", severity: "attention" },
  },
} satisfies Record<MigrationHaltCode, MigrationHaltCopy>;
