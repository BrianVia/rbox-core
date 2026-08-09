/**
 * M-6: M5, the Q ladder, and the authority flip.
 *
 * Three properties are what this suite exists for, and each is proven against
 * real on-disk state rather than a mock.
 *
 * 1. **The kill matrix.** Every instant of M5 -> ladder -> flip is enumerated as
 *    an on-disk image, the classifier is asked what it sees, and the mutator is
 *    re-entered on that image. Resume must converge without repeating a
 *    destructive step. `killMatrix` below is that table.
 * 2. **The flip's ordering has a negative control.** The suite performs the
 *    INVERTED order — publish M6, then rename — inline, and shows the crash
 *    between the two produces the bad state the real order cannot. A guard
 *    nobody can show failing is a guard nobody has tested.
 * 3. **The cleanup vector is consumed by its real consumer.** The M6 control
 *    this lane publishes is handed to `stepCleanup`, not to an assertion about
 *    its shape, because the two hazards 222 §M-8 names (a copied path, a
 *    whole-file digest where the 128 header bytes belong) both satisfy the codec
 *    and fail only at the door of the module that removes the file.
 *
 * Inode fixtures are CONSTRUCTED and ASSERTED, never assumed: `inode-fixtures.ts`
 * builds "a different inode is now here" by renaming a live sibling over the
 * original, because a filesystem that recycles inode numbers makes an
 * unlink-recreate fixture assert nothing (FLAKE-006).
 */
import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTHORITY_MARKER_BYTES, authorityMarkerBytes } from "../authority-marker.js";
import { MigrationControlError, MigrationPhaseHaltError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths, sqliteResetPaths, statePath } from "../paths.js";
import { flipAuthority } from "./authority-flip.js";
import { classifyMigrationState, PhaseReceipt } from "./classifier.js";
import { stepCleanup } from "./cleanup.js";
import {
  blocksSqliteWrites, encodeMigrationControl,
  type MigrationControl, type MigrationWitness, type SourceWitness, type StagingProof,
} from "./control-codec.js";
import { publishMigrationControl, readCanonicalControl } from "./control-publication.js";
import { publishPreparedDatabase, stepQSibling } from "./finalize.js";
import { inodeOf, replaceUnderNewInode } from "./inode-fixtures.js";
import { buildReserveHeader, RESERVE_HEADER_BYTES } from "./reserve.js";

const ID = "m4a";
const AUTHORITY = "0123456789abcdef0123456789abcdef";
const MARKER = authorityMarkerBytes(AUTHORITY);
const MARKER_SHA = digest(MARKER);
const DB_BYTES = Buffer.from("not-really-sqlite-but-nothing-here-opens-it");
const LEGACY = Buffer.from(JSON.stringify({ version: 1, files: {} }));
const locks = {} as unknown as HeldStatePlaneLocks;

function digest(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const receipt = (control: MigrationControl): PhaseReceipt => PhaseReceipt.observe(control);

const spies: { restore: () => void }[] = [];
/** Replace one `fs` entry point for the length of a test. */
function inject<K extends keyof typeof fs>(key: K, replacement: (typeof fs)[K]): void {
  const original = fs[key];
  Object.defineProperty(fs, key, { configurable: true, writable: true, value: replacement });
  spies.push({ restore: () => { Object.defineProperty(fs, key, { configurable: true, writable: true, value: original }); } });
}
afterEach(() => {
  while (spies.length > 0) spies.pop()!.restore();
});

const enospc = (): NodeJS.ErrnoException => Object.assign(new Error("no space"), { code: "ENOSPC" });

/** Run `plant` in the instant before `claimSibling`'s exclusive create — the only
 * instant that reaches the descriptor-side re-proof rather than the observation
 * one layer above it. */
function plantOnCreate(fx: Fixture, plant: () => void): void {
  const realOpen = fs.openSync as unknown as (...a: unknown[]) => number;
  let planted = false;
  inject("openSync", ((file: unknown, flags: unknown, ...rest: unknown[]) => {
    if (!planted && file === fx.sibling && typeof flags === "number"
      && (flags & fs.constants.O_CREAT) !== 0) {
      planted = true;
      plant();
    }
    return realOpen(file, flags, ...rest);
  }) as unknown as typeof fs.openSync);
}

/** Every path under `.rbox` with its size, inode, and mtime — so a file that
 * appeared and was removed, or a pure `utimes` bump, still fails the zero-write
 * assertion. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = path.join(root, ".rbox");
  for (const entry of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const file = path.join(dir, entry);
    // `{ bigint: true }` is what makes `mtimeNs` exist at all: the ordinary Stats
    // has no such field, so the earlier spelling compared the string "undefined"
    // on every row and asserted nothing about modification times.
    const stat = fs.lstatSync(file, { bigint: true });
    // Directories carry their mtime too: a refusal that created a file and then
    // unlinked it leaves no trace in the file rows, but it moved the parent's
    // mtime. No path in this lane does that today, and this is what would say so.
    out[entry] = stat.isFile()
      ? `${stat.size}:${inodeOf(file)}:${stat.mtimeNs}`
      : `dir:${stat.mode}:${stat.mtimeNs}`;
  }
  return out;
}

interface Fixture {
  root: string;
  stateDir: string;
  staging: string;
  active: string;
  sibling: string;
  reserve: string;
  emergency: string;
  reserveHeader: Buffer;
  proof: StagingProof;
  control: MigrationControl;
}

interface Overrides {
  /** The phase the published control records. */
  phase?: "M4" | "M5";
  /** Where the database is when the fixture is handed over. */
  database?: "staging" | "active" | "both" | "neither";
  qDisposition?: Extract<MigrationWitness, { phase: "M5" }>["qSibling"]["disposition"];
  /** Bytes to put at the Q sibling path before publishing the control. */
  siblingBytes?: { bytes: Buffer; mode?: number };
  over?: (control: MigrationControl) => MigrationControl;
}

/**
 * A workspace at the end of M4 (or M5), with a real legacy document, real
 * preamble-prefixed backups at their derived paths, a real reserve carrying a
 * real 128-byte header, and a real emergency candidate.
 *
 * Nothing here is a SQLite database, and nothing needs to be: M-6 decides every
 * question about the store from its physical bytes, which is the ownership rule
 * this lane inherits (163 v13).
 */
function fixture(options: Overrides = {}): Fixture {
  const { phase = "M4", database = phase === "M4" ? "staging" : "active" } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-u3-4a-"));
  const stateDir = path.join(root, ".rbox", "state");
  fs.mkdirSync(path.join(stateDir, "legacy-json"), { recursive: true });

  fs.writeFileSync(statePath(root), LEGACY);
  const sourceStat = fs.lstatSync(statePath(root));
  const source = {
    path: statePath(root), dev: Number(sourceStat.dev), ino: Number(sourceStat.ino),
    bytes: LEGACY.byteLength, sha256: digest(LEGACY), mtimeNs: fs.lstatSync(statePath(root), { bigint: true }).mtimeNs.toString(),
  };

  const backupBytes = Buffer.concat([Buffer.from(`RBOX-LEGACY-STATE-BACKUP-v1 ${source.sha256}\n`), LEGACY]);
  const witnessFor = (file: string) => {
    fs.writeFileSync(file, backupBytes);
    const stat = fs.lstatSync(file);
    return { path: file, dev: Number(stat.dev), ino: Number(stat.ino), bytes: backupBytes.byteLength, sha256: digest(backupBytes) };
  };
  const history = witnessFor(migrationPaths.backupHistory(root, source.sha256));
  const fixedBackup = witnessFor(migrationPaths.fixedBackup(root));

  const reserveHeader = buildReserveHeader("2.0.0", "b".repeat(64));
  const reserveBytes = Buffer.concat([reserveHeader, Buffer.alloc(512, 7)]);
  const reserve = migrationPaths.reserve(root);
  fs.writeFileSync(reserve, reserveBytes);
  const reserveStat = fs.lstatSync(reserve);
  const emergencyBytes = Buffer.alloc(64, 3);
  const emergency = migrationPaths.emergency(root, ID);
  fs.writeFileSync(emergency, emergencyBytes);
  const emergencyStat = fs.lstatSync(emergency);

  const staging = migrationPaths.staging(root, ID);
  const active = sqliteResetPaths.active(root);
  if (database === "staging" || database === "both") fs.writeFileSync(staging, DB_BYTES);
  if (database === "active" || database === "both") fs.writeFileSync(active, DB_BYTES);
  // The recorded staging identity is the inode M3 claimed. When the fixture hands
  // over an already-renamed database it is the ACTIVE file that holds it.
  const holder = database === "active" ? active : staging;
  const holderStat = database === "neither" ? undefined : fs.lstatSync(holder);
  const stagingMain = holderStat
    ? { state: "present" as const, dev: Number(holderStat.dev), ino: Number(holderStat.ino) }
    : { state: "present" as const, dev: 1, ino: 1 };

  const proof: StagingProof = {
    sha256: digest(DB_BYTES), bytes: DB_BYTES.byteLength,
    semanticDigest: "c".repeat(64), entryCount: 1, repoCount: 0, proofVersion: 1,
  };

  if (options.siblingBytes) {
    fs.writeFileSync(migrationPaths.qSibling(root, ID), options.siblingBytes.bytes,
      options.siblingBytes.mode === undefined ? {} : { mode: options.siblingBytes.mode });
  }

  const layers = [
    { admission: { sourceBytes: LEGACY.byteLength, requiredBytes: 512, budgetBytes: 4096 } },
    { history, fixedBackup, stagingMain },
    {
      completion: {
        migrationId: ID, importerVersion: "2.0.0", authorityId: AUTHORITY,
        sourceJsonSha256: source.sha256, sourceSemanticDigest: "c".repeat(64),
        sourceBytes: LEGACY.byteLength, entryCount: 1, repoCount: 0,
        perTableCounts: { files: 1 }, completedAt: 5,
      },
    },
    { staging: proof },
    {
      active: proof,
      qSibling: {
        path: migrationPaths.qSibling(root, ID), bytes: 58 as const, sha256: MARKER_SHA,
        disposition: options.qDisposition ?? { state: "absent" as const },
      },
    },
  ];
  const depth = phase === "M4" ? 4 : 5;
  const witness = Object.assign({ phase }, ...layers.slice(0, depth)) as MigrationWitness;

  const draft: MigrationControl = {
    version: 1, controlRevision: 1, migrationId: ID, authorityId: AUTHORITY,
    source, stagingPath: staging, witness,
    haltResources: {
      reserve: {
        disposition: "available", dev: Number(reserveStat.dev), ino: Number(reserveStat.ino),
        bytes: reserveBytes.byteLength, sha256: digest(reserveBytes),
      },
      emergency: {
        disposition: "available", dev: Number(emergencyStat.dev), ino: Number(emergencyStat.ino),
        bytes: emergencyBytes.byteLength, sha256: digest(emergencyBytes),
      },
    },
    halt: null, retirement: null,
  };
  const control = publishMigrationControl(
    root, { migrationId: "absent", revision: "absent" },
    options.over ? options.over(draft) : draft, locks,
  );
  return {
    root, stateDir, staging, active, sibling: migrationPaths.qSibling(root, ID),
    reserve, emergency, reserveHeader, proof, control,
  };
}

