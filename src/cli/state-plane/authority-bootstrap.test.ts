import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
import { StateAuthorityCorruptError, StateWriteRefusedError } from "./errors.js";
import { readGenesisIntent } from "./genesis.js";
import type { EntryProof, HeldStatePlaneLocks } from "./locks.js";
import type { MigrationOutcome } from "./migration/authority.js";
import {
  MIGRATION_PHASES, encodeMigrationControl,
  type ArtifactItem, type HaltResource, type MigrationControl,
  type MigrationPhase, type MigrationWitness,
} from "./migration/control-codec.js";
import { genesisPaths, migrationPaths, sqliteResetPaths, statePath } from "./paths.js";
import { createStateStore, openStateStore, stateStoreDatabase } from "./store/open.js";

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

/** Records every call so "exactly one migration run" is observable.
 *
 * Wave 5A collapsed 2D's generic, so the stub now returns the real
 * `MigrationOutcome`. This was invisible to both gates before — `tsconfig.json`
 * excludes `**\/*.test.ts` and Bun erases the annotation at runtime — which is the
 * same blind spot that cost lane 2B a review round. */
const STUB_OUTCOME: MigrationOutcome = { kind: "migrated", phases: ["M7"], elapsedMs: 0 };

function driver(): MigrationDriver & { calls: number } {
  const run = (async () => {
    run.calls += 1;
    return STUB_OUTCOME;
  }) as MigrationDriver & { calls: number };
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

type WitnessLayer = Partial<Omit<Extract<MigrationWitness, { phase: "M7" }>, "phase">>;

const LAYERS: readonly WitnessLayer[] = [
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

/** A workspace whose active database is real, so an open would have something
 * to open and sidecars to deposit. */
async function workspaceWithDatabase(): Promise<{ root: string; dir: string; active: string }> {
  const root = await workspace();
  const active = sqliteResetPaths.active(root);
  createStateStore(active, {
    stream: "s", createdBy: "genesis-v1", authorityId: "a".repeat(32), lineageId: "b".repeat(32),
  }).close();
  return { root, dir: sqliteResetPaths.stateRoot(root), active };
}

const listing = (dir: string): string[] => fs.readdirSync(dir).sort();

function queryOnce(db: { query: (sql: string) => { get: () => unknown } }): void {
  db.query("select count(*) as c from sqlite_master").get();
}

test("the fence leaves the state directory byte-identical", async () => {
  const { root, dir } = await workspaceWithDatabase();
  const before = snapshot(dir);
  expect(Object.keys(before)).toEqual(["state.db"]);

  for (let i = 0; i < 3; i += 1) assertAuthorityWritable(root);

  expect(snapshot(dir)).toEqual(before);
});

test("163 v13 negative control: a read-only open of the inspected database fails that snapshot", async () => {
  const { dir, active } = await workspaceWithDatabase();
  const before = snapshot(dir);

  const db = new Database(active, { readonly: true });
  queryOnce(db);
  const during = listing(dir);
  db.close();

  // The v13 finding, executable: the first read creates both sidecars and a
  // read-only close cannot remove them.
  expect(during).toEqual(["state.db", "state.db-shm", "state.db-wal"]);
  expect(snapshot(dir)).not.toEqual(before);
});

test("a self-cleaning open is why the proof above is not sufficient on its own", async () => {
  const { dir, active } = await workspaceWithDatabase();
  const before = snapshot(dir);

  // The repo's own helper opens read-write underneath and checkpoint-truncates
  // on close, so its sidecars exist only for the duration of the call.
  const handle = openStateStore(active, { readonly: true });
  queryOnce(stateStoreDatabase(handle));
  const during = listing(dir);
  handle.close();

  expect(during).toEqual(["state.db", "state.db-shm", "state.db-wal"]);
  expect(listing(dir)).toEqual(["state.db"]);
  void before;
});

test("163 v13 complete control: the fence works where no open can, however placed", async () => {
  const { root, dir, active } = await workspaceWithDatabase();
  if (process.getuid?.() === 0) return; // root ignores the mode bits this rests on

  // An unwritable parent cannot receive `-wal`/`-shm`, so EVERY open of this
  // database fails wherever it is placed — including one that would have
  // removed its own debris before returning.
  fs.chmodSync(dir, 0o555);
  try {
    for (let i = 0; i < 3; i += 1) assertAuthorityWritable(root);
    expect(() => {
      const db = new Database(active, { readonly: true });
      try { queryOnce(db); } finally { db.close(); }
    }).toThrow();
    expect(() => openStateStore(active, { readonly: true }).close()).toThrow();
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  expect(listing(dir)).toEqual(["state.db"]);
});

// --- both fence reads are bounded: no hang, no follow, no unbounded load ----

test("a FIFO at either fence path refuses instead of hanging the save", async () => {
  for (const at of ["control", "intent"] as const) {
    const root = await workspace();
    const file = at === "control" ? migrationPaths.control(root) : genesisPaths.intent(root);
    execFileSync("mkfifo", [file]);
    // Without O_NONBLOCK this never returns — while holding the state lock.
    expect(() => assertAuthorityWritable(root), at).toThrow();
  }
});

test("a symlink or an oversized file at the intent path refuses", async () => {
  const root = await workspace();
  const huge = path.join(root, "huge.json");
  await fsp.writeFile(huge, "x".repeat(64 * 1024));
  await fsp.symlink(huge, genesisPaths.intent(root));
  expect(() => assertAuthorityWritable(root)).toThrow(StateAuthorityCorruptError);

  await fsp.rm(genesisPaths.intent(root));
  await fsp.copyFile(huge, genesisPaths.intent(root));
  expect(() => assertAuthorityWritable(root)).toThrow(/over the .* cap/);
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
  expect(await establishStateAuthority(root, ENTRY, run)).toEqual({ domain: "migration", outcome: STUB_OUTCOME });
  expect(run.calls).toBe(1);
});

test("legacy JSON dispatches to migration without genesis claiming it", async () => {
  const root = await workspace();
  await fsp.writeFile(statePath(root), JSON.stringify({ version: 1, entries: {} }));
  const run = driver();
  expect(await establishStateAuthority(root, ENTRY, run)).toEqual({ domain: "migration", outcome: STUB_OUTCOME });
  expect(run.calls).toBe(1);
});

/** An intent bound to this exact workspace, so §2.5.2 case 7 does not fire
 * before the case under test. */
async function plantIntent(root: string, authorityId = "a".repeat(32)): Promise<void> {
  const config = JSON.parse(await fsp.readFile(path.join(root, ".rbox", "workspace.json"), "utf8")) as WorkspaceConfig;
  await fsp.writeFile(genesisPaths.intent(root), JSON.stringify({
    version: 1, authorityId, lineageId: "b".repeat(32),
    evidence: { root: await fsp.realpath(root), stream: syncStreamId(config), incarnation: "absent" },
    staging: { dev: 1, ino: 1 },
  }));
}

test("an intent claims genesis even when a migration control exists", async () => {
  const root = await workspace();
  await plantIntent(root);
  plantControl(root, "M0");
  const run = driver();

  const outcome = await establishStateAuthority(root, ENTRY, run);
  expect(outcome.domain).toBe("genesis");
  expect(run.calls).toBe(0);
});

test("a genesis refusal that is not legacy-present returns directly, with no re-dispatch", async () => {
  const root = await workspace();
  await fsp.rm(path.join(root, ".rbox", "workspace.json"));   // no fenced evidence
  const run = driver();

  expect(await establishStateAuthority(root, ENTRY, run))
    .toEqual({ domain: "genesis", outcome: { kind: "refused", reason: "evidence-missing" } });
  expect(run.calls, "only legacy-present may re-dispatch").toBe(0);
});

test("C8: a genesis intent that finds an L refuses, retires, and migration runs in the same pass", async () => {
  const root = await workspace();
  await plantIntent(root);
  await fsp.writeFile(statePath(root), JSON.stringify({ version: 1, entries: {} }));
  // The premise, stated rather than assumed: nothing holds the staged path, so
  // the intent's recorded inode cannot match and no removal depends on it.
  expect(fs.lstatSync(genesisPaths.staged(root, "a".repeat(32)), { throwIfNoEntry: false })).toBeUndefined();

  const run = driver();
  expect(await establishStateAuthority(root, ENTRY, run)).toEqual({ domain: "migration", outcome: STUB_OUTCOME });
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

/** Every specifier a module can reach at RUNTIME: `from "…"` and dynamic
 * `import("…")`, minus type-only lines, which are erased. */
function valueSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(import|export)\s+type\s/.test(line)) continue;
    for (const match of line.matchAll(/(?:from|import\s*\()\s*"([^"]+)"/g)) out.push(match[1]!);
  }
  return out;
}

/** `state-plane/index.ts` re-exports `migration/`, so importing it reaches
 * migration without naming it. */
const STATE_PLANE_INDEX = /\/state-plane\/index\.js"?$/;
const importsGenesis = (text: string): boolean =>
  valueSpecifiers(text).some((spec) => /\/genesis\.js$/.test(spec));
const importsMigration = (text: string): boolean =>
  valueSpecifiers(text).some((spec) => /(^|\/)migration\/[^/]+\.js$/.test(spec) || STATE_PLANE_INDEX.test(spec));

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

// --- the fence cannot reach SQLite, however anyone rewrites it --------------

const BOOTSTRAP = path.join(import.meta.dir, "authority-bootstrap.ts");

/** The identifiers `assertAuthorityWritable` actually calls. A grep for
 * `bun:sqlite` cannot see an open reached through a re-exporting facade; the
 * call graph can. */
function fenceCallees(text: string): string[] {
  const signature = text.indexOf("export function assertAuthorityWritable");
  const body = text.slice(text.indexOf("{", signature)).split("\n}")[0]!;
  return [...new Set([...body.matchAll(/\b([a-z][\w$]*)\s*\(/g)].map((m) => m[1]!))]
    .filter((name) => !["if", "for", "while", "return", "catch", "switch"].includes(name));
}

/** Resolve a relative specifier to the `.ts` on disk; bare specifiers stay. */
function resolveSpecifier(from: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  return path.resolve(path.dirname(from), spec.replace(/\.js$/, ".ts"));
}

function reachableFrom(seeds: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !file.endsWith(".ts")) continue;
    seen.add(file);
    for (const spec of valueSpecifiers(fs.readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved.endsWith(".ts")) queue.push(resolved);
      else seen.add(resolved);
    }
  }
  return seen;
}

test("the fence calls only its two bounded readers and its own refusal", () => {
  expect(fenceCallees(fs.readFileSync(BOOTSTRAP, "utf8")).sort())
    .toEqual(["blocksSqliteWrites", "readCanonicalControl", "readGenesisIntent", "refuse"]);
});

test("no SQLite is reachable from anything the fence calls", () => {
  const text = fs.readFileSync(BOOTSTRAP, "utf8");
  const seeds: string[] = [];
  for (const callee of fenceCallees(text)) {
    if (new RegExp(`^(export )?function ${callee}\\b`, "m").test(text)) continue;   // local
    const imported = new RegExp(`import[^;]*\\b${callee}\\b[^;]*from "([^"]+)"`).exec(text);
    expect(imported, `${callee} must be imported or local`).not.toBeNull();
    seeds.push(resolveSpecifier(BOOTSTRAP, imported![1]!));
  }
  expect(seeds.length).toBeGreaterThan(1);

  const reachable = reachableFrom(seeds);
  expect([...reachable].filter((entry) => /sqlite/i.test(entry) && !entry.endsWith(".ts")))
    .toEqual([]);
  expect([...reachable].some((entry) => entry.endsWith(`${path.sep}genesis.ts`)))
    .toBe(false);
});
