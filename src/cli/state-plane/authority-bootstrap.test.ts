import { expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../workspace-config.js";
import {
  assertAuthorityWritable,
  establishStateAuthority,
  type MigrationDriver,
} from "./authority-bootstrap.js";
import { StateWriteRefusedError } from "./errors.js";
import { readGenesisIntent } from "./genesis.js";
import type { EntryProof, HeldStatePlaneLocks } from "./locks.js";
import {
  MIGRATION_PHASES, encodeMigrationControl,
  type ArtifactItem, type HaltResource, type MigrationControl,
  type MigrationPhase, type MigrationWitness,
} from "./migration/control-codec.js";
import { genesisPaths, migrationPaths, sqliteResetPaths, statePath } from "./paths.js";
import { createStateStore } from "./store/open.js";

const ENTRY: EntryProof = { entry: "foreground-migrate", locks: {} as HeldStatePlaneLocks };

async function workspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-u3-2d-bootstrap-"));
  const config: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
    rootPath: root, remoteUrl: "https://example.invalid", token: "",
  };
  await saveConfig(root, config);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  return root;
}

/** Records every call so "exactly one migration run" is observable. */
function driver(): MigrationDriver<string> & { calls: number } {
  const run = (async () => {
    run.calls += 1;
    return "migrated";
  }) as MigrationDriver<string> & { calls: number };
  run.calls = 0;
  return run;
}

// --- control fixtures (shape mirrors `migration/control.test.ts`) ------------

const HASH = "a".repeat(64);
const source = { path: "/w/.rbox/state.json", dev: 1, ino: 2, bytes: 10, sha256: HASH, mtimeNs: "123" };
const artifact = { path: "/w/x", dev: 1, ino: 3, bytes: 4, sha256: HASH };
const proof = { sha256: HASH, bytes: 9, semanticDigest: HASH, entryCount: 1, repoCount: 0, proofVersion: 1 };
const item = (role: ArtifactItem["role"], ino: number): ArtifactItem =>
  ({ role, path: `/w/${role}`, parent: "/w", dev: 1, ino, sha256: null });

const LAYERS: readonly Record<string, unknown>[] = [
  {},
  { admission: { sourceBytes: 10, requiredBytes: 520, budgetBytes: 4096 } },
  { history: artifact, fixedBackup: artifact, stagingMain: { state: "present", dev: 1, ino: 30 } },
  {
    completion: {
      migrationId: "m1", importerVersion: "2.0.0", authorityId: "a1", sourceJsonSha256: HASH,
      sourceSemanticDigest: HASH, sourceBytes: 10, entryCount: 1, repoCount: 0,
      perTableCounts: { files: 1 }, completedAt: 5,
    },
  },
  { staging: proof },
  {
    active: proof,
    qSibling: { path: "/w/.rbox/state.json.migrate.m1.q", bytes: 58, sha256: HASH, disposition: { state: "absent" } },
  },
  { cleanup: { items: [item("reserve", 7)], durablePrefix: 1, currentIntent: null }, futureControls: null },
  { terminalSibling: { ...artifact, disposition: "exact-or-absent-terminal" } },
];

const available: HaltResource = { disposition: "available", dev: 1, ino: 20, bytes: 1_048_576, sha256: HASH };

function resourcesFor(phase: MigrationPhase): MigrationControl["haltResources"] {
  if (phase === "M0") return { reserve: { disposition: "not-created" }, emergency: { disposition: "not-created" } };
  if (phase === "M7") return { reserve: { disposition: "retired" }, emergency: { disposition: "retired" } };
  if (phase === "M6") return { reserve: { disposition: "cleanup-absent" }, emergency: { disposition: "cleanup-intent" } };
  return { reserve: available, emergency: available };
}

function controlFor(phase: MigrationPhase): MigrationControl {
  return {
    version: 1, controlRevision: 1, migrationId: "m1", authorityId: "a1",
    source, stagingPath: "/w/.rbox/state/state.db.migrate.m1",
    witness: Object.assign({ phase }, ...LAYERS.slice(0, MIGRATION_PHASES.indexOf(phase) + 1)) as MigrationWitness,
    haltResources: resourcesFor(phase),
    halt: null, retirement: null,
  };
}

function plantControl(root: string, phase: MigrationPhase): void {
  fs.writeFileSync(migrationPaths.control(root), encodeMigrationControl(controlFor(phase)));
}

