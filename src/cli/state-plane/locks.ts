/**
 * The state-plane lock bundle and the two admitted entry sites (design 222 §3.1,
 * §3.2 — 163's `MIGRATION-EXCLUSIVITY-v11` "parked car" rule).
 *
 * The repository fence is callback-scoped, so the bundle is a witness of what is
 * held rather than a set of handles. `withStatePlaneLocks` is its only mint
 * site: the brand below has no exported name, so no other module can construct
 * one without an explicit cast.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { repoCtxFromDisk } from "../../engine/git/shared.js";
import { acquireLock, type OwnedLock } from "../../engine/git/lockfile.js";
import { withRepositoryRecoveryFence, type RepositoryProtocolFenceRequest } from "../../engine/git/protocol-locks.js";
import { repositoryIdentityForContext, repositoryIdentityHash } from "../../engine/git/repo-lineage.js";
import { ResetMemoryAdmissionError } from "../reset-io.js";
import { readResetJournal, recoverResetJournalUnderHeldFence } from "../reset-journal.js";
import { repoRecordsForState } from "../sync-state-model.js";
import {
  acquireWorkspaceSyncMutex,
  releaseWorkspaceSyncMutex,
  workspaceSyncMutexDegraded,
  type SyncMutexOptions,
  type WorkspaceSyncMutex,
} from "../sync-mutex.js";
import { loadConfigIfPresent, syncStreamId } from "../workspace-config.js";
import { loadRawState } from "./adapters/whole-state-compat.js";
import { classifyStateFormat, type StateFormat } from "./authority-marker.js";
import { blocksSqliteWrites } from "./migration/control-codec.js";
import { readCanonicalControl } from "./migration/control-publication.js";
import { stateLockPath, statePath } from "./paths.js";

const heldStatePlaneLocks: unique symbol = Symbol("held-state-plane-locks");

/** Proof that the complete state-plane lock set is held right now. */
export interface HeldStatePlaneLocks {
  readonly mutex: WorkspaceSyncMutex;
  readonly stateLock: OwnedLock;
  readonly underRepositoryFence: true;
  readonly [heldStatePlaneLocks]: true;
}

/** The two admitted ways to be inside an exclusivity window (163:184). */
export type EntryPoint = "upgrade-stop-window" | "foreground-migrate";
export interface EntryProof {
  readonly entry: EntryPoint;
  readonly locks: HeldStatePlaneLocks;
}

/** 163:2393's first M0 condition. Defined here because the mutex is what
 * answers it, and admission's refusal union imports this exact member so one
 * code exists rather than two that could drift. */
export interface DegradedFenceRefusal {
  readonly code: "degraded-fence";
  readonly detail: string;
}

/**
 * The parse budget refused the legacy document, so the inventory this fence is
 * derived from could not be read at all (163:3309's envelope, measured).
 *
 * It shares the `memory-admission` name with the halt code deliberately — one
 * condition, one word of copy — but it is NEVER a halt: it is raised while
 * deriving the read-only inventory, before a mutex is minted or any artifact is
 * touched, so there is nothing durable for a halt to describe. A 16 GiB host
 * with an 81 MB `state.json` reaches this on every attempt.
 */
export interface MemoryAdmissionRefusal {
  readonly code: "memory-admission";
  readonly detail: string;
}

export type StatePlaneLockRefusal = DegradedFenceRefusal | MemoryAdmissionRefusal;

/** The bundle was held, or it was refused before anything was locked or
 * written. A degraded workspace is a refusal with user-facing copy, not an
 * exception — and not a body that runs anyway. */
export type StatePlaneLockOutcome<T> =
  | { readonly held: true; readonly value: T }
  | { readonly held: false; readonly refusal: StatePlaneLockRefusal };

export interface StatePlaneLockOptions {
  /** Bounded restarts when the fenced recheck sees a changed inventory. */
  readonly attempts?: number;
  /** Passed to the workspace mutex acquisition. */
  readonly mutex?: SyncMutexOptions;
  /** Test seam: observe each acquisition stage in order. */
  readonly onStage?: (stage: StatePlaneLockStage) => void | Promise<void>;
}

export type StatePlaneLockStage =
  | "mutex"
  | "inventory"
  | "fence"
  | "state-lock"
  | "fenced-recheck"
  | "reset-recovery"
  | "body";

interface RepositoryRequest extends RepositoryProtocolFenceRequest {
  readonly relPath: string;
  readonly identityHash: string;
}

interface Inventory {
  readonly requests: readonly RepositoryRequest[];
  readonly stream: string | undefined;
  readonly standingResetJournal: boolean;
}

