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
import { runAstSweep } from "../sync-git/ast-sweep-runner.js";

const REPO = path.resolve(import.meta.dir, "../../..");
const SWEEP = path.join(import.meta.dir, "..", "sync-git", "base-composer-ast-sweep.mjs");
// 16,683 bytes when introduced; leave room for new guarded entry points. Raised
// to 28 KiB by U3 wave 4A, which enrolled `flipAuthority` — the one rename that
// elects SQLite — as an order-tracked owner, adding roughly 1 KiB of records.
// This is a transport bound on the sweep's stdout, not a policy on how many
// entry points may exist.
const AST_SWEEP_MAX_BYTES = 28 * 1024;

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
  { file: "src/cli/state-plane/adapters/legacy-json-store.ts", symbol: "loadRawLegacyJsonState", kind: "read", sites: 2, guards: ["assertStateReadable"] },
  { file: "src/cli/state-plane/adapters/legacy-json-store.ts", symbol: "loadLegacyJsonState", kind: "read", sites: 1, guards: ["loadRawLegacyJsonState"] },
  { file: "src/cli/doctor-state-plane.ts", symbol: "checkState", kind: "read", sites: 1, guards: ["loadRawLegacyJsonState"] },

  // The whole-state compatibility adapter (design 222 §1.2 A-2): one selection
  // from the document's bytes, and every backend-specific read or write behind
  // it. The refusals are file-level, so nothing here opens a database first.
  { file: "src/cli/state-plane/adapters/whole-state-compat.ts", symbol: "selectSqliteAuthority", kind: "read", sites: 2, guards: ["classifyStateFormat", "readAuthorityMarkerId"] },
  { file: "src/cli/state-plane/adapters/whole-state-compat.ts", symbol: "loadRawState", kind: "read", sites: 0, guards: ["selectSqliteAuthority", "openAuthorityStore"] },
  { file: "src/cli/state-plane/adapters/whole-state-compat.ts", symbol: "loadState", kind: "read", sites: 0, guards: ["selectSqliteAuthority", "recoverStandingResetJournal", "openAuthorityStore", "markResetLineageProvenance"] },
  { file: "src/cli/state-plane/locks.ts", symbol: "inspectInventory", kind: "read", sites: 1, guards: ["classifyStateFormat"] },
  { file: "src/cli/state-plane/migration/admission.ts", symbol: "barrierWitness", kind: "read", sites: 1, guards: ["verifyLastWriterWitness"] },
  // The migration classifier's sole reader of the document. It must handle the
  // marker rather than refuse it, so its guard is the classifier that decides
  // the format, not the barrier that throws on it.
  { file: "src/cli/state-plane/migration/artifact-observation.ts", symbol: "observeLegacyAuthority", kind: "read", sites: 3, guards: ["classifyStateFormat"] },

  // Writes — check the barrier immediately before the publishing rename, and
  // record the last-writer witness immediately after it.
  { file: "src/cli/state-plane/adapters/legacy-json-publication.ts", symbol: "publishWholeState", kind: "write", sites: 0, guards: ["assertStatePublishable"] },
  { file: "src/cli/state-plane/adapters/legacy-json-publication.ts", symbol: "afterStatePublication", kind: "write", sites: 0, guards: ["recordLastWriterWitness", "ensureStateReserve"] },
  { file: "src/cli/state-plane/adapters/legacy-json-store.ts", symbol: "applyLegacyJsonSavePacket", kind: "write", sites: 7, guards: ["assertStatePublishable", "afterStatePublication"] },
  // The SQLite save boundary: the lock, then the ONE write fence, then the
  // selection re-read under that lock, and only then a database open.
  { file: "src/cli/state-plane/adapters/whole-state-compat.ts", symbol: "applyStateSavePacket", kind: "write", sites: 0, guards: ["selectSqliteAuthority"] },
  { file: "src/cli/state-plane/adapters/whole-state-compat.ts", symbol: "saveThroughStore", kind: "write", sites: 2, guards: ["acquireLock", "assertAuthorityWritable", "selectSqliteAuthority", "openAuthorityStore"] },
  { file: "src/cli/state-plane/adapters/legacy-json-store.ts", symbol: "writeWholeStateUnsafe", kind: "write", sites: 2, guards: ["acquireLock", "publishWholeState", "afterStatePublication"] },
  { file: "src/cli/state-plane/adapters/legacy-json-store.ts", symbol: "ensureTelemetryBindingId", kind: "write", sites: 5, guards: ["assertStatePublishable", "afterStatePublication"] },

  // Reset entry points — the same obligations, plus the ones that republish the
  // state document by renaming a prepared candidate over it.
  { file: "src/cli/state-plane/adapters/legacy-json-store.ts", symbol: "installGenesisResetStateUnderHeldLock", kind: "reset", sites: 4, guards: ["publishWholeState", "afterStatePublication"] },
  { file: "src/cli/reset-journal.ts", symbol: "observePhysical", kind: "reset", sites: 0, guards: ["assertStateReadable"] },
  { file: "src/cli/reset-journal.ts", symbol: "recoverResetJournalUnderHeldFence", kind: "reset", sites: 8, guards: ["assertStateReadable", "isOwner", "recordLastWriterWitness"] },
  { file: "src/cli/reset-journal.ts", symbol: "inspectResetJournal", kind: "reset", sites: 1, guards: ["classifyStateFormat"] },
  { file: "src/cli/reset-journal.ts", symbol: "recoverResetJournal", kind: "reset", sites: 5, guards: ["classifyStateFormat", "recoverResetJournalUnderHeldFence"] },
  { file: "src/cli/reset-state.ts", symbol: "prepareResetArtifactsUnderFence", kind: "reset", sites: 3, guards: ["assertStateReadable"] },
  { file: "src/cli/reset-state.ts", symbol: "resetSyncState", kind: "reset", sites: 5, guards: ["loadRawState", "assertStateReadable"] },
  { file: "src/cli/reset-quarantine.ts", symbol: "restoreResetQuarantineUnderFence", kind: "reset", sites: 1, guards: ["assertStateReadable"] },
  { file: "src/cli/reset-journal-doctor.ts", symbol: "withResetJournalDoctorFence", kind: "reset", sites: 5, guards: ["classifyStateFormat", "assertStateReadable"] },
  { file: "src/cli/reset-journal-doctor.ts", symbol: "quarantineStandingJournal", kind: "reset", sites: 4, guards: ["withResetJournalDoctorFence"] },

  // Genesis (design 222 §2) — the only writer that publishes `Q` rather than a
  // legacy document. It never replaces an existing document: every path here
  // classifies first, and `finishWithQ` renames only over a re-confirmed absence.
  { file: "src/cli/state-plane/genesis.ts", symbol: "inspect", kind: "read", sites: 1, guards: ["classifyStateFormat"] },
  { file: "src/cli/state-plane/genesis.ts", symbol: "eligibility", kind: "read", sites: 1, guards: ["classifyStateFormat"] },
  { file: "src/cli/state-plane/genesis.ts", symbol: "resume", kind: "read", sites: 2, guards: ["classifyStateFormat", "holdsMarkerFor"] },
  { file: "src/cli/state-plane/genesis.ts", symbol: "finishWithQ", kind: "write", sites: 2, guards: ["classifyStateFormat", "fsp.rename"] },

  // Design 163's authority flip (M-6): the one rename in the product that
  // replaces a live legacy document with `Q`. Its barrier is deliberately not
  // `assertStatePublishable` — that guards a binary about to write legacy JSON,
  // and this is the writer publishing the marker that barrier exists to protect.
  // Its obligations instead are the sibling fence, the exact-sibling image, and
  // the re-read of the live body digest as the LAST thing before the rename.
  { file: "src/cli/state-plane/migration/authority-flip.ts", symbol: "flipAuthority", kind: "write", sites: 0, guards: ["requireSibling", "observeQSibling", "revalidateBackups", "revalidateActive", "cleanupCursor", "renameSync"] },
];

