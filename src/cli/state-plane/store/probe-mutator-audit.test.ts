/**
 * Design 277 §A2's future-proofing gate.
 *
 * The freshness probe reads four lineage tokens and concludes that a state
 * carrying them is the state the store holds. That conclusion is only as good
 * as this claim: EVERY production mutation of a table `loadRawStateFromStore`
 * projects either bumps a probed token in the same transaction, establishes the
 * authority/lineage itself, or is the one deliberately non-CAS writer the probe
 * covers by name.
 *
 * A `state_lineage` UPDATE grep would not prove that — it would miss a direct
 * `repo_records`, BASE-plane, or manifest-chain write that forgot to bump. So
 * this audit enumerates the statements instead, and a new one fails here until
 * somebody records which of those three it is.
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

type Category =
  /** Runs inside a CAS transaction that bumps `state_revision` (write-packet.ts
   *  :296/:302) — the probe sees the bump. */
  | "revision-bump"
  /** Establishes or replaces the authority/lineage itself, which changes
   *  `active_lineage_id` (or creates the store). */
  | "lineage-genesis"
  /** The deliberately non-CAS telemetry writer — probed by name. */
  | "telemetry-probe"
  /** LOCAL plane only. `SyncState` materializes the BASE plane; the local head
   *  is `local_revision`, explicitly exempt (design 277 §A2). */
  | "local-plane"
  /** A crash rig, never linked into a shipped command path. */
  | "test-rig";

interface Mutator { statement: string; category: Category; why: string }

/** file → the mutations it performs on materialized tables. */
const ALLOWLIST: ReadonlyMap<string, readonly Mutator[]> = new Map([
  ["schema/application.ts", [
    { statement: "INSERT state_lineage", category: "lineage-genesis", why: "genesis creates the lineage the probe reads" },
    { statement: "INSERT store_meta", category: "lineage-genesis", why: "genesis names the active lineage" },
    { statement: "INSERT plane_heads", category: "lineage-genesis", why: "genesis seeds both plane heads" },
    { statement: "INSERT migration_completion", category: "lineage-genesis", why: "genesis records the origin shape" },
  ]],
  ["migration/import-install.ts", [
    { statement: "INSERT entry_values", category: "lineage-genesis", why: "the import installs a NEW lineage; nothing may read it before store_meta names it" },
    { statement: "INSERT plane_entries", category: "lineage-genesis", why: "runs in the same new-lineage install transaction" },
    { statement: "INSERT repo_records", category: "lineage-genesis", why: "runs in the same new-lineage install transaction" },
    { statement: "INSERT global_manifest_meta", category: "lineage-genesis", why: "runs in the same new-lineage install transaction" },
    { statement: "INSERT manifest_chain", category: "lineage-genesis", why: "runs in the same new-lineage install transaction" },
    { statement: "INSERT manifest_git_sections", category: "lineage-genesis", why: "runs in the same new-lineage install transaction" },
    { statement: "INSERT state_lineage", category: "lineage-genesis", why: "the installed lineage id is new by construction" },
    { statement: "INSERT store_meta", category: "lineage-genesis", why: "publishes the new active_lineage_id" },
    { statement: "INSERT plane_heads", category: "lineage-genesis", why: "runs in the same new-lineage install transaction" },
    { statement: "INSERT migration_completion", category: "lineage-genesis", why: "runs in the same new-lineage install transaction" },
  ]],
  ["store/write-packet.ts", [
    { statement: "UPDATE state_lineage", category: "revision-bump", why: "the CAS bump itself: nonce, revision, and sequence move together" },
    { statement: "UPDATE state_lineage", category: "revision-bump", why: "the elided-packet bump, still a revision move" },
    { statement: "UPDATE state_lineage", category: "telemetry-probe", why: "ensureStoreTelemetryBindingId: non-CAS by design, which is why telemetry_binding_id is a probed column" },
  ]],
  ["store/cas-steps.ts", [
    { statement: "UPDATE plane_heads", category: "revision-bump", why: "base head advance inside the CAS transaction" },
    { statement: "UPDATE state_lineage", category: "revision-bump", why: "active_base_generation rides the revision-bumping transaction" },
    { statement: "DELETE manifest_chain", category: "revision-bump", why: "runs inside the revision-bumping CAS transaction" },
    { statement: "DELETE global_manifest_meta", category: "revision-bump", why: "runs inside the revision-bumping CAS transaction" },
    { statement: "DELETE manifest_git_sections", category: "revision-bump", why: "runs inside the revision-bumping CAS transaction" },
    { statement: "INSERT global_manifest_meta", category: "revision-bump", why: "runs inside the revision-bumping CAS transaction" },
    { statement: "INSERT manifest_chain", category: "revision-bump", why: "runs inside the revision-bumping CAS transaction" },
    { statement: "INSERT manifest_git_sections", category: "revision-bump", why: "runs inside the revision-bumping CAS transaction" },
    { statement: "INSERT repo_records", category: "revision-bump", why: "runs inside the revision-bumping CAS transaction" },
    { statement: "DELETE manifest_git_sections", category: "revision-bump", why: "meta git-section replacement, inside the CAS transaction" },
    { statement: "INSERT manifest_git_sections", category: "revision-bump", why: "meta git-section replacement, inside the CAS transaction" },
  ]],
  ["store/plane-promotion.ts", [
    { statement: "INSERT entry_values", category: "revision-bump", why: "promotion runs only inside a CAS generation transaction" },
    { statement: "DELETE plane_entries", category: "revision-bump", why: "runs in the same CAS generation transaction as the bump" },
    { statement: "INSERT plane_entries", category: "revision-bump", why: "runs in the same CAS generation transaction as the bump" },
    { statement: "DELETE plane_entries", category: "revision-bump", why: "runs in the same CAS generation transaction as the bump" },
    { statement: "INSERT plane_entries", category: "revision-bump", why: "runs in the same CAS generation transaction as the bump" },
    { statement: "DELETE entry_values", category: "revision-bump", why: "unreferenced-value collection, same transaction" },
  ]],
  ["store/local-plane.ts", [
    { statement: "UPDATE plane_heads", category: "local-plane", why: "the LOCAL head; SyncState materializes BASE" },
    { statement: "UPDATE plane_heads", category: "local-plane", why: "local-plane invalidation" },
  ]],
  ["reset/crash-rig-child.ts", [
    { statement: "UPDATE state_lineage", category: "test-rig", why: "the crash rig's child process, never a shipped command path" },
  ]],
]);

