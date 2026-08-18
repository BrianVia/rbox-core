/**
 * Design 277's future-proofing gate.
 *
 * The memo skips a materialization when the store's lineage token still matches
 * the retained one. That is only sound while EVERY production mutation of a
 * table `loadRawStateFromStore` projects either bumps a probed token in the same
 * transaction, establishes the authority/lineage itself, or is the one
 * deliberately non-CAS writer the probe covers by name.
 *
 * A `state_lineage` UPDATE grep would not prove that — it would miss a direct
 * `repo_records`, BASE-plane, or manifest-chain write that forgot to bump. So
 * this audit enumerates the statements PER FUNCTION and pins each function's
 * production callers, because the same helper can be safe under one caller and
 * unsafe under another (`promoteFilesIntoPlane` is plane-parameterized: BASE
 * from the CAS transaction, LOCAL from a transaction that bumps nothing).
 *
 * NAMED LIMITATIONS — this audit is a tripwire, not a proof:
 *  - table names are matched literally; a statement built from a template
 *    literal whose table is interpolated is invisible to it (the temp-table
 *    helpers in `plane-promotion.ts` are the existing example, and they only
 *    ever name temp tables);
 *  - "the caller bumps the revision" is checked structurally (the caller is the
 *    CAS writer, or is itself allowlisted as such), not by proving one SQLite
 *    transaction encloses both statements;
 *  - callers are found by identifier occurrence across the state plane, so a
 *    dynamically dispatched call would not be seen.
 * Each of those failure modes leaves the token comparison itself intact — a
 * missed bump makes a load stale, which is exactly what the fleet-facing kill
 * switch `RBOX_STATE_LOAD_CACHE=0` exists to undo.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const STATE_PLANE = path.resolve(import.meta.dir, "..");

/** Every table `loadRawStateFromStore` projects (adapters/read-only.ts through
 * store/read-snapshot.ts). Tables outside this set cannot change what a
 * materialization returns, so they need no entry. */
const MATERIALIZED_TABLES = new Set([
  "store_meta",
  "state_lineage",
  "plane_heads",
  "plane_entries",
  "entry_values",
  "repo_records",
  "global_manifest_meta",
  "manifest_chain",
  "manifest_git_sections",
  "migration_completion",
]);

type Coverage =
  /** Runs inside the CAS transaction that bumps `state_revision`. */
  | "revision-bump"
  /** Establishes or replaces the authority/lineage itself. */
  | "lineage-genesis"
  /** The deliberately non-CAS telemetry writer — probed by name. */
  | "telemetry-probe"
  /** Touches LOCAL-plane rows only. `SyncState` materializes the BASE plane;
   *  `local_revision` is explicitly exempt (design 277 §A2). */
  | "local-plane"
  /** No production caller: reachable only as a facade export. */
  | "unreachable"
  /** A crash rig, never linked into a shipped command path. */
  | "test-rig";

interface Mutator {
  /** Statements on materialized tables, in source order, inside this function. */
  statements: readonly string[];
  /** Every production file that names this function, with how the probe covers
   *  the mutation under that caller. `<module-private>` means the function is
   *  not exported, so its only callers are inside its own module. */
  callers: readonly { file: string; coverage: Coverage; why: string }[];
}

const CAS_WRITER = "store/write-packet.ts";

