/**
 * Write-then-read differential harness.
 *
 * The SAME logical delta — byte-identical transition inputs and the same file-only
 * manifest — is applied to the JSON authority through `applyStateSavePacket` and to
 * the SQLite store through its save adapter. Both sides are then read back through
 * their own durable form, and the resulting `SyncState` values must be strictly
 * equal. A store that merely round-trips its own writes would pass a self-test;
 * only this comparison proves the write seam preserves the JSON authority's
 * semantics.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry, GitSection, Manifest } from "../../../engine/index.js";
import type { LockIdentitySource } from "../../../engine/lockfile.js";
import { carryRepoBaseProof, type RepoBaseProof } from "../../sync-git/base-composer.js";
import {
  applyStateSavePacket, loadRawState, statePath,
} from "../../sync-state-store.js";
import type {
  GlobalManifestMeta, RepoRecordInput, StateSavePacket, SyncState,
} from "../../sync-state-model.js";
import { loadRawStateFromStore } from "../adapters/read-only.js";
import { applySavePacketToStore } from "../adapters/sqlite-state-save.js";
import { authorityMarkerBytes } from "../authority-marker.js";
import { StateWriteRefusedError } from "../errors.js";
import { sqliteResetPaths } from "../paths.js";
import type { ManifestHeader } from "../ports.js";
import { createStateStore, openStateStore } from "./open.js";
import { casOwnerTokenForTest } from "./owner-token-testkit.js";

const roots: string[] = [];
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const STREAM = "https://api.test::ws_163::root";
const OWNER = casOwnerTokenForTest(() => true);

const identity: LockIdentitySource = {
  current: async () => ({ hostId: "84", bootId: "84", pid: 84, startTime: "1" }),
  probe: async () => ({ status: "alive", startTime: "1" }),
};
const lockOptions = { identity, token: () => "8".repeat(32) };

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(prefix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

function entry(name: string, seed: number, extras: Partial<FileEntry> = {}): FileEntry {
  return {
    ...extras,
    path: name,
    sha256: hex(64, seed),
    size: seed,
    mode: seed % 2 ? 0o755 : 0o644,
    mtimeMs: seed + 0.5,
    type: "file",
  } as FileEntry;
}

function section(seed: number, refs: Record<string, string> = {}): GitSection {
  return {
    bundleSha: hex(64, seed + 1),
    bundleEncSha: hex(64, seed + 2),
    bundleCipherSize: seed + 10,
    // A symbolic HEAD must name a branch the section carries, so an empty-ref
    // section is detached. Empty refs keep a carry proof on its terminal path.
    head: refs["refs/heads/main"] === undefined ? hex(40, seed + 3) : "ref: refs/heads/main",
    refs,
    config: {},
    refScope: "all",
    generatedAt: `2026-07-28T00:${String(seed % 60).padStart(2, "0")}:00.000Z`,
  } as GitSection;
}

function meta(seed: number, chain: string[]): GlobalManifestMeta {
  return {
    encManifestSha: hex(64, seed),
    manifestHash: hex(64, seed + 1),
    accountEpoch: 1,
    keyEpoch: 2,
    chain,
    chainBytes: chain.length === 0 ? 0 : 4096,
    snapshotBytes: 8192,
    gitRepos: {},
  };
}

interface Delta {
  header: ManifestHeader;
  files: FileEntry[];
  manifestMeta?: GlobalManifestMeta;
  sourceGlobalSeq: number;
  transitions: Array<{ relPath: string; expectedRepoGen: number; newRecord: RepoRecordInput; baseProof?: RepoBaseProof }>;
}

/* ------------------------------------------------------------- JSON authority */

function jsonPacket(delta: Delta, expectedNonce: string): StateSavePacket {
  const manifest = {
    generatedAt: delta.header.generatedAt,
    files: delta.files,
    ...(delta.header.manifestSchema === undefined ? {} : { manifestSchema: delta.header.manifestSchema }),
  } as Manifest;
  return {
    expectedStream: STREAM,
    expectedNonce,
    sourceGlobalSeq: delta.sourceGlobalSeq,
    global: { manifest, ...(delta.manifestMeta ? { manifestMeta: delta.manifestMeta } : {}) },
    repos: delta.transitions.map((transition) => ({ ...transition })),
  };
}

/* ------------------------------------------------------------------ the deltas */

