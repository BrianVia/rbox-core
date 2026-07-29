/**
 * The migration control record as a value (design 163 § "Migration artifacts and
 * completion witness", :2627, and § "Durable phase publication", :2676).
 *
 * Pure: no filesystem, no SQLite, no state document, no path computation. It
 * owns the closed exact schema, its canonical bytes, and the predicates that
 * read a control without observing anything else.
 *
 * Two members 163 prints are deliberately absent, because each would store the
 * same value twice and could therefore only ever disagree: the top-level `phase`
 * (the witness union's discriminant is the phase) and the halt's own `phase` (a
 * halt is phase-preserving by construction).
 */
import { canonicalize, canonicalString } from "../../../engine/e2ee/jcs.js";
import { MigrationControlError } from "../errors.js";
import type { MigrationHalt, MigrationHaltCode } from "./health.js";

export const CONTROL_MAX_BYTES = 65_536;
export const MIGRATION_PHASES = ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"] as const;
export type MigrationPhase = typeof MIGRATION_PHASES[number];

export const HALT_RESOURCE_DISPOSITIONS = [
  "not-created", "available", "consumed-for-halt",
  "retirement-intent", "retirement-absent",
  "cleanup-intent", "cleanup-absent", "retired",
] as const;
export type HaltResourceDisposition = typeof HALT_RESOURCE_DISPOSITIONS[number];

export const ARTIFACT_ROLES = [
  "q-sibling", "staging-journal", "staging-wal", "staging-shm", "staging-main",
  "prepared-active-db", "control-sibling", "emergency", "reserve",
] as const;
export type ArtifactRole = typeof ARTIFACT_ROLES[number];

const HALT_CODES: readonly MigrationHaltCode[] = [
  "source-oversize", "memory-admission", "record-oversize", "disk-preflight", "filesystem-full",
  "source-changed", "verification", "reserved-path", "durability-indeterminate", "cleanup-deferred",
];

export interface Inode { readonly dev: number; readonly ino: number }
export interface SourceWitness extends Inode {
  readonly path: string; readonly bytes: number; readonly sha256: string;
  /** The identity bracket's stat token, decimal nanoseconds. */
  readonly mtimeNs: string;
}
export interface ArtifactWitness extends Inode {
  readonly path: string; readonly bytes: number; readonly sha256: string;
}
/** One member of a retirement or cleanup vector. Derived only from the exact
 * control's own recorded artifacts; a path is never discovered. */
export interface ArtifactItem extends Inode {
  readonly role: ArtifactRole; readonly path: string; readonly parent: string; readonly sha256: string | null;
}
/** `available` is the only disposition that names a file, and it names it by
 * identity: nothing releases a resource it cannot prove it owns. */
export type HaltResource =
  | ({ readonly disposition: "available"; readonly bytes: number; readonly sha256: string } & Inode)
  | { readonly disposition: Exclude<HaltResourceDisposition, "available"> };

export interface AdmissionProof {
  readonly sourceBytes: number; readonly requiredBytes: number; readonly budgetBytes: number;
}
export interface CompletionTuple {
  readonly migrationId: string; readonly importerVersion: string; readonly authorityId: string;
  readonly sourceJsonSha256: string; readonly sourceSemanticDigest: string; readonly sourceBytes: number;
  readonly entryCount: number; readonly repoCount: number;
  readonly perTableCounts: Readonly<Record<string, number>>; readonly completedAt: number;
}
export interface StagingProof {
  readonly sha256: string; readonly bytes: number; readonly semanticDigest: string;
  readonly entryCount: number; readonly repoCount: number; readonly proofVersion: number;
}
export type StagingMain = { readonly state: "absent" } | ({ readonly state: "present" } & Inode);

/** The Q sibling's prebound path/bytes plus its closed same-phase disposition
 * (163:2646). `building` admits only the recorded inode at length 0..58. */
export interface QSiblingWitness {
  readonly path: string; readonly bytes: 58; readonly sha256: string;
  readonly disposition:
    | { readonly state: "absent" }
    | ({ readonly state: "building" | "exact" } & Inode);
}

/** A monotone one-target cleanup cursor: retirement's (163:2761) and M6's
 * (163:2899) are the same machine over different vectors. */
export interface Cursor {
  readonly items: readonly ArtifactItem[];
  readonly durablePrefix: number;
  readonly currentIntent: null | { readonly index: number };
}

/** A prepared future-control sibling on the M6 allocation-free runway
 * (163:2988). Neither descriptor may ever be reset to `absent`. */
export type PreparedDescriptor =
  | { readonly state: "absent" }
  | ({ readonly state: "building"; readonly expected: null | { readonly bytes: number; readonly sha256: string } } & Inode)
  | ({ readonly state: "exact"; readonly bytes: number; readonly sha256: string } & Inode);

