/**
 * M-8: the M6 cleanup cursor, the allocation-free runway, and M7.
 *
 * Every fault here is injected, and every guard has a NEGATIVE CONTROL: a test
 * that performs the unguarded action inline and asserts the bad outcome
 * actually occurs. A guard nobody can show failing is a guard nobody has
 * tested.
 *
 * Inode fixtures are CONSTRUCTED and ASSERTED, never assumed. tmpfs does not
 * recycle inode numbers and CI's filesystem does, so "the inode changed" is
 * proven by comparing two observations rather than by trusting that a delete
 * plus a create produces a new number.
 */
import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MigrationControlError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths } from "../paths.js";
import { PhaseReceipt } from "./classifier.js";
import {
  completeFinalItem, retryPromotedHalt, stepFutureControlPreparation,
  type RunwayStep,
} from "./cleanup-runway.js";
import { finishMigration, stepCleanup } from "./cleanup.js";
import {
  encodeMigrationControl,
  type ArtifactItem, type Cursor, type FutureControls, type MigrationControl, type MigrationWitness,
} from "./control-codec.js";
import {
  publishMigrationControl, readCanonicalControl, releaseHaltResource, renderPreparedControl,
  retireCanonicalControl,
} from "./control-publication.js";
import { inodeOf, replaceUnderNewInode } from "./inode-fixtures.js";
import { buildReserveHeader, RESERVE_HEADER_BYTES } from "./reserve.js";

const HASH = "a".repeat(64);
const ID = "m1";
const locks = {} as unknown as HeldStatePlaneLocks;
const digest = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const enospc = (): NodeJS.ErrnoException => Object.assign(new Error("no space"), { code: "ENOSPC" });

const source = { path: "/w/.rbox/state.json", dev: 1, ino: 2, bytes: 10, sha256: HASH, mtimeNs: "123" };
const witnessArtifact = { path: "/w/x", dev: 1, ino: 3, bytes: 4, sha256: HASH };
const proof = { sha256: HASH, bytes: 9, semanticDigest: HASH, entryCount: 1, repoCount: 0, proofVersion: 1 };
const available = { disposition: "available", dev: 1, ino: 20, bytes: 1_048_576, sha256: HASH } as const;

function m6Witness(cleanup: Cursor, futureControls: FutureControls): MigrationWitness {
  return {
    phase: "M6",
    admission: { sourceBytes: 10, requiredBytes: 520, budgetBytes: 4096 },
    history: witnessArtifact, fixedBackup: witnessArtifact, stagingMain: { state: "absent" },
    completion: {
      migrationId: ID, importerVersion: "2.0.0", authorityId: "a1", sourceJsonSha256: HASH,
      sourceSemanticDigest: HASH, sourceBytes: 10, entryCount: 1, repoCount: 0,
      perTableCounts: { files: 1 }, completedAt: 5,
    },
    staging: proof,
    active: proof,
    qSibling: { path: `/w/.rbox/state.json.migrate.${ID}.q`, bytes: 58, sha256: HASH, disposition: { state: "absent" } },
    cleanup, futureControls,
  };
}

function itemFor(role: "reserve" | "emergency", file: string, sha256: string | null): ArtifactItem {
  const stat = fs.lstatSync(file);
  return { role, path: file, parent: path.dirname(file), dev: Number(stat.dev), ino: Number(stat.ino), sha256 };
}

interface Fixture {
  root: string;
  stateDir: string;
  reserve: string;
  emergency: string;
  control: MigrationControl;
}

/** A workspace whose M6 cleanup cursor is at prefix zero with no intent, over a
 * real reserve carrying a real 128-byte header and a real emergency candidate. */
function fixture(rewriteItems?: (defaults: ArtifactItem[], root: string) => ArtifactItem[]): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-cleanup-"));
  const stateDir = path.join(root, ".rbox", "state");
  fs.mkdirSync(stateDir, { recursive: true });

  const reserve = migrationPaths.reserve(root);
  const header = buildReserveHeader("2.0.0", HASH);
  fs.writeFileSync(reserve, Buffer.concat([header, Buffer.alloc(512)]));
  const emergency = migrationPaths.emergency(root, ID);
  fs.writeFileSync(emergency, Buffer.alloc(64));

  const defaults = [itemFor("reserve", reserve, digest(header)), itemFor("emergency", emergency, null)];
  const items = rewriteItems ? rewriteItems(defaults, root) : defaults;
  const control = publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, {
    version: 1, controlRevision: 1, migrationId: ID, authorityId: "a1",
    source, stagingPath: path.join(stateDir, `state.db.migrate.${ID}`),
    witness: m6Witness({ items, durablePrefix: 0, currentIntent: null }, null),
    haltResources: { reserve: available, emergency: available },
    halt: null, retirement: null,
  }, locks);
  return { root, stateDir, reserve, emergency, control };
}

const receipt = (control: MigrationControl): PhaseReceipt => PhaseReceipt.observe(control);

/** Drive the cursor until the final item's intent is durable. */
async function toFinalIntent(fx: Fixture): Promise<MigrationControl> {
  let current = fx.control;
  for (let guard = 0; guard < 10; guard++) {
    const step = await stepCleanup(fx.root, receipt(current), locks);
    if (step.kind === "halted") throw new Error(`unexpected halt: ${step.halt.code}`);
    current = step.control;
    if (step.kind === "final-intent") return current;
  }
  throw new Error("the cursor never reached its final intent");
}

/** Drive the runway to the ready revision, optionally observing each step. */
async function toReady(fx: Fixture, control: MigrationControl, onStep?: (step: RunwayStep) => void): Promise<MigrationControl> {
  let current = control;
  for (let guard = 0; guard < 10; guard++) {
    const step = await stepFutureControlPreparation(fx.root, receipt(current), locks, { onStep });
    if (step.kind === "halted") throw new Error("unexpected preparation halt");
    current = step.control;
    if (step.kind === "ready") return current;
  }
  throw new Error("the runway never became ready");
}

