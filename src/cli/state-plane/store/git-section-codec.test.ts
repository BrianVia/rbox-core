/** T1.4 — the Git-section codec seam and its error taxonomy at the three routed
 * sites: the generation builder (caller malformation -> TypeError), sealed-stage
 * reads (corruption -> StageChangedError), and authority reads (corrupt row ->
 * StateDataCorruptionError). A well-formed section must round-trip unchanged. */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitSection } from "../../../engine/index.js";
import { decodeGitSection, encodeGitSection } from "../codecs/git-section.js";
import { canonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import { StageDigestBuilder, type StageCounts } from "../digest/stage-semantic-v1.js";
import { StageChangedError, StateDataCorruptionError } from "../errors.js";
import type { ManifestHeader } from "../ports.js";
import { CAS_TRANSITION_TEMP, applyTransitions, createTransitionTemp } from "./cas-steps.js";
import { STAGE_DDL, beginGeneration } from "./generations.js";
import { createStateStore, stateStoreDatabase } from "./open.js";
import { openReadSnapshot } from "./read-snapshot.js";
import { openSealedStage, type SealedStageRef } from "./sealed-stages.js";
import {
  PrivateStageDirectory, StageLock, configureStageBuilder, sealAndPublish, sealedStagePath,
} from "./stage-artifacts.js";

const roots: string[] = [];
const LINEAGE = "b".repeat(32);
const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(prefix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

/** Keys out of order — canonical parse refuses it, standing in for any corrupt
 * durable blob (non-canonical bytes or a canonical non-object). */
const NON_CANONICAL = '{"b":1,"a":2}';

function freshStore(prefix: string) {
  const handle = createStateStore(path.join(root(prefix), "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: "stream", createdBy: "test",
  });
  return { handle, db: stateStoreDatabase(handle) };
}

function expectCorruption(fn: () => unknown, entity: string, key?: string): void {
  let thrown: unknown;
  try { fn(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(StateDataCorruptionError);
  expect((thrown as StateDataCorruptionError).entity).toBe(entity);
  if (key !== undefined) expect((thrown as StateDataCorruptionError).key).toBe(key);
}

/** A well-formed section. `bad` drops a mandatory field to make it inadmissible. */
function section(seed: number): GitSection {
  return {
    bundleSha: hex(64, seed + 1), bundleEncSha: hex(64, seed + 2), bundleCipherSize: seed + 10,
    head: hex(40, seed + 3), refs: {}, config: {}, refScope: "all",
    generatedAt: "2026-07-28T00:00:00.000Z",
  } as GitSection;
}
function withoutRefScope(seed: number): unknown {
  const { refScope: _drop, ...rest } = section(seed);
  return rest;
}

/* ------------------------------------------------------------------ codec unit */

test("encodeGitSection validates path and shape, and round-trips byte-identically", () => {
  const encoded = encodeGitSection("repo-a", section(0));
  expect(encoded.canonical).toBe(canonicalJson(section(0)));
  expect(encoded.bytes).toBe(Buffer.byteLength(encoded.canonical) + Buffer.byteLength("repo-a"));
  // The sync root "." is a legal key; a valid section decodes back to itself.
  expect(decodeGitSection(".", encodeGitSection(".", section(1)).canonical)).toEqual(section(1));
});

test("encodeGitSection rejects a malformed path or section as a TypeError", () => {
  expect(() => encodeGitSection("./repo", section(0))).toThrow(TypeError);
  expect(() => encodeGitSection("../repo", section(0))).toThrow(TypeError);
  expect(() => encodeGitSection("repo-a", withoutRefScope(0) as GitSection)).toThrow(TypeError);
});

test("decodeGitSection refuses non-canonical or inadmissible stored bytes", () => {
  // Not canonical: keys out of order.
  expect(() => decodeGitSection("repo-a", '{"b":1,"a":2}')).toThrow();
  // Canonical but inadmissible (no refScope).
  expect(() => decodeGitSection("repo-a", canonicalJson(withoutRefScope(0)))).toThrow(TypeError);
});

/* ---------------------------------------------------------------- builder site */

test("the generation builder rejects a malformed section as a caller TypeError", () => {
  const stages = path.join(root("rbox-gitsec-builder-"), "stages");
  const header: ManifestHeader = { generatedAt: "2026-07-28T10:00:00.000Z", complete: true };
  const builder = beginGeneration(stages, "base", header);
  try {
    expect(() => builder.putGitSection("meta-wire", "meta-wire/../escape", section(0))).toThrow(TypeError);
    expect(() => builder.putGitSection("meta-wire", "repo-a", withoutRefScope(0) as GitSection)).toThrow(TypeError);
  } finally {
    builder.discardGeneration();
  }
});

test("a well-formed section round-trips unchanged through seal and sealed read", () => {
  const stages = path.join(root("rbox-gitsec-roundtrip-"), "stages");
  const header: ManifestHeader = { generatedAt: "2026-07-28T10:00:00.000Z", complete: true };
  const builder = beginGeneration(stages, "base", header);
  builder.putGitSection("meta-wire", "repo-a", section(5));
  const ref = builder.finishGeneration({ files: 0, gitSections: 1 });
  const lock = StageLock.acquire(stages, ref.stageId);
  const reader = openSealedStage(stages, ref, lock);
  try {
    expect(reader.gitRepo("meta-wire", "repo-a")).toEqual(section(5));
    const page = reader.gitRepoCursor("meta-wire", undefined, 16);
    expect(page.rows).toEqual([{ relPath: "repo-a", section: section(5) }]);
  } finally {
    reader.close();
    lock.release();
  }
});

/* ----------------------------------------------------------------- sealed site */

/** Forge a self-consistent sealed stage whose section is canonical yet
 * inadmissible — its logical digest and physical hash match, so the stage opens,
 * and only the decode at read time can catch it. This is the corruption the seam
 * defends: bytes that pass every proof but are not a valid section. */
test("a sealed stage carrying an inadmissible section fails reads as StageChangedError", () => {
  const stages = path.join(root("rbox-gitsec-sealed-"), "stages");
  const stageId = "a".repeat(32);
  const header: ManifestHeader = { generatedAt: "2026-07-28T10:00:00.000Z", complete: true };
  const badCjson = canonicalJson(withoutRefScope(7));

  const lock = StageLock.acquire(stages, stageId);
  const priv = PrivateStageDirectory.claim(lock);
  const db = new Database(priv.file(), { create: true, readwrite: true });
  configureStageBuilder(db);
  db.exec(STAGE_DDL);
  db.query("INSERT INTO stage_meta(stage_id,plane,state,header_cjson) VALUES (?,?,'building',?)")
    .run(stageId, "base", canonicalJson(header));
  db.exec("BEGIN");
  db.query("INSERT INTO stage_git_roles(stage_id,role) VALUES (?,?)").run(stageId, "meta-wire");
  db.query("INSERT INTO stage_git_sections(stage_id,role,rel_path,path_order,section_cjson) VALUES (?,?,?,?,?)")
    .run(stageId, "meta-wire", "repo-a", utf16beOrderKey("repo-a"), badCjson);
  const digest = new StageDigestBuilder(stageId, "base", header);
  digest.declareRole("meta-wire");
  digest.gitSection("meta-wire", "repo-a", badCjson);
  const counts: StageCounts = digest.counts;
  const logicalDigest = digest.seal(counts);
  db.query("UPDATE stage_meta SET state='sealed',digest=?,counts_cjson=? WHERE stage_id=?")
    .run(logicalDigest, canonicalJson(counts), stageId);
  db.exec("COMMIT");
  const physical = sealAndPublish(db, priv.file(), sealedStagePath(stages, stageId, logicalDigest), stageId);
  priv.destroy();
  lock.release();

  const ref: SealedStageRef = {
    stageId, plane: "base", header, logicalDigest,
    physicalSha256: physical.sha256, bytes: physical.bytes, counts,
  };
  const readLock = StageLock.acquire(stages, stageId);
  const reader = openSealedStage(stages, ref, readLock); // opens: proofs all agree
  try {
    expect(() => reader.gitRepo("meta-wire", "repo-a")).toThrow(StageChangedError);
    expect(() => reader.gitRepoCursor("meta-wire", undefined, 16)).toThrow(StageChangedError);
  } finally {
    reader.close();
    readLock.release();
  }
});

/* -------------------------------------------------------------- authority site */

test("a corrupt Git authority row surfaces as StateDataCorruptionError with entity/key", () => {
  const handle = createStateStore(path.join(root("rbox-gitsec-authority-git-"), "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: "stream", createdBy: "test",
  });
  const db = stateStoreDatabase(handle);
  db.query("INSERT INTO manifest_git_sections VALUES (?,0,'manifest-projection',?,?,?)")
    .run(LINEAGE, "repo-a", utf16beOrderKey("repo-a"), canonicalJson(withoutRefScope(3)));
  const snapshot = openReadSnapshot(handle);
  let thrown: unknown;
  try {
    snapshot.manifestGitRepoCursor(undefined, 16);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(StateDataCorruptionError);
  expect((thrown as StateDataCorruptionError).entity).toBe("gitSection");
  expect((thrown as StateDataCorruptionError).key).toBe("repo-a");
  expect((thrown as StateDataCorruptionError).cause).toBeInstanceOf(TypeError);
  handle.close();
});

test("a corrupt persisted base section read through the CAS path is StateDataCorruptionError", () => {
  const handle = createStateStore(path.join(root("rbox-gitsec-cas-base-"), "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: "stream", createdBy: "test",
  });
  const db = stateStoreDatabase(handle);
  const relPath = "repo-a";
  const order = utf16beOrderKey(relPath);
  // A persisted repo record whose base column is canonical yet inadmissible
  // (no refScope) — corruption the write path would never have admitted.
  db.query(`INSERT INTO repo_records(lineage_id,rel_path,path_order,repo_gen,source_seq,base_cjson,
    canonical_bytes,retained_estimate) VALUES (?,?,?,?,?,?,?,?)`)
    .run(LINEAGE, relPath, order, 1, 1, canonicalJson(withoutRefScope(9)), 4096, 4096);

  // A transition over that same repo reaches recomposeBase, which reads the
  // persisted base. base_proof absent, so the decode is what fails first.
  createTransitionTemp(db);
  db.query(`INSERT INTO ${CAS_TRANSITION_TEMP}(rel_path,path_order,expected_repo_gen,record_cjson,base_proof_cjson,evidence_cjson)
    VALUES (?,?,?,?,NULL,?)`)
    .run(relPath, order, 1, canonicalJson({ sourceSeq: 2 }), canonicalJson({ sourceStages: [] }));

  let thrown: unknown;
  try {
    applyTransitions(db, LINEAGE);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(StateDataCorruptionError);
  expect((thrown as StateDataCorruptionError).entity).toBe("gitSection");
  expect((thrown as StateDataCorruptionError).key).toBe(relPath);
  expect((thrown as StateDataCorruptionError).cause).toBeInstanceOf(TypeError);
  handle.close();
});

test("a corrupt FileEntry authority row surfaces as StateDataCorruptionError", () => {
  const handle = createStateStore(path.join(root("rbox-gitsec-authority-file-"), "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: "stream", createdBy: "test",
  });
  const db = stateStoreDatabase(handle);
  const p = "src/a.ts";
  const order = utf16beOrderKey(p);
  const sha = createHash("sha256").update("x").digest();
  // A structurally sound row whose stored size columns lie: decodeFileEntry
  // recomputes them and refuses the mismatch as data-at-rest corruption.
  db.query(`INSERT INTO entry_values(entry_id,exact_fingerprint,path,path_order,sha256,size,mode,mtime_ms,
    kind,symlink_target,enc_sha,comp,payload_sha,cipher_size,extras_cjson,canonical_bytes,retained_estimate)
    VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?)`)
    .run("e".repeat(32), "f".repeat(64), p, order, sha, 3, 0o644, 1.5, "file", 1, 4096);
  db.query("INSERT INTO plane_entries(lineage_id,plane,path,path_order,entry_id,changed_generation) VALUES (?,?,?,?,?,0)")
    .run(LINEAGE, "base", p, order, "e".repeat(32));
  const snapshot = openReadSnapshot(handle);
  let thrown: unknown;
  try {
    snapshot.files("base", undefined, 16);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(StateDataCorruptionError);
  expect((thrown as StateDataCorruptionError).entity).toBe("fileEntry");
  expect((thrown as StateDataCorruptionError).key).toBe(p);
  handle.close();
});

/* --------------------------------------- token tables read by currentSnapshot */
// Every durable blob the snapshot token decodes is in the taxonomy: a corrupt row
// of ANY authority table is StateDataCorruptionError with that table's entity, not
// a bare Error/TypeError leaking through spreadExtras/parseCanonicalJson.

test("a corrupt state_lineage extras row is StateDataCorruptionError(stateLineage)", () => {
  const { handle, db } = freshStore("rbox-gitsec-lineage-");
  db.query("UPDATE state_lineage SET extras_cjson=? WHERE lineage_id=?").run(NON_CANONICAL, LINEAGE);
  expectCorruption(() => openReadSnapshot(handle), "stateLineage", LINEAGE);
  handle.close();
});

test("a corrupt plane_heads extras row is StateDataCorruptionError(planeHead)", () => {
  const { handle, db } = freshStore("rbox-gitsec-planehead-");
  db.query("UPDATE plane_heads SET extras_cjson=? WHERE lineage_id=? AND plane='base'").run(NON_CANONICAL, LINEAGE);
  expectCorruption(() => openReadSnapshot(handle), "planeHead", "base");
  handle.close();
});

test("a corrupt migration_completion source-presence row is StateDataCorruptionError(migrationCompletion)", () => {
  const { handle, db } = freshStore("rbox-gitsec-migcomp-");
  db.query("UPDATE migration_completion SET source_presence_flags_cjson=? WHERE singleton=1").run(NON_CANONICAL);
  expectCorruption(() => openReadSnapshot(handle), "migrationCompletion", LINEAGE);
  handle.close();
});

test("a corrupt global_manifest_meta extras row is StateDataCorruptionError(globalManifestMeta)", () => {
  const { handle, db } = freshStore("rbox-gitsec-meta-");
  // Genesis carries no meta row; install one at the active base generation (0) so
  // the snapshot materializes it, with a corrupt extras blob.
  db.query(`INSERT OR REPLACE INTO global_manifest_meta(lineage_id,base_generation,enc_manifest_sha,
    manifest_hash,account_epoch,key_epoch,chain_bytes,snapshot_bytes,extras_cjson)
    VALUES (?,0,?,?,0,0,0,1,?)`).run(LINEAGE, Buffer.alloc(32), Buffer.alloc(32), NON_CANONICAL);
  expectCorruption(() => openReadSnapshot(handle), "globalManifestMeta", "0");
  handle.close();
});
