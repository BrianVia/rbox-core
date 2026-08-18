/**
 * State-plane doctor policy.
 *
 * The checks that speak for the local state plane live here rather than in
 * `doctor-cmd.ts`, so the orchestrator stays orchestration. Three of them:
 *
 *   1. `state` — the live sync records, in EITHER format (163 §C4).
 *   2. `upgrade reserve` — the reserved 1 MiB of runway.
 *   3. `genesis` — fresh SQLite setup that did not finish.
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
import { statePath } from "./state-plane/paths.js";
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
 * Report an unfinished fresh-workspace SQLite setup without opening SQLite.
 */
export function checkStateGenesis(root: string): DoctorCheck {
  if (read(() => readGenesisIntent(root))) {
    return {
      ok: false,
      label: "genesis",
      status: "state-genesis/unfinished",
      message: "setting up this workspace's sync records didn't finish",
      hint: "rbox sync",
      finding: {
        id: "state-genesis/unfinished",
        severity: "attention",
        problem: "rbox was setting up this workspace's sync records and didn't finish.",
        safety: "No files were changed. rbox will pick the setup back up where it left off.",
        command: "rbox sync",
      },
    };
  }
  return { ok: true, label: "genesis", message: "no setup in progress" };
}

/** A record that cannot be read is reported by the `state` check above and by
 * the state check above; a doctor that crashed on it would report neither. */
function read<T>(reader: () => T | undefined): T | undefined {
  try {
    return reader();
  } catch {
    return undefined;
  }
}
