/**
 * M-6, second half: the one authority flip (design 222 §M-6; design 163 phase
 * M6, :3295).
 *
 * `finalize.ts` builds everything this file renames. Here there is exactly one
 * `fs.rename`, and it is the only operation in the product that elects SQLite as
 * the state plane's authority. Everything before it is evidence; everything
 * after it is durability.
 *
 * The last three statements of the pre-flip path are the design's whole point:
 * re-read the live document's body digest, compare it to the digest M3 imported,
 * rename. Nothing sits between the comparison and the rename — no fsync, no hash
 * of another file, no logging — which reduces the pre-`1.11.0` lost-write
 * exposure to those two instants (163:3311). It is explicitly not atomic, and
 * the design says so; this file must not grow a statement in that gap.
 *
 * Refusals here are typed by which side of the rename they are on. Before it,
 * every refusal leaves `.rbox` exactly as it found it and reports `wrote: false`.
 * At or after it, a fault is `durability-indeterminate` and nothing lower is
 * published: the workspace sits on the `M5 + exact Q` row, which SQLite writes
 * are already fenced against, and a restart completes the parent fsync and the
 * M6 publication rather than renaming anything back.
 */
import crypto from "node:crypto";
import fs, { constants as O } from "node:fs";
import path from "node:path";
import { MigrationControlError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths, sqliteResetPaths, statePath } from "../paths.js";
import { fsyncDirectory } from "../store/artifact-proof.js";
import {
  isForeign, observePath, observeQSibling, observeSidecars, type PathObservation,
} from "./artifact-observation.js";
import type { PhaseReceipt } from "./classifier.js";
import type {
  ArtifactItem, ArtifactWitness, C1Trigger, Cursor, HaltResource, MigrationControl, SourceWitness,
} from "./control-codec.js";
import { publishMigrationControl } from "./control-publication.js";
import {
  expectationFor, m5, markerBytes, requireSibling, digestOfBytes, type M5State,
} from "./finalize.js";
import { halt } from "./phase-io.js";
import { RESERVE_HEADER_BYTES } from "./reserve.js";

type Regular = Extract<PathObservation, { state: "regular" }>;
type Available = Extract<HaltResource, { disposition: "available" }>;

export type FlipOutcome =
  | { readonly kind: "flipped"; readonly control: MigrationControl }
  | { readonly kind: "arm-retirement"; readonly trigger: C1Trigger };

const sourceOf = (file: string, observed: Regular): SourceWitness => ({
  path: file, dev: observed.dev, ino: observed.ino,
  bytes: observed.bytes, sha256: observed.sha256!, mtimeNs: observed.mtimeNs,
});

const sameSource = (recorded: SourceWitness, file: string, observed: Regular): boolean =>
  recorded.path === file && recorded.dev === observed.dev && recorded.ino === observed.ino
  && recorded.bytes === observed.bytes && recorded.mtimeNs === observed.mtimeNs
  && recorded.sha256 === observed.sha256;

/**
 * ONE LENGTH POLICY, stated once for this file and `finalize.ts`.
 *
 * Where a WHOLE-file digest is compared, the recorded length is not compared: a
 * file cannot reproduce a SHA-256 at a different length, so the conjunct can only
 * ever agree, and a mutation sweep reports dropping it as equivalent.
 * `classifier.ts`'s `matchesProof` reached the same conclusion first and deleted
 * it, so every reader of these witnesses now means the same thing by "is it ours".
 *
 * Lengths ARE compared in exactly two places, because there the digest does not
 * cover the file: the Q sibling's 58 bytes (its digest covers a fixed-length
 * marker, and a longer file with that prefix is a different file), and the
 * reserve's 128 header bytes (a prefix digest, whose read count must be checked
 * or a short file digests padding).
 */

/** Both preserved copies, at the paths their own recorded facts derive to. The
 * history entry is content-addressed by the source digest, so neither path is
 * believed from the record alone. */
