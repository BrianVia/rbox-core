/**
 * Design 263 real-entry gate. The crash child never calls the genesis protocol:
 * it enters through LocalRuntime or RboxDaemon and kills the process at a real
 * filesystem publication boundary. Recovery then enters through the other
 * product surface.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig, type WorkspaceConfig } from "../workspace-config.js";
import { assertAuthorityWritable } from "./authority-bootstrap.js";
import { authorityMarkerBytes } from "./authority-marker.js";
import { StateWriteRefusedError } from "./errors.js";
import { readGenesisIntent } from "./genesis-intent.js";
import { rboxResiduePaths } from "./migration/fault-rig.js";
import { genesisPaths, sqliteResetPaths, statePath } from "./paths.js";
import { openStateStore, stateStoreDatabase } from "./store/open.js";

type Entry = "foreground" | "daemon-direct" | "daemon-contended-adoption" | "daemon-contended-recycle";
interface KillPoint { syscall: "rename"; match: string; when: "after" }
interface EntryResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  trace: string[];
}

const CHILD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `rbox-genesis-admission-child-${process.pid}-`));
const CHILD = path.join(CHILD_DIR, "entry-child.ts");
const CLI_DIR = path.resolve(import.meta.dir, "..");

fs.writeFileSync(CHILD, `
import { mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const [mode, root, traceFile, specJson] = process.argv.slice(2);
const spec = JSON.parse(specJson);
if (spec) {
  const table = fs.promises;
  const call = table[spec.syscall];
  let matches = 0;
  let fired = false;
  table[spec.syscall] = function patched(...args) {
    const subject = args.filter((arg) => typeof arg === "string").join("\\u0000");
    if (!new RegExp(spec.match).test(subject)) return call.apply(this, args);
    matches += 1;
    if (matches !== (spec.nth ?? 1)) return call.apply(this, args);
    fired = true;
    if (spec.when === "before") process.kill(process.pid, "SIGKILL");
    return Promise.resolve(call.apply(this, args)).then((value) => {
      process.kill(process.pid, "SIGKILL");
      return value;
    });
  };
  process.on("beforeExit", () => {
    if (!fired) { console.error("fault point never matched: " + specJson); process.exitCode = 65; }
  });
}

const cliDir = ${JSON.stringify(CLI_DIR)};
const emptyManifest = { generatedAt: "", files: [] };
const remote = {
  latest: async () => ({ sequence: 0, manifest: emptyManifest }),
  missingBlobs: async () => [],
  putBlobFile: async () => {},
  commit: async () => ({ sequence: 1 }),
  blobStore: () => ({
    has: async () => false,
    put: async () => {},
    get: async () => { throw new Error("unexpected blob read"); },
  }),
};
const policy = {
  syncGit: false,
  git: { incremental: false },
  respectGitignore: false,
  noDrift: false,
  trash: { days: 30, maxBytes: 1_000_000 },
};

mock.module(path.join(cliDir, "e2ee-client.js"), () => ({
  buildAuthedRemote: async (workspaceRoot) => {
    const { loadConfig } = await import(path.join(cliDir, "workspace-config.ts"));
    const cfg = await loadConfig(workspaceRoot);
    return {
      cfg: { ...cfg, encrypted: true, kek: Buffer.alloc(32, 7), accountId: "acct_test", accountEpoch: 0, keyEpoch: 0 },
      deps: { remote, backoff: async () => {} },
      remote,
    };
  },
}));
mock.module(path.join(cliDir, "folder-authority.js"), () => ({
  ensureFolderAuthority: async () => ({ kind: "authoritative", revision: "test" }),
}));
mock.module(path.join(cliDir, "folder-inventory.js"), () => ({
  observeFolderAdmission: async () => ({ kind: "admitted", generation: "test", policy }),
  applyFolderPolicy: (cfg, next) => ({ ...cfg, ...next, git: { ...cfg.git, ...next.git } }),
  folderPolicyFields: (next) => ({ ...next, git: { ...next.git } }),
  runtimeRefusal: (refusal) => new Error("folder admission refused: " + refusal.kind),
}));

const marker = path.join(root, ".rbox", "state.json");
const intent = path.join(root, ".rbox", "state", "genesis-v1.json");
function record(kind) {
  if (!fs.existsSync(marker) || fs.existsSync(intent)) {
    throw new Error(kind + " ran before genesis admission completed");
  }
  fs.appendFileSync(traceFile, kind + "\\n");
}

if (mode === "foreground") {
  const { LocalRuntime } = await import(path.join(cliDir, "local-runtime.ts"));
  try {
    await new LocalRuntime(root).run({ kind: "pull", massDelete: "guarded" });
  } catch (error) {
    // SP-1 proves admission, not SP-3's global SQLite product flip. The real
    // pull currently reaches its legacy-only lineage initializer after the
    // first state load; accept only that named downstream refusal, and only
    // after the authority is visibly settled and the intent is gone.
    if (error?.reason !== "state-format-too-new" || !fs.existsSync(marker) || fs.existsSync(intent)) throw error;
  }
  fs.appendFileSync(traceFile, "foreground-admission-complete\\n");
} else {
  const [{ RboxDaemon }, { loadConfig }, mutex, adopt] = await Promise.all([
    import(path.join(cliDir, "daemon/daemon.ts")),
    import(path.join(cliDir, "workspace-config.ts")),
    import(path.join(cliDir, "sync-mutex.ts")),
    import(path.join(cliDir, "adopt-cache.ts")),
  ]);
  const cfg = await loadConfig(root);
  const contended = mode.startsWith("daemon-contended");
  let startupBlocker = contended
    ? await mutex.acquireWorkspaceSyncMutex(root, "cli", { attempts: 1 })
    : undefined;
  const daemon = new RboxDaemon(root, cfg, { remote, backoff: async () => {} }, {
    bootId: "genesis-admission-gate",
    pullOnly: true,
    keyDeliveryFlight: null,
    acquireSyncMutex: async (workspaceRoot) => {
      const result = await mutex.acquireWorkspaceSyncMutex(workspaceRoot, "daemon");
      if (result.status === "contended" && startupBlocker) {
        await mutex.releaseWorkspaceSyncMutex(startupBlocker);
        startupBlocker = undefined;
      }
      return result;
    },
    log: () => {},
  });
  const originalRebuild = daemon.rebuildMatcher.bind(daemon);
  daemon.rebuildMatcher = (...args) => {
    record("matcher");
    return originalRebuild(...args);
  };
  daemon.localObserver.observe = async (plan) => {
    record("scan:" + (plan.scanKind ?? "startup"));
    void daemon.stop();
    return { deferredPaths: new Set() };
  };
  if (mode === "daemon-contended-adoption") await adopt.invalidateAdoptionCaches(root, "adopt-complete");
  if (mode === "daemon-contended-recycle") {
    daemon.folderMatcherRebuildPending = false;
    daemon.folderPolicyRecyclePending = true;
  }
  await daemon.start();
  await daemon.stop();
}
`);

const POINTS: ReadonlyArray<{ name: string; point: KillPoint }> = [
  { name: "after-intent-rename", point: { syscall: "rename", match: "genesis-v1\\.json$", when: "after" } },
  { name: "after-active-rename", point: { syscall: "rename", match: "state\\.db$", when: "after" } },
  { name: "after-Q-rename", point: { syscall: "rename", match: "state\\.json$", when: "after" } },
];

const ROUTE_RESIDUE = new Set([
  "entry-trace.txt",
  "state/activity.json",
  "state/cache-generation.json",
  "state/hashcache.json",
  "state/shell.line",
]);

async function workspace(label: string): Promise<string> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-gag-${label}-${process.pid}-`)));
  const config: WorkspaceConfig = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws-genesis-gate",
    projectId: "root",
    deviceId: "dev-genesis-gate",
    rootPath: root,
    remoteUrl: "https://example.invalid",
    token: "",
  };
  await saveConfig(root, config);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  return root;
}

function runEntry(entry: Entry, root: string, point?: KillPoint): EntryResult {
  const traceFile = path.join(root, ".rbox", "entry-trace.txt");
  const child = spawnSync(process.execPath, [CHILD, entry, root, traceFile, JSON.stringify(point ?? null)], {
    encoding: "utf8",
    env: {
      ...process.env,
      RBOX_HOME: path.join(root, "runtime-home"),
      RBOX_DAEMON_WS_DISABLED: "1",
      RBOX_DAEMON_WS_RELIABILITY_DISABLED: "1",
      RBOX_SCAN_PRUNE: "0",
    },
  });
  const trace = fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { status: child.status, signal: child.signal, stderr: child.stderr, trace };
}

function expectKilled(entry: Entry, root: string, point: KillPoint): void {
  const result = runEntry(entry, root, point);
  expect(result.signal, `${entry}: ${result.stderr}`).toBe("SIGKILL");
  expect(result.trace, `${entry} reached matcher/scan before admission`).toEqual([]);
}

function intentAuthorityId(root: string): string {
  const intent = readGenesisIntent(root);
  if (!intent) throw new Error("crash image has no genesis intent");
  return intent.authorityId;
}

function assertConverged(root: string, authorityId: string): void {
  expect(fs.existsSync(genesisPaths.intent(root))).toBe(false);
  expect(fs.readFileSync(statePath(root))).toEqual(authorityMarkerBytes(authorityId));
  expect(() => assertAuthorityWritable(root)).not.toThrow();
  const active = sqliteResetPaths.active(root);
  for (const suffix of ["-wal", "-shm", "-journal"]) expect(fs.existsSync(`${active}${suffix}`)).toBe(false);
  const store = openStateStore(active, { readonly: true });
  try {
    expect(store.header.authority_id).toBe(authorityId);
    const completion = stateStoreDatabase(store).query(
      "SELECT origin_kind,migration_id,entry_count,repo_count FROM migration_completion WHERE singleton=1",
    ).get() as { origin_kind: string; migration_id: string; entry_count: number; repo_count: number };
    expect(completion).toMatchObject({ origin_kind: "genesis", entry_count: 0, repo_count: 0 });
    expect(completion.migration_id).toMatch(/^genesis:[0-9a-f]{32}$/);
  } finally {
    store.close();
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) expect(fs.existsSync(`${active}${suffix}`)).toBe(false);
  // Whole-tree crash residue, not a hand-picked known-artifact list. Any owned
  // Q sibling, staged genesis database, sidecar, or future publication debris
  // changes this closed inventory and fails the gate.
  const residue = rboxResiduePaths(root);
  const allowed = new Set([
    ...ROUTE_RESIDUE,
    "state.json",
    "state/state.db",
    "workspace.json",
  ]);
  expect(residue.filter((entry) => !allowed.has(entry)), residue.join("\n")).toEqual([]);
  for (const required of ["entry-trace.txt", "state.json", "state/state.db", "workspace.json"]) {
    expect(residue, required).toContain(required);
  }
}

function assertCrashPremise(root: string, point: string, authorityId: string): void {
  expect(intentAuthorityId(root)).toBe(authorityId);
  let expectedResidue: string[];
  if (point === "after-intent-rename") {
    expect(fs.existsSync(statePath(root))).toBe(false);
    expect(fs.existsSync(genesisPaths.staged(root, authorityId))).toBe(true);
    expectedResidue = [
      "state/genesis-v1.json",
      `state/state.db.genesis.${authorityId}`,
      "workspace.json",
    ];
  } else if (point === "after-active-rename") {
    expect(fs.existsSync(statePath(root))).toBe(false);
    expect(fs.existsSync(sqliteResetPaths.active(root))).toBe(true);
    expectedResidue = ["state/genesis-v1.json", "state/state.db", "workspace.json"];
  } else {
    expect(fs.readFileSync(statePath(root))).toEqual(authorityMarkerBytes(authorityId));
    let refusal: unknown;
    try { assertAuthorityWritable(root); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(StateWriteRefusedError);
    expectedResidue = ["state.json", "state/genesis-v1.json", "state/state.db", "workspace.json"];
  }
  const residue = rboxResiduePaths(root);
  expect(
    residue.filter((entry) => !ROUTE_RESIDUE.has(entry)),
    residue.join("\n"),
  ).toEqual(expectedResidue);
}

test("the real-entry gate has no direct genesis implementation import or establish call", async () => {
  const source = await fsp.readFile(import.meta.path, "utf8");
  expect(source).not.toMatch(/from ["'][^"']*\/genesis(?:\.js)?["']/);
  expect(source).not.toMatch(/\bestablish\s*\(/);
  expect(fs.readFileSync(CHILD, "utf8")).not.toMatch(/\bestablish\s*\(/);
});

for (const row of ["adoption", "recycle"] as const) {
  test(`forced-contention ${row} route reaches its boundary scan only after admission`, async () => {
    const root = await workspace(`contended-${row}-uninterrupted`);
    try {
      const result = runEntry(`daemon-contended-${row}`, root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.trace.some((line) => line === "scan:deep scan"), result.trace.join(", ")).toBe(true);
      expect(result.trace.indexOf("matcher")).toBeLessThan(result.trace.indexOf("scan:deep scan"));
      const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
      const authorityId = store.header.authority_id;
      store.close();
      assertConverged(root, authorityId);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}

for (const { name, point } of POINTS) {
  test(`foreground ${name} resumes through daemon direct start`, async () => {
    const root = await workspace(`fg-${name}`);
    try {
      expectKilled("foreground", root, point);
      const authorityId = intentAuthorityId(root);
      assertCrashPremise(root, name, authorityId);
      const resumed = runEntry("daemon-direct", root);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.trace.some((line) => line.startsWith("scan:"))).toBe(true);
      assertConverged(root, authorityId);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test(`daemon direct ${name} resumes through foreground`, async () => {
    const root = await workspace(`direct-${name}`);
    try {
      expectKilled("daemon-direct", root, point);
      const authorityId = intentAuthorityId(root);
      assertCrashPremise(root, name, authorityId);
      const resumed = runEntry("foreground", root);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.trace).toContain("foreground-admission-complete");
      assertConverged(root, authorityId);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  for (const row of ["adoption", "recycle"] as const) {
    test(`daemon contended ${row} ${name} admits before its scan and resumes through foreground`, async () => {
      const root = await workspace(`contended-${row}-${name}`);
      try {
        expectKilled(`daemon-contended-${row}`, root, point);
        const authorityId = intentAuthorityId(root);
        assertCrashPremise(root, name, authorityId);
        const resumed = runEntry("foreground", root);
        expect(resumed.status, resumed.stderr).toBe(0);
        expect(resumed.trace).toContain("foreground-admission-complete");
        assertConverged(root, authorityId);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    }, 30_000);
  }
}