/** Refuse, and prove `.rbox` is byte-identical to what it was. */
async function refusesWithoutWriting(
  fx: Fixture, run: () => Promise<unknown>, match: RegExp,
): Promise<MigrationPhaseHaltError> {
  const before = snapshot(fx.root);
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, "the call was expected to refuse").toBeInstanceOf(MigrationPhaseHaltError);
  const halt = caught as MigrationPhaseHaltError;
  expect(halt.message).toMatch(match);
  expect(halt.wrote, "a pre-mutation refusal must report wrote: false").toBe(false);
  expect(snapshot(fx.root), "the refusal mutated .rbox").toEqual(before);
  return halt;
}

/** Drive `absent -> building -> exact -> ready`, returning the final control. */
async function ladderToReady(fx: Fixture, from: MigrationControl): Promise<MigrationControl> {
  let current = from;
  for (let guard = 0; guard < 5; guard++) {
    const step = await stepQSibling(fx.root, receipt(current), locks);
    current = step.control;
    if (step.kind === "ready") return current;
  }
  throw new Error("the Q ladder never became ready");
}

/** An M5 control whose sibling is exact and whose database sits at the active
 * name: the state the flip runs from. */
async function readyToFlip(options: Overrides = {}): Promise<{ fx: Fixture; control: MigrationControl }> {
  const fx = fixture({ phase: "M4", ...options });
  const m5 = await publishNextPhase(fx);
  return { fx, control: await ladderToReady(fx, m5) };
}

/**
 * Drive the flip so the authority rename LANDS and M6's publication does not,
 * leaving 163's sole M6-artifact-ahead image: `Q` live, control still M5, sibling
 * absent. Returns the durable control as a restarted process would read it.
 */
async function killAfterTheRename(fx: Fixture, control: MigrationControl): Promise<MigrationControl> {
  const realRename = fs.renameSync as unknown as (a: unknown, b: unknown) => void;
  let renames = 0;
  inject("renameSync", ((from: unknown, to: unknown) => {
    renames += 1;
    if (renames === 2) throw enospc();
    return realRename(from, to);
  }) as unknown as typeof fs.renameSync);
  try {
    await flipAuthority(fx.root, receipt(control), locks);
    throw new Error("the publication was expected to fail");
  } catch (error) {
    if (!(error instanceof MigrationPhaseHaltError)) throw error;
  } finally {
    spies.pop()!.restore();
  }
  const durable = readCanonicalControl(fx.root)!;
  if (durable.witness.phase !== "M5") throw new Error("the fixture did not strand the flip at M5");
  return durable;
}

/** Re-publish the control with the source witness the live document now has, for
 * fixtures that need the document to be something other than what `fixture()`
 * wrote. */
function republishSource(fx: Fixture, bytes: Buffer): MigrationControl {
  const stat = fs.lstatSync(statePath(fx.root), { bigint: true });
  const sha256 = digest(bytes);
  // The history entry is content-addressed by the source digest, so a different
  // source means a different derived path — the backups have to move with it or the
  // derivation check refuses before the test reaches what it is about.
  const backupBytes = Buffer.concat([Buffer.from(`RBOX-LEGACY-STATE-BACKUP-v1 ${sha256}\n`), bytes]);
  const rewrite = (file: string) => {
    fs.rmSync(migrationPaths.backupHistory(fx.root, digest(LEGACY)), { force: true });
    fs.writeFileSync(file, backupBytes);
    const found = fs.lstatSync(file);
    return {
      path: file, dev: Number(found.dev), ino: Number(found.ino),
      bytes: backupBytes.byteLength, sha256: digest(backupBytes),
    };
  };
  const next: MigrationControl = {
    ...fx.control,
    controlRevision: fx.control.controlRevision + 1,
    source: {
      path: statePath(fx.root), dev: Number(stat.dev), ino: Number(stat.ino),
      bytes: bytes.byteLength, sha256, mtimeNs: stat.mtimeNs.toString(),
    },
    witness: {
      ...(fx.control.witness as object),
      history: rewrite(migrationPaths.backupHistory(fx.root, sha256)),
      fixedBackup: rewrite(migrationPaths.fixedBackup(fx.root)),
      completion: {
        ...(fx.control.witness as { completion: object }).completion,
        sourceJsonSha256: sha256,
      },
    } as MigrationWitness,
  };
  return publishMigrationControl(
    fx.root, { migrationId: ID, revision: fx.control.controlRevision }, next, locks,
  );
}

/** Run M5 and publish its witness the way M-9 will. */
async function publishNextPhase(fx: Fixture): Promise<MigrationControl> {
  const witness = await publishPreparedDatabase(fx.root, receipt(fx.control), locks);
  const next: MigrationControl = {
    ...fx.control,
    controlRevision: fx.control.controlRevision + 1,
    witness: { ...(fx.control.witness as object), phase: "M5", ...witness } as MigrationWitness,
  };
  return publishMigrationControl(
    fx.root, { migrationId: ID, revision: fx.control.controlRevision }, next, locks,
  );
}

// ---------------------------------------------------------------------------

