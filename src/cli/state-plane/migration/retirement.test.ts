import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTHORITY_MARKER_BYTES } from "../authority-marker.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths, sqliteResetPaths, statePath } from "../paths.js";
import { PhaseReceipt } from "./classifier.js";
import type {
  ArtifactItem, C1Trigger, HaltResource, MigrationControl, MigrationPhase, MigrationWitness,
  SourceWitness,
} from "./control-codec.js";
import { publishMigrationControl, readCanonicalControl } from "./control-publication.js";
import { armRetirement, stepRetirement, type RetirementStep } from "./retirement.js";

const locks = {} as unknown as HeldStatePlaneLocks;
const ID = "mig1";
/** What the classifier bracketed on the live document. Retirement stores it as
 * the diagnostic witness and never interprets it. */
const REPLACEMENT: SourceWitness = {
  path: "/w/.rbox/state.json", dev: 9, ino: 99, bytes: 24, sha256: "b".repeat(64), mtimeNs: "42",
};
const TRIGGER: C1Trigger = { disposition: "source-changed", replacement: REPLACEMENT };
const LEGACY_WRITE: C1Trigger = {
  disposition: "legacy-write-detected", replacement: REPLACEMENT, observedBodySha256: "c".repeat(64),
};
const sha = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

interface Physical { dev: number; ino: number; bytes: number; sha256: string }

function write(file: string, contents: Buffer | string): Physical {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  fs.writeFileSync(file, bytes);
  return { ...inodeOf(file), bytes: bytes.byteLength, sha256: sha(bytes) };
}

function inodeOf(file: string): { dev: number; ino: number } {
  const stat = fs.statSync(file);
  return { dev: Number(stat.dev), ino: Number(stat.ino) };
}

/**
 * Replace a file's CONTENT under a NEW inode, and prove the inode is new. Both
 * files exist at once, so the kernel cannot hand back the old number — a plain
 * unlink-then-create can, and does on the CI filesystem, which would leave every
 * identity assertion below vacuously true.
 */
function swapInode(file: string, contents: string): { dev: number; ino: number } {
  const before = inodeOf(file);
  const decoy = `${file}.decoy`;
  write(decoy, contents);
  const after = inodeOf(decoy);
  expect(after.ino, "the decoy reused the inode under test").not.toBe(before.ino);
  fs.renameSync(decoy, file);
  expect(inodeOf(file)).toEqual(after);
  return after;
}

const available = (physical: Physical): HaltResource => ({ disposition: "available", ...physical });

interface Fixture {
  root: string;
  control: MigrationControl;
  paths: Record<string, string>;
}

/** A workspace whose artifacts are real files and whose control records exactly
 * their observed identities. */
