/**
 * M-6, first half: the prepared database takes the active name, and the 58-byte
 * authority marker is rendered at its revision-scoped sibling (design 222 §M-6;
 * design 163 phases M5 and M6, :3289).
 *
 * M-6 ships as two files for the same reason M-8 did: 163:3994's ceiling is not
 * negotiable and the honest implementation is 475 lines. The seam is the flip
 * itself. Here, legacy JSON is authority from the first line to the last: M5
 * moves the proven database onto `state.db`, and the Q ladder walks the sibling
 * through `absent -> building -> exact`. `authority-flip.ts` owns the single
 * rename that elects SQLite, and imports the receipt guard, the marker bytes,
 * and the sibling fence from here — never the reverse, so the split cannot
 * become a cycle.
 *
 * Two rules govern every line across both halves.
 *
 * - **The rename is the boundary.** Every refusal before it leaves a fully
 *   determinate state and says so (`wrote: false` where nothing was mutated);
 *   only a fault at or after `fs.rename` is `durability-indeterminate`
 *   (163:2988). Misreporting a pre-rename CAS refusal as indeterminate would
 *   block SQLite writes over a workspace nothing touched.
 * - **This module owns the staging inode, and after the flip the active DB.**
 *   It opens neither. Every judgement is file-level — identity, length, and
 *   digest through one no-follow descriptor — because a read-only SQLite open of
 *   a checkpointed WAL database creates `-wal`/`-shm` and leaves them, and "any
 *   sidecar halts" is a precondition of the M4 -> M5 -> M6 resume rows (163 v13's
 *   ownership rule, lane 4A).
 *
 * Everything either half renders is a pure function of durable facts, because a
 * crash inside the publisher's render -> rename window strands the record: the Q
 * sibling's bytes come from the authority id, and the M6 cleanup vector's paths
 * are derived per role with identities taken from the control's own resources.
 */
import crypto from "node:crypto";
import fs, { constants as O } from "node:fs";
import path from "node:path";
import { AUTHORITY_MARKER_BYTES, authorityMarkerBytes } from "../authority-marker.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths, sqliteResetPaths } from "../paths.js";
import { fsyncDbAndParent, requireDbArtifactS0 } from "../reset/artifacts.js";
import { fsyncDirectory } from "../store/artifact-proof.js";
import { isForeign, observePath, observeQSibling, observeSidecars } from "./artifact-observation.js";
import type { PhaseReceipt } from "./classifier.js";
import type {
  Inode, M5Witness, MigrationControl, MigrationWitness, QSiblingWitness, StagingProof,
} from "./control-codec.js";
import { publishMigrationControl, type PublishExpectation } from "./control-publication.js";
import { bracketSource, halt, requirePhase } from "./phase-io.js";

export type M5State = Extract<MigrationWitness, { phase: "M5" }>;

/** One durable rung of the Q ladder. `ready` publishes nothing: the sibling is
 * already exact and the flip is the next call. */
export interface QSiblingStep {
  readonly kind: "claimed" | "written" | "ready";
  readonly control: MigrationControl;
}

export const digestOfBytes = (bytes: Uint8Array): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");
export const expectationFor = (control: MigrationControl): PublishExpectation =>
  ({ migrationId: control.migrationId, revision: control.controlRevision });

/**
 * The M5 receipt and its own witness layer.
 *
 * The second check is unreachable and stays. `PhaseReceipt` derives `phase` from
 * the control it was minted from, so `requirePhase` already settles it — the
 * mutation sweep reports replacing this line with a cast as an equivalent mutant,
 * and it is. What the line actually buys is the narrowing: it is how `M5State`
 * comes out of the witness union without a cast, which is what keeps three
 * functions from reading fields off a witness that may not carry them. The
 * `prove-staging.ts` M3 body has the identical pair for the identical reason.
 */
export function m5(receipt: PhaseReceipt): { control: MigrationControl; witness: M5State } {
  const control = requirePhase(receipt, "M5");
  if (control.witness.phase !== "M5") throw new TypeError("an M5 receipt must carry an M5 witness");
  return { control, witness: control.witness };
}

/** The exact 58 bytes `Q` will hold. The codec's id charset admits strings
 * `authorityMarkerBytes` refuses, so this is a real refusal rather than a cast. */
export function markerBytes(control: MigrationControl): Buffer {
  try {
    return authorityMarkerBytes(control.authorityId);
  } catch {
    return halt("verification", false, `${control.authorityId} cannot be published as an authority marker`);
  }
}

