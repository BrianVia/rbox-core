/** The five in-transaction steps of the CAS, in the order the design numbers them.
 *
 * Every read and write here happens inside the caller's one `BEGIN IMMEDIATE`, and
 * every input is a connection-owned TEMP copy of an already-verified sealed
 * artifact. Steps 2 and 4 are fused per row so the packet is never collected in JS.
 */
import type { Database } from "bun:sqlite";
import {
  composeRepoBase, type BranchBaseOrigin, type RepoBaseProof, type RepoBaseValue,
} from "../../sync-git/base-composer.js";
import {
  validManifestMeta, type ElisionExpectation, type GlobalManifestMeta,
  type RepoRecord, type RepoRecordInput,
} from "../../sync-state-model.js";
import type { DeltaBinding } from "../../sync-state-delta.js";
import { decodeGitSection } from "../codecs/git-section.js";
import { encodeRepoRecord } from "../codecs/repo-record.js";
import { canonicalJson, parseCanonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import { ProoflessBaseError, StageChangedError, decodeAuthorityRow } from "../errors.js";
import type { CasRejectionReason, ManifestHeader } from "../ports.js";
import { applyDeltaOpsIntoPlane, internStagedEntryValues, promoteFilesIntoPlane } from "./plane-promotion.js";
import { runStatement, selectRow, streamRows, withStatement } from "./statements.js";
import {
  canonicalEvidenceOf, decodeTransitionBaseProof, decodeTransitionEvidence, decodeTransitionRecord,
  isJsonObject, type SealedTransitionReader,
} from "./transition-stages.js";
import type { SourceStageBinding } from "../digest/repo-transition-v1.js";
import type { CasOwnerToken } from "../ports.js";
import type { CasExpectation } from "./write-packet.js";
import { jsonText, type JsonValue } from "../../../json.js";


/**
 * The transaction's inputs, deep-copied out of the VERIFIED artifacts and the
 * packet scalars once verification is complete. Everything inside `BEGIN
 * IMMEDIATE` reads only this. The caller still owns `ownerToken.isOwner()`, which
 * runs twice inside the transaction — freezing is what stops that callback from
 * rewriting the header, the sequence, or an expectation between the predicate
 * checks and the commit.
 */
export interface FrozenCasInputs {
  expected: CasExpectation;
  sourceGlobalSeq: number;
  hasGlobal: boolean;
  /** The header the stage was SEALED with, read back from the artifact. */
  globalHeader?: ManifestHeader;
  globalManifestMeta?: GlobalManifestMeta;
  globalBinding?: SourceStageBinding;
  /** Existing stream admitted for the one reset-provenance replacement case. */
  replacementOldStream?: string;
  /** The snapshot this packet's elisions were proven against (design 267 §3.2b). */
  elisionExpectation?: ElisionExpectation;
  /** Present when the global is RELATIVE (design 269): its predecessor binding
   * and the post-conditions the sealed artifact commits to. */
  delta?: FrozenDeltaInputs;
  ownerToken: CasOwnerToken;
}

/** A relative global's frozen inputs. The binding is its own frozen expectation:
 * `expected` and the transition snapshot token stay live-derived, so a
 * predecessor that moved is a retryable rejection rather than a throw. */
export interface FrozenDeltaInputs {
  stageId: string;
  binding: DeltaBinding;
  resultFiles: number;
}

/** Canonical validated copy of the one nested packet value the caller owns. */
export function freezeGlobalManifestMeta(value: GlobalManifestMeta): GlobalManifestMeta {
  const copied = validManifestMeta(parseCanonicalJson(canonicalJson(value)));
  if (!copied) throw new Error("not a valid GlobalManifestMeta");
  return copied;
}

export class Rejected extends Error {
  constructor(readonly reason: CasRejectionReason) {
    super(`cas rejected: ${reason}`);
  }
}

export const reject = (reason: CasRejectionReason): never => {
  throw new Rejected(reason);
};

interface LineageRow {
  lineage_id: string; stream: string; state_nonce: string | null; state_revision: number | null;
  last_synced_sequence: number; active_base_generation: number; local_revision: number;
}

/** Step 1: every predicate, including each row's source evidence against the
 * stages this CAS actually verified. */
export function checkPredicates(db: Database, frozen: FrozenCasInputs, verified: ReadonlySet<string>): void {
  const row = selectRow<LineageRow>(db, `SELECT l.lineage_id,l.stream,l.state_nonce,l.state_revision,
    l.last_synced_sequence,l.active_base_generation,l.local_revision
    FROM store_meta m JOIN state_lineage l ON l.lineage_id=m.active_lineage_id
    WHERE m.singleton=1`);
  if (!row) throw new Error("state store singleton disappeared");
  const expected = frozen.expected;
  if (row.lineage_id !== expected.lineageId) reject("lineage");
  if (row.stream !== (frozen.replacementOldStream ?? expected.stream)) reject("stream");
  if ((row.state_nonce ?? "legacy") !== expected.nonce) reject("nonce");
  if ((row.state_revision ?? 0) !== expected.stateRevision) reject("state-revision");
  // Sampled BEFORE the state lock, unlike every predicate above: an elided
  // global disables the sequence predicate and an elided repo leaves no
  // repo_gen to check, so revision equality is what proves nothing interleaved.
  const elision = frozen.elisionExpectation;
  if (elision && ((row.state_nonce ?? "legacy") !== elision.nonce
    || (row.state_revision ?? 0) !== elision.stateRevision)) reject("elision-drift");
  // Same sampling rule for a relative global: its ops are only meaningful against
  // the exact predecessor they were composed from.
  const delta = frozen.delta;
  if (delta && ((row.state_nonce ?? "legacy") !== delta.binding.nonce
    || (row.state_revision ?? 0) !== delta.binding.stateRevision)) reject("delta-binding");
  if (row.active_base_generation !== expected.baseGeneration) reject("base-generation");
  if (row.local_revision !== expected.localRevision) reject("local-revision");
  if (frozen.hasGlobal && frozen.sourceGlobalSeq < row.last_synced_sequence) reject("global-sequence");
  if (frozen.replacementOldStream !== undefined && row.last_synced_sequence !== 0) reject("global-sequence");
  const drift = selectRow<{ rel_path: string }>(db, `SELECT t.rel_path FROM ${CAS_TRANSITION_TEMP} t
    WHERE t.expected_repo_gen <> COALESCE(
      (SELECT r.repo_gen FROM repo_records r WHERE r.lineage_id=? AND r.rel_path=t.rel_path), 0)
    LIMIT 1`, expected.lineageId);
  if (drift) reject("repo-generation");
  assertEvidenceAgainstVerified(db, verified, frozen.globalBinding);
  if (!frozen.ownerToken.isOwner()) reject("owner-lost");
}

const canonicalBinding = (binding: SourceStageBinding): string => canonicalJson({
  stageId: binding.stageId, logicalDigest: binding.logicalDigest, physicalSha256: binding.physicalSha256,
});

function assertEvidenceAgainstVerified(
  db: Database,
  verified: ReadonlySet<string>,
  globalBinding: SourceStageBinding | undefined,
): void {
  streamRows<{ rel_path: string; evidence_cjson: string }>(
    db, `SELECT rel_path,evidence_cjson FROM ${CAS_TRANSITION_TEMP} ORDER BY path_order`, [], (row) => {
      const named = decodeTransitionEvidence(row.evidence_cjson).sourceStages;
      if (verified.size > 0 && named.length === 0) {
        throw new StageChangedError(row.rel_path, "transition row names no verified source stage");
      }
      if (verified.size === 0 && named.length > 0) {
        throw new StageChangedError(row.rel_path, "transition row names a source stage this packet did not verify");
      }
      for (const binding of named) {
        if (!verified.has(canonicalBinding(binding))) {
          throw new StageChangedError(row.rel_path, `transition row names unverified source stage ${binding.stageId}`);
        }
      }
      // Subset-of-verified is not enough: a global packet derives EVERY record
      // from the global stage, so its exact identity must appear in each row.
      if (globalBinding && !named.some((binding) => canonicalBinding(binding) === canonicalBinding(globalBinding))) {
        throw new StageChangedError(row.rel_path, "transition row does not name the packet's global source stage");
      }
    });
}

/** Step 3. The staged file set replaces BASE by set-difference; the sealed header,
 * manifest meta, and sequence are replaced together or not at all. */
export function applyGlobal(db: Database, frozen: FrozenCasInputs, lineageId: string): void {
  const generation = frozen.expected.baseGeneration + 1;
  if (frozen.delta === undefined) {
    internStagedEntryValues(db);
    promoteFilesIntoPlane(db, lineageId, "base", generation);
  } else {
    applyDeltaOpsIntoPlane(db, lineageId, "base", generation, frozen.delta);
  }
  const { generatedAt, manifestSchema, sourceSequence, trustEpoch, complete: _complete, ...extras } = frozen.globalHeader!;
  runStatement(db, `UPDATE plane_heads SET generation=?,generated_at=?,manifest_schema=?,source_sequence=?,
    trust_epoch=?,complete=1,extras_cjson=? WHERE lineage_id=? AND plane='base'`,
    generation, generatedAt, manifestSchema ?? null, sourceSequence ?? null, trustEpoch ?? null,
    Object.keys(extras).length === 0 ? null : canonicalJson(extras), lineageId,
  );
  runStatement(db, "UPDATE state_lineage SET last_synced_sequence=? WHERE lineage_id=?", frozen.sourceGlobalSeq, lineageId);
  runStatement(db, "DELETE FROM manifest_chain WHERE lineage_id=?", lineageId);
  runStatement(db, "DELETE FROM global_manifest_meta WHERE lineage_id=?", lineageId);
  runStatement(db, "DELETE FROM manifest_git_sections WHERE lineage_id=? AND role='meta-wire'", lineageId);
  if (frozen.globalManifestMeta === undefined) return;
  // The admission invariants U1a could only read are enforced here, by the one
  // definition the wire codec and the JSON authority already share.
  const meta = validManifestMeta(frozen.globalManifestMeta);
  if (!meta) throw new TypeError("CAS manifestMeta is not a valid GlobalManifestMeta");
  const { encManifestSha, manifestHash, accountEpoch, keyEpoch, chainBytes, snapshotBytes,
    chain, gitRepos, ...metaExtras } = meta;
  runStatement(db, `INSERT INTO global_manifest_meta(lineage_id,base_generation,enc_manifest_sha,manifest_hash,
    account_epoch,key_epoch,chain_bytes,snapshot_bytes,extras_cjson) VALUES (?,?,?,?,?,?,?,?,?)`,
    lineageId, generation, Buffer.from(encManifestSha, "hex"), Buffer.from(manifestHash, "hex"),
    accountEpoch, keyEpoch, chainBytes, snapshotBytes,
    Object.keys(metaExtras).length === 0 ? null : canonicalJson(metaExtras),
  );
  withStatement(db, "INSERT INTO manifest_chain(lineage_id,base_generation,ordinal,enc_sha) VALUES (?,?,?,?)", (chainInsert) => {
    for (const [ordinal, encSha] of chain.entries()) {
      chainInsert.run(lineageId, generation, ordinal, Buffer.from(encSha, "hex"));
    }
  });
  withStatement(db, `INSERT INTO manifest_git_sections(lineage_id,base_generation,role,rel_path,path_order,section_cjson)
    VALUES (?,?,'meta-wire',?,?,?)`, (gitInsert) => {
    for (const [relPath, section] of Object.entries(gitRepos)) {
      gitInsert.run(lineageId, generation, relPath, utf16beOrderKey(relPath), canonicalJson(section));
    }
  });
}

const REPO_VALUE_COLUMNS = [
  "base_cjson", "advertised_cjson", "branch_base_origins_cjson", "packed_refs_identity",
  "pending_cjson", "repo_absent", "removed_key", "resolution_key", "cfg_synced", "cfg_applied",
  "cfg_token_cjson", "cfg_shape_cjson", "deferrals_cjson", "partial_cjson", "attempt_cjson",
  "resolution_receipt_cjson", "idx_proj",
] as const;

/**
 * Steps 2 and 4, streamed. Each transition is recomposed against its exact
 * predecessor with its own explicit proof and written as one whole value. The
 * packet is never collected in JS: one row is in memory at a time.
 */
export function applyTransitions(db: Database, lineageId: string): void {
  withStatement(db, `SELECT base_cjson,branch_base_origins_cjson
    FROM repo_records WHERE lineage_id=? AND rel_path=?`, (previous) => {
    withStatement(db, `INSERT INTO repo_records(
      lineage_id,rel_path,path_order,repo_gen,source_seq,${REPO_VALUE_COLUMNS.join(",")},
      extras_cjson,canonical_bytes,retained_estimate
    ) VALUES (${Array.from({ length: 5 + REPO_VALUE_COLUMNS.length + 3 }, () => "?").join(",")})
    ON CONFLICT(lineage_id,rel_path) DO UPDATE SET
      path_order=excluded.path_order, repo_gen=excluded.repo_gen, source_seq=excluded.source_seq,
      ${REPO_VALUE_COLUMNS.map((column) => `${column}=excluded.${column}`).join(",")},
      extras_cjson=excluded.extras_cjson, canonical_bytes=excluded.canonical_bytes,
      retained_estimate=excluded.retained_estimate`, (upsert) => {
      streamRows<{ rel_path: string; expected_repo_gen: number; record_cjson: string; base_proof_cjson: string | null }>(
        db, `SELECT rel_path,expected_repo_gen,record_cjson,base_proof_cjson
        FROM ${CAS_TRANSITION_TEMP} ORDER BY path_order`, [], (row) => {
          const candidate = decodeTransitionRecord(row.record_cjson);
          const before = previous.get(lineageId, row.rel_path) as {
            base_cjson: string | null; branch_base_origins_cjson: string | null;
          } | null;
          const next = recomposeBase(row.rel_path, candidate, row.base_proof_cjson, before);
          const encoded = encodeRepoRecord(row.rel_path, { ...next, repoGen: row.expected_repo_gen + 1 } as RepoRecord);
          upsert.run(
            lineageId, row.rel_path, encoded.pathOrder, encoded.repoGen, encoded.sourceSeq,
            ...REPO_VALUE_COLUMNS.map((column) => encoded.values[column] ?? null),
            encoded.extrasCjson, encoded.canonicalBytes, encoded.retainedEstimate,
          );
        });
    });
  });
}

/**
 * The persisted `branch_base_origins_cjson` column: a record's own branch
 * provenance, re-established as the v1 union `composeRepoBase` decides against.
 * The parsed object itself is returned, so members this rule cannot see ride
 * along into the recomposed record exactly as they were stored.
 */
function assertBranchBaseOrigins(value: JsonValue): asserts value is JsonValue & Record<string, BranchBaseOrigin> {
  if (!isJsonObject(value)) throw new TypeError("branchBaseOrigins is not a JSON object");
  for (const [ref, origin] of Object.entries(value)) {
    if (!isJsonObject(origin) || origin.v !== 1 || !jsonText(origin.oid) || !jsonText(origin.lineageHash)) {
      throw new TypeError(`branchBaseOrigins.${ref} is not a v1 branch origin`);
    }
    const named = origin.kind === "publisher-ack"
      ? Number.isSafeInteger(origin.sourceSeq) && jsonText(origin.incomingKey)
      : (origin.kind === "pull-p" || origin.kind === "manual") && jsonText(origin.episode);
    if (!named) throw new TypeError(`branchBaseOrigins.${ref} has no known origin kind`);
  }
}

function decodeBranchBaseOrigins(text: string): Record<string, BranchBaseOrigin> {
  const value = parseCanonicalJson(text);
  assertBranchBaseOrigins(value);
  return value;
}

/** Step 2. A record that asks for BASE without an explicit proof never reaches an
 * authority write; a proof that composes to `pending` installs today's safety hold
 * instead of silently landing the requested BASE. */
function recomposeBase(
  relPath: string,
  candidate: RepoRecordInput,
  baseProofCjson: string | null,
  before: { base_cjson: string | null; branch_base_origins_cjson: string | null } | null,
): RepoRecordInput {
  // `before` is a persisted authority repo_records row. A row that no longer
  // decodes is data-at-rest corruption (StateDataCorruptionError), never a bare
  // parse Error or a caller-layer TypeError from the recompose below — the same
  // taxonomy every other authority read observes. The base column routes through
  // the shared Git-section codec so canonical-but-inadmissible bytes are caught
  // here rather than escaping validation.
  const previous: RepoBaseValue = {};
  if (before?.base_cjson != null) {
    previous.base = decodeAuthorityRow("gitSection", relPath, () => decodeGitSection(relPath, before.base_cjson!));
  }
  if (before?.branch_base_origins_cjson != null) {
    previous.branchBaseOrigins = decodeAuthorityRow("repoRecord", relPath,
      () => decodeBranchBaseOrigins(before.branch_base_origins_cjson!));
  }
  if (baseProofCjson === null) {
    // Without a proof this transition may not move BASE authority in ANY
    // direction. Branch origins are BASE provenance in their own right, so a
    // record that still carries origins is protected even with no `base`.
    if (candidate.base !== undefined) throw new ProoflessBaseError(relPath, "the CAS input carries BASE with no proof");
    if (candidate.branchBaseOrigins !== undefined) {
      throw new ProoflessBaseError(relPath, "the CAS input carries branch base origins with no proof");
    }
    if (previous.base !== undefined) {
      throw new ProoflessBaseError(relPath, "the CAS input would drop the authority's BASE with no proof");
    }
    if (previous.branchBaseOrigins !== undefined) {
      throw new ProoflessBaseError(relPath, "the CAS input would drop the authority's branch base origins with no proof");
    }
    return candidate;
  }
  const proof = decodeTransitionBaseProof(baseProofCjson);
  const composed = composeRepoBase(
    previous,
    { base: candidate.base, branchBaseOrigins: candidate.branchBaseOrigins },
    proof.authority,
    proof.lockedProof,
  );
  const next: RepoRecordInput = { ...candidate };
  if (composed.base === undefined) delete next.base; else next.base = composed.base;
  if (composed.branchBaseOrigins === undefined) delete next.branchBaseOrigins;
  else next.branchBaseOrigins = composed.branchBaseOrigins;
  if (composed.disposition === "pending" && candidate.base !== undefined && next.pending === undefined) {
    next.pending = candidate.base;
  }
  return next;
}

/** The manifest projection is derived, never carried: removal and suppression hide
 * a repository from it without destroying its BASE provenance anchor. */
export function rebuildManifestProjection(db: Database, lineageId: string, generation: number): void {
  runStatement(db, "DELETE FROM manifest_git_sections WHERE lineage_id=? AND role='manifest-projection'", lineageId);
  runStatement(db, `INSERT INTO manifest_git_sections(lineage_id,base_generation,role,rel_path,path_order,section_cjson)
    SELECT ?,?,'manifest-projection',rel_path,path_order,base_cjson FROM repo_records
    WHERE lineage_id=? AND base_cjson IS NOT NULL AND repo_absent IS NULL AND removed_key IS NULL`,
  lineageId, generation, lineageId);
}

/* ------------------------------------------------------- the CAS input copy */

export const CAS_TRANSITION_TEMP = "cas_transitions";

export function createTransitionTemp(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS temp.${CAS_TRANSITION_TEMP};
    CREATE TEMP TABLE ${CAS_TRANSITION_TEMP}(
      rel_path TEXT PRIMARY KEY, path_order BLOB NOT NULL, expected_repo_gen INTEGER NOT NULL,
      record_cjson TEXT NOT NULL, base_proof_cjson TEXT, evidence_cjson TEXT NOT NULL);`);
}

export function dropTransitionTemp(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS temp.${CAS_TRANSITION_TEMP}`);
}

/** Per-row evidence travels into the TEMP schema, because step 1 of the CAS checks
 * it against the packet's verified source stages. Dropping it here would make the
 * check unfalsifiable. */
export function copyTransitionRowsIntoTemp(db: Database, reader: SealedTransitionReader): number {
  return withStatement(db, `INSERT INTO ${CAS_TRANSITION_TEMP}(rel_path,path_order,expected_repo_gen,record_cjson,base_proof_cjson,evidence_cjson)
    VALUES (?,?,?,?,?,?)`, (insert) => reader.streamRows((row) => {
    insert.run(
      row.relPath, utf16beOrderKey(row.relPath), row.expectedRepoGen,
      canonicalJson(row.newRecord), row.baseProof === undefined ? null : canonicalJson(row.baseProof),
      canonicalEvidenceOf(row.evidenceBindings),
    );
  }));
}
