/**
 * The named doctor-check contract.
 *
 * Every workspace-health probe registers as a descriptor instead of taking a
 * slot in an index-aligned `Promise.all` tuple + result object + render key
 * list. The orchestrator (`doctor-cmd.ts`) iterates descriptors, so adding a
 * check — design 163 §U3 adds ~15 migration halts — is one array entry, not four
 * coordinated edits a reorder could silently corrupt. `renderHuman` emits the
 * workspace-health lines; `renderMachine` shapes the check's entry in the
 * `--report` diagnostics bundle.
 */
import { style } from "./style.js";
import type { Credentials, CredentialLoadResult } from "./credentials.js";
import type { WorkspaceConfig } from "./config.js";
import type { DoctorCheck, DoctorChecks } from "./doctor-cmd.js";
import type { DaemonObservation } from "./daemon/observation.js";

/** Everything a doctor check may read. One shared, pre-resolved input keeps the
 * descriptors index-free: each names the fields it needs. */
export interface DoctorCheckRunInput {
  root: string;
  cfg: WorkspaceConfig;
  daemon: DaemonObservation;
  creds: Credentials | undefined;
  loaded: CredentialLoadResult;
}

export interface DoctorCheckDescriptor {
  readonly id: keyof DoctorChecks;
  run(input: DoctorCheckRunInput): DoctorCheck | Promise<DoctorCheck>;
  renderHuman(check: DoctorCheck): string[];
  renderMachine(check: DoctorCheck): DoctorCheck;
}

/** The uniform workspace-health line: status glyph, label, message, and — only
 * on a proven fault — one fix hint. */
export function renderCheckHuman(check: DoctorCheck): string[] {
  const lines = [`  ${check.ok ? style.sym.ok : style.sym.err} ${check.label}: ${check.message}`];
  if (!check.ok && check.hint) lines.push(`      ${style.dim("fix:")} ${check.hint}`);
  return lines;
}

/** A current check IS its own machine representation: the `DoctorCheck` is what
 * the diagnostics bundle serializes. U3's migration-halt descriptors override
 * this to emit their `MIGRATION_HALT_COPY` machine twin. */
export const passthroughMachine = (check: DoctorCheck): DoctorCheck => check;

/** A descriptor wired to the default uniform human + machine renderers. */
export function describeCheck(id: keyof DoctorChecks, run: DoctorCheckDescriptor["run"]): DoctorCheckDescriptor {
  return { id, run, renderHuman: renderCheckHuman, renderMachine: passthroughMachine };
}