function fixture(phase: "M3" | "M5"): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rbox-retire-${process.pid}-`));
  fs.mkdirSync(path.join(root, ".rbox", "state"), { recursive: true });
  write(statePath(root), '{"legacy":"replacement"}');

  const stagingPath = migrationPaths.staging(root, ID);
  const reserve = write(migrationPaths.reserve(root), "reserve-bytes");
  const emergency = write(migrationPaths.emergency(root, ID), "emergency-bytes");
  const paths: Record<string, string> = {
    reserve: migrationPaths.reserve(root),
    emergency: migrationPaths.emergency(root, ID),
    history: migrationPaths.backupHistory(root, "d".repeat(64)),
    fixedBackup: migrationPaths.fixedBackup(root),
  };
  const history = write(paths.history!, "history");
  const fixedBackup = write(paths.fixedBackup!, "backup");

  const layers: Record<string, unknown>[] = [
    { admission: { sourceBytes: 24, requiredBytes: 1248, budgetBytes: 1 << 20 } },
    {
      history: { path: paths.history, ...history },
      fixedBackup: { path: paths.fixedBackup, ...fixedBackup },
      stagingMain: { state: "absent" },
    },
    {
      completion: {
        migrationId: ID, importerVersion: "2.0.0", authorityId: "auth1", sourceJsonSha256: "e".repeat(64),
        sourceSemanticDigest: "f".repeat(64), sourceBytes: 24, entryCount: 1, repoCount: 0,
        perTableCounts: { files: 1 }, completedAt: 7,
      },
    },
  ];

  if (phase === "M3") {
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      paths[suffix] = `${stagingPath}${suffix}`;
      write(paths[suffix]!, `sidecar${suffix}`);
    }
    paths.staging = stagingPath;
    const staging = write(stagingPath, "staging-database");
    layers[1] = { ...layers[1], stagingMain: { state: "present", dev: staging.dev, ino: staging.ino } };
  } else {
    paths.active = sqliteResetPaths.active(root);
    paths.qSibling = migrationPaths.qSibling(root, ID);
    const active = write(paths.active, "active-database");
    const marker = Buffer.alloc(AUTHORITY_MARKER_BYTES, 0x51);
    const sibling = write(paths.qSibling, marker);
    const proof = {
      sha256: active.sha256, bytes: active.bytes, semanticDigest: "f".repeat(64),
      entryCount: 1, repoCount: 0, proofVersion: 1,
    };
    layers.push({ staging: proof }, {
      active: proof,
      qSibling: {
        path: paths.qSibling, bytes: AUTHORITY_MARKER_BYTES, sha256: sibling.sha256,
        disposition: { state: "exact", dev: sibling.dev, ino: sibling.ino },
      },
    });
  }

  const witness = Object.assign({ phase }, ...layers) as MigrationWitness;
  const control: MigrationControl = {
    version: 1, controlRevision: 1, migrationId: ID, authorityId: "auth1",
    source: {
      path: statePath(root), dev: 1, ino: 2, bytes: 12, sha256: "a".repeat(64), mtimeNs: "1",
    },
    stagingPath, witness,
    haltResources: { reserve: available(reserve), emergency: available(emergency) },
    halt: null, retirement: null,
  };
  publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control, locks);
  return { root, control, paths };
}

const receipt = (control: MigrationControl): PhaseReceipt => PhaseReceipt.observe(control);

function arm(f: Fixture, trigger: C1Trigger = TRIGGER): MigrationControl {
  const outcome = armRetirement(f.root, receipt(f.control), trigger, locks);
  if (outcome.kind !== "armed") throw new Error(`expected armed, got ${outcome.halt.underlyingCode}`);
  return outcome.control;
}

/** Drive the cursor to its terminal row, returning every step taken. */
function drive(root: string, from: MigrationControl): RetirementStep[] {
  const steps: RetirementStep[] = [];
  let control: MigrationControl | undefined = from;
  for (let guard = 0; control && guard < 40; guard++) {
    const step: RetirementStep = stepRetirement(root, receipt(control), locks);
    steps.push(step);
    control = step.kind === "intent" || step.kind === "retired" ? step.control : undefined;
    if (step.kind === "complete" || step.kind === "corrupt") break;
  }
  return steps;
}

/** Step until the cursor holds an intent on an item of this role. */
function advanceToIntent(root: string, from: MigrationControl, role: string): MigrationControl {
  let control = from;
  for (let guard = 0; guard < 40; guard++) {
    const step = stepRetirement(root, receipt(control), locks);
    if (step.kind !== "intent" && step.kind !== "retired") throw new Error(`unexpected step ${step.kind}`);
    control = step.control;
    const cursor = control.retirement!.cursor;
    if (cursor.currentIntent && cursor.items[cursor.durablePrefix]!.role === role) return control;
  }
  throw new Error(`the cursor never claimed a ${role} item`);
}

const roles = (control: MigrationControl): string[] =>
  (control.retirement?.cursor.items ?? []).map((item: ArtifactItem) => item.role);

describe("arming a source-change retirement", () => {
  test("M5 arms the fixed-role vector in 163's order and deletes nothing yet", () => {
    const f = fixture("M5");
    const armed = arm(f);
    expect(roles(armed)).toEqual(["q-sibling", "prepared-active-db", "emergency", "reserve"]);
    expect(armed.controlRevision).toBe(2);
    expect(armed.witness.phase).toBe("M5");
    expect(armed.retirement?.reason).toBe("source-changed");
    expect(armed.retirement?.fromPhase).toBe("M5");
    expect(armed.retirement?.fromControlRevision).toBe(1);
    expect(armed.retirement?.cursor.durablePrefix).toBe(0);
    expect(armed.retirement?.cursor.currentIntent).toBeNull();
    // Publication precedes every deletion (163:2814).
    expect(armed.haltResources.reserve.disposition).toBe("available");
    for (const file of Object.values(f.paths)) expect(fs.existsSync(file), file).toBe(true);
    expect(readCanonicalControl(f.root)).toEqual(armed);
  });

  test("M3 records each owned sidecar before its main, and no active database", () => {
    const armed = arm(fixture("M3"));
    expect(roles(armed)).toEqual([
      "staging-journal", "staging-wal", "staging-shm", "staging-main", "emergency", "reserve",
    ]);
  });

  test("the vector never names the source, the history, or the fixed backup", () => {
    const f = fixture("M5");
    const named = new Set((arm(f).retirement?.cursor.items ?? []).map((item) => item.path));
    for (const file of [statePath(f.root), f.paths.history!, f.paths.fixedBackup!]) {
      expect(named.has(file), file).toBe(false);
    }
  });

  test("both C1 dispositions arm the one durable reason and the same witness pair", () => {
    for (const trigger of [TRIGGER, LEGACY_WRITE]) {
      const f = fixture("M5");
      const armed = arm(f, trigger);
      expect(armed.retirement?.reason, trigger.disposition).toBe("source-changed");
      expect(armed.retirement?.triggeringSource).toEqual(REPLACEMENT);
      expect(armed.retirement?.originalSource).toEqual(f.control.source);
    }
  });

  test("an artifact whose inode changed under its recorded path refuses, zero-write", () => {
    const f = fixture("M5");
    swapInode(f.paths.reserve!, "reserve-bytes");
    const outcome = armRetirement(f.root, receipt(f.control), TRIGGER, locks);
    expect(outcome.kind).toBe("corrupt");
    if (outcome.kind !== "corrupt") throw new Error("unreachable");
    expect(outcome.halt.code).toBe("reserved-path");
    expect(outcome.halt.underlyingCode).toContain("recorded reserve resource");
    expect(readCanonicalControl(f.root)?.controlRevision).toBe(1);
    expect(readCanonicalControl(f.root)?.retirement).toBeNull();
    expect(fs.existsSync(f.paths.reserve!)).toBe(true);
  });

  test("an active database whose bytes are not the proved ones refuses", () => {
    const f = fixture("M5");
    fs.writeFileSync(f.paths.active!, "tampered-database");
    const outcome = armRetirement(f.root, receipt(f.control), TRIGGER, locks);
    expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode).toContain("not the database this migration proved");
  });

  test("a staging main rebuilt under a new inode refuses", () => {
    const f = fixture("M3");
    swapInode(f.paths.staging!, "staging-database");
    const outcome = armRetirement(f.root, receipt(f.control), TRIGGER, locks);
    expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode).toContain("not the recorded staging inode");
    expect(fs.existsSync(f.paths.staging!)).toBe(true);
  });

  test("a symlink where a staging sidecar belongs refuses rather than following it", () => {
    const f = fixture("M3");
    const wal = f.paths["-wal"]!;
    const victim = path.join(f.root, "victim");
    write(victim, "innocent");
    fs.rmSync(wal);
    fs.symlinkSync(victim, wal);
    const outcome = armRetirement(f.root, receipt(f.control), TRIGGER, locks);
    expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode).toContain("not a regular file");
    expect(fs.existsSync(victim)).toBe(true);
  });

  test("a control whose staging path escapes .rbox/state names no victim", () => {
    const f = fixture("M3");
    const victim = path.join(f.root, "victim.db");
    const staged = write(victim, "not-ours");
    const escaped = {
      ...f.control, stagingPath: path.join(f.root, ".rbox", "state", "..", "..", "victim.db"),
      witness: { ...f.control.witness, stagingMain: { state: "present", dev: staged.dev, ino: staged.ino } },
    } as MigrationControl;
    const outcome = armRetirement(f.root, receipt(escaped), TRIGGER, locks);
    expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode)
      .toContain("staging path is not the one its migration id derives to");
    expect(fs.existsSync(victim)).toBe(true);
  });

  test("refuses a second arming, a halted control, and a phase past the flip", () => {
    const f = fixture("M5");
    const armed = arm(f);
    expect(armRetirement(f.root, receipt(armed), TRIGGER, locks).kind).toBe("corrupt");

    const halted = { ...f.control, halt: { code: "filesystem-full", underlyingCode: null, required: null, available: null } } as MigrationControl;
    expect(armRetirement(f.root, receipt(halted), TRIGGER, locks).kind).toBe("corrupt");

    for (const phase of ["M6", "M7"] as MigrationPhase[]) {
      const past = { ...f.control, witness: { ...f.control.witness, phase } } as MigrationControl;
      const outcome = armRetirement(f.root, receipt(past), TRIGGER, locks);
      expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode, phase).toContain("past the authority flip");
    }
  });
});

/**
 * Review B1. Every case asserts the VICTIM survived, never the mechanism that
 * spared it: each one arms and, if arming succeeds, drives the cursor to its
 * end, so a fence that merely moves the refusal later still fails here.
 */
describe("a control may not name a file this migration does not own", () => {
  function attemptRetirement(root: string, control: MigrationControl): void {
    try {
      const outcome = armRetirement(root, receipt(control), TRIGGER, locks);
      if (outcome.kind === "armed") drive(root, outcome.control);
    } catch {
      // A refusal is one of the outcomes under test.
    }
    // Refusing at the unlink is not good enough: a retirement that ARMS over a
    // victim path has already published a record doctor must clear, so the
    // refusal has to land before anything durable names the victim.
    expect(readCanonicalControl(root)?.retirement ?? null, "a retirement was armed over a foreign path").toBeNull();
  }

  /** R1/R2: `stagingPath` is carried verbatim, and both victims are direct
   * children of the directories a migration owns. */
  for (const [name, victimOf] of [
    ["the live legacy source", (root: string) => statePath(root)],
    ["the fixed backup", (root: string) => migrationPaths.fixedBackup(root)],
  ] as const) {
    test(`a staging path aimed at ${name} retires nothing`, () => {
      const f = fixture("M3");
      const victim = victimOf(f.root);
      const before = fs.readFileSync(victim);
      const staged = inodeOf(victim);
      attemptRetirement(f.root, {
        ...f.control, stagingPath: victim,
        witness: { ...f.control.witness, stagingMain: { state: "present", ...staged } },
      } as MigrationControl);
      expect(fs.existsSync(victim), victim).toBe(true);
      expect(fs.readFileSync(victim)).toEqual(before);
    });
  }

  /** R3: the Q-sibling path is the SECOND verbatim path a control carries, and
   * its `building` branch pins no content hash. */
  test("a Q-sibling path aimed at the reset journal retires nothing", () => {
    const f = fixture("M5");
    const victim = sqliteResetPaths.journal(f.root);
    write(victim, '{"reset":"journal"}');
    const staged = inodeOf(victim);
    const witness = {
      ...f.control.witness,
      qSibling: {
        ...(f.control.witness as { qSibling: { sha256: string } }).qSibling,
        path: victim, disposition: { state: "building", ...staged },
      },
    };
    attemptRetirement(f.root, { ...f.control, witness } as MigrationControl);
    expect(fs.existsSync(victim)).toBe(true);
  });

  /** R6, the root cause: nothing is tampered but the id, and every path in the
   * vector is then honestly derived by the path policy. */
  test("a migration id that escapes its path templates retires nothing", () => {
    const f = fixture("M3");
    const poisoned = "x/../../state.json";
    expect(migrationPaths.staging(f.root, poisoned), "the template no longer escapes; rewrite this repro")
      .toBe(statePath(f.root));
    const before = fs.readFileSync(statePath(f.root));
    const staged = inodeOf(statePath(f.root));
    // Nothing is tampered but the id: the staging path is what the path policy
    // itself derives, and the resources are spent so only that one item remains.
    const control = {
      ...f.control, controlRevision: 2, migrationId: poisoned,
      stagingPath: migrationPaths.staging(f.root, poisoned),
      witness: { ...f.control.witness, stagingMain: { state: "present", ...staged } },
      haltResources: { reserve: { disposition: "consumed-for-halt" }, emergency: { disposition: "consumed-for-halt" } },
    } as MigrationControl;
    try {
      publishMigrationControl(f.root, { migrationId: ID, revision: 1 }, control, locks);
    } catch {
      // Refusing the record outright is one of the outcomes under test.
    }
    attemptRetirement(f.root, control);
    expect(fs.existsSync(statePath(f.root))).toBe(true);
    expect(fs.readFileSync(statePath(f.root))).toEqual(before);
  });
});

describe("the retirement cursor", () => {
  test("each item takes an intent revision, then an absence revision", () => {
    const f = fixture("M5");
    const armed = arm(f);
    const items = armed.retirement!.cursor.items;
    const steps = drive(f.root, armed);

    expect(steps.map((step) => step.kind))
      .toEqual([...items.flatMap(() => ["intent", "retired"]), "complete"]);
    for (const [index, item] of items.entries()) {
      const intent = steps[index * 2]!;
      const retired = steps[index * 2 + 1]!;
      if (intent.kind !== "intent" || retired.kind !== "retired") throw new Error("unreachable");
      expect(intent.control.retirement?.cursor.currentIntent).toEqual({ index: index + 1 });
      expect(intent.control.retirement?.cursor.durablePrefix).toBe(index);
      expect(retired.control.retirement?.cursor.durablePrefix).toBe(index + 1);
      expect(retired.control.retirement?.cursor.currentIntent).toBeNull();
      expect(fs.existsSync(item.path), item.path).toBe(false);
    }
    // Terminal: the control itself is gone, so a fresh M0 may choose a new id.
    expect(readCanonicalControl(f.root)).toBeUndefined();
    // Nothing outside the vector was touched.
    for (const file of [statePath(f.root), f.paths.history!, f.paths.fixedBackup!]) {
      expect(fs.existsSync(file), file).toBe(true);
    }
  });

  test("a halt resource is never described as available once it is claimed", () => {
    const f = fixture("M5");
    let control = arm(f);
    const dispositions: string[] = [];
    for (const step of drive(f.root, control)) {
      if (step.kind !== "intent" && step.kind !== "retired") continue;
      control = step.control;
      dispositions.push(`${control.haltResources.emergency.disposition}/${control.haltResources.reserve.disposition}`);
    }
    expect(dispositions).toEqual([
      "available/available", "available/available",       // the q sibling
      "available/available", "available/available",       // the prepared active db
      "retirement-intent/available", "retirement-absent/available",
      "retirement-absent/retirement-intent", "retirement-absent/retirement-absent",
    ]);
  });

  test("the M3 vector retires every staging artifact and the resources", () => {
    const f = fixture("M3");
    const armed = arm(f);
    const steps = drive(f.root, armed);
    expect(steps.at(-1)?.kind).toBe("complete");
    for (const item of armed.retirement!.cursor.items) expect(fs.existsSync(item.path), item.path).toBe(false);
  });

  test("a claimed target that is already absent is never recreated", () => {
    const f = fixture("M5");
    const armed = arm(f);
    const first = stepRetirement(f.root, receipt(armed), locks);
    if (first.kind !== "intent") throw new Error("unreachable");
    const target = armed.retirement!.cursor.items[0]!;
    // The crash image the intent exists for: the unlink landed, the prefix
    // publication did not.
    fs.rmSync(target.path);
    const second = stepRetirement(f.root, receipt(first.control), locks);
    expect(second.kind).toBe("retired");
    expect(fs.existsSync(target.path)).toBe(false);
    if (second.kind !== "retired") throw new Error("unreachable");
    expect(second.control.retirement?.cursor.durablePrefix).toBe(1);
  });

  test("a claimed target whose identity changed is refused, not unlinked", () => {
    const f = fixture("M5");
    const first = stepRetirement(f.root, receipt(arm(f)), locks);
    if (first.kind !== "intent") throw new Error("unreachable");
    const target = first.control.retirement!.cursor.items[0]!;
    swapInode(target.path, Buffer.alloc(AUTHORITY_MARKER_BYTES, 0x51).toString("latin1"));

    const outcome = stepRetirement(f.root, receipt(first.control), locks);
    expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode).toContain("not the artifact this retirement bracketed");
    expect(fs.existsSync(target.path)).toBe(true);
    expect(readCanonicalControl(f.root)?.controlRevision).toBe(first.control.controlRevision);
  });

  test("a claimed target whose CONTENT changed under its inode is refused", () => {
    const f = fixture("M5");
    // The reserve is the item whose armed disposition pins a content hash.
    const control = advanceToIntent(f.root, arm(f), "reserve");
    const reserve = f.paths.reserve!;
    const before = inodeOf(reserve);
    fs.truncateSync(reserve, 3);
    expect(inodeOf(reserve), "truncation must preserve the inode or this test proves nothing").toEqual(before);

    const outcome = stepRetirement(f.root, receipt(control), locks);
    expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode).toContain("not the artifact this retirement bracketed");
    expect(fs.existsSync(reserve)).toBe(true);
  });

  test("an item ahead of the cursor that vanished is corruption, not a smaller vector", () => {
    const f = fixture("M5");
    const armed = arm(f);
    fs.rmSync(armed.retirement!.cursor.items.at(-1)!.path);
    const outcome = stepRetirement(f.root, receipt(armed), locks);
    expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode).toContain("no longer matches the identity");
    expect(readCanonicalControl(f.root)?.controlRevision).toBe(armed.controlRevision);
  });

  test("an item behind the prefix that reappeared is corruption", () => {
    const f = fixture("M5");
    let control = arm(f);
    for (const step of drive(f.root, control).slice(0, 2)) {
      if (step.kind === "retired") control = step.control;
    }
    expect(control.retirement?.cursor.durablePrefix).toBe(1);
    write(control.retirement!.cursor.items[0]!.path, "resurrected");
    const outcome = stepRetirement(f.root, receipt(control), locks);
    expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode).toContain("behind the retirement prefix but is present");
  });

  test("a durable cursor item pointing outside the owned directories unlinks nothing", () => {
    const f = fixture("M5");
    const armed = arm(f);
    const victim = path.join(f.root, "victim.db");
    const staged = write(victim, "not-ours");
    const items = armed.retirement!.cursor.items.map((item, index) => index === 0
      ? { ...item, path: victim, parent: path.dirname(victim), dev: staged.dev, ino: staged.ino }
      : item);
    const tampered: MigrationControl = {
      ...armed, controlRevision: armed.controlRevision + 1,
      retirement: { ...armed.retirement!, cursor: { items, durablePrefix: 0, currentIntent: null } },
    };
    publishMigrationControl(f.root, { migrationId: ID, revision: armed.controlRevision }, tampered, locks);

    const outcome = stepRetirement(f.root, receipt(tampered), locks);
    expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode).toContain("is not the path this migration");
    expect(fs.existsSync(victim)).toBe(true);
    expect(readCanonicalControl(f.root)?.controlRevision).toBe(tampered.controlRevision);
  });

  test("a cursor item whose recorded parent is not its parent unlinks nothing", () => {
    const f = fixture("M5");
    const armed = arm(f);
    const items = armed.retirement!.cursor.items.map((item, index) =>
      index === 0 ? { ...item, parent: path.join(f.root, ".rbox", "state") } : item);
    // The Q sibling lives in `.rbox`, so `.rbox/state` is an owned directory
    // that is nonetheless the wrong fsync target for it.
    expect(items[0]!.parent).not.toBe(path.dirname(items[0]!.path));
    const tampered: MigrationControl = {
      ...armed, controlRevision: armed.controlRevision + 1,
      retirement: { ...armed.retirement!, cursor: { items, durablePrefix: 0, currentIntent: null } },
    };
    publishMigrationControl(f.root, { migrationId: ID, revision: armed.controlRevision }, tampered, locks);

    const outcome = stepRetirement(f.root, receipt(tampered), locks);
    expect(outcome.kind === "corrupt" && outcome.halt.underlyingCode).toContain("is not the path this migration");
    expect(fs.existsSync(items[0]!.path)).toBe(true);
  });

  test("a control with no retirement, and a halted one, step nowhere", () => {
    const f = fixture("M5");
    expect(stepRetirement(f.root, receipt(f.control), locks).kind).toBe("corrupt");
    const armed = arm(f);
    const halted = { ...armed, halt: { code: "source-changed", underlyingCode: null, required: null, available: null } } as MigrationControl;
    expect(stepRetirement(f.root, receipt(halted), locks).kind).toBe("corrupt");
  });

  test("a stale receipt cannot advance the cursor", () => {
    const f = fixture("M5");
    const armed = arm(f);
    stepRetirement(f.root, receipt(armed), locks);
    expect(() => stepRetirement(f.root, receipt(armed), locks)).toThrow(/cas/);
  });

  test("an empty vector goes straight to the terminal control unlink", () => {
    const f = fixture("M5");
    const armed = arm(f);
    const emptied: MigrationControl = {
      ...armed, controlRevision: armed.controlRevision + 1,
      retirement: { ...armed.retirement!, cursor: { items: [], durablePrefix: 0, currentIntent: null } },
    };
    publishMigrationControl(f.root, { migrationId: ID, revision: armed.controlRevision }, emptied, locks);
    expect(stepRetirement(f.root, receipt(emptied), locks).kind).toBe("complete");
    expect(readCanonicalControl(f.root)).toBeUndefined();
  });
});

describe("structure", () => {
  test("retirement never reaches a database", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "retirement.ts"), "utf8");
    for (const forbidden of ["bun:sqlite", "node:sqlite", "openStateStore", "Database"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
