import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry, GitSection } from "../../../engine/index.js";
import { loadRawState, loadState, statePath, StreamMismatchError } from "../../sync-state-store.js";
import {
  type RepoRecord, type SyncState, type TypedBlocker,
} from "../../sync-state-model.js";
import {
  stateFromRepoRecords,
} from "../../sync-state-records.js";
import { loadRawStateFromStore, materializeManifestFromStore } from "../adapters/read-only.js";
import { encodeFileEntry } from "../codecs/file-entry.js";
import { encodeRepoRecord } from "../codecs/repo-record.js";
import { canonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import {
  CursorWindowError,
  GitSectionOversizeError,
  SnapshotChangedError,
} from "../errors.js";
import { createStateStore, stateStoreDatabase, type StateStoreHandle } from "./open.js";
import { openReadSnapshot } from "./read-snapshot.js";

const roots: string[] = [];
const LINEAGE = "b".repeat(32);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(prefix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

function hex(width: number, value: number): string {
  return value.toString(16).padStart(width, "0");
}

function section(value: number, extras: Partial<GitSection> = {}): GitSection {
  return {
    ...extras,
    bundleSha: hex(64, value + 1),
    bundleEncSha: hex(64, value + 2),
    bundleCipherSize: value + 100,
    head: "ref: refs/heads/main",
    refs: { "refs/heads/main": hex(40, value + 3) },
    config: {},
    refScope: "all",
    generatedAt: `2026-07-28T00:${String(value % 60).padStart(2, "0")}:00.000Z`,
  } as GitSection;
}

function projection(bytes: number) {
  return { bytes, sha256: hex(64, bytes), prefixB64: "", truncated: false };
}

function completePRepairReceipt() {
  const lineageHash = "1".repeat(64);
  const repositoryIdentityHash = "2".repeat(64);
  const ref = "refs/heads/pull";
  const episode = "3".repeat(32);
  const targetOid = "4".repeat(40);
  const q = {
    v: 1,
    kind: "p-repair",
    lineageHash,
    repositoryIdentityHash,
    p: {
      artifactRef: projection(1),
      artifactOid: targetOid,
      payload: {
        v: 2,
        lineageHash,
        repositoryIdentityHash,
        ref: projection(2),
        episode,
        priorOid: null,
        nextOid: targetOid,
      },
      payloadBytes: 3,
      payloadSha256: "5".repeat(64),
    },
    observed: {
      liveOid: null,
      baseOid: null,
      repoGen: 1,
      stateRevision: 7,
      incomingKey: "incoming",
      reflog: { bytes: 4, entries: 1, sha256: "6".repeat(64), top: projection(4) },
    },
    preserved: { count: 1, oidsSha256: "7".repeat(64) },
    repair: {
      at: "2026-07-28T00:00:00.000Z",
      reason: "live-mismatch",
      baseDisposition: "advance-prior-to-next",
    },
  } as const;
  return {
    v: 1,
    kind: "p-repaired",
    lineageHash,
    repositoryIdentityHash,
    ref,
    episode,
    p: { ref: "refs/rbox-base/present/p", targetOid },
    k: [{ ref: "refs/rbox-base/keep/k", targetOid }],
    q: { ref: "refs/rbox-recovery/q", targetOid, value: q },
    origin: { ref, episode, class: "human" },
    skeep: { count: 1, oidsSha256: "8".repeat(64) },
    reflog: { bytes: 4, sha256: "9".repeat(64) },
    baseDisposition: "advance-prior-to-next",
    eviction: { qRef: "refs/rbox-recovery/old", targetOid },
  } as const;
}

/** One unknown extension per index, cycling: none, null, object, array. */
const EXTENSIONS = [{}, { extensionNull: null }, { extensionObject: {} }, { extensionArray: [] }] as const;

function realisticState(): SyncState {
  const files: FileEntry[] = Array.from({ length: 513 }, (_, index) => ({
    path: `files/${String(index).padStart(3, "0")}.txt`,
    sha256: hex(64, index + 1),
    size: index === 0 ? 2 ** 53 + 2 : index,
    mode: index % 2 ? 0o755 : 0o644,
    mtimeMs: index + 0.25,
    type: "file",
    ...EXTENSIONS[index % 4],
  } as FileEntry));
  const records: Record<string, RepoRecord> = {};
  for (let index = 0; index < 17; index++) {
    records[`repo-${String(index).padStart(2, "0")}`] = {
      repoGen: index + 1,
      sourceSeq: 41,
      base: section(index),
      ...EXTENSIONS[index % 4],
    } as RepoRecord;
  }
  const originSection = section(50);
  originSection.refs = {
    "refs/heads/main": "a".repeat(40),
    "refs/heads/pull": "b".repeat(40),
    "refs/heads/ack": "c".repeat(40),
    "refs/heads/manual": "d".repeat(40),
  };
  records["repo-00"] = {
    ...records["repo-00"]!,
    base: originSection,
    branchBaseOrigins: {
      "refs/heads/pull": {
        v: 1, oid: "b".repeat(40), lineageHash: "e".repeat(64), kind: "pull-p", episode: "1".repeat(32),
      },
      "refs/heads/ack": {
        v: 1, oid: "c".repeat(40), lineageHash: "e".repeat(64), kind: "publisher-ack",
        sourceSeq: 41, incomingKey: "ack-incoming",
      },
      "refs/heads/manual": {
        v: 1, oid: "d".repeat(40), lineageHash: "e".repeat(64), kind: "manual", episode: "2".repeat(32),
      },
    },
  };
  records["repo-01"] = {
    ...records["repo-01"]!,
    partial: {
      incomingKey: "partial-incoming",
      checkoutPending: true,
      appliedRefs: {
        direct: { kind: "direct", oid: "1".repeat(40) },
        symbolic: { kind: "symbolic", target: "refs/heads/main" },
        absent: { kind: "absent", artifactOid: "2".repeat(40) },
        present: { kind: "present", oid: "3".repeat(40), artifactOid: "4".repeat(40), episode: "3".repeat(32) },
        expected: { kind: "safe-ref", proof: "expected-old-transaction", beforeOid: null, afterOid: "5".repeat(40) },
        terminal: { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: null },
      },
      pRepaired: { "refs/heads/pull": completePRepairReceipt() },
      heldRefs: { "refs/heads/held": "ownership" },
      configApplied: false,
      configBase: {},
    },
  };
  const blockers: TypedBlocker[] = [
    { provenance: "ref-plane", reason: "local-commits", ref: "refs/heads/main" },
    { provenance: "checkout", reason: "local-index" },
    { provenance: "boundary", reason: "containment", detail: "outside" },
    { provenance: "indeterminate", reason: "unreadable", detail: "io" },
    { provenance: "protocol", reason: "artifact", detail: "missing" },
    { provenance: "composer", reason: "artifact", detail: "proof", code: "missing-branch-proof" },
  ];
  records["repo-02"] = {
    ...records["repo-02"]!,
    packedRefsIdentity: { mtimeMs: 12.5 },
    cfgToken: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
    cfgStore: {
      repoKind: "standalone",
      commonDir: { realpath: "/repo/.git", dev: "1", ino: "2", birthtime: "3" },
    },
    attempt: {
      incomingKey: "held-incoming",
      effectiveBaseIndexProjection: null,
      effectiveIncomingIndexProjection: "incoming-index",
      incomingIndexArtifactDescriptor: "descriptor",
      localFingerprint: "fingerprint",
      fingerprintVersion: "v1",
      reflogs: [{ path: "logs/HEAD", digest: "digest" }],
      blockers,
      repoIdentity: "identity",
      stateNonce: "c".repeat(32),
      baseOriginsHash: "origins",
      partialDisposition: "held",
      at: "2026-07-28T00:00:00.000Z",
    },
    resolutionReceipt: {
      repo: "repo-02",
      attemptedGitIncomingKey: "incoming",
      attemptedSequence: 41,
      confirmedReportHash: "report",
    },
  };
  records["repo-removed"] = {
    repoGen: 18,
    sourceSeq: 41,
    pending: section(80),
    removedKey: "removed",
    resolutionKey: "resolution",
  };
  const metaGitRepos = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `repo-${String(index).padStart(2, "0")}`,
      section(index + 100, index === 0 ? { extensionNull: null, extensionObject: {}, extensionArray: [] } : {}),
    ]),
  );
  return stateFromRepoRecords({
    extensionNull: null,
    extensionObject: {},
    extensionArray: [],
    stream: "workspace/project",
    lastSyncedSequence: 41,
    lastSyncedManifest: {
      generatedAt: "2026-07-28T12:00:00.000Z",
      manifestSchema: 2,
      files,
      extensionNull: null,
      extensionObject: {},
      extensionArray: [],
    } as never,
    manifestMeta: {
      encManifestSha: hex(64, 999),
      manifestHash: hex(64, 998),
      accountEpoch: 2,
      keyEpoch: 3,
      chain: [hex(64, 900), hex(64, 901)],
      chainBytes: 1234,
      snapshotBytes: 5678,
      gitRepos: metaGitRepos,
      extensionNull: null,
      extensionObject: {},
      extensionArray: [],
    } as never,
    stateNonce: "c".repeat(32),
    stateRevision: 7,
    telemetryBindingId: "d".repeat(16),
  } as SyncState, records);
}

