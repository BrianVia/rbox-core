/**
 * A-2, the whole-state compatibility adapter (design 222 §1.2).
 *
 * Two properties carry this lane. First, it is INERT over legacy JSON: the
 * selector must not change one observable byte or verdict before M6 flips `Q`.
 * Second, on `Q` every refusal is decided from file-level facts — a workspace
 * this adapter refuses is byte-identical afterwards, SQLite sidecars included,
 * because a read-only open is not a zero-write operation (163 v13).
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileEntry } from "../../../engine/index.js";
import { acquireLock } from "../../../engine/lockfile.js";
import { withProtocolLockClass } from "../../../cli/sync-git/protocol-locks.js";
import { acquireWorkspaceSyncMutex, releaseWorkspaceSyncMutex } from "../../sync-mutex.js";
import type { StateSavePacket, SyncState } from "../../sync-state-model.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../../workspace-config.js";
import { authorityMarkerBytes, readAuthorityMarkerId } from "../authority-marker.js";
import { StateAuthorityCorruptError, StateWriteRefusedError, StreamMismatchError } from "../errors.js";
import { readGenesisIntent } from "../genesis-intent.js";
import { rboxResidue } from "../migration/fault-rig.js";
import { genesisPaths, sqliteResetPaths, stateLockPath, statePath } from "../paths.js";
import { sqliteResetFacade } from "../reset/index.js";
import {
  createStateStore, openStateStore, ownedStateStoreWriterForReset, stateStoreDatabase,
} from "../store/open.js";
import {
  applyStateSavePacket, ensureCapableStateLineage, LEGACY_REJECTION_REASON, loadRawState, loadState,
} from "./whole-state-compat.js";

const STREAM = "https://api.test::ws_222::root";
const AUTHORITY = "a".repeat(32);
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const COMPAT = path.join(import.meta.dir, "whole-state-compat.ts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function workspace(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-2c-${prefix}-`));
  roots.push(root);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  return root;
}

async function configuredWorkspace(prefix: string): Promise<string> {
  const root = await workspace(prefix);
  const config: WorkspaceConfig = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_222",
    projectId: "root",
    deviceId: "dev",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
  };
  expect(syncStreamId(config)).toBe(STREAM);
  await saveConfig(root, config);
  return root;
}

/** A workspace whose authority is `Q` and whose database really exists. */
async function flipped(prefix: string, authorityId = AUTHORITY): Promise<string> {
  const root = await workspace(prefix);
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: AUTHORITY, lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  }).close();
  await fsp.writeFile(statePath(root), authorityMarkerBytes(authorityId));
  return root;
}

async function legacy(prefix: string): Promise<string> {
  const root = await workspace(prefix);
  await fsp.writeFile(statePath(root), JSON.stringify({
    stream: STREAM, stateNonce: NONCE, stateRevision: 0,
    lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] }, repoRecords: {},
  } satisfies SyncState));
  return root;
}

async function plantResumeIntent(root: string, authorityId: string): Promise<void> {
  const active = sqliteResetPaths.active(root);
  const stat = await fsp.stat(active);
  const store = openStateStore(active, { readonly: true });
  const lineageId = store.header.active_lineage_id;
  store.close();
  await fsp.writeFile(genesisPaths.intent(root), JSON.stringify({
    version: 1,
    authorityId,
    lineageId,
    evidence: { root: await fsp.realpath(root), stream: STREAM, incarnation: "absent" },
    staging: { dev: stat.dev, ino: stat.ino },
  }));
}

const file = (name: string, seed: number): FileEntry => ({
  path: name, sha256: seed.toString(16).padStart(64, "0"), size: seed,
  mode: 0o644, mtimeMs: seed, type: "file",
} as FileEntry);

function packet(overrides: Partial<StateSavePacket> = {}): StateSavePacket {
  return {
    expectedStream: STREAM,
    expectedNonce: NONCE,
    sourceGlobalSeq: 5,
    global: { manifest: { generatedAt: "2026-07-29T00:00:00.000Z", files: [file("one.txt", 1)] } },
    repos: [],
    ...overrides,
  };
}