const SEED: Delta = {
  header: { generatedAt: "2026-07-28T10:00:00.000Z", manifestSchema: 2, complete: true },
  files: [entry("a/one.txt", 1), entry("a/two.txt", 2), entry("b/three.txt", 3)],
  manifestMeta: meta(900, []),
  sourceGlobalSeq: 5,
  transitions: [
    {
      relPath: "repo-clean",
      expectedRepoGen: 0,
      newRecord: { sourceSeq: 5, base: section(20) },
      baseProof: carryRepoBaseProof("lineage-clean"),
    },
    {
      // A branch ref under a carry proof is a hard hold: BASE must NOT land, and
      // the requested value is copied to `pending` as today's safety hold.
      relPath: "repo-held",
      expectedRepoGen: 0,
      newRecord: { sourceSeq: 5, base: section(30, { "refs/heads/main": "a".repeat(40) }) },
      baseProof: carryRepoBaseProof("lineage-held"),
    },
    { relPath: "repo-plain", expectedRepoGen: 0, newRecord: { sourceSeq: 5, removedKey: "removed-1" } },
  ],
};

const DELTA: Delta = {
  header: { generatedAt: "2026-07-28T11:00:00.000Z", manifestSchema: 2, complete: true },
  // one unchanged, one modified, one deleted, one added
  files: [entry("a/one.txt", 1), entry("a/two.txt", 42), entry("c/four.txt", 4)],
  manifestMeta: meta(901, [hex(64, 910), hex(64, 911)]),
  sourceGlobalSeq: 9,
  transitions: [
    {
      relPath: "repo-clean",
      expectedRepoGen: 1,
      newRecord: { sourceSeq: 9, base: section(20), repoAbsent: true, idxProj: "projection" },
      baseProof: carryRepoBaseProof("lineage-clean"),
    },
    {
      relPath: "repo-new",
      expectedRepoGen: 0,
      newRecord: {
        sourceSeq: 9,
        resolutionKey: "resolution-1",
        resolutionReceipt: {
          repo: "repo-new", attemptedGitIncomingKey: "incoming", attemptedSequence: 9, confirmedReportHash: "hash",
        },
      },
    },
  ],
};

function seedJsonAuthority(jsonRoot: string): void {
  fs.mkdirSync(path.dirname(statePath(jsonRoot)), { recursive: true });
  fs.writeFileSync(statePath(jsonRoot), JSON.stringify({
    stream: STREAM,
    stateNonce: NONCE,
    stateRevision: 0,
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
    repoRecords: {},
  } satisfies SyncState));
}

