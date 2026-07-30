/**
 * M0 and M1 — the two phase bodies no wave built (design 222 §5.2's first two
 * rows).
 *
 * Waves 1-4 delivered M2 through M7 and everything around them, but the phases
 * that *start* a migration fell between §M-4 (admission, which decides whether
 * one may begin and publishes nothing) and §M-5 (which begins at M1's exact
 * receipt). Nothing minted a migration id, published a first control, claimed
 * the reserve, or created the emergency candidate, so `publishMigrationControl`
 * at `FIRST_CONTROL_REVISION` and `migrationPaths.emergency` had no production
 * caller at all. Wave 5A owns the driver, and a driver with no M0 is not a
 * driver.
 *
 * The split from `authority.ts` is §7.9's: the driver imports no `node:fs`, no
 * `node:crypto`, and no `bun:sqlite`, and M0 must hash a document and mint two
 * random ids while M1 must allocate a megabyte. So the sequencing lives there
 * and the syscalls live here, exactly as they do for M2-M7.
 */
import crypto from "node:crypto";
import fs, { constants as O } from "node:fs";
import path from "node:path";
import { fsyncDirectory } from "../store/artifact-proof.js";
import type { EntryProof, HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths } from "../paths.js";
import { loadConfigIfPresent, syncStreamId } from "../../workspace-config.js";
import { admitMigration, admitMigrationBudget, type AdmissionRefusal } from "./admission.js";
import { observeLegacyAuthority, observePath } from "./artifact-observation.js";
import type { PhaseReceipt } from "./classifier.js";
import {
  CONTROL_MAX_BYTES, type AdmissionProof, type HaltResource, type Inode, type MigrationControl, type SourceWitness,
} from "./control-codec.js";
import { FIRST_CONTROL_REVISION, publishMigrationControl } from "./control-publication.js";
import { admitMigrationDisk } from "./disk-preflight.js";
import { bracketSource, fsyncFileAndParent, halt, requirePhase } from "./phase-io.js";
import { ensureStateReserve, RESERVE_TOTAL_BYTES, stateReservePath } from "./reserve.js";

/**
 * The emergency candidate's fixed size: exactly one canonical control record's
 * ceiling. It exists so a halt publication that cannot allocate has somewhere to
 * put ONE record, and 163 never gives it a size — so it is derived from the one
 * bound that decides what it must cover rather than picked. Zero-filled, so its
 * bytes are a pure function of its length and every attempt renders the same
 * record for it (design 222 §M-2's 1A pin).
 */
export const EMERGENCY_CANDIDATE_BYTES = CONTROL_MAX_BYTES;

export type BeginOutcome =
  | { readonly kind: "began"; readonly control: MigrationControl }
  | { readonly kind: "refused"; readonly refusal: AdmissionRefusal };

/** M1's own witness layer plus the two resources it makes releasable. Returned
 * rather than published, exactly as M2-M5 return their layers: the driver owns
 * every durable transition so the phase order lives in one place. */
export interface RunwayWitness {
  readonly admission: AdmissionProof;
  readonly resources: MigrationControl["haltResources"];
}

const hex32 = (): string => crypto.randomBytes(16).toString("hex");
const digest = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");

async function streamId(root: string): Promise<string> {
  const config = await loadConfigIfPresent(root).catch(() => undefined);
  const stream = config ? syncStreamId(config) : undefined;
  // The reserve's provenance is bound to the stream, so a workspace without a
  // durable config cannot prove which reserve is its own. Refusing here is the
  // same fail-closed judgement `withStatePlaneLocks` makes about reset recovery.
  return stream ?? halt("reserved-path", false, "this workspace has no durable config stream to bind its reserve to");
}

/**
 * The source as M0 records it, read fresh rather than taken from the classifier's
 * observation. 222 §5.2's M0 row publishes "after fresh identity/hash": the
 * classifier's read happened before admission, and admission deliberately waits
 * on a bounded quiet interval, so its witness is exactly as old as that wait.
 */
async function freshSource(root: string): Promise<SourceWitness> {
  const legacy = await observeLegacyAuthority(root);
  return legacy.kind === "json"
    ? legacy.witness
    : halt("verification", false, `the legacy document is ${legacy.kind}, not the JSON source M0 requires`);
}

const identical = (a: SourceWitness, b: SourceWitness): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.bytes === b.bytes && a.mtimeNs === b.mtimeNs && a.sha256 === b.sha256;

/**
 * M0. Admit, bracket the source twice around the id mint, and publish the first
 * control — the only publication in the whole protocol with no predecessor.
 *
 * A failure here is an IN-PROCESS halt only (222 §5.2). There is no control to
 * CAS a halt revision against, so nothing durable can record it; the driver
 * reports it with `durableHalt: false` and the workspace is byte-identical.
 *
 * KNOWN, not blocking (for doctor/quarantine): a crash between the id mint and the
 * first control's rename leaks one inert ~1 KiB revision temp per crash, because
 * re-entry mints a FRESH id and the dead id's temp is named by nothing durable.
 * `control-sibling.ts`'s strand repair cannot reach it (it is scoped to the live
 * id), and it is harmless — an unreferenced temp, never adopted — but it is
 * doctor's inert-temp quarantine to sweep, 163's designated sole remover. Noted
 * here so the sweep's scope is on record.
 */