/** Every byte under the state directory, sidecars included: entry name → its
 * base64 bytes, or `<dir>`. */
type StateDirectoryBytes = Record<string, string>;

function snapshot(root: string): StateDirectoryBytes {
  const dir = sqliteResetPaths.stateRoot(root);
  const out: StateDirectoryBytes = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const entry = path.join(dir, name);
    out[name] = fs.statSync(entry).isDirectory() ? "<dir>" : fs.readFileSync(entry).toString("base64");
  }
  return out;
}

// --- inert over legacy JSON -------------------------------------------------

test("legacy JSON keeps every read and write on the JSON backend", async () => {
  const root = await legacy("inert");
  expect((await loadState(root, STREAM)).stream).toBe(STREAM);
  expect((await loadRawState(root))?.stateNonce).toBe(NONCE);

  const result = await applyStateSavePacket(root, packet());
  expect(result.status).toBe("accepted");
  // The document is still JSON, and no database was created beside it.
  expect(JSON.parse(await fsp.readFile(statePath(root), "utf8")).lastSyncedSequence).toBe(5);
  // The JSON publication owns its witness and reserve; nothing SQLite appeared.
  expect(Object.keys(snapshot(root)).filter((name) => name.startsWith("state.db"))).toEqual([]);
});

test("settled JSON preserves the released-handle load behavior and leaves no admission residue", async () => {
  const root = await legacy("released-json");
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  await releaseWorkspaceSyncMutex(mutex);
  const beforeState = await fsp.readFile(statePath(root));
  const beforeDirectory = snapshot(root);

  expect((await loadState(root, STREAM, () => undefined, mutex)).stateNonce).toBe(NONCE);
  expect(await fsp.readFile(statePath(root))).toEqual(beforeState);
  expect(snapshot(root)).toEqual(beforeDirectory);
  expect(readGenesisIntent(root)).toBeUndefined();
});

test("a held-mutex settled JSON load performs exactly one bounded intent read", async () => {
  const root = await legacy("one-intent-read");
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  const originalOpen = fs.openSync;
  let intentReads = 0;
  const observed = spyOn(fs, "openSync").mockImplementation(((file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(genesisPaths.intent(root))) intentReads += 1;
    return originalOpen(file, ...args);
  }) as typeof fs.openSync);
  try {
    expect((await loadState(root, STREAM, () => undefined, mutex)).stateNonce).toBe(NONCE);
    expect(intentReads).toBe(1);
  } finally {
    observed.mockRestore();
    await releaseWorkspaceSyncMutex(mutex);
  }
});

test("settled JSON preserves wrong-root, ownership-lost, and degraded adapter behavior", async () => {
  const wrongRootState = await legacy("wrong-root-json");
  const other = await workspace("wrong-root-handle");
  const wrongRoot = await acquireWorkspaceSyncMutex(other, "cli");
  const wrongRootResidue = rboxResidue(wrongRootState);
  try {
    expect((await loadState(wrongRootState, STREAM, () => undefined, wrongRoot)).stateNonce).toBe(NONCE);
    expect(rboxResidue(wrongRootState)).toEqual(wrongRootResidue);
  } finally {
    await releaseWorkspaceSyncMutex(wrongRoot);
  }

  const ownershipLostState = await legacy("ownership-lost-json");
  const ownershipLost = await acquireWorkspaceSyncMutex(ownershipLostState, "cli");
  if (!ownershipLost.lock) throw new Error("test requires a real mutex");
  await fsp.rm(ownershipLost.lock.path);
  const ownershipLostResidue = rboxResidue(ownershipLostState);
  try {
    expect((await loadState(ownershipLostState, STREAM, () => undefined, ownershipLost)).stateNonce).toBe(NONCE);
    expect(rboxResidue(ownershipLostState)).toEqual(ownershipLostResidue);
  } finally {
    await releaseWorkspaceSyncMutex(ownershipLost).catch(() => undefined);
  }

  const degradedState = await legacy("degraded-json");
  const degraded = {
    root: degradedState,
    incarnation: "degraded",
    released: false,
    degraded: { reason: "test" },
  } as const;
  const degradedResidue = rboxResidue(degradedState);
  expect((await loadState(degradedState, STREAM, () => undefined, degraded)).stateNonce).toBe(NONCE);
  expect(rboxResidue(degradedState)).toEqual(degradedResidue);
});

