/**
 * The pinning inventory test (design 163, unit B0, contents item 2).
 *
 * The barrier is only worth as much as its coverage: one new reader or writer of
 * `.rbox/state.json` that forgets the check reopens exactly the hole the barrier
 * exists to close, and nothing else in the build would notice.
 *
 * The pin is per ACCESS SITE, not per file. Every call in `src/**` whose
 * arguments construct or name the state path is enumerated from the TypeScript
 * AST and attributed to its enclosing function; the resulting table must match
 * this file exactly. Adding an access to a function that is already inventoried
 * — or to one that is exempt — changes the table and fails here. Guards are
 * likewise checked as real calls in the enclosing function, so a mention in a
 * comment or a string proves nothing.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");
const SWEEP = path.join(import.meta.dir, "sync-git", "base-composer-ast-sweep.mjs");

/** Text that constructs or names `.rbox/state.json`. */
const STATE_PATH_ARGUMENT = /\bstatePath\(|\bactiveStatePath\(|["']state\.json["']/;

interface AstSite {
  category: string;
  callee?: string;
  arguments?: string[];
  file: string;
  line: number;
  owner: string;
}

interface EntryPoint {
  file: string;
  /** Enclosing function of the access sites. */
  symbol: string;
  kind: "read" | "write" | "reset";
  /** Access sites attributed to this function. */
  sites: number;
  /** Functions this one must call: a barrier check, a witness update, or an
   * already-guarded reader it delegates its recognition to. */
  guards: string[];
}

const ENTRY_POINTS: readonly EntryPoint[] = [
  // Reads — refuse a state plane written by a newer rbox instead of guessing.
  { file: "src/cli/sync-state-store.ts", symbol: "loadRawState", kind: "read", sites: 2, guards: ["assertStateReadable"] },
  { file: "src/cli/sync-state-store.ts", symbol: "loadState", kind: "read", sites: 1, guards: ["loadRawState"] },
  { file: "src/cli/doctor-cmd.ts", symbol: "checkState", kind: "read", sites: 1, guards: ["loadRawState"] },

  // Writes — check the barrier immediately before the publishing rename, and
  // record the last-writer witness immediately after it.
  { file: "src/cli/state-publish.ts", symbol: "publishWholeState", kind: "write", sites: 0, guards: ["assertStatePublishable"] },
  { file: "src/cli/state-publish.ts", symbol: "afterStatePublication", kind: "write", sites: 0, guards: ["recordLastWriterWitness", "ensureStateReserve"] },
  { file: "src/cli/sync-state-store.ts", symbol: "applyStateSavePacket", kind: "write", sites: 7, guards: ["assertStatePublishable", "afterStatePublication"] },
  { file: "src/cli/sync-state-store.ts", symbol: "writeWholeStateUnsafe", kind: "write", sites: 2, guards: ["acquireLock", "publishWholeState", "afterStatePublication"] },
  { file: "src/cli/sync-state-store.ts", symbol: "ensureTelemetryBindingId", kind: "write", sites: 5, guards: ["assertStatePublishable", "afterStatePublication"] },

  // Reset entry points — the same obligations, plus the ones that republish the
  // state document by renaming a prepared candidate over it.
  { file: "src/cli/sync-state-store.ts", symbol: "installGenesisResetStateUnderHeldLock", kind: "reset", sites: 4, guards: ["publishWholeState", "afterStatePublication"] },
  { file: "src/cli/reset-journal.ts", symbol: "observePhysical", kind: "reset", sites: 0, guards: ["assertStateReadable"] },
  { file: "src/cli/reset-journal.ts", symbol: "recoverResetJournalUnderHeldFence", kind: "reset", sites: 8, guards: ["assertStateReadable", "recordLastWriterWitness", "isOwner"] },
  { file: "src/cli/reset-journal.ts", symbol: "recoverResetJournal", kind: "reset", sites: 3, guards: ["recoverResetJournalUnderHeldFence"] },
  { file: "src/cli/reset-state.ts", symbol: "prepareResetArtifactsUnderFence", kind: "reset", sites: 3, guards: ["assertStateReadable"] },
  { file: "src/cli/reset-state.ts", symbol: "resetSyncState", kind: "reset", sites: 5, guards: ["loadRawState", "assertStateReadable"] },
  { file: "src/cli/reset-quarantine.ts", symbol: "restoreResetQuarantineUnderFence", kind: "reset", sites: 4, guards: ["assertStateReadable"] },
  { file: "src/cli/reset-journal-doctor.ts", symbol: "withResetJournalDoctorFence", kind: "reset", sites: 3, guards: ["assertStateReadable"] },
  { file: "src/cli/reset-journal-doctor.ts", symbol: "quarantineStandingJournal", kind: "reset", sites: 4, guards: ["withResetJournalDoctorFence"] },
];

/** Access sites that neither read nor replace the document's contents. Each
 * needs a reason, because "it only names the path" is a claim the next reader of
 * this list has to be able to check. */
const EXEMPT: ReadonlyMap<string, { sites: number; reason: string }> = new Map([
  ["src/cli/sync-state-store.ts::<module>", { sites: 1, reason: "the statePath constructor itself" }],
  ["src/cli/reset-journal.ts::activeStatePath", { sites: 1, reason: "the local state-path constructor itself" }],
  ["src/cli/reset-journal.ts::beginResetJournal", { sites: 2, reason: "hashes the caller-supplied prepared bytes and names the candidate path; the live document is read by its guarded caller under the same lock" }],
  ["src/cli/sync-git/p-settlement.ts::settleExactPresentArtifact", { sites: 4, reason: "uses statePath only to name the protocol lock class; the save itself is applyStateSavePacket" }],
  ["src/cli/scan-probe.ts::loadScanProbe", { sites: 2, reason: "a local statePath naming .rbox/state/scan-probe.json, not the state plane" }],
  ["src/cli/scan-probe.ts::saveScanProbe", { sites: 3, reason: "a local statePath naming .rbox/state/scan-probe.json, not the state plane" }],
]);

let cached: AstSite[] | undefined;
function astSites(): AstSite[] {
  if (cached) return cached;
  const result = Bun.spawnSync(["node", SWEEP, REPO]);
  if (!result.success) throw new Error(result.stderr.toString() || `AST sweep exited ${result.exitCode}`);
  cached = JSON.parse(result.stdout.toString()) as AstSite[];
  return cached;
}

const key = (file: string, owner: string) => `${file}::${owner}`;

/** Every access site of the state path, counted per enclosing function. */
function accessTable(): Map<string, number> {
  const table = new Map<string, number>();
  for (const site of astSites()) {
    if (site.category !== "call") continue;
    if (!(site.arguments ?? []).some((argument) => STATE_PATH_ARGUMENT.test(argument))) continue;
    const id = key(site.file, site.owner);
    table.set(id, (table.get(id) ?? 0) + 1);
  }
  return table;
}

/** The callees actually invoked inside one enclosing function. */
function calleesIn(file: string, owner: string): Set<string> {
  const out = new Set<string>();
  for (const site of astSites()) {
    if (site.category !== "call" || site.file !== file || site.owner !== owner) continue;
    const callee = site.callee ?? "";
    out.add(callee);
    // `lock.isOwner()` and `handle.stat()` are property calls; index the member
    // name too so a guard can be named without pinning the receiver.
    const member = callee.split(".").pop();
    if (member) out.add(member);
  }
  return out;
}

describe("state barrier pinning inventory", () => {
  test("the set of state-path access sites is exactly the inventory", () => {
    const expected = new Map<string, number>();
    for (const entry of ENTRY_POINTS) {
      if (entry.sites > 0) expected.set(key(entry.file, entry.symbol), entry.sites);
    }
    for (const [id, { sites }] of EXEMPT) expected.set(id, sites);
    expect(
      Object.fromEntries([...accessTable()].sort()),
      "a function reached .rbox/state.json a different number of times than the barrier inventory records; "
      + "add the barrier check and update ENTRY_POINTS (or, if the site never reads or replaces the document, EXEMPT with a reason)",
    ).toEqual(Object.fromEntries([...expected].sort()));
  });

  test("every enumerated entry point calls its barrier and witness obligations", () => {
    for (const entry of ENTRY_POINTS) {
      const callees = calleesIn(entry.file, entry.symbol);
      expect(callees.size, `${entry.file}:${entry.symbol} was not found — the inventory is stale`).toBeGreaterThan(0);
      for (const guard of entry.guards) {
        expect(
          callees.has(guard),
          `${entry.file}:${entry.symbol} (${entry.kind}) does not call its barrier obligation \`${guard}\``,
        ).toBe(true);
      }
    }
  });

  test("the barrier module is the only thing that recognizes the marker bytes", async () => {
    const offenders: string[] = [];
    for (const site of astSites()) {
      if (site.file.endsWith("state-barrier.ts")) continue;
      if ((site.arguments ?? []).some((argument) => argument.includes("RBOX-SQLITE-AUTHORITY"))) offenders.push(site.file);
    }
    const barrier = await fs.readFile(path.join(REPO, "src/cli/state-barrier.ts"), "utf8");
    expect(barrier).toContain("RBOX-SQLITE-AUTHORITY-v1");
    expect(offenders, "the marker literal must live only in state-barrier.ts").toEqual([]);
  });

  test("every exemption states a reason", () => {
    for (const [id, { reason }] of EXEMPT) expect(reason.length, id).toBeGreaterThan(20);
  });
});