const inventoryFingerprint = (inventory: Inventory): string => JSON.stringify([
  inventory.requests.map((request) =>
    [request.relPath, request.commonDir, request.identityHash, [...request.reflogRefs ?? []], request.origins === true]),
  inventory.stream ?? null,
  inventory.standingResetJournal,
]);

/**
 * Is the authority marker live AND the state-plane write fence up?
 *
 * This is the one window where reading the store is not free. The `M5 + Q` row
 * requires the database to be **at rest** — M4 checkpoints and closes before M5
 * is published — and the classifier reads a live `-wal`/`-shm` there as
 * corruption. An inventory read that opened the store would create exactly those
 * sidecars, so a legitimate crash between M5's rename and M6's publication would
 * classify as a never-retryable `StateAuthorityCorruptError` instead of resuming.
 * The re-entry fix introduced that window; this closes it.
 *
 * Naming no repositories is not a weaker fence here, it is the correct one: the
 * fence is up precisely because nothing but the migration may act, and M5→M6
 * touches no repository. Both readers are file-level and SQLite-free by
 * construction — that is why `assertAuthorityWritable` is built out of them —
 * so deciding this cannot itself deposit what it exists to avoid.
 */
function fencedUnderMarker(format: StateFormat, root: string): boolean {
  if (format !== "authority-marker") return false;
  try {
    const control = readCanonicalControl(root);
    return control !== undefined && blocksSqliteWrites(control);
  } catch {
    // An unreadable control is the classifier's verdict to make, not this
    // function's. Fall through to the ordinary read.
    return false;
  }
}

/**
 * Read-only inventory of everything the fence must cover: the repositories the
 * current state names, plus any standing reset transaction's own repositories.
 * Derived before the fence and re-derived under it — a change between the two
 * restarts the acquisition rather than proceeding on a stale request set.
 */
async function inspectInventory(root: string): Promise<Inventory> {
  // The whole-state SELECTOR, not the JSON reader (wave 5B).
  //
  // Post-`Q` the repository records live in SQLite. Reading them through the
  // legacy document derived a fence that covered nothing, so this refused
  // outright with `StateFormatTooNewError` — which made every lock bundle
  // unobtainable on a workspace that had just been migrated, and therefore made
  // `rbox migrate` unable to report success on its own work and
  // `--retry-state-migration` unreachable on the two post-`Q` halts that exist
  // precisely to be retried (222 §3.2's annotated debt).
  //
  // The selector answers both formats with one signature, so the fence covers
  // the same repositories either way and there is no second inventory to keep in
  // step.
  const config = await loadConfigIfPresent(root).catch(() => undefined);
  const stream = config ? syncStreamId(config) : undefined;
  const state = fencedUnderMarker(await classifyStateFormat(statePath(root)), root)
    ? undefined
    : await loadRawState(root);
  const requests = new Map<string, RepositoryRequest>();
  for (const [relPath, record] of Object.entries(state ? repoRecordsForState(state) : {}).sort(([a], [b]) => a < b ? -1 : 1)) {
    const repoDir = relPath === "." ? root : path.join(root, ...relPath.split("/"));
    const ctx = await repoCtxFromDisk(repoDir);
    const branchRefs = Object.keys(record.base?.refs ?? {}).filter((ref) => ref.startsWith("refs/heads/")).sort();
    if (!ctx) {
      if (branchRefs.length || Object.keys(record.branchBaseOrigins ?? {}).length) {
        throw new Error(`state-plane locks refused: repository identity unavailable for ${relPath}`);
      }
      continue;
    }
    const worktreeId = await fs.realpath(ctx.repoDir).catch(() => path.resolve(ctx.repoDir));
    const identity = await repositoryIdentityForContext(relPath, ctx, worktreeId);
    requests.set(relPath, {
      relPath, commonDir: ctx.commonDir, reflogRefs: branchRefs, origins: true,
      identityHash: repositoryIdentityHash(identity),
    });
  }

  const journal = await readResetJournal(root);
  for (const entry of journal?.old.z ?? []) {
    const relPath = `reset:${entry.repositoryIdentity.commonDirReal}`;
    requests.set(relPath, {
      relPath,
      commonDir: entry.repositoryIdentity.commonDirReal,
      reflogRefs: [entry.activeRef, entry.recoveryRef].sort(),
      origins: true,
      identityHash: repositoryIdentityHash(entry.repositoryIdentity),
    });
  }
  return {
    requests: [...requests.values()].sort((a, b) => a.relPath < b.relPath ? -1 : 1),
    stream,
    standingResetJournal: journal !== undefined,
  };
}

