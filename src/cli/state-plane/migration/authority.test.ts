/**
 * Wave 5A's gates: the driver's structural obligations, the four retry buckets'
 * routing, and design 222 §7.9's inventory items that were prose until now.
 *
 * These are deliberately static and pure. The driver's end-to-end kill matrix
 * needs a real workspace with a live mutex, a held lock bundle, a legacy
 * document, and a config stream — the harness `finalize.test.ts` and
 * `cleanup.test.ts` already stand up per phase — and those fixtures belong beside
 * the phase bodies they interrupt. What is asserted here is the layer above: that
 * the dispatch table cannot route a stale witness member to its consumer, that a
 * halt cannot be routed to the wrong bucket, and that the inventory claims 222
 * wrote as prose now fail a test when they stop being true.
 */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MIGRATION_PHASES, type MigrationControl, type MigrationPhase } from "./control-codec.js";
import { ROW_DISPATCH, SQLITE_LIVE_ROWS } from "./authority.js";
import { classifyHaltBucket, type HaltBucket } from "./halt-recovery.js";

const HERE = import.meta.dir;
const REPO = path.resolve(HERE, "../../../..");
const DRIVER = path.join(HERE, "authority.ts");
const RECOVERY = path.join(HERE, "halt-recovery.ts");

const read = (file: string): string => fs.readFileSync(file, "utf8");

/** Which module owns each dispatched phase body. Written out rather than
 * discovered, so a body that MOVES is a failing test rather than a silently
 * skipped check. */
const BODY_HOME: Record<string, string> = {
  beginMigration: "begin.ts",
  provisionRunway: "begin.ts",
  preserveSource: "import-json.ts",
  claimStagingMain: "import-json.ts",
  importOwnedStaging: "import-json.ts",
  proveStaging: "prove-staging.ts",
  publishPreparedDatabase: "finalize.ts",
  stepQSibling: "finalize.ts",
  flipAuthority: "authority-flip.ts",
  armRetirement: "retirement.ts",
  stepRetirement: "retirement.ts",
  stepCleanup: "cleanup.ts",
  finishMigration: "cleanup.ts",
  stepFutureControlPreparation: "cleanup-runway.ts",
  completeFinalItem: "cleanup-runway.ts",
};

const DISPATCHED = [...new Set(Object.values(ROW_DISPATCH).flat())].sort();

/** The source text of one exported function, from its signature to the next
 * column-0 close brace. The same slice `authority-bootstrap.test.ts` uses for the
 * fence's callee whitelist. */
function bodyOf(name: string): string {
  const file = BODY_HOME[name];
  expect(file, `${name} has no recorded home module`).toBeDefined();
  const text = read(path.join(HERE, file!));
  const signature = new RegExp(`^export (async )?function ${name}\\(`, "m").exec(text);
  expect(signature, `${name} is not an exported function of ${file}`).not.toBeNull();
  return text.slice(signature!.index).split("\n}")[0]!;
}

// --- the driver's own structural obligations (§7.9, §M-9) -------------------

/**
 * §M-9 prints "no `node:fs`, `node:crypto`, or `bun:sqlite` in this module's
 * import graph". Taken transitively that is unimplementable — the driver's whole
 * job is sequencing bodies that open databases and rename files — so it is read
 * as §7.9 states it: `authority.ts` imports none of the three ITSELF. The
 * property being protected is that no syscall is written here, and a direct-import
 * ban is exactly what enforces that.
 */
test("neither the driver nor halt recovery names a filesystem, crypto, or SQLite primitive", () => {
  for (const file of [DRIVER, RECOVERY]) {
    const text = read(file);
    const name = path.basename(file);
    for (const module of ["node:fs", "node:crypto", "node:path", "bun:sqlite"]) {
      expect(text, `${name} must not import ${module}`).not.toContain(`"${module}"`);
    }
    // A grep for the module names alone would miss a global.
    for (const global of ["Bun.file", "Buffer.", "process.binding"]) {
      expect(text, `${name} must not reach ${global}`).not.toContain(global);
    }
  }
});

/** Exhaustiveness over the rows is the compiler's:
 * `satisfies Record<MigrationObservation["row"], …>` fails to build if a row is
 * missing or invented. What a test adds is that every NAME in the table resolves
 * to a real exported body — a typo there is a runtime `undefined` call, which
 * `satisfies` cannot see because the values are plain strings. */
