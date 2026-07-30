/**
 * State-plane doctor policy.
 *
 * The checks that speak for the local state plane live here rather than in
 * `doctor-cmd.ts`, so the orchestrator stays orchestration. Three of them:
 *
 *   1. `state` — the live sync records, in EITHER format (163 §C4).
 *   2. `upgrade reserve` — the reserved 1 MiB of runway.
 *   3. `migration` — a conversion that is suspended, interrupted, or unfinished.
 *
 * The words all three speak come from `state-plane-copy.ts`, whose exhaustive
 * `satisfies` clauses are the merge gate; `state-plane-report.ts` turns a typed
 * outcome into them. Nothing here invents copy, and nothing here mutates.
 */
import path from "node:path";
import { syncStreamId, type WorkspaceConfig } from "./config.js";
import { ResetCorruptionError } from "./reset-io.js";
import { classifyStateFormat } from "./state-plane/authority-marker.js";
// The SELECTING whole-state seam. 163 §C4 makes doctor authority-aware, and this
// is that change for the `state` check: on `Q` the legacy reader raised
// `StateFormatTooNewError`, so a healthy migrated workspace was told to upgrade a
// binary that is already current — the one thing a doctor must never do.
import { loadRawState } from "./state-plane/adapters/whole-state-compat.js";
import { readGenesisIntent } from "./state-plane/genesis-intent.js";
import { readCanonicalControl } from "./state-plane/migration/control-publication.js";
import { statePath } from "./state-plane/paths.js";
import { describeMigrationHalt, renderOperatorReport } from "./state-plane-report.js";
import {
  inspectStateReserve, StateAuthorityCorruptError, StateFormatTooNewError,
} from "./state-plane/index.js";
import type { DoctorCheck } from "./doctor-cmd.js";

export async function checkState(root: string, cfg: WorkspaceConfig): Promise<DoctorCheck> {
  const file = path.join(root, ".rbox", "state.json");
  const migrated = await classifyStateFormat(statePath(root)).catch(() => "json" as const)
    === "authority-marker";
  try {
    const parsed = await loadRawState(root);
    if (migrated) {
      return {
        ok: true, label: "state", status: "sqlite",
        message: "sync records are in rbox's current format and readable",
      };
    }
    if (!parsed) return { ok: true, label: "state", message: "no sync state yet" };
    const expected = syncStreamId(cfg);
    if (parsed.stream !== undefined && parsed.stream !== expected) {
      return { ok: false, status: "stream-mismatch", label: "state", message: ".rbox/state.json belongs to a different stream", hint: "run `rbox status` for the local re-baseline warning" };
    }
    return { ok: true, label: "state", message: "state file parses and matches this stream" };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    // Only reachable now for a marker this binary genuinely cannot read, which is
    // the sole case where "upgrade" is the honest advice.
    if (e instanceof StateFormatTooNewError) {
      return {
        ok: false, status: "format-too-new", label: "state",
        message: ".rbox/state.json was written by a newer version of rbox",
        hint: "run `rbox upgrade`; do not delete this file",
      };
    }
    // The marker says the new format; the records behind it are missing or do not
    // match. 222 §6.4: never a halt, never a retry, and never "upgrade".
    if (e instanceof StateAuthorityCorruptError) {
      return {
        ok: false, status: "authority-corrupt", label: "state",
        message: "this workspace's sync records are missing or do not match their marker",
        hint: "rbox stop, move this workspace's `.rbox` folder aside, then run `rbox adopt` here",
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
 * The `migration` check: is a conversion of this workspace's sync records
 * suspended, interrupted, or unfinished?
 *
 * READ-ONLY and file-level. It reads the canonical control record and the
 * genesis intent — both plain files — and never classifies artifacts, never
 * takes a lock, and never opens a database. 163 v13's rule is that a read-only
 * SQLite open is not zero-write, and doctor is the surface a worried user runs
 * most, so it is the last place that should deposit sidecars.
 *
 * Every message comes from `state-plane-report.ts`, so what doctor prints about
 * a halt and what `rbox migrate` printed when it hit that halt are the same
 * sentences.
 */
export function checkStateMigration(root: string): DoctorCheck {
  const control = read(() => readCanonicalControl(root));
  if (control?.halt) {
    const report = describeMigrationHalt(root, control.halt, true, control);
    return {
      ok: report.ok,
      label: "migration",
      status: report.finding.id,
      // The check LINE carries what happened plus the facts it names; the safety
      // answer and the one command belong to the triage finding, which is the
      // surface a non-developer actually reads. Duplicating them into a
      // paragraph-long check line would push the other checks off the screen.
      message: [report.finding.problem, ...report.facts].join(" "),
      ...(report.finding.command === undefined ? {} : { hint: report.finding.command }),
      finding: report.finding,
    };
  }
  if (control) {
    return {
      ok: false,
      label: "migration",
      status: "state-migration/interrupted",
      message: "converting this workspace's sync records was interrupted partway through",
      hint: "rbox migrate",
      finding: {
        id: "state-migration/interrupted",
        severity: "attention",
        problem: "rbox started converting this workspace's sync records to its current format and didn't finish.",
        safety: "Nothing was lost. The records rbox is using right now are the ones it was already using.",
        command: "rbox migrate",
      },
    };
  }
  if (read(() => readGenesisIntent(root))) {
    return {
      ok: false,
      label: "migration",
      status: "state-genesis/unfinished",
      message: "setting up this workspace's sync records didn't finish",
      hint: "rbox migrate",
      finding: {
        id: "state-genesis/unfinished",
        severity: "attention",
        problem: "rbox was setting up this workspace's sync records and didn't finish.",
        safety: "No files were changed. rbox will pick the setup back up where it left off.",
        command: "rbox migrate",
      },
    };
  }
  return { ok: true, label: "migration", message: "no conversion in progress" };
}

/** A record that cannot be read is reported by the `state` check above and by
 * the migration machine's own corruption halt; a doctor that crashed on it would
 * report neither. */
function read<T>(reader: () => T | undefined): T | undefined {
  try {
    return reader();
  } catch {
    return undefined;
  }
}
