/**
 * Design 265 §6.4 reset-port acceptance measurements.
 *
 * Every sample gets a new copy of a scratch fixture. Fixture copying, reset
 * consent construction, mutex acquisition, and L1 provenance marking are
 * deliberately outside the timed region. Store counters are injected into the
 * source graph by this benchmark only; production modules remain unchanged.
 *
 * usage:
 *   bun scripts/bench/reset-sqlite-port.ts
 *   bun scripts/bench/reset-sqlite-port.ts --samples 20 --repo /tmp/rbox-core
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type AuthorityKind = "json" | "q";
type OpenKind =
  | "projectionReadonly"
  | "saveWritable"
  | "beginActiveWritable"
  | "beginSeedCreate"
  | "recoveryWalTakeover";
type ReadKind =
  | "immutableLineage"
  | "stateProjection"
  | "beginLineageSql"
  | "lockedLineageSql"
  | "recoveryLineageSql";

interface StoreCounters {
  opens: Record<OpenKind, number>;
  reads: Record<ReadKind, number>;
  namespaceWalks: number;
  sqliteModuleEvaluations: number;
}

interface Sample {
  elapsedMs: number;
  counters: StoreCounters;
}

interface MeasurementSummary {
  p50Ms: number;
  p95Ms: number;
  samples: number;
  storeOpens: StoreCounters["opens"];
  storeReads: StoreCounters["reads"];
  namespaceWalks: number;
  sqliteModuleEvaluations: number;
}

const OLD_STREAM = "https://bench.invalid::ws-reset-old::root";
const NEXT_STREAM = "https://bench.invalid::ws-reset-next::root";
const NONCE = "c".repeat(32);
const AUTHORITY_ID = "a".repeat(32);
const LINEAGE_ID = "b".repeat(32);

const moduleUrl = (repo: string, relative: string): string =>
  pathToFileURL(path.join(repo, relative)).href;

const emptyCounters = (): StoreCounters => ({
  opens: {
    projectionReadonly: 0,
    saveWritable: 0,
    beginActiveWritable: 0,
    beginSeedCreate: 0,
    recoveryWalTakeover: 0,
  },
  reads: {
    immutableLineage: 0,
    stateProjection: 0,
    beginLineageSql: 0,
    lockedLineageSql: 0,
    recoveryLineageSql: 0,
  },
  namespaceWalks: 0,
  sqliteModuleEvaluations: 0,
});

let activeCounters: StoreCounters | undefined;
let sqliteModuleEvaluationCount = 0;

function recordStoreOperation(kind: OpenKind | ReadKind | "namespaceWalk" | "sqliteModuleEvaluation"): void {
  if (kind === "sqliteModuleEvaluation") sqliteModuleEvaluationCount += 1;
  if (!activeCounters) return;
  if (kind === "namespaceWalk") {
    activeCounters.namespaceWalks += 1;
  } else if (kind === "sqliteModuleEvaluation") {
    activeCounters.sqliteModuleEvaluations += 1;
  } else if (kind === "projectionReadonly" || kind === "saveWritable"
    || kind === "beginActiveWritable" || kind === "beginSeedCreate" || kind === "recoveryWalTakeover") {
    activeCounters.opens[kind] += 1;
  } else {
    activeCounters.reads[kind] += 1;
  }
}

function instrument(source: string, replacements: ReadonlyArray<readonly [string, string]>, file: string): string {
  let result = source;
  for (const [needle, replacement] of replacements) {
    if (!result.includes(needle)) throw new Error(`reset benchmark instrumentation drifted at ${file}: ${needle}`);
    result = result.replace(needle, replacement);
  }
  return result;
}

function installStoreInstrumentation(repo: string): void {
  const openFile = path.resolve(repo, "src/cli/state-plane/store/open.ts");
  const readFile = path.resolve(repo, "src/cli/state-plane/adapters/read-only.ts");
  const saveFile = path.resolve(repo, "src/cli/state-plane/adapters/sqlite-state-save.ts");
  const compatFile = path.resolve(repo, "src/cli/state-plane/adapters/whole-state-compat.ts");
  const lifecycleFile = path.resolve(repo, "src/cli/state-plane/reset/lifecycle.ts");
  const inventoryFile = path.resolve(repo, "src/cli/reset-namespace-inventory.ts");
  const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const record = (kind: OpenKind | ReadKind | "namespaceWalk" | "sqliteModuleEvaluation"): string =>
    `(globalThis as typeof globalThis & { __rboxResetBenchRecord?: (kind: string) => void }).__rboxResetBenchRecord?.("${kind}");`;

  Object.assign(globalThis, { __rboxResetBenchRecord: recordStoreOperation });
  Bun.plugin({
    name: "reset-sqlite-port-store-counters",
    setup(build) {
      build.onLoad({ filter: new RegExp(`^(?:${[
        openFile, readFile, saveFile, compatFile, lifecycleFile, inventoryFile,
      ].map(escaped).join("|")})$`) }, (args) => {
        const source = fs.readFileSync(args.path, "utf8");
        if (args.path === openFile) {
          return {
            loader: "ts",
            contents: `${record("sqliteModuleEvaluation")}\n${instrument(source, [
              [
                "export function readImmutableStoreLineage(file: string): ImmutableStoreLineage {",
                `export function readImmutableStoreLineage(file: string): ImmutableStoreLineage {\n  ${record("immutableLineage")}`,
              ],
            ], args.path)}`,
          };
        }
        if (args.path === saveFile) {
          return {
            loader: "ts",
            contents: instrument(source, [[
              "export function readReplacementLineage(store: StateStoreHandle): ReplacementLineage {",
              `export function readReplacementLineage(store: StateStoreHandle): ReplacementLineage {\n  ${record("lockedLineageSql")}`,
            ]], args.path),
          };
        }
        if (args.path === compatFile) {
          return {
            loader: "ts",
            contents: instrument(source, [[
              "async function openAuthorityStore(authority: SqliteAuthority, readonly: boolean): Promise<{ store: StateStoreHandle; facade: StoreFacade }> {",
              `async function openAuthorityStore(authority: SqliteAuthority, readonly: boolean): Promise<{ store: StateStoreHandle; facade: StoreFacade }> {\n  if (readonly) { ${record("projectionReadonly")} } else { ${record("saveWritable")} }`,
            ]], args.path),
          };
        }
        if (args.path === lifecycleFile) {
          return {
            loader: "ts",
            contents: instrument(source, [
              [
                "const store = ownedStateStoreWriterForReset(file) ?? openStateStore(file);",
                `const store = ownedStateStoreWriterForReset(file) ?? (() => { ${record("beginActiveWritable")} return openStateStore(file); })();`,
              ],
              [
                "export async function quiesceActiveDbForReset(root: string, heldLock: OwnedLock): Promise<SqliteResetLineage> {",
                `export async function quiesceActiveDbForReset(root: string, heldLock: OwnedLock): Promise<SqliteResetLineage> {\n  ${record("beginLineageSql")}`,
              ],
              [
                "const store = openStateStoreForWalTakeover(file);",
                `${record("recoveryWalTakeover")}\n  const store = openStateStoreForWalTakeover(file);`,
              ],
              [
                "export async function recoverOrdinaryWalCrash(\n  root: string,\n  heldLock: OwnedLock,\n  expected?: Partial<SqliteResetLineage>,\n  hooks: { crashAt?: (point: string) => void | Promise<void> } = {},\n): Promise<SqliteResetLineage> {",
                `export async function recoverOrdinaryWalCrash(\n  root: string,\n  heldLock: OwnedLock,\n  expected?: Partial<SqliteResetLineage>,\n  hooks: { crashAt?: (point: string) => void | Promise<void> } = {},\n): Promise<SqliteResetLineage> {\n  ${record("recoveryLineageSql")}`,
              ],
              [
                "    const store = createStateStore(temp, {",
                `    ${record("beginSeedCreate")}\n    const store = createStateStore(temp, {`,
              ],
            ], args.path),
          };
        }
        if (args.path === inventoryFile) {
          return {
            loader: "ts",
            contents: instrument(source, [[
              "async function inventoryAttempt(\n  root: string,\n  context: AttemptContext,\n): Promise<ResetNamespaceInventory> {",
              `async function inventoryAttempt(\n  root: string,\n  context: AttemptContext,\n): Promise<ResetNamespaceInventory> {\n  ${record("namespaceWalk")}`,
            ]], args.path),
          };
        }
        return {
          loader: "ts",
          contents: instrument(source, [[
            "export function loadRawStateFromStore(store: StateStoreHandle): SyncState {",
            `export function loadRawStateFromStore(store: StateStoreHandle): SyncState {\n  ${record("stateProjection")}`,
          ]], args.path),
        };
      });
    },
  });
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

function stableCounters(samples: readonly Sample[]): StoreCounters {
  const first = samples[0]?.counters ?? emptyCounters();
  const expected = JSON.stringify(first);
  for (const sample of samples) {
    if (JSON.stringify(sample.counters) !== expected) {
      throw new Error(`store counts varied between identical samples: ${expected} != ${JSON.stringify(sample.counters)}`);
    }
  }
  return first;
}

function summary(samples: readonly Sample[]): MeasurementSummary {
  const counters = stableCounters(samples);
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    p50Ms: round(percentile(samples.map((sample) => sample.elapsedMs), 0.5)),
    p95Ms: round(percentile(samples.map((sample) => sample.elapsedMs), 0.95)),
    samples: samples.length,
    storeOpens: {
      ...counters.opens,
    },
    storeReads: {
      ...counters.reads,
    },
    namespaceWalks: counters.namespaceWalks,
    sqliteModuleEvaluations: counters.sqliteModuleEvaluations,
  };
}

async function measured(operation: () => void | Promise<void>): Promise<Sample> {
  activeCounters = emptyCounters();
  const startedAt = performance.now();
  try {
    await operation();
    return { elapsedMs: performance.now() - startedAt, counters: activeCounters };
  } finally {
    activeCounters = undefined;
  }
}

function cloneFixture(parent: string, template: string, label: string, index: number): string {
  const root = path.join(parent, `${label}-${index}`);
  fs.cpSync(template, root, { recursive: true });
  return fs.realpathSync(root);
}

async function makeJsonFixtures(repo: string): Promise<{
  parent: string;
  json: string;
  jsonL1: string;
}> {
  const [legacy, paths] = await Promise.all([
    import(moduleUrl(repo, "src/cli/state-plane/adapters/legacy-json-store.ts")),
    import(moduleUrl(repo, "src/cli/state-plane/paths.ts")),
  ]);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-reset-port-bench-"));
  const json = fs.realpathSync(fs.mkdtempSync(path.join(parent, "json-template-")));
  const state = {
    stream: OLD_STREAM,
    stateNonce: NONCE,
    stateRevision: 0,
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
    repoRecords: {},
  };

  await legacy.saveStateUnsafeLegacyOrTest(json, state);
  const jsonL1 = path.join(parent, "json-l1-template");
  fs.cpSync(json, jsonL1, { recursive: true });
  const jsonBytes = fs.readFileSync(paths.statePath(jsonL1));
  const jsonArchive = path.join(
    paths.sqliteResetPaths.stateRoot(jsonL1), "lineages", NONCE,
    `${crypto.createHash("sha256").update(jsonBytes).digest("hex")}.json`,
  );
  fs.mkdirSync(path.dirname(jsonArchive), { recursive: true });
  fs.copyFileSync(paths.statePath(jsonL1), jsonArchive);
  return { parent, json, jsonL1 };
}

async function makeSqliteFixtures(repo: string, parent: string): Promise<{ q: string; qL1: string }> {
  const [paths, stores, marker, artifacts] = await Promise.all([
    import(moduleUrl(repo, "src/cli/state-plane/paths.ts")),
    import(moduleUrl(repo, "src/cli/state-plane/store/open.ts")),
    import(moduleUrl(repo, "src/cli/state-plane/authority-marker.ts")),
    import(moduleUrl(repo, "src/cli/state-plane/reset/artifacts.ts")),
  ]);
  const q = fs.realpathSync(fs.mkdtempSync(path.join(parent, "q-template-")));
  fs.mkdirSync(paths.sqliteResetPaths.stateRoot(q), { recursive: true });
  stores.createStateStore(paths.sqliteResetPaths.active(q), {
    authorityId: AUTHORITY_ID,
    lineageId: LINEAGE_ID,
    stream: OLD_STREAM,
    createdBy: "reset-port-bench",
    stateNonce: NONCE,
    stateRevision: 0,
  }).close();
  fs.writeFileSync(paths.statePath(q), marker.authorityMarkerBytes(AUTHORITY_ID));
  const qL1 = path.join(parent, "q-l1-template");
  fs.cpSync(q, qL1, { recursive: true });
  const qHash = (await artifacts.stableDbHash(paths.sqliteResetPaths.active(qL1))).sha256;
  const qArchive = paths.sqliteResetPaths.archive(qL1, NONCE, qHash);
  fs.mkdirSync(path.dirname(qArchive), { recursive: true });
  fs.copyFileSync(paths.sqliteResetPaths.active(qL1), qArchive);
  return { q, qL1 };
}

async function dirtyWal(file: string): Promise<void> {
  const child = spawnSync(process.execPath, [import.meta.path, "--dirty-wal", file], { encoding: "utf8" });
  if (child.signal !== "SIGKILL") throw new Error(`failed to crash the W1 fixture writer: ${child.stderr}`);
  if (!fs.existsSync(`${file}-wal`) || !fs.existsSync(`${file}-shm`)) {
    throw new Error("W1 fixture child did not leave WAL/SHM residue");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const samplesAt = args.indexOf("--samples");
  const repoAt = args.indexOf("--repo");
  const samples = samplesAt === -1 ? 20 : Number(args[samplesAt + 1]);
  const repo = path.resolve(repoAt === -1 ? process.cwd() : args[repoAt + 1] ?? "");
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
  if (!fs.existsSync(path.join(repo, "docs/design/265-reset-rebind-sqlite-port.md"))) {
    throw new Error(`--repo is not an rbox source tree with design 265: ${repo}`);
  }

  installStoreInstrumentation(repo);
  const [reset, journal, consent, mutexes, lineage, syncState, paths] = await Promise.all([
    import(moduleUrl(repo, "src/cli/reset-state.ts")),
    import(moduleUrl(repo, "src/cli/reset-journal.ts")),
    import(moduleUrl(repo, "src/cli/reset-consent.ts")),
    import(moduleUrl(repo, "src/cli/sync-mutex.ts")),
    import(moduleUrl(repo, "src/cli/state-plane/reset-lineage.ts")),
    import(moduleUrl(repo, "src/cli/sync-state.ts")),
    import(moduleUrl(repo, "src/cli/state-plane/paths.ts")),
  ]);
  const fixtures = await makeJsonFixtures(repo);
  const sqliteEvaluationsBeforeJsonRows = sqliteModuleEvaluationCount;
  if (sqliteEvaluationsBeforeJsonRows !== 0) {
    throw new Error(`SQLite evaluated ${sqliteEvaluationsBeforeJsonRows} time(s) before the JSON rows`);
  }
  let fixtureIndex = 0;
  const take = (template: string, label: string): string => cloneFixture(
    fixtures.parent, template, label, fixtureIndex++,
  );
  const mintConsent = (root: string) => consent.mintSetupExistingConsent({
    root,
    observedOldStream: OLD_STREAM,
    observedOldNonce: NONCE,
    mintedAtRevision: 0,
    remoteUrl: "https://bench.invalid",
    workspaceId: "ws-reset-next",
    projectId: "root",
  });
  const repeat = async (operation: (index: number) => Promise<Sample>): Promise<MeasurementSummary> => {
    const values: Sample[] = [];
    for (let index = 0; index < samples; index += 1) values.push(await operation(index));
    return summary(values);
  };
  const p1 = async (kind: AuthorityKind, template: string): Promise<MeasurementSummary> => repeat(async () => {
    const root = take(template, `p1-${kind}`);
    const witness = mintConsent(root);
    const mutex = await mutexes.acquireWorkspaceSyncMutex(root, "cli");
    try {
      return await measured(() => reset.resetSyncState(root, NEXT_STREAM, mutex, witness));
    } finally {
      await mutexes.releaseWorkspaceSyncMutex(mutex);
    }
  });
  const standing = async (kind: AuthorityKind, template: string): Promise<MeasurementSummary> => repeat(async () => {
    const root = take(template, `s-${kind}`);
    return measured(async () => {
      const observation = await journal.inspectResetFenceInventory(root, OLD_STREAM);
      if (observation.settlement !== "none") throw new Error(`${kind} S0 fixture unexpectedly needs settlement`);
    });
  });
  const w1 = async (template: string): Promise<MeasurementSummary> => repeat(async () => {
    const root = take(template, "w1-q");
    await dirtyWal(paths.sqliteResetPaths.active(root));
    const mutex = await mutexes.acquireWorkspaceSyncMutex(root, "cli");
    try {
      return await measured(async () => {
        const result = await journal.settleStandingReset(root, mutex, OLD_STREAM);
        if (result !== "complete") throw new Error("W1 fixture was not recovered");
      });
    } finally {
      await mutexes.releaseWorkspaceSyncMutex(mutex);
    }
  });
  const l1 = async (kind: AuthorityKind, template: string): Promise<MeasurementSummary> => repeat(async () => {
    const root = take(template, `l1-${kind}`);
    const authorized = await lineage.markResetLineageProvenance(root, {
      stream: NEXT_STREAM,
      stateNonce: NONCE,
      stateRevision: 0,
      lastSyncedSequence: 0,
      lastSyncedManifest: { generatedAt: "", files: [] },
      repoRecords: {},
    });
    if (!lineage.stateWasStreamMismatch(authorized)) throw new Error(`${kind} L1 fixture lacks reset provenance`);
    return measured(async () => {
      const saved = await syncState.saveStateSource(root, authorized, {
        expectedStream: NEXT_STREAM,
        sourceGlobalSeq: 0,
        observedRepos: [],
        values: {},
      }, { allowLegacyStreamReplacement: true });
      if (saved.stream !== NEXT_STREAM) throw new Error(`${kind} L1 did not replace the stream`);
    });
  });

  try {
    // Run every JSON row before constructing or importing the SQLite fixtures.
    // A lazy-graph regression now evaluates open.ts inside the measured JSON row
    // and is visible as a non-zero sqliteModuleEvaluations counter.
    const jsonP1 = await p1("json", fixtures.json);
    const jsonS0 = await standing("json", fixtures.json);
    const jsonL1 = await l1("json", fixtures.jsonL1);
    const qFixtures = await makeSqliteFixtures(repo, fixtures.parent);
    const qP1 = await p1("q", qFixtures.q);
    const qS1 = await standing("q", qFixtures.q);
    const qW1 = await w1(qFixtures.q);
    const qL1 = await l1("q", qFixtures.qL1);
    if (qP1.storeReads.stateProjection !== 1) {
      throw new Error(`P1(Q) projected whole state ${qP1.storeReads.stateProjection} times, expected exactly once`);
    }
    if (qL1.storeReads.stateProjection !== 1) {
      throw new Error(`L1(Q) projected whole state ${qL1.storeReads.stateProjection} times, expected exactly once`);
    }
    if (qW1.storeReads.recoveryLineageSql !== 1) {
      throw new Error(`W1(Q) performed ${qW1.storeReads.recoveryLineageSql} direct lineage reads, expected exactly one`);
    }
    const result = {
      version: 2,
      design: 265,
      samples,
      repo,
      bun: Bun.version,
      host: `${os.platform()}-${os.arch()} ${os.cpus()[0]?.model ?? "unknown-cpu"}`,
      sqliteEvaluationsBeforeJsonRows,
      operations: {
        P1: { json: jsonP1, q: qP1 },
        S0: { json: jsonS0 },
        S1: { q: qS1 },
        W1: { q: qW1 },
        L1: { json: jsonL1, q: qL1 },
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    fs.rmSync(fixtures.parent, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--dirty-wal") {
  const file = process.argv[3];
  if (!file) throw new Error("missing W1 database path");
  const { Database } = await import("bun:sqlite");
  const db = new Database(file, { create: false, readwrite: true });
  db.exec("UPDATE state_lineage SET telemetry_binding_id='deadc0dedeadc0de'");
  process.kill(process.pid, "SIGKILL");
} else {
  await main();
}