test("every dispatch entry names a real exported phase body", () => {
  expect(Object.keys(ROW_DISPATCH).length).toBe(15);
  expect(DISPATCHED.length).toBeGreaterThan(10);
  for (const name of DISPATCHED) expect(bodyOf(name).length).toBeGreaterThan(0);
  // And the driver actually calls each one, so the table cannot drift into
  // documentation of a dispatch that no longer happens.
  const text = read(DRIVER);
  for (const name of DISPATCHED) {
    expect(text, `${name} is in ROW_DISPATCH but the driver never calls it`).toContain(`${name}(root`);
  }
});

// --- §M-6's stale-witness table, as the assertion nobody had ----------------

/**
 * `bracketSource` is the unconditional reader of `control.source`: it is the
 * first statement of every body that has it, and its refusal is a halt. So a body
 * that calls it can only run while the legacy document still exists — which is
 * exactly the containment §M-6 records for `source` and
 * `completion.sourceJsonSha256`, written as "unreachable from any row where `Q` is
 * live" and never asserted.
 *
 * The driver is the first row dispatcher, so it is the thing that could break it.
 * This is the assertion.
 *
 * `flipAuthority` is the one body that spans the rename, and 4A made it
 * deliberately NOT call `bracketSource` for this reason — its own resume branch
 * skips both stale members and its kill-matrix walk covers that. So this gate
 * admits it on both M5 rows and refuses everything else on the live side.
 */
test("no body dispatched from a row where Q is live re-reads the deleted source", () => {
  const readsSource = DISPATCHED.filter((name) => /\bbracketSource\(/.test(bodyOf(name)));
  expect(readsSource, "the stale-source reader set must not be empty").not.toEqual([]);
  for (const row of SQLITE_LIVE_ROWS) {
    for (const name of ROW_DISPATCH[row] as readonly string[]) {
      expect(readsSource, `${row} may not dispatch ${name}, which re-brackets the deleted source`)
        .not.toContain(name);
    }
  }
});

/**
 * The one body that spans the rename needs its own assertion, because for
 * `flipAuthority` the containment is a BRANCH rather than a row: it does read
 * `control.source` and `witness.completion.sourceJsonSha256`, and §M-6's claim is
 * that its resume branch — the only path `m5-artifact-ahead-q` can take — skips
 * both. That claim was prose. It is checkable exactly: the resume branch's own
 * `return` must precede every stale read in the function.
 *
 * This is what would catch a future edit that hoists a source revalidation to the
 * top of the flip "for symmetry" and thereby bricks every workspace killed between
 * the rename and M6's publication — the same class of defect 4A found on this row,
 * on the one row where there is no going back to JSON.
 */
test("the flip's resume branch returns before every stale-source read", () => {
  const body = bodyOf("flipAuthority");
  const resumeReturn = body.indexOf('return { kind: "flipped"');
  expect(resumeReturn, "the resume branch must still be an early return").toBeGreaterThan(0);

  for (const stale of ["control.source", "witness.completion.sourceJsonSha256", "revalidateBackups("]) {
    const at = body.indexOf(stale);
    expect(at, `${stale} must appear in the flip at all, or this gate is vacuous`).toBeGreaterThan(0);
    expect(at, `${stale} is stale on the resume branch and must come after its return`)
      .toBeGreaterThan(resumeReturn);
  }
  // And the resume branch itself reads only the member §M-6 marks "never stale".
  const resume = body.slice(body.indexOf('observed.sha256 === witness.qSibling.sha256'), resumeReturn);
  expect(resume).toContain("revalidateActive(");
  expect(resume).not.toContain("control.source");
});

/**
 * `staging` — the M4 proof — is stale from M5's rename. §M-6 contains it by "every
 * consumer at phase >= M5 reads `active` instead", which `retirement.ts` does with
 * an explicit phase selection. A body that reads it with NO phase guard is
 * therefore only safe below M5, and the driver is what decides that.
 */
test("an unguarded reader of the stale M4 staging proof is dispatched only below M5", () => {
  const unguarded = DISPATCHED.filter((name) => {
    const body = bodyOf(name);
    return /witness\.staging\b/.test(body) && !/witness\.phase\s*===/.test(body);
  });
  expect(unguarded, "publishPreparedDatabase is the unguarded reader this gate exists for")
    .toEqual(["publishPreparedDatabase"]);
  const rows = Object.entries(ROW_DISPATCH)
    .filter(([, bodies]) => (bodies as readonly string[]).some((name) => unguarded.includes(name)))
    .map(([row]) => row);
  expect(rows, "only the M4 row may hand the stale staging proof to its consumer").toEqual(["m4-resume"]);
});

/**
 * The two M5 rows are disjoint by which authority the live document holds, and
 * that disjointness is the whole containment for the two flip-stale members. Only
 * the JSON-side row may climb the Q ladder; the `Q`-side row may do nothing but
 * finish the flip.
 */
test("the two M5 rows stay disjoint on everything but the flip itself", () => {
  const json = new Set(ROW_DISPATCH["m5-resume"] as readonly string[]);
  const live = new Set(ROW_DISPATCH["m5-artifact-ahead-q"] as readonly string[]);
  expect([...live]).toEqual(["flipAuthority"]);
  expect(json.has("stepQSibling"), "the ladder belongs to the JSON-authority row").toBe(true);
  expect(live.has("stepQSibling"), "the ladder must never run once Q is live").toBe(false);
  expect([...json].filter((name) => live.has(name))).toEqual(["flipAuthority"]);
});

// --- the four retry buckets -------------------------------------------------

const HASH = "a".repeat(64);
const source = { path: "/w/.rbox/state.json", dev: 1, ino: 2, bytes: 10, sha256: HASH, mtimeNs: "1" };
const artifact = { path: "/w/x", dev: 1, ino: 3, bytes: 4, sha256: HASH };
const proof = { sha256: HASH, bytes: 9, semanticDigest: HASH, entryCount: 1, repoCount: 0, proofVersion: 1 };
const item = { role: "reserve" as const, path: "/w/r", parent: "/w", dev: 1, ino: 7, sha256: HASH };

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
  { cleanup: { items: [item], durablePrefix: 0, currentIntent: { index: 1 } }, futureControls: null },
  { terminalSibling: { ...artifact, disposition: "exact-or-absent-terminal" } },
];