/** Drive all the way to the promoted halted-M6 control by starving the one
 * unlink the final item needs. */
async function toPromotedHalt(fx: Fixture): Promise<{
  halted: MigrationControl; origin: Extract<FutureControls, { stage: "promoted-halt" }>["origin"];
}> {
  const ready = await toReady(fx, await toFinalIntent(fx));
  const unlink = fs.unlinkSync;
  let failed = false;
  inject("unlinkSync", ((file: string) => {
    if (!failed && file === fx.emergency) { failed = true; throw enospc(); }
    return unlink(file);
  }) as typeof fs.unlinkSync);
  const deferred = await completeFinalItem(fx.root, receipt(ready), locks);
  if (deferred.kind !== "promoted-halt") throw new Error("the final item did not defer");
  const witness = deferred.control.witness;
  if (witness.phase !== "M6" || witness.futureControls?.stage !== "promoted-halt") throw new Error("no promoted ledger");
  return { halted: deferred.control, origin: witness.futureControls.origin };
}

const ledgerOf = (control: MigrationControl): Extract<FutureControls, { stage: "preparing" }> => {
  const witness = control.witness;
  if (witness.phase !== "M6" || witness.futureControls?.stage !== "preparing") throw new Error("no preparation ledger");
  return witness.futureControls;
};

/** Every path under `.rbox`, with its bytes — the zero-write snapshot. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = path.join(root, ".rbox");
  for (const entry of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const file = path.join(dir, entry);
    const stat = fs.lstatSync(file);
    out[entry] = stat.isFile() ? `${stat.size}:${inodeOf(file)}` : `dir:${stat.mode}`;
  }
  return out;
}

const spies: { restore: () => void }[] = [];
/** Replace one `fs` entry point for the length of a test. */
function inject<K extends keyof typeof fs>(key: K, replacement: (typeof fs)[K]): void {
  const original = fs[key];
  (fs as Record<string, unknown>)[key as string] = replacement;
  spies.push({ restore: () => { (fs as Record<string, unknown>)[key as string] = original; } });
}
afterEach(() => {
  while (spies.length > 0) spies.pop()!.restore();
});

