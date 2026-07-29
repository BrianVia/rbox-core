import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "../../../engine/e2ee/jcs.js";
import { MigrationControlError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths } from "../paths.js";
import {
  blocksSqliteWrites, decodeMigrationControl, durableRetirementReason, encodeMigrationControl,
  isFinalIntentPromotedHalt, type ArtifactItem, type MigrationControl, type MigrationWitness,
} from "./control-codec.js";
import {
  promotePreparedControl, publishMigrationControl, publishMigrationHalt,
  readCanonicalControl, renderPreparedControl,
} from "./control-publication.js";

const HASH = "a".repeat(64);
const locks = {} as unknown as HeldStatePlaneLocks;
const source = { path: "/w/.rbox/state.json", dev: 1, ino: 2, bytes: 10, sha256: HASH, mtimeNs: "123" };
const artifact = { path: "/w/x", dev: 1, ino: 3, bytes: 4, sha256: HASH };
const proof = { sha256: HASH, bytes: 9, semanticDigest: HASH, entryCount: 1, repoCount: 0, proofVersion: 1 };
const item = (role: ArtifactItem["role"], ino: number): ArtifactItem =>
  ({ role, path: `/w/${role}`, parent: "/w", dev: 1, ino, sha256: null });

const M6_WITNESS: MigrationWitness = {
  phase: "M6",
  admission: { sourceBytes: 10, requiredBytes: 520, budgetBytes: 4096 },
  history: artifact, fixedBackup: artifact, stagingMain: { state: "absent" },
  completion: {
    migrationId: "m1", importerVersion: "2.0.0", authorityId: "a1", sourceJsonSha256: HASH,
    sourceSemanticDigest: HASH, sourceBytes: 10, entryCount: 1, repoCount: 0,
    perTableCounts: { files: 1 }, completedAt: 5,
  },
  staging: proof,
  active: proof,
  qSibling: { path: "/w/.rbox/state.json.migrate.m1.q", bytes: 58, sha256: HASH, disposition: { state: "absent" } },
  cleanup: { items: [item("reserve", 7), item("emergency", 8)], durablePrefix: 1, currentIntent: { index: 2 } },
  futureControls: {
    kind: "promoted-halt",
    origin: { path: "/w/o", revision: 9, dev: 1, ino: 10 },
    preparedSuccess: { path: "/w/s", revision: 10, dev: 1, ino: 11, bytes: 500 },
  },
};

const control = (over: Partial<MigrationControl> = {}): MigrationControl => ({
  version: 1, controlRevision: 1, migrationId: "m1", authorityId: "a1",
  source, stagingPath: "/w/.rbox/state/state.db.migrate.m1",
  witness: { phase: "M0" },
  haltResources: { reserve: { disposition: "not-created" }, emergency: { disposition: "not-created" } },
  halt: null, retirement: null,
  ...over,
});

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
  test("round-trips every phase's witness", () => {
    for (const witness of [{ phase: "M0" } as const, M6_WITNESS]) {
      const original = control({ witness });
      expect(decodeMigrationControl(encodeMigrationControl(original))).toEqual(original);
    }
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

  test("rejects a cursor whose intent is not the item after its durable prefix", () => {
    const witness = { ...M6_WITNESS, cleanup: { items: [item("reserve", 7)], durablePrefix: 0, currentIntent: { index: 2 } } };
    expect(() => encodeMigrationControl(control({ witness }))).toThrow(MigrationControlError);
  });

  test("rejects a preparation ledger whose revisions are not exactly spaced", () => {
    const witness = {
      ...M6_WITNESS,
      futureControls: {
        kind: "preparing", baseRevision: 4, readyRevision: 8, haltRevision: 9, successRevision: 11,
        halt: { state: "absent" }, success: { state: "absent" },
      },
    } as MigrationWitness;
    expect(() => encodeMigrationControl(control({ witness }))).toThrow(MigrationControlError);
  });

  test("refuses a record over the 64 KiB cap", () => {
    const items = Array.from({ length: 4000 }, (_, i) => item("reserve", i));
    const witness = { ...M6_WITNESS, cleanup: { items, durablePrefix: 0, currentIntent: null } };
    expect(() => encodeMigrationControl(control({ witness }))).toThrow(/over the 65536 cap/);
  });

  test("blocksSqliteWrites: below M6 and durability-indeterminate block, cleanup-deferred does not", () => {
    const halt = (code: "durability-indeterminate" | "cleanup-deferred") =>
      ({ code, underlyingCode: null, required: null, available: null });
    expect(blocksSqliteWrites(control())).toBe(true);
    expect(blocksSqliteWrites(control({ witness: M6_WITNESS }))).toBe(false);
    expect(blocksSqliteWrites(control({ witness: M6_WITNESS, halt: halt("cleanup-deferred") }))).toBe(false);
    expect(blocksSqliteWrites(control({ witness: M6_WITNESS, halt: halt("durability-indeterminate") }))).toBe(true);
  });

  test("isFinalIntentPromotedHalt names only the promoted final-intent halt", () => {
    const halted = control({
      witness: M6_WITNESS,
      halt: { code: "cleanup-deferred", underlyingCode: null, required: null, available: null },
    });
    expect(isFinalIntentPromotedHalt(halted)).toBe(true);
    expect(isFinalIntentPromotedHalt(control({ witness: M6_WITNESS }))).toBe(false);
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

  test("refuses a first control that is not revision 1, and any gap but a promotion's r+2", () => {
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

  test("promotes a prepared sibling across the r -> r+2 gap and refuses a mutated one", () => {
    const root = workspace();
    publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks);
    const prepared = renderPreparedControl(root, 3, control({ controlRevision: 3 }), locks);
    expect(fs.statSync(prepared.path).size).toBe(prepared.bytes);

    const tampered = renderPreparedControl(root, 4, control({ controlRevision: 4, authorityId: "other" }), locks);
    fs.writeFileSync(tampered.path, Buffer.from(encodeMigrationControl(control({ controlRevision: 4 }))));
    expect(() => promotePreparedControl(root, { migrationId: "m1", revision: 1 }, { ...tampered, revision: 3 }, locks))
      .toThrow(/prepared-foreign/);

    const promoted = promotePreparedControl(root, { migrationId: "m1", revision: 1 }, prepared, locks);
    expect(promoted.controlRevision).toBe(3);
    expect(fs.existsSync(prepared.path)).toBe(false);
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

  test("a halt that cannot be published is nondurable and carries no control", () => {
    const root = workspace();
    const base = publishMigrationControl(root, { migrationId: "absent", revision: "absent" }, control(), locks);
    fs.rmSync(path.join(root, ".rbox", "state", "migration-v1.json"));
    const outcome = publishMigrationHalt(root, base, { code: "filesystem-full", underlyingCode: "ENOSPC", required: 1, available: 0 }, locks);
    expect(outcome).toEqual({ durable: false, reason: expect.any(MigrationControlError) });
  });
});
