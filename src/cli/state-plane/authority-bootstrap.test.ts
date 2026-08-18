import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../workspace-config.js";
import {
  acquireWorkspaceSyncMutex,
  releaseWorkspaceSyncMutex,
  type WorkspaceSyncMutex,
} from "../sync-mutex.js";
import {
  admitGenesisAuthority,
  observeStateAuthority,
} from "./authority-bootstrap.js";
import { assertAuthorityWritable } from "./state-write-fence.js";
import { authorityMarkerBytes } from "./authority-marker.js";
import { StateAuthorityCorruptError, StateWriteRefusedError } from "./errors.js";
import { readGenesisIntent } from "./genesis.js";
import { genesisPaths, sqliteResetPaths, statePath } from "./paths.js";
import { createStateStore, openStateStore, stateStoreDatabase } from "./store/open.js";
import { rboxResiduePaths } from "./fault-rig.js";

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

async function plantLegacyState(root: string): Promise<void> {
  await fsp.writeFile(statePath(root), JSON.stringify({
    stream: "s",
    stateNonce: "d".repeat(32),
    stateRevision: 0,
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
    repoRecords: {},
  }));
}

/** Every byte under a directory, sidecars included — the snapshot 163 uses to
 * prove an observation wrote nothing. */
function snapshot(dir: string) {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    out[name] = fs.statSync(file).isDirectory() ? "<dir>" : fs.readFileSync(file).toString("base64");
  }
  return out;
}

// --- the write fence --------------------------------------------------------

test("the fence admits a workspace with no genesis intent", async () => {
  const root = await workspace();
  expect(() => assertAuthorityWritable(root)).not.toThrow();
});

test("the fence refuses an unretired genesis intent under the same reason", async () => {
  const root = await workspace();
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  try {
    expect(await admitGenesisAuthority(root, mutex)).toMatchObject({
      kind: "selected",
      authority: { kind: "sqlite-store" },
    });
  } finally {
    await releaseWorkspaceSyncMutex(mutex);
  }
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

test("a FIFO at the genesis-intent fence refuses instead of hanging the save", async () => {
  const root = await workspace();
  execFileSync("mkfifo", [genesisPaths.intent(root)]);
  expect(() => assertAuthorityWritable(root)).toThrow();
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

// --- observation and ordinary admission -------------------------------------

test("file-level observation keeps absence separate from both backends", async () => {
  const root = await workspace();
  expect(await observeStateAuthority(root)).toEqual({ kind: "uninitialized", format: "absent" });

  await plantLegacyState(root);
  expect(await observeStateAuthority(root)).toEqual({ kind: "legacy-json-store", format: "json" });

  await fsp.writeFile(statePath(root), "not an rbox state document\n");
  expect(await observeStateAuthority(root)).toEqual({ kind: "legacy-json-store", format: "foreign" });

  const authorityId = "9".repeat(32);
  await fsp.writeFile(statePath(root), authorityMarkerBytes(authorityId));
  expect(await observeStateAuthority(root)).toEqual({
    kind: "sqlite-store", format: "authority-marker", authorityId,
  });
});

test("settled authority is selected before borrowed-mutex validation or lock/genesis loading", async () => {
  const root = await workspace();
  await plantLegacyState(root);
  const unusable = {
    root: `${root}-wrong`, incarnation: "never-owned", released: true,
  } as WorkspaceSyncMutex;

  expect(await admitGenesisAuthority(root, unusable)).toEqual({
    kind: "selected",
    authority: { kind: "legacy-json-store", format: "json" },
  });

  const source = fs.readFileSync(path.join(import.meta.dir, "authority-bootstrap.ts"), "utf8");
  const admission = source.slice(
    source.indexOf("export async function admitGenesisAuthority"),
    source.indexOf("/** Doctor's advisory"),
  );
  const fastReturn = admission.indexOf('return { kind: "selected", authority: selection }');
  expect(fastReturn).toBeGreaterThan(-1);
  expect(admission.indexOf('import("./locks.js")')).toBeGreaterThan(fastReturn);
  expect(admission.indexOf('import("./genesis.js")')).toBeGreaterThan(fastReturn);
  for (const removed of ["MigrationDriver", "AuthorityOutcome", "establishStateAuthority", "claimsGenesis"]) {
    expect(admission).not.toContain(removed);
  }
});

for (const format of ["absent", "q-intent"] as const) {
  test(`${format} admission completes with the whole-state inventory replaced by a throwing sentinel`, () => {
    const fixture = path.join(import.meta.dir, "genesis-admission-recursion.fixture.js");
    const output = execFileSync(process.execPath, [fixture, format], { encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ format, kind: "sqlite-store", intent: false });
  });
}

test("two concurrent real held-mutex entries publish exactly one genesis authority", async () => {
  const root = await workspace();
  let waits = 0;
  let stagedClaims = 0;
  const originalOpen = fsp.open;
  const observedOpen = spyOn(fsp, "open").mockImplementation(((file, flags, ...args) => {
    if (String(file).includes("state.db.genesis.") && (Number(flags) & fs.constants.O_EXCL) !== 0) {
      stagedClaims += 1;
    }
    return originalOpen(file, flags, ...args);
  }) as typeof fsp.open);
  const enter = async () => {
    const mutex = await acquireWorkspaceSyncMutex(root, "cli", {
      attempts: 500,
      retryDelayMs: 1,
      onWait: () => { waits += 1; },
    });
    try {
      return await admitGenesisAuthority(root, mutex);
    } finally {
      await releaseWorkspaceSyncMutex(mutex);
    }
  };

  const [first, second] = await Promise.all([enter(), enter()]).finally(() => observedOpen.mockRestore());
  expect(first.kind).toBe("selected");
  expect(second).toEqual(first);
  expect(waits).toBeGreaterThan(0);
  expect(stagedClaims).toBe(1);
  expect(readGenesisIntent(root)).toBeUndefined();
  expect(rboxResiduePaths(root)).toEqual(["state.json", "state/state.db", "workspace.json"]);

  if (first.kind !== "selected" || first.authority.kind !== "sqlite-store") {
    throw new Error("test requires selected SQLite authority");
  }
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
  try {
    expect(store.header.authority_id).toBe(first.authority.authorityId);
    expect(stateStoreDatabase(store).query(
      "SELECT origin_kind,entry_count,repo_count FROM migration_completion WHERE singleton=1",
    ).all()).toEqual([{ origin_kind: "genesis", entry_count: 0, repo_count: 0 }]);
  } finally {
    store.close();
  }
});

test("state-lock I/O is a typed ephemeral refusal before genesis mutation", async () => {
  const root = await workspace();
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  const originalLink = fsp.link;
  const failedLink = spyOn(fsp, "link").mockImplementation(async (existing, target) => {
    if (String(target).endsWith("state.json.lock")) {
      throw Object.assign(new Error("injected state-lock storage fault"), { code: "EIO" });
    }
    return originalLink(existing, target);
  });
  try {
    expect(await admitGenesisAuthority(root, mutex)).toMatchObject({
      kind: "refused",
      refusal: { reason: "lock-io", layer: "state" },
    });
    expect(readGenesisIntent(root)).toBeUndefined();
    expect(await observeStateAuthority(root)).toEqual({ kind: "uninitialized", format: "absent" });
    expect(rboxResiduePaths(root)).toEqual(["workspace.json"]);
  } finally {
    failedLink.mockRestore();
    await releaseWorkspaceSyncMutex(mutex);
  }
});

test("ordinary admission has no migration dispatch vocabulary", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "authority-bootstrap.ts"), "utf8");
  for (const removed of [
    "establishStateAuthority",
    "AuthorityOutcome",
    "MigrationDriver",
    "claimsGenesis",
    "runMigration",
  ]) expect(source).not.toContain(removed);
});

// --- the boundary the fence's home depends on (§7.9) ------------------------

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

// --- the fence cannot reach SQLite, however anyone rewrites it --------------

const BOOTSTRAP = path.join(import.meta.dir, "authority-bootstrap.ts");
const FENCE = path.join(import.meta.dir, "state-write-fence.ts");

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

/** Runtime-static imports only. Admission's genesis/lock imports are
 * deliberately excluded: settled selection returns before evaluating them. */
function staticValueSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(import|export)\s+type\s/.test(line)) continue;
    const from = /\bfrom\s+"([^"]+)"/.exec(line)?.[1];
    const sideEffect = /^\s*import\s+"([^"]+)"/.exec(line)?.[1];
    if (from) out.push(from);
    if (sideEffect) out.push(sideEffect);
  }
  return out;
}

