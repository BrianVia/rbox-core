/**
 * M-5: a proven staging database derived from an admitted source (design 222
 * §M-5; design 163 phases M2, M3, and the v13 rewrite of M4).
 *
 * Three phases, one ownership rule. Every file this module opens is one it
 * durably owns: the source, under the identity its own control recorded and
 * re-brackets before every mutator; the two backups, which it created; and the
 * staging main, whose inode it claimed and published before SQLite touched it.
 * Nothing here opens the legacy document to interpret it as authority, and
 * nothing opens a database on a path this migration did not claim.
 *
 * WHY M4 VERIFIES BEFORE IT CHECKPOINTS (163 v13, this lane's blocker): the
 * withdrawn text reopened staging read-only and required `S0` a second time.
 * Staging is WAL-mode, so a read-only verifier's first read recreates
 * `-wal`/`-shm` and its close cannot remove them — the second `S0` could only
 * ever fail. Verification therefore runs on the OWNING read-write connection,
 * and the checkpoint that brings the file to rest runs after it passes.
 *
 * A halt is raised, never published: `MigrationPhaseHaltError` carries the
 * exact code and whether anything was written before the refusal, and the
 * driver owns the durable record.
 */
import crypto from "node:crypto";
import fs, { constants as O } from "node:fs";
import path from "node:path";
import { RBOX_VERSION } from "../../version.js";
import {
  assertResetParseAdmission, RESET_MATERIALIZED_BYTE_LIMIT, ResetMemoryAdmissionError,
} from "../../reset-io.js";
import type { SyncState } from "../../sync-state-model.js";
import { LegacyStateStructureError, normalizeLegacyStateV1 } from "../digest/legacy-state-plan.js";
import { legacyStateSemanticDigest } from "../digest/state-semantic-v1.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths } from "../paths.js";
import {
  adoptClaimedStateStore, openStateStoreForWalTakeover, stateStoreDatabase, type ClaimedInode,
} from "../store/open.js";
import { observePath, observeStagingMain, isForeign } from "./artifact-observation.js";
import type {
  CompletionTuple, M2Witness, M3Witness, MigrationControl, SourceWitness,
} from "./control-codec.js";
import type { PhaseReceipt } from "./classifier.js";
import { installLegacyState, readCompletionTuple } from "./import-install.js";
import { publishBackup, readBackup } from "./legacy-backup.js";
import { fsyncDirectory } from "../store/artifact-proof.js";
import { bracketSource, fsyncFileAndParent, halt, requirePhase } from "./phase-io.js";

/**
 * M2. The immutable hash-addressed history entry, then the fixed convenience
 * copy — and a differing-but-valid prior fixed backup is preserved under its
 * OWN body hash first, so no unique bytes are ever overwritten.
 */
export async function preserveSource(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<M2Witness> {
  void locks;
  const control = requirePhase(receipt, "M1");
  const source = bracketSource(control);
  const history = migrationPaths.backupHistory(root, source.sha256);
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fsyncDirectory(path.dirname(path.dirname(history)));

  const prior = readBackup(migrationPaths.fixedBackup(root));
  if (prior && prior.declared !== source.sha256) {
    const preserved = migrationPaths.backupHistory(root, prior.declared);
    if (observePath(preserved).state === "absent") {
      fs.copyFileSync(migrationPaths.fixedBackup(root), preserved, fs.constants.COPYFILE_EXCL);
      fsyncFileAndParent(preserved);
    }
  }
  return {
    history: publishBackup(root, control, history, source),
    fixedBackup: publishBackup(root, control, migrationPaths.fixedBackup(root), source),
    stagingMain: { state: "absent" },
  };
}

// ---------------------------------------------------------------------------
// M3 — claim, publish the identity, import.

export type StagingMainClaim =
  | { readonly kind: "claimed"; readonly identity: ClaimedInode }
  | { readonly kind: "completed"; readonly identity: ClaimedInode; readonly completion: CompletionTuple };

/** A branded pairing of the claimed inode with the receipt minted from the
 * control revision that recorded it. `importOwnedStaging` cannot be handed a
 * bare inode, so it cannot import into a file no durable record names. */
export interface PublishedStagingClaim {
  readonly identity: ClaimedInode;
  readonly receipt: PhaseReceipt;
}

const claimedInode = (file: string): ClaimedInode => {
  const observed = observePath(file);
  if (observed.state !== "regular") return halt("reserved-path", true, `${file} is not the file just claimed`);
  return { dev: observed.dev, ino: observed.ino };
};

function createStagingMain(file: string): ClaimedInode {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, O.O_CREAT | O.O_EXCL | O.O_WRONLY | O.O_NOFOLLOW, 0o600);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fsyncDirectory(path.dirname(file));
  return claimedInode(file);
}

