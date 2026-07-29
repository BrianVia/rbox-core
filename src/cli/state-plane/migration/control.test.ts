import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "../../../engine/e2ee/jcs.js";
import { MigrationControlError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths } from "../paths.js";
import {
  MIGRATION_PHASES, blocksSqliteWrites, decodeMigrationControl, durableRetirementReason,
  encodeMigrationControl, isFinalIntentPromotedHalt,
  type ArtifactItem, type FutureControls, type HaltResource, type MigrationControl,
  type MigrationPhase, type MigrationWitness,
} from "./control-codec.js";
import {
  haltRunway, promotePreparedControl, publishMigrationControl, publishMigrationHalt,
  readCanonicalControl, renderPreparedControl, retireCanonicalControl,
} from "./control-publication.js";

const HASH = "a".repeat(64);
const locks = {} as unknown as HeldStatePlaneLocks;
const source = { path: "/w/.rbox/state.json", dev: 1, ino: 2, bytes: 10, sha256: HASH, mtimeNs: "123" };
const artifact = { path: "/w/x", dev: 1, ino: 3, bytes: 4, sha256: HASH };
const proof = { sha256: HASH, bytes: 9, semanticDigest: HASH, entryCount: 1, repoCount: 0, proofVersion: 1 };
const available: HaltResource = { disposition: "available", dev: 1, ino: 20, bytes: 1_048_576, sha256: HASH };
const item = (role: ArtifactItem["role"], ino: number): ArtifactItem =>
  ({ role, path: `/w/${role}`, parent: "/w", dev: 1, ino, sha256: null });

const PROMOTED: FutureControls = {
  stage: "promoted-halt",
  origin: { path: "/w/o", revision: 9, dev: 1, ino: 10 },
  preparedSuccess: { path: "/w/s", revision: 10, dev: 1, ino: 11, bytes: 500 },
};
const PREPARING: FutureControls = {
  stage: "preparing", version: 1,
  baseRevision: 4, readyRevision: 8, haltRevision: 9, successRevision: 10,
  halt: { kind: "halted-m6", path: "/w/h", disposition: { state: "exact", dev: 1, ino: 12, bytes: 400, sha256: HASH } },
  success: { kind: "m7", path: "/w/s", disposition: { state: "building", dev: 1, ino: 13, expected: null } },
};

/** The witness is monotone, so each phase is its predecessor plus one layer. */
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
  {
    cleanup: { items: [item("reserve", 7), item("emergency", 8)], durablePrefix: 1, currentIntent: { index: 2 } },
    futureControls: PROMOTED,
  },
  { terminalSibling: { ...artifact, disposition: "exact-or-absent-terminal" } },
];

const witnessFor = (phase: MigrationPhase): MigrationWitness =>
  Object.assign({ phase }, ...LAYERS.slice(0, MIGRATION_PHASES.indexOf(phase) + 1)) as MigrationWitness;

/** Dispositions are phase-legal by construction (163:2636). */
function resourcesFor(phase: MigrationPhase): MigrationControl["haltResources"] {
  if (phase === "M0") return { reserve: { disposition: "not-created" }, emergency: { disposition: "not-created" } };
  if (phase === "M7") return { reserve: { disposition: "retired" }, emergency: { disposition: "retired" } };
  if (phase === "M6") return { reserve: { disposition: "cleanup-absent" }, emergency: { disposition: "cleanup-intent" } };
  return { reserve: available, emergency: available };
}

const controlFor = (phase: MigrationPhase, over: Partial<MigrationControl> = {}): MigrationControl => ({
  version: 1, controlRevision: 1, migrationId: "m1", authorityId: "a1",
  source, stagingPath: "/w/.rbox/state/state.db.migrate.m1",
  witness: witnessFor(phase),
  haltResources: resourcesFor(phase),
  halt: null, retirement: null,
  ...over,
});
const control = (over: Partial<MigrationControl> = {}): MigrationControl => controlFor("M0", over);