/** Access sites that neither read nor replace the document's contents. Each
 * needs a reason, because "it only names the path" is a claim the next reader of
 * this list has to be able to check. */
const EXEMPT: ReadonlyMap<string, { sites: number; reason: string }> = new Map([
  ["src/cli/state-plane/errors.ts::<module>", { sites: 1, reason: "StreamMismatchError renders the stable legacy authority path but never reads or writes it" }],
  ["src/cli/reset-journal.ts::activeStatePath", { sites: 1, reason: "the local state-path constructor itself" }],
  ["src/cli/reset-journal.ts::beginResetJournal", { sites: 2, reason: "hashes the caller-supplied prepared bytes and names the candidate path; the live document is read by its guarded caller under the same lock" }],
  ["src/cli/sync-git/p-settlement.ts::settleExactPresentArtifact", { sites: 4, reason: "uses statePath only to name the protocol lock class; the save itself is applyStateSavePacket" }],
  ["src/cli/state-plane/locks.ts::withStatePlaneLocks", { sites: 2, reason: "uses statePath only as the repository fence's state identity; the document is read by the guarded inspectInventory" }],
  ["src/cli/state-plane/migration/authority-flip.ts::completeFlip", { sites: 2, reason: "names `.rbox` only as the parent to fsync after the flip's rename; the document itself is replaced by flipAuthority, which is inventoried above" }],
  ["src/cli/scan-probe.ts::loadScanProbe", { sites: 2, reason: "a local statePath naming .rbox/state/scan-probe.json, not the state plane" }],
  ["src/cli/scan-probe.ts::saveScanProbe", { sites: 3, reason: "a local statePath naming .rbox/state/scan-probe.json, not the state plane" }],
]);