test("an absent state document is still the JSON backend's first run", async () => {
  const root = await workspace("absent");
  expect((await loadState(root, STREAM)).lastSyncedSequence).toBe(0);
  expect(await loadRawState(root)).toBeUndefined();
});

test("a healthy held-mutex load admits absent state and re-selects the genesis store", async () => {
  const root = await configuredWorkspace("admit-absent");
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  try {
    const state = await loadState(root, STREAM, () => undefined, mutex);
    expect(state.stream).toBe(STREAM);
    expect(state.lastSyncedSequence).toBe(0);
    expect(state.stateNonce).toBeUndefined();
    const capable = await ensureCapableStateLineage(root, state);
    expect(capable.stateNonce).toMatch(/^[0-9a-f]{32}$/);
    expect((await loadState(root, STREAM, () => undefined, mutex)).stateNonce).toBe(capable.stateNonce);

    const authorityId = await readAuthorityMarkerId(statePath(root));
    expect(authorityId).toMatch(/^[0-9a-f]{32}$/);
    expect(readGenesisIntent(root)).toBeUndefined();
    expect(await mutex.lock?.isOwner()).toBeTrue();
    expect(mutex.released).toBeFalse();

    const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
    try {
      expect(store.header.authority_id).toBe(authorityId!);
      const completion = stateStoreDatabase(store).query(
        "SELECT origin_kind,migration_id,entry_count,repo_count FROM migration_completion WHERE singleton=1",
      ).get() as { origin_kind: string; migration_id: string; entry_count: number; repo_count: number };
      expect(completion).toEqual({
        origin_kind: "genesis",
        migration_id: `genesis:${store.header.active_lineage_id}`,
        entry_count: 0,
        repo_count: 0,
      });
    } finally {
      store.close();
    }
  } finally {
    await releaseWorkspaceSyncMutex(mutex);
  }
});

for (const markerPublished of [true, false]) {
  test(`held-mutex load resumes ${markerPublished ? "Q + intent" : "absent + active DB + intent"} with the same authority`, async () => {
    const root = await configuredWorkspace(markerPublished ? "resume-q" : "resume-active");
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    try {
      await loadState(root, STREAM, () => undefined, mutex);
      const authorityId = await readAuthorityMarkerId(statePath(root));
      expect(authorityId).toMatch(/^[0-9a-f]{32}$/);
      await plantResumeIntent(root, authorityId!);
      if (!markerPublished) await fsp.rm(statePath(root));

      const beforeResume = await import("../authority-bootstrap.js");
      expect(() => beforeResume.assertAuthorityWritable(root)).toThrow(StateWriteRefusedError);
      const recovered = await loadState(root, STREAM, () => undefined, mutex);
      expect(await readAuthorityMarkerId(statePath(root))).toBe(authorityId!);
      expect(readGenesisIntent(root)).toBeUndefined();
      expect(() => beforeResume.assertAuthorityWritable(root)).not.toThrow();
      expect((await applyStateSavePacket(root, packet({
        expectedNonce: recovered.stateNonce ?? "legacy",
        sourceGlobalSeq: 1,
      }))).status).toBe("accepted");
    } finally {
      await releaseWorkspaceSyncMutex(mutex);
    }
  });
}