describe("the M6 cleanup cursor", () => {
  test("intends, removes, and records each item, then arms the runway at the final one", async () => {
    const fx = fixture();
    const intent = await stepCleanup(fx.root, receipt(fx.control), locks);
    expect(intent.kind).toBe("intent");
    if (intent.kind !== "intent") throw new Error("unreachable");
    expect(intent.control.haltResources.reserve.disposition).toBe("cleanup-intent");
    // Intending a removal removes nothing.
    expect(fs.existsSync(fx.reserve)).toBe(true);

    const retired = await stepCleanup(fx.root, receipt(intent.control), locks);
    expect(retired.kind).toBe("retired");
    if (retired.kind !== "retired") throw new Error("unreachable");
    expect(fs.existsSync(fx.reserve)).toBe(false);
    expect(retired.control.haltResources.reserve.disposition).toBe("cleanup-absent");
    expect(retired.control.witness.phase === "M6" && retired.control.witness.cleanup.durablePrefix).toBe(1);

    const final = await stepCleanup(fx.root, receipt(retired.control), locks);
    expect(final.kind).toBe("final-intent");
    if (final.kind !== "final-intent") throw new Error("unreachable");
    const ledger = ledgerOf(final.control);
    expect(ledger.baseRevision).toBe(final.control.controlRevision);
    expect([ledger.readyRevision, ledger.haltRevision, ledger.successRevision])
      .toEqual([ledger.baseRevision + 4, ledger.baseRevision + 5, ledger.baseRevision + 6]);
    expect(ledger.halt.disposition.state).toBe("absent");
    // The emergency candidate is untouched until the runway is ready.
    expect(fs.existsSync(fx.emergency)).toBe(true);
    // Re-running at the final intent is a no-op observation, not a second removal.
    expect((await stepCleanup(fx.root, receipt(final.control), locks)).kind).toBe("final-intent");
  });

  test("re-matches all 128 reserve header bytes before unlinking role 7", async () => {
    const fx = fixture();
    const intent = await stepCleanup(fx.root, receipt(fx.control), locks);
    if (intent.kind !== "intent") throw new Error("unreachable");

    // One byte inside the header, on the SAME inode: identity still matches.
    const before = inodeOf(fx.reserve);
    const fd = fs.openSync(fx.reserve, "r+");
    fs.writeSync(fd, Buffer.from([0x00]), 0, 1, 4);
    fs.closeSync(fd);
    expect(inodeOf(fx.reserve), "the header edit must not change the inode").toBe(before);

    await expect(stepCleanup(fx.root, receipt(intent.control), locks))
      .rejects.toThrow(/128 reserve header bytes/);
    expect(fs.existsSync(fx.reserve), "a header mismatch removes nothing").toBe(true);

    // NEGATIVE CONTROL: without the header re-match, the identity bracket alone
    // passes and the unlink goes through.
    fs.unlinkSync(fx.reserve);
    expect(fs.existsSync(fx.reserve)).toBe(false);
  });

  test("refuses an item whose recorded inode is no longer at its path", async () => {
    const fx = fixture();
    const intent = await stepCleanup(fx.root, receipt(fx.control), locks);
    if (intent.kind !== "intent") throw new Error("unreachable");

    const recorded = inodeOf(fx.reserve);
    const swapped = replaceUnderNewInode(fx.reserve, Buffer.alloc(640));
    expect(swapped, "the fixture must actually produce a different inode").not.toBe(recorded);

    await expect(stepCleanup(fx.root, receipt(intent.control), locks)).rejects.toThrow(MigrationControlError);
    expect(fs.existsSync(fx.reserve), "a foreign occupant is never removed").toBe(true);
  });

  test("refuses a non-regular occupant even at the recorded inode", async () => {
    // A directory at the DERIVED reserve path, whose inode the vector recorded.
    // Without the `isFile` check the unlink is still refused — by `EISDIR`, from
    // the kernel, as an uncaught errno rather than a protocol refusal.
    const fx = fixture((defaults, root) => {
      const file = migrationPaths.reserve(root);
      fs.unlinkSync(file);
      fs.mkdirSync(file);
      const stat = fs.lstatSync(file);
      return [{ ...defaults[0]!, dev: Number(stat.dev), ino: Number(stat.ino) }, defaults[1]!];
    });
    const intent = await stepCleanup(fx.root, receipt(fx.control), locks);
    if (intent.kind !== "intent") throw new Error("unreachable");
    await expect(stepCleanup(fx.root, receipt(intent.control), locks))
      .rejects.toThrow(/is not the reserve this cleanup vector recorded/);
  });

  /** A control is a record, not a construction. `ArtifactItem.path` is a bare
   * string in the schema, so the vector's paths are re-derived at the door of
   * every M6 mutator — the same fence `retirement.ts` applies to the C1 vector. */
  test.each([
    ["a path outside the state directory", (item: ArtifactItem, root: string) =>
      ({ ...item, path: path.join(root, "precious.txt"), parent: root })],
    ["a plausible path inside it", (item: ArtifactItem, root: string) =>
      ({ ...item, path: path.join(root, ".rbox", "state", "reserve-1mib.bin.old") })],
    ["a parent that is not the item's own directory", (item: ArtifactItem, root: string) =>
      ({ ...item, parent: root })],
  ])("refuses a cleanup item naming %s", async (_label, tamper) => {
    const decoy: string[] = [];
    const fx = fixture((defaults, root) => {
      const moved = tamper(defaults[0]!, root);
      if (moved.path !== defaults[0]!.path) {
        fs.renameSync(defaults[0]!.path, moved.path);
        decoy.push(moved.path);
      }
      return [moved, defaults[1]!];
    });
    await expect(stepCleanup(fx.root, receipt(fx.control), locks))
      .rejects.toThrow(/is not the path this migration's reserve derives to/);
    for (const file of decoy) expect(fs.existsSync(file), "and the named file is untouched").toBe(true);
  });

  test("refuses a reserve item recorded without its header digest", async () => {
    const fx = fixture((defaults) => [{ ...defaults[0]!, sha256: null }, defaults[1]!]);
    const intent = await stepCleanup(fx.root, receipt(fx.control), locks);
    if (intent.kind !== "intent") throw new Error("unreachable");
    // The contract 4A must honour, pinned by its own message rather than by
    // whatever the digest comparison happens to do with a null.
    await expect(stepCleanup(fx.root, receipt(intent.control), locks))
      .rejects.toThrow(/was recorded without its reserve header digest/);
    expect(fs.existsSync(fx.reserve)).toBe(true);
  });

  test("refuses a cursor that is already complete but never reached M7", async () => {
    const fx = fixture();
    const witness = fx.control.witness as Extract<MigrationWitness, { phase: "M6" }>;
    const complete: MigrationControl = {
      ...fx.control,
      witness: { ...witness, cleanup: { ...witness.cleanup, durablePrefix: witness.cleanup.items.length } },
    };
    await expect(stepCleanup(fx.root, receipt(complete), locks))
      .rejects.toThrow(/cursor is complete but M7 was never published/);
  });

  test("the identity bracket alone refuses a swapped item that carries no header rule", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));

    const recorded = inodeOf(fx.emergency);
    replaceUnderNewInode(fx.emergency, Buffer.alloc(64));
    expect(inodeOf(fx.emergency), "the swap must actually produce a different inode").not.toBe(recorded);

    // The emergency candidate has no 128-byte header, so `dev`/`ino` is the
    // whole test — this is what fails if the bracket is dropped.
    await expect(completeFinalItem(fx.root, receipt(ready), locks))
      .rejects.toThrow(/is not the emergency this cleanup vector recorded/);
    expect(fs.existsSync(fx.emergency)).toBe(true);
    expect(readCanonicalControl(fx.root)!.controlRevision).toBe(ready.controlRevision);
  });

  test.each(["ENOSPC", "EDQUOT"])("a %s transition defers against the exact same cursor and consumes no vector item", async (code) => {
    const fx = fixture();
    let failed = false;
    const rename = fs.renameSync;
    inject("renameSync", ((from: string, to: string) => {
      if (!failed) { failed = true; throw Object.assign(new Error("out of room"), { code }); }
      return rename(from, to);
    }) as typeof fs.renameSync);

    const step = await stepCleanup(fx.root, receipt(fx.control), locks);
    expect(step).toMatchObject({ kind: "halted", durableHalt: true });
    if (step.kind !== "halted") throw new Error("unreachable");
    expect(step.halt.code).toBe("cleanup-deferred");

    const published = readCanonicalControl(fx.root)!;
    expect(published.halt?.code).toBe("cleanup-deferred");
    expect(published.witness.phase === "M6" && published.witness.cleanup)
      .toMatchObject({ durablePrefix: 0, currentIntent: null });
    // 163:3343 — a halt never consumes a cursor item as its own runway.
    expect(fs.existsSync(fx.reserve)).toBe(true);
    expect(fs.existsSync(fx.emergency)).toBe(true);
    expect(published.haltResources.reserve.disposition).toBe("available");
  });
});