export async function beginMigration(root: string, entry: EntryProof): Promise<BeginOutcome> {
  const admitted = await admitMigration(root, entry);
  if (admitted.outcome === "refused") return { kind: "refused", refusal: admitted.refusal };

  const stream = await streamId(root);
  const observed = await freshSource(root);
  const budget = await admitMigrationBudget(root, observed.bytes, stream);
  if (budget.outcome === "refused") return { kind: "refused", refusal: budget.refusal };
  if (budget.outcome === "halted") throw haltOf(budget.halt);

  const migrationId = hex32();
  const authorityId = hex32();
  // The second bracket. The mint is pure, but the budget admission above is not:
  // it stats the reserve and measures RSS, so the document could have moved under
  // it. Publishing a source witness that was already stale would make every later
  // `bracketSource` refuse a migration that never had a chance.
  const source = await freshSource(root);
  if (!identical(observed, source)) {
    halt("verification", false, "the legacy document changed while M0 was admitting it");
  }
  const control: MigrationControl = {
    version: 1,
    controlRevision: FIRST_CONTROL_REVISION,
    migrationId,
    authorityId,
    source,
    stagingPath: migrationPaths.staging(root, migrationId),
    witness: { phase: "M0" },
    haltResources: { reserve: { disposition: "not-created" }, emergency: { disposition: "not-created" } },
    halt: null,
    retirement: null,
  };
  return {
    kind: "began",
    control: publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control, entry.locks),
  };
}

/** `admitMigrationBudget` reports its halts as verdicts; the phase bodies raise
 * theirs. One conversion, so the driver sees exactly one halt channel. */
function haltOf(value: { code: Parameters<typeof halt>[0]; required: number | null; available: number | null }): never {
  return halt(value.code, false, `admission refused ${value.code}`, {
    ...(value.required === null ? {} : { required: value.required }),
    ...(value.available === null ? {} : { available: value.available }),
  });
}

/**
 * M1. The disk envelope, the claimed reserve, and the emergency candidate — the
 * two resources a halt below M6 may spend to publish itself.
 *
 * Both are recorded `available` with identity, length, and WHOLE-file digest,
 * because that is the evidence `releaseHaltResource` re-proves before it unlinks
 * one. The cleanup vector's role-7 item compares the first 128 bytes instead;
 * design 222 §M-8 warns that these two digests describe the same file and that
 * nothing cross-checks them, so this module records the one its own consumer
 * verifies and never the other.
 */
