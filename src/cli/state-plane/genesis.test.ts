import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../workspace-config.js";
import { AUTHORITY_MARKER_MAGIC } from "./authority-marker.js";
import { StateAuthorityCorruptError } from "./errors.js";
import {
  establish,
  inspect,
  readGenesisIntent,
  type FencedEvidence,
  type GenesisIds,
  type GenesisIntent,
  type HeldStatePlaneLocks,
} from "./genesis.js";
import { genesisPaths, migrationPaths, sqliteResetPaths, statePath } from "./paths.js";
import { createStateStore, openStateStore, stateStoreDatabase } from "./store/open.js";

const LOCKS = {} as HeldStatePlaneLocks;
const IDS: GenesisIds = { authorityId: "a".repeat(32), lineageId: "b".repeat(32) };
const OTHER: GenesisIds = { authorityId: "c".repeat(32), lineageId: "d".repeat(32) };

async function workspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-genesis-"));
  const config: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
    rootPath: root, remoteUrl: "https://example.invalid", token: "",
  };
  await saveConfig(root, config);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  return root;
}

async function evidenceOf(root: string): Promise<FencedEvidence> {
  const config = JSON.parse(await fsp.readFile(path.join(root, ".rbox", "workspace.json"), "utf8")) as WorkspaceConfig;
  return { root: await fsp.realpath(root), stream: syncStreamId(config), incarnation: "absent" };
}

function markerBytes(authorityId: string): Buffer {
  return Buffer.from(`${AUTHORITY_MARKER_MAGIC}\n${authorityId}\n`, "latin1");
}

function inodeOf(file: string): { dev: number; ino: number } {
  const stat = fs.lstatSync(file);
  return { dev: stat.dev, ino: stat.ino };
}

/** A complete genesis database, built the way `installGenesisLineage` builds it. */
function plantStore(file: string, stream: string, ids: GenesisIds): { dev: number; ino: number } {
  createStateStore(file, { stream, createdBy: "genesis-v1", ...ids }).close();
  return inodeOf(file);
}

async function plantIntent(root: string, intent: GenesisIntent): Promise<void> {
  await fsp.writeFile(genesisPaths.intent(root), JSON.stringify(intent));
}

async function run(root: string, ids: GenesisIds = IDS, faults = {}) {
  return establish(root, () => ids, LOCKS, faults);
}

async function listing(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir)).sort();
}

test("G1: a fresh workspace reaches Q with no leftovers and no migration artifact", async () => {
  const root = await workspace();
  expect(await run(root)).toEqual({ kind: "established", authorityId: IDS.authorityId });

  expect(await fsp.readFile(statePath(root))).toEqual(markerBytes(IDS.authorityId));
  expect(await listing(sqliteResetPaths.stateRoot(root))).toEqual(["state.db"]);
  expect(await listing(path.join(root, ".rbox"))).toEqual(["state", "state.json", "workspace.json"]);
  expect(readGenesisIntent(root)).toBeUndefined();

  const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
  try {
    expect(store.header.authority_id).toBe(IDS.authorityId);
    expect(store.header.active_lineage_id).toBe(IDS.lineageId);
    const row = stateStoreDatabase(store).query(
      "SELECT origin_kind,migration_id,entry_count,repo_count FROM migration_completion WHERE singleton=1",
    ).get() as { origin_kind: string; migration_id: string; entry_count: number; repo_count: number };
    expect(row).toEqual({
      origin_kind: "genesis", migration_id: `genesis:${IDS.lineageId}`, entry_count: 0, repo_count: 0,
    });
  } finally {
    store.close();
  }
});

