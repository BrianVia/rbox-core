/**
 * A-2, the whole-state compatibility adapter (design 222 §1.2).
 *
 * Two properties carry this lane. First, it is INERT over legacy JSON: the
 * selector must not change one observable byte or verdict before M6 flips `Q`.
 * Second, on `Q` every refusal is decided from file-level facts — a workspace
 * this adapter refuses is byte-identical afterwards, SQLite sidecars included,
 * because a read-only open is not a zero-write operation (163 v13).
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileEntry } from "../../../engine/index.js";
import { acquireLock } from "../../../engine/git/lockfile.js";
import type { StateSavePacket, SyncState } from "../../sync-state-model.js";
import { authorityMarkerBytes } from "../authority-marker.js";
import { StateAuthorityCorruptError, StateWriteRefusedError, StreamMismatchError } from "../errors.js";
import { genesisPaths, sqliteResetPaths, stateLockPath, statePath } from "../paths.js";
import { createStateStore } from "../store/open.js";
import {
  applyStateSavePacket, loadRawState, loadState,
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

/** Every byte under the state directory, sidecars included. */
function snapshot(root: string): Record<string, string> {
  const dir = sqliteResetPaths.stateRoot(root);
  const out: Record<string, string> = {};
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

test("an absent state document is still the JSON backend's first run", async () => {
  const root = await workspace("absent");
  expect((await loadState(root, STREAM)).lastSyncedSequence).toBe(0);
  expect(await loadRawState(root)).toBeUndefined();
});

// --- selection on Q ---------------------------------------------------------

test("Q selects the store for whole reads", async () => {
  const root = await flipped("read");
  const state = await loadState(root, STREAM);
  expect(state.stream).toBe(STREAM);
  expect(state.stateNonce).toBe(NONCE);
  expect((await loadRawState(root))!.stateRevision).toBe(0);
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

// --- CasResult translation --------------------------------------------------

test("raw CAS rejections translate into the JSON vocabulary against the retry view", async () => {
  const root = await flipped("reject");
  for (const [override, reason] of [
    [{ expectedNonce: "d".repeat(32) }, "nonce"],
    [{ expectedStream: "https://api.test::other::root" }, "stream"],
    [{ repos: [{ relPath: "repo", expectedRepoGen: 7, newRecord: { sourceSeq: 5 } }] }, "repo-generation"],
  ] as const) {
    const result = await applyStateSavePacket(root, packet(override));
    expect(result.status, JSON.stringify(override)).toBe("rejected");
    if (result.status !== "rejected") continue;
    expect(result.reason).toBe(reason);
    // The state handed back is the authority the rejection was decided against.
    expect(result.state.stateRevision).toBe(0);
    expect(result.state.lastSyncedSequence).toBe(0);
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
  const refusal = await applyStateSavePacket(root, packet()).catch((error: unknown) => error);
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
  // A static import of either the coordinator or the store would drag
  // `bun:sqlite` into the CLI's eager graph, which `schema/inventory.test.ts`
  // forbids — and would stop the adapter being inert before the flip.
  expect(source).not.toMatch(/^import .*(authority-bootstrap|store-facade)\.js/m);
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
const LOAD_STATE_SITES: Readonly<Record<string, number>> = {
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
};

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
