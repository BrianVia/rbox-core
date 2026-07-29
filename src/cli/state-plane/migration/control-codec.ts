/**
 * The migration control record as a value (design 163 § "Migration artifacts and
 * completion witness", :2627, and § "Durable phase publication", :2676).
 *
 * Pure: no filesystem, no SQLite, no state document, no path computation. It
 * owns the closed exact schema, its canonical bytes, and the predicates that
 * read a control without observing anything else.
 *
 * Three members 163 prints are deliberately absent, because each would store the
 * same value twice and could therefore only ever disagree: the top-level `phase`
 * (the witness union's discriminant is the phase), the halt's own `phase` (a halt
 * is phase-preserving by construction), and M6's `qAuthorityId` (the control
 * already carries `authorityId`). Everything else 163 prints is stored, including
 * every artifact path — see design 222 §1.1's record of what wave 1A pinned.
 */
import { canonicalize, canonicalString } from "../../../engine/e2ee/jcs.js";
import { checkRecord, tagged, type Fields, type Refuse, type Spec } from "../closed-record.js";
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

/** Exhaustive by construction: a `Record<MigrationHaltCode, true>` cannot omit a
 * code, so a wave that adds one cannot leave the codec rejecting durable halt
 * records the rest of the build already accepts. */
const HALT_CODE_TABLE: Record<MigrationHaltCode, true> = {
  "source-oversize": true, "memory-admission": true, "record-oversize": true,
  "disk-preflight": true, "filesystem-full": true, "source-changed": true,
  "verification": true, "reserved-path": true, "durability-indeterminate": true,
  "cleanup-deferred": true,
};
const HALT_CODES = Object.keys(HALT_CODE_TABLE);

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

/** A prepared future-control sibling's disposition on the M6 allocation-free
 * runway (163:2988). It may never be reset from `building`/`exact` to `absent`. */
export type PreparedDescriptor =
  | { readonly state: "absent" }
  | ({ readonly state: "building"; readonly expected: null | { readonly bytes: number; readonly sha256: string } } & Inode)
  | ({ readonly state: "exact"; readonly bytes: number; readonly sha256: string } & Inode);

/** One prebound member of the ledger: its fixed kind, its exact path, and how
 * far it has been rendered (163:2986). Every artifact this record names stores
 * its own path — the same policy as the retirement vector, the cleanup vector,
 * and the terminal sibling. */
export interface PreparedControlSlot {
  readonly kind: "halted-m6" | "m7";
  readonly path: string;
  readonly disposition: PreparedDescriptor;
}

export type FutureControls =
  | null
  | {
    readonly stage: "preparing"; readonly version: 1;
    readonly baseRevision: number; readonly readyRevision: number;
    readonly haltRevision: number; readonly successRevision: number;
    readonly halt: PreparedControlSlot; readonly success: PreparedControlSlot;
  }
  /** The ledger as the promoted halted-M6 record consumes it: where it came
   * from, and the M7 sibling it still owns. Neither member carries its own
   * SHA-256 — that would be a self/cross-digest cycle (163:3028). */
  | {
    readonly stage: "promoted-halt";
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
// The closed schema. `closed-record.ts` owns the reader that enforces it.

const bad: Refuse = (at, why) => {
  throw new MigrationControlError("schema", `${at} ${why}`);
};

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
const slot = (kind: "halted-m6" | "m7"): Spec => ({
  fields: {
    kind: { const: kind },
    path: "string",
    disposition: tagged("state", {
      absent: {},
      building: { ...INODE, expected: { opt: { fields: { bytes: "int", sha256: "hex" } } } },
      exact: { ...INODE, bytes: "int", sha256: "hex" },
    }),
  },
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
      opt: tagged("stage", {
        preparing: {
          version: { const: 1 },
          baseRevision: "int", readyRevision: "int", haltRevision: "int", successRevision: "int",
          halt: slot("halted-m6"), success: slot("m7"),
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

/** The correlations the shape schema cannot state. */
function checkInvariants(control: MigrationControl): void {
  const { witness } = control;
  const m6 = witness.phase === "M6" || witness.phase === "M7" ? witness : undefined;
  // Disposition legality (163:2636): `not-created` only at M0, `retired` only at
  // M7, and each intent/absent variant only inside its own subprotocol.
  for (const [role, resource] of Object.entries(control.haltResources)) {
    const at = `control.haltResources.${role}`;
    const d = resource.disposition;
    if (d === "not-created" && witness.phase !== "M0") bad(at, "is not-created outside M0");
    if (d === "retired" && witness.phase !== "M7") bad(at, "is retired outside M7");
    if (d.startsWith("retirement-") && control.retirement === null) bad(at, "names a retirement with none armed");
    if (d.startsWith("cleanup-") && !m6) bad(at, "names an M6 cleanup before M6");
  }
  for (const cursor of [control.retirement?.cursor, m6?.cleanup]) {
    if (!cursor) continue;
    if (cursor.durablePrefix > cursor.items.length) bad("control cursor", "prefix exceeds its vector");
    if (cursor.currentIntent && cursor.currentIntent.index !== cursor.durablePrefix + 1) {
      bad("control cursor", "current intent is not the item after the durable prefix");
    }
    if (cursor.currentIntent && cursor.currentIntent.index > cursor.items.length) bad("control cursor", "current intent is past its vector");
  }
  const ledger = m6?.futureControls;
  if (ledger?.stage === "preparing") {
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
  checkRecord(parsed, CONTROL, "control", bad);
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
    && witness.futureControls?.stage === "promoted-halt"
    && witness.cleanup.currentIntent?.index === witness.cleanup.items.length;
}
