import {
  inspectResetJournal,
  type ResetJournalInspection,
} from "./reset-journal.js";

export type ResetSafetyInspection = ResetJournalInspection;

/** Stable adapter for callers that should depend only on the safety verdict. */
export const inspectResetJournalSafety = inspectResetJournal;

/**
 * Design 276 F2.1: every Adapter decides about every verdict. Passing the value
 * here once an Adapter has handled the rows it knows makes a NEW variant fail to
 * COMPILE at that Adapter, instead of silently inheriting whatever its trailing
 * branch happens to do.
 */
export function unhandledResetInspection(inspection: never): Error {
  return new Error(`unhandled reset inspection: ${JSON.stringify(inspection)}`);
}
