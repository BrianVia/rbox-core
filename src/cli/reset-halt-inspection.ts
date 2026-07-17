import { boundedHash, boundedRead } from "./reset-io.js";
import { resetJournalPath } from "./reset-journal.js";

const MAX_JOURNAL_BYTES = 512 * 1024;

export type ResetSafetyInspection =
  | { status: "none" }
  | { status: "recoverable"; journalIdentityHash: string; [key: string]: unknown }
  | { status: "halt"; reason: string; journalIdentityHash?: string; journal?: unknown; observation?: unknown; [key: string]: unknown };

/** Stable adapter while the safety classifier lives beside reset-journal.ts.
 * The fallback recognizes only unquestionably unsafe legacy/malformed input;
 * a v2 document is never guessed recoverable. */
export async function inspectResetJournalSafety(root: string, callerStream?: string): Promise<ResetSafetyInspection> {
  const module = await import("./reset-journal.js") as typeof import("./reset-journal.js") & {
    inspectResetJournal?: (workspaceRoot: string, stream?: string) => Promise<ResetSafetyInspection>;
  };
  if (module.inspectResetJournal) return module.inspectResetJournal(root, callerStream);
  const file = resetJournalPath(root);
  let bytes: Buffer | undefined;
  try {
    bytes = await boundedRead(file, MAX_JOURNAL_BYTES);
  } catch (error) {
    return {
      status: "halt",
      reason: error instanceof Error ? error.message : "reset journal is unsafe or oversized",
      journalIdentityHash: await boundedHash(file, MAX_JOURNAL_BYTES).catch(() => undefined),
    };
  }
  if (!bytes) return { status: "none" };
  const journalIdentityHash = await boundedHash(file, MAX_JOURNAL_BYTES);
  try {
    const value = JSON.parse(bytes.toString("utf8")) as { v?: unknown };
    if (value?.v === 1) return { status: "halt", reason: "legacy reset journal has no authorization witness", journalIdentityHash };
    return { status: "halt", reason: "reset journal could not be safely classified", journalIdentityHash };
  } catch {
    return { status: "halt", reason: "malformed reset journal JSON", journalIdentityHash };
  }
}