export type FutureControls =
  | null
  | {
    readonly kind: "preparing"; readonly baseRevision: number; readonly readyRevision: number;
    readonly haltRevision: number; readonly successRevision: number;
    readonly halt: PreparedDescriptor; readonly success: PreparedDescriptor;
  }
  /** The ledger as the promoted halted-M6 record consumes it: where it came
   * from, and the M7 sibling it still owns. Neither member carries its own
   * SHA-256 — that would be a self/cross-digest cycle (163:3028). */
  | {
    readonly kind: "promoted-halt";
    readonly origin: { readonly path: string; readonly revision: number } & Inode;
    readonly preparedSuccess: { readonly path: string; readonly revision: number; readonly bytes: number } & Inode;
  };

/** M7's descriptor for the prepared halt sibling: exact on the direct branch,
 * absent on the promoted branch, and the record never claims which (163:3125). */
export interface TerminalSibling extends ArtifactWitness {
  readonly disposition: "exact-or-absent-terminal";
}

interface W1 { readonly admission: AdmissionProof }
interface W2 { readonly history: ArtifactWitness; readonly fixedBackup: ArtifactWitness; readonly stagingMain: StagingMain }
interface W3 { readonly completion: CompletionTuple }
interface W4 { readonly staging: StagingProof }
interface W5 { readonly active: StagingProof; readonly qSibling: QSiblingWitness }
interface W6 { readonly cleanup: Cursor; readonly futureControls: FutureControls }
interface W7 { readonly terminalSibling: TerminalSibling }

/** The phase witness: monotone, recorded only after that phase's artifact work
 * and every named parent fsync completed (163:2681). */
export type MigrationWitness =
  | { readonly phase: "M0" }
  | ({ readonly phase: "M1" } & W1)
  | ({ readonly phase: "M2" } & W1 & W2)
  | ({ readonly phase: "M3" } & W1 & W2 & W3)
  | ({ readonly phase: "M4" } & W1 & W2 & W3 & W4)
  | ({ readonly phase: "M5" } & W1 & W2 & W3 & W4 & W5)
  | ({ readonly phase: "M6" } & W1 & W2 & W3 & W4 & W5 & W6)
  | ({ readonly phase: "M7" } & W1 & W2 & W3 & W4 & W5 & W6 & W7);

/** The durable source-change retirement union (163:2725). The witness phase
 * stays the old highest completed phase; this is a separate cleanup high-water. */
export interface MigrationRetirement {
  readonly version: 1;
  readonly reason: "source-changed";
  readonly fromPhase: MigrationPhase;
  readonly fromControlRevision: number;
  readonly originalSource: SourceWitness;
  /** Diagnostic, never authority. */
  readonly triggeringSource: SourceWitness;
  readonly cursor: Cursor;
}

export interface MigrationControl {
  readonly version: 1;
  readonly controlRevision: number;
  readonly migrationId: string;
  readonly authorityId: string;
  readonly source: SourceWitness;
  readonly stagingPath: string;
  readonly witness: MigrationWitness;
  readonly haltResources: { readonly reserve: HaltResource; readonly emergency: HaltResource };
  readonly halt: MigrationHalt | null;
  readonly retirement: MigrationRetirement | null;
}

// ---------------------------------------------------------------------------
// The closed schema, and the one reader that enforces it.

type Fields = Record<string, Spec>;
type Spec =
  | "string" | "int" | "hex" | "digits"
  | { readonly oneOf: readonly string[] }
  | { readonly const: unknown }
  | { readonly opt: Spec }
  | { readonly list: Spec }
  | { readonly each: Spec }
  | { readonly fields: Fields }
  | { readonly union: { readonly on: string; readonly cases: Record<string, Fields> } };

const bad = (at: string, why: string): never => {
  throw new MigrationControlError("schema", `${at} ${why}`);
};
const plainObject = (v: unknown, at: string): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : bad(at, "is not an object");