test("JSON plus an intent is recovered before dispatch without changing the JSON bytes", async () => {
  const root = await configuredWorkspace("resume-json");
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  try {
    await loadState(root, STREAM, () => undefined, mutex);
    const authorityId = await readAuthorityMarkerId(statePath(root));
    await plantResumeIntent(root, authorityId!);
    const json = JSON.stringify({
      stream: STREAM,
      stateNonce: NONCE,
      stateRevision: 0,
      lastSyncedSequence: 0,
      lastSyncedManifest: { generatedAt: "", files: [] },
      repoRecords: {},
    } satisfies SyncState);
    await fsp.writeFile(statePath(root), json);

    expect((await loadState(root, STREAM, () => undefined, mutex)).stateNonce).toBe(NONCE);
    expect(await fsp.readFile(statePath(root), "utf8")).toBe(json);
    expect(readGenesisIntent(root)).toBeUndefined();
    expect(fs.existsSync(sqliteResetPaths.active(root))).toBeFalse();
  } finally {
    await releaseWorkspaceSyncMutex(mutex);
  }
});

test("a foreign authority file cannot hide a surviving genesis intent", async () => {
  const root = await configuredWorkspace("resume-foreign");
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  try {
    await loadState(root, STREAM, () => undefined, mutex);
    const authorityId = await readAuthorityMarkerId(statePath(root));
    await plantResumeIntent(root, authorityId!);
    await fsp.writeFile(statePath(root), "foreign authority holder\n");

    await expect(loadState(root, STREAM, () => undefined, mutex))
      .rejects.toBeInstanceOf(StateAuthorityCorruptError);
    expect(readGenesisIntent(root)?.authorityId).toBe(authorityId!);
    expect(fs.existsSync(sqliteResetPaths.active(root))).toBeTrue();
  } finally {
    await releaseWorkspaceSyncMutex(mutex);
  }
});

// --- selection on Q ---------------------------------------------------------

test("Q selects the store for whole reads", async () => {
  const root = await flipped("read");
  const state = await loadState(root, STREAM);
  expect(state.stream).toBe(STREAM);
  expect(state.stateNonce).toBe(NONCE);
  expect((await loadRawState(root))!.stateRevision).toBe(0);
});

test("a held-mutex settled Q load reads intent once and opens the authority exactly once", async () => {
  const root = await flipped("one-q-open");
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  const originalOpen = fs.openSync;
  let intentReads = 0;
  let authorityOpens = 0;
  const observed = spyOn(fs, "openSync").mockImplementation(((file, ...args) => {
    const resolved = path.resolve(String(file));
    if (resolved === path.resolve(genesisPaths.intent(root))) intentReads += 1;
    if (resolved === path.resolve(sqliteResetPaths.active(root))) authorityOpens += 1;
    return originalOpen(file, ...args);
  }) as typeof fs.openSync);
  try {
    expect((await loadState(root, STREAM, () => undefined, mutex)).stateNonce).toBe(NONCE);
    expect(intentReads).toBe(1);
    expect(authorityOpens).toBe(1);
  } finally {
    observed.mockRestore();
    await releaseWorkspaceSyncMutex(mutex);
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    expect(fs.existsSync(`${sqliteResetPaths.active(root)}${suffix}`)).toBeFalse();
  }
});

test("a different stream refuses on the SQLite backend too", async () => {
  const root = await flipped("stream");
  await expect(loadState(root, "https://api.test::other::root")).rejects.toBeInstanceOf(StreamMismatchError);
});

test("a save on Q lands in the store and never republishes JSON", async () => {
  const root = await flipped("save");
  const result = await applyStateSavePacket(root, packet());
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") return;
  expect(result.state.lastSyncedSequence).toBe(5);
  expect(result.state.stateRevision).toBe(1);
  expect(result.state.lastSyncedManifest.files.map((entry) => entry.path)).toEqual(["one.txt"]);
  // `Q` is untouched, and the materialized state matches a fresh read.
  expect(fs.readFileSync(statePath(root)).toString("latin1")).toBe(authorityMarkerBytes(AUTHORITY).toString("latin1"));
  expect(await loadRawState(root)).toStrictEqual(result.state);
});