describe("M5 — the prepared database takes the active name", () => {
  test("renames staging over state.db and prebinds the Q sibling absent", async () => {
    const fx = fixture();
    const staged = inodeOf(fx.staging);
    const witness = await publishPreparedDatabase(fx.root, receipt(fx.control), locks);

    expect(fs.existsSync(fx.staging), "the staging name is gone").toBe(false);
    expect(inodeOf(fx.active), "the active name holds the staging inode").toBe(staged);
    expect(witness.active).toEqual(fx.proof);
    expect(witness.qSibling).toEqual({
      path: fx.sibling, bytes: AUTHORITY_MARKER_BYTES, sha256: MARKER_SHA, disposition: { state: "absent" },
    });
    // 163:2748: the M5 witness records the staging name absent, because M5 is what
    // emptied it. Keeping M3's `present` would not merely be stale — it makes C1
    // retirement from M5 impossible, since `retirement.ts` reads this member,
    // finds the staging name empty at a phase that is not M4, and refuses.
    expect(witness.stagingMain).toEqual({ state: "absent" });
    // Deterministic: the witness is a pure function of the M4 proof and the
    // authority id, so a crash in the publisher's render -> rename window strands
    // exactly the record the next attempt renders.
    expect(await publishPreparedDatabase(fx.root, receipt(fx.control), locks)).toEqual(witness);
  });

  test("resumes an active-only image without renaming anything", async () => {
    const fx = fixture({ database: "active" });
    const before = inodeOf(fx.active);
    const witness = await publishPreparedDatabase(fx.root, receipt(fx.control), locks);
    expect(inodeOf(fx.active), "active never moves backward").toBe(before);
    expect(witness.active).toEqual(fx.proof);
  });

  test("removes only the redundant staging name when a crash left both", async () => {
    const fx = fixture({ database: "both" });
    const settled = inodeOf(fx.active);
    const redundant = inodeOf(fx.staging);
    expect(redundant, "the fixture must give the two names distinct inodes").not.toBe(settled);

    await publishPreparedDatabase(fx.root, receipt(fx.control), locks);
    expect(fs.existsSync(fx.staging)).toBe(false);
    expect(inodeOf(fx.active), "the settled database is the one that stays").toBe(settled);
  });

  test("refuses when neither name holds the proven database", async () => {
    const fx = fixture({ database: "neither" });
    await refusesWithoutWriting(
      fx, () => publishPreparedDatabase(fx.root, receipt(fx.control), locks),
      /neither the staging nor the active name holds the database M4 proved/,
    );
  });

  test("refuses an active file that is not the database M4 proved", async () => {
    const fx = fixture({ database: "active" });
    fs.writeFileSync(fx.active, Buffer.concat([DB_BYTES, Buffer.from("!")]));
    await refusesWithoutWriting(
      fx, () => publishPreparedDatabase(fx.root, receipt(fx.control), locks),
      /is not the database this migration proved/,
    );
  });

  test.each(["-wal", "-shm", "-journal"])("refuses a %s sidecar beside staging", async (suffix) => {
    const fx = fixture();
    fs.writeFileSync(`${fx.staging}${suffix}`, "leftover");
    await refusesWithoutWriting(
      fx, () => publishPreparedDatabase(fx.root, receipt(fx.control), locks),
      /carries sidecars, which M4 left at rest/,
    );
  });

  test("refuses a staging file at an inode other than the recorded one", async () => {
    const fx = fixture();
    const recorded = inodeOf(fx.staging);
    const swapped = replaceUnderNewInode(fx.staging, DB_BYTES);
    expect(swapped, "the fixture must actually produce a different inode").not.toBe(recorded);
    await refusesWithoutWriting(
      fx, () => publishPreparedDatabase(fx.root, receipt(fx.control), locks),
      /is not the staging inode this migration recorded/,
    );
  });

  test("refuses once the legacy document is no longer the one M0 recorded", async () => {
    const fx = fixture();
    replaceUnderNewInode(statePath(fx.root), LEGACY);
    await refusesWithoutWriting(
      fx, () => publishPreparedDatabase(fx.root, receipt(fx.control), locks),
      /the legacy document is no longer the one this migration recorded/,
    );
  });

  test("refuses an authority id that cannot be published as a marker", async () => {
    // `id` charset admits it; the 32-lowercase-hex marker does not. Without the
    // refusal the witness would prebind a digest of 58 zero bytes.
    const fx = fixture({ over: (control) => ({ ...control, authorityId: "not-hex-at-all" }) });
    await refusesWithoutWriting(
      fx, () => publishPreparedDatabase(fx.root, receipt(fx.control), locks),
      /cannot be published as an authority marker/,
    );
  });

  test("refuses a non-regular occupant at the active name", async () => {
    const fx = fixture();
    fs.mkdirSync(sqliteResetPaths.active(fx.root));
    await refusesWithoutWriting(
      fx, () => publishPreparedDatabase(fx.root, receipt(fx.control), locks),
      /is not a regular file/,
    );
  });

  test.each([
    ["publishPreparedDatabase", (fx: Fixture, control: MigrationControl) =>
      publishPreparedDatabase(fx.root, receipt(control), locks), "M4"],
    ["stepQSibling", (fx: Fixture, control: MigrationControl) =>
      stepQSibling(fx.root, receipt(control), locks), "M5"],
    ["flipAuthority", (fx: Fixture, control: MigrationControl) =>
      flipAuthority(fx.root, receipt(control), locks), "M5"],
  ])("%s refuses a receipt for the wrong phase", async (_label, run, expected) => {
    // `requirePhase` is the seam that makes a stale or mis-dispatched receipt
    // unusable. Without it a phase body would act on another phase's witness.
    const fx = fixture({ phase: expected === "M4" ? "M5" : "M4" });
    await expect(run(fx, fx.control)).rejects.toThrow(
      new RegExp(`requires an exact ${expected} receipt`),
    );
  });

  test("refuses if the redundant staging name survives its own removal", async () => {
    // 163's "require staging absent" after convergence. Injected because the
    // only way to reach it is an unlink that reports success and does nothing.
    const fx = fixture({ database: "both" });
    const realUnlink = fs.unlinkSync as unknown as (p: unknown) => void;
    inject("unlinkSync", ((target: unknown) => {
      if (target === fx.staging) return;
      return realUnlink(target);
    }) as unknown as typeof fs.unlinkSync);
    await expect(publishPreparedDatabase(fx.root, receipt(fx.control), locks))
      .rejects.toThrow(/still holds a file after the active name was published/);
  });

  test("reports a database that will not come to rest as a durability question", async () => {
    // A sidecar appears after the pre-check, in the instant between the rename
    // and the at-rest requirement — the one shape `S0` exists to catch.
    const fx = fixture();
    const realRename = fs.renameSync as unknown as (a: unknown, b: unknown) => void;
    inject("renameSync", ((from: unknown, to: unknown) => {
      realRename(from, to);
      if (to === fx.active) fs.writeFileSync(`${fx.active}-wal`, "appeared");
    }) as unknown as typeof fs.renameSync);
    let caught: unknown;
    try {
      await publishPreparedDatabase(fx.root, receipt(fx.control), locks);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationPhaseHaltError);
    const halt = caught as MigrationPhaseHaltError;
    expect(halt.halt.code).toBe("durability-indeterminate");
    expect(halt.wrote, "the rename already happened").toBe(true);
  });

  test("brackets the active identity across the rename", async () => {
    // The published database must be the inode that was proved. Injected: the
    // rename lands and something swaps the file underneath it.
    const fx = fixture();
    const realRename = fs.renameSync as unknown as (a: unknown, b: unknown) => void;
    // `replaceUnderNewInode` renames too, so the spy has to stand aside for its
    // own nested call or it recurses forever.
    let swapping = false;
    inject("renameSync", ((from: unknown, to: unknown) => {
      realRename(from, to);
      if (to === fx.active && !swapping) {
        swapping = true;
        replaceUnderNewInode(fx.active, DB_BYTES);
      }
    }) as unknown as typeof fs.renameSync);
    await expect(publishPreparedDatabase(fx.root, receipt(fx.control), locks))
      .rejects.toThrow(/is not the database this phase published/);
  });

  test("refuses a staging path the migration id does not derive to", async () => {
    const decoy = "state.db.migrate.somebody-else";
    const fx = fixture({
      over: (control) => ({ ...control, stagingPath: path.join(path.dirname(control.stagingPath), decoy) }),
    });
    await refusesWithoutWriting(
      fx, () => publishPreparedDatabase(fx.root, receipt(fx.control), locks),
      /staging path is not the one its migration id derives to/,
    );
  });
});

// ---------------------------------------------------------------------------