const mutated = (base: MigrationControl, edit: (raw: Record<string, unknown>) => void): Uint8Array => {
  const raw = JSON.parse(Buffer.from(encodeMigrationControl(base)).toString("utf8")) as Record<string, unknown>;
  edit(raw);
  return canonicalize(raw);
};
/** Byte-level edits for values `canonicalize` itself refuses to emit. */
const rawEdit = (base: MigrationControl, from: string, to: string): Uint8Array =>
  Buffer.from(Buffer.from(encodeMigrationControl(base)).toString("utf8").replace(from, to));

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-control-"));
  fs.mkdirSync(path.join(root, ".rbox", "state"), { recursive: true });
  return root;
}

describe("control codec", () => {
  test("round-trips all eight phase witnesses", () => {
    for (const phase of MIGRATION_PHASES) {
      const original = controlFor(phase);
      expect(decodeMigrationControl(encodeMigrationControl(original)), phase).toEqual(original);
    }
  });

  test("round-trips the M6 preparation ledger and its M7 terminal sibling", () => {
    for (const phase of ["M6", "M7"] as const) {
      const witness = { ...witnessFor(phase), futureControls: PREPARING } as MigrationWitness;
      const original = controlFor(phase, { witness });
      expect(decodeMigrationControl(encodeMigrationControl(original)), phase).toEqual(original);
    }
  });

  test("round-trips an armed source-change retirement", () => {
    const original = controlFor("M3", {
      retirement: {
        version: 1, reason: "source-changed", fromPhase: "M3", fromControlRevision: 1,
        originalSource: source, triggeringSource: { ...source, sha256: "b".repeat(64) },
        cursor: { items: [item("staging-wal", 40), item("staging-main", 41)], durablePrefix: 0, currentIntent: { index: 1 } },
      },
    });
    expect(decodeMigrationControl(encodeMigrationControl(original))).toEqual(original);
  });

  test("rejects unknown, missing, mistyped, and noncanonical bytes", () => {
    const base = control();
    const cases: (() => Uint8Array)[] = [
      () => mutated(base, (raw) => { raw.extra = 1; }),
      () => mutated(base, (raw) => { delete raw.authorityId; }),
      () => rawEdit(base, '"controlRevision":1', '"controlRevision":-1'),
      () => rawEdit(base, '"controlRevision":1', '"controlRevision":1.5'),
      () => mutated(base, (raw) => { raw.version = 2; }),
      () => mutated(base, (raw) => { (raw.witness as Record<string, unknown>).phase = "M9"; }),
      () => mutated(base, (raw) => { (raw.source as Record<string, unknown>).sha256 = "AB"; }),
      () => mutated(base, (raw) => { (raw.haltResources as Record<string, unknown>).reserve = { disposition: "available" }; }),
      () => Buffer.from(` ${Buffer.from(encodeMigrationControl(base)).toString("utf8")}`),
      () => Buffer.from("not json"),
    ];
    for (const build of cases) expect(() => decodeMigrationControl(build())).toThrow(MigrationControlError);
  });

  test("rejects every phase-illegal resource disposition (163:2636)", () => {
    const illegal: [MigrationPhase, HaltResource["disposition"], RegExp][] = [
      ["M3", "not-created", /not-created outside M0/],
      ["M3", "retired", /retired outside M7/],
      ["M3", "retirement-intent", /retirement with none armed/],
      ["M3", "cleanup-intent", /M6 cleanup before M6/],
    ];
    for (const [phase, disposition, message] of illegal) {
      const haltResources = { ...resourcesFor(phase), reserve: { disposition } };
      expect(() => encodeMigrationControl(controlFor(phase, { haltResources })), disposition).toThrow(message);
    }
  });

  test("rejects a cursor whose intent is not the item after its durable prefix", () => {
    const witness = {
      ...witnessFor("M6"),
      cleanup: { items: [item("reserve", 7)], durablePrefix: 0, currentIntent: { index: 2 } },
    } as MigrationWitness;
    expect(() => encodeMigrationControl(controlFor("M6", { witness }))).toThrow(MigrationControlError);
  });

  test("rejects a preparation ledger whose revisions are not exactly spaced", () => {
    const futureControls = { ...PREPARING, successRevision: 11 } as FutureControls;
    const witness = { ...witnessFor("M6"), futureControls } as MigrationWitness;
    expect(() => encodeMigrationControl(controlFor("M6", { witness }))).toThrow(/exactly spaced/);
  });

  test("refuses a record over the 64 KiB cap", () => {
    const items = Array.from({ length: 4000 }, (_, i) => item("reserve", i));
    const witness = { ...witnessFor("M6"), cleanup: { items, durablePrefix: 0, currentIntent: null } } as MigrationWitness;
    expect(() => encodeMigrationControl(controlFor("M6", { witness }))).toThrow(/over the 65536 cap/);
  });

  test("blocksSqliteWrites: below M6 and durability-indeterminate block, cleanup-deferred does not", () => {
    const halt = (code: "durability-indeterminate" | "cleanup-deferred") =>
      ({ code, underlyingCode: null, required: null, available: null });
    expect(blocksSqliteWrites(control())).toBe(true);
    expect(blocksSqliteWrites(controlFor("M5"))).toBe(true);
    expect(blocksSqliteWrites(controlFor("M6"))).toBe(false);
    expect(blocksSqliteWrites(controlFor("M6", { halt: halt("cleanup-deferred") }))).toBe(false);
    expect(blocksSqliteWrites(controlFor("M6", { halt: halt("durability-indeterminate") }))).toBe(true);
  });

  test("isFinalIntentPromotedHalt names only the promoted final-intent halt", () => {
    const halt = { code: "cleanup-deferred", underlyingCode: null, required: null, available: null } as const;
    expect(isFinalIntentPromotedHalt(controlFor("M6", { halt }))).toBe(true);
    expect(isFinalIntentPromotedHalt(controlFor("M6"))).toBe(false);
    const witness = { ...witnessFor("M6"), futureControls: PREPARING } as MigrationWitness;
    expect(isFinalIntentPromotedHalt(controlFor("M6", { witness, halt }))).toBe(false);
  });

  test("both C1 dispositions map to the one durable reason", () => {
    expect(durableRetirementReason({ disposition: "source-changed", replacement: source })).toBe("source-changed");
    expect(durableRetirementReason({ disposition: "legacy-write-detected", observedBodySha256: HASH })).toBe("source-changed");
  });
});