test("a standing SQLite reset is recovered by the read, not reported as corruption", async () => {
  const root = await flipped("reset");
  await sqliteResetFacade.begin(root, "next", [], {
    version: 2, authorizedNextStream: "next", consentKind: "setup-rebind", mintedAtRevision: 0,
  });
  expect(fs.existsSync(sqliteResetPaths.journal(root))).toBe(true);
  // Gating this recovery on the LEGACY journal decoder threw
  // `ResetCorruptionError` here: a `Q` workspace's journal is `sqlite/v1`, the
  // one format that decoder refuses. The read must recover instead.
  const outcome = await loadState(root, STREAM).catch((error: Error) => error);
  expect(outcome, String(outcome)).toBeInstanceOf(StreamMismatchError); // the reset rebound the stream
  expect(fs.existsSync(sqliteResetPaths.journal(root))).toBe(false);
  expect((await loadState(root, "next")).stream).toBe("next");
});

// --- CasResult translation --------------------------------------------------

/** Every row, including the four A-1 makes unreachable by binding them from the
 * live token: an unreachable row is still a promise to the caller. */
test("the rejection vocabulary is exactly the translation the JSON CAS speaks", () => {
  expect(LEGACY_REJECTION_REASON).toEqual({
    lineage: "nonce",
    stream: "stream",
    nonce: "nonce",
    "state-revision": "nonce",
    "base-generation": "global-sequence",
    "local-revision": "nonce",
    "repo-generation": "repo-generation",
    "global-sequence": "global-sequence",
    "owner-lost": "owner-lost",
  });
});

test("raw CAS rejections translate into the JSON vocabulary against the retry view", async () => {
  const root = await flipped("reject");
  expect((await applyStateSavePacket(root, packet({ sourceGlobalSeq: 9 }))).status).toBe("accepted");
  for (const [override, reason] of [
    [{ expectedNonce: "d".repeat(32) }, "nonce"],
    [{ expectedStream: "https://api.test::other::root" }, "stream"],
    [{ sourceGlobalSeq: 12, repos: [{ relPath: "repo", expectedRepoGen: 7, newRecord: { sourceSeq: 12 } }] }, "repo-generation"],
    // A global behind the authority's own sequence: the reachable
    // `global-sequence` row, which shares its translation with base-generation.
    [{ sourceGlobalSeq: 2 }, "global-sequence"],
  ] as const) {
    const authority = await loadRawState(root);
    const result = await applyStateSavePacket(root, packet(override));
    expect(result.status, JSON.stringify(override)).toBe("rejected");
    if (result.status !== "rejected") continue;
    expect(result.reason, JSON.stringify(override)).toBe(reason);
    // The state handed back is the authority the rejection was decided against,
    // and the rejected packet moved nothing.
    expect(result.state).toStrictEqual(authority!);
    expect(await loadRawState(root)).toStrictEqual(authority!);
  }
  // The sealed retry view is closed on every rejection: a leaked one keeps its
  // stage artifact and its lock alive for the life of the process.
  expect(fs.readdirSync(sqliteResetPaths.stateRoot(root)).filter((name) => name.startsWith("stage-"))).toEqual([]);
});

test("a busy state lock is reported as busy, not attempted", async () => {
  const root = await flipped("busy");
  const held = await acquireLock(stateLockPath(root));
  expect(held.status).toBe("acquired");
  try {
    const before = snapshot(root);
    const result = await applyStateSavePacket(root, packet());
    expect(result.status).toBe("busy");
    expect(snapshot(root)).toEqual(before);
  } finally {
    if (held.status === "acquired") await held.lock.release();
  }
});

// --- the one-call write fence ----------------------------------------------