test("step 1 refuses, mutating nothing: legacy JSON, an artifact, a migration control, missing evidence", async () => {
  const legacy = await workspace();
  await fsp.writeFile(statePath(legacy), '{"lastSyncedSequence":1}');
  expect(await run(legacy)).toEqual({ kind: "refused", reason: "legacy-present" });
  expect(await fsp.readFile(statePath(legacy), "utf8")).toBe('{"lastSyncedSequence":1}');
  expect(await listing(sqliteResetPaths.stateRoot(legacy))).toEqual([]);

  const claimed = await workspace();
  plantStore(sqliteResetPaths.active(claimed), "other", OTHER);
  expect(await run(claimed)).toEqual({ kind: "refused", reason: "artifact-present" });

  const migrating = await workspace();
  await fsp.writeFile(migrationPaths.control(migrating), "{}");
  expect(await run(migrating)).toEqual({ kind: "refused", reason: "artifact-present" });

  const unlinked = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-genesis-"));
  expect(await run(unlinked)).toEqual({ kind: "refused", reason: "evidence-missing" });
});

test("case 1: Q is published and the intent survives — finish the fsync and retire it", async () => {
  const root = await workspace();
  const evidence = await evidenceOf(root);
  const staging = plantStore(sqliteResetPaths.active(root), evidence.stream, IDS);
  await fsp.writeFile(statePath(root), markerBytes(IDS.authorityId));
  await fsp.writeFile(genesisPaths.qSibling(root, IDS.authorityId), markerBytes(IDS.authorityId));
  await plantIntent(root, { version: 1, ...IDS, evidence, staging });

  expect(await run(root)).toEqual({ kind: "already-established" });
  expect(await fsp.readFile(statePath(root))).toEqual(markerBytes(IDS.authorityId));
  expect(inodeOf(sqliteResetPaths.active(root))).toEqual(staging);
  expect(readGenesisIntent(root)).toBeUndefined();
  expect(await listing(sqliteResetPaths.stateRoot(root))).toEqual(["state.db"]);
});

test("G2 case 2: the database is placed but Q is not — resume publishes the identical Q", async () => {
  const reference = await workspace();
  await run(reference);
  const expected = await fsp.readFile(statePath(reference));

  const root = await workspace();
  const evidence = await evidenceOf(root);
  const staging = plantStore(sqliteResetPaths.active(root), evidence.stream, IDS);
  await plantIntent(root, { version: 1, ...IDS, evidence, staging });

  expect(await run(root)).toEqual({ kind: "established", authorityId: IDS.authorityId });
  expect(await fsp.readFile(statePath(root))).toEqual(expected);
  expect(inodeOf(sqliteResetPaths.active(root))).toEqual(staging);
  expect(readGenesisIntent(root)).toBeUndefined();
});

test("G2 case 3 clean: a complete staged database is placed and published", async () => {
  const root = await workspace();
  const evidence = await evidenceOf(root);
  const staged = genesisPaths.staged(root, IDS.authorityId);
  const staging = plantStore(staged, evidence.stream, IDS);
  await plantIntent(root, { version: 1, ...IDS, evidence, staging });

  expect(await run(root)).toEqual({ kind: "established", authorityId: IDS.authorityId });
  expect(inodeOf(sqliteResetPaths.active(root))).toEqual(staging);
  expect(await listing(sqliteResetPaths.stateRoot(root))).toEqual(["state.db"]);
});

test("G2 case 3 unopenable: the recorded inode is truncated in place, never unlinked", async () => {
  const root = await workspace();
  const evidence = await evidenceOf(root);
  const staged = genesisPaths.staged(root, IDS.authorityId);
  await fsp.writeFile(staged, "not a database, and not zero bytes", { mode: 0o600 });
  const staging = inodeOf(staged);
  await fsp.writeFile(`${staged}-wal`, "leftover");
  await plantIntent(root, { version: 1, ...IDS, evidence, staging });

  expect(await run(root)).toEqual({ kind: "established", authorityId: IDS.authorityId });
  // C3: the inode survives the repair, so a second crash reads case 3 again.
  expect(inodeOf(sqliteResetPaths.active(root))).toEqual(staging);
  expect(await listing(sqliteResetPaths.stateRoot(root))).toEqual(["state.db"]);
});