function check(v: unknown, spec: Spec, at: string): void {
  if (spec === "string") { if (typeof v !== "string" || v.length === 0) bad(at, "is not a nonempty string"); return; }
  if (spec === "int") { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) bad(at, "is not a nonnegative safe integer"); return; }
  if (spec === "hex") { if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) bad(at, "is not 64 lowercase hex characters"); return; }
  if (spec === "digits") { if (typeof v !== "string" || !/^[0-9]+$/.test(v)) bad(at, "is not decimal digits"); return; }
  if ("oneOf" in spec) { if (!spec.oneOf.includes(v as string)) bad(at, `is not one of ${spec.oneOf.join("|")}`); return; }
  if ("const" in spec) { if (v !== spec.const) bad(at, `is not ${JSON.stringify(spec.const)}`); return; }
  if ("opt" in spec) { if (v !== null) check(v, spec.opt, at); return; }
  if ("list" in spec) {
    if (!Array.isArray(v)) { bad(at, "is not an array"); return; }
    v.forEach((item, i) => check(item, spec.list, `${at}[${i}]`));
    return;
  }
  if ("each" in spec) {
    for (const [key, item] of Object.entries(plainObject(v, at))) check(item, spec.each, `${at}.${key}`);
    return;
  }
  if ("union" in spec) {
    const tag = plainObject(v, at)[spec.union.on];
    const fields = typeof tag === "string" ? spec.union.cases[tag] : undefined;
    if (!fields) bad(`${at}.${spec.union.on}`, `is not one of ${Object.keys(spec.union.cases).join("|")}`);
    return check(v, { fields: fields! }, at);
  }
  const o = plainObject(v, at);
  const keys = Object.keys(spec.fields);
  for (const key of Object.keys(o)) if (!keys.includes(key)) bad(at, `has unknown member ${JSON.stringify(key)}`);
  for (const key of keys) {
    if (!(key in o)) bad(at, `is missing ${JSON.stringify(key)}`);
    check(o[key], spec.fields[key]!, `${at}.${key}`);
  }
}

const tagged = (on: string, cases: Record<string, Fields>): Spec => ({
  union: { on, cases: Object.fromEntries(Object.entries(cases).map(([tag, f]) => [tag, { [on]: { const: tag }, ...f }])) },
});
const INODE: Fields = { dev: "int", ino: "int" };
const SOURCE: Spec = { fields: { path: "string", ...INODE, bytes: "int", sha256: "hex", mtimeNs: "digits" } };
const ARTIFACT: Fields = { path: "string", ...INODE, bytes: "int", sha256: "hex" };
const CURSOR: Spec = {
  fields: {
    items: { list: { fields: { role: { oneOf: ARTIFACT_ROLES }, path: "string", parent: "string", ...INODE, sha256: { opt: "hex" } } } },
    durablePrefix: "int",
    currentIntent: { opt: { fields: { index: "int" } } },
  },
};
const RESOURCE: Spec = tagged("disposition", Object.fromEntries(HALT_RESOURCE_DISPOSITIONS.map(
  (d) => [d, d === "available" ? { ...INODE, bytes: "int", sha256: "hex" } : {}] as const,
)));
const PREPARED: Spec = tagged("state", {
  absent: {},
  building: { ...INODE, expected: { opt: { fields: { bytes: "int", sha256: "hex" } } } },
  exact: { ...INODE, bytes: "int", sha256: "hex" },
});
const PROOF: Fields = {
  sha256: "hex", bytes: "int", semanticDigest: "hex", entryCount: "int", repoCount: "int", proofVersion: "int",
};
const WITNESS_LAYERS: readonly Fields[] = [
  {},
  { admission: { fields: { sourceBytes: "int", requiredBytes: "int", budgetBytes: "int" } } },
  {
    history: { fields: ARTIFACT }, fixedBackup: { fields: ARTIFACT },
    stagingMain: tagged("state", { absent: {}, present: INODE }),
  },
  {
    completion: {
      fields: {
        migrationId: "string", importerVersion: "string", authorityId: "string",
        sourceJsonSha256: "hex", sourceSemanticDigest: "hex", sourceBytes: "int",
        entryCount: "int", repoCount: "int", perTableCounts: { each: "int" }, completedAt: "int",
      },
    },
  },
  { staging: { fields: PROOF } },
  {
    active: { fields: PROOF },
    qSibling: {
      fields: {
        path: "string", bytes: { const: 58 }, sha256: "hex",
        disposition: tagged("state", { absent: {}, building: INODE, exact: INODE }),
      },
    },
  },
  {
    cleanup: CURSOR,
    futureControls: {
      opt: tagged("kind", {
        preparing: {
          baseRevision: "int", readyRevision: "int", haltRevision: "int", successRevision: "int",
          halt: PREPARED, success: PREPARED,
        },
        "promoted-halt": {
          origin: { fields: { path: "string", revision: "int", ...INODE } },
          preparedSuccess: { fields: { path: "string", revision: "int", ...INODE, bytes: "int" } },
        },
      }),
    },
  },
  { terminalSibling: { fields: { ...ARTIFACT, disposition: { const: "exact-or-absent-terminal" } } } },
];