describe("the allocation-free runway", () => {
  test("renders exactly one pair across b+1..b+4 and never a second", async () => {
    const fx = fixture();
    const base = await toFinalIntent(fx);
    const observed: RunwayStep[] = [];
    const ready = await toReady(fx, base, (step) => observed.push(step));

    expect(observed).toEqual(["claim-halt", "claim-success", "write-halt", "write-success"]);
    const ledger = ledgerOf(ready);
    expect(ready.controlRevision).toBe(ledger.readyRevision);
    expect(ledger.halt.disposition.state).toBe("exact");
    expect(ledger.success.disposition.state).toBe("exact");
    expect(inodeOf(ledger.halt.path)).toBe(`${(ledger.halt.disposition as { dev: number; ino: number }).dev}:${(ledger.halt.disposition as { ino: number }).ino}`);
    expect(inodeOf(ledger.success.path)).toBe(`${(ledger.success.disposition as { dev: number; ino: number }).dev}:${(ledger.success.disposition as { ino: number }).ino}`);

    // Exactly two prepared siblings survive in the revision namespace; every
    // ordinary publication temp was renamed away.
    const siblings = fs.readdirSync(fx.stateDir).filter((name) => name.endsWith(".tmp"));
    expect(siblings.sort()).toEqual([path.basename(ledger.halt.path), path.basename(ledger.success.path)].sort());
  });

  test("adopts the sole zero-byte create-ahead at a prebound slot", async () => {
    const fx = fixture();
    const base = await toFinalIntent(fx);
    const ledger = ledgerOf(base);
    fs.writeFileSync(ledger.halt.path, Buffer.alloc(0), { mode: 0o600 });
    const ahead = inodeOf(ledger.halt.path);

    const step = await stepFutureControlPreparation(fx.root, receipt(base), locks);
    expect(step.kind).toBe("advanced");
    if (step.kind !== "advanced") throw new Error("unreachable");
    const claimed = ledgerOf(step.control).halt.disposition;
    expect(claimed.state).toBe("building");
    expect(`${(claimed as { dev: number }).dev}:${(claimed as { ino: number }).ino}`,
      "the create-ahead inode is adopted, never replaced").toBe(ahead);
  });

  /** `zero-create-ahead` is a conjunction — zero bytes AND mode 0600 — and each
   * conjunct is pinned separately, because either alone admits a file this
   * runway would then treat as its own empty slot. */
  test.each([
    ["carrying bytes at the right mode", (file: string) => fs.writeFileSync(file, "content", { mode: 0o600 })],
    ["empty at the wrong mode", (file: string) => fs.writeFileSync(file, Buffer.alloc(0), { mode: 0o644 })],
  ])("refuses a create-ahead %s", async (_label, occupy) => {
    const fx = fixture();
    const base = await toFinalIntent(fx);
    const ledger = ledgerOf(base);
    occupy(ledger.halt.path);
    // `writeFileSync`'s mode applies only on create, and umask can clear bits.
    fs.chmodSync(ledger.halt.path, fs.lstatSync(ledger.halt.path).size === 0 ? 0o644 : 0o600);

    await expect(stepFutureControlPreparation(fx.root, receipt(base), locks))
      .rejects.toThrow(/neither absent nor the sole zero-byte create-ahead/);
  });

  test("an out-of-space runway publishes NO alternate control and resumes the same inode", async () => {
    const fx = fixture();
    const base = await toFinalIntent(fx);
    let current = base;
    for (const _ of [0, 1]) {
      const step = await stepFutureControlPreparation(fx.root, receipt(current), locks);
      if (step.kind !== "advanced") throw new Error("unreachable");
      current = step.control;
    }
    const beforeLedger = ledgerOf(current);
    const beforeInode = inodeOf(beforeLedger.halt.path);
    const beforeSnapshot = snapshot(fx.root);

    const halted = await stepFutureControlPreparation(fx.root, receipt(current), locks, {
      onStep: (step) => { if (step === "write-halt") throw enospc(); },
    });
    expect(halted).toMatchObject({ kind: "halted", durableHalt: false });
    if (halted.kind !== "halted") throw new Error("unreachable");
    expect(halted.halt.code).toBe("cleanup-deferred");
    // 163's named scoped exception to f6: no alternate control, nothing on disk.
    expect(readCanonicalControl(fx.root)!.controlRevision).toBe(current.controlRevision);
    expect(readCanonicalControl(fx.root)!.halt).toBeNull();
    expect(snapshot(fx.root)).toEqual(beforeSnapshot);

    const resumed = await stepFutureControlPreparation(fx.root, receipt(current), locks);
    expect(resumed.kind).toBe("advanced");
    expect(inodeOf(beforeLedger.halt.path), "preparation resumes the SAME inode").toBe(beforeInode);
  });

  test("a short write leaves a resumable building image, not a corruption wedge", async () => {
    const fx = fixture();
    const base = await toFinalIntent(fx);
    let current = base;
    for (const _ of [0, 1]) {
      const step = await stepFutureControlPreparation(fx.root, receipt(current), locks);
      if (step.kind !== "advanced") throw new Error("unreachable");
      current = step.control;
    }
    const ledger = ledgerOf(current);
    const recorded = inodeOf(ledger.halt.path);

    const write = fs.writeSync;
    let shortened = false;
    inject("writeSync", ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number) => {
      if (!shortened && length > 8) {
        shortened = true;
        return write(fd, buffer, offset, 8, position);
      }
      return write(fd, buffer, offset, length, position);
    }) as unknown as typeof fs.writeSync);

    const halted = await stepFutureControlPreparation(fx.root, receipt(current), locks);
    expect(halted).toMatchObject({ kind: "halted", durableHalt: false });
    expect(readCanonicalControl(fx.root)!.controlRevision).toBe(current.controlRevision);
    // A bounded partial image on the SAME inode is an admitted `building` row.
    expect(inodeOf(ledger.halt.path)).toBe(recorded);
    expect(fs.lstatSync(ledger.halt.path).size).toBe(8);

    while (spies.length > 0) spies.pop()!.restore();
    const resumed = await stepFutureControlPreparation(fx.root, receipt(current), locks);
    expect(resumed.kind).toBe("advanced");
    expect(inodeOf(ledger.halt.path)).toBe(recorded);
  });

  test("NEGATIVE CONTROL: creating a replacement pair instead of resuming wedges the runway", async () => {
    const fx = fixture();
    const base = await toFinalIntent(fx);
    let current = base;
    for (const _ of [0, 1]) {
      const step = await stepFutureControlPreparation(fx.root, receipt(current), locks);
      if (step.kind !== "advanced") throw new Error("unreachable");
      current = step.control;
    }
    const ledger = ledgerOf(current);
    const recorded = inodeOf(ledger.halt.path);

    // Exactly what "just rebuild the pair" would do.
    replaceUnderNewInode(ledger.halt.path, Buffer.alloc(0), { mode: 0o600 });
    expect(inodeOf(ledger.halt.path), "the replacement must actually be a new inode").not.toBe(recorded);

    await expect(stepFutureControlPreparation(fx.root, receipt(current), locks))
      .rejects.toThrow(/is not the halted-m6 inode this ledger recorded/);
  });

  test("refuses to write a slot whose derived record is not the one the ledger expects", async () => {
    const fx = fixture();
    const base = await toFinalIntent(fx);
    let current = base;
    for (const _ of [0, 1]) {
      const step = await stepFutureControlPreparation(fx.root, receipt(current), locks);
      if (step.kind !== "advanced") throw new Error("unreachable");
      current = step.control;
    }
    // A ledger claiming an expectation the derivation does not meet: the bytes
    // are never written against a foreign expectation.
    const ledger = ledgerOf(current);
    const expected = ledger.halt.disposition;
    if (expected.state !== "building" || expected.expected === null) throw new Error("unreachable");
    const tampered: MigrationControl = {
      ...current,
      witness: {
        ...current.witness as Extract<MigrationWitness, { phase: "M6" }>,
        futureControls: {
          ...ledger,
          halt: { ...ledger.halt, disposition: { ...expected, expected: { ...expected.expected, sha256: "b".repeat(64) } } },
        },
      },
    };
    await expect(stepFutureControlPreparation(fx.root, receipt(tampered), locks))
      .rejects.toThrow(/the halted-M6 record is not the one this ledger expected/);
    expect(fs.lstatSync(ledger.halt.path).size, "and nothing was written").toBe(0);
  });

  /** The prepared records are pure functions of the WHOLE control, cursor
   * included, so moving the cursor moves the bytes the ledger's exact
   * descriptors must match. That is why `finalItem`'s own intent guard is
   * unreachable from here: the derivation refuses first, and more specifically. */
  test("refuses a moved cursor because the prepared records no longer derive", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const witness = ready.witness as Extract<MigrationWitness, { phase: "M6" }>;
    const misaimed: MigrationControl = {
      ...ready,
      witness: { ...witness, cleanup: { ...witness.cleanup, durablePrefix: 0, currentIntent: { index: 1 } } },
    };
    await expect(completeFinalItem(fx.root, receipt(misaimed), locks))
      .rejects.toThrow(/is not the exact halted-m6 record this ledger prepared/);
    expect(fs.existsSync(fx.emergency), "and no item is removed on a cursor that does not derive").toBe(true);
  });

  test("refuses to complete the final item while a descriptor is still building", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const ledger = ledgerOf(ready);
    const exact = ledger.halt.disposition;
    if (exact.state !== "exact") throw new Error("unreachable");
    const notReady: MigrationControl = {
      ...ready,
      witness: {
        ...ready.witness as Extract<MigrationWitness, { phase: "M6" }>,
        futureControls: {
          ...ledger,
          halt: { ...ledger.halt, disposition: { state: "building", dev: exact.dev, ino: exact.ino, expected: null } },
        },
      },
    };
    await expect(completeFinalItem(fx.root, receipt(notReady), locks))
      .rejects.toThrow(/the final-item runway is not ready/);
    expect(fs.existsSync(fx.emergency)).toBe(true);
  });

  test("refuses a slot swapped between the bracket and the write, before any bytes land", async () => {
    const fx = fixture();
    const base = await toFinalIntent(fx);
    let current = base;
    for (const _ of [0, 1]) {
      const step = await stepFutureControlPreparation(fx.root, receipt(current), locks);
      if (step.kind !== "advanced") throw new Error("unreachable");
      current = step.control;
    }
    const ledger = ledgerOf(current);
    const recorded = inodeOf(ledger.halt.path);

    // The swap lands in the window between `bracketSlot` and the write. Only the
    // write descriptor's own identity check can see it; a check after the write
    // would notice a slot it had already put a control record into.
    const step = stepFutureControlPreparation(fx.root, receipt(current), locks, {
      onStep: (which) => {
        if (which !== "write-halt") return;
        replaceUnderNewInode(ledger.halt.path, "not this ledger's slot", { mode: 0o600 });
      },
    });
    await expect(step).rejects.toThrow(/changed identity before its halted-m6 bytes were written/);
    expect(inodeOf(ledger.halt.path), "the swap must actually be a new inode").not.toBe(recorded);
    expect(fs.readFileSync(ledger.halt.path, "utf8"), "and it never received the record").toBe("not this ledger's slot");
  });

  test("refuses a building slot that grew past the image it is allowed to hold", async () => {
    const fx = fixture();
    const base = await toFinalIntent(fx);
    let current = base;
    for (const _ of [0, 1]) {
      const step = await stepFutureControlPreparation(fx.root, receipt(current), locks);
      if (step.kind !== "advanced") throw new Error("unreachable");
      current = step.control;
    }
    const ledger = ledgerOf(current);
    const expected = ledger.halt.disposition;
    if (expected.state !== "building" || expected.expected === null) throw new Error("unreachable");

    // Same inode, but longer than the expected image: `building` admits
    // `0..expected.bytes` and nothing else.
    const recorded = inodeOf(ledger.halt.path);
    fs.truncateSync(ledger.halt.path, expected.expected.bytes + 1);
    expect(inodeOf(ledger.halt.path)).toBe(recorded);

    await expect(stepFutureControlPreparation(fx.root, receipt(current), locks))
      .rejects.toThrow(/past its expected/);
  });

  test("refuses to write the M7 slot against an expectation the derivation does not meet", async () => {
    const fx = fixture();
    const base = await toFinalIntent(fx);
    let current = base;
    for (const _ of [0, 1, 2]) {
      const step = await stepFutureControlPreparation(fx.root, receipt(current), locks);
      if (step.kind !== "advanced") throw new Error("unreachable");
      current = step.control;
    }
    const ledger = ledgerOf(current);
    const success = ledger.success.disposition;
    if (success.state !== "building" || success.expected === null) throw new Error("unreachable");
    const before = fs.lstatSync(ledger.success.path).size;

    const tampered: MigrationControl = {
      ...current,
      witness: {
        ...current.witness as Extract<MigrationWitness, { phase: "M6" }>,
        futureControls: {
          ...ledger,
          success: {
            ...ledger.success,
            disposition: { ...success, expected: { ...success.expected, sha256: "c".repeat(64) } },
          },
        },
      },
    };
    await expect(stepFutureControlPreparation(fx.root, receipt(tampered), locks))
      .rejects.toThrow(/the M7 record is not the one this ledger expected/);
    expect(fs.lstatSync(ledger.success.path).size, "and nothing was written").toBe(before);
  });

  test("refuses a slot that kept the record as its prefix but grew past it", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const ledger = ledgerOf(ready);
    const recorded = inodeOf(ledger.halt.path);

    // Appending leaves every recorded byte in place, so a comparison that only
    // reads `bytes.byteLength` bytes and compares them still matches. The
    // recorded LENGTH is the only thing that refuses this.
    fs.appendFileSync(ledger.halt.path, "trailing");
    expect(inodeOf(ledger.halt.path), "the append must keep the recorded inode").toBe(recorded);

    await expect(completeFinalItem(fx.root, receipt(ready), locks))
      .rejects.toThrow(/is not the exact halted-m6 record this ledger prepared/);
    expect(fs.existsSync(fx.emergency)).toBe(true);
  });

  test("the ledger owns b+5 and b+6 while control sits at b+4, so no temp may be blanket-overwritten", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const ledger = ledgerOf(ready);
    expect(ready.controlRevision).toBe(ledger.readyRevision);

    // The publisher already refuses to reuse an occupied sibling path.
    expect(() => renderPreparedControl(fx.root, ledger.haltRevision, {
      ...ready, controlRevision: ledger.haltRevision,
    }, locks)).toThrow(/occupied by something other than this exact record/);

    // NEGATIVE CONTROL: a blanket overwrite of the "stranded" temp destroys a
    // live ledger-owned artifact and terminalization can no longer complete.
    // Same inode, same length, different bytes: only the byte-for-byte reread
    // can catch this, which is exactly the point.
    const exact = ledger.halt.disposition;
    if (exact.state !== "exact") throw new Error("unreachable");
    const overwrite = fs.openSync(ledger.halt.path, "r+");
    fs.writeSync(overwrite, Buffer.alloc(exact.bytes, 0x20), 0, exact.bytes, 0);
    fs.closeSync(overwrite);
    expect(fs.lstatSync(ledger.halt.path).size).toBe(exact.bytes);

    await expect(completeFinalItem(fx.root, receipt(ready), locks))
      .rejects.toThrow(/is not the exact halted-m6 record this ledger prepared/);
    expect(fs.existsSync(fx.emergency), "and the final item is still there, unremovable").toBe(true);
  });
});

