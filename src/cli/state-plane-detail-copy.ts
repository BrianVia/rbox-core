/**
 * The DISCRIMINATOR vocabulary of the state plane (design 222 §6.3).
 *
 * Split from `state-plane-copy.ts`, which holds the outcome tables, because the
 * two answer different questions at different points and the combined file
 * crossed 163's module-size law. That file decides WHICH outcome a user met;
 * this one decides which of the several conditions hiding inside one halt code
 * it actually was — `verification` covers seven distinct refusals and
 * `reserved-path` has roughly forty producers across eight modules.
 *
 * Words only. `state-plane-report.ts` does the classifying.
 */
import type { OperatorCopy } from "./state-plane-copy.js";

/**
 * The stable tokens the phase bodies put in `underlyingCode`, in plain English.
 *
 * They are a discriminator inside one halt code — `verification` alone covers
 * seven distinct refusals — so without this table a user is told "it didn't
 * match" and nothing more.
 *
 * **Anything NOT in this table is never shown.** `underlyingCode` is also where
 * `authority.ts`, `classifier.ts`, `retirement.ts`, and `halt-recovery.ts` put
 * free-text corruption details, and those are developer sentences: "no durable
 * config stream to bind its reserve to" is a true statement about this codebase
 * and means nothing to the four people who read it. The report module gives an
 * unrecognised value a generic line instead; the detail survives verbatim in the
 * durable record, which is what `rbox doctor --report` is for.
 */
export const UNDERLYING_TOKEN_COPY: Readonly<Record<string, string>> = {
  "staging-open": "the converted copy could not be opened for checking",
  "authority-mismatch": "the converted copy was not stamped by this conversion",
  "completion-tuple": "the converted copy's own record of what it imported did not match",
  "semantic-digest": "a content fingerprint of the converted copy did not match the original",
  "foreign-key-check": "the converted copy's internal links did not check out",
  "integrity-check": "the converted copy failed its own database integrity check",
  checkpoint: "the converted copy could not be settled onto the disk",
  "not-at-rest": "the converted copy still had working files beside it",
  "staging-inode": "the file being converted was not the one rbox recorded",
  "staging-identity-absent": "the file being converted was gone",
  "staging-identity-changed": "the file being converted was replaced while rbox was checking it",
};

/** What a halt says when its discriminator is a sentence rbox wrote for itself.
 * It admits the shape of the problem without pretending to explain it. */
export const UNDERLYING_UNKNOWN_LINE =
  "rbox recorded the details of what stopped it; `rbox doctor --report` collects them.";

/**
 * `reserved-path`'s producer classes, and the remedy each one actually has.
 *
 * `reserved-path` is the taxonomy's catch-all: roughly forty producers across
 * eight modules raise it, and they are not one situation. A single remedy is
 * therefore wrong for most of them — "move anything rbox didn't write aside
 * yourself" is meaningless for a missing config stream, an `EIO`, or an
 * exhausted reserve budget, and on the post-flip producers the file list it
 * pointed at includes the workspace's LIVE sync records. Telling a
 * non-developer to move those aside is the worst instruction this surface could
 * give.
 *
 * The class is derived from `underlyingCode`, and the DEFAULT is `internal`:
 * a durable path-occupancy halt carries no discriminator at all (the stable-token
 * rule keeps prose out of the record), so "send the report" is what an unclassified
 * one gets. Naming files a user should not touch is worse than naming none.
 */
export type ReservedPathClass = "path-occupied" | "environment" | "internal";

export const RESERVED_PATH_CLASS_COPY = {
  /** Something rbox did not write is sitting where rbox keeps its own files, and
   * the halt named which one. This is the only class that names a path. */
  "path-occupied": {
    human: {
      problem: "Something rbox didn't write is sitting where rbox keeps this workspace's sync records.",
      safety: "Nothing was deleted, moved, or overwritten. Your files and your sync are unaffected.",
      command: "look at the file named above; move it aside yourself, then run `rbox migrate`",
    },
    machine: { id: "state-migration/reserved-path", severity: "blocked" },
  },
  /** The disk or the operating system refused an operation. Nothing is occupied
   * and there is nothing for the user to move. */
  environment: {
    human: {
      problem: "The system refused an operation rbox needed while converting this workspace's sync records.",
      safety: "Nothing was lost. The records rbox is using right now are the ones it was already using.",
      command: "rbox doctor",
    },
    machine: { id: "state-migration/reserved-path", severity: "blocked" },
  },
  /** rbox's own records for this workspace are in a shape it does not recognise.
   * There is no file the user can helpfully touch. */
  internal: {
    human: {
      problem: "rbox found its own records for this workspace in a state it doesn't recognise, so it stopped.",
      safety: "Nothing was deleted, moved, or overwritten. Your files and your sync are unaffected.",
      command: "rbox doctor --report",
    },
    machine: { id: "state-migration/reserved-path", severity: "blocked" },
  },
} satisfies Record<ReservedPathClass, OperatorCopy>;

/**
 * The `internal` producers that DO have a real remedy, keyed on their stable
 * token. Only the post-`Q` abort has one today, and it is 163's re-adoption
 * procedure spelled out rather than named.
 */
export const RESERVED_PATH_TOKEN_COPY: Readonly<Record<string, OperatorCopy>> = {
  "abort-after-flip": {
    human: {
      problem: "This workspace's sync records have already been converted, so there's nothing left to undo.",
      safety: "Nothing changed. Your files and your sync are unaffected, and the converted records are the ones in use.",
      command: "nothing — the conversion finished. To go back to the old format you would have to set this workspace up again from scratch with `rbox adopt`",
    },
    machine: { id: "state-migration/abort-after-flip", severity: "attention" },
  },
};
