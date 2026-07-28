import {
  inspectResetJournal,
  type ResetJournalInspection,
} from "./reset-journal.js";

export type ResetSafetyInspection = ResetJournalInspection;

/** Stable adapter for callers that should depend only on the safety verdict. */
export const inspectResetJournalSafety = inspectResetJournal;