let cached: AstSite[] | undefined;
function astSites(): AstSite[] {
  if (cached) return cached;
  const result = runAstSweep(SWEEP, REPO, "state-plane-inventory");
  expect(result.stdoutLength, "AST sweep returned empty stdout").toBeGreaterThan(0);
  expect(result.stdoutLength, "AST sweep output exceeded its transport budget")
    .toBeLessThanOrEqual(AST_SWEEP_MAX_BYTES);
  const parsed = result.parsed;
  expect(Array.isArray(parsed), "AST sweep output was not an array").toBeTrue();
  expect(parsed.length, "AST sweep returned no records").toBeGreaterThan(0);
  cached = parsed as AstSite[];
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

/** Calls in lexical source order inside one enclosing function. */
function callsIn(file: string, owner: string): AstSite[] {
  return astSites()
    .filter((site) => site.category === "call" && site.file === file && site.owner === owner)
    .sort((left, right) => left.line - right.line);
}

function calleeMatches(site: AstSite, expected: string): boolean {
  const callee = site.callee ?? "";
  return callee === expected || callee.split(".").pop() === expected;
}

function requiredCall(file: string, owner: string, callee: string): AstSite {
  const site = callsIn(file, owner).find((candidate) => calleeMatches(candidate, callee));
  expect(site, `${file}:${owner} does not call ${callee}`).toBeDefined();
  return site!;
}

function requiredCallAfter(file: string, owner: string, callee: string, after: AstSite): AstSite {
  const site = callsIn(file, owner)
    .find((candidate) => candidate.line > after.line && calleeMatches(candidate, callee));
  expect(site, `${file}:${owner} does not call ${callee} after line ${after.line}`).toBeDefined();
  return site!;
}

function expectOrderedCalls(file: string, owner: string, callees: readonly string[]): void {
  const calls = callsIn(file, owner);
  let cursor = -1;
  for (const callee of callees) {
    const index = calls.findIndex((site, candidateIndex) =>
      candidateIndex > cursor && calleeMatches(site, callee));
    expect(index, `${file}:${owner} does not call ${callee} after ${callees[Math.max(0, callees.indexOf(callee) - 1)]}`)
      .toBeGreaterThan(cursor);
    cursor = index;
  }
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

  test("every enumerated entry point calls its barrier and witness obligations in order", () => {
    for (const entry of ENTRY_POINTS) {
      const calls = callsIn(entry.file, entry.symbol);
      expect(calls.length, `${entry.file}:${entry.symbol} was not found — the inventory is stale`).toBeGreaterThan(0);
      expectOrderedCalls(entry.file, entry.symbol, entry.guards);
    }
  });

  test("ordinary publication traverses the typed adapter in publication order", () => {
    for (const symbol of ["writeWholeStateUnsafe", "installGenesisResetStateUnderHeldLock"]) {
      expectOrderedCalls("src/cli/state-plane/adapters/legacy-json-store.ts", symbol, ["publishWholeState", "afterStatePublication"]);
    }

    const file = "src/cli/state-plane/adapters/legacy-json-publication.ts";
    const publish = requiredCall(file, "publishWholeState", "writeFileAtomic");
    const options = publish.arguments?.[2] ?? "";
    expect(options).toContain("beforeRename");
    expect(options).toContain("assertStatePublishable");
    expect(options).toContain("lock.isOwner");
    const stateParentSync = requiredCallAfter(file, "publishWholeState", "fsyncDirectory", publish);
    expect(stateParentSync.arguments?.[0]).toBe("path.dirname(file)");
    expectOrderedCalls(file, "publishWholeState", ["writeFileAtomic", "fsyncDirectory"]);
    expectOrderedCalls(file, "afterStatePublication", ["recordLastWriterWitness", "ensureStateReserve"]);
  });

  test("inline CAS publication proves its callback and post-publication order", () => {
    for (const symbol of ["applyLegacyJsonSavePacket", "ensureTelemetryBindingId"]) {
      const publish = requiredCall("src/cli/state-plane/adapters/legacy-json-store.ts", symbol, "writeFileAtomic");
      const options = publish.arguments?.[2] ?? "";
      expect(options).toContain("beforeRename");
      expect(options).toContain("assertStatePublishable");
      expect(options).toContain("isOwner");
      const stateParentSync = requiredCallAfter("src/cli/state-plane/adapters/legacy-json-store.ts", symbol, "fsyncDirectory", publish);
      expect(stateParentSync.arguments?.[0]).toBe("path.dirname(statePath(root))");
      expectOrderedCalls("src/cli/state-plane/adapters/legacy-json-store.ts", symbol, [
        "assertStatePublishable",
        "fsyncDirectory",
        "afterStatePublication",
      ]);
    }
  });

  test("reset byte-swap publication remains a separately ordered contract", () => {
    const file = "src/cli/reset-journal.ts";
    const owner = "recoverResetJournalUnderHeldFence";
    const calls = callsIn(file, owner);
    const renameIndex = calls.findIndex((site) => calleeMatches(site, "fs.rename"));
    const ownerIndex = calls.findLastIndex((site, index) => index < renameIndex && calleeMatches(site, "isOwner"));
    const readableIndex = calls.findLastIndex((site, index) => index < renameIndex && calleeMatches(site, "assertStateReadable"));
    const stateParentSyncIndex = calls.findIndex((site, index) => index > renameIndex && calleeMatches(site, "fsyncDirectory"));
    expect(ownerIndex).toBeGreaterThan(-1);
    expect(readableIndex).toBeGreaterThan(ownerIndex);
    expect(renameIndex).toBeGreaterThan(readableIndex);
    expect(stateParentSyncIndex).toBeGreaterThan(renameIndex);
    expect(calls[stateParentSyncIndex]?.arguments?.[0]).toBe("activeParent");
    expectOrderedCalls(file, owner, ["fs.rename", "fsyncDirectory", "recordLastWriterWitness"]);
  });

  // 222 §2.4: a resume that rebuilt from step 4 with caller-supplied ids would
  // install values §2.5.1 can never satisfy, live-locking a HEALTHY workspace
  // into a permanent halt on every retry. The intent is the sole source.
  test("installGenesisLineage's only genesis caller derives its ids from the intent", async () => {
    const genesis = await fs.readFile(path.join(REPO, "src/cli/state-plane/genesis.ts"), "utf8");

    expect(genesis.split("installGenesisLineage(").length - 1, "genesis.ts must install a lineage exactly once").toBe(1);
    const call = genesis.slice(genesis.indexOf("installGenesisLineage("));
    const argument = call.slice(0, call.indexOf("})") + 1);
    for (const binding of ["stream: intent.evidence.stream", "authorityId: intent.authorityId", "lineageId: intent.lineageId"]) {
      expect(argument, `the installed lineage must come from the intent, not a caller: ${binding}`).toContain(binding);
    }

    expect(genesis.split("mintIds()").length - 1, "the id thunk must be called from exactly one place").toBe(1);
    expect(
      genesis.slice(genesis.indexOf("async function resume(")).split("\n}")[0],
      "resume must never mint ids — only §2.5.2 case 4 does, by returning to establish",
    ).not.toContain("mintIds");
  });

  test("the barrier module is the only thing that recognizes the marker bytes", async () => {
    const offenders: string[] = [];
    for (const site of astSites()) {
      if (site.file.endsWith("state-plane/authority-marker.ts")) continue;
      if ((site.arguments ?? []).some((argument) => argument.includes("RBOX-SQLITE-AUTHORITY"))) offenders.push(site.file);
    }
    const barrier = await fs.readFile(path.join(REPO, "src/cli/state-plane/authority-marker.ts"), "utf8");
    expect(barrier).toContain("RBOX-SQLITE-AUTHORITY-v1");
    expect(offenders, "the marker literal must live only in state-plane/authority-marker.ts").toEqual([]);
  });

  test("the barrier read classifies from one no-follow descriptor", () => {
    const file = "src/cli/state-plane/authority-marker.ts";
    const calls = callsIn(file, "classifyStateFormat");

    const opens = calls.filter((site) => calleeMatches(site, "fs.open"));
    expect(opens.length, "classifyStateFormat must take exactly one descriptor").toBe(1);
    for (const open of opens) {
      expect(
        open.arguments?.[1] ?? "",
        "classifyStateFormat must open the state path with O_NOFOLLOW, or a symlink swapped in at the path is read as the document",
      ).toContain("O_NOFOLLOW");
    }

    // Type, size, and bytes must all come from that descriptor.
    for (const callee of ["handle.stat", "handle.read"]) requiredCall(file, "classifyStateFormat", callee);

    // The AST sweep records calls per enclosing function, not per enclosing
    // `catch`, so the one permitted pathname lookup — classifying an ELOOP that
    // O_NOFOLLOW raised — is pinned by living alone in `isSymbolicLinkAtPath`,
    // whose whole body is checked below. Nothing else here may name the path.
    const pathnameApis = ["fs.lstat", "fs.stat", "fs.readFile", "fs.readlink", "fs.opendir", "fs.access", "fs.realpath"];
    const pathLookups = calls.filter((site) => pathnameApis.some((callee) => calleeMatches(site, callee)));
    expect(
      pathLookups.map((site) => `${site.callee}:${site.line}`),
      "the classification must be decided from the descriptor, not from a second pathname lookup",
    ).toEqual([]);

    expect(
      callsIn(file, "isSymbolicLinkAtPath").map((site) => site.callee),
      "the permitted lstat must only classify — a read through it would reopen the swap window",
    ).toEqual(["(await fs.lstat(file)).isSymbolicLink", "fs.lstat"]);
  });

  test("every exemption states a reason", () => {
    for (const [id, { reason }] of EXEMPT) expect(reason.length, id).toBeGreaterThan(20);
  });
});