const CONTROL: Spec = {
  fields: {
    version: { const: 1 },
    controlRevision: "int",
    migrationId: "string",
    authorityId: "string",
    source: SOURCE,
    stagingPath: "string",
    witness: tagged("phase", Object.fromEntries(MIGRATION_PHASES.map(
      (phase, depth) => [phase, Object.assign({}, ...WITNESS_LAYERS.slice(0, depth + 1))] as const,
    ))),
    haltResources: { fields: { reserve: RESOURCE, emergency: RESOURCE } },
    halt: { opt: { fields: { code: { oneOf: HALT_CODES }, underlyingCode: { opt: "string" }, required: { opt: "int" }, available: { opt: "int" } } } },
    retirement: {
      opt: {
        fields: {
          version: { const: 1 }, reason: { const: "source-changed" },
          fromPhase: { oneOf: MIGRATION_PHASES.slice(0, 6) }, fromControlRevision: "int",
          originalSource: SOURCE, triggeringSource: SOURCE, cursor: CURSOR,
        },
      },
    },
  },
};

/** The two correlations the shape schema cannot state. */
function checkInvariants(control: MigrationControl): void {
  const { witness } = control;
  const m6 = witness.phase === "M6" || witness.phase === "M7" ? witness : undefined;
  for (const cursor of [control.retirement?.cursor, m6?.cleanup]) {
    if (!cursor) continue;
    if (cursor.durablePrefix > cursor.items.length) bad("control cursor", "prefix exceeds its vector");
    if (cursor.currentIntent && cursor.currentIntent.index !== cursor.durablePrefix + 1) {
      bad("control cursor", "current intent is not the item after the durable prefix");
    }
    if (cursor.currentIntent && cursor.currentIntent.index > cursor.items.length) bad("control cursor", "current intent is past its vector");
  }
  const ledger = m6?.futureControls;
  if (ledger?.kind === "preparing") {
    const { baseRevision: b, readyRevision, haltRevision, successRevision } = ledger;
    if (readyRevision !== b + 4 || haltRevision !== b + 5 || successRevision !== b + 6) {
      bad("control futureControls", "revisions are not exactly spaced b+4/b+5/b+6");
    }
  }
}

/** Canonical bytes, hard-capped at 64 KiB (163:2696). Encoding round-trips
 * through the strict reader, so no caller can publish a record the next process
 * would refuse. */
export function encodeMigrationControl(control: MigrationControl): Buffer {
  const bytes = Buffer.from(canonicalize(control));
  decodeMigrationControl(bytes);
  return bytes;
}

/** Strict. Unknown, extra, missing, mistyped, or noncanonical bytes REJECT
 * (163:2639). */
export function decodeMigrationControl(bytes: Uint8Array): MigrationControl {
  const text = Buffer.from(bytes).toString("utf8");
  if (bytes.byteLength > CONTROL_MAX_BYTES) {
    throw new MigrationControlError("schema", `record is ${bytes.byteLength} bytes, over the ${CONTROL_MAX_BYTES} cap`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new MigrationControlError("schema", `record is not JSON: ${String(cause)}`);
  }
  check(parsed, CONTROL, "control");
  const control = parsed as MigrationControl;
  checkInvariants(control);
  if (canonicalString(control) !== text) throw new MigrationControlError("schema", "record bytes are not canonical");
  return control;
}

/** The C1 trigger. Both dispositions total-map to 163's single durable reason
 * (163:2727), so a second durable reason cannot be introduced. It lives here so
 * retirement (wave 3) does not depend on the flip (wave 4). */
export type C1Trigger =
  | { readonly disposition: "source-changed"; readonly replacement: SourceWitness }
  | { readonly disposition: "legacy-write-detected"; readonly observedBodySha256: string };
export const durableRetirementReason = (_: C1Trigger): "source-changed" => "source-changed";

/**
 * The post-`Q` migration write fence. Called only where `Q` already elects
 * SQLite, so a phase below M6 is the `M5 + Q` row — the rename landed but M6's
 * publication and parent fsync did not (163:3266). `cleanup-deferred` is
 * explicitly writable; `durability-indeterminate` never is.
 */
export function blocksSqliteWrites(control: MigrationControl): boolean {
  return control.halt?.code === "durability-indeterminate"
    || MIGRATION_PHASES.indexOf(control.witness.phase) < MIGRATION_PHASES.indexOf("M6");
}

/** The one halted row whose clear is a rename rather than a durable CAS-clear
 * (163:3105): an exact final-intent promoted halt on the M6 runway. */
export function isFinalIntentPromotedHalt(control: MigrationControl): boolean {
  const { witness } = control;
  return witness.phase === "M6"
    && control.halt?.code === "cleanup-deferred"
    && witness.futureControls?.kind === "promoted-halt"
    && witness.cleanup.currentIntent?.index === witness.cleanup.items.length;
}