describe("the Q ladder", () => {
  test("claims, writes, and finishes — absent -> building -> exact -> ready", async () => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);

    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    expect(claimed.kind).toBe("claimed");
    const claimedWitness = claimed.control.witness as Extract<MigrationWitness, { phase: "M5" }>;
    expect(claimedWitness.qSibling.disposition.state).toBe("building");
    expect(fs.lstatSync(fx.sibling).size, "a claimed sibling holds no bytes yet").toBe(0);
    expect(fs.lstatSync(fx.sibling).mode & 0o7777).toBe(0o600);
    const claimedInode = inodeOf(fx.sibling);

    const written = await stepQSibling(fx.root, receipt(claimed.control), locks);
    expect(written.kind).toBe("written");
    const writtenWitness = written.control.witness as Extract<MigrationWitness, { phase: "M5" }>;
    expect(writtenWitness.qSibling.disposition.state).toBe("exact");
    expect(inodeOf(fx.sibling), "the marker is written into the recorded inode").toBe(claimedInode);
    expect(fs.readFileSync(fx.sibling)).toEqual(MARKER);

    const ready = await stepQSibling(fx.root, receipt(written.control), locks);
    expect(ready.kind).toBe("ready");
    expect(ready.control.controlRevision, "a ready rung publishes nothing")
      .toBe(written.control.controlRevision);
  });

  test("adopts the sole zero-byte create-ahead rather than replacing it", async () => {
    const fx = fixture({ siblingBytes: { bytes: Buffer.alloc(0), mode: 0o600 } });
    const ahead = inodeOf(fx.sibling);
    const m5 = await publishNextPhase(fx);
    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    expect(inodeOf(fx.sibling), "the create-ahead inode is adopted, not replaced").toBe(ahead);
    const witness = claimed.control.witness as Extract<MigrationWitness, { phase: "M5" }>;
    expect(witness.qSibling.disposition).toMatchObject({ state: "building" });
  });

  test("refuses a world-readable zero-byte occupant", async () => {
    const fx = fixture({ siblingBytes: { bytes: Buffer.alloc(0), mode: 0o644 } });
    const m5 = await publishNextPhase(fx);
    const before = snapshot(fx.root);
    await expect(stepQSibling(fx.root, receipt(m5), locks))
      .rejects.toThrow(/neither absent nor the sole zero-byte create-ahead/);
    expect(snapshot(fx.root)).toEqual(before);
  });

  test("rewrites a partial building image into the exact marker on the same inode", async () => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    // The power-loss image a `building` rung admits: some prefix of the marker.
    fs.writeFileSync(fx.sibling, MARKER.subarray(0, 20));
    const inode = inodeOf(fx.sibling);

    const written = await stepQSibling(fx.root, receipt(claimed.control), locks);
    expect(written.kind).toBe("written");
    expect(inodeOf(fx.sibling)).toBe(inode);
    expect(fs.readFileSync(fx.sibling)).toEqual(MARKER);
  });

  test("accepts the sole finish-ahead image: building recorded, exact bytes on disk", async () => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    fs.writeFileSync(fx.sibling, MARKER);
    // The spy is on the OPEN, not on `writeSync`: the control publisher writes a
    // record on every rung, so a bare write spy proves nothing. Only `writeMarker`
    // opens the sibling for writing. Capture the real entry point before
    // replacing it — `fs.openSync` inside the replacement is the replacement.
    const realOpen = fs.openSync as unknown as (...a: unknown[]) => number;
    let openedForWriting = false;
    inject("openSync", ((file: unknown, flags: unknown, ...rest: unknown[]) => {
      if (file === fx.sibling && typeof flags === "number" && (flags & fs.constants.O_WRONLY) !== 0) {
        openedForWriting = true;
      }
      return realOpen(file, flags, ...rest);
    }) as unknown as typeof fs.openSync);

    const written = await stepQSibling(fx.root, receipt(claimed.control), locks);
    expect(written.kind).toBe("written");
    expect(openedForWriting, "a finish-ahead sibling is republished, not rewritten").toBe(false);
  });

  /**
   * `claimSibling`'s descriptor-side re-proof, one conjunct at a time.
   *
   * The occupant is planted ON THE EXCLUSIVE CREATE, because that is the only
   * instant that reaches this code: `observeQSibling` refuses the same three
   * shapes one layer earlier from the pathname, so a fixture that plants before
   * the ladder starts asserts on that layer instead and proves nothing here. The
   * two layers deliberately no longer share a message.
   *
   * Each fixture trips exactly ONE conjunct — an occupant that is both nonzero and
   * world-readable would pass whichever check survived a mutation.
   */
  test.each([
    ["a zero-byte occupant with the wrong mode", () => Buffer.alloc(0), 0o644, /its mode is 644/],
    ["a 0600 occupant with the wrong length", () => Buffer.from("x"), 0o600, /it holds 1 bytes/],
  ])("refuses %s planted on the exclusive create", async (_label, bytes, mode, match) => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    plantOnCreate(fx, () => fs.writeFileSync(fx.sibling, bytes(), { mode }));
    await expect(stepQSibling(fx.root, receipt(m5), locks)).rejects.toThrow(match);
    expect(fs.lstatSync(fx.sibling).isFile(), "the occupant is left exactly as it was").toBe(true);
    expect(fs.readFileSync(fx.sibling)).toEqual(bytes());
  });

  test("refuses a directory planted on the exclusive create", async () => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    plantOnCreate(fx, () => fs.mkdirSync(fx.sibling));
    await expect(stepQSibling(fx.root, receipt(m5), locks))
      .rejects.toThrow(/it is not a regular file/);
    expect(fs.lstatSync(fx.sibling).isDirectory(), "and it is still a directory").toBe(true);
  });

  test("refuses a symlink planted on the exclusive create", async () => {
    // O_NOFOLLOW's own test. The decoy is a legal create-ahead shape, so without
    // `O_NOFOLLOW` the reopen would stat the TARGET, adopt its inode, and write the
    // authority marker into a file this migration never claimed.
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const decoy = path.join(fx.stateDir, "sibling-decoy");
    fs.writeFileSync(decoy, Buffer.alloc(0), { mode: 0o600 });
    plantOnCreate(fx, () => fs.symlinkSync(decoy, fx.sibling));
    await expect(stepQSibling(fx.root, receipt(m5), locks))
      .rejects.toThrow(/is occupied by something this migration cannot claim \(ELOOP\)/);
    expect(fs.lstatSync(fx.sibling).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(decoy).size, "the decoy is never written").toBe(0);
  });

  test("re-proves the sibling's identity on the write descriptor itself", async () => {
    // The same race one rung later: the inode is swapped between the ladder's
    // observation and `writeMarker`'s open. Without the check the marker lands in
    // a file the durable record does not name.
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    const realOpen = fs.openSync as unknown as (...a: unknown[]) => number;
    let swapped = false;
    inject("openSync", ((file: unknown, flags: unknown, ...rest: unknown[]) => {
      if (!swapped && file === fx.sibling && typeof flags === "number"
        && (flags & fs.constants.O_WRONLY) !== 0) {
        swapped = true;
        replaceUnderNewInode(fx.sibling, Buffer.alloc(0), { mode: 0o600 });
      }
      return realOpen(file, flags, ...rest);
    }) as unknown as typeof fs.openSync);
    await expect(stepQSibling(fx.root, receipt(claimed.control), locks))
      .rejects.toThrow(/changed identity before the marker was written/);
  });

  test("reports a short marker write as a space problem, not a success", async () => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    const realWrite = fs.writeSync as unknown as (...a: unknown[]) => number;
    inject("writeSync", ((fd: unknown, buffer: unknown, ...rest: unknown[]) => {
      if (Buffer.isBuffer(buffer) && buffer.byteLength === AUTHORITY_MARKER_BYTES) {
        return realWrite(fd, buffer.subarray(0, 20), 0, 20, 0);
      }
      return realWrite(fd, buffer, ...rest);
    }) as unknown as typeof fs.writeSync);
    let caught: unknown;
    try {
      await stepQSibling(fx.root, receipt(claimed.control), locks);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationPhaseHaltError);
    expect((caught as MigrationPhaseHaltError).halt.code).toBe("filesystem-full");
    // And the partial image is a `building` image the next attempt finishes, not
    // a foreign one: same inode, fewer bytes.
    expect(fs.lstatSync(fx.sibling).size).toBe(20);
  });

  test("truncates the sibling to exactly 58 bytes rather than trusting its length", async () => {
    // Injected: the recorded inode grows past 58 between the observation and the
    // write. Without the truncate the reread finds 78 bytes and refuses; with it
    // the rung completes, which is the behaviour 163 asks for.
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    const realOpen = fs.openSync as unknown as (...a: unknown[]) => number;
    let grown = false;
    inject("openSync", ((file: unknown, flags: unknown, ...rest: unknown[]) => {
      if (!grown && file === fx.sibling && typeof flags === "number"
        && (flags & fs.constants.O_WRONLY) !== 0) {
        grown = true;
        const fd = realOpen(file, "r+");
        fs.writeSync(fd, Buffer.alloc(78, 0x5a), 0, 78, 0);
        fs.closeSync(fd);
      }
      return realOpen(file, flags, ...rest);
    }) as unknown as typeof fs.openSync);

    const written = await stepQSibling(fx.root, receipt(claimed.control), locks);
    expect(written.kind).toBe("written");
    expect(fs.readFileSync(fx.sibling), "trailing bytes are truncated away").toEqual(MARKER);
  });

  test("rereads the sibling rather than trusting the write it just made", async () => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    const realWrite = fs.writeSync as unknown as (...a: unknown[]) => number;
    inject("writeSync", ((fd: unknown, buffer: unknown, ...rest: unknown[]) => {
      if (Buffer.isBuffer(buffer) && buffer.byteLength === AUTHORITY_MARKER_BYTES) {
        // A write that reports full success and lands the wrong bytes.
        realWrite(fd, Buffer.alloc(AUTHORITY_MARKER_BYTES, 0x42), 0, AUTHORITY_MARKER_BYTES, 0);
        return AUTHORITY_MARKER_BYTES;
      }
      return realWrite(fd, buffer, ...rest);
    }) as unknown as typeof fs.writeSync);
    await expect(stepQSibling(fx.root, receipt(claimed.control), locks))
      .rejects.toThrow(/is not the marker just written/);
  });

  test.each([
    ["claimed", 0],
    ["written", 1],
  ])("brackets the source on the %s rung, not just at M5", async (_label, rungs) => {
    // M5's own `bracketSource` had a test; the ladder's did not. A rung that ran
    // on a changed document would build the marker for a migration whose source
    // has already moved on, which is C1's business and not the ladder's.
    const fx = fixture();
    let current = await publishNextPhase(fx);
    for (let i = 0; i < rungs; i++) {
      current = (await stepQSibling(fx.root, receipt(current), locks)).control;
    }
    replaceUnderNewInode(statePath(fx.root), LEGACY);
    await expect(stepQSibling(fx.root, receipt(current), locks))
      .rejects.toThrow(/the legacy document is no longer the one this migration recorded/);
  });

  test("refuses a building sibling that is no longer the recorded inode", async () => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    const recorded = inodeOf(fx.sibling);
    expect(replaceUnderNewInode(fx.sibling, Buffer.alloc(0), { mode: 0o600 })).not.toBe(recorded);
    await expect(stepQSibling(fx.root, receipt(claimed.control), locks))
      .rejects.toThrow(/is not the recorded Q-sibling inode/);
  });

  test("refuses an exact record whose sibling is gone", async () => {
    const fx = fixture();
    const ready = await ladderToReady(fx, await publishNextPhase(fx));
    fs.unlinkSync(fx.sibling);
    await expect(stepQSibling(fx.root, receipt(ready), locks))
      .rejects.toThrow(/is not the recorded Q-sibling inode/);
  });

  test("refuses a Q-sibling path this migration id does not derive to", async () => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const tampered = tamperM5(fx, m5, (q) => ({ ...q, path: path.join(fx.root, ".rbox", "state.json.migrate.other.q") }));
    await expect(stepQSibling(fx.root, receipt(tampered), locks))
      .rejects.toThrow(/is not the Q sibling this migration derives to/);
  });

  test("refuses a recorded digest that is not this authority's marker", async () => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const tampered = tamperM5(fx, m5, (q) => ({ ...q, sha256: "d".repeat(64) }));
    await expect(stepQSibling(fx.root, receipt(tampered), locks))
      .rejects.toThrow(/recorded under bytes that are not this authority's marker/);
  });
});

