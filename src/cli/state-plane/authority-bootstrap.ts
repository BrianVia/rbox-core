/** File-level state-authority observation, ordinary SQLite genesis admission,
 * and the state-plane write fence. Explicit migration has its own command owner;
 * this module never dispatches between genesis and migration. */
import { randomBytes } from "node:crypto";
import type { LockUnsupportedReason } from "../../engine/lockfile.js";
import type { WorkspaceSyncMutex } from "../sync-mutex.js";
import { classifyStateFormat, readAuthorityMarkerId } from "./authority-marker.js";
import { StateAuthorityCorruptError } from "./errors.js";
import type { GenesisIds } from "./genesis.js";
// Not from `genesis.js`: the fence's reachable graph must contain no SQLite.
import { readGenesisIntent } from "./genesis-intent.js";
import { statePath } from "./paths.js";
import { GENESIS_ADMISSION_REFUSAL_COPY } from "../state-plane-copy.js";

/** The durable state backend observed from `.rbox/state.json` alone. Absence is
 * not a legacy backend: it is the lack of any selected authority. */
export type StateAuthorityObservation =
  | { readonly kind: "uninitialized"; readonly format: "absent" }
  | {
      readonly kind: "legacy-json-store";
      readonly format: "json" | "foreign";
    }
  | {
      readonly kind: "sqlite-store";
      readonly format: "authority-marker";
      readonly authorityId: string;
    };

/**
 * Observe the state authority without taking locks, opening SQLite, or reading
 * admission records. Only an exact authority marker selects the store.
 */
export async function observeStateAuthority(root: string): Promise<StateAuthorityObservation> {
  const format = await classifyStateFormat(statePath(root));
  if (format === "absent") return { kind: "uninitialized", format };
  if (format !== "authority-marker") return { kind: "legacy-json-store", format };
  const authorityId = await readAuthorityMarkerId(statePath(root));
  if (authorityId === undefined) {
    throw new StateAuthorityCorruptError(
      statePath(root),
      "the authority marker changed while it was being read",
    );
  }
  return { kind: "sqlite-store", format, authorityId };
}

export type GenesisAdmissionRefusal = {
  readonly reason:
    | "lock-unsupported"
    | "lock-indeterminate"
    | "lock-identity-unavailable"
    | "lock-io";
  readonly layer: "workspace" | "state";
  readonly error?: unknown;
};

export type GenesisAdmissionResult =
  | {
      readonly kind: "selected";
      readonly authority: Exclude<StateAuthorityObservation, { kind: "uninitialized" }>;
    }
  | { readonly kind: "refused"; readonly refusal: GenesisAdmissionRefusal };

/** Typed exception used only by adapters whose existing signature cannot carry
 * the result union (foreground/daemon state loading). */
export class GenesisAdmissionRefusedError extends Error {
  constructor(readonly refusal: GenesisAdmissionRefusal) {
    const copy = GENESIS_ADMISSION_REFUSAL_COPY[refusal.reason].human;
    super(`${copy.problem}\n${copy.safety}`);
    this.name = "GenesisAdmissionRefusedError";
  }
}

export function requireSelected(
  result: GenesisAdmissionResult,
): Exclude<StateAuthorityObservation, { kind: "uninitialized" }> {
  if (result.kind === "refused") throw new GenesisAdmissionRefusedError(result.refusal);
  return result.authority;
}

/**
 * Complete genesis admission for a caller that already owns the workspace
 * mutex. The handle is borrowed, and the returned selection is always a fresh
 * observation of the durable authority bytes.
 */
export async function admitGenesisAuthority(
  root: string,
  heldMutex: WorkspaceSyncMutex,
): Promise<GenesisAdmissionResult> {
  const intent = readGenesisIntent(root);
  const selection = await observeStateAuthority(root);
  if (intent === undefined && selection.kind !== "uninitialized") {
    return { kind: "selected", authority: selection };
  }

  if (heldMutex.lockFailure) {
    return { kind: "refused", refusal: admissionRefusal("workspace", heldMutex.lockFailure.reason, heldMutex.lockFailure.error) };
  }
  if (heldMutex.degraded !== undefined || !heldMutex.lock) {
    return {
      kind: "refused",
      refusal: admissionRefusal("workspace", "identity-unavailable", heldMutex.degraded?.detail),
    };
  }

  const [{ StateLockAcquisitionError, withGenesisAdmissionLocks }, genesis] = await Promise.all([
    import("./locks.js"),
    import("./genesis.js"),
  ]);
  try {
    return await withGenesisAdmissionLocks(root, heldMutex, async (locks): Promise<GenesisAdmissionResult> => {
      const lockedIntent = readGenesisIntent(root);
      const lockedSelection = await observeStateAuthority(root);
      if (lockedIntent === undefined && lockedSelection.kind !== "uninitialized") {
        return { kind: "selected", authority: lockedSelection };
      }

      const outcome = await genesis.establish(root, mintIds, locks);
      const fresh = await observeStateAuthority(root);
      const survivingIntent = readGenesisIntent(root);
      if ((outcome.kind === "established" || outcome.kind === "already-established")
        && (fresh.kind !== "sqlite-store" || survivingIntent !== undefined)) {
        throw new StateAuthorityCorruptError(
          statePath(root),
          "genesis completed without publishing a settled SQLite authority",
        );
      }
      // A same-window legacy race is genesis's one owned refusal/cleanup case.
      // The fresh file-level observation is then the selected legacy authority.
      if (outcome.kind === "refused" && outcome.reason === "legacy-present"
        && fresh.kind === "legacy-json-store" && survivingIntent === undefined) {
        return { kind: "selected", authority: fresh };
      }
      if (fresh.kind === "uninitialized" || survivingIntent !== undefined) {
        throw new StateAuthorityCorruptError(
          statePath(root),
          `genesis stopped without selecting a settled authority (${outcome.kind})`,
        );
      }
      return { kind: "selected", authority: fresh };
    });
  } catch (error) {
    if (error instanceof StateLockAcquisitionError) {
      if (error.outcome.status === "held") throw error;
      if (error.outcome.status === "unsupported") {
        return {
          kind: "refused",
          refusal: admissionRefusal("state", error.outcome.reason, error.outcome.error),
        };
      }
      // `error` and every other non-`unsupported` outcome: the acquisition
      // failed for a reason the lock layer did not classify. "io" is what that
      // is; naming it `link-capacity` would assert a diagnosis nobody made.
      return {
        kind: "refused",
        refusal: admissionRefusal("state", "io", error.outcome.error),
      };
    }
    throw error;
  }
}