const STATEMENT = /(INSERT\s+(?:OR\s+REPLACE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi;

function productionSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(full);
    if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) return [];
    return [full];
  });
}

/** Every mutation of a materialized table, in source order, as `file` → list. */
function observedMutators(): Map<string, string[]> {
  const observed = new Map<string, string[]>();
  for (const file of productionSources(STATE_PLANE)) {
    const relative = path.relative(STATE_PLANE, file);
    if (relative === "schema/v1.ts") continue; // the DDL itself, including triggers
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(STATEMENT)) {
      const table = match[2]!.toLowerCase();
      if (!MATERIALIZED_TABLES.has(table)) continue;
      const verb = match[1]!.toUpperCase().startsWith("INSERT") ? "INSERT"
        : match[1]!.toUpperCase().startsWith("UPDATE") ? "UPDATE" : "DELETE";
      const list = observed.get(relative) ?? [];
      list.push(`${verb} ${table}`);
      observed.set(relative, list);
    }
  }
  return observed;
}

test("277 A2: every mutator of materialized state is probe-covered", () => {
  const observed = observedMutators();
  const declared = new Map([...ALLOWLIST].map(([file, mutators]) => [file, mutators.map((entry) => entry.statement)]));
  expect(
    Object.fromEntries([...observed].sort()),
    "a production statement mutates state the freshness probe claims to cover. Either bump a probed token in the same "
    + "transaction, change the active authority/lineage, or record it here with the reason it is safe.",
  ).toEqual(Object.fromEntries([...declared].sort()));
});

test("277 A2: the allowlist's revision-bump claim is backed by an actual bump", () => {
  const bumpingFiles = new Set<string>();
  for (const [file, mutators] of ALLOWLIST) {
    if (mutators.some((entry) => entry.category === "revision-bump")) bumpingFiles.add(file);
  }
  // Every revision-bump module either performs the bump itself or is reached
  // exclusively from the packet writer that does.
  const writer = fs.readFileSync(path.join(STATE_PLANE, "store/write-packet.ts"), "utf8");
  expect(writer).toContain("state_revision");
  for (const file of bumpingFiles) {
    const source = fs.readFileSync(path.join(STATE_PLANE, file), "utf8");
    const bumpsItself = source.includes("state_revision");
    const reachedFromWriter = writer.includes(path.basename(file, ".ts"));
    expect(bumpsItself || reachedFromWriter, `${file} claims revision-bump coverage but neither bumps nor is reached from write-packet.ts`).toBe(true);
  }
});

test("277 A2: every allowlist entry records a reason", () => {
  for (const [file, mutators] of ALLOWLIST) {
    for (const entry of mutators) {
      expect(entry.why.length, `${file}:${entry.statement} has no reason`).toBeGreaterThan(20);
    }
  }
});