/** Republish the M5 control with an edited Q-sibling witness. The record on disk
 * has to be the tampered one, because that is the thing a mutator reads. */
function tamperM5(
  fx: Fixture, control: MigrationControl,
  edit: (q: Extract<MigrationWitness, { phase: "M5" }>["qSibling"]) => Extract<MigrationWitness, { phase: "M5" }>["qSibling"],
): MigrationControl {
  const witness = control.witness as Extract<MigrationWitness, { phase: "M5" }>;
  const next: MigrationControl = {
    ...control,
    controlRevision: control.controlRevision + 1,
    witness: { ...witness, qSibling: edit(witness.qSibling) },
  };
  return publishMigrationControl(
    fx.root, { migrationId: ID, revision: control.controlRevision }, next, locks,
  );
}

// ---------------------------------------------------------------------------

describe("the authority flip", () => {
  test("renames the exact sibling over the legacy document and publishes M6", async () => {
    const { fx, control } = await readyToFlip();
    const siblingInode = inodeOf(fx.sibling);

    const outcome = await flipAuthority(fx.root, receipt(control), locks);
    expect(outcome.kind).toBe("flipped");
    if (outcome.kind !== "flipped") throw new Error("unreachable");

    expect(fs.readFileSync(statePath(fx.root)), "`Q` is the sibling's own bytes").toEqual(MARKER);
    expect(inodeOf(statePath(fx.root)), "and its own inode: this is a rename, not a copy").toBe(siblingInode);
    expect(fs.existsSync(fx.sibling), "the sibling is gone from its own path").toBe(false);

    const witness = outcome.control.witness;
    expect(witness.phase).toBe("M6");
    if (witness.phase !== "M6") throw new Error("unreachable");
    expect(witness.qSibling.disposition).toEqual({ state: "absent" });
    expect(witness.futureControls).toBeNull();
    expect(witness.cleanup.durablePrefix).toBe(0);
    expect(witness.cleanup.currentIntent).toBeNull();
    expect(blocksSqliteWrites(outcome.control), "M6 lifts the write fence").toBe(false);
    expect(readCanonicalControl(fx.root)?.controlRevision).toBe(outcome.control.controlRevision);
  });

  test("derives every cleanup path from migrationPaths and never carries one", async () => {
    const { fx, control } = await readyToFlip();
    const outcome = await flipAuthority(fx.root, receipt(control), locks);
    if (outcome.kind !== "flipped") throw new Error("unreachable");
    const witness = outcome.control.witness;
    if (witness.phase !== "M6") throw new Error("unreachable");

    expect(witness.cleanup.items.map((item) => [item.role, item.path])).toEqual([
      ["reserve", migrationPaths.reserve(fx.root)],
      ["emergency", migrationPaths.emergency(fx.root, ID)],
    ]);
    for (const item of witness.cleanup.items) {
      expect(item.parent, "parent is the item's own directory: the fsync is aimed there")
        .toBe(path.dirname(item.path));
      expect({ dev: item.dev, ino: item.ino }).toEqual({
        dev: fs.lstatSync(item.path).dev, ino: fs.lstatSync(item.path).ino,
      } as unknown as { dev: number; ino: number });
    }
    // The emergency candidate is last, because it owns the allocation-free
    // runway and the runway belongs to the FINAL item (163:4926).
    expect(witness.cleanup.items.at(-1)!.role).toBe("emergency");
  });

  test("records the reserve's 128 header bytes, not its whole-file digest", async () => {
    const { fx, control } = await readyToFlip();
    const outcome = await flipAuthority(fx.root, receipt(control), locks);
    if (outcome.kind !== "flipped") throw new Error("unreachable");
    const witness = outcome.control.witness;
    if (witness.phase !== "M6") throw new Error("unreachable");
    const reserve = witness.cleanup.items[0]!;

    const whole = digest(fs.readFileSync(fx.reserve));
    expect(reserve.sha256, "the contract 222 §M-8 states verbatim").toBe(digest(fx.reserveHeader));
    expect(reserve.sha256, "and it is NOT the whole file").not.toBe(whole);
    expect(reserve.sha256, "nor haltResources.reserve.sha256, which IS the whole file")
      .not.toBe(outcome.control.haltResources.reserve.sha256);
    expect(outcome.control.haltResources.reserve.sha256, "the two quantities must not drift").toBe(whole);
    // The emergency candidate has no header rule, and `cleanup.ts` never reads a
    // digest for it — a stored one could only ever go stale unchecked.
    expect(witness.cleanup.items[1]!.sha256).toBeNull();
  });

  test("publishes a vector its real consumer accepts and can drive to the final intent", async () => {
    const { fx, control } = await readyToFlip();
    const outcome = await flipAuthority(fx.root, receipt(control), locks);
    if (outcome.kind !== "flipped") throw new Error("unreachable");

    const intent = await stepCleanup(fx.root, receipt(outcome.control), locks);
    expect(intent.kind).toBe("intent");
    if (intent.kind !== "intent") throw new Error("unreachable");
    expect(intent.control.haltResources.reserve.disposition).toBe("cleanup-intent");

    // The reserve's removal is where the 128-header rule is enforced. It only
    // passes because the digest above is the header's.
    const retired = await stepCleanup(fx.root, receipt(intent.control), locks);
    expect(retired.kind).toBe("retired");
    if (retired.kind !== "retired") throw new Error("unreachable");
    expect(fs.existsSync(fx.reserve)).toBe(false);

    const final = await stepCleanup(fx.root, receipt(retired.control), locks);
    expect(final.kind, "the emergency candidate is the runway's final item").toBe("final-intent");
  });

  test("a whole-file digest in the reserve slot is refused by cleanup — the hazard, shown", async () => {
    // NEGATIVE CONTROL for the header rule. Publish the vector 222 warns about —
    // the reserve item carrying `haltResources.reserve.sha256` — and show that
    // the consumer refuses to remove the file. Nothing in the codec catches it.
    const { fx, control } = await readyToFlip();
    const outcome = await flipAuthority(fx.root, receipt(control), locks);
    if (outcome.kind !== "flipped") throw new Error("unreachable");
    const witness = outcome.control.witness;
    if (witness.phase !== "M6") throw new Error("unreachable");

    const items = witness.cleanup.items.map((item, index) =>
      index === 0 ? { ...item, sha256: outcome.control.haltResources.reserve.sha256 } : item);
    const drifted: MigrationControl = {
      ...outcome.control,
      controlRevision: outcome.control.controlRevision + 1,
      witness: { ...witness, cleanup: { ...witness.cleanup, items } },
    };
    // It encodes and decodes cleanly: the schema cannot tell the two apart.
    expect(() => encodeMigrationControl(drifted)).not.toThrow();
    const published = publishMigrationControl(
      fx.root, { migrationId: ID, revision: outcome.control.controlRevision }, drifted, locks,
    );
    const intent = await stepCleanup(fx.root, receipt(published), locks);
    if (intent.kind !== "intent") throw new Error("unreachable");
    await expect(stepCleanup(fx.root, receipt(intent.control), locks))
      .rejects.toThrow(/does not carry the 128 reserve header bytes/);
    expect(fs.existsSync(fx.reserve), "and the reserve survives the mistake").toBe(true);
  });

  test("arms C1 instead of renaming when the source changed", async () => {
    const { fx, control } = await readyToFlip();
    replaceUnderNewInode(statePath(fx.root), LEGACY);
    const before = snapshot(fx.root);

    const outcome = await flipAuthority(fx.root, receipt(control), locks);
    expect(outcome.kind).toBe("arm-retirement");
    if (outcome.kind !== "arm-retirement") throw new Error("unreachable");
    expect(outcome.trigger.disposition).toBe("source-changed");
    expect(outcome.trigger.replacement.path).toBe(statePath(fx.root));
    expect(snapshot(fx.root), "a disposition renames nothing and publishes nothing").toEqual(before);
  });

  test("arms C1 with legacy-write-detected when the body digest moved off M3's", async () => {
    // The identity still matches what M0 recorded — same inode, same length,
    // same mtime — so only the LAST check, against the digest M3 imported, can
    // catch this. That is the microwindow the v9 ordering exists for.
    const { fx, control } = await readyToFlip({
      over: (draft) => ({
        ...draft,
        witness: {
          ...(draft.witness as object),
          completion: { ...(draft.witness as { completion: object }).completion, sourceJsonSha256: "e".repeat(64) },
        } as MigrationWitness,
      }),
    });
    const before = snapshot(fx.root);

    const outcome = await flipAuthority(fx.root, receipt(control), locks);
    expect(outcome.kind).toBe("arm-retirement");
    if (outcome.kind !== "arm-retirement") throw new Error("unreachable");
    expect(outcome.trigger.disposition).toBe("legacy-write-detected");
    if (outcome.trigger.disposition !== "legacy-write-detected") throw new Error("unreachable");
    expect(outcome.trigger.observedBodySha256).toBe(digest(LEGACY));
    expect(fs.readFileSync(statePath(fx.root)), "legacy JSON stays authority").toEqual(LEGACY);
    expect(snapshot(fx.root)).toEqual(before);
  });

  /** One recorded source field wrong at a time. `replaceUnderNewInode` moves the
   * inode AND the mtime AND the digest at once, so it cannot show which conjunct
   * of `sameSource` is load-bearing; tampering the RECORD one field at a time
   * can. Each must arm C1 rather than rename. */
  const sourceTamperCases: readonly (readonly [string, (root: string, source: SourceWitness) => SourceWitness])[] = [
    ["a path that is not the live document", (root: string, s: SourceWitness) =>
      ({ ...s, path: path.join(root, ".rbox", "state", "somewhere-else.json") })],
    ["an inode that is not the live document's", (_root: string, s: SourceWitness) =>
      ({ ...s, ino: s.ino + 100_000 })],
    ["a length the live document does not have", (_root: string, s: SourceWitness) =>
      ({ ...s, bytes: s.bytes + 1 })],
    ["an mtime the live document does not have", (_root: string, s: SourceWitness) =>
      ({ ...s, mtimeNs: "1" })],
    ["a digest the live document does not have", (_root: string, s: SourceWitness) =>
      ({ ...s, sha256: "f".repeat(64) })],
  ];
  test.each(sourceTamperCases)("arms C1 when the control records %s", async (_label, tamper) => {
    // The tamper lands AFTER the ladder: M5 and every rung call `bracketSource`,
    // so a control that already disagreed with the document could never have
    // reached the flip. This is the state where the document moved between the
    // last rung and the flip.
    const { fx, control } = await readyToFlip();
    const tampered = publishMigrationControl(
      fx.root, { migrationId: ID, revision: control.controlRevision },
      {
        ...control,
        controlRevision: control.controlRevision + 1,
        source: tamper(fx.root, control.source),
      }, locks,
    );
    const before = snapshot(fx.root);
    const outcome = await flipAuthority(fx.root, receipt(tampered), locks);
    expect(outcome.kind).toBe("arm-retirement");
    if (outcome.kind !== "arm-retirement") throw new Error("unreachable");
    expect(outcome.trigger.disposition).toBe("source-changed");
    expect(snapshot(fx.root)).toEqual(before);
  });

  test("refuses a backup recorded at a path this migration does not derive to", async () => {
    // The decoy holds the right bytes under its own identity, so ONLY the
    // derivation check can refuse it.
    let decoy = "";
    const { fx, control } = await readyToFlip({
      over: (draft) => {
        const witness = draft.witness as { fixedBackup: { path: string } };
        decoy = path.join(path.dirname(witness.fixedBackup.path), "pre-163-latest.json.bak.copy");
        fs.copyFileSync(witness.fixedBackup.path, decoy);
        const stat = fs.lstatSync(decoy);
        return {
          ...draft,
          witness: {
            ...(draft.witness as object),
            fixedBackup: {
              ...witness.fixedBackup, path: decoy,
              dev: Number(stat.dev), ino: Number(stat.ino),
            },
          } as typeof draft.witness,
        };
      },
    });
    await refusesWithoutWriting(
      fx, () => flipAuthority(fx.root, receipt(control), locks),
      /is not the backup path this migration derives to/,
    );
    expect(fs.existsSync(decoy), "and the named file is untouched").toBe(true);
  });

  test("revalidates the active database on the resume path too", async () => {
    // The guard was there; nothing reached it. `Q` is live and the phase is still
    // M5, so the fence has been up since before the rename and the recorded digest
    // is still exact — which is precisely why the comparison is legitimate here
    // and why skipping it would ratify a swapped database as authority.
    const { fx, control } = await readyToFlip();
    const stranded = await killAfterTheRename(fx, control);
    fs.writeFileSync(fx.active, "a different database entirely");
    let caught: unknown;
    try {
      await flipAuthority(fx.root, receipt(stranded), locks);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationPhaseHaltError);
    expect((caught as MigrationPhaseHaltError).message)
      .toMatch(/is not the database this migration published/);
    expect(readCanonicalControl(fx.root)!.witness.phase, "M6 is not published").toBe("M5");
  });

  test("refuses a backup whose inode moved even though its bytes did not", async () => {
    // The reserve had this row; the backups did not, so their `dev`/`ino` conjunct
    // was carried only by the digest.
    const { fx, control } = await readyToFlip();
    const backup = migrationPaths.fixedBackup(fx.root);
    const bytes = fs.readFileSync(backup);
    const recorded = inodeOf(backup);
    expect(replaceUnderNewInode(backup, bytes)).not.toBe(recorded);
    await refusesWithoutWriting(
      fx, () => flipAuthority(fx.root, receipt(control), locks),
      /is not the backup this migration published/,
    );
  });

  test("detects the resume by the marker's digest, not by its length", async () => {
    // A legacy document that is exactly 58 bytes is not `Q`. Read by length alone
    // the flip would take the resume branch, skip every pre-rename check, and
    // publish M6 over a live JSON document.
    const fifty8 = Buffer.alloc(AUTHORITY_MARKER_BYTES, 0x7b);
    const fx = fixture();
    fs.writeFileSync(statePath(fx.root), fifty8);
    const republished = republishSource(fx, fifty8);
    const ready = await ladderToReady(fx, await publishNextPhase({ ...fx, control: republished }));
    expect(fs.lstatSync(statePath(fx.root)).size).toBe(AUTHORITY_MARKER_BYTES);

    const outcome = await flipAuthority(fx.root, receipt(ready), locks);
    expect(outcome.kind, "the flip happens for real; it is not mistaken for a resume").toBe("flipped");
    expect(fs.readFileSync(statePath(fx.root)), "and `Q` is the marker, not the decoy").toEqual(MARKER);
  });

  test.each([
    ["the live document", (fx: Fixture) => statePath(fx.root), /is neither legacy sync records nor this authority's marker/],
    ["the fixed backup", (fx: Fixture) => migrationPaths.fixedBackup(fx.root), /is not the backup this migration published/],
  ])("refuses a non-regular occupant at %s", async (_label, at, match) => {
    const { fx, control } = await readyToFlip();
    const file = at(fx);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    await refusesWithoutWriting(fx, () => flipAuthority(fx.root, receipt(control), locks), match);
  });

  test("refuses a reserve whose inode moved even though its bytes did not", async () => {
    const { fx, control } = await readyToFlip();
    const bytes = fs.readFileSync(fx.reserve);
    const recorded = inodeOf(fx.reserve);
    expect(replaceUnderNewInode(fx.reserve, bytes)).not.toBe(recorded);
    await refusesWithoutWriting(
      fx, () => flipAuthority(fx.root, receipt(control), locks),
      /is not the resource this migration recorded/,
    );
  });

  test("refuses a reserve edited in place past its header", async () => {
    // The discriminator for the WHOLE-file digest: a byte in the fill region
    // leaves the inode, the length, and the 128 header bytes all intact, so only
    // `haltResources.reserve.sha256` can catch it.
    const { fx, control } = await readyToFlip();
    const fd = fs.openSync(fx.reserve, "r+");
    fs.writeSync(fd, Buffer.from([0xff]), 0, 1, RESERVE_HEADER_BYTES + 8);
    fs.closeSync(fd);
    await refusesWithoutWriting(
      fx, () => flipAuthority(fx.root, receipt(control), locks),
      /does not hold the bytes this migration recorded/,
    );
  });

  test("refuses a reserve too short to carry a header", async () => {
    // Recorded length and actual length agree, so the identity bracket passes
    // and the header read is the only thing left to refuse it.
    const short = Buffer.alloc(64, 9);
    const { fx, control } = await readyToFlip({
      over: (draft) => {
        fs.writeFileSync(migrationPaths.reserve(path.dirname(path.dirname(draft.source.path))), short);
        const stat = fs.lstatSync(migrationPaths.reserve(path.dirname(path.dirname(draft.source.path))));
        return {
          ...draft,
          haltResources: {
            ...draft.haltResources,
            reserve: {
              disposition: "available", dev: Number(stat.dev), ino: Number(stat.ino),
              bytes: short.byteLength, sha256: digest(short),
            },
          },
        };
      },
    });
    await refusesWithoutWriting(
      fx, () => flipAuthority(fx.root, receipt(control), locks),
      /is too short to carry a reserve header/,
    );
  });

  test("refuses a flip from a sibling that was never recorded exact", async () => {
    // THE HOLE THIS GUARD CLOSES. Under a `building` record with the exact 58
    // bytes on disk, `observeQSibling` answers `exact` — so the image check alone
    // would let the flip rename a sibling no durable revision ever promoted.
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    fs.writeFileSync(fx.sibling, MARKER);
    await refusesWithoutWriting(
      fx, () => flipAuthority(fx.root, receipt(claimed.control), locks),
      /requires an exact Q sibling/,
    );
    expect(fs.readFileSync(statePath(fx.root))).toEqual(LEGACY);
  });

  test("refuses a flip whose exact sibling no longer holds the marker", async () => {
    const { fx, control } = await readyToFlip();
    // Same inode, 58 bytes, wrong bytes: the length rule passes and the digest
    // is what refuses it. Without this the rename publishes arbitrary bytes as Q.
    const fd = fs.openSync(fx.sibling, "r+");
    fs.writeSync(fd, Buffer.alloc(AUTHORITY_MARKER_BYTES, 0x41), 0, AUTHORITY_MARKER_BYTES, 0);
    fs.closeSync(fd);
    await refusesWithoutWriting(
      fx, () => flipAuthority(fx.root, receipt(control), locks),
      /does not hold the exact authority marker/,
    );
    expect(fs.readFileSync(statePath(fx.root))).toEqual(LEGACY);
  });

  test("fsyncs .rbox after the rename", async () => {
    // A missing parent fsync is invisible to userspace, so the assertion is on
    // the syscall: the directory holding the state document is opened and synced.
    const { fx, control } = await readyToFlip();
    const realOpen = fs.openSync as unknown as (...a: unknown[]) => number;
    const fds = new Map<number, unknown>();
    const synced: unknown[] = [];
    inject("openSync", ((...args: unknown[]) => {
      const fd = realOpen(...args);
      fds.set(fd, args[0]);
      return fd;
    }) as unknown as typeof fs.openSync);
    const realFsync = fs.fsyncSync as unknown as (fd: number) => void;
    inject("fsyncSync", ((fd: number) => {
      synced.push(fds.get(fd));
      return realFsync(fd);
    }) as unknown as typeof fs.fsyncSync);

    await flipAuthority(fx.root, receipt(control), locks);
    expect(synced, "the state document's own directory").toContain(path.join(fx.root, ".rbox"));
  });

  /**
   * 163:3311's window, asserted by saying what IS in it.
   *
   * The first version of this test blacklisted callee names and guarded only the
   * gap between the arm-C1 block and the rename. Both halves were wrong: an
   * enumeration of forbidden names has holes (a `readFileSync`, a digest of
   * another file, a second `stat`, and — worst — a bare `await`, which genuinely
   * widens the exposure in an `async` function, all passed it), and the window has
   * two sides, since a statement between the re-read and the comparison is in the
   * same two instants as one between the comparison and the rename.
   *
   * So the whole window is normalized and matched against a golden. Any edit
   * inside it fails here and has to be deliberate; nothing has to be predicted.
   */
  test("the window between the body re-read and the rename holds exactly two guards", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "authority-flip.ts"), "utf8");
    const start = source.lastIndexOf("const final = observePath(live, true);");
    const rename = source.indexOf("fs.renameSync(sibling, live);");
    expect(start, "the body re-read moved").toBeGreaterThan(0);
    expect(rename, "the rename moved").toBeGreaterThan(start);

    // Comments are the one thing the window may carry freely: they compile to
    // nothing. Everything else is code, and code in this window is the defect.
    const window = source.slice(start, rename)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    expect(window, "a statement was added, removed, or reordered inside 163:3311's window").toBe(
      'const final = observePath(live, true); '
      + 'if (final.state !== "regular" || final.sha256 === null) { '
      + 'return halt("reserved-path", false, `${live} stopped being a regular file`); } '
      + 'if (final.sha256 !== witness.completion.sourceJsonSha256) { '
      + 'return { kind: "arm-retirement", trigger: { disposition: "legacy-write-detected", '
      + 'replacement: sourceOf(live, final), observedBodySha256: final.sha256, }, }; } try {',
    );
    // Named separately because it is the mutant that reads as harmless: the
    // function is `async`, so one `await` in here suspends between the check and
    // the rename and the golden above is the only thing that says so.
    expect(window, "an await in this window widens the lost-write exposure").not.toContain("await");

    // Everything the flip must read happens BEFORE the window — including the
    // reserve that the cleanup vector identity-brackets.
    expect(source.indexOf("const cleanup = cleanupCursor(root, control);"),
      "the cleanup vector must be built before the final read, not inside the window")
      .toBeLessThan(start);
  });

  test("compares the LAST read of the live document, not the first", async () => {
    // The single most load-bearing guard in the lane, and the only one the source
    // assertion above was covering on its own: substituting the earlier `observed`
    // for `final` reduces the flip to v8's ordering, where the body was hashed at
    // the START of the step. Injected here for real — the document is rewritten in
    // place, same inode and same length, between the two observations, so only the
    // second read can see it.
    const { fx, control } = await readyToFlip();
    const live = statePath(fx.root);
    const realOpen = fs.openSync as unknown as (...a: unknown[]) => number;
    let reads = 0;
    inject("openSync", ((file: unknown, ...rest: unknown[]) => {
      if (file === live) {
        reads += 1;
        if (reads === 2) {
          const fd = realOpen(live, "r+");
          fs.writeSync(fd, Buffer.alloc(LEGACY.byteLength, 0x7b), 0, LEGACY.byteLength, 0);
          fs.closeSync(fd);
        }
      }
      return realOpen(file, ...rest);
    }) as unknown as typeof fs.openSync);

    const outcome = await flipAuthority(fx.root, receipt(control), locks);
    expect(reads, "the flip must read the live document twice").toBeGreaterThanOrEqual(2);
    expect(outcome.kind, "the write inside the window must arm C1, not rename").toBe("arm-retirement");
    if (outcome.kind !== "arm-retirement") throw new Error("unreachable");
    expect(outcome.trigger.disposition).toBe("legacy-write-detected");
    expect(fs.existsSync(fx.sibling), "and the sibling is still the sibling").toBe(true);
  });

  test.each([
    ["a fixed backup that changed", (fx: Fixture) => {
      fs.writeFileSync(migrationPaths.fixedBackup(fx.root), "tampered");
    }, /is not the backup this migration published/],
    ["a history entry that is gone", (fx: Fixture) => {
      fs.unlinkSync(migrationPaths.backupHistory(fx.root, digest(LEGACY)));
    }, /is not the backup this migration published/],
    ["an active database that changed", (fx: Fixture) => {
      fs.writeFileSync(fx.active, "not the proven database");
    }, /is not the database this migration published/],
    ["a sidecar beside the active database", (fx: Fixture) => {
      fs.writeFileSync(`${fx.active}-wal`, "uncheckpointed");
    }, /carries sidecars while writes are still fenced/],
  ])("refuses the flip on %s", async (_label, damage, match) => {
    const { fx, control } = await readyToFlip();
    damage(fx);
    await refusesWithoutWriting(fx, () => flipAuthority(fx.root, receipt(control), locks), match);
    expect(fs.readFileSync(statePath(fx.root)), "legacy JSON is still authority").toEqual(LEGACY);
  });

  test("publishes a shorter vector when a halt already spent the reserve", async () => {
    // A resource released as halt runway is gone, so it is not a cleanup item.
    // The vector shortens rather than refusing — the emergency candidate becomes
    // the final item and the runway still has one — and the reserve's disposition
    // is left exactly as the halt recorded it.
    const { fx, control } = await readyToFlip({
      over: (draft) => ({
        ...draft,
        haltResources: { ...draft.haltResources, reserve: { disposition: "consumed-for-halt" } },
      }),
    });
    fs.unlinkSync(fx.reserve);
    const outcome = await flipAuthority(fx.root, receipt(control), locks);
    expect(outcome.kind).toBe("flipped");
    if (outcome.kind !== "flipped") throw new Error("unreachable");
    const witness = outcome.control.witness;
    if (witness.phase !== "M6") throw new Error("unreachable");
    expect(witness.cleanup.items.map((item) => item.role)).toEqual(["emergency"]);
    expect(outcome.control.haltResources.reserve.disposition).toBe("consumed-for-halt");
    // And 3C's cursor drives it: one item, which is therefore the final one.
    const step = await stepCleanup(fx.root, receipt(outcome.control), locks);
    expect(step.kind).toBe("final-intent");
  });

  test("refuses a flip whose cleanup vector would be empty", async () => {
    // Both halt resources already spent. `stepCleanup` has no complete-prefix
    // transition into M7 and the runway has no final item, so an empty cursor
    // would wedge the migration one phase after the point of no return.
    const { fx, control } = await readyToFlip({
      over: (draft) => ({
        ...draft,
        haltResources: {
          reserve: { disposition: "consumed-for-halt" },
          emergency: { disposition: "consumed-for-halt" },
        },
      }),
    });
    await refusesWithoutWriting(
      fx, () => flipAuthority(fx.root, receipt(control), locks),
      /records no halt resource for its cleanup vector/,
    );
  });
});