/** Every byte under a directory, sidecars included — the snapshot 163 uses to
 * prove an observation wrote nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    out[name] = fs.statSync(file).isDirectory() ? "<dir>" : fs.readFileSync(file).toString("base64");
  }
  return out;
}

// --- the write fence --------------------------------------------------------

test("the fence admits a workspace with no control and no intent", async () => {
  const root = await workspace();
  expect(() => assertAuthorityWritable(root)).not.toThrow();
});

test("the fence refuses while a control blocks writes, with one reason", async () => {
  const root = await workspace();
  plantControl(root, "M0");
  try {
    assertAuthorityWritable(root);
    throw new Error("expected a refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(StateWriteRefusedError);
    expect((error as StateWriteRefusedError).reason).toBe("authority-recovery-pending");
    expect((error as StateWriteRefusedError).file).toBe(statePath(root));
  }
});

test("the fence admits a control past the flip", async () => {
  const root = await workspace();
  plantControl(root, "M7");
  expect(() => assertAuthorityWritable(root)).not.toThrow();
});

test("the fence refuses an unretired genesis intent under the same reason", async () => {
  const root = await workspace();
  const run = driver();
  expect(await establishStateAuthority(root, ENTRY, run)).toMatchObject({ domain: "genesis" });
  expect(readGenesisIntent(root)).toBeUndefined();
  expect(() => assertAuthorityWritable(root)).not.toThrow();

  // A surviving intent means `Q`'s parent fsync may not have completed (§2.5.2 case 1).
  await fsp.writeFile(genesisPaths.intent(root), JSON.stringify({
    version: 1, authorityId: "b".repeat(32), lineageId: "c".repeat(32),
    evidence: { root, stream: "s", incarnation: "absent" }, staging: { dev: 1, ino: 2 },
  }));
  expect(() => assertAuthorityWritable(root)).toThrow(StateWriteRefusedError);
  expect(() => assertAuthorityWritable(root)).toThrow(/authority recovery|mid-recovery/);
});

test("the fence fails closed on an undecodable control", async () => {
  const root = await workspace();
  await fsp.writeFile(migrationPaths.control(root), "{not json");
  expect(() => assertAuthorityWritable(root)).toThrow();
});

test("the fence opens no database: the state directory is byte-identical after it runs", async () => {
  const root = await workspace();
  const active = sqliteResetPaths.active(root);
  createStateStore(active, {
    stream: "s", createdBy: "genesis-v1", authorityId: "a".repeat(32), lineageId: "b".repeat(32),
  }).close();
  const dir = sqliteResetPaths.stateRoot(root);
  const before = snapshot(dir);
  expect(Object.keys(before)).toEqual(["state.db"]);

  for (let i = 0; i < 3; i += 1) assertAuthorityWritable(root);

  expect(snapshot(dir)).toEqual(before);
});

// --- dispatch ---------------------------------------------------------------

test("a fresh workspace dispatches to genesis and never runs migration", async () => {
  const root = await workspace();
  const run = driver();
  const outcome = await establishStateAuthority(root, ENTRY, run);
  expect(outcome.domain).toBe("genesis");
  expect(outcome).toMatchObject({ outcome: { kind: "established" } });
  expect(run.calls).toBe(0);
});

test("a workspace carrying a migration control dispatches to migration", async () => {
  const root = await workspace();
  plantControl(root, "M0");
  const run = driver();
  expect(await establishStateAuthority(root, ENTRY, run)).toEqual({ domain: "migration", outcome: "migrated" });
  expect(run.calls).toBe(1);
});

test("legacy JSON dispatches to migration without genesis claiming it", async () => {
  const root = await workspace();
  await fsp.writeFile(statePath(root), JSON.stringify({ version: 1, entries: {} }));
  const run = driver();
  expect(await establishStateAuthority(root, ENTRY, run)).toEqual({ domain: "migration", outcome: "migrated" });
  expect(run.calls).toBe(1);
});

test("C8: a genesis intent that finds an L refuses, retires, and migration runs in the same pass", async () => {
  const root = await workspace();
  const config = JSON.parse(await fsp.readFile(path.join(root, ".rbox", "workspace.json"), "utf8")) as WorkspaceConfig;
  // A published intent, and an `L` that appeared before the attempt resumed.
  await fsp.writeFile(genesisPaths.intent(root), JSON.stringify({
    version: 1, authorityId: "a".repeat(32), lineageId: "b".repeat(32),
    evidence: { root: await fsp.realpath(root), stream: syncStreamId(config), incarnation: "absent" },
    staging: { dev: 1, ino: 1 },
  }));
  await fsp.writeFile(statePath(root), JSON.stringify({ version: 1, entries: {} }));

  const run = driver();
  expect(await establishStateAuthority(root, ENTRY, run)).toEqual({ domain: "migration", outcome: "migrated" });
  expect(run.calls).toBe(1);
  expect(readGenesisIntent(root)).toBeUndefined();
  // The re-inspect is bounded: writes flow again the moment the intent is gone.
  expect(() => assertAuthorityWritable(root)).not.toThrow();
});

// --- the boundary the fence's home depends on (§7.9) ------------------------

const SRC = path.resolve(import.meta.dir, "../../..", "src");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts") ? [file] : [];
  });
}

const importsGenesis = (text: string): boolean => /from "[^"]*\/genesis\.js"/.test(text);
const importsMigration = (text: string): boolean => /from "[^"]*(\/|\.\/)migration\/[^"]+\.js"/.test(text);

test("genesis and migration never import each other, and one module imports both", () => {
  const both: string[] = [];
  for (const file of sources(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    const genesisSide = importsGenesis(text);
    const migrationSide = importsMigration(text);
    if (file.endsWith(`${path.sep}genesis.ts`)) {
      expect(migrationSide, "genesis.ts must import nothing from migration/").toBe(false);
    }
    if (file.includes(`${path.sep}state-plane${path.sep}migration${path.sep}`)) {
      expect(genesisSide, `${file} must import nothing from genesis.ts`).toBe(false);
    }
    if (genesisSide && migrationSide) both.push(path.relative(SRC, file));
  }
  expect(both).toEqual([path.join("cli", "state-plane", "authority-bootstrap.ts")]);
});

test("the fence's module opens no database", () => {
  const text = fs.readFileSync(path.join(import.meta.dir, "authority-bootstrap.ts"), "utf8");
  expect(text).not.toContain("bun:sqlite");
  expect(text).not.toContain("store/open.js");
});