const HALT = { code: "filesystem-full" as const, underlyingCode: "ENOSPC", required: null, available: null };

function halted(phase: MigrationPhase, extra: Partial<MigrationControl> = {}): MigrationControl {
  return {
    version: 1, controlRevision: 4, migrationId: "m1", authorityId: "a1",
    source, stagingPath: "/w/.rbox/state/state.db.migrate.m1",
    witness: Object.assign({ phase }, ...LAYERS.slice(0, MIGRATION_PHASES.indexOf(phase) + 1)),
    haltResources: { reserve: { disposition: "consumed-for-halt" }, emergency: { disposition: "consumed-for-halt" } },
    halt: HALT, retirement: null,
    ...extra,
  } as MigrationControl;
}

/** The promoted-halt shape `isFinalIntentPromotedHalt` recognizes: an M6 control
 * whose cursor sits on a durable FINAL-item intent and whose ledger has been
 * consumed into its promoted form. */
function promotedHalt(): MigrationControl {
  const base = halted("M6");
  const witness = base.witness as Extract<MigrationControl["witness"], { phase: "M6" }>;
  return {
    ...base,
    witness: {
      ...witness,
      cleanup: { items: [item], durablePrefix: 0, currentIntent: { index: 1 } },
      futureControls: {
        stage: "promoted-halt",
        origin: { path: "/w/.rbox/state/migration-v1.json.m1.5.tmp", revision: 5, dev: 1, ino: 41 },
        preparedSuccess: { path: "/w/.rbox/state/migration-v1.json.m1.6.tmp", revision: 6, dev: 1, ino: 42 },
      },
    },
    halt: { code: "cleanup-deferred", underlyingCode: "ENOSPC", required: null, available: null },
  } as MigrationControl;
}

test("every ordinary pre-flip phase routes to bucket 1", () => {
  for (const phase of ["M0", "M1", "M2", "M3", "M4", "M5"] as const) {
    expect(classifyHaltBucket(halted(phase)), `${phase} is an ordinary halt`).toBe("ordinary");
  }
});

test("a cursor halt routes to bucket 2 from any phase, and M6 does too", () => {
  const retirement = {
    version: 1 as const, reason: "source-changed" as const, fromPhase: "M2" as const,
    fromControlRevision: 2, originalSource: source, triggeringSource: source,
    cursor: { items: [item], durablePrefix: 0, currentIntent: null },
  };
  expect(classifyHaltBucket(halted("M2", { retirement }))).toBe("cursor");
  expect(classifyHaltBucket(halted("M6"))).toBe("cursor");
});