test("G2 case 4: nothing durable followed the intent — rebuild under a fresh authority id", async () => {
  const root = await workspace();
  const evidence = await evidenceOf(root);
  await plantIntent(root, { version: 1, ...IDS, evidence, staging: { dev: 1, ino: 999_999 } });

  expect(await run(root, OTHER)).toEqual({ kind: "established", authorityId: OTHER.authorityId });
  expect(await fsp.readFile(statePath(root))).toEqual(markerBytes(OTHER.authorityId));
  expect(readGenesisIntent(root)).toBeUndefined();
  expect(await listing(sqliteResetPaths.stateRoot(root))).toEqual(["state.db"]);
});

test("G3: an L published inside step 7's window refuses, renames nothing, and keeps the L", async () => {
  const root = await workspace();
  const legacy = '{"lastSyncedSequence":7}';
  const outcome = await run(root, IDS, {
    afterQPrepared: async () => { await fsp.writeFile(statePath(root), legacy); },
  });

  expect(outcome).toEqual({ kind: "refused", reason: "legacy-present" });
  expect(await fsp.readFile(statePath(root), "utf8")).toBe(legacy);
  expect(readGenesisIntent(root)).toBeUndefined();
  // Only artifacts confirmed to be this attempt's are removed.
  expect(await listing(sqliteResetPaths.stateRoot(root))).toEqual([]);
  expect(await listing(path.join(root, ".rbox"))).toEqual(["state", "state.json", "workspace.json"]);
});

test("a foreign artifact inside step 7's window halts — it never reads as legacy-present", async () => {
  for (const [label, bytes] of [["foreign", " not json"], ["marker", markerBytes(OTHER.authorityId).toString("latin1")]] as const) {
    const root = await workspace();
    await expect(run(root, IDS, {
      afterQPrepared: async () => { await fsp.writeFile(statePath(root), bytes, "latin1"); },
    }), label).rejects.toThrow(StateAuthorityCorruptError);
    // legacyPresent would have deleted the database step 5 just placed.
    expect(fs.existsSync(sqliteResetPaths.active(root)), label).toBe(true);
    expect(readGenesisIntent(root), label).toBeDefined();
  }
});

test("G4: the intent survives past the authority rename and case 1 retires it", async () => {
  const root = await workspace();
  const evidence = await evidenceOf(root);
  const staging = plantStore(sqliteResetPaths.active(root), evidence.stream, IDS);
  await fsp.writeFile(statePath(root), markerBytes(IDS.authorityId));
  const intent: GenesisIntent = { version: 1, ...IDS, evidence, staging };
  await plantIntent(root, intent);

  // The write fence reads the same record, synchronously, and sees it unretired.
  expect(readGenesisIntent(root)).toEqual(intent);
  expect(await run(root)).toEqual({ kind: "already-established" });
  expect(readGenesisIntent(root)).toBeUndefined();
});

test("G5: a genesis database copied from another workspace never publishes Q", async () => {
  const root = await workspace();
  plantStore(sqliteResetPaths.active(root), "some-other-stream", OTHER);

  expect((await inspect(root, LOCKS)).claims).toBe(false);
  expect(await run(root)).toEqual({ kind: "refused", reason: "artifact-present" });
  expect(fs.existsSync(statePath(root))).toBe(false);
  expect(await listing(sqliteResetPaths.stateRoot(root))).toEqual(["state.db"]);
});

test("G6: artifacts scoped to another authority id are never adopted and never deleted", async () => {
  const root = await workspace();
  const strayDb = genesisPaths.staged(root, OTHER.authorityId);
  const strayQ = genesisPaths.qSibling(root, OTHER.authorityId);
  await fsp.writeFile(strayDb, "");
  await fsp.writeFile(strayQ, markerBytes(OTHER.authorityId));

  expect(await run(root)).toEqual({ kind: "established", authorityId: IDS.authorityId });
  expect(fs.existsSync(strayDb)).toBe(true);
  expect(fs.existsSync(strayQ)).toBe(true);
});