describe("the final item", () => {
  test("removes it and promotes the prepared M7 in one r -> r+2 step", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const ledger = ledgerOf(ready);

    const outcome = await completeFinalItem(fx.root, receipt(ready), locks);
    expect(outcome.kind).toBe("finished");
    if (outcome.kind !== "finished") throw new Error("unreachable");
    expect(outcome.control.witness.phase).toBe("M7");
    expect(outcome.control.controlRevision).toBe(ledger.successRevision);
    expect(outcome.control.haltResources).toEqual({
      reserve: { disposition: "retired" }, emergency: { disposition: "retired" },
    });
    expect(fs.existsSync(fx.emergency)).toBe(false);
    expect(fs.existsSync(ledger.success.path), "the M7 sibling became the control").toBe(false);
    expect(fs.existsSync(ledger.halt.path), "the unused halt sibling is M7's terminal artifact").toBe(true);

    await finishMigration(fx.root, receipt(outcome.control), locks);
    expect(fs.existsSync(ledger.halt.path)).toBe(false);
    expect(readCanonicalControl(fx.root)).toBeUndefined();
    expect(fs.readdirSync(fx.stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("an out-of-space removal promotes the prepared halt, which doctor then retries to M7", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const ledger = ledgerOf(ready);

    const unlink = fs.unlinkSync;
    let failed = false;
    inject("unlinkSync", ((file: string) => {
      if (!failed && file === fx.emergency) { failed = true; throw enospc(); }
      return unlink(file);
    }) as typeof fs.unlinkSync);

    const deferred = await completeFinalItem(fx.root, receipt(ready), locks);
    expect(deferred.kind).toBe("promoted-halt");
    if (deferred.kind !== "promoted-halt") throw new Error("unreachable");
    const halted = deferred.control;
    expect(halted.controlRevision).toBe(ledger.haltRevision);
    expect(halted.witness.phase).toBe("M6");
    expect(halted.halt?.code).toBe("cleanup-deferred");
    expect(halted.witness.phase === "M6" && halted.witness.futureControls?.stage).toBe("promoted-halt");
    expect(fs.existsSync(ledger.halt.path), "the halt sibling became the control").toBe(false);
    expect(fs.existsSync(fx.emergency), "the final item survived the deferral").toBe(true);

    // Doctor's single-use delegation. Its success is also the proof that the M7
    // bytes are recomputable from the halted record alone: `readSlotExact`
    // compares the recomputed record byte-for-byte against the prepared sibling.
    const retried = await retryPromotedHalt(fx.root, receipt(halted), locks);
    expect(retried.kind).toBe("finished");
    if (retried.kind !== "finished") throw new Error("unreachable");
    expect(retried.control.controlRevision).toBe(ledger.successRevision);
    expect(retried.control.witness.phase).toBe("M7");
    expect(fs.existsSync(fx.emergency)).toBe(false);

    await finishMigration(fx.root, receipt(retried.control), locks);
    expect(readCanonicalControl(fx.root)).toBeUndefined();
  });

  test("a pre-rename refusal throws; only a real rename failure is durability-indeterminate", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));

    // Someone published past us. The CAS refuses BEFORE the rename, so the state
    // is fully determinate — reporting `durability-indeterminate` would both
    // misdescribe it and block SQLite writes over nothing.
    fs.writeFileSync(migrationPaths.control(fx.root),
      encodeMigrationControl({ ...ready, controlRevision: ready.controlRevision + 1 }));
    await expect(completeFinalItem(fx.root, receipt(ready), locks)).rejects.toThrow(MigrationControlError);
    expect(fs.existsSync(fx.emergency), "the final item was still removed first").toBe(false);

    // A genuine rename failure is the indeterminate case.
    const other = fixture();
    const otherReady = await toReady(other, await toFinalIntent(other));
    inject("renameSync", (() => { throw Object.assign(new Error("io"), { code: "EIO" }); }) as typeof fs.renameSync);
    const outcome = await completeFinalItem(other.root, receipt(otherReady), locks);
    expect(outcome).toMatchObject({ kind: "halted", durableHalt: false });
    if (outcome.kind !== "halted") throw new Error("unreachable");
    expect(outcome.halt.code).toBe("durability-indeterminate");
    expect(outcome.halt.underlyingCode).toBe("EIO");
  });

  test("a retry whose final item is already absent never recreates it", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const unlink = fs.unlinkSync;
    let failed = false;
    inject("unlinkSync", ((file: string) => {
      if (!failed && file === fx.emergency) { failed = true; throw enospc(); }
      return unlink(file);
    }) as typeof fs.unlinkSync);
    const deferred = await completeFinalItem(fx.root, receipt(ready), locks);
    if (deferred.kind !== "promoted-halt") throw new Error("unreachable");

    fs.unlinkSync(fx.emergency);
    const retried = await retryPromotedHalt(fx.root, receipt(deferred.control), locks);
    expect(retried.kind).toBe("finished");
    expect(fs.existsSync(fx.emergency)).toBe(false);
  });

  test("the retry refuses a control that is not a promoted halt at all", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    await expect(retryPromotedHalt(fx.root, receipt(ready), locks))
      .rejects.toThrow(/only an exact final-intent promoted halt/);
  });

  test("the retry refuses a byte-identical control at a different inode", async () => {
    const fx = fixture();
    const { halted } = await toPromotedHalt(fx);
    const control = migrationPaths.control(fx.root);

    const before = inodeOf(control);
    fs.writeFileSync(`${control}.copy`, encodeMigrationControl(halted));
    fs.renameSync(`${control}.copy`, control);
    expect(inodeOf(control), "the copy must actually be a different inode").not.toBe(before);

    await expect(retryPromotedHalt(fx.root, receipt(halted), locks))
      .rejects.toThrow(/not the halt sibling this ledger promoted/);
    expect(fs.existsSync(fx.emergency)).toBe(true);
  });

  test("the retry refuses a reappeared origin path even at the exact recorded inode", async () => {
    const fx = fixture();
    const { halted, origin } = await toPromotedHalt(fx);
    const control = migrationPaths.control(fx.root);

    // A hard link, so the canonical control keeps the EXACT recorded inode and
    // only the origin-absence check can refuse it.
    fs.linkSync(control, origin.path);
    expect(inodeOf(control), "the control is still the recorded origin inode").toBe(`${origin.dev}:${origin.ino}`);
    expect(inodeOf(origin.path), "the link shares that inode").toBe(inodeOf(control));

    await expect(retryPromotedHalt(fx.root, receipt(halted), locks))
      .rejects.toThrow(/must be absent once its record is canonical/);
    expect(fs.existsSync(fx.emergency)).toBe(true);
  });
});