/** The committed completion this staging file already carries, or `undefined`.
 * Opening is legal here and only here: the inode is the one this migration's
 * own control records, and the open is read-write as its sole owner, so WAL
 * recovery is the sanctioned action rather than a foreign mutation. */
function committedCompletion(file: string, control: MigrationControl): CompletionTuple | undefined {
  let store;
  try {
    store = openStateStoreForWalTakeover(file);
  } catch {
    return undefined;
  }
  let completion: CompletionTuple;
  try {
    completion = readCompletionTuple(stateStoreDatabase(store));
  } catch {
    // Unreadable or half-built is "incomplete", not a halt: this is precisely
    // the crash image the rebuild branch exists for.
    return undefined;
  } finally {
    store.close();
  }
  // Outside the swallowing catch on purpose. A complete import belonging to
  // someone else is a foreign artifact, and mistaking it for an incomplete one
  // would rebuild over it.
  if (completion.migrationId !== control.migrationId || completion.authorityId !== control.authorityId) {
    halt("reserved-path", true, `${file} holds a completed import for another migration`);
  }
  return completion;
}

/**
 * Reset the recorded inode instead of replacing it. Genesis case 3 established
 * the rule and this lane needs it for a second reason: the M2 revision that
 * publishes the staging identity is the first non-deterministic record in the
 * protocol, and a rebuild that minted a FRESH inode would have to publish a
 * second one — whose render→rename window has no resumable image, because the
 * recorded identity and the observed file would then disagree forever.
 * Truncating keeps `{dev, ino}`, so the identity is published exactly once.
 *
 * It removes no sidecars, deliberately. Every path that reaches here has just
 * gone through `committedCompletion`, which either opened the file and closed
 * it or failed to open it — and SQLite clears its own `-wal`/`-shm` on both
 * (measured: a failed takeover of a non-database leaves none). A loop here
 * could only ever be a no-op, and the real guarantee is downstream anyway:
 * `adoptClaimedStateStore` refuses a claimed file that has any sidecar, so a
 * surviving one fails closed rather than being silently swept.
 *
 * The identity re-check IS kept, and is the one assertion in this module that
 * no test can reach: `observeStagingMain` already proved this inode a moment
 * ago, so only a violation of the state lock could make it fire. It guards an
 * `ftruncate`, which is the one irreversible thing this module does to a file
 * it did not just create, and that is worth an unreachable assertion.
 */
