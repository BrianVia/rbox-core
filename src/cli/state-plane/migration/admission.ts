/**
 * May a migration begin or continue right now (design 222 §M-4).
 *
 * 163:2386 fixes exactly five M0 admission conditions and no others, in order.
 * They are a table here, not a chain of `if`s, so the order is data the
 * structural test can read and a fault fixture can demonstrably subtract one
 * condition from without editing the production path.
 *
 * Every condition fails closed: an indeterminate observation refuses. Refusals
 * publish nothing, create nothing, and are freely retried.
 */
import fs from "node:fs/promises";
import { isDaemonProcess } from "../../daemon/process-control.js";
import { readDaemonPidRecord } from "../../daemon/runtime-state.js";
import {
  assertResetParseAdmission,
  RESET_MATERIALIZED_BYTE_LIMIT,
  RESET_PARSE_EXPANSION_MULTIPLIER,
  ResetMemoryAdmissionError,
  resetParseBudgetBytes,
} from "../../reset-io.js";
import { assertHealthyOwnedSyncMutex, workspaceSyncMutexDegraded } from "../../sync-mutex.js";
import type { EntryProof } from "../locks.js";
import { migrationPaths, stateLockPath, statePath } from "../paths.js";
import type { AdmissionProof } from "./control-codec.js";
import type { MigrationHalt } from "./health.js";
import {
  inspectStateReserve,
  type ReserveForeignDetail,
} from "./reserve.js";
import { verifyLastWriterWitness, type WitnessVerdict } from "./last-writer-witness.js";

export type AdmissionRefusal =
  | { readonly code: "degraded-fence"; readonly detail: string }
  | { readonly code: "quarantine-pending"; readonly detail: string }
  | { readonly code: "barrier-witness-missing"; readonly verdict: WitnessVerdict }
  | { readonly code: "migration-not-exclusive"; readonly detail: string }
  | { readonly code: "reserve-foreign"; readonly detail: ReserveForeignDetail };

export type AdmissionVerdict =
  | { readonly outcome: "admitted" }
  | { readonly outcome: "refused"; readonly refusal: AdmissionRefusal };

export type BudgetVerdict =
  | { readonly outcome: "admitted"; readonly proof: AdmissionProof }
  | { readonly outcome: "refused"; readonly refusal: Extract<AdmissionRefusal, { code: "reserve-foreign" }> }
  | { readonly outcome: "halted"; readonly halt: MigrationHalt };

/** The five names, in 163:2386's order. */
export type AdmissionConditionName =
  | "locking-health"
  | "no-live-workspace-operation"
  | "quarantine-absent"
  | "barrier-witness"
  | "exclusivity-window";

export interface AdmissionContext {
  readonly root: string;
  readonly entry: EntryProof;
  /** The bounded wait separating the two daemon-liveness samples. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly quietWaitMs?: number;
}

export interface AdmissionCondition {
  readonly name: AdmissionConditionName;
  /** `undefined` admits. */
  evaluate(context: AdmissionContext): Promise<AdmissionRefusal | undefined>;
}

/**
 * 163:2393 — workspace locking health is not `degraded-unlocked`.
 *
 * Read from the live mutex, never from `.rbox/state/locking-health.json`: a
 * successful acquisition deletes that record (`sync-mutex.ts:195`), so by the
 * time the bundle is held the durable copy says nothing. The handle is the only
 * determinate answer.
 */
async function lockingHealth(context: AdmissionContext): Promise<AdmissionRefusal | undefined> {
  const { mutex } = context.entry.locks;
  return workspaceSyncMutexDegraded(mutex)
    ? { code: "degraded-fence", detail: mutex.degraded?.reason ?? "identity-unavailable" }
    : undefined;
}

/**
 * One determinate observation of daemon liveness. A pid record that is present
 * but unparseable is not evidence of quiet: it refuses.
 */
function daemonEvidence(root: string): string | undefined {
  const record = readDaemonPidRecord(root);
  if (!record.present) return undefined;
  if (record.unreadable || record.pid === undefined) return "the daemon pid record could not be read";
  return isDaemonProcess(record.pid) ? `a daemon is running for this workspace (pid ${record.pid})` : undefined;
}

/**
 * 163:2396 — no other live rbox process holds or *recently held* a workspace
 * operation. Two samples separated by a bounded wait: a daemon that appears
 * between them is exactly the "recently held" case, and one sample cannot see
 * it.
 */
async function noLiveWorkspaceOperation(context: AdmissionContext): Promise<AdmissionRefusal | undefined> {
  const before = daemonEvidence(context.root);
  if (before) return { code: "migration-not-exclusive", detail: before };
  await (context.sleep ?? defaultSleep)(context.quietWaitMs ?? QUIET_WAIT_MS);
  const after = daemonEvidence(context.root);
  return after ? { code: "migration-not-exclusive", detail: after } : undefined;
}

async function quarantineAbsent(context: AdmissionContext): Promise<AdmissionRefusal | undefined> {
  const file = migrationPaths.quarantine(context.root);
  try {
    await fs.lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return { code: "quarantine-pending", detail: `${file} could not be inspected (${String(code)})` };
  }
  return { code: "quarantine-pending", detail: `${file} exists` };
}