describe("control publication", () => {
  test("publishes a first control, then CAS-advances one revision", () => {
    const root = workspace();
    expect(readCanonicalControl(root)).toBeUndefined();
    const first = publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks);
    expect(first.controlRevision).toBe(1);
    expect(readCanonicalControl(root)).toEqual(first);

    const expect1 = { migrationId: "m1", revision: 1 };
    const second = publishMigrationControl(root, expect1, control({ controlRevision: 2 }), locks);
    expect(second.controlRevision).toBe(2);
    expect(() => publishMigrationControl(root, expect1, control({ controlRevision: 2 }), locks)).toThrow(/cas/);
  });

  test("refuses a first control that is not revision 1, and any gap in ordinary publication", () => {
    const root = workspace();
    expect(() => publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control({ controlRevision: 4 }), locks))
      .toThrow(/must be revision 1/);
    publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks);
    expect(() => publishMigrationControl(root, { migrationId: "m1", revision: 1 }, control({ controlRevision: 3 }), locks))
      .toThrow(/may not advance/);
  });

  test("a refused publication leaves no sibling and the old record intact", () => {
    const root = workspace();
    publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks);
    expect(() => publishMigrationControl(root, { migrationId: "m1", revision: 7 }, control({ controlRevision: 8 }), locks)).toThrow();
    expect(fs.existsSync(migrationPaths.controlRevision(root, "m1", 8))).toBe(false);
    expect(readCanonicalControl(root)?.controlRevision).toBe(1);
  });

  test("resumes the exact inert temp a crash between render and rename leaves behind", () => {
    const root = workspace();
    publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks);
    const next = control({ controlRevision: 2 });
    const stranded = renderPreparedControl(root, 2, next, locks);
    expect(fs.existsSync(stranded.path)).toBe(true);
    const published = publishMigrationControl(root, { migrationId: "m1", revision: 1 }, next, locks);
    expect(published.controlRevision).toBe(2);
    expect(fs.existsSync(stranded.path)).toBe(false);
  });

  test("refuses an occupied sibling path that is not this exact record", () => {
    const root = workspace();
    const file = migrationPaths.controlRevision(root, "m1", 1);
    fs.writeFileSync(file, "squatter");
    expect(() => publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks))
      .toThrow(/occupied by something other than this exact record/);
    expect(fs.readFileSync(file, "utf8")).toBe("squatter");
  });

  test("only the direct-M7 success promotion may take the r -> r+2 gap", () => {
    const root = workspace();
    publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks);
    const expect1 = { migrationId: "m1", revision: 1 };

    const notTerminal = renderPreparedControl(root, 3, controlFor("M6", { controlRevision: 3 }), locks);
    expect(() => promotePreparedControl(root, expect1, notTerminal, locks)).toThrow(/may not advance/);
    fs.rmSync(notTerminal.path);

    const terminal = renderPreparedControl(root, 3, controlFor("M7", { controlRevision: 3 }), locks);
    expect(promotePreparedControl(root, expect1, terminal, locks).controlRevision).toBe(3);
    expect(fs.existsSync(terminal.path)).toBe(false);
  });

  test("promotion refuses a sibling whose bytes changed under its recorded identity", () => {
    const root = workspace();
    publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks);
    const prepared = renderPreparedControl(root, 2, control({ controlRevision: 2, authorityId: "other" }), locks);
    fs.writeFileSync(prepared.path, Buffer.from(encodeMigrationControl(control({ controlRevision: 2 }))));
    expect(() => promotePreparedControl(root, { migrationId: "m1", revision: 1 }, prepared, locks))
      .toThrow(/prepared-foreign/);
    expect(readCanonicalControl(root)?.controlRevision).toBe(1);
  });

  test("a halt publishes the same phase at the next revision", () => {
    const root = workspace();
    const base = publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks);
    const outcome = publishMigrationHalt(root, base, { code: "reserved-path", underlyingCode: null, required: null, available: null }, locks);
    expect(outcome.durable).toBe(true);
    if (!outcome.durable) throw new Error("unreachable");
    expect(outcome.control.controlRevision).toBe(2);
    expect(outcome.control.witness.phase).toBe("M0");
    expect(outcome.control.halt?.code).toBe("reserved-path");
    expect(outcome.control.haltResources.reserve.disposition).toBe("not-created");
  });

  test("a halt that cannot be published is nondurable, carries no control, and releases nothing", () => {
    const root = workspace();
    const base = publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, controlFor("M1"), locks);
    const reserve = migrationPaths.reserve(root);
    fs.writeFileSync(reserve, "reserved");
    fs.rmSync(migrationPaths.control(root));
    const outcome = publishMigrationHalt(root, base, { code: "filesystem-full", underlyingCode: "ENOSPC", required: 1, available: 0 }, locks);
    expect(outcome).toEqual({ durable: false, reason: expect.any(MigrationControlError) });
    // A CAS refusal is not an allocation failure: nothing may be released for it.
    expect(fs.existsSync(reserve)).toBe(true);
  });

  test("the terminal unlink CASes the exact record, and refuses a stale expectation", () => {
    const root = workspace();
    const published = publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks);
    expect(() => retireCanonicalControl(root, { migrationId: "m1", revision: 2 }, locks)).toThrow(/cas/);
    expect(() => retireCanonicalControl(root, { migrationId: "other", revision: 1 }, locks)).toThrow(/cas/);
    expect(readCanonicalControl(root)).toEqual(published);

    retireCanonicalControl(root, { migrationId: "m1", revision: 1 }, locks);
    expect(readCanonicalControl(root)).toBeUndefined();
    expect(() => retireCanonicalControl(root, { migrationId: "m1", revision: 1 }, locks)).toThrow(/cas/);
  });

  test("haltRunway offers only available resources, and none while a cursor runs (163:3343)", () => {
    expect(haltRunway(controlFor("M1"))).toEqual(["reserve", "emergency"]);
    expect(haltRunway(control())).toEqual([]);
    expect(haltRunway(controlFor("M1", {
      haltResources: { reserve: { disposition: "consumed-for-halt" }, emergency: available },
    }))).toEqual(["emergency"]);
    // M6/M7 resources are cleanup-vector items, and an armed retirement's are
    // retirement-vector items: neither may be consumed as halt runway.
    expect(haltRunway(controlFor("M6"))).toEqual([]);
    expect(haltRunway(controlFor("M7"))).toEqual([]);
    expect(haltRunway(controlFor("M4", {
      retirement: {
        version: 1, reason: "source-changed", fromPhase: "M4", fromControlRevision: 1,
        originalSource: source, triggeringSource: source,
        cursor: { items: [item("reserve", 7)], durablePrefix: 0, currentIntent: null },
      },
    }))).toEqual([]);
  });
});