function resetRecordedInode(file: string, recorded: ClaimedInode): ClaimedInode {
  const fd = fs.openSync(file, O.O_WRONLY | O.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (Number(opened.dev) !== recorded.dev || Number(opened.ino) !== recorded.ino) {
      halt("reserved-path", false, `${file} is not the recorded staging inode`);
    }
    fs.ftruncateSync(fd, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(file));
  return recorded;
}

/** The four admitted observations of the staging main (design 222 §M-5). */
export async function claimStagingMain(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<StagingMainClaim> {
  void locks;
  const control = requirePhase(receipt, "M2");
  bracketSource(control);
  const file = control.stagingPath;
  const recorded = control.witness.phase === "M2" ? control.witness.stagingMain : { state: "absent" as const };
  const observed = observeStagingMain(file, recorded);
  if (isForeign(observed)) return halt("reserved-path", false, observed.foreign);
  switch (observed.state) {
    case "absent":
      return { kind: "claimed", identity: createStagingMain(file) };
    case "create-ahead":
      fsyncFileAndParent(file);
      return { kind: "claimed", identity: claimedInode(file) };
    default: {
      const identity = recorded.state === "present" ? { dev: recorded.dev, ino: recorded.ino } : claimedInode(file);
      if (observed.bytes === 0 && observed.sidecars.length === 0) return { kind: "claimed", identity };
      const completion = committedCompletion(file, control);
      return completion
        ? { kind: "completed", identity, completion }
        : { kind: "claimed", identity: resetRecordedInode(file, identity) };
    }
  }
}

/** The lineage this import lands on, derived rather than minted: a resume that
 * rebuilds the staging file must produce the same rows, and a second random id
 * would make the semantic digest of a rebuilt import differ from the first. */
const importLineageId = (control: MigrationControl): string =>
  crypto.createHash("sha256")
    .update(`rbox-state-lineage-v1\n${control.migrationId}\n${control.authorityId}`)
    .digest("hex").slice(0, 32);

/**
 * The one guarded parse — and the import path's ONLY read of the source.
 *
 * It does the whole job on ONE descriptor: admission, complete identity, read,
 * hash, parse. `bracketSource` is deliberately not called before it here, the
 * way M2 and M4 call it, because two reads would be two different sets of bytes
 * with a window between them — and the only bytes whose identity matters are
 * the ones actually parsed. Folding them removes the window rather than
 * defending it, and makes each of these checks the sole guard of its own fact,
 * so none of them can be deleted without a test noticing.
 */
function parseAdmittedSource(source: SourceWitness): SyncState {
  if (source.bytes > RESET_MATERIALIZED_BYTE_LIMIT) {
    halt("source-oversize", false, "the legacy document is over the 512 MiB limit",
      { required: source.bytes, available: RESET_MATERIALIZED_BYTE_LIMIT });
  }
  try {
    assertResetParseAdmission(source.bytes);
  } catch (error) {
    if (!(error instanceof ResetMemoryAdmissionError)) throw error;
    halt("memory-admission", false, "this machine cannot materialize the legacy document",
      { required: error.requiredBytes, available: error.availableBytes });
  }
  const fd = fs.openSync(source.path, O.O_RDONLY | O.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || Number(stat.dev) !== source.dev || Number(stat.ino) !== source.ino) {
      halt("verification", false, "the legacy document is not the inode this migration recorded");
    }
    if (Number(stat.size) !== source.bytes) {
      halt("verification", false, "the legacy document is not the length this migration recorded");
    }
    if (stat.mtimeNs.toString() !== source.mtimeNs) {
      halt("verification", false, "the legacy document was written since this migration recorded it");
    }
    bytes = Buffer.alloc(source.bytes);
    if (fs.readSync(fd, bytes, 0, source.bytes, 0) !== source.bytes) {
      halt("verification", false, "the legacy document was truncated while it was read");
    }
  } finally {
    fs.closeSync(fd);
  }
  // The hash covers the bytes about to be parsed, not a separate read of the
  // path. This is the check that makes "the admitted document" a fact rather
  // than an inference from a stat.
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
    halt("verification", false, "the legacy document does not hash to its recorded digest");
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as SyncState;
  } catch (cause) {
    return halt("verification", false, `the legacy document is not JSON: ${String(cause)}`);
  }
}

/**
 * M3. Import every plane and record in ONE transaction with the completion row
 * last, then return the tuple exactly as it was committed — never as it was
 * assembled, so what M3 publishes is what the database holds.
 */
export async function importOwnedStaging(
  root: string, published: PublishedStagingClaim, locks: HeldStatePlaneLocks,
): Promise<M3Witness> {
  void locks;
  const control = requirePhase(published.receipt, "M2");
  // No separate `bracketSource` here: `parseAdmittedSource` is the bracket, on
  // the same descriptor it reads from.
  const source = control.source;
  const state = parseAdmittedSource(source);
  let plan;
  try {
    plan = normalizeLegacyStateV1(state, importLineageId(control));
  } catch (error) {
    if (!(error instanceof LegacyStateStructureError) && !(error instanceof TypeError)) throw error;
    return halt("verification", false, error.message);
  }
  const completedAtIso = new Date().toISOString();
  const store = adoptClaimedStateStore(control.stagingPath, published.identity, (db) => {
    installLegacyState(db, plan, {
      migrationId: control.migrationId,
      authorityId: control.authorityId,
      importerVersion: RBOX_VERSION,
      sourceJsonSha256: source.sha256,
      sourceSemanticDigest: legacyStateSemanticDigest(plan),
      sourceBytes: source.bytes,
      completedAtIso,
    });
  });
  try {
    return { completion: readCompletionTuple(stateStoreDatabase(store)) };
  } finally {
    store.close();
  }
}

