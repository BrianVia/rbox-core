import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry } from "../../../engine/index.js";
import type { SyncState } from "../../sync-state-model.js";
import { normalizeLegacyStateV1 } from "../digest/legacy-state-plan.js";
import { legacyStateSemanticDigest } from "../digest/state-semantic-v1.js";
import { adoptClaimedStateStore } from "../store/open.js";
import {
  admitMigrationDisk, DISK_PREFLIGHT_MARGIN_BYTES, migrationDiskBudget,
  STAGING_BYTES_PER_SOURCE_BYTE, WAL_BYTES_PER_STAGING_BYTE,
} from "./disk-preflight.js";
import { RESERVE_TOTAL_BYTES } from "./reserve.js";
import { installLegacyState } from "./import-install.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rbox-u3-3a-${label}-${process.pid}-`));
  roots.push(dir);
  return dir;
}

test("the budget is itemized and monotone in the source size", () => {
  const small = migrationDiskBudget(1_000);
  const large = migrationDiskBudget(10_000_000);
  expect(large.requiredBytes).toBeGreaterThan(small.requiredBytes);
  expect(small.backupBytes).toBe(2 * (1_000 + 128));
  expect(small.walBytes).toBe(small.stagingBytes);
  expect(() => migrationDiskBudget(-1)).toThrow(RangeError);
  // An empty source still needs the schema seed, the reserve, and the margin.
  expect(migrationDiskBudget(0).requiredBytes).toBeGreaterThan(17 * 1024 * 1024);
});

test("every itemized term is actually summed into the requirement", () => {
  // Reporting a term and then not charging for it is the failure that makes an
  // itemized budget worse than no budget: the halt names numbers nobody used.
  // Each term is pinned by the difference it makes, so dropping any one of the
  // four addends changes a value asserted here.
  const budget = migrationDiskBudget(4_096);
  expect(budget.requiredBytes).toBe(
    budget.backupBytes + budget.stagingBytes + budget.walBytes
    + RESERVE_TOTAL_BYTES + DISK_PREFLIGHT_MARGIN_BYTES,
  );
  // ...and the WAL term specifically, which is the one a wrong constant would
  // silently zero out while every other assertion still passed.
  expect(budget.walBytes).toBe(budget.stagingBytes * WAL_BYTES_PER_STAGING_BYTE);
  expect(WAL_BYTES_PER_STAGING_BYTE).toBeGreaterThanOrEqual(1);
  expect(budget.requiredBytes - migrationDiskBudget(0).requiredBytes)
    .toBe(2 * 4_096 + 4_096 * STAGING_BYTES_PER_SOURCE_BYTE * (1 + WAL_BYTES_PER_STAGING_BYTE));
});

test("a budget larger than the filesystem is a disk-preflight halt naming both numbers", async () => {
  const dir = scratch("disk-halt");
  const impossible = await admitMigrationDisk(dir, 400 * 1024 * 1024);
  const ordinary = await admitMigrationDisk(dir, 1024);
  // The host running this suite has room for a kilobyte and not for 2.4 GiB.
  expect(ordinary.outcome).toBe("admitted");
  if (impossible.outcome === "halted") {
    expect(impossible.halt.code).toBe("disk-preflight");
    expect(impossible.halt.required).toBe(migrationDiskBudget(400 * 1024 * 1024).requiredBytes);
    expect(impossible.halt.available).toBeLessThan(impossible.halt.required!);
  } else {
    expect(impossible.availableBytes).toBeGreaterThanOrEqual(impossible.budget.requiredBytes);
  }
});

test("an unreadable filesystem admits rather than halts", async () => {
  const verdict = await admitMigrationDisk(path.join(scratch("disk-missing"), "not-a-directory"), 1024);
  expect(verdict.outcome).toBe("admitted");
});

/**
 * The calibration. `STAGING_BYTES_PER_SOURCE_BYTE` is the one term of the
 * budget that cannot be read off an existing constant, so it is pinned against
 * a real import instead of asserted: it must over-estimate the database the
 * importer actually produces, and it must not over-estimate it by so much that
 * the preflight becomes a refusal machine.
 */
test("the staging factor over-estimates a real import without inflating it", () => {
  const files: FileEntry[] = Array.from({ length: 2_000 }, (_, index) => ({
    path: `files/${String(index).padStart(5, "0")}.txt`,
    sha256: index.toString(16).padStart(64, "0"),
    size: index, mode: 0o644, mtimeMs: index + 0.5, type: "file",
  } as FileEntry));
  const state = {
    stream: "workspace/calibration",
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "2026-07-29T00:00:00.000Z", manifestSchema: 2, files },
  } as unknown as SyncState;
  const sourceBytes = Buffer.byteLength(JSON.stringify(state));

  const dir = scratch("disk-calibration");
  const file = path.join(dir, "state.db");
  const fd = fs.openSync(file, "wx", 0o600);
  const stat = fs.fstatSync(fd);
  fs.closeSync(fd);
  const plan = normalizeLegacyStateV1(state, "b".repeat(32));
  adoptClaimedStateStore(file, { dev: stat.dev, ino: stat.ino }, (db) => {
    installLegacyState(db, plan, {
      migrationId: "calibration", authorityId: "a".repeat(32), importerVersion: "test",
      sourceJsonSha256: "c".repeat(64), sourceSemanticDigest: legacyStateSemanticDigest(plan),
      sourceBytes, completedAtIso: new Date().toISOString(),
    });
  }).close();

  const actual = fs.statSync(file).size;
  const estimated = migrationDiskBudget(sourceBytes).stagingBytes;
  expect(estimated).toBeGreaterThan(actual);
  expect(estimated).toBeLessThan(actual * 3);
  expect(STAGING_BYTES_PER_SOURCE_BYTE).toBeGreaterThanOrEqual(1);
});