function revalidateBackups(root: string, control: MigrationControl, witness: M5State): void {
  const pairs: readonly (readonly [string, ArtifactWitness])[] = [
    [migrationPaths.backupHistory(root, control.source.sha256), witness.history],
    [migrationPaths.fixedBackup(root), witness.fixedBackup],
  ];
  for (const [derived, recorded] of pairs) {
    if (recorded.path !== derived) {
      halt("verification", false, `${recorded.path} is not the backup path this migration derives to`);
    }
    const observed = observePath(derived, true);
    if (observed.state !== "regular" || observed.dev !== recorded.dev || observed.ino !== recorded.ino
      || observed.sha256 !== recorded.sha256) {
      halt("verification", false, `${derived} is not the backup this migration published`);
    }
  }
}

/** The frozen window: the control is pre-flip `M5`, so nothing has written the
 * store and its recorded physical digest is exact. The ROW decides this, never
 * `blocksSqliteWrites` — that fence is also true after the flip, where the M5
 * witness is stale and this comparison would manufacture a corruption verdict out
 * of an ordinary save (#589's row list is normative). */
function revalidateActive(root: string, witness: M5State): void {
  const file = sqliteResetPaths.active(root);
  if (observeSidecars(file).length > 0) {
    halt("verification", false, `${file} carries sidecars while writes are still fenced`);
  }
  const observed = observePath(file, true);
  if (observed.state !== "regular" || observed.sha256 !== witness.active.sha256) {
    halt("verification", false, `${file} is not the database this migration published`);
  }
}

/**
 * The reserve and the emergency candidate, proven through ONE descriptor: the
 * recorded identity, the recorded whole-file digest, and — for the reserve only —
 * the digest of exactly its first {@link RESERVE_HEADER_BYTES}.
 *
 * That header digest is what `cleanup.ts` re-matches before unlinking role 7. It
 * is deliberately NOT `haltResources.reserve.sha256`, which is a whole-file
 * digest and is what `releaseHaltResource` checks. Both names describe the same
 * file and nothing cross-checks them, so the two are computed here in one place,
 * from one descriptor, and never assigned to each other (222 §M-8's two hazards
 * for this builder).
 *
 * ABSENCE IS A TYPED REFUSAL, not an exception and not a shorter vector. A record
 * can genuinely say `available` about a file that is gone:
 * `publishMigrationHalt` releases the reserve and then the emergency candidate as
 * runway, and if every publication attempt still fails it returns
 * `{durable: false}` — both unlinked while the canonical control still records
 * both `available`. Reached from the post-rename resume branch, a bare `ENOENT`
 * out of this function would escape as an untyped error from a row 163:2988
 * requires to be a typed halt, with no code, no `wrote`, and no classifier row.
 * Dropping the item instead would be worse: a damaged record could silently
 * shorten its own cleanup vector.
 */
