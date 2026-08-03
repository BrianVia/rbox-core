/**
 * The 5C I/O halt matrix (design 222 §5.2's "Reachable halts" column, §5.4,
 * §7.2).
 *
 * `ENOSPC`, `EDQUOT`, and `EIO` at the real write sites of a real migration.
 * Nothing is planted here either: the workspace is built by the production
 * writer, the migration is the production driver, and the only thing this file
 * supplies is the errno one syscall returns. Every expected halt code below was
 * read off the machine first and is asserted as the machine's answer.
 *
 * These are error returns rather than crashes, so they run in-process and every
 * fault is restored in `afterEach`.
 *
 * Two limits of the rig, recorded rather than worked around:
 *
 * - `reserve.ts` and `disk-preflight.ts` do their I/O through
 *   `node:fs/promises`, a different object from the `node:fs` default export the
 *   rig patches. So the reserve's own creation write and the `statfs` behind the
 *   `disk-preflight` halt are NOT reachable from here; what is reachable is
 *   `begin.ts`'s synchronous re-observation of the claimed reserve.
 * - `source-oversize`, `memory-admission`, and `record-oversize` are size
 *   admissions, not I/O, and belong to their own lanes' tests.
 */
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveStateUnsafeLegacyOrTest } from "../../sync-state-store.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../../workspace-config.js";
import { withStatePlaneLocks, type EntryProof } from "../locks.js";
import { sqliteResetPaths } from "../paths.js";
import { runMigration, type MigrationOutcome } from "./authority.js";
import { classifyMigrationState, type MigrationObservation } from "./classifier.js";
import {
  installStatePlaneFault, rboxResidue,
  type InstalledFault, type StatePlaneFaultAction, type StatePlaneFaultPoint,
} from "./fault-rig.js";
import { retryHaltedMigration } from "./halt-recovery.js";
import type { MigrationHaltCode } from "./health.js";

process.env.RBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-u3-5c-io-home-"));

const live: InstalledFault[] = [];
afterEach(() => {
  for (const fault of live.splice(0).reverse()) fault.restore();
});

const arm = (point: StatePlaneFaultPoint, action: StatePlaneFaultAction): InstalledFault => {
  const fault = installStatePlaneFault(point, action);
  live.push(fault);
  return fault;
};

