import type {
  ResetPhysicalObservation,
  ResetPhysicalRow,
} from "./reset-journal-classifier.js";
import type {
  ResetJournalDecodeError,
  SQLiteResetJournalV2,
} from "./reset-journal-codec.js";
import type {
  ResetJournal,
  ResetJournalV2,
} from "./reset-journal-legacy-schema.js";

export interface ResetJournalHooks {
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  crashAt?: (point: string) => void | Promise<void>;
}

export interface ResetArtifactObservation extends ResetPhysicalObservation {
  activeHash?: string;
  candidateHash?: string;
  archiveHash?: string;
  artifactPaths: { active: string; candidate: string; archive: string; marker: string; journal: string };
}

export type ResetJournalInspection =
  | { status: "none" }
  | { status: "halt"; reason: string; journalIdentityHash?: string; journal?: ResetJournal | SQLiteResetJournalV2; observation?: ResetArtifactObservation; decodeError?: ResetJournalDecodeError }
  | {
    status: "recoverable";
    journalIdentityHash: string;
    journal: ResetJournalV2 | SQLiteResetJournalV2;
    configDisposition: "old" | "next";
    row: ResetPhysicalRow;
    observation: ResetArtifactObservation;
  };

export class ResetRecoveryHaltError extends Error {
  readonly code = "RESET_RECOVERY_HALT";
  constructor(readonly inspection: Extract<ResetJournalInspection, { status: "halt" }>) {
    super(`reset recovery halted: ${inspection.reason}`);
    this.name = "ResetRecoveryHaltError";
  }
}