test("an unretired genesis intent refuses the save before anything opens the database", async () => {
  const root = await flipped("fence-genesis");
  const before = snapshot(root);
  await fsp.writeFile(genesisPaths.intent(root), JSON.stringify({
    version: 1, authorityId: "e".repeat(32), lineageId: "f".repeat(32),
    evidence: { root, stream: STREAM, incarnation: "absent" }, staging: { dev: 1, ino: 2 },
  }));
  const refusal = await applyStateSavePacket(root, packet()).catch((error: Error) => error);
  expect(refusal).toBeInstanceOf(StateWriteRefusedError);
  expect((refusal as StateWriteRefusedError).reason).toBe("authority-recovery-pending");
  // Byte-identical apart from the intent this test planted: no `-wal`, no
  // `-shm`, no stage artifact. The fence ran before any open.
  const after = snapshot(root);
  delete after[path.basename(genesisPaths.intent(root))];
  expect(after).toEqual(before);
});

test("the fence is called exactly once per save, and never through a static import", async () => {
  const source = fs.readFileSync(COMPAT, "utf8");
  expect(source.split("assertAuthorityWritable(").length - 1).toBe(1);
  expect(source).toContain('await import("../authority-bootstrap.js")');
  // Both read paths take a read-only handle; only the save path takes the
  // writer. 163 v13 is specifically about what a READ is allowed to do.
  expect(source.match(/openAuthorityStore\(authority, true\)/g) ?? []).toHaveLength(2);
  expect(source.match(/openAuthorityStore\(authority, false\)/g) ?? []).toHaveLength(1);
  expect(source).toContain("facade.openStateStore(authority.file, { readonly })");
  // Four closes: the two read paths, the save, and the authority-id refusal
  // that closes the handle it had to open to compare ids.
  expect(source.match(/store\.close\(\);/g) ?? []).toHaveLength(4);
  // A static import of either the coordinator or the store would drag
  // `bun:sqlite` into the CLI's eager graph, which `schema/inventory.test.ts`
  // forbids — and would stop the adapter being inert before the flip.
  expect(source).not.toMatch(/^import .*(authority-bootstrap|store-facade)\.js/m);
});

/**
 * A store handle that outlives its call is invisible to every other assertion
 * here, and it is exactly what makes `checkpointStateStoreForReset` refuse a
 * later reset as busy. The store keeps its own liveness registry, so ask that
 * rather than counting descriptors — a leaked handle is unreferenced garbage,
 * so its file descriptor disappears on the next GC and proves nothing.
 */
test("the save closes the writer it opened", async () => {
  const root = await flipped("close");
  const active = sqliteResetPaths.active(root);
  expect(ownedStateStoreWriterForReset(active)).toBeUndefined();
  expect((await applyStateSavePacket(root, packet())).status).toBe("accepted");
  expect(ownedStateStoreWriterForReset(active), "the save left a live writer registered").toBeUndefined();
});

test("a held lock is reused when it is the state lock, and refused when it is not", async () => {
  const root = await flipped("held-lock");
  const identity = path.resolve(statePath(root));
  const foreign = await acquireLock(path.join(root, "foreign.lock"));
  expect(foreign.status).toBe("acquired");
  if (foreign.status !== "acquired") return;
  try {
    await expect(withProtocolLockClass("state", identity, () =>
      applyStateSavePacket(root, packet(), { heldLock: foreign.lock }))).rejects.toThrow(/held state lock does not match/);
  } finally {
    await foreign.lock.release();
  }

  const held = await acquireLock(stateLockPath(root));
  expect(held.status).toBe("acquired");
  if (held.status !== "acquired") return;
  try {
    // The state lock is already ours: the save must reuse it rather than
    // re-acquire it and report itself busy.
    const result = await withProtocolLockClass("state", identity, () =>
      applyStateSavePacket(root, packet(), { heldLock: held.lock }));
    expect(result.status).toBe("accepted");
  } finally {
    await held.lock.release();
  }
});

// --- contradictory authority ------------------------------------------------

test("a marker naming a different authority than the database refuses", async () => {
  const root = await flipped("wrong-id", "9".repeat(32));
  await expect(loadRawState(root)).rejects.toBeInstanceOf(StateAuthorityCorruptError);
  await expect(applyStateSavePacket(root, packet())).rejects.toBeInstanceOf(StateAuthorityCorruptError);
});