test("write-then-read round trips are strictly differential with the JSON authority", async () => {
  const jsonRoot = root("rbox-cas-json-");
  const sqlRoot = root("rbox-cas-sql-");
  seedJsonAuthority(jsonRoot);
  const handle = createStateStore(path.join(sqlRoot, "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  });

  for (const delta of [SEED, DELTA]) {
    const packet = jsonPacket(delta, NONCE);
    const jsonResult = await applyStateSavePacket(jsonRoot, packet, { lock: lockOptions });
    expect(jsonResult.status).toBe("accepted");

    const casResult = await applySavePacketToStore(handle, packet, OWNER);
    expect(casResult.status).toBe("accepted");

    const fromJson = await loadRawState(jsonRoot);
    const fromStore = loadRawStateFromStore(handle);
    expect(fromStore).toStrictEqual(fromJson!);
  }

  const final = loadRawStateFromStore(handle);
  expect(final.lastSyncedSequence).toBe(9);
  expect(final.stateRevision).toBe(2);
  expect(final.lastSyncedManifest.files.map((file) => file.path)).toEqual(["a/one.txt", "a/two.txt", "c/four.txt"]);
  // repo-clean went repoAbsent, so it is hidden from the manifest projection while
  // its BASE anchor survives on the record.
  expect(Object.keys(final.lastSyncedManifest.gitRepos ?? {})).toEqual([]);
  expect(final.repoRecords!["repo-clean"]!.base).toBeDefined();
  expect(final.repoRecords!["repo-held"]!.base).toBeUndefined();
  expect(final.repoRecords!["repo-held"]!.pending).toBeDefined();
  expect(final.repoRecords!["repo-clean"]!.repoGen).toBe(2);
  handle.close();
});

test("a repo-only packet preserves the whole global plane and still increments the revision", async () => {
  const jsonRoot = root("rbox-cas-json-repo-only-");
  const sqlRoot = root("rbox-cas-sql-repo-only-");
  seedJsonAuthority(jsonRoot);
  const handle = createStateStore(path.join(sqlRoot, "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  });
  expect((await applyStateSavePacket(jsonRoot, jsonPacket(SEED, NONCE), { lock: lockOptions })).status).toBe("accepted");
  expect((await applySavePacketToStore(handle, jsonPacket(SEED, NONCE), OWNER)).status).toBe("accepted");

  const repoOnly: Delta = { ...DELTA, transitions: DELTA.transitions };
  const jsonResult = await applyStateSavePacket(jsonRoot, {
    expectedStream: STREAM,
    expectedNonce: NONCE,
    sourceGlobalSeq: repoOnly.sourceGlobalSeq,
    repos: repoOnly.transitions.map((transition) => ({ ...transition })),
  }, { lock: lockOptions });
  expect(jsonResult.status).toBe("accepted");

  const packet: StateSavePacket = {
    expectedStream: STREAM,
    expectedNonce: NONCE,
    sourceGlobalSeq: repoOnly.sourceGlobalSeq,
    repos: repoOnly.transitions.map((transition) => ({ ...transition })),
  };
  const result = await applySavePacketToStore(handle, packet, OWNER);
  expect(result.status).toBe("accepted");

  const fromJson = await loadRawState(jsonRoot);
  expect(loadRawStateFromStore(handle)).toStrictEqual(fromJson!);
  expect(fromJson!.lastSyncedSequence).toBe(5);
  handle.close();
});

test("adapter preserves raw stream and nonce rejections and leaves authority unchanged", async () => {
  const sqlRoot = root("rbox-cas-sql-reject-");
  const handle = createStateStore(path.join(sqlRoot, "state.db"), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  });
  const before = loadRawStateFromStore(handle);
  for (const [packet, reason] of [
    [{ ...jsonPacket(SEED, NONCE), expectedStream: "other-stream" }, "stream"],
    [jsonPacket(SEED, "d".repeat(32)), "nonce"],
  ] as const) {
    const result = await applySavePacketToStore(handle, packet, OWNER);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toBe(reason);
      result.retry.close();
    }
    expect(loadRawStateFromStore(handle)).toStrictEqual(before);
    expect(fs.readdirSync(sqlRoot).filter((name) => name.startsWith("stage-"))).toEqual([]);
  }
  handle.close();
});

test("adapter owns sealed-stage cleanup before CAS ownership and on unsupported stores", async () => {
  const sqlRoot = root("rbox-cas-sql-cleanup-");
  const target = path.join(sqlRoot, "state.db");
  const handle = createStateStore(target, {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  });
  const invalid = jsonPacket(SEED, NONCE);
  invalid.repos = [{ ...invalid.repos[0]!, expectedRepoGen: -1 }];
  await expect(applySavePacketToStore(handle, invalid, OWNER)).rejects.toThrow("invalid expected generation");
  expect(fs.readdirSync(sqlRoot).filter((name) => name.startsWith("stage-"))).toEqual([]);
  handle.close();

  const readonly = openStateStore(target, { readonly: true });
  const result = await applySavePacketToStore(readonly, jsonPacket(SEED, NONCE), OWNER);
  expect(result.status).toBe("unsupported");
  expect(fs.readdirSync(sqlRoot).filter((name) => name.startsWith("stage-"))).toEqual([]);
  readonly.close();
});

test("selected adapter refuses an unsupported Q lock with zero opens and byte-identical authority", async () => {
  const sqlRoot = root("rbox-cas-sql-selected-unsupported-");
  fs.mkdirSync(sqliteResetPaths.stateRoot(sqlRoot), { recursive: true });
  createStateStore(sqliteResetPaths.active(sqlRoot), {
    authorityId: "a".repeat(32), lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  }).close();
  fs.writeFileSync(statePath(sqlRoot), authorityMarkerBytes("a".repeat(32)));
  const before = Object.fromEntries(fs.readdirSync(sqliteResetPaths.stateRoot(sqlRoot)).sort().map((name) => [
    name,
    fs.readFileSync(path.join(sqliteResetPaths.stateRoot(sqlRoot), name)).toString("base64"),
  ]));
  const active = path.resolve(sqliteResetPaths.active(sqlRoot));
  const originalOpen = fs.openSync;
  let storeOpens = 0;
  const open = spyOn(fs, "openSync").mockImplementation(((file, ...args) => {
    if (path.resolve(String(file)) === active) storeOpens += 1;
    return originalOpen(file, ...args);
  }) as typeof fs.openSync);
  try {
    const result = await applyStateSavePacket(sqlRoot, jsonPacket(SEED, NONCE), {
      lock: {
        identity: {
          current: async () => { throw new Error("identity unavailable"); },
          probe: async () => ({ status: "unknown" }),
        },
      },
    });
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.error).toBeInstanceOf(StateWriteRefusedError);
    expect(storeOpens).toBe(0);
    expect(Object.fromEntries(fs.readdirSync(sqliteResetPaths.stateRoot(sqlRoot)).sort().map((name) => [
      name,
      fs.readFileSync(path.join(sqliteResetPaths.stateRoot(sqlRoot), name)).toString("base64"),
    ]))).toEqual(before);
  } finally {
    open.mockRestore();
  }
});