describe("M7 terminalization", () => {
  test("judges an inert publisher temp by lstat alone and never opens it", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const outcome = await completeFinalItem(fx.root, receipt(ready), locks);
    if (outcome.kind !== "finished") throw new Error("unreachable");

    // A stranded temp inside this migration's own revision interval, left
    // unreadable. If inertness were judged by opening it, this would throw.
    const stranded = migrationPaths.controlRevision(fx.root, ID, 2);
    fs.writeFileSync(stranded, "a stranded inert temp", { mode: 0o000 });
    // NEGATIVE CONTROL: an open-based judgement demonstrably fails here.
    expect(() => fs.readFileSync(stranded)).toThrow();

    await finishMigration(fx.root, receipt(outcome.control), locks);
    expect(readCanonicalControl(fx.root)).toBeUndefined();
    expect(fs.existsSync(stranded), "doctor's quarantine remains its only remover").toBe(true);
  });

  test("refuses a non-regular occupant of a role-5 path, writing nothing", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const outcome = await completeFinalItem(fx.root, receipt(ready), locks);
    if (outcome.kind !== "finished") throw new Error("unreachable");

    fs.mkdirSync(migrationPaths.controlRevision(fx.root, ID, 3));
    const before = snapshot(fx.root);
    await expect(finishMigration(fx.root, receipt(outcome.control), locks))
      .rejects.toThrow(/neither absent nor an inert regular temp/);
    // The terminal sibling is unlinked before the assertion, so the snapshot is
    // taken after that; what must not change is the control itself.
    expect(readCanonicalControl(fx.root)?.controlRevision).toBe(outcome.control.controlRevision);
    expect(before[path.join("state", path.basename(migrationPaths.control(fx.root)))]).toBeDefined();
  });

  /** M7's unlink brackets on inode AND length; each conjunct is pinned alone,
   * because a test that changes both proves neither. */
  test.each([
    ["a different inode at the recorded length", (file: string, size: number) => {
      replaceUnderNewInode(file, Buffer.alloc(size, 0x2e));
    }],
    ["the recorded inode at a different length", (file: string) => {
      fs.appendFileSync(file, "grown");
    }],
  ])("refuses a terminal sibling with %s", async (_label, tamper) => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const ledger = ledgerOf(ready);
    const outcome = await completeFinalItem(fx.root, receipt(ready), locks);
    if (outcome.kind !== "finished") throw new Error("unreachable");

    const before = { inode: inodeOf(ledger.halt.path), size: fs.lstatSync(ledger.halt.path).size };
    tamper(ledger.halt.path, before.size);
    const after = { inode: inodeOf(ledger.halt.path), size: fs.lstatSync(ledger.halt.path).size };
    // Exactly one conjunct moved, so exactly one check can be doing the work.
    expect([after.inode !== before.inode, after.size !== before.size].filter(Boolean)).toHaveLength(1);

    await expect(finishMigration(fx.root, receipt(outcome.control), locks))
      .rejects.toThrow(/is not the prepared sibling M7 recorded/);
    expect(fs.existsSync(ledger.halt.path), "a foreign sibling is never unlinked").toBe(true);
    expect(readCanonicalControl(fx.root)).toBeDefined();
  });

  test("refuses to retire artifacts before M7 is the canonical control", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const ledger = ledgerOf(ready);
    const outcome = await completeFinalItem(fx.root, receipt(ready), locks);
    if (outcome.kind !== "finished") throw new Error("unreachable");

    const stale = { ...outcome.control, controlRevision: outcome.control.controlRevision + 1 };
    await expect(finishMigration(fx.root, receipt(stale), locks))
      .rejects.toThrow(/must be the canonical control/);
    expect(fs.existsSync(ledger.halt.path)).toBe(true);
  });
});