function insertEntry(handle: StateStoreHandle, entry: FileEntry): void {
  const db = stateStoreDatabase(handle);
  const encoded = encodeFileEntry(entry);
  db.query(`INSERT INTO entry_values(
    entry_id,exact_fingerprint,path,path_order,sha256,size,mode,mtime_ms,kind,
    symlink_target,enc_sha,comp,payload_sha,cipher_size,extras_cjson,canonical_bytes,retained_estimate
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    encoded.entryId, encoded.exactFingerprint, encoded.path, encoded.pathOrder, encoded.sha256,
    encoded.size, encoded.mode, encoded.mtimeMs, encoded.kind, encoded.symlinkTarget,
    encoded.encSha, encoded.comp, encoded.payloadSha, encoded.cipherSize, encoded.extrasCjson,
    encoded.canonicalBytes, encoded.retainedEstimate,
  );
  db.query(`INSERT INTO plane_entries(
    lineage_id,plane,path,path_order,entry_id,changed_generation
  ) VALUES (?,?,?,?,?,3)`).run(LINEAGE, "base", encoded.path, encoded.pathOrder, encoded.entryId);
}

const REPO_VALUE_COLUMNS = [
  "base_cjson", "advertised_cjson", "branch_base_origins_cjson", "packed_refs_identity",
  "pending_cjson", "repo_absent", "removed_key", "resolution_key", "cfg_synced", "cfg_applied",
  "cfg_token_cjson", "cfg_store_cjson", "deferrals_cjson", "partial_cjson", "attempt_cjson",
  "resolution_receipt_cjson", "idx_proj",
] as const;

function insertRepo(handle: StateStoreHandle, relPath: string, record: RepoRecord): void {
  const db = stateStoreDatabase(handle);
  const encoded = encodeRepoRecord(relPath, record);
  db.query(`INSERT INTO repo_records(
    lineage_id,rel_path,path_order,repo_gen,source_seq,${REPO_VALUE_COLUMNS.join(",")},
    extras_cjson,canonical_bytes,retained_estimate
  ) VALUES (${Array.from({ length: 5 + REPO_VALUE_COLUMNS.length + 3 }, () => "?").join(",")})`).run(
    LINEAGE, relPath, encoded.pathOrder, encoded.repoGen, encoded.sourceSeq,
    ...REPO_VALUE_COLUMNS.map((column) => encoded.values[column] ?? null),
    encoded.extrasCjson, encoded.canonicalBytes, encoded.retainedEstimate,
  );
}

function insertState(handle: StateStoreHandle, state: SyncState): void {
  const db = stateStoreDatabase(handle);
  db.transaction(() => {
    db.query(`UPDATE state_lineage SET
      state_nonce=?,state_revision=?,last_synced_sequence=?,telemetry_binding_id=?,extras_cjson=?
      WHERE lineage_id=?`).run(
      state.stateNonce!, state.stateRevision!, state.lastSyncedSequence, state.telemetryBindingId!,
      canonicalJson({ extensionNull: null, extensionObject: {}, extensionArray: [] }), LINEAGE,
    );
    db.query(`UPDATE plane_heads SET generation=3,generated_at=?,manifest_schema=2,
      source_sequence=41,complete=1,extras_cjson=? WHERE lineage_id=? AND plane='base'`).run(
      state.lastSyncedManifest.generatedAt,
      canonicalJson({ extensionNull: null, extensionObject: {}, extensionArray: [] }),
      LINEAGE,
    );
    db.query(`UPDATE migration_completion SET source_repo_records_present=1,
      source_presence_flags_cjson=?,entry_count=?,repo_count=? WHERE singleton=1`).run(
      canonicalJson({
        stream: true,
        stateNonce: true,
        stateRevision: true,
        lastSyncedManifest: { manifestSchema: true, gitRepos: true },
      }),
      state.lastSyncedManifest.files.length,
      Object.keys(state.repoRecords!).length,
    );
    for (const entry of state.lastSyncedManifest.files) insertEntry(handle, entry);
    for (const [relPath, record] of Object.entries(state.repoRecords!)) insertRepo(handle, relPath, record);

    const meta = state.manifestMeta!;
    db.query(`INSERT INTO global_manifest_meta(
      lineage_id,base_generation,enc_manifest_sha,manifest_hash,account_epoch,key_epoch,
      chain_bytes,snapshot_bytes,extras_cjson
    ) VALUES (?,3,?,?,?,?,?,?,?)`).run(
      LINEAGE, Buffer.from(meta.encManifestSha, "hex"), Buffer.from(meta.manifestHash, "hex"),
      meta.accountEpoch, meta.keyEpoch, meta.chainBytes, meta.snapshotBytes,
      canonicalJson({ extensionNull: null, extensionObject: {}, extensionArray: [] }),
    );
    for (const [ordinal, encSha] of meta.chain.entries()) {
      db.query("INSERT INTO manifest_chain VALUES (?,3,?,?)")
        .run(LINEAGE, ordinal, Buffer.from(encSha, "hex"));
    }
    for (const [relPath, git] of Object.entries(state.lastSyncedManifest.gitRepos!)) {
      db.query("INSERT INTO manifest_git_sections VALUES (?,3,'manifest-projection',?,?,?)")
        .run(LINEAGE, relPath, utf16beOrderKey(relPath), canonicalJson(git));
    }
    for (const [relPath, git] of Object.entries(meta.gitRepos)) {
      db.query("INSERT INTO manifest_git_sections VALUES (?,3,'meta-wire',?,?,?)")
        .run(LINEAGE, relPath, utf16beOrderKey(relPath), canonicalJson(git));
    }
  })();
}

function enforceExpectedStreamAtCompatibilityBoundary(
  testRoot: string,
  expectedStream: string,
  observed: SyncState,
): SyncState {
  if (observed.stream !== expectedStream) {
    throw new StreamMismatchError(testRoot, expectedStream, observed.stream, "state");
  }
  return observed;
}

async function captureStreamMismatch(run: () => SyncState | Promise<SyncState>): Promise<StreamMismatchError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(StreamMismatchError);
    return error as StreamMismatchError;
  }
  throw new Error("expected StreamMismatchError");
}

test("direct SQL read path is strictly differential with realistic JSON state across cursor windows", async () => {
  const fixture = JSON.parse(JSON.stringify(realisticState())) as SyncState;
  const jsonRoot = root("rbox-store-json-differential-");
  fs.mkdirSync(path.dirname(statePath(jsonRoot)), { recursive: true });
  fs.writeFileSync(statePath(jsonRoot), JSON.stringify(fixture));
  const jsonState = await loadRawState(jsonRoot);
  expect(jsonState).toStrictEqual(fixture);

  const sqlRoot = root("rbox-store-sql-differential-");
  const handle = createStateStore(path.join(sqlRoot, "state.db"), {
    authorityId: "a".repeat(32),
    lineageId: LINEAGE,
    stream: fixture.stream,
    createdBy: "test",
    stateNonce: fixture.stateNonce,
    stateRevision: fixture.stateRevision,
    telemetryBindingId: fixture.telemetryBindingId,
  });
  insertState(handle, fixture);

  const snapshot = openReadSnapshot(handle);
  const filePage1 = snapshot.files("base", undefined, 512);
  expect(filePage1.rows).toHaveLength(512);
  expect(filePage1.done).toBe(false);
  const filePage2 = snapshot.files("base", filePage1.after, 512);
  expect(filePage2.rows).toHaveLength(1);
  expect(filePage2.done).toBe(true);
  const repoPage1 = snapshot.repos(undefined, 16);
  expect(repoPage1.rows).toHaveLength(16);
  expect(repoPage1.done).toBe(false);
  const repoPage2 = snapshot.repos(repoPage1.after, 16);
  expect(repoPage2.rows).toHaveLength(2);
  expect(repoPage2.done).toBe(true);
  const gitPage1 = snapshot.manifestGitRepoCursor(undefined, 16);
  expect(gitPage1.rows).toHaveLength(16);
  expect(gitPage1.done).toBe(false);
  expect(snapshot.manifestGitRepoCursor(gitPage1.after, 16).rows).toHaveLength(1);
  expect(snapshot.metaGitRepoCursor(undefined, 16).done).toBe(false);
  expect(snapshot.manifestChainCursor(undefined, 512).rows).toHaveLength(2);
  expect(() => snapshot.files("base", undefined, 513)).toThrow(CursorWindowError);
  expect(() => snapshot.repos(undefined, 17)).toThrow(CursorWindowError);
  expect(() => snapshot.manifestGitRepoCursor(undefined, 17)).toThrow(CursorWindowError);
  expect(() => snapshot.manifestChainCursor(undefined, 513)).toThrow(CursorWindowError);
  snapshot.finishProjection();

  expect(materializeManifestFromStore(handle, {
    plane: "base",
    purpose: "wire-delta",
    projectionToken: snapshot.token,
  })).toStrictEqual(fixture.lastSyncedManifest);
  expect(loadRawStateFromStore(handle)).toStrictEqual(jsonState);

  const stale = openReadSnapshot(handle);
  stateStoreDatabase(handle).query(
    "UPDATE plane_heads SET generated_at='changed' WHERE lineage_id=? AND plane='base'",
  ).run(LINEAGE);
  expect(() => stale.finishProjection()).toThrow(SnapshotChangedError);
  expect(() => materializeManifestFromStore(handle, {
    plane: "base",
    purpose: "wire-snapshot",
    projectionToken: stale.token,
  })).toThrow(SnapshotChangedError);
  handle.close();
});

test("wrong-stream compatibility preserves authority and has JSON/SQLite typed refusal parity", async () => {
  const fixture = JSON.parse(JSON.stringify(realisticState())) as SyncState;
  const sharedRoot = root("rbox-store-stream-mismatch-");
  fs.mkdirSync(path.dirname(statePath(sharedRoot)), { recursive: true });
  fs.writeFileSync(statePath(sharedRoot), JSON.stringify(fixture));
  const handle = createStateStore(path.join(sharedRoot, "state.db"), {
    authorityId: "a".repeat(32),
    lineageId: LINEAGE,
    stream: fixture.stream,
    createdBy: "test",
    stateNonce: fixture.stateNonce,
    stateRevision: fixture.stateRevision,
    telemetryBindingId: fixture.telemetryBindingId,
  });
  insertState(handle, fixture);

  const expectedStream = "workspace/other";
  const jsonError = await captureStreamMismatch(() => loadState(sharedRoot, expectedStream));
  const sqliteRaw = loadRawStateFromStore(handle);
  expect(sqliteRaw.stream).toBe(fixture.stream);
  expect(sqliteRaw.lastSyncedSequence).toBe(41);
  expect(sqliteRaw.lastSyncedManifest.files.length).toBeGreaterThan(0);
  expect(Object.keys(sqliteRaw.repoRecords ?? {}).length).toBeGreaterThan(0);
  expect(sqliteRaw).not.toEqual({
    stream: expectedStream,
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });

  // SQLite intentionally has no production expected-stream read yet. This
  // test-only translation records the contract the future compatibility
  // boundary must implement without letting the raw substrate fabricate state.
  const sqliteError = await captureStreamMismatch(() =>
    enforceExpectedStreamAtCompatibilityBoundary(sharedRoot, expectedStream, sqliteRaw)
  );
  expect({
    name: sqliteError.name,
    expectedStream: sqliteError.expectedStream,
    observedStream: sqliteError.observedStream,
    source: sqliteError.source,
    message: sqliteError.message,
  }).toEqual({
    name: jsonError.name,
    expectedStream: jsonError.expectedStream,
    observedStream: jsonError.observedStream,
    source: jsonError.source,
    message: jsonError.message,
  });
  handle.close();
});

test("empty manifest gitRepos presence survives independently of child rows", () => {
  const testRoot = root("rbox-store-empty-git-shape-");
  const handle = createStateStore(path.join(testRoot, "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: "stream", createdBy: "test",
  });
  const absent = openReadSnapshot(handle);
  expect(materializeManifestFromStore(handle, {
    plane: "base", purpose: "wire-snapshot", projectionToken: absent.token,
  })).not.toHaveProperty("gitRepos");
  stateStoreDatabase(handle).query(
    "UPDATE migration_completion SET source_presence_flags_cjson=? WHERE singleton=1",
  ).run(canonicalJson({ lastSyncedManifest: { gitRepos: true } }));
  const present = openReadSnapshot(handle);
  expect(materializeManifestFromStore(handle, {
    plane: "base", purpose: "wire-snapshot", projectionToken: present.token,
  }).gitRepos).toEqual({});
  expect(loadRawStateFromStore(handle).lastSyncedManifest.gitRepos).toEqual({});
  handle.close();
});

test("Git cursors enforce both row and byte ceilings", () => {
  const testRoot = root("rbox-store-git-byte-window-");
  const handle = createStateStore(path.join(testRoot, "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: "stream", createdBy: "test",
  });
  const db = stateStoreDatabase(handle);
  const large = (marker: string, bytes: number) => canonicalJson({
    ...section(marker.charCodeAt(0)),
    padding: marker.repeat(bytes),
  });
  for (const [relPath, marker] of [["a", "a"], ["b", "b"]] as const) {
    db.query("INSERT INTO manifest_git_sections VALUES (?,0,'manifest-projection',?,?,?)")
      .run(LINEAGE, relPath, utf16beOrderKey(relPath), large(marker, 3 * 1024 * 1024));
  }
  const snapshot = openReadSnapshot(handle);
  const first = snapshot.manifestGitRepoCursor(undefined, 16);
  expect(first.rows).toHaveLength(1);
  expect(first.done).toBe(false);
  expect(snapshot.manifestGitRepoCursor(first.after, 16)).toMatchObject({ done: true });

  db.query("UPDATE manifest_git_sections SET section_cjson=? WHERE rel_path='b'")
    .run(large("b", 4 * 1024 * 1024 + 1));
  const oversize = openReadSnapshot(handle);
  expect(() => oversize.manifestGitRepoCursor("a", 16)).toThrow(GitSectionOversizeError);
  handle.close();
});