/** The one path a Q sibling may hold, and the one digest it may carry. A control
 * read back from disk is a record, and the next acts on this path are a create,
 * a write, and a rename over the live state document. */
export function requireSibling(
  root: string, control: MigrationControl, witness: QSiblingWitness, marker: Buffer,
): string {
  if (witness.path !== migrationPaths.qSibling(root, control.migrationId)) {
    halt("reserved-path", false, `${witness.path} is not the Q sibling this migration derives to`);
  }
  if (witness.sha256 !== digestOfBytes(marker)) {
    halt("verification", false, `${witness.path} is recorded under bytes that are not this authority's marker`);
  }
  return witness.path;
}

// ---------------------------------------------------------------------------
// M5 — the prepared database takes the active name.

/**
 * Absent, or exactly the database M4 proved, from one no-follow descriptor.
 * Present-but-different is a refusal; nothing here repairs a database.
 *
 * The digest is the whole test. An earlier draft also compared the recorded
 * length, and the mutation sweep reported dropping it as an equivalent mutant —
 * a file cannot reproduce a SHA-256 at a different length. `classifier.ts`'s
 * `matchesProof` deleted the same redundant conjunct for the same reason, so the
 * two readers of a `StagingProof` now agree on what "is it ours" means.
 */
function proveDatabase(file: string, proof: StagingProof): Inode | "absent" {
  const observed = observePath(file, true);
  if (observed.state === "absent") return "absent";
  if (observed.state !== "regular") return halt("reserved-path", false, `${file} is not a regular file`);
  if (observed.sha256 !== proof.sha256) {
    return halt("verification", false, `${file} is not the database this migration proved`);
  }
  return { dev: observed.dev, ino: observed.ino };
}

/**
 * M5. Rename staging over `state.db`, remove only a redundant exact staging
 * name, require staging absent and the active database `S0`, fsync, and return
 * the witness M-9 publishes. Legacy JSON stays authority throughout (163:3289).
 *
 * Three images are admitted, because the rename may have run ahead of the
 * publication: staging-only, active-only, and both-exact. Active never moves
 * backward — when it already holds the proven database the staging name is the
 * redundant one and it is what goes.
 */
