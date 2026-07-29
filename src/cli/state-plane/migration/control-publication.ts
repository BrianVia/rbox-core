/**
 * Every durable transition of the canonical migration control (design 163
 * § "Durable phase publication and sole actor", :2692).
 *
 * This module is the ONLY writer of `.rbox/state/migration-v1.json`. Ordinary
 * publication and prepared-sibling promotion share one private replacement
 * primitive, so neither can grow its own rename: revalidate the target under
 * `expect`, no-follow revalidate the source inode/length/hash/canonical bytes,
 * rename, fsync `.rbox/state`, reread exactly.
 *
 * Synchronous throughout. It runs once per phase under the complete lock set,
 * and the state-plane write fence that consumes `readCanonicalControl` is itself
 * synchronous, so an async surface would buy interleaving nobody wants.
 *
 * `locks` is a compile-time witness that the complete lock set is held; it has
 * no runtime use and must not grow one.
 */
import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { MigrationControlError, type MigrationControlErrorReason } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths } from "../paths.js";
import {
  CONTROL_MAX_BYTES, decodeMigrationControl, encodeMigrationControl,
  type Inode, type MigrationControl,
} from "./control-codec.js";
import type { MigrationHalt } from "./health.js";

/** The revision of a migration's first published control. */
export const FIRST_CONTROL_REVISION = 1;

/** What the canonical control must be right now for a publication to proceed.
 * Both members are `"absent"` together, or neither is. */
export interface PublishExpectation {
  readonly migrationId: string | "absent";
  readonly revision: number | "absent";
}

/** A rendered, fsynced, revision-scoped sibling: exactly the bytes of one
 * control record, identified by inode as well as path. */
export interface PreparedControlIdentity extends Inode {
  readonly path: string;
  readonly revision: number;
  readonly bytes: number;
  readonly sha256: string;
}

/** Discriminated so the nondurable branch carries NO next control: a caller
 * cannot keep publishing after a failed halt (163:3346). */
export type HaltPublication =
  | { readonly durable: true; readonly control: MigrationControl }
  | { readonly durable: false; readonly reason: unknown };

type HaltResourceRole = "reserve" | "emergency";

const digest = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const fail: (reason: MigrationControlErrorReason, detail: string) => never = (reason, detail) => {
  throw new MigrationControlError(reason, detail);
};