/**
 * The inventory read's own refusal, carried out of the fence by an exception
 * because the two `inspectInventory` call sites sit at different depths. Minted
 * here and nowhere else, so the single catch in `withStatePlaneLocks` cannot
 * capture a refusal the body raised after writing something.
 */
class InventoryRefused extends Error {
  constructor(readonly refusal: StatePlaneLockRefusal) {
    super(refusal.detail);
    this.name = "InventoryRefused";
  }
}

async function readInventory(root: string): Promise<Inventory> {
  try {
    return await inspectInventory(root);
  } catch (error) {
    if (error instanceof ResetMemoryAdmissionError) {
      throw new InventoryRefused({ code: "memory-admission", detail: error.message });
    }
    throw error;
  }
}

/** Finish any standing reset transaction before the caller observes the
 * workspace: a migration may not begin on a half-completed reset. */
async function completeStandingReset(root: string, inventory: Inventory, stateLock: OwnedLock): Promise<void> {
  if (!inventory.standingResetJournal) return;
  if (!inventory.stream) throw new Error("state-plane locks refused: reset recovery needs the durable config stream");
  await recoverResetJournalUnderHeldFence(root, inventory.stream, {}, stateLock);
}

/**
 * Acquire the complete state-plane lock set in design 222 §3.1's order and run
 * `fn` inside it: healthy workspace mutex, read-only inventory, repository
 * recovery fence, state lock, fenced recheck, standing reset recovery, body.
 *
 * A degraded workspace never reaches any of that. `completeStandingReset` below
 * copies, creates, and renames, so the degraded check has to precede it — a
 * workspace whose locking is known unreliable is exactly the population
 * `degraded-fence` exists to keep away from state mutation. It is reported as a
 * refusal so the caller can print 163:2446's copy instead of a stack trace.
 *
 * The inventory read is the second refusal for the same reason. It parses the
 * whole legacy document, so on a small-memory host it is the FIRST thing an
 * oversized `state.json` stops — earlier than M0's own `memory-admission` halt
 * can ever be consulted. This function promises a typed outcome, so that
 * measurement arrives as one, not as a `RangeError` out of the fence.
 *
 * The mutex's other two health axes are not rechecked here: it was acquired for
 * this exact root one statement earlier, and ownership is verified where the
 * answer is consumed rather than where the handle is made — admission's
 * exclusivity-window condition, which is re-called before the M6 rename.
 */
export async function withStatePlaneLocks<T>(
  root: string,
  fn: (locks: HeldStatePlaneLocks) => Promise<T>,
  options: StatePlaneLockOptions = {},
): Promise<StatePlaneLockOutcome<T>> {
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    const mutex = await acquireWorkspaceSyncMutex(root, "cli", options.mutex);
    try {
      if (workspaceSyncMutexDegraded(mutex)) {
        return {
          held: false,
          refusal: { code: "degraded-fence", detail: mutex.degraded?.reason ?? "identity-unavailable" },
        };
      }
      await options.onStage?.("mutex");
      const inventory = await readInventory(root);
      await options.onStage?.("inventory");
      const restart = await withRepositoryRecoveryFence(inventory.requests, path.resolve(statePath(root)), async () => {
        await options.onStage?.("fence");
        const acquired = await acquireLock(stateLockPath(root));
        if (acquired.status !== "acquired") {
          throw new Error(`state-plane locks refused: the sync state lock is unavailable (${acquired.status})`);
        }
        const stateLock = acquired.lock;
        try {
          await options.onStage?.("state-lock");
          if (inventoryFingerprint(await readInventory(root)) !== inventoryFingerprint(inventory)) {
            return { restart: true as const };
          }
          await options.onStage?.("fenced-recheck");
          await completeStandingReset(root, inventory, stateLock);
          await options.onStage?.("reset-recovery");
          if (!await stateLock.isOwner()) throw new Error("state-plane locks refused: state lock ownership was lost");
          await options.onStage?.("body");
          const locks = {
            mutex, stateLock, underRepositoryFence: true, [heldStatePlaneLocks]: true,
          } satisfies HeldStatePlaneLocks;
          return { restart: false as const, value: await fn(locks) };
        } finally {
          await stateLock.release();
        }
      });
      if (!restart.restart) return { held: true, value: restart.value };
    } catch (error) {
      if (error instanceof InventoryRefused) return { held: false, refusal: error.refusal };
      throw error;
    } finally {
      await releaseWorkspaceSyncMutex(mutex);
    }
    if (attempt >= attempts) {
      throw new Error(`state-plane locks refused: the workspace kept changing under the fence (${attempts} attempts)`);
    }
  }
}