export interface GenesisLockingProbe {
  /** Absent when every directory the probe could test published a lock. */
  readonly refusal?: GenesisAdmissionRefusal;
  /** What was tested, what was not, and why — empty only when the probe reached
   * a refusal before observing anything. A directory that reported its probe
   * lock held is named here rather than counted as a pass. */
  readonly explanation: string;
}

/**
 * Doctor's advisory configured-root probe: can this filesystem publish the
 * hardlink locks genesis needs, in the directories genesis needs them?
 *
 * Doctor's §1.1 contract is ZERO mutation, so this creates no directory an
 * uninitialized root does not already have — it tests the nearest EXISTING
 * ancestor instead, and says which one. It also never touches a real lock path:
 * a probe that took `sync.lock` would be a diagnostic that can block the very
 * operation the operator runs next. The probe names are unique per invocation
 * and belong to no protocol, so nothing else can be waiting on them.
 */
export async function probeGenesisLocking(root: string): Promise<GenesisLockingProbe> {
  const [{ acquireLock }, fs, path] = await Promise.all([
    import("../../engine/lockfile.js"),
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const exists = async (dir: string): Promise<boolean> =>
    fs.stat(dir).then((entry) => entry.isDirectory(), () => false);
  const rboxDir = path.join(root, ".rbox");
  const stateDir = path.join(rboxDir, "state");
  // Each genesis lock lives in a different directory, so each is its own answer:
  // `.rbox/state.json.lock` beside the authority, `.rbox/state/sync.lock` in the
  // state directory a fresh root may not have yet.
  const layers = [
    { layer: "state" as const, dir: rboxDir },
    { layer: "workspace" as const, dir: stateDir },
  ];
  const tested: string[] = [];
  const skipped: string[] = [];
  for (const { layer, dir } of layers) {
    if (!await exists(dir)) {
      skipped.push(`${path.relative(root, dir) || "."} does not exist yet, so its locking is untested`);
      continue;
    }
    const file = path.join(dir, `.rbox-locking-probe.${process.pid}.${hex32()}.lock`);
    const acquired = await acquireLock(file);
    if (acquired.status === "unsupported") {
      return {
        refusal: admissionRefusal(layer, acquired.reason, acquired.error),
        explanation: probeStory(tested, skipped),
      };
    }
    if (acquired.status === "error") {
      return { refusal: { reason: "lock-io", layer, error: acquired.error }, explanation: probeStory(tested, skipped) };
    }
    if (acquired.status === "held") {
      // A unique name nobody else knows cannot be legitimately contended, so
      // this is an anomaly rather than a refusal — but it is not a pass either,
      // and the operator is told rather than shown a clean bill of health.
      skipped.push(`${path.relative(root, dir) || "."} reported its probe lock already held; its locking is untested`);
      continue;
    }
    const released = await acquired.lock.release();
    if (!released.released || !released.durable) {
      return { refusal: admissionRefusal(layer, "io", released.error), explanation: probeStory(tested, skipped) };
    }
    tested.push(path.relative(root, dir) || ".");
  }
  return { explanation: probeStory(tested, skipped) };
}

function probeStory(tested: readonly string[], skipped: readonly string[]): string {
  const parts = tested.length > 0 ? [`locking works in ${tested.join(" and ")}`] : [];
  return [...parts, ...skipped].join("; ");
}

/** Fresh ids for a fresh attempt. Genesis calls this at most once and never on
 * a resume, where the intent is the sole source of both ids (§2.4). */
function mintIds(): GenesisIds {
  return { authorityId: hex32(), lineageId: hex32() };
}

function hex32(): string {
  return randomBytes(16).toString("hex");
}

function admissionRefusal(
  layer: GenesisAdmissionRefusal["layer"],
  reason: LockUnsupportedReason | "io",
  error?: GenesisAdmissionRefusal["error"],
): GenesisAdmissionRefusal {
  const refusalReason = reason === "hardlink-unsupported"
    ? "lock-unsupported"
    : reason === "indeterminate"
      ? "lock-indeterminate"
      : reason === "identity-unavailable"
        ? "lock-identity-unavailable"
        : "lock-io";
  if (error === undefined) return { reason: refusalReason, layer };
  return { reason: refusalReason, layer, error };
}