const ALLOWLIST: ReadonlyMap<string, Mutator> = new Map([
  ["schema/application.ts::installGenesisLineage", {
    statements: ["INSERT state_lineage", "INSERT store_meta", "INSERT plane_heads", "INSERT migration_completion"],
    callers: [
      { file: "genesis.ts", coverage: "lineage-genesis", why: "genesis creates the very lineage a token is later read from" },
      { file: "store/open.ts", coverage: "lineage-genesis", why: "store creation installs the lineage before anything can retain it" },
    ],
  }],
  ["store/write-packet.ts::runTransaction", {
    statements: ["UPDATE state_lineage", "UPDATE state_lineage"],
    callers: [{ file: "<module-private>", coverage: "revision-bump", why: "the bump itself: nonce, revision and sequence move in one transaction" }],
  }],
  ["store/write-packet.ts::ensureStoreTelemetryBindingId", {
    statements: ["UPDATE state_lineage"],
    callers: [
      { file: "adapters/whole-state-compat.ts", coverage: "telemetry-probe", why: "non-CAS by design, which is why telemetry_binding_id is one of the probed columns" },
      { file: "store-facade.ts", coverage: "telemetry-probe", why: "the facade re-export of that same writer, probed by the same column" },
    ],
  }],
  ["store/cas-steps.ts::applyGlobal", {
    statements: [
      "UPDATE plane_heads", "UPDATE state_lineage", "DELETE manifest_chain", "DELETE global_manifest_meta",
      "DELETE manifest_git_sections", "INSERT global_manifest_meta", "INSERT manifest_chain", "INSERT manifest_git_sections",
    ],
    callers: [{ file: "store/write-packet.ts", coverage: "revision-bump", why: "the CAS writer's own generation step, inside its transaction" }],
  }],
  ["store/cas-steps.ts::applyTransitions", {
    statements: ["INSERT repo_records"],
    callers: [{ file: "store/write-packet.ts", coverage: "revision-bump", why: "repo-record transitions inside the CAS writer's transaction" }],
  }],
  ["store/cas-steps.ts::rebuildManifestProjection", {
    statements: ["DELETE manifest_git_sections", "INSERT manifest_git_sections"],
    callers: [{ file: "store/write-packet.ts", coverage: "revision-bump", why: "meta git-section replacement inside the CAS writer's transaction" }],
  }],
  ["store/plane-promotion.ts::internStagedEntryValues", {
    statements: ["INSERT entry_values"],
    callers: [
      { file: "store/cas-steps.ts", coverage: "revision-bump", why: "BASE interning inside the CAS writer's transaction" },
      { file: "store/local-plane.ts", coverage: "local-plane", why: "interning only ADDS values; a BASE projection reaches values through BASE plane_entries, which a LOCAL promotion never writes" },
    ],
  }],
  ["store/plane-promotion.ts::promoteFilesIntoPlane", {
    statements: ["DELETE plane_entries", "INSERT plane_entries"],
    callers: [
      { file: "store/cas-steps.ts", coverage: "revision-bump", why: "promotes the BASE plane inside the CAS writer's transaction" },
      { file: "store/local-plane.ts", coverage: "local-plane", why: "promotes plane='local' in local-plane's OWN BEGIN IMMEDIATE with no revision bump; LOCAL rows are not part of the SyncState projection" },
    ],
  }],
  ["store/plane-promotion.ts::applyDeltaOpsIntoPlane", {
    statements: ["DELETE plane_entries", "INSERT plane_entries"],
    callers: [{ file: "store/cas-steps.ts", coverage: "revision-bump", why: "delta application into BASE inside the CAS writer's transaction" }],
  }],
  ["store/plane-promotion.ts::collectUnreferencedEntryValues", {
    statements: ["DELETE entry_values"],
    callers: [{ file: "store-facade.ts", coverage: "unreachable", why: "no production caller — the facade re-exports it and nothing calls it. A caller must re-classify: deleting a value a BASE projection still reaches WOULD change materialization" }],
  }],
  ["store/local-plane.ts::promote", {
    statements: ["UPDATE plane_heads"],
    callers: [{ file: "<module-private>", coverage: "local-plane", why: "writes the LOCAL head, whose generation IS local_revision — explicitly exempt from the projection" }],
  }],
  ["store/local-plane.ts::invalidateLocalPlane", {
    statements: ["UPDATE plane_heads"],
    callers: [{ file: "store-facade.ts", coverage: "local-plane", why: "watcher invalidation bumps the LOCAL head only, never the BASE plane" }],
  }],
  ["reset/crash-rig-child.ts::zFixture", {
    statements: ["UPDATE state_lineage"],
    callers: [{ file: "<module-private>", coverage: "test-rig", why: "the crash rig's child process, never linked into a shipped command path" }],
  }],
]);

const STATEMENT = /(INSERT\s+(?:OR\s+REPLACE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi;
const FUNCTION_HEAD = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/;

function productionSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(full);
    if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) return [];
    return [full];
  });
}