function proveResource(file: string, recorded: Available, header: boolean): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, O.O_RDONLY | O.O_NOFOLLOW | O.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return halt("reserved-path", false, code === "ENOENT"
      ? `${file} is recorded available but is not there`
      : `${file} could not be opened as the recorded resource (${String(code)})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || Number(stat.dev) !== recorded.dev || Number(stat.ino) !== recorded.ino) {
      halt("reserved-path", false, `${file} is not the resource this migration recorded`);
    }
    const whole = crypto.createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    for (let offset = 0; ;) {
      const read = fs.readSync(fd, chunk, 0, chunk.byteLength, offset);
      if (read === 0) break;
      whole.update(chunk.subarray(0, read));
      offset += read;
    }
    if (whole.digest("hex") !== recorded.sha256) {
      halt("verification", false, `${file} does not hold the bytes this migration recorded`);
    }
    if (!header) return null;
    const head = Buffer.alloc(RESERVE_HEADER_BYTES);
    if (fs.readSync(fd, head, 0, RESERVE_HEADER_BYTES, 0) !== RESERVE_HEADER_BYTES) {
      halt("verification", false, `${file} is too short to carry a reserve header`);
    }
    return digestOfBytes(head);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The initial M6 cleanup cursor. Order is 163:4926's: the reserve, then the
 * emergency candidate, which owns the allocation-free runway and is therefore
 * always the final item.
 *
 * Every `path` is DERIVED from `migrationPaths` for its role and is never
 * carried from another record; `parent` is that path's own directory, because
 * the post-unlink fsync is aimed at it. Identities come from the control's own
 * `haltResources`, so the whole vector is a pure function of durable facts and a
 * stranded render is byte-identical to the next attempt's.
 *
 * A resource that is not `available` contributes nothing — it is already gone —
 * but an empty vector is refused rather than published: `stepCleanup` has no
 * complete-prefix transition into M7 and the runway has no final item, so an
 * empty cursor is a wedge, not a fast path.
 */
function cleanupCursor(root: string, control: MigrationControl): Cursor {
  const items: ArtifactItem[] = [];
  for (const role of ["reserve", "emergency"] as const) {
    const recorded = control.haltResources[role];
    if (recorded.disposition !== "available") continue;
    const file = role === "reserve"
      ? migrationPaths.reserve(root)
      : migrationPaths.emergency(root, control.migrationId);
    items.push({
      role, path: file, parent: path.dirname(file),
      dev: recorded.dev, ino: recorded.ino,
      sha256: proveResource(file, recorded, role === "reserve"),
    });
  }
  if (items.length === 0) {
    halt("reserved-path", false, "the migration records no halt resource for its cleanup vector");
  }
  return { items, durablePrefix: 0, currentIntent: null };
}

/**
 * Everything after the rename, and nothing else. 163:2988's block is scoped to
 * "once the rename begins": a fault here leaves the `M5 + exact Q` row, which
 * `blocksSqliteWrites` already answers TRUE for, and no lower revision may be
 * published. A `MigrationControlError` is rethrown — a CAS or prepared-sibling
 * refusal is a determinate protocol violation, not a durability question (the
 * same discrimination as `cleanup-runway.ts`'s `promoteSuccess`).
 */
function completeFlip(
  root: string, control: MigrationControl, witness: M5State, cleanup: Cursor, locks: HeldStatePlaneLocks,
): MigrationControl {
  try {
    fsyncDirectory(path.dirname(statePath(root)));
    const next: MigrationControl = {
      ...control,
      controlRevision: control.controlRevision + 1,
      witness: {
        ...witness, phase: "M6",
        qSibling: { ...witness.qSibling, disposition: { state: "absent" } },
        cleanup, futureControls: null,
      },
    };
    return publishMigrationControl(root, expectationFor(control), next, locks);
  } catch (error) {
    if (error instanceof MigrationControlError) throw error;
    return halt("durability-indeterminate", true, `the authority flip could not be made durable (${String(error)})`);
  }
}

/**
 * The one authority flip. Migration only, and the source witness is always real:
 * there is no genesis caller and no nullable witness.
 *
 * A source change never renames. It returns the C1 trigger for `armRetirement`
 * to publish, with JSON still authoritative — which is why this function does
 * not use `bracketSource`, whose refusal is a halt.
 */
export async function flipAuthority(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<FlipOutcome> {
  const { control, witness } = m5(receipt);
  const marker = markerBytes(control);
  const sibling = requireSibling(root, control, witness.qSibling, marker);
  const live = statePath(root);

  // BEFORE the live document is even looked at, and covering both branches below.
  // Only an `exact` sibling can be renamed, and therefore only an `exact` sibling
  // can already HAVE been renamed — so a control recording `absent` or `building`
  // over a live marker is not a resume, it is a marker this migration never
  // published. Checked here rather than inside the pre-flip path because the
  // resume path publishes M6 and lifts the fence: reached with a `building`
  // record it would ratify a flip no durable revision ever authorized. The
  // classifier refuses to mint such a receipt, but that is its invariant, not
  // this function's.
  if (witness.qSibling.disposition.state !== "exact") {
    return halt("reserved-path", false, "the authority flip requires an exact Q sibling");
  }
  const observed = observePath(live, true);

  // The resume row: the rename landed and the parent fsync or M6's publication
  // did not (163:3325).
  if (observed.state === "regular" && observed.sha256 === witness.qSibling.sha256) {
    if (observePath(sibling).state !== "absent") {
      return halt("reserved-path", false, "the Q sibling survived the authority rename");
    }
    // Still the frozen window: the phase is M5, so `blocksSqliteWrites` has been
    // TRUE since before the rename and nothing can have written the store. The
    // classifier proves this too before it hands out the receipt; proving it here
    // as well keeps the flip's correctness local to the flip.
    revalidateActive(root, witness);
    // NOT revalidated here, and the asymmetry is deliberate: the source (gone —
    // `Q` is what stands at its path) and the two legacy-JSON backups. 163's
    // `M5 + exact Q` row admits exactly one action, "complete/retry the `.rbox`
    // fsync, publish M6", and lists no backup precondition — and refusing would
    // wedge the workspace at a fenced M5 forever, because the document the
    // backups copy no longer exists to re-derive them from. The cost is that a
    // backup deleted inside the rename -> publish window is never noticed. It
    // cannot be recorded either: the control schema is closed and strict, so a
    // "backups unchecked" note needs a codec member this lane does not own. Open
    // question for 163/1A, raised in the PR rather than papered over here.
    return { kind: "flipped", control: completeFlip(root, control, witness, cleanupCursor(root, control), locks) };
  }
  const image = observeQSibling(witness.qSibling);
  if (isForeign(image) || image.state !== "exact") {
    return halt("reserved-path", false, `${sibling} does not hold the exact authority marker`);
  }
  if (observed.state !== "regular" || observed.sha256 === null) {
    return halt("reserved-path", false, `${live} is neither legacy sync records nor this authority's marker`);
  }
  if (!sameSource(control.source, live, observed)) {
    return { kind: "arm-retirement", trigger: { disposition: "source-changed", replacement: sourceOf(live, observed) } };
  }
  revalidateBackups(root, control, witness);
  revalidateActive(root, witness);
  const cleanup = cleanupCursor(root, control);

  const final = observePath(live, true);
  if (final.state !== "regular" || final.sha256 === null) {
    return halt("reserved-path", false, `${live} stopped being a regular file`);
  }
  if (final.sha256 !== witness.completion.sourceJsonSha256) {
    return {
      kind: "arm-retirement",
      trigger: {
        disposition: "legacy-write-detected",
        replacement: sourceOf(live, final), observedBodySha256: final.sha256,
      },
    };
  }
  // THE RENAME, and its own failure — which is typed, because 163:2988's rule is
  // stated for the rename's *aftermath* and says nothing about the syscall itself.
  //
  // `rename(2)` is atomic, so a failure here left either the old durable pair
  // `{L, exact sibling}` or the new pair `{Q, sibling absent}`. Both are admitted
  // resume rows (163:3325) and this function's own resume branch converges from
  // the second, so no on-disk state is lost either way. What the caller cannot
  // know is WHICH — this is the one refusal in the lane where `wrote` is
  // genuinely unknowable at the instant it is raised.
  //
  // Both halves are therefore reported conservatively, and deliberately:
  //
  //  - `wrote: true`, because `phase-io.ts` defines `wrote` as the one fact the
  //    driver cannot recompute, and the zero-write rows are assertions. An
  //    unknown must not be published as a promise that nothing moved.
  //  - `durability-indeterminate`, because the durability of the flip is
  //    literally indeterminate. This does NOT contradict `completeFlip`'s
  //    refusal to mislabel a CAS error the same way: that fence would block a
  //    workspace whose writes were otherwise free, whereas here
  //    `blocksSqliteWrites` is already TRUE for every phase below M6 — the
  //    workspace was fenced before this call and stays fenced under either
  //    outcome, so the code costs nothing and describes the situation honestly.
  //
  // Leaving it bare was the gap: a driver author holding an `EIO` with no code
  // and no `wrote` flag has to guess, and guessing "indeterminate" for a rename
  // that never happened is the stale-witness misclassification this module's
  // header exists to warn about.
  try {
    fs.renameSync(sibling, live);
  } catch (error) {
    return halt("durability-indeterminate", true,
      `the authority rename did not complete (${String((error as NodeJS.ErrnoException).code ?? error)})`);
  }
  return { kind: "flipped", control: completeFlip(root, control, witness, cleanup, locks) };
}