export async function publishPreparedDatabase(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<M5Witness> {
  void locks;
  const control = requirePhase(receipt, "M4");
  bracketSource(control);
  const witness = control.witness;
  if (witness.phase !== "M4") throw new TypeError("an M4 receipt must carry an M4 witness");
  // Before anything moves. The witness this phase publishes prebinds the marker's
  // digest, so an authority id the marker cannot express makes M5 unpublishable —
  // and computing that at the END would refuse only after the rename, reporting a
  // zero-write refusal that had already renamed a database.
  const marker = markerBytes(control);
  const staging = control.stagingPath;
  if (staging !== migrationPaths.staging(root, control.migrationId)) {
    halt("reserved-path", false, "the control's staging path is not the one its migration id derives to");
  }
  const active = sqliteResetPaths.active(root);
  for (const file of [staging, active]) {
    if (observeSidecars(file).length > 0) {
      halt("reserved-path", false, `${file} carries sidecars, which M4 left at rest`);
    }
  }
  const proof = witness.staging;
  const recorded = witness.stagingMain;
  const staged = proveDatabase(staging, proof);
  if (staged !== "absent" && recorded.state === "present"
    && (staged.dev !== recorded.dev || staged.ino !== recorded.ino)) {
    halt("reserved-path", false, `${staging} is not the staging inode this migration recorded`);
  }
  const settled = proveDatabase(active, proof);

  // Active first, because "never move active backward" is the rule that decides
  // two of the three images: once it holds the proven database, a staging name
  // beside it is the redundant one and it is what goes.
  let expected: Inode;
  if (settled !== "absent") {
    expected = settled;
    if (staged !== "absent") fs.unlinkSync(staging);
  } else if (staged !== "absent") {
    expected = staged;
    fs.renameSync(staging, active);
  } else {
    return halt("verification", false, "neither the staging nor the active name holds the database M4 proved");
  }
  if (observePath(staging).state !== "absent") {
    return halt("reserved-path", true, `${staging} still holds a file after the active name was published`);
  }
  let atRest;
  try {
    atRest = await requireDbArtifactS0(active);
  } catch (error) {
    return halt("durability-indeterminate", true, `${active} did not come to rest (${String(error)})`);
  }
  if (Number(atRest.dev) !== expected.dev || Number(atRest.ino) !== expected.ino
    || Number(atRest.size) !== proof.bytes) {
    halt("verification", true, `${active} is not the database this phase published`);
  }
  await fsyncDbAndParent(active);
  return {
    active: proof,
    qSibling: {
      path: migrationPaths.qSibling(root, control.migrationId),
      bytes: AUTHORITY_MARKER_BYTES,
      sha256: digestOfBytes(marker),
      disposition: { state: "absent" },
    },
  };
}

// ---------------------------------------------------------------------------
// The Q ladder — absent -> building -> exact, one durable rung per call.

/** Create the sibling exclusively, or adopt the sole admitted create-ahead: one
 * no-follow regular 0600 zero-byte inode. Nothing else at the path is adopted,
 * truncated, or removed (163:3298). */
function claimSibling(file: string): Inode {
  let fd: number;
  let created = true;
  try {
    fd = fs.openSync(file, O.O_CREAT | O.O_EXCL | O.O_WRONLY | O.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = fs.openSync(file, O.O_RDONLY | O.O_NOFOLLOW | O.O_NONBLOCK);
    created = false;
  }
  try {
    const found = fs.fstatSync(fd);
    if (!created && (!found.isFile() || Number(found.size) !== 0 || (Number(found.mode) & 0o7777) !== 0o600)) {
      halt("reserved-path", false, `${file} is neither absent nor the sole zero-byte create-ahead`);
    }
    fs.fsyncSync(fd);
    fsyncDirectory(path.dirname(file));
    return { dev: Number(found.dev), ino: Number(found.ino) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Rewrite the RECORDED inode from offset zero and truncate to exactly 58 bytes.
 * No temp, no second inode, no rename: a kill mid-write leaves a partial image
 * of the one inode the durable record names, which is what `building` admits.
 * The identity is re-proven on the write descriptor itself, because between the
 * caller's observation and this open the path can be replaced. */
function writeMarker(file: string, recorded: Inode, marker: Buffer, sha256: string): void {
  const fd = fs.openSync(file, O.O_WRONLY | O.O_NOFOLLOW | O.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (Number(stat.dev) !== recorded.dev || Number(stat.ino) !== recorded.ino) {
      halt("reserved-path", false, `${file} changed identity before the marker was written`);
    }
    if (fs.writeSync(fd, marker, 0, marker.byteLength, 0) !== marker.byteLength) {
      halt("filesystem-full", true, `${file} took only part of the authority marker`);
    }
    fs.ftruncateSync(fd, marker.byteLength);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(file));
  const observed = observePath(file, true);
  if (observed.state !== "regular" || observed.dev !== recorded.dev || observed.ino !== recorded.ino
    || observed.bytes !== marker.byteLength || observed.sha256 !== sha256) {
    halt("verification", true, `${file} is not the marker just written`);
  }
}

function publishSibling(
  root: string, control: MigrationControl, witness: M5State,
  disposition: QSiblingWitness["disposition"], locks: HeldStatePlaneLocks,
): MigrationControl {
  const next: MigrationControl = {
    ...control,
    controlRevision: control.controlRevision + 1,
    witness: { ...witness, qSibling: { ...witness.qSibling, disposition } },
  };
  return publishMigrationControl(root, expectationFor(control), next, locks);
}

/** One rung. The recorded disposition — never the observation — decides which
 * step runs; the observation only decides whether this workspace is on an
 * admitted image of that step at all. */
export async function stepQSibling(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<QSiblingStep> {
  const { control, witness } = m5(receipt);
  bracketSource(control);
  const marker = markerBytes(control);
  const file = requireSibling(root, control, witness.qSibling, marker);
  const observed = observeQSibling(witness.qSibling);
  if (isForeign(observed)) return halt("reserved-path", false, observed.foreign);
  const recorded = witness.qSibling.disposition;
  // Under an `exact` record `observeQSibling` returns `exact` or foreign and
  // nothing else, so the refusal above already covers the only bad image. A
  // second check here was dead code the mutation sweep could not kill; the flip
  // re-proves the image itself before it renames, which is where it matters.
  if (recorded.state === "exact") return { kind: "ready", control };
  if (recorded.state === "absent") {
    const disposition = { state: "building", ...claimSibling(file) } as const;
    return { kind: "claimed", control: publishSibling(root, control, witness, disposition, locks) };
  }
  // Recorded `building`. The sole finish-ahead image is the recorded inode
  // already holding the exact 58 bytes; anything shorter is rewritten.
  if (observed.state !== "exact") writeMarker(file, recorded, marker, witness.qSibling.sha256);
  return {
    kind: "written",
    control: publishSibling(root, control, witness, { state: "exact", dev: recorded.dev, ino: recorded.ino }, locks),
  };
}

