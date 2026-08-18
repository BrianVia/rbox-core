/** User-facing copy for fresh SQLite genesis admission failures. */
import type { TriageFinding, TriageSeverity } from "./doctor-triage.js";
import type { GenesisAdmissionRefusal } from "./state-plane/authority-bootstrap.js";

export interface OperatorCopy {
  readonly human: {
    readonly problem: string;
    readonly safety: string;
    readonly command?: string;
  };
  readonly machine: { readonly id: string; readonly severity: TriageSeverity };
}

export type OperatorFinding = TriageFinding;

const GENESIS_LOCK_SAFETY = "Your files are safe. rbox stopped before syncing or changing any more files; synced copies on the server and other computers were not changed.";

export const GENESIS_ADMISSION_REFUSAL_COPY = {
  "lock-unsupported": {
    human: {
      problem: "rbox can't safely continue because this folder doesn't allow the locking rbox needs. Move this entire workspace folder, including its hidden .rbox folder, to a local disk, then run the same command there.",
      safety: GENESIS_LOCK_SAFETY,
    },
    machine: { id: "state-genesis/lock-unsupported", severity: "blocked" },
  },
  "lock-indeterminate": {
    human: {
      problem: "rbox couldn't create the lock it needs in this folder. Check this folder's permissions and storage or security policy, then run the same command again. If it still fails, run rbox doctor.",
      safety: GENESIS_LOCK_SAFETY,
    },
    machine: { id: "state-genesis/lock-indeterminate", severity: "blocked" },
  },
  "lock-identity-unavailable": {
    human: {
      problem: "rbox couldn't verify this computer's identity for safe locking. Restart this computer, then run the same command again.",
      safety: GENESIS_LOCK_SAFETY,
    },
    machine: { id: "state-genesis/lock-identity-unavailable", severity: "blocked" },
  },
  "lock-io": {
    human: {
      problem: "rbox couldn't complete a storage operation needed to create, verify, or clean up the lock in this folder. Check that the disk has free space and that this folder is readable and writable, then run the same command again. If it still fails, run rbox doctor.",
      safety: GENESIS_LOCK_SAFETY,
    },
    machine: { id: "state-genesis/lock-io", severity: "blocked" },
  },
} satisfies Record<GenesisAdmissionRefusal["reason"], OperatorCopy>;