export async function provisionRunway(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<RunwayWitness> {
  void locks;
  const control = requirePhase(receipt, "M0");
  const source = bracketSource(control);
  const stream = await streamId(root);

  const budget = await admitMigrationBudget(root, source.bytes, stream);
  if (budget.outcome === "halted") throw haltOf(budget.halt);
  if (budget.outcome === "refused") {
    // Unreachable through the driver: M0 admitted the same reserve one phase ago
    // under this same lock bundle. It stays because a damaged reserve must fail
    // closed rather than reach the claim below.
    return halt("reserved-path", false, `the migration reserve is ${budget.refusal.detail}`);
  }
  const disk = await admitMigrationDisk(root, source.bytes);
  if (disk.outcome === "halted") throw haltOf(disk.halt);

  return {
    admission: budget.proof,
    resources: {
      reserve: await claimReserve(root, stream),
      emergency: createEmergencyCandidate(root, control.migrationId),
    },
  };
}

/**
 * Recreate whatever a halt spent, so bucket 1 can clear it (design 222 §M-6's
 * constraint on the wave that introduces halt clearing). Re-claiming is
 * idempotent: an intact resource is adopted under its own identity and nothing
 * is truncated or replaced.
 *
 * This is why 5A needs neither of the two escapes §M-6 offered — a halt is never
 * cleared while either resource is missing, so a cleared M5 halt reaches the
 * flip with the full two-item vector it started with.
 */
export async function restoreHaltRunway(
  root: string, control: MigrationControl,
): Promise<MigrationControl["haltResources"]> {
  const stream = await streamId(root);
  return {
    reserve: await claimReserve(root, stream),
    emergency: createEmergencyCandidate(root, control.migrationId),
  };
}

async function claimReserve(root: string, stream: string): Promise<HaltResource> {
  const outcome = await ensureStateReserve(root, stream);
  if (outcome.status === "reserve-foreign") {
    return halt("reserved-path", false, `the migration reserve is ${outcome.detail}`);
  }
  if (outcome.status === "unavailable") {
    return halt("filesystem-full", false, `the migration reserve could not be established (${outcome.detail})`);
  }
  const file = stateReservePath(root);
  const observed = observePath(file, true);
  if (observed.state !== "regular" || observed.sha256 === null || observed.bytes !== RESERVE_TOTAL_BYTES) {
    return halt("reserved-path", true, `${file} is not the reserve this phase just claimed`);
  }
  return {
    disposition: "available",
    dev: observed.dev, ino: observed.ino, bytes: observed.bytes, sha256: observed.sha256,
  };
}

/**
 * The emergency candidate: id-scoped, so it is never a foreign path to anyone
 * else, and created exclusively. Three admitted occupant images, and the same
 * adopt-then-repair discipline `control-sibling.ts` applies to a control strand,
 * for the same reason — a kill between the create and the fsync must not wedge the
 * phase, and here the wedge is worse: ENOSPC is *the* condition this file exists
 * to survive, and the reserve half is immune only because `ensureStateReserve`
 * writes-a-temp-and-renames while this path is created in place.
 *
 * - the exact zero-filled record already fsynced → adopt;
 * - this migration's OWN torn write (a strictly shorter all-zero prefix) →
 *   repair in place on its recorded inode, never unlink-and-recreate;
 * - anything else (nonzero bytes, over-length, a symlink, a directory) → refuse.
 */
function createEmergencyCandidate(root: string, migrationId: string): HaltResource {
  const file = migrationPaths.emergency(root, migrationId);
  const bytes = Buffer.alloc(EMERGENCY_CANDIDATE_BYTES);
  const existing = observePath(file, true);
  if (existing.state === "foreign") return halt("reserved-path", false, `${file} is not a regular file`);
  if (existing.state === "regular") {
    if (existing.bytes === bytes.byteLength && existing.sha256 === digest(bytes)) {
      fsyncFileAndParent(file);
      return available(existing.dev, existing.ino, bytes);
    }
    // A strictly shorter all-zero image is the only thing a torn own write leaves:
    // `writeSync` fills from offset 0 with the zero buffer. Repair it in place.
    if (existing.bytes < bytes.byteLength && existing.sha256 === digest(Buffer.alloc(existing.bytes))) {
      return rewriteEmergencyStrand(file, bytes, existing);
    }
    return halt("reserved-path", false, `${file} is occupied by something other than this migration's candidate`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(file, O.O_CREAT | O.O_EXCL | O.O_WRONLY | O.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    if (code === "ENOSPC" || code === "EDQUOT") {
      return halt("filesystem-full", false, `${file} could not be allocated (${code})`);
    }
    return halt("reserved-path", false, `${file} could not be created exclusively (${code})`);
  }
  try {
    fs.writeSync(fd, bytes, 0, bytes.byteLength, 0);
    fs.fsyncSync(fd);
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    fs.closeSync(fd);
    // The partial file is this migration's own id-scoped path and the next
    // attempt adopts or rejects it by content; it is never left as runway.
    if (code === "ENOSPC" || code === "EDQUOT") {
      return halt("filesystem-full", true, `${file} could not be filled (${code})`);
    }
    return halt("reserved-path", true, `${file} could not be written (${code})`);
  }
  fs.closeSync(fd);
  fsyncDirectory(path.dirname(file));
  const written = observePath(file, true);
  if (written.state !== "regular" || written.bytes !== bytes.byteLength || written.sha256 !== digest(bytes)) {
    return halt("verification", true, `${file} is not the candidate just written`);
  }
  return available(written.dev, written.ino, bytes);
}

/** Repair this migration's own torn emergency-candidate write, in place on the
 * recorded inode — the `control-sibling.ts::rewriteStrand` shape. The inode is
 * re-bracketed on the write descriptor, `O_NONBLOCK` so a FIFO swapped in cannot
 * hang the open, and the result is re-observed byte-for-byte. */
function rewriteEmergencyStrand(file: string, bytes: Buffer, recorded: Inode): HaltResource {
  const fd = fs.openSync(file, O.O_WRONLY | O.O_NOFOLLOW | O.O_NONBLOCK);
  try {
    const observed = fs.fstatSync(fd);
    if (!observed.isFile() || Number(observed.dev) !== recorded.dev || Number(observed.ino) !== recorded.ino) {
      return halt("reserved-path", false, `${file} stopped being the strand just observed`);
    }
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, bytes, 0, bytes.byteLength, 0);
    fs.fsyncSync(fd);
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    fs.closeSync(fd);
    if (code === "ENOSPC" || code === "EDQUOT") return halt("filesystem-full", true, `${file} could not be refilled (${code})`);
    return halt("reserved-path", true, `${file} could not be rewritten (${code})`);
  }
  fs.closeSync(fd);
  fsyncDirectory(path.dirname(file));
  const written = observePath(file, true);
  if (written.state !== "regular" || written.bytes !== bytes.byteLength || written.sha256 !== digest(bytes)) {
    return halt("verification", true, `${file} is not the candidate just repaired`);
  }
  return available(written.dev, written.ino, bytes);
}

const available = (dev: number, ino: number, bytes: Buffer): HaltResource =>
  ({ disposition: "available", dev, ino, bytes: bytes.byteLength, sha256: digest(bytes) });
