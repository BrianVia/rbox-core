/**
 * The 5C crash matrix (design 222 §5.2's "crash-resume row" column, §7.2).
 *
 * Nothing here is planted. Every row is produced the same way: build a REAL
 * legacy workspace, run the REAL migration in a child process, SIGKILL it at one
 * named syscall, and then assert against whatever the machine left. The fixture
 * is the interruption, never the state — which is the whole reason this wave
 * exists, because the eight lanes before it kept hand-writing control records,
 * staging files, and dispositions that no crash can produce.
 *
 * Every kill point and every `nth` below was derived from the machine's own
 * trace (`scripts/probe/u3-5c-trace.ts`), not guessed, and the derivation is
 * self-guarding in two directions: an `nth` that no longer matches makes the
 * child exit 65 (never a silent pass), and the trace's exact length is pinned by
 * the negative control at the bottom.
 *
 * The reference is one uninterrupted migration of the SAME corpus. Note what it
 * can and cannot be compared against: `state_lineage.lineage_id` is minted per
 * migration, and both `stateSemanticDigest` and the recorded
 * `source_semantic_digest` are salted by it, so two runs of one corpus never
 * share a digest. The cross-run-stable form of "same content" is therefore the
 * table row counts plus the completion tuple's source-describing members, and
 * the digest is asserted as the WITHIN-workspace identity M3/M4 established:
 * the resumed database still digests to the source digest it recorded.
 */
import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveStateUnsafeLegacyOrTest } from "../../sync-state-store.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../../workspace-config.js";
import { loadRawLegacyJsonState } from "../adapters/legacy-json-store.js";
import { StateFormatTooNewError } from "../errors.js";
import { withStatePlaneLocks, type EntryProof } from "../locks.js";
import { sqliteResetPaths, statePath } from "../paths.js";
import { stateSemanticDigest } from "../digest/state-semantic-v1.js";
import { openStateStore, stateStoreDatabase } from "../store/open.js";
import { runMigration, SQLITE_LIVE_ROWS, type MigrationOutcome } from "./authority.js";
import { classifyMigrationState, type MigrationObservation } from "./classifier.js";
import {
  installStatePlaneFault, rboxResidue, rboxResiduePaths, type StatePlaneFaultPoint,
} from "./fault-rig.js";
import { replaceUnderNewInode } from "./inode-fixtures.js";

process.env.RBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-u3-5c-crash-home-"));
const CHILD = path.resolve(import.meta.dir, "fault-rig-child.ts");
type Row = MigrationObservation["row"];

// ---------------------------------------------------------------------------
// The workspace. A non-empty corpus, so every phase does real work.

const corpus = (n: number) => Array.from({ length: n }, (_, i) => ({
  path: `repo${i % 7}/file-${i}.txt`,
  sha256: crypto.createHash("sha256").update(`f${i}`).digest("hex"),
  size: 100 + i, mode: 0o644, mtimeMs: 1_700_000_000_000 + i, type: "file" as const,
}));