async function barrierWitness(context: AdmissionContext): Promise<AdmissionRefusal | undefined> {
  const verdict = await verifyLastWriterWitness(context.root, statePath(context.root));
  return verdict.status === "ok" ? undefined : { code: "barrier-witness-missing", verdict };
}

/**
 * 163:2413 (`MIGRATION-EXCLUSIVITY-v11`) — the caller is inside one of the two
 * admitted windows and the complete lock set is still live-owned at this
 * instant. Admission is re-called verbatim immediately before the M6 rename, so
 * this is a re-verification, never a cached fact.
 */
async function exclusivityWindow(context: AdmissionContext): Promise<AdmissionRefusal | undefined> {
  const { entry, locks } = context.entry;
  if (entry !== "upgrade-stop-window" && entry !== "foreground-migrate") {
    return { code: "migration-not-exclusive", detail: `unadmitted entry point ${String(entry)}` };
  }
  if (locks.underRepositoryFence !== true) return { code: "migration-not-exclusive", detail: "the repository fence is not held" };
  if (locks.stateLock.path !== stateLockPath(context.root)) {
    return { code: "migration-not-exclusive", detail: "the state lock is held for a different workspace" };
  }
  try {
    await assertHealthyOwnedSyncMutex(locks.mutex, context.root);
  } catch (error) {
    return { code: "migration-not-exclusive", detail: error instanceof Error ? error.message : String(error) };
  }
  return await locks.stateLock.isOwner()
    ? undefined
    : { code: "migration-not-exclusive", detail: "state lock ownership was lost" };
}

const QUIET_WAIT_MS = 250;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The five conditions, in 163:2386's order. Order is load-bearing: the first
 * refusal is the one reported. */
export const MIGRATION_ADMISSION_CONDITIONS: readonly AdmissionCondition[] = [
  { name: "locking-health", evaluate: lockingHealth },
  { name: "no-live-workspace-operation", evaluate: noLiveWorkspaceOperation },
  { name: "quarantine-absent", evaluate: quarantineAbsent },
  { name: "barrier-witness", evaluate: barrierWitness },
  { name: "exclusivity-window", evaluate: exclusivityWindow },
];

/** Evaluate an ordered condition set. Exported so a fault fixture can run the
 * production conditions minus one and show what the missing one was preventing. */
export async function evaluateAdmission(
  conditions: readonly AdmissionCondition[],
  context: AdmissionContext,
): Promise<AdmissionVerdict> {
  for (const condition of conditions) {
    const refusal = await condition.evaluate(context);
    if (refusal) return { outcome: "refused", refusal };
  }
  return { outcome: "admitted" };
}

/**
 * The M0 admission gate, re-called verbatim immediately before the M6 rename.
 *
 * The design's signature also passed the lock bundle separately; it is dropped,
 * because `EntryProof` already carries it and the only reachable disagreement
 * between the two copies is a bug (the same rule wave 1A applied to the
 * control record's three duplicated members).
 */
export async function admitMigration(
  root: string,
  entry: EntryProof,
  options: Pick<AdmissionContext, "sleep" | "quietWaitMs"> = {},
): Promise<AdmissionVerdict> {
  return evaluateAdmission(MIGRATION_ADMISSION_CONDITIONS, { root, entry, ...options });
}

export interface BudgetOptions {
  readonly budgetBytes?: number;
  readonly currentRssBytes?: number;
}

const halted = (code: MigrationHalt["code"], required: number, available: number): BudgetVerdict =>
  ({ outcome: "halted", halt: { code, underlyingCode: null, required, available } });

/**
 * The M1 admission (163:2684): `S <= 512 MiB` and `52 * S <= budget - RSS`,
 * plus the generic 1 MiB reserve being this workspace's rather than foreign.
 *
 * The envelope arithmetic and its machine-scaled, cgroup-aware budget are the
 * legacy materializer's, called rather than restated — two copies of a
 * fail-closed number is how the two diverge.
 *
 * `disk-preflight` is deliberately NOT decided here: 163:3319 budgets it from
 * staging/backup/WAL size estimates wave 3A owns, and inventing a multiplier
 * would put a made-up number into a durable halt record.
 */
export async function admitMigrationBudget(
  root: string,
  sourceBytes: number,
  stream: string,
  options: BudgetOptions = {},
): Promise<BudgetVerdict> {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
    throw new RangeError("migration source size must be a non-negative safe integer");
  }
  if (sourceBytes > RESET_MATERIALIZED_BYTE_LIMIT) {
    return halted("source-oversize", sourceBytes, RESET_MATERIALIZED_BYTE_LIMIT);
  }
  const budgetBytes = options.budgetBytes ?? resetParseBudgetBytes();
  const currentRssBytes = options.currentRssBytes ?? process.memoryUsage.rss();
  try {
    assertResetParseAdmission(sourceBytes, { processBudgetBytes: budgetBytes, currentRssBytes });
  } catch (error) {
    if (!(error instanceof ResetMemoryAdmissionError)) throw error;
    return halted("memory-admission", error.requiredBytes, error.availableBytes);
  }

  const reserve = await inspectStateReserve(root, stream);
  if (reserve.status === "reserve-foreign") {
    return { outcome: "refused", refusal: { code: "reserve-foreign", detail: reserve.detail } };
  }
  return {
    outcome: "admitted",
    proof: { sourceBytes, requiredBytes: sourceBytes * RESET_PARSE_EXPANSION_MULTIPLIER, budgetBytes },
  };
}