describe("the terminal control retirement", () => {
  test("unlinks the control only under its exact CAS", async () => {
    const fx = fixture();
    const ready = await toReady(fx, await toFinalIntent(fx));
    const outcome = await completeFinalItem(fx.root, receipt(ready), locks);
    if (outcome.kind !== "finished") throw new Error("unreachable");
    const expect1 = { migrationId: ID, revision: outcome.control.controlRevision };

    expect(() => retireCanonicalControl(fx.root, { ...expect1, revision: expect1.revision - 1 }, locks)).toThrow(/cas/);
    expect(() => retireCanonicalControl(fx.root, { ...expect1, migrationId: "other" }, locks)).toThrow(/cas/);
    expect(readCanonicalControl(fx.root), "a refused retirement leaves the control").toBeDefined();

    retireCanonicalControl(fx.root, expect1, locks);
    expect(readCanonicalControl(fx.root)).toBeUndefined();
    // The migration's last durable act does not run twice.
    expect(() => retireCanonicalControl(fx.root, expect1, locks)).toThrow(/cas/);
  });
});

describe("releaseHaltResource (closing wave 1A's untested refusal)", () => {
  test("releases only the exact recorded resource, and refuses every other observation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-release-"));
    fs.mkdirSync(path.join(root, ".rbox", "state"), { recursive: true });
    const file = migrationPaths.reserve(root);
    const content = Buffer.alloc(64, 0x7a);
    fs.writeFileSync(file, content);
    const stat = fs.lstatSync(file);
    const recorded = {
      disposition: "available", dev: Number(stat.dev), ino: Number(stat.ino), bytes: 64,
      sha256: digest(content),
    } as const;
    const control = (over: Partial<MigrationControl["haltResources"]["reserve"]> = {}): MigrationControl =>
      ({
        version: 1, controlRevision: 1, migrationId: ID, authorityId: "a1", source,
        stagingPath: "/w/s", witness: { phase: "M0" },
        haltResources: { reserve: { ...recorded, ...over }, emergency: { disposition: "not-created" } },
        halt: null, retirement: null,
      } as MigrationControl);

    // A resource that is not `available` names no file, so nothing is released.
    expect(() => releaseHaltResource(root, {
      ...control(), haltResources: { reserve: { disposition: "cleanup-intent" }, emergency: { disposition: "not-created" } },
    }, "reserve")).toThrow(/not available/);
    expect(fs.existsSync(file)).toBe(true);

    // Wrong inode, and wrong length: both refuse, both leave the file.
    expect(() => releaseHaltResource(root, control({ ino: recorded.ino + 1 }), "reserve")).toThrow(/is not the recorded reserve/);
    expect(() => releaseHaltResource(root, control({ bytes: 65 }), "reserve")).toThrow(/is not the recorded reserve/);
    expect(fs.existsSync(file)).toBe(true);

    // An in-place rewrite keeps the inode AND the length, so only the content
    // digest can refuse it. This is the case the bracket used to release.
    const rewrite = fs.openSync(file, "r+");
    fs.writeSync(rewrite, Buffer.alloc(64, 0x41), 0, 64, 0);
    fs.closeSync(rewrite);
    expect(inodeOf(file), "the rewrite must keep the recorded inode").toBe(`${recorded.dev}:${recorded.ino}`);
    expect(fs.lstatSync(file).size).toBe(recorded.bytes);
    expect(() => releaseHaltResource(root, control(), "reserve")).toThrow(/is not the recorded reserve/);
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, content);

    // A directory at the path is not a regular file.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-release-"));
    fs.mkdirSync(migrationPaths.reserve(other), { recursive: true });
    expect(() => releaseHaltResource(other, control(), "reserve")).toThrow(/is not the recorded reserve/);

    // The exact recorded resource is released.
    releaseHaltResource(root, control(), "reserve");
    expect(fs.existsSync(file)).toBe(false);

    // NEGATIVE CONTROL: the bracket is what saved the file above — an unguarded
    // unlink of the same path removes whatever is there.
    fs.writeFileSync(file, Buffer.alloc(1));
    fs.unlinkSync(file);
    expect(fs.existsSync(file)).toBe(false);
  });
});