test("an ordinary halted M7 routes to bucket 3", () => {
  expect(classifyHaltBucket(halted("M7"))).toBe("terminal");
});

test("a final-intent promoted halt routes to bucket 4", () => {
  expect(classifyHaltBucket(promotedHalt())).toBe("promoted");
});

/**
 * The negative control the brief asks for: a bucket that MIS-routes a halt must
 * demonstrably produce the wrong behaviour with the guard removed.
 *
 * A promoted halt is an M6 final-intent control, so every later test in
 * `classifyHaltBucket` also matches it — the `isFinalIntentPromotedHalt` conjunct
 * is the only thing that keeps it out of bucket 2. Dropping that conjunct is
 * reproduced here rather than described: the same record then classifies as
 * `cursor`, whose handler CAS-clears the halt. 163:3141 says the promoted halt's
 * clear IS the expected-`r+1` rename of the prepared M7 sibling, so a CAS clear
 * would publish an unhalted M6 at the revision that sibling already occupies and
 * the terminal path becomes unreachable.
 */
test("without its first conjunct, bucket 4's record falls into bucket 2 — the wrong clear", () => {
  const control = promotedHalt();
  expect(classifyHaltBucket(control)).toBe("promoted");

  const withoutFirstConjunct = (candidate: MigrationControl): HaltBucket => {
    if (candidate.retirement !== null) return "cursor";
    if (candidate.witness.phase === "M7") return "terminal";
    if (candidate.witness.phase === "M6") return "cursor";
    return "ordinary";
  };
  expect(withoutFirstConjunct(control), "the mutant routes the one halt that must not be cleared")
    .toBe("cursor");
});

/** Bucket 3 exists because M7 is past every cursor. Removing the M7 conjunct
 * routes it to `ordinary`, whose handler recreates the reserve and the emergency
 * candidate — both already `retired` at M7 — and republishes them `available`,
 * resurrecting two artifacts the terminal record says are gone. */
test("without its M7 conjunct, bucket 3's record falls into bucket 1 — a resurrecting clear", () => {
  const control = halted("M7");
  expect(classifyHaltBucket(control)).toBe("terminal");
  const withoutM7 = (candidate: MigrationControl): HaltBucket =>
    candidate.retirement !== null || candidate.witness.phase === "M6" ? "cursor" : "ordinary";
  expect(withoutM7(control)).toBe("ordinary");
});

/**
 * §M-6's constraint on the wave that introduces halt clearing, discharged as an
 * assertion rather than a promise: bucket 1 is the only handler that clears a
 * pre-flip halt, and it recreates the runway in the SAME publication that clears.
 * So a workspace is never observable as cleared-but-unprovisioned, and a cleared
 * M5 halt cannot reach the flip with an empty cleanup vector.
 */