describe("sole-writer gate (design 222 §7.9)", () => {
  /** A module cannot write a file it cannot name, so naming the canonical
   * control is the property to pin. `paths.ts` defines it; every reader reaches
   * it through `readCanonicalControl`. */
  test("only control-publication.ts names the canonical control path", () => {
    const src = path.resolve(import.meta.dir, "../../..");
    const allowed = new Set([
      "cli/state-plane/paths.ts",
      "cli/state-plane/migration/control-publication.ts",
    ]);
    // Genesis must observe the control's ABSENCE at 222 §2.4 step 1, and §7.9
    // forbids it importing anything from `migration/` — so it is the one module
    // outside the publisher that names the path. It may only stat it.
    const observer = "cli/state-plane/genesis.ts";
    const offenders: string[] = [];
    let observerText = "";
    for (const entry of fs.readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const relative = entry.split(path.sep).join("/");
      if (allowed.has(relative)) continue;
      const text = fs.readFileSync(path.join(src, entry), "utf8");
      if (relative === observer) { observerText = text; continue; }
      if (/migrationPaths\.control(Revision)?\(/.test(text) || text.includes("migration-v1.json")) offenders.push(relative);
    }
    expect(offenders).toEqual([]);

    expect(observerText, `${observer} was not found — this exemption is stale`).not.toBe("");
    expect(observerText, "genesis must reach the control through paths.ts, never the literal").not.toContain("migration-v1.json");
    expect(observerText.split("migrationPaths.control(").length - 1, "genesis may name the control exactly once").toBe(1);

    // Pinned as an exact statement, not a prefix: a loop with a body could grow
    // a write inside it and still satisfy a `toContain` check. `.some(inodeOf)`
    // has no body, so the only way to write through this name is to edit this
    // line — which fails here.
    const naming = observerText.split("\n").find((line) => line.includes("migrationPaths.control("))!;
    expect(
      naming.trim(),
      "genesis may only STAT the control. Changing this statement means genesis can now write it — "
      + "do not update this expectation without moving the observation to the §1.3 coordinator instead.",
    ).toBe("if ([sqliteResetPaths.active(root), migrationPaths.control(root)].some(inodeOf)) {");
  });
});