// ---------------------------------------------------------------------------

describe("the kill matrix", () => {
  /**
   * Every instant of the flip, as an on-disk image: what the classifier reads
   * there, and whether re-entering the mutator converges. The rename is the only
   * step that is not idempotent, so the two rows around it are the ones that
   * matter.
   */
  test("M4 + the rename ran ahead resumes M5 without renaming again", async () => {
    const fx = fixture({ database: "active" });
    const observation = await classifyMigrationState(fx.root, locks);
    expect(observation.row).toBe("m4-resume");
    const inode = inodeOf(fx.active);
    await publishPreparedDatabase(fx.root, receipt(fx.control), locks);
    expect(inodeOf(fx.active)).toBe(inode);
  });

  test("M5 + a claimed sibling resumes the ladder on the recorded inode", async () => {
    const fx = fixture();
    const m5 = await publishNextPhase(fx);
    const claimed = await stepQSibling(fx.root, receipt(m5), locks);
    const observation = await classifyMigrationState(fx.root, locks);
    expect(observation.row).toBe("m5-resume");
    const inode = inodeOf(fx.sibling);
    // Re-entering does not claim a second inode; it advances the same one.
    const again = await stepQSibling(fx.root, receipt(claimed.control), locks);
    expect(again.kind).toBe("written");
    expect(inodeOf(fx.sibling)).toBe(inode);
  });

  test("killed after the rename: Q elects SQLite, writes are fenced, and the flip completes", async () => {
    const { fx, control } = await readyToFlip();
    // The kill: the rename lands, the publication does not. Injecting a failure
    // into the publisher's own rename is what produces this image honestly —
    // the flip's rename has already happened by then.
    let renames = 0;
    const real = fs.renameSync;
    inject("renameSync", ((from: string, to: string) => {
      renames += 1;
      if (renames === 2) throw enospc();
      return real(from, to);
    }) as typeof fs.renameSync);

    let caught: unknown;
    try {
      await flipAuthority(fx.root, receipt(control), locks);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationPhaseHaltError);
    const halt = caught as MigrationPhaseHaltError;
    expect(halt.halt.code, "past the rename, a fault is a durability question")
      .toBe("durability-indeterminate");
    expect(halt.wrote).toBe(true);
    spies.pop()!.restore();

    // The durable image: Q is authority, the control is still M5, the sibling is
    // gone. This is 163's sole M6-artifact-ahead form.
    expect(fs.readFileSync(statePath(fx.root))).toEqual(MARKER);
    expect(fs.existsSync(fx.sibling)).toBe(false);
    const durable = readCanonicalControl(fx.root)!;
    expect(durable.witness.phase).toBe("M5");
    expect(blocksSqliteWrites(durable), "writes stay fenced until M6 lands").toBe(true);

    const observation = await classifyMigrationState(fx.root, locks);
    expect(observation.row, "and the classifier admits it rather than calling it corruption")
      .toBe("m5-artifact-ahead-q");

    // Resume converges: no second rename, and M6 publishes.
    const resumed = await flipAuthority(fx.root, receipt(durable), locks);
    expect(resumed.kind).toBe("flipped");
    if (resumed.kind !== "flipped") throw new Error("unreachable");
    expect(resumed.control.witness.phase).toBe("M6");
    expect(blocksSqliteWrites(resumed.control)).toBe(false);
  });

  test("the authority rename's own failure is a typed durability halt", async () => {
    // BLOCKER FROM REVIEW ROUND 1. The rename that elects SQLite is the one
    // operation whose failure 163:2988 does not cover by name — its rule is about
    // the aftermath — and a bare `EIO` here would leave the driver to guess a halt
    // code and a `wrote` flag for the most dangerous instant in the protocol.
    const { fx, control } = await readyToFlip();
    const realRename = fs.renameSync as unknown as (a: unknown, b: unknown) => void;
    inject("renameSync", ((from: unknown, to: unknown) => {
      if (from === fx.sibling) throw Object.assign(new Error("io error"), { code: "EIO" });
      return realRename(from, to);
    }) as unknown as typeof fs.renameSync);

    let caught: unknown;
    try {
      await flipAuthority(fx.root, receipt(control), locks);
    } catch (error) {
      caught = error;
    }
    expect(caught, "not a bare ErrnoException").toBeInstanceOf(MigrationPhaseHaltError);
    const halt = caught as MigrationPhaseHaltError;
    expect(halt.halt.code).toBe("durability-indeterminate");
    expect(halt.halt.underlyingCode ?? halt.message).toMatch(/EIO/);
    // `wrote: true` because the caller cannot know which side of an atomic rename
    // it is on, and a zero-write row is an assertion that must not be guessed.
    expect(halt.wrote).toBe(true);
    // The durable state is one of the two admitted images, and here it is the old
    // one — so the fence that was already up is all that is needed.
    expect(fs.readFileSync(statePath(fx.root))).toEqual(LEGACY);
    expect(readCanonicalControl(fx.root)!.witness.phase).toBe("M5");
    expect(blocksSqliteWrites(readCanonicalControl(fx.root)!)).toBe(true);
    const observation = await classifyMigrationState(fx.root, locks);
    expect(observation.row, "and the classifier still has a row for it").toBe("m5-resume");
  });

  test("a halt resource recorded available but absent is a typed refusal, on both paths", async () => {
    // BLOCKER FROM REVIEW ROUND 2. `publishMigrationHalt` unlinks the reserve and
    // then the emergency candidate as publication runway and, if every attempt
    // still fails, returns `{durable: false}` — leaving both files gone while the
    // canonical control still records both `available`. The vector builder must
    // refuse that, typed, rather than throwing `ENOENT`; and it must NOT quietly
    // shorten the vector, or a damaged record could drop one of its own items.
    const { fx, control } = await readyToFlip();
    fs.unlinkSync(fx.reserve);
    await refusesWithoutWriting(
      fx, () => flipAuthority(fx.root, receipt(control), locks),
      /is recorded available but is not there/,
    );
  });

  test("the same refusal on the post-rename resume path, where it would wedge", async () => {
    // `Q` already elects SQLite here, so an untyped error out of the resume branch
    // is unreachable by any doctor row and the workspace never leaves M5.
    const { fx, control } = await readyToFlip();
    const stranded = await killAfterTheRename(fx, control);
    fs.unlinkSync(fx.emergency);

    let caught: unknown;
    try {
      await flipAuthority(fx.root, receipt(stranded), locks);
    } catch (error) {
      caught = error;
    }
    expect(caught, "not a bare ENOENT").toBeInstanceOf(MigrationPhaseHaltError);
    const halt = caught as MigrationPhaseHaltError;
    expect(halt.halt.code).toBe("reserved-path");
    expect(halt.message).toMatch(/is recorded available but is not there/);
    // The vector is refused whole, never silently shortened to the one item that
    // is still there.
    expect(readCanonicalControl(fx.root)!.witness.phase).toBe("M5");
  });

  test("a Q sibling that survived the rename refuses the resume", async () => {
    const { fx, control } = await readyToFlip();
    const outcome = await flipAuthority(fx.root, receipt(control), locks);
    if (outcome.kind !== "flipped") throw new Error("unreachable");
    // Manufacture the contradiction: Q is published AND the sibling is back.
    fs.writeFileSync(fx.sibling, MARKER);
    await expect(flipAuthority(fx.root, receipt(control), locks))
      .rejects.toThrow(/survived the authority rename/);
  });

  test("a CAS refusal after the rename is a control error, not a durability verdict", async () => {
    // 3C's discrimination, inherited. The publisher's pre-rename checks leave a
    // fully determinate state; calling them `durability-indeterminate` would
    // describe a healthy workspace as one whose writes cannot be trusted.
    const { fx, control } = await readyToFlip();
    // Move the canonical control on, so the flip's receipt is stale.
    const witness = control.witness as Extract<MigrationWitness, { phase: "M5" }>;
    publishMigrationControl(
      fx.root, { migrationId: ID, revision: control.controlRevision },
      { ...control, controlRevision: control.controlRevision + 1, witness }, locks,
    );
    await expect(flipAuthority(fx.root, receipt(control), locks)).rejects.toBeInstanceOf(MigrationControlError);
    // The rename still happened — that is the point of the row.
    expect(fs.readFileSync(statePath(fx.root))).toEqual(MARKER);
    expect(blocksSqliteWrites(readCanonicalControl(fx.root)!)).toBe(true);
  });

  /**
   * THE NEGATIVE CONTROL for the flip's ordering.
   *
   * The real order is rename, then publish. Inverted — publish M6, then rename —
   * a crash between the two leaves a control claiming the flip happened while
   * legacy JSON is still authority. This test performs the inversion inline and
   * shows the bad state actually occurs, so the ordering is a tested property
   * rather than a claim in a comment.
   */
  test("inverting the flip's ordering demonstrably produces the bad state", async () => {
    const { fx, control } = await readyToFlip();
    const witness = control.witness as Extract<MigrationWitness, { phase: "M5" }>;
    const m6: MigrationControl = {
      ...control,
      controlRevision: control.controlRevision + 1,
      witness: {
        ...witness, phase: "M6",
        qSibling: { ...witness.qSibling, disposition: { state: "absent" } },
        cleanup: { items: [], durablePrefix: 0, currentIntent: null },
        futureControls: null,
      },
    };
    // Step one of the inverted order. Step two — the rename — never runs.
    publishMigrationControl(fx.root, { migrationId: ID, revision: control.controlRevision }, m6, locks);

    const observation = await classifyMigrationState(fx.root, locks);
    expect(observation.row, "M6 under legacy JSON authority is unresumable corruption").toBe("corruption");
    if (observation.row !== "corruption") throw new Error("unreachable");
    expect(observation.halt.underlyingCode)
      .toMatch(/records M6, but legacy sync records are still authority/);
    // And the real order never produces it: the same crash instant under the
    // shipped ordering is `m5-artifact-ahead-q`, which resumes.
  });
});