test("bucket 1 clears a halt only together with the resources the halt spent", () => {
  const recovery = read(RECOVERY);
  const body = recovery.slice(recovery.indexOf("const BUCKETS"));
  const ordinary = body.slice(body.indexOf("ordinary:")).split("\n  },")[0]!;
  expect(ordinary).toContain("restoreHaltRunway");
  expect(ordinary).toContain("halt: null");
  expect(ordinary).toContain("haltResources: resources");
  // One publication, so there is no window between the two facts.
  expect(ordinary.match(/publishMigrationControl\(/g)?.length).toBe(1);
  // And the recreation precedes it.
  expect(ordinary.indexOf("restoreHaltRunway")).toBeLessThan(ordinary.indexOf("publishMigrationControl("));

  for (const bucket of ["cursor", "terminal"] as const) {
    const handler = body.slice(body.indexOf(`${bucket}:`)).split("\n  },")[0]!;
    expect(handler, `${bucket} resources are vector items, never runway`).not.toContain("restoreHaltRunway");
  }
  const promoted = body.slice(body.indexOf("promoted:")).split("\n  },")[0]!;
  expect(promoted, "bucket 4 has no clear at all — the rename is the clear")
    .not.toContain("publishMigrationControl(");
});

// --- §7.9's remaining prose-only inventory items ----------------------------

const gitGrep = (pattern: string, ...pathspec: string[]): string[] =>
  execFileSync("git", ["grep", "-nIE", pattern, "--", ...pathspec], { cwd: REPO, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);

/**
 * §7.9: "Exactly two entry call sites of `establishStateAuthority`, plus one
 * doctor authorization site."
 *
 * The two entry sites are `rbox upgrade`'s stop window and foreground
 * `rbox migrate`, and the `EntryPoint` union has named them since wave 2B. Neither
 * command is wired yet: §6.3 makes that explicit ("Both commands land with §3.2
 * and §5B. Until they do, no halt is reachable"), and 5B owns the halt copy
 * renderer, the `--json` twin, and `--retry-state-migration`/
 * `--abort-state-migration` that the authorization site exists for.
 *
 * So the count is PINNED at what exists rather than asserted at two. That is the
 * point of the gate either way: it is the appearance of an unenumerated third
 * caller that must fail, and pinning zero catches that today exactly as pinning
 * two will after 5B. `EXPECTED_SITES` is the one line 5B edits.
 */
const EXPECTED_SITES: readonly string[] = [];

test("the coordinator's production entry call sites are exactly the enumerated ones", () => {
  // Comments are stripped, the same way the sole-writer gate strips them: the
  // driver's own doc comment explains why the progress sink is NOT a parameter of
  // `establishStateAuthority`, and prose about a function is not a call to it.
  const hits = gitGrep("\\bestablishStateAuthority\\b", "src", ":!*.test.ts")
    .filter((line) => !line.startsWith("src/cli/state-plane/authority-bootstrap.ts:"))
    .filter((line) => {
      const body = line.split(":").slice(2).join(":").trim();
      return !body.startsWith("//") && !body.startsWith("*") && !body.startsWith("/*");
    });
  expect(hits.map((line) => line.split(":")[0]!).sort()).toEqual([...EXPECTED_SITES].sort());
  // The two admitted names must stay exactly two, or "exactly two entry sites"
  // is a claim about a union that grew.
  const union = read(path.join(HERE, "..", "locks.ts"));
  expect(/export type EntryPoint = "upgrade-stop-window" \| "foreground-migrate";/.test(union)).toBe(true);
});

/**
 * §7.9's last bullet — "`docs/CODEMAP.md` gains one ownership line per new module
 * in the same change" — was the only inventory item with no enforcement at all,
 * and every wave-1-to-4 lane consequently proposed its line in a PR body instead
 * of landing it. Wave 5A folds them all in and makes the rule executable, so the
 * next lane cannot repeat it.
 */
test("every production state-plane module has a CODEMAP ownership line", () => {
  // Line STARTS, not `includes`. A substring test is vacuous here: any sibling's
  // line contains the directory prefix, so `includes(dir + "/")` would pass for
  // every module in a directory that documents exactly one of them — which is
  // precisely the state this gate found the tree in.
  const owned = new Set(
    read(path.join(REPO, "docs", "CODEMAP.md")).split("\n")
      .map((line) => /^`?(src\/[^`\s]+)/.exec(line.trim())?.[1])
      .filter((entry): entry is string => entry !== undefined),
  );
  const covered = (rel: string): boolean =>
    owned.has(rel) || owned.has(`${path.dirname(rel)}/`);

  const missing: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile() || !file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue;
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      if (!covered(rel)) missing.push(rel);
    }
  };
  walk(path.resolve(HERE, ".."));
  expect(missing, "add one ownership line per module, in the same change (222 §7.9)").toEqual([]);

  // ONE line per module. Two lines for one path is two owners, which is the
  // condition the document exists to make impossible.
  const counts = new Map<string, number>();
  for (const line of read(path.join(REPO, "docs", "CODEMAP.md")).split("\n")) {
    const entry = /^`?(src\/[^`\s]+)/.exec(line.trim())?.[1];
    if (entry) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  expect([...counts].filter(([, n]) => n > 1).map(([entry]) => entry)).toEqual([]);
});

/** The cast-containment gate 222 recorded as prose lives in `locks.test.ts`,
 * where lane 2B made it executable. It is pinned from here too, because a gate
 * that is deleted is indistinguishable from a gate that never existed, and this
 * is the module inventory's home. */
test("the HeldStatePlaneLocks cast gate is still executable and still loose", () => {
  const text = read(path.join(HERE, "..", "locks.test.ts"));
  expect(text).toContain("only locks.ts casts its way to a bundle in production code");
  // Loose on purpose: `as unknown as Mod.HeldStatePlaneLocks` slipped past the
  // first, tighter pattern.
  expect(text).toContain("\\\\bas\\\\b[^;]*HeldStatePlaneLocks");
  expect(text).toContain(":!*.test.ts");
});