function staticallyReachableFrom(seed: string): Set<string> {
  const seen = new Set<string>();
  const queue = [seed];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !file.endsWith(".ts")) continue;
    seen.add(file);
    for (const spec of staticValueSpecifiers(fs.readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved.endsWith(".ts")) queue.push(resolved);
      else seen.add(resolved);
    }
  }
  return seen;
}

test("settled selection's static coordinator closure is SQLite/genesis/lock free", () => {
  const reachable = staticallyReachableFrom(BOOTSTRAP);
  const names = [...reachable];
  expect(names.some((name) => name.endsWith(`${path.sep}genesis.ts`))).toBeFalse();
  expect(names.some((name) => name.endsWith(`${path.sep}locks.ts`))).toBeFalse();
  expect(names.some((name) => name.endsWith(`${path.sep}store-facade.ts`))).toBeFalse();
  expect(names).not.toContain("bun:sqlite");
});

test("the fence calls only its bounded genesis reader and its own refusal", () => {
  expect(fenceCallees(fs.readFileSync(FENCE, "utf8")).sort())
    .toEqual(["readGenesisIntent", "refuse"]);
});

test("no SQLite is reachable from anything the fence calls", () => {
  const text = fs.readFileSync(FENCE, "utf8");
  const seeds: string[] = [];
  for (const callee of fenceCallees(text)) {
    if (new RegExp(`^(export )?function ${callee}\\b`, "m").test(text)) continue;   // local
    const imported = new RegExp(`import[^;]*\\b${callee}\\b[^;]*from "([^"]+)"`).exec(text);
    expect(imported, `${callee} must be imported or local`).not.toBeNull();
    seeds.push(resolveSpecifier(FENCE, imported![1]!));
  }
  expect(seeds).toHaveLength(1);

  const reachable = reachableFrom(seeds);
  expect([...reachable].filter((entry) => /sqlite/i.test(entry) && !entry.endsWith(".ts")))
    .toEqual([]);
  expect([...reachable].some((entry) => entry.endsWith(`${path.sep}genesis.ts`)))
    .toBe(false);
});