test("case 7: bound evidence that is not this workspace's halts before case 5 can delete", async () => {
  const root = await workspace();
  const evidence = await evidenceOf(root);
  const staging = plantStore(sqliteResetPaths.active(root), evidence.stream, IDS);
  await fsp.writeFile(statePath(root), '{"lastSyncedSequence":3}');
  await plantIntent(root, {
    version: 1, ...IDS, evidence: { ...evidence, root: `${evidence.root}-elsewhere` }, staging,
  });

  await expect(run(root)).rejects.toThrow(StateAuthorityCorruptError);
  expect(fs.existsSync(sqliteResetPaths.active(root))).toBe(true);
  expect(await fsp.readFile(statePath(root), "utf8")).toBe('{"lastSyncedSequence":3}');
  expect(readGenesisIntent(root)).toBeDefined();
});

test("case 7: a re-adopted incarnation marker is a mismatch too", async () => {
  const root = await workspace();
  const evidence = await evidenceOf(root);
  const staging = plantStore(genesisPaths.staged(root, IDS.authorityId), evidence.stream, IDS);
  await plantIntent(root, {
    version: 1, ...IDS, evidence: { ...evidence, incarnation: { dev: 1, ino: 2, sha256: "e".repeat(64) } }, staging,
  });

  await expect(run(root)).rejects.toThrow(StateAuthorityCorruptError);
});

test("case 6: a foreign inode at either path, a foreign Q, or a malformed intent halts with zero writes", async () => {
  const foreign = await workspace();
  const evidence = await evidenceOf(foreign);
  plantStore(sqliteResetPaths.active(foreign), evidence.stream, OTHER);
  await plantIntent(foreign, { version: 1, ...IDS, evidence, staging: { dev: 1, ino: 4 } });
  await expect(run(foreign)).rejects.toThrow(StateAuthorityCorruptError);
  expect(fs.existsSync(sqliteResetPaths.active(foreign))).toBe(true);

  const staged = await workspace();
  const stagedEvidence = await evidenceOf(staged);
  await fsp.writeFile(genesisPaths.staged(staged, IDS.authorityId), "");
  await plantIntent(staged, { version: 1, ...IDS, evidence: stagedEvidence, staging: { dev: 1, ino: 4 } });
  await expect(run(staged)).rejects.toThrow(StateAuthorityCorruptError);

  const wrongQ = await workspace();
  const wrongEvidence = await evidenceOf(wrongQ);
  const staging = plantStore(sqliteResetPaths.active(wrongQ), wrongEvidence.stream, IDS);
  await fsp.writeFile(statePath(wrongQ), markerBytes(OTHER.authorityId));
  await plantIntent(wrongQ, { version: 1, ...IDS, evidence: wrongEvidence, staging });
  await expect(run(wrongQ)).rejects.toThrow(StateAuthorityCorruptError);

  const malformed = await workspace();
  await fsp.writeFile(genesisPaths.intent(malformed), JSON.stringify({ version: 1, authorityId: "nope" }));
  expect(() => readGenesisIntent(malformed)).toThrow(StateAuthorityCorruptError);
  await expect(run(malformed)).rejects.toThrow(StateAuthorityCorruptError);
});

/** Name, mode, size, identity and content hash of every entry — the fixture a
 * "zero writes" claim has to survive. Shared shape with wave 2A's classifier
 * harness: a sidecar appearing, a mode changing, or a byte moving all show up. */
async function fileSet(dir: string): Promise<Record<string, string>> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const set: Record<string, string> = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    const stat = await fsp.lstat(file);
    const identity = `mode=${(stat.mode & 0o7777).toString(8)} size=${stat.size} ino=${stat.dev}:${stat.ino}`;
    set[entry.name] = entry.isDirectory()
      ? `<dir> ${identity}`
      : `${identity} sha256=${createHash("sha256").update(await fsp.readFile(file)).digest("hex")}`;
  }
  return set;
}

