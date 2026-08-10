/**
 * M4: verify the staging database, then bring it to rest (design 163 phase M4,
 * as rewritten in v13).
 *
 * WHY VERIFICATION COMES FIRST, AND ON THE OWNING CONNECTION — this lane's
 * blocker. The withdrawn text reopened staging read-only and required `S0` a
 * second time. Staging is WAL-mode, so a read-only verifier's first read
 * recreates `-wal`/`-shm` and its close cannot remove them: the second `S0`
 * could only ever fail. Verification therefore runs on the OWNING read-write
 * connection, and the checkpoint runs after it passes.
 *
 * Split out of `import-json.ts` for 163's module-size law, along the seam that
 * was already there: M2 and M3 build the database, and this is the only phase
 * that opens one purely to interrogate it.
 */
import type { Database } from "bun:sqlite";
import { canonicalString } from "../../../engine/e2ee/jcs.js";
import { stateSemanticDigest } from "../digest/state-semantic-v1.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { fsyncDbAndParent, requireDbArtifactS0, stableDbHash } from "../reset/artifacts.js";
import {
  checkpointStateStoreForReset, openStateStoreForWalTakeover, stateStoreDatabase,
} from "../store/open.js";
import { observePath } from "./artifact-observation.js";
import type { PhaseReceipt } from "./classifier.js";
import type { CompletionTuple, M4Witness, StagingProof } from "./control-codec.js";
import { readCompletionTuple } from "./import-install.js";
import { bracketSource, halt, requirePhase } from "./phase-io.js";

export const STAGING_PROOF_VERSION = 1;

interface ForeignKeyViolationRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

interface IntegrityCheckRow { integrity_check: string }

function foreignKeyViolations(db: Database): ForeignKeyViolationRow[] {
  const prepared = db.prepare("PRAGMA foreign_key_check");
  try {
    return prepared.all() as ForeignKeyViolationRow[];
  } finally {
    prepared.finalize();
  }
}

function integrityCheck(db: Database): IntegrityCheckRow[] {
  const prepared = db.prepare("PRAGMA integrity_check");
  try {
    return prepared.all() as IntegrityCheckRow[];
  } finally {
    prepared.finalize();
  }
}

function verifyOwnedStaging(file: string, completion: CompletionTuple): void {
  let store;
  try {
    store = openStateStoreForWalTakeover(file);
  } catch (error) {
    // Schema, application id, DDL fingerprint, and the singleton/head coherence
    // `validateOpen` enforces are all verification facts about a database this
    // migration built. They arrive as a typed store error; M4 owes the driver a
    // halt, not someone else's exception class.
    return halt("verification", true, `the staging database did not open as a valid store (${String(error)})`,
      { underlyingCode: "staging-open" });
  }
  try {
    const db = stateStoreDatabase(store);
    if (store.header.authority_id !== completion.authorityId) {
      halt("verification", false, "the staging database carries a different authority",
        { underlyingCode: "authority-mismatch" });
    }
    // Through the record's OWN canonicalizer, not `JSON.stringify`. `completion`
    // arrives from a decoded control and so carries JCS-sorted keys, while
    // `readCompletionTuple` builds its object in SELECT order — a stringify
    // compare of two equal tuples is unequal on every real migration.
    const committed = readCompletionTuple(db);
    if (canonicalString(committed) !== canonicalString(completion)) {
      halt("verification", false, "the staging completion row is not the one M3 published",
        { underlyingCode: "completion-tuple" });
    }
    if (stateSemanticDigest(db) !== completion.sourceSemanticDigest) {
      halt("verification", false, "the imported database does not reproduce the source semantic digest",
        { underlyingCode: "semantic-digest" });
    }
    // Prepared and finalized, never `db.query` — see the digest module: past
    // five cached statements a connection stops closing, and closing is the one
    // thing M4 exists to achieve.
    //
    // `foreign_key_check` is NOT covered by `integrity_check`: the latter
    // validates page and index structure, and reports foreign key violations
    // only under `PRAGMA foreign_keys` for the rows it happens to touch. An
    // orphaned `plane_entries` row is structurally perfect and semantically
    // dangling, which is exactly the shape a partial import produces.
    const violations = foreignKeyViolations(db);
    if (violations.length > 0) {
      halt("verification", false, `the imported database has ${violations.length} foreign key violations`,
        { underlyingCode: "foreign-key-check" });
    }
    const integrity = integrityCheck(db);
    const verdict = integrity.length === 1 ? integrity[0]!.integrity_check : undefined;
    if (verdict !== "ok") {
      halt("verification", false, "the imported database failed integrity_check",
        { underlyingCode: "integrity-check" });
    }
    // Only after every check passes, and never before (163 v13).
    //
    // Honest note on what this does and does not buy, because it reads like
    // more than it is. By the time M4 runs, this connection has only READ, so
    // the log is already empty and `TRUNCATE` has nothing to move — measured,
    // and the reason an assertion on its returned frame counts is a tautology
    // rather than a check. `close()` would reach `S0` without it.
    //
    // It is kept for two reasons that are not "it makes the file at rest": 163
    // v13 requires a non-busy checkpoint at exactly this point, and it is the
    // one place a still-open reader is reported as a durability question rather
    // than inferred later from a sidecar. Deleting it is an equivalent mutant
    // and is knowingly retained.
    try {
      checkpointStateStoreForReset(store);
    } catch (error) {
      return halt("durability-indeterminate", true,
        `the staging database could not be checkpointed to rest (${String(error)})`,
        { underlyingCode: "checkpoint" });
    }
  } finally {
    store.close();
  }
}

/** M4. Verification first, on the owning read-write connection; checkpoint,
 * close, and require `S0` once (163 v13). */
export async function proveStaging(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<M4Witness> {
  void locks;
  const control = requirePhase(receipt, "M3");
  bracketSource(control);
  const witness = control.witness;
  if (witness.phase !== "M3") throw new TypeError("an M3 receipt must carry an M3 witness");
  const file = control.stagingPath;
  const recorded = witness.stagingMain;
  if (recorded.state !== "present") {
    return halt("verification", false, "M3 records no staging identity to prove",
      { underlyingCode: "staging-identity-absent" });
  }
  const observed = observePath(file);
  if (observed.state !== "regular" || observed.dev !== recorded.dev || observed.ino !== recorded.ino) {
    halt("reserved-path", false, `${file} is not the recorded staging inode`,
      { underlyingCode: "staging-inode" });
  }
  verifyOwnedStaging(file, witness.completion);
  // `S0` once, through the reset plane's at-rest predicate rather than a second
  // sidecar sweep of this module's own, and its identity is what brackets the
  // physical hash below — so the requirement is load-bearing rather than an
  // assertion something else could satisfy.
  let atRest;
  try {
    atRest = await requireDbArtifactS0(file);
  } catch (error) {
    return halt("durability-indeterminate", true,
      `the staging database did not come to rest after its checkpoint (${String(error)})`,
      { underlyingCode: "not-at-rest" });
  }
  await fsyncDbAndParent(file);
  const { sha256, identity } = await stableDbHash(file, atRest);
  if (Number(identity.dev) !== recorded.dev || Number(identity.ino) !== recorded.ino) {
    halt("verification", true, `${file} changed identity while it was being proved`,
      { underlyingCode: "staging-identity-changed" });
  }
  const staging: StagingProof = {
    sha256, bytes: Number(identity.size),
    semanticDigest: witness.completion.sourceSemanticDigest,
    entryCount: witness.completion.entryCount,
    repoCount: witness.completion.repoCount,
    proofVersion: STAGING_PROOF_VERSION,
  };
  return { staging };
}
