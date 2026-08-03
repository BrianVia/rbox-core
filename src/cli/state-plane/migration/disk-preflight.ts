/**
 * M1's advisory disk budget and the `disk-preflight` halt (163:3384).
 *
 * Wave 2B left this undecided on purpose: the budget is the sum of artifacts
 * only this lane knows the size of, and a guessed multiplier would put a
 * fabricated number into a durable halt record. Every term below is therefore
 * either a measured constant already in the tree or a factor pinned by
 * `disk-preflight.test.ts` against a real import — the factor is falsifiable,
 * not asserted.
 *
 * 163 is explicit that the estimate is NOT authoritative: sparse files, quotas,
 * concurrent consumers, and delayed allocation all defeat it. Its only job is
 * an early refusal that keeps a doomed migration from touching anything. Every
 * write, rename, and fsync in M0–M7 still handles `ENOSPC` on its own row.
 */
import { statfs } from "node:fs/promises";
import { RESET_SCHEMA_V1_EMPTY_SEED_BYTES } from "../reset/artifacts.js";
import type { MigrationHalt } from "./health.js";
import { RESERVE_TOTAL_BYTES } from "./reserve.js";

/**
 * Staging bytes per source byte, covering row values, both path-order indexes,
 * the entry fingerprint index, and page slack. Pinned by a calibration test
 * that imports a real corpus and asserts this over-estimates the resulting
 * database while staying under 2× the truth — so it cannot silently drift into
 * either a useless number or a refusal machine.
 */
export const STAGING_BYTES_PER_SOURCE_BYTE = 8;

/** One full rewrite of the staging database can sit in the WAL before M4's
 * checkpoint truncates it, so the log is budgeted at the database's own size. */
export const WAL_BYTES_PER_STAGING_BYTE = 1;

/** Fixed headroom for directory entries, the emergency candidate, and the
 * rounding every filesystem does. Not a fudge factor for the terms above. */
export const DISK_PREFLIGHT_MARGIN_BYTES = 16 * 1024 * 1024;

export interface DiskBudget {
  /** Worst-case bytes M1–M6 may need beyond what already exists. */
  readonly requiredBytes: number;
  /** The two backup copies: the immutable history entry and the fixed one. */
  readonly backupBytes: number;
  readonly stagingBytes: number;
  readonly walBytes: number;
}

/**
 * The budget, itemized so the halt record and doctor copy can both name real
 * quantities. The preamble line is charged with the copies it prefixes.
 */
export function migrationDiskBudget(sourceBytes: number): DiskBudget {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
    throw new RangeError("migration source size must be a non-negative safe integer");
  }
  const backupBytes = 2 * (sourceBytes + 128);
  const stagingBytes = RESET_SCHEMA_V1_EMPTY_SEED_BYTES + sourceBytes * STAGING_BYTES_PER_SOURCE_BYTE;
  const walBytes = stagingBytes * WAL_BYTES_PER_STAGING_BYTE;
  return {
    requiredBytes: backupBytes + stagingBytes + walBytes + RESERVE_TOTAL_BYTES + DISK_PREFLIGHT_MARGIN_BYTES,
    backupBytes,
    stagingBytes,
    walBytes,
  };
}

export type DiskVerdict =
  | { readonly outcome: "admitted"; readonly budget: DiskBudget; readonly availableBytes: number }
  | { readonly outcome: "halted"; readonly halt: MigrationHalt<"disk-preflight"> };

/**
 * The advisory `statfs`. An unreadable filesystem is admitted rather than
 * halted: this check exists to refuse a migration that provably cannot fit, and
 * refusing one because the estimate itself failed would convert a diagnostic
 * into an outage. The real defence is every phase's own `ENOSPC` row.
 */
export async function admitMigrationDisk(root: string, sourceBytes: number): Promise<DiskVerdict> {
  const budget = migrationDiskBudget(sourceBytes);
  let availableBytes: number;
  try {
    const stats = await statfs(root);
    availableBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return { outcome: "admitted", budget, availableBytes: Number.POSITIVE_INFINITY };
  }
  if (!Number.isFinite(availableBytes) || availableBytes >= budget.requiredBytes) {
    return { outcome: "admitted", budget, availableBytes };
  }
  return {
    outcome: "halted",
    halt: {
      code: "disk-preflight", underlyingCode: null,
      required: budget.requiredBytes, available: Math.floor(availableBytes),
    },
  };
}