async function migratable(prefix: string, files = corpus(120)): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rbox-u3-5c-${prefix}-`));
  const config: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
    rootPath: root, remoteUrl: "https://example.invalid", token: "",
  };
  await saveConfig(root, config);
  fs.mkdirSync(sqliteResetPaths.stateRoot(root), { recursive: true });
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(config), lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files },
  } as never);
  return root;
}

const under = <T>(root: string, fn: (entry: EntryProof) => Promise<T>): Promise<T> =>
  withStatePlaneLocks(root, (locks) => fn({ entry: "foreground-migrate", locks })).then((o) => {
    if (!o.held) throw new Error(`bundle refused: ${o.refusal.code}`);
    return o.value;
  });

const classify = (root: string): Promise<Row> =>
  under(root, (entry) => classifyMigrationState(root, entry.locks)).then((o) => o.row);

/** Read the migrated store. Opening it is itself a mutation of `.rbox` (the
 * `-wal`/`-shm` pair the r6 negative control at the bottom exists to prove), so
 * every caller snapshots the residue BEFORE this runs. */
function storeFacts(root: string): { counts: string; source: string; consistent: boolean } {
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
  try {
    const db = stateStoreDatabase(store);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const counts = tables
      .map((t) => `${t.name}=${(db.prepare(`SELECT count(*) c FROM "${t.name}"`).get() as { c: number }).c}`)
      .join(",");
    const row = db.prepare(`SELECT origin_kind,source_json_sha256,source_bytes,entry_count,repo_count,
      source_shape_flags_cjson,source_repo_records_present,source_semantic_digest
      FROM migration_completion WHERE singleton=1`).get() as Record<string, unknown>;
    return {
      counts,
      source: JSON.stringify({ ...row, source_semantic_digest: null }),
      consistent: String(stateSemanticDigest(db)) === String(row.source_semantic_digest),
    };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// The observers. A fault installed at an `nth` no run reaches never fires, so
// its only effect is `matches()` — the rig doubles as a counter, which is how
// "no destructive step repeats" is measured without a second mechanism.

const DESTRUCTIVE = {
  qRename: { syscall: "renameSync", match: /state\.json\.migrate\..*\.q/ },
  dbRename: { syscall: "renameSync", match: /state\.db\.migrate\./ },
  reserveUnlink: { syscall: "unlinkSync", match: /reserve-1mib\.bin/ },
  emergencyUnlink: { syscall: "unlinkSync", match: /migration-emergency\..*\.bin/ },
  controlUnlink: { syscall: "unlinkSync", match: /migration-v1\.json$/ },
} as const;
type Destructive = Record<keyof typeof DESTRUCTIVE, number>;

function countDestructive(): { read: () => Destructive; restore: () => void } {
  const installed = Object.entries(DESTRUCTIVE).map(([name, point]) =>
    [name, installStatePlaneFault({ ...point, nth: Number.MAX_SAFE_INTEGER }, { kind: "kill" })] as const);
  return {
    read: () => Object.fromEntries(installed.map(([n, f]) => [n, f.matches()])) as Destructive,
    restore: () => { for (const [, f] of [...installed].reverse()) f.restore(); },
  };
}

// ---------------------------------------------------------------------------
// One matrix cell: kill, observe, re-enter.

interface Cell {
  readonly root: string;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stderr: string;
  readonly row: Row;
  readonly residueAtCrash: readonly string[];
  readonly outcome: MigrationOutcome;
  readonly destructive: Destructive;
  readonly residue: readonly string[];
  readonly facts: { counts: string; source: string; consistent: boolean } | undefined;
}

function spawnKill(root: string, point: StatePlaneFaultPoint): ReturnType<typeof Bun.spawnSync> {
  const spec = JSON.stringify({
    point: { ...point, match: point.match?.source },
    action: { kind: "kill" },
  });
  return Bun.spawnSync([process.execPath, CHILD, "migrate", root, spec], { env: { ...process.env } });
}

async function interrupt(prefix: string, point: StatePlaneFaultPoint): Promise<Cell> {
  const root = await migratable(prefix);
  const child = spawnKill(root, point);
  const row = await classify(root);
  const residueAtCrash = rboxResiduePaths(root);
  const counter = countDestructive();
  let outcome: MigrationOutcome;
  try {
    outcome = await under(root, (entry) => runMigration(root, entry));
  } finally {
    counter.restore();
  }
  const residue = rboxResiduePaths(root);
  return {
    root, exitCode: child.exitCode, signalCode: child.signalCode as string | null,
    stderr: String(child.stderr), row, residueAtCrash, outcome,
    destructive: counter.read(), residue,
    facts: outcome.kind === "migrated" || outcome.kind === "already-migrated" ? storeFacts(root) : undefined,
  };
}

/** Every assertion §5.2 and §7.2 make about a crash row, in one place. */
function assertConverged(cell: Cell, expected: Row): void {
  expect(cell.exitCode, `an unreachable kill point is a broken row: ${cell.stderr}`).not.toBe(65);
  const killed = cell.signalCode === "SIGKILL" || cell.exitCode === 137 || cell.exitCode === 9;
  expect(killed, `the child returned ${cell.exitCode}/${cell.signalCode} instead of dying`).toBe(true);
  expect(cell.row).toBe(expected);
  expect(cell.outcome.kind).toBe(expected === "terminal-sqlite" ? "already-migrated" : "migrated");
  // Same store as an uninterrupted run, in the two forms that survive a per-run
  // lineage id; and the digest identity M3/M4 proved is still true after resume.
  expect(cell.facts?.counts).toBe(reference.facts.counts);
  expect(cell.facts?.source).toBe(reference.facts.source);
  expect(cell.facts?.consistent).toBe(true);
  const alreadyFlipped = (SQLITE_LIVE_ROWS as readonly string[]).includes(expected);
  // Residue, §7.3's terminal shape — minus the ONE difference an uninterrupted
  // run does not have. A row on which `Q` is already live is classified through
  // `active-store-proof.ts`, the sanctioned opener, and a SQLite open leaves a
  // `-wal`/`-shm` pair behind (whether SQLite reaps them at close varies run to
  // run). So the pair is excluded from the comparison and then asserted on its
  // own: it may only ever appear on a row that legitimately opened the store.
  // The other admitted difference is `begin.ts`'s documented M0 leak, and it is
  // admitted on the `no-control-json` row ALONE, where it is then asserted in
  // its own right below rather than merely tolerated here.
  const sidecar = (p: string): boolean => p.endsWith("-wal") || p.endsWith("-shm");
  const strandedM0 = (p: string): boolean =>
    expected === "no-control-json" && /^state\/migration-v1\.json\.[0-9a-f]{32}\.1\.tmp$/.test(p);
  expect(cell.residue.filter((p) => !sidecar(p) && !strandedM0(p))).toEqual(reference.residue);
  expect(cell.residue.filter(sidecar).every((p) => p.startsWith("state/state.db-"))).toBe(true);
  if (cell.residue.some(sidecar)) expect(alreadyFlipped).toBe(true);
  // No destructive step repeats: exactly one per effect across crash + resume,
  // and exactly zero for any effect the crash image proves already landed.
  const done = (needle: string): boolean =>
    alreadyFlipped && !cell.residueAtCrash.some((p) => p.includes(needle));
  expect(cell.destructive.qRename).toBe(alreadyFlipped ? 0 : 1);
  expect(cell.destructive.dbRename).toBeLessThanOrEqual(1);
  expect(cell.destructive.reserveUnlink).toBe(done("reserve-1mib.bin") ? 0 : 1);
  expect(cell.destructive.emergencyUnlink).toBe(done("migration-emergency.") ? 0 : 1);
  expect(cell.destructive.controlUnlink).toBe(expected === "terminal-sqlite" ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Drive the whole matrix once, then assert it cheaply.

const reference = await (async () => {
  const root = await migratable("ref");
  const outcome = await under(root, (entry) => runMigration(root, entry));
  const residue = rboxResiduePaths(root);
  const residueBeforeAnyOpen = rboxResidue(root);
  return { root, outcome, residue, residueBeforeAnyOpen, facts: storeFacts(root) };
})();

/** The 18 durable control publications, both sides of each. Derived from the
 * trace; the resulting row is the machine's answer, not the design's. */
const CONTROL: readonly (readonly [number, "before" | "after", Row])[] = [
  [1, "before", "no-control-json"], [1, "after", "m0-resume"],
  [2, "before", "m0-resume"], [2, "after", "m1-resume"],
  [3, "before", "m1-resume"], [3, "after", "m2-resume"],
  [4, "before", "m2-resume"], [4, "after", "m2-resume"],
  [5, "before", "m2-resume"], [5, "after", "m3-resume"],
  [6, "before", "m3-resume"], [6, "after", "m4-resume"],
  [7, "before", "m4-resume"], [7, "after", "m5-resume"],
  [8, "before", "m5-resume"], [8, "after", "m5-resume"],
  [9, "before", "m5-resume"], [9, "after", "m5-resume"],
  [10, "before", "m5-artifact-ahead-q"], [10, "after", "m6-cleanup"],
  [11, "before", "m6-cleanup"], [11, "after", "m6-cleanup"],
  [12, "before", "m6-cleanup"], [12, "after", "m6-cleanup"],
  [13, "before", "m6-cleanup"], [13, "after", "m6-cleanup"],
  [14, "before", "m6-cleanup"], [14, "after", "m6-cleanup"],
  [15, "before", "m6-cleanup"], [15, "after", "m6-cleanup"],
  [16, "before", "m6-cleanup"], [16, "after", "m6-cleanup"],
  [17, "before", "m6-cleanup"], [17, "after", "m6-cleanup"],
  [18, "before", "m6-cleanup"], [18, "after", "m7"],
];

/** The physical effects, which are the transitions a control record does not
 * describe: the two backup renames, the staging rename, THE FLIP, the two
 * cleanup unlinks, and the terminal control retirement. */
const PHYSICAL: readonly (readonly [string, StatePlaneFaultPoint, Row])[] = [
  ["M1 backup history landed", { syscall: "renameSync", match: /legacy-json\//, nth: 1, when: "after" }, "m1-resume"],
  ["M1 fixed .bak landed", { syscall: "renameSync", match: /legacy-json\//, nth: 2, when: "after" }, "m1-resume"],
  ["M4 staging rename pending", { syscall: "renameSync", match: /state\.db\.migrate\./, nth: 1, when: "before" }, "m4-resume"],
  ["M4 staging rename landed", { syscall: "renameSync", match: /state\.db\.migrate\./, nth: 1, when: "after" }, "m4-resume"],
  ["the flip pending", { syscall: "renameSync", match: /state\.json\.migrate\..*\.q/, nth: 1, when: "before" }, "m5-resume"],
  ["the flip landed", { syscall: "renameSync", match: /state\.json\.migrate\..*\.q/, nth: 1, when: "after" }, "m5-artifact-ahead-q"],
  ["M6 reserve unlink pending", { syscall: "unlinkSync", match: /reserve-1mib\.bin/, nth: 1, when: "before" }, "m6-cleanup"],
  ["M6 reserve unlinked", { syscall: "unlinkSync", match: /reserve-1mib\.bin/, nth: 1, when: "after" }, "m6-cleanup"],
  ["M6 emergency unlinked", { syscall: "unlinkSync", match: /migration-emergency\..*\.bin/, nth: 1, when: "after" }, "m6-cleanup"],
  ["M7 control retire pending", { syscall: "unlinkSync", match: /migration-v1\.json$/, nth: 1, when: "before" }, "m7"],
  ["M7 control retired", { syscall: "unlinkSync", match: /migration-v1\.json$/, nth: 1, when: "after" }, "terminal-sqlite"],
];

const CELLS = new Map<string, Cell>();
for (const [nth, when] of CONTROL) {
  CELLS.set(`control-${nth}-${when}`, await interrupt(`c${nth}${when}`, {
    syscall: "renameSync", match: /migration-v1\.json$/, nth, when,
  }));
}
for (const [label, point] of PHYSICAL) {
  CELLS.set(label, await interrupt(label.replaceAll(/\W+/g, "").slice(0, 12), point));
}

test("the uninterrupted reference migrates and leaves exactly the terminal residue", () => {
  expect(reference.outcome).toMatchObject({ kind: "migrated" });
  // §7.3's M2-M5 residue, as the machine leaves it: the immutable history entry
  // and the fixed `.bak` survive; every runway artifact and the control do not.
  expect(reference.residue.map((p) => p.replace(/[0-9a-f]{64}/, "<source-sha>"))).toEqual([
    "state.json", "state/last-writer.json",
    "state/legacy-json/<source-sha>.json", "state/legacy-json/pre-163-latest.json.bak",
    "state/state.db", "workspace.json",
  ]);
});

for (const [nth, when, row] of CONTROL) {
  test(`crash ${when} durable control publication ${nth} resumes from ${row}`, () => {
    assertConverged(CELLS.get(`control-${nth}-${when}`)!, row);
  });
}

for (const [label, , row] of PHYSICAL) {
  test(`crash at "${label}" resumes from ${row}`, () => {
    assertConverged(CELLS.get(label)!, row);
  });
}

test("the trace has exactly 18 durable control publications and no more", async () => {
  // The `nth` of every row above is only meaningful if the trace's length is
  // pinned. Exit 65 IS the never-matched verdict, so a 19th point that cannot
  // fire reads as a failure of the point and never as a clean pass.
  const root = await migratable("nth19");
  const child = spawnKill(root, { syscall: "renameSync", match: /migration-v1\.json$/, nth: 19 });
  expect(child.exitCode).toBe(65);
  expect(String(child.stderr)).toContain("fault point was never reached");
  expect(await classify(root)).toBe("terminal-sqlite");
});

test("M0's documented leak: a kill before the first publication strands one inert temp", () => {
  const cell = CELLS.get("control-1-before")!;
  const stranded = cell.residue.filter((p) => /migration-v1\.json\.[0-9a-f]{32}\.1\.tmp$/.test(p));
  // `begin.ts` records this: re-entry mints a FRESH migration id, so the dead
  // id's temp is named by nothing durable. It is never adopted and never
  // removed — doctor's inert-temp quarantine is its sole remover.
  expect(stranded).toHaveLength(1);
  expect(cell.residueAtCrash).toContain(stranded[0]!);
  expect(cell.residue).not.toContain("state/migration-v1.json");
});

test("the flip's Q sibling never survives the rename that consumed it", () => {
  const landed = CELLS.get("the flip landed")!;
  expect(landed.residueAtCrash.some((p) => p.endsWith(".q"))).toBe(false);
  expect(CELLS.get("the flip pending")!.residueAtCrash.some((p) => p.endsWith(".q"))).toBe(true);
});

test("M7 retires the control last: no prepared sibling survives the terminal unlink", () => {
  const before = CELLS.get("M7 control retire pending")!;
  expect(before.residueAtCrash.some((p) => p.endsWith(".tmp"))).toBe(false);
  expect(CELLS.get("control-18-after")!.residueAtCrash.some((p) => p.endsWith(".18.tmp"))).toBe(true);
});

// ---------------------------------------------------------------------------
// r6 (§7.1). Without this control, every "byte-identical" assertion in this
// wave is vacuous: a stray `-wal`/`-shm` beside an untouched artifact passes a
// single-file comparison while proving the opposite of what it exists to prove.

test("r6: a read-only open of an inspected database FAILS a residue snapshot", async () => {
  const root = await migratable("r6");
  await under(root, (entry) => runMigration(root, entry));
  const untouched = rboxResidue(root);
  expect(Object.keys(untouched).some((p) => p.endsWith("-wal") || p.endsWith("-shm"))).toBe(false);
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
  const opened = rboxResidue(root);
  store.close();
  expect(opened, "an inspected database must not compare equal to an untouched one").not.toEqual(untouched);
  expect(Object.keys(opened).some((p) => p.endsWith("-wal") || p.endsWith("-shm"))).toBe(true);
  // And the reference's own comparison basis was taken before any open, which
  // is what makes every `toEqual(reference.residue)` above non-vacuous.
  expect(Object.keys(reference.residueBeforeAnyOpen).some((p) => p.endsWith("-wal"))).toBe(false);
});

// ---------------------------------------------------------------------------
// 4A's deferred F2/F5. F3 and F6 are NOT faked below — see the skip.

test("F2: a legacy writer suspended before M0 and resumed after M7 fails closed", async () => {
  const root = await migratable("f2", corpus(24));
  // Suspended after its state read: this is the document the 1.10.x-shaped
  // writer is holding when the whole migration runs underneath it.
  const held = await loadRawLegacyJsonState(root);
  expect(await under(root, (entry) => runMigration(root, entry))).toMatchObject({ kind: "migrated" });
  const before = rboxResidue(root);
  await expect(saveStateUnsafeLegacyOrTest(root, held as never))
    .rejects.toBeInstanceOf(StateFormatTooNewError);
  // `Q` byte-identical, widened to the whole `.rbox` tree per §7.1's r6 note.
  expect(rboxResidue(root)).toEqual(before);
});

test("F5 companion: a legacy write one window before the flip refuses the rename", async () => {
  const root = await migratable("f5", corpus(24));
  // Killed with the flip's rename pending: the Q sibling exists, JSON is still
  // authority, and this is exactly the window F5's companion writes into.
  const child = spawnKill(root, { syscall: "renameSync", match: /state\.json\.migrate\..*\.q/, nth: 1, when: "before" });
  expect(child.exitCode).not.toBe(65);
  expect(rboxResiduePaths(root).some((p) => p.endsWith(".q"))).toBe(true);
  const written = fs.readFileSync(statePath(root)).toString().replace('"lastSyncedSequence":0', '"lastSyncedSequence":7');
  replaceUnderNewInode(statePath(root), written);

  expect(await classify(root)).toBe("source-changed");
  const outcome = await under(root, (entry) => runMigration(root, entry));
  expect(outcome).toEqual({ kind: "retired", reason: "source-changed", fromPhase: "M5" });
  // No rename, JSON authoritative, the writer's document intact, and the two
  // §7.3 M2–M5 backups kept. Nothing was published over `state.json`.
  expect(fs.readFileSync(statePath(root)).toString()).toBe(written);
  const residue = rboxResiduePaths(root);
  expect(residue.some((p) => p.endsWith(".q"))).toBe(false);
  expect(residue).not.toContain("state/state.db");
  expect(residue).toContain("state/legacy-json/pre-163-latest.json.bak");
});

/**
 * F3 and F6 need one artifact this repository cannot synthesize: the PUBLISHED,
 * SIGNED 1.10.x (F3) / 1.11.0 (F6) binary, run as a second process against the
 * same workspace. Their whole content is what a build WITHOUT the `Q` barrier
 * does — F3 documents that it destroys `Q`, F6 that the post-flip pull silently
 * overwrites — so running today's source with the barrier stubbed out would
 * assert the stub, not the released behaviour. That artifact belongs in the rig
 * (a version-pinned download beside `fault-rig-child.ts`), and until it is there
 * these two gates are open. Do not replace this with a hand-built fixture.
 */
test.skip("F3/F6 require the published signed 1.10.x / 1.11.0 binaries in the rig", () => {});
