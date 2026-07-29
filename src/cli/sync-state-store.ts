/**
 * Compatibility facade for the legacy JSON state store (thermo sweep #4, T1.1
 * step 2). The path policy now lives in `state-plane/paths.ts` and the raw JSON
 * access, JSON CAS, unsafe whole writes, telemetry mutation, and incarnation
 * publication now live in `state-plane/adapters/legacy-json-store.ts`. Every
 * historical caller keeps its exact `./sync-state-store.js` import through this
 * re-export surface; nothing here adds logic.
 */
export { statePath, stateLockPath } from "./state-plane/paths.js";
/** Whole-state access selects its backend from the state document's bytes
 * (design 222 §1.2 A-2); everything below it is JSON-only by construction. */
export {
  applyStateSavePacket,
  loadRawState,
  loadState,
} from "./state-plane/adapters/whole-state-compat.js";
export {
  StreamMismatchError,
  assertResetIncarnationMarkerNormalized,
  ensureCapableStateLineage,
  ensureTelemetryBindingId,
  installGenesisResetStateUnderHeldLock,
  saveState,
  saveStateUnsafeLegacyOrTest,
  stateLockBusyDetail,
} from "./state-plane/adapters/legacy-json-store.js";
export { stateWasStreamMismatch } from "./state-plane/reset-lineage.js";