test("a foreign file at the database path refuses without opening it", async () => {
  const root = await workspace("foreign");
  await fsp.writeFile(sqliteResetPaths.active(root), "this is not a database\n");
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
  const before = snapshot(root);
  await expect(loadState(root, STREAM)).rejects.toBeInstanceOf(StateAuthorityCorruptError);
  await expect(applyStateSavePacket(root, packet())).rejects.toBeInstanceOf(StateAuthorityCorruptError);
  // No `-wal`/`-shm`: the header gate decided ownership from bytes, and a
  // refusal that had already opened would have left sidecars it cannot remove.
  expect(snapshot(root)).toEqual(before);
});

test("a symlink at the database path is refused without following it", async () => {
  const root = await workspace("symlink-db");
  const victim = path.join(root, "victim.db");
  createStateStore(victim, {
    authorityId: AUTHORITY, lineageId: LINEAGE, stream: STREAM, createdBy: "test",
  }).close();
  await fsp.symlink(victim, sqliteResetPaths.active(root));
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
  // A real, well-formed rbox database sits at the far end: only O_NOFOLLOW
  // keeps this a refusal rather than an adoption of a file rbox does not own.
  await expect(loadState(root, STREAM)).rejects.toBeInstanceOf(StateAuthorityCorruptError);
  await expect(applyStateSavePacket(root, packet())).rejects.toBeInstanceOf(StateAuthorityCorruptError);
  expect(fs.readdirSync(root).filter((name) => name.startsWith("victim.db-"))).toEqual([]);
});

test("a marker with no database at all refuses and repairs nothing", async () => {
  const root = await workspace("no-db");
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
  await expect(loadState(root, STREAM)).rejects.toBeInstanceOf(StateAuthorityCorruptError);
  expect(snapshot(root)).toEqual({});
});

// --- the call-site inventory ------------------------------------------------

/**
 * Backend-first condition 2 (163 §U3): the whole-state adapter is the single
 * permitted production use of `loadState(): SyncState`, its call sites are
 * counted from this release forward, that count MAY ONLY DECREASE, and it must
 * reach zero by U4f. The table is exact so a new reader cannot arrive quietly;
 * shrink an entry and update it in the same change.
 */
const LOAD_STATE_SITES = {
  "cli/chain-repair.ts": 3,
  "cli/daemon/daemon.ts": 2,
  "cli/doctor-cmd.ts": 4,
  "cli/git/deferrals-command.ts": 5,
  "cli/git/republish-command.ts": 5,
  "cli/git/resolve-command.ts": 9,
  "cli/ignore-cmd.ts": 2,
  "cli/scope/scope-cmd.ts": 3,
  "cli/scope/scope-transaction.ts": 2,
  "cli/status-read-port.ts": 2,
  "cli/sync-git/deferral-hygiene.ts": 2,
  "cli/sync/pull.ts": 6,
  "cli/sync/push.ts": 6,
  "cli/track-cmd.ts": 2,
} satisfies Readonly<Record<string, number>>;

/** The adapter and the two facades that only re-export it. */
const LOAD_STATE_SEAM = new Set([
  "cli/state-plane/adapters/whole-state-compat.ts",
  "cli/sync-state-store.ts",
  "cli/config.ts",
]);

test("production reach of the whole-state loadState may only decrease", () => {
  const src = path.resolve(import.meta.dir, "../../..");
  const found: Record<string, number> = {};
  for (const entry of fs.readdirSync(src, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".typecheck.ts")) continue;
    if (LOAD_STATE_SEAM.has(entry)) continue;
    // Comments name the symbol constantly; only code counts as reach.
    const code = fs.readFileSync(path.join(src, entry), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const sites = (code.match(/\bloadState\b/g) ?? []).length;
    if (sites > 0) found[entry] = sites;
  }
  expect(found, "the whole-state adapter's production reach changed; it may only shrink (163 §U3, zero by U4f)")
    .toEqual(LOAD_STATE_SITES);
  expect(Object.values(found).reduce((total, sites) => total + sites, 0)).toBeLessThanOrEqual(53);
});
