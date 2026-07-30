/**
 * The primitives every M-5 phase body shares: how it refuses, how it makes a
 * write durable, and how it re-establishes that the source is still the one its
 * control recorded.
 *
 * A leaf so `import-json.ts` and `legacy-backup.ts` can both reach them without
 * either importing the other.
 */
import fs, { constants as O } from "node:fs";
import path from "node:path";
import { MigrationPhaseHaltError } from "../errors.js";
import { fsyncDirectory } from "../store/artifact-proof.js";
import { observePath } from "./artifact-observation.js";
import type { PhaseReceipt } from "./classifier.js";
import type { MigrationControl, SourceWitness } from "./control-codec.js";
import type { MigrationHaltCode } from "./health.js";

/**
 * Raise the halt; never publish it. The durable record is the driver's (163's
 * "a failed halt publication is the final mutation of the trace"), and `wrote`
 * is the one fact the driver cannot recompute — whether this refusal happened
 * before any artifact mutation, which is what the zero-write rows assert.
 *
 * `detail` reaches the exception message and nothing else, so a phase whose code
 * covers several distinct checks names the one that refused in `underlyingCode`
 * — the durable record's only free slot, already carrying that discriminator in
 * `retirement.ts`, `classifier.ts`, and `authority.ts`. It must be a STABLE
 * token, never the measured prose: `control-sibling.ts` explains why a halt
 * record whose bytes will never recur strands its revision-scoped sibling.
 */
export const halt = (
  code: MigrationHaltCode, wrote: boolean, detail: string,
  fields: { required?: number; available?: number; underlyingCode?: string } = {},
): never => {
  throw new MigrationPhaseHaltError(
    {
      code, underlyingCode: fields.underlyingCode ?? null,
      required: fields.required ?? null, available: fields.available ?? null,
    },
    wrote, detail,
  );
};

/** A phase body may only run on a receipt for the phase it follows. Shared so
 * the two modules that hold phase bodies cannot drift on what "exact" means. */
export function requirePhase(
  receipt: PhaseReceipt, expected: MigrationControl["witness"]["phase"],
): MigrationControl {
  if (receipt.phase !== expected) {
    throw new TypeError(`this phase body requires an exact ${expected} receipt, not ${receipt.phase}`);
  }
  return receipt.control;
}

export const fsyncFileAndParent = (file: string): void => {
  const fd = fs.openSync(file, O.O_RDONLY | O.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fsyncDirectory(path.dirname(file));
};

/** The recorded source, re-bracketed. Called before every mutator: a receipt
 * proves which control was observed, not that the document still is what that
 * control says. */
export function bracketSource(control: MigrationControl): SourceWitness {
  const source = control.source;
  const observed = observePath(source.path, true);
  if (observed.state !== "regular" || observed.dev !== source.dev || observed.ino !== source.ino
    || observed.bytes !== source.bytes || observed.sha256 !== source.sha256
    || observed.mtimeNs !== source.mtimeNs) {
    halt("verification", false, "the legacy document is no longer the one this migration recorded");
  }
  return source;
}