/** Statements on materialized tables, keyed `file::enclosing-function`. */
function observedMutators(): Map<string, string[]> {
  const observed = new Map<string, string[]>();
  for (const file of productionSources(STATE_PLANE)) {
    const relative = path.relative(STATE_PLANE, file);
    if (relative === "schema/v1.ts") continue; // the DDL itself, including triggers
    let owner = "<module>";
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const head = FUNCTION_HEAD.exec(line);
      if (head) owner = head[1]!;
      for (const match of line.matchAll(STATEMENT)) {
        const table = match[2]!.toLowerCase();
        if (!MATERIALIZED_TABLES.has(table)) continue;
        const verb = match[1]!.toUpperCase().startsWith("INSERT") ? "INSERT"
          : match[1]!.toUpperCase().startsWith("UPDATE") ? "UPDATE" : "DELETE";
        const key = `${relative}::${owner}`;
        observed.set(key, [...(observed.get(key) ?? []), `${verb} ${table}`]);
      }
    }
  }
  return observed;
}

/** Comments name functions all the time; only code counts as a caller. */
function code(file: string): string {
  return fs.readFileSync(path.join(STATE_PLANE, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
}

/** Production files in the state plane that name this function. A function the
 * module does not export cannot be called from outside it. */
function callersOf(functionName: string, definedIn: string): string[] {
  if (!new RegExp(`export\\s+(?:async\\s+)?function\\s+${functionName}\\b`).test(code(definedIn))) {
    return ["<module-private>"];
  }
  const identifier = new RegExp(`\\b${functionName}\\b`);
  return productionSources(STATE_PLANE)
    .map((file) => path.relative(STATE_PLANE, file))
    .filter((file) => file !== definedIn && identifier.test(code(file)))
    .sort();
}

test("277: every mutator of materialized state is enumerated per function", () => {
  const observed = observedMutators();
  const declared = new Map([...ALLOWLIST].map(([key, mutator]) => [key, [...mutator.statements]]));
  expect(
    Object.fromEntries([...observed].sort()),
    "a production statement mutates state the memo's token comparison claims to cover. Either bump a probed token in "
    + "the same transaction, change the active authority/lineage, or record it here with the reason it is safe.",
  ).toEqual(Object.fromEntries([...declared].sort()));
});

test("277: every allowlisted function's production callers are the ones it claims", () => {
  for (const [key, mutator] of ALLOWLIST) {
    const [file, functionName] = key.split("::") as [string, string];
    const declared = mutator.callers.map((caller) => caller.file).sort();
    expect(callersOf(functionName, file), `${key}: its callers moved — re-derive how the probe covers each one`)
      .toEqual(declared);
  }
});

test("277: a revision-bump claim names a caller that is (or reaches) the CAS writer", () => {
  const writer = code(CAS_WRITER);
  // The bump the whole scheme rests on, at its one owner.
  expect(writer).toMatch(/UPDATE state_lineage SET[^`]*state_revision/);
  for (const [key, mutator] of ALLOWLIST) {
    for (const caller of mutator.callers) {
      if (caller.coverage !== "revision-bump") continue;
      const reaches = caller.file === "<module-private>"
        ? key.startsWith(CAS_WRITER)
        : caller.file === CAS_WRITER || [...ALLOWLIST.keys()].some((other) => other.startsWith(`${caller.file}::`));
      expect(reaches, `${key}: claims revision-bump coverage under ${caller.file}, which is not the CAS writer or an allowlisted step`).toBe(true);
    }
  }
});

const LOCAL_MODULE = "store/local-plane.ts";

test("277: a local-plane claim belongs to the LOCAL module, which never names the base plane", () => {
  // The claim is "this mutation only touches LOCAL rows". Its mechanical
  // evidence: the mutation is defined in, or reached from, the module whose
  // whole job is the LOCAL plane — and that module never names the other one.
  expect(code(LOCAL_MODULE), `${LOCAL_MODULE} now names the base plane; LOCAL-plane exemptions are no longer safe`)
    .not.toMatch(/["']base["']/);
  for (const [key, mutator] of ALLOWLIST) {
    for (const caller of mutator.callers) {
      if (caller.coverage !== "local-plane") continue;
      const local = caller.file === LOCAL_MODULE || key.startsWith(`${LOCAL_MODULE}::`);
      expect(local, `${key}: claims LOCAL-plane coverage under ${caller.file}, which is not the LOCAL module`).toBe(true);
    }
  }
});

test("277: every caller claim records a reason", () => {
  for (const [key, mutator] of ALLOWLIST) {
    for (const caller of mutator.callers) {
      expect(caller.why.length, `${key} (${caller.file}) has no reason`).toBeGreaterThan(30);
    }
  }
});