test("case 6: the zero-write halt leaves a migrated database's file set byte-for-byte unchanged", async () => {
  const root = await workspace();
  const evidence = await evidenceOf(root);
  // The C2 hazard made concrete: the recorded inode is recycled onto a real
  // migrated database. The conjunction must open it read-only, refuse it, and
  // leave no trace — a `-wal`/`-shm` beside `state.db` is itself a durable
  // authority signature rbox is then forbidden to clean up (163:1136-1138).
  const active = sqliteResetPaths.active(root);
  const staging = plantStore(active, evidence.stream, OTHER);
  await plantIntent(root, { version: 1, ...IDS, evidence, staging });

  const before = await fileSet(sqliteResetPaths.stateRoot(root));
  await expect(run(root)).rejects.toThrow(StateAuthorityCorruptError);
  expect(await fileSet(sqliteResetPaths.stateRoot(root))).toEqual(before);
});

test("case 5: refusing to a legacy L leaves a foreign active database's file set unchanged", async () => {
  const root = await workspace();
  const evidence = await evidenceOf(root);
  const staging = plantStore(sqliteResetPaths.active(root), evidence.stream, OTHER);
  await plantIntent(root, { version: 1, ...IDS, evidence, staging });
  await fsp.writeFile(statePath(root), '{"lastSyncedSequence":9}');

  const expected = await fileSet(sqliteResetPaths.stateRoot(root));
  delete expected["genesis-v1.json"];
  expect(await run(root)).toEqual({ kind: "refused", reason: "legacy-present" });
  expect(await fileSet(sqliteResetPaths.stateRoot(root))).toEqual(expected);
});

test("the same workspace reached through a symlinked parent is one evidence key, not case 7", async () => {
  const root = await workspace();
  const link = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-genesis-link-")), "workspace");
  await fsp.symlink(root, link, "dir");

  // Established through the real path, resumed through the symlink: a
  // `path.resolve` binding would make this healthy workspace a permanent halt.
  const evidence = await evidenceOf(root);
  const staging = plantStore(sqliteResetPaths.active(root), evidence.stream, IDS);
  await plantIntent(root, { version: 1, ...IDS, evidence, staging });

  expect(await run(link)).toEqual({ kind: "established", authorityId: IDS.authorityId });
  expect(await fsp.readFile(statePath(root))).toEqual(markerBytes(IDS.authorityId));
});

test("case 6: a non-string incarnation is refused, never coerced", async () => {
  const root = await workspace();
  const evidence = await evidenceOf(root);
  const base = { version: 1, ...IDS, evidence, staging: { dev: 1, ino: 2 } };
  for (const incarnation of [["absent"], [["absent"]], { toString: "x" }, "Absent", null, 1]) {
    await plantIntent(root, { ...base, evidence: { ...evidence, incarnation } } as unknown as GenesisIntent);
    expect(() => readGenesisIntent(root), `incarnation ${JSON.stringify(incarnation)} was admitted`)
      .toThrow(StateAuthorityCorruptError);
  }
});

test("inspect claims an empty workspace and any workspace holding an intent", async () => {
  const empty = await workspace();
  expect(await inspect(empty, LOCKS)).toEqual({ claims: true });

  const legacy = await workspace();
  await fsp.writeFile(statePath(legacy), "{}");
  expect((await inspect(legacy, LOCKS)).claims).toBe(false);

  const resuming = await workspace();
  const evidence = await evidenceOf(resuming);
  const intent: GenesisIntent = { version: 1, ...IDS, evidence, staging: { dev: 1, ino: 2 } };
  await plantIntent(resuming, intent);
  await fsp.writeFile(statePath(resuming), "{}");
  expect(await inspect(resuming, LOCKS)).toEqual({ claims: true, intent });
});