async function migratable(prefix: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rbox-u3-5c-io-${prefix}-`));
  const config: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
    rootPath: root, remoteUrl: "https://example.invalid", token: "",
  };
  await saveConfig(root, config);
  fs.mkdirSync(sqliteResetPaths.stateRoot(root), { recursive: true });
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(config), lastSyncedSequence: 0,
    lastSyncedManifest: {
      generatedAt: "", files: Array.from({ length: 24 }, (_, i) => ({
        path: `repo${i % 4}/file-${i}.txt`,
        sha256: crypto.createHash("sha256").update(`f${i}`).digest("hex"),
        size: 100 + i, mode: 0o644, mtimeMs: 1_700_000_000_000 + i, type: "file" as const,
      })),
    },
  } as never);
  return root;
}

const under = <T>(root: string, fn: (entry: EntryProof) => Promise<T>): Promise<T> =>
  withStatePlaneLocks(root, (locks) => fn({ entry: "foreground-migrate", locks })).then((o) => {
    if (!o.held) throw new Error(`bundle refused: ${o.refusal.code}`);
    return o.value;
  });

const classify = (root: string): Promise<MigrationObservation["row"]> =>
  under(root, (entry) => classifyMigrationState(root, entry.locks)).then((o) => o.row);

/** A migration run under one fault. A raw errno escaping the driver is a real
 * outcome of this machine, so it is captured rather than rethrown — the tests
 * below assert which sites produce which, and that is the point. */
async function faulted(
  prefix: string, point: StatePlaneFaultPoint, action: StatePlaneFaultAction,
): Promise<{ root: string; outcome: MigrationOutcome | undefined; escaped: string | undefined }> {
  const root = await migratable(prefix);
  const fault = arm(point, action);
  let outcome: MigrationOutcome | undefined;
  let escaped: string | undefined;
  try {
    outcome = await under(root, (entry) => runMigration(root, entry));
  } catch (error) {
    escaped = String((error as NodeJS.ErrnoException).code);
  }
  expect(fault.fired(), "an unreachable injection point is a broken row").toBe(true);
  return { root, outcome, escaped };
}

const P = (syscall: string, match: RegExp, nth = 1): StatePlaneFaultPoint => ({ syscall, match, nth, when: "before" });

// ---------------------------------------------------------------------------
// The sites that produce a TYPED halt, and the retry bucket that clears it.

interface HaltRow {
  readonly label: string;
  readonly point: StatePlaneFaultPoint;
  readonly code: MigrationHaltCode;
  /** §5.4: whether the halt reached the durable control. */
  readonly durable: boolean;
}

const TYPED: readonly HaltRow[] = [
  // M1's runway. The FIRST open of each path is `observePath`'s, which reads any
  // non-`ENOENT` failure as a foreign occupant (`artifact-observation.ts:50`).
  { label: "M1 emergency observation open", point: P("openSync", /migration-emergency\..*\.bin/, 1), code: "reserved-path", durable: true },
  { label: "M1 emergency exclusive create", point: P("openSync", /migration-emergency\..*\.bin/, 2), code: "filesystem-full", durable: true },
  { label: "M1 emergency post-write reread", point: P("openSync", /migration-emergency\..*\.bin/, 3), code: "verification", durable: true },
  { label: "M1 claimed-reserve reread", point: P("openSync", /reserve-1mib\.bin/, 1), code: "reserved-path", durable: true },
  // The flip and the publication that records it: after `Q`, only the two
  // post-flip codes are expressible (§5.4).
  { label: "M5→M6 the authority rename", point: P("renameSync", /state\.json\.migrate\..*\.q/, 1), code: "durability-indeterminate", durable: true },
  { label: "M6 publication after the flip", point: P("renameSync", /migration-v1\.json$/, 10), code: "durability-indeterminate", durable: true },
  { label: "M6 reserve removal", point: P("unlinkSync", /reserve-1mib\.bin/, 1), code: "cleanup-deferred", durable: true },
  { label: "M6 emergency removal", point: P("unlinkSync", /migration-emergency\..*\.bin/, 1), code: "cleanup-deferred", durable: true },
  { label: "M6 cursor publication", point: P("renameSync", /migration-v1\.json$/, 12), code: "cleanup-deferred", durable: true },
];

for (const code of ["ENOSPC", "EDQUOT"] as const) {
  for (const row of TYPED) {
    test(`${code} at ${row.label} halts ${row.code}, and --retry-state-migration converges`, async () => {
      const { root, outcome, escaped } = await faulted("t", row.point, { kind: "errno", code });
      expect(escaped, "a space condition at this site must not escape as a raw errno").toBeUndefined();
      expect(outcome).toMatchObject({ kind: "halted", durableHalt: row.durable });
      expect((outcome as Extract<MigrationOutcome, { kind: "halted" }>).halt.code).toBe(row.code);
      expect(await classify(root)).toBe("halted");
      // The fault is cleared by `afterEach`'s restore in every other test; here
      // it must be cleared BEFORE the retry, which is the whole point of a halt.
      for (const fault of live.splice(0).reverse()) fault.restore();
      expect(await under(root, (entry) => retryHaltedMigration(root, entry))).toMatchObject({ kind: "migrated" });
      expect(await classify(root)).toBe("terminal-sqlite");
    });
  }
}

// ---------------------------------------------------------------------------
// FINDING (reported, not repaired): §5.2 lists `filesystem-full` as a reachable
// halt for M1 through M6, but at every site below a real `ENOSPC` escapes
// `runMigration` as a raw `ErrnoException` — no typed halt, no `durableHalt`,
// and not a member of `MigrationOutcome` at all. The fail-closed and resumable
// properties DO hold at each of them, which is what these rows assert; the typed
// surface does not. Asserted as the machine's real behaviour so that a later
// wave which closes the gap has to come back and change this table on purpose.

const ESCAPING: readonly (readonly [string, StatePlaneFaultPoint, MigrationObservation["row"]])[] = [
  ["M0 first control publication", P("renameSync", /migration-v1\.json$/, 1), "no-control-json"],
  ["M1 publication", P("renameSync", /migration-v1\.json$/, 2), "m0-resume"],
  ["M2 publication", P("renameSync", /migration-v1\.json$/, 3), "m1-resume"],
  ["M2 backup temp create", P("openSync", /legacy-json\/pre-163\..*\.tmp/, 1), "m1-resume"],
  ["M2 backup history rename", P("renameSync", /legacy-json\//, 1), "m1-resume"],
  ["M2 fixed .bak rename", P("renameSync", /legacy-json\//, 2), "m1-resume"],
  ["M3 publication", P("renameSync", /migration-v1\.json$/, 5), "m2-resume"],
  ["M5 publication", P("renameSync", /migration-v1\.json$/, 7), "m4-resume"],
  ["M4→M5 staging rename", P("renameSync", /state\.db\.migrate\./, 1), "m4-resume"],
  ["M7 control retirement", P("unlinkSync", /migration-v1\.json$/, 1), "m7"],
];

for (const [label, point, row] of ESCAPING) {
  test(`ENOSPC at ${label} escapes untyped, but fails closed and re-runs clean`, async () => {
    const { root, outcome, escaped } = await faulted("e", point, { kind: "errno", code: "ENOSPC" });
    expect(outcome, "no MigrationOutcome is produced at this site").toBeUndefined();
    expect(escaped).toBe("ENOSPC");
    // Fail-closed: the workspace is on an ordinary resume row, no halt was
    // manufactured, and a plain re-run converges once the condition clears.
    expect(await classify(root)).toBe(row);
    for (const fault of live.splice(0).reverse()) fault.restore();
    expect(await under(root, (entry) => runMigration(root, entry))).toMatchObject({ kind: "migrated" });
  });
}

// ---------------------------------------------------------------------------
// EIO. No phase claims a row for it, so this asserts that it fails CLOSED
// rather than assuming: it never buys a space-shaped verdict, and where the
// production code is errno-agnostic it produces the identical durable halt.

test("EIO never yields a space-shaped halt at a site where ENOSPC does", async () => {
  for (const label of ["M6 reserve removal", "M6 emergency removal", "M6 cursor publication"]) {
    const row = TYPED.find((r) => r.label === label)!;
    const { root, outcome, escaped } = await faulted("eio", row.point, { kind: "errno", code: "EIO" });
    // `cleanup.ts`'s `isOutOfSpace` is a closed two-code test, so EIO is
    // rethrown rather than dressed up as a deferral it is not.
    expect(outcome).toBeUndefined();
    expect(escaped).toBe("EIO");
    expect(await classify(root)).toBe("m6-cleanup");
    for (const fault of live.splice(0).reverse()) fault.restore();
    expect(await under(root, (entry) => runMigration(root, entry))).toMatchObject({ kind: "migrated" });
  }
});

test("EIO at an errno-agnostic site produces the same durable halt ENOSPC does", async () => {
  for (const label of ["M5→M6 the authority rename", "M1 claimed-reserve reread"]) {
    const row = TYPED.find((r) => r.label === label)!;
    const { root, outcome } = await faulted("eioh", row.point, { kind: "errno", code: "EIO" });
    expect(outcome).toMatchObject({ kind: "halted", durableHalt: true });
    const halt = (outcome as Extract<MigrationOutcome, { kind: "halted" }>).halt;
    expect(halt.code).toBe(row.code);
    expect(halt.code === "filesystem-full" || halt.code === "cleanup-deferred").toBe(false);
    for (const fault of live.splice(0).reverse()) fault.restore();
    expect(await under(root, (entry) => retryHaltedMigration(root, entry))).toMatchObject({ kind: "migrated" });
  }
});

// ---------------------------------------------------------------------------
// 3C's cleanup runway: a SHORT WRITE, which is how a real `ENOSPC` on a large
// write reaches the caller. `cleanup-runway.ts:167` synthesizes the errno from
// the shortfall rather than from a thrown code.

test("a short write to a prepared runway slot defers cleanup and stays resumable", async () => {
  const anchor = await migratable("anchor");
  const counter = arm({ syscall: "writeSync", nth: Number.MAX_SAFE_INTEGER }, { kind: "kill" });
  await under(anchor, (entry) => runMigration(anchor, entry));
  // Anchors the two `nth` values below: `writeSync` carries no string argument,
  // so a runway slot can only be named by its ordinal, and an ordinal is a lie
  // unless the trace it indexes is pinned.
  expect(counter.matches()).toBe(25);
  for (const fault of live.splice(0).reverse()) fault.restore();

  for (const nth of [22, 24]) {
    const { root, outcome, escaped } = await faulted(
      `runway${nth}`, { syscall: "writeSync", nth }, { kind: "short-write", bytes: 1 },
    );
    expect(escaped).toBeUndefined();
    expect(outcome).toMatchObject({ kind: "halted", durableHalt: false });
    const halt = (outcome as Extract<MigrationOutcome, { kind: "halted" }>).halt;
    expect(halt.code).toBe("cleanup-deferred");
    expect(halt.underlyingCode).toBe("ENOSPC");
    // §5.4: the failed halt publication advances nothing. The row is unchanged.
    expect(await classify(root)).toBe("m6-cleanup");
    for (const fault of live.splice(0).reverse()) fault.restore();
    expect(await under(root, (entry) => runMigration(root, entry))).toMatchObject({ kind: "migrated" });
  }
});

// ---------------------------------------------------------------------------
// §7.2 — "a failed halt publication is the final mutation of the trace".
//
// The ordering observer is built out of the rig's own matcher seam:
// `installStatePlaneFault` consults `match.test(args)` on every call to its
// syscall before it decides anything, so a matcher that always answers `false`,
// installed at an `nth` no run reaches, alters nothing and yields an ordered
// log. Install order matters: the tap goes on AFTER the fault so it wraps it and
// therefore sees the call that is about to fail.

const MUTATORS = ["renameSync", "unlinkSync", "writeFileSync", "ftruncateSync", "rmSync", "copyFileSync"];

function tapMutations(root: string, sink: (entry: string) => void): void {
  for (const syscall of MUTATORS) {
    const match = {
      test: (subject: string) => {
        if (subject.includes(root)) sink(`${syscall} ${subject}`);
        return false;
      },
    } as unknown as RegExp;
    arm({ syscall, match, nth: Number.MAX_SAFE_INTEGER }, { kind: "kill" });
  }
}

test("a failed halt publication is the final mutation of the trace", async () => {
  const root = await migratable("final");
  const log: string[] = [];
  let atFailure: Record<string, string> | undefined;
  let publications = 0;
  // 18 is M6's final-intent promotion; the trace's length is pinned by
  // `crash-matrix.test.ts`'s 19th-publication negative control.
  arm(P("renameSync", /migration-v1\.json$/, 18), { kind: "errno", code: "ENOSPC" });
  tapMutations(root, (entry) => {
    log.push(entry);
    if (entry.startsWith("renameSync") && /migration-v1\.json$/.test(entry) && ++publications === 18) {
      atFailure = rboxResidue(root);
    }
  });

  const outcome = await under(root, (entry) => runMigration(root, entry));
  for (const fault of live.splice(0).reverse()) fault.restore();

  expect(outcome).toMatchObject({ kind: "halted", durableHalt: false });
  expect((outcome as Extract<MigrationOutcome, { kind: "halted" }>).halt.code).toBe("durability-indeterminate");
  // No subsequent write, by trace AND by whole-tree snapshot.
  expect(publications).toBe(18);
  expect(log.at(-1)).toBe(log.filter((e) => /renameSync .*migration-v1\.json$/.test(e)).at(-1));
  expect(atFailure).toBeDefined();
  expect(rboxResidue(root)).toEqual(atFailure!);
  // And nothing advanced: the row is exactly where the halt found it.
  expect(await classify(root)).toBe("m6-cleanup");
  expect(await under(root, (entry) => runMigration(root, entry))).toMatchObject({ kind: "migrated" });
});