function fsyncDirectorySync(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** One no-follow descriptor decides type, identity, and bytes: a second pathname
 * lookup could be answered by a symlink swapped in after the first. */
function readExactFile(file: string): { bytes: Buffer; dev: number; ino: number } | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return fail("schema", `${file} could not be opened as a regular file (${code})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return fail("schema", `${file} is not a regular file`);
    if (stat.size > CONTROL_MAX_BYTES) return fail("schema", `${file} is ${stat.size} bytes, over the ${CONTROL_MAX_BYTES} cap`);
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, bytes.byteLength, 0) !== bytes.byteLength) return fail("schema", `${file} was truncated while reading`);
    return { bytes, dev: Number(stat.dev), ino: Number(stat.ino) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Remove a sibling this process created, and only if the path still holds the
 * exact inode it recorded. Cleanup on a caught failure only: a crash leaves the
 * inert revision temp 163's `absent` crash row already admits. */
function removeOwnSibling(prepared: PreparedControlIdentity): void {
  try {
    const observed = fs.lstatSync(prepared.path);
    if (!observed.isFile() || Number(observed.dev) !== prepared.dev || Number(observed.ino) !== prepared.ino) return;
    fs.unlinkSync(prepared.path);
    fsyncDirectorySync(path.dirname(prepared.path));
  } catch {
    // Best effort: the sibling is inert either way.
  }
}

export function readCanonicalControl(root: string): MigrationControl | undefined {
  const exact = readExactFile(migrationPaths.control(root));
  return exact && decodeMigrationControl(exact.bytes);
}

function assertExpectation(current: MigrationControl | undefined, expect: PublishExpectation): void {
  const absent = expect.migrationId === "absent";
  if (absent !== (expect.revision === "absent")) fail("cas", "expectation mixes an absent control with an exact revision");
  if (absent) {
    if (current) fail("cas", `expected no control, found ${current.migrationId} revision ${current.controlRevision}`);
    return;
  }
  if (!current) fail("cas", `expected ${String(expect.migrationId)} revision ${String(expect.revision)}, found no control`);
  else if (current.migrationId !== expect.migrationId || current.controlRevision !== expect.revision) {
    fail("cas", `expected ${String(expect.migrationId)} revision ${String(expect.revision)}, found ${current.migrationId} revision ${current.controlRevision}`);
  }
}

/** Revisions are safe integers, exactly spaced. `r -> r+2` is the single
 * permitted gap and only a prepared promotion may take it (163:3008, :2919). */
function assertRevisionStep(expect: PublishExpectation, next: number, allowGapTwo: boolean): void {
  if (expect.revision === "absent") {
    if (next !== FIRST_CONTROL_REVISION) fail("cas", `a first control must be revision ${FIRST_CONTROL_REVISION}, not ${next}`);
    return;
  }
  const step = next - expect.revision;
  if (step === 1 || (allowGapTwo && step === 2)) return;
  fail("cas", `revision ${expect.revision} may not advance to ${next}`);
}

/**
 * The one canonical replacement. Every durable control write lands here, and no
 * entry point implements its own rename.
 */
function replaceCanonicalControl(
  root: string, expect: PublishExpectation, source: PreparedControlIdentity, locks: HeldStatePlaneLocks,
): MigrationControl {
  void locks;
  assertExpectation(readCanonicalControl(root), expect);
  const exact = readExactFile(source.path);
  if (!exact || exact.dev !== source.dev || exact.ino !== source.ino
    || exact.bytes.byteLength !== source.bytes || digest(exact.bytes) !== source.sha256) {
    fail("prepared-foreign", `${source.path} is not the recorded inode, length, and hash`);
  }
  const bytes = exact.bytes;
  const next = decodeMigrationControl(bytes);
  if (next.controlRevision !== source.revision) {
    fail("prepared-foreign", `${source.path} carries revision ${next.controlRevision}, not ${source.revision}`);
  }
  const file = migrationPaths.control(root);
  fs.renameSync(source.path, file);
  fsyncDirectorySync(path.dirname(file));
  const published = readExactFile(file);
  if (!published || !published.bytes.equals(bytes)) fail("reread", `${file} is not the record just published`);
  return next;
}

/**
 * Render one exclusive revision-scoped sibling: create, write, fsync the file,
 * fsync `.rbox/state`, then reread it exactly. Used both for an ordinary
 * publication's own temp and for the M6 runway's prepared future controls —
 * they are the same namespace.
 */
export function renderPreparedControl(
  root: string, revision: number, next: MigrationControl, locks: HeldStatePlaneLocks,
): PreparedControlIdentity {
  void locks;
  if (next.controlRevision !== revision) fail("schema", `record revision ${next.controlRevision} may not be rendered at ${revision}`);
  const bytes = encodeMigrationControl(next);
  const file = migrationPaths.controlRevision(root, next.migrationId, revision);
  const fd = fs.openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      fs.writeSync(fd, bytes, 0, bytes.byteLength, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectorySync(path.dirname(file));
    const exact = readExactFile(file);
    if (!exact || !exact.bytes.equals(bytes)) return fail("reread", `${file} is not the record just rendered`);
    return { path: file, revision, dev: exact.dev, ino: exact.ino, bytes: bytes.byteLength, sha256: digest(bytes) };
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
}

export function publishMigrationControl(
  root: string, expect: PublishExpectation, next: MigrationControl, locks: HeldStatePlaneLocks,
): MigrationControl {
  assertRevisionStep(expect, next.controlRevision, false);
  const prepared = renderPreparedControl(root, next.controlRevision, next, locks);
  try {
    return replaceCanonicalControl(root, expect, prepared, locks);
  } catch (error) {
    removeOwnSibling(prepared);
    throw error;
  }
}

/**
 * Promote an ALREADY-EXACT prepared sibling. No temp, no write, no truncate:
 * the shared primitive's pre-rename revalidation of the recorded inode, byte
 * length, SHA-256, and canonical bytes for this fixed revision is the whole
 * admission test, and anything else is foreign and is not renamed.
 */
export function promotePreparedControl(
  root: string, expect: PublishExpectation, prepared: PreparedControlIdentity, locks: HeldStatePlaneLocks,
): MigrationControl {
  assertRevisionStep(expect, prepared.revision, true);
  return replaceCanonicalControl(root, expect, prepared, locks);
}

/** ENOSPC and EDQUOT are the two conditions the prebuilt runway exists for. */
const isOutOfSpace = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
};

/**
 * What this halt may release to make its own publication possible, in order.
 * Only a resource recorded `available` qualifies, and none does while a
 * retirement or M6 cleanup cursor is running — those resources are vector items,
 * and a halt consumes no vector item as runway (163:3343).
 */
function haltRunway(control: MigrationControl): readonly HaltResourceRole[] {
  const cursorActive = control.retirement !== null
    || control.witness.phase === "M6" || control.witness.phase === "M7";
  if (cursorActive) return [];
  return (["reserve", "emergency"] as const).filter((role) => control.haltResources[role].disposition === "available");
}

function releaseHaltResource(root: string, control: MigrationControl, role: HaltResourceRole): void {
  const recorded = control.haltResources[role];
  if (recorded.disposition !== "available") fail("cas", `${role} is ${recorded.disposition}, not available`);
  const file = role === "reserve" ? migrationPaths.reserve(root) : migrationPaths.emergency(root, control.migrationId);
  const observed = fs.lstatSync(file);
  if (!observed.isFile() || Number(observed.dev) !== recorded.dev
    || Number(observed.ino) !== recorded.ino || observed.size !== recorded.bytes) {
    fail("prepared-foreign", `${file} is not the recorded ${role}`);
  }
  fs.unlinkSync(file);
  fsyncDirectorySync(path.dirname(file));
}

/**
 * Publish the same phase at the next revision with the exact halt and the
 * updated resource dispositions. If publication needs space it releases the
 * exact previously-`available` resources in order and records each
 * `consumed-for-halt`; it never relabels a current intent, because an intent is
 * never `available`.
 */
export function publishMigrationHalt(
  root: string, control: MigrationControl, halt: MigrationHalt, locks: HeldStatePlaneLocks,
): HaltPublication {
  const expect: PublishExpectation = { migrationId: control.migrationId, revision: control.controlRevision };
  const runway = haltRunway(control);
  let haltResources = control.haltResources;
  for (let attempt = 0; ; attempt++) {
    const next: MigrationControl = { ...control, controlRevision: control.controlRevision + 1, halt, haltResources };
    try {
      return { durable: true, control: publishMigrationControl(root, expect, next, locks) };
    } catch (error) {
      const role = runway[attempt];
      if (role === undefined || !isOutOfSpace(error)) return { durable: false, reason: error };
      try {
        releaseHaltResource(root, control, role);
      } catch {
        return { durable: false, reason: error };
      }
      haltResources = { ...haltResources, [role]: { disposition: "consumed-for-halt" } };
    }
  }
}
