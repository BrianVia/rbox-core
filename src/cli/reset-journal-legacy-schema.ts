import type { JsonValue } from "../json.js";
import { constructResetJournal } from "./reset-journal-schema.js";
import {
  ResetCorruptionError,
} from "./reset-io.js";
import type {
  ResetConsentKind,
  ResetJournalAuthorization,
  ResetJournalV1 as CodecV1,
  ResetJournalV2 as CodecV2,
  ResetNextState,
  ResetPhase,
} from "./reset-journal-codec.js";

export type {
  ResetConsentKind,
  ResetJournalAuthorization,
  ResetNextState,
  ResetPhase,
};

export type ResetJournalV1 = Omit<CodecV1, "old"> & {
  old: CodecV1["old"] & { archiveBaseline: "absent" };
};
export type ResetJournalV2 = CodecV2;
export type ResetJournal = ResetJournalV1 | ResetJournalV2;

function rejected(cause: unknown): never {
  throw new ResetCorruptionError(
    `reset journal schema rejected: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

export function validateResetJournalV1(value: JsonValue): ResetJournalV1 {
  try {
    const journal = constructResetJournal(value);
    if ("stateFormat" in journal || journal.v !== 1) rejected("bad reset journal v1 envelope");
    return {
      ...journal,
      old: { ...journal.old, archiveBaseline: "absent" },
    };
  } catch (cause) {
    rejected(cause);
  }
}

export function validateResetJournalV2(value: JsonValue): ResetJournalV2 {
  try {
    const journal = constructResetJournal(value);
    if ("stateFormat" in journal || journal.v !== 2) rejected("bad reset journal v2 envelope");
    return journal;
  } catch (cause) {
    rejected(cause);
  }
}
