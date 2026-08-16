/**
 * One owner for the store's raw `CasResult` → whole-state `StateSaveResult`
 * translation: the rejection vocabulary the JSON CAS has always spoken, and the
 * choice between reading the accepted state back and projecting it.
 */
import type { StateSaveResult, SyncState } from "../../sync-state-model.js";
import type { CasRejectionReason, CasResult } from "../ports.js";
import type { StateStoreHandle } from "../store/open.js";

export type StoreFacade = typeof import("../store-facade.js");

type LegacyRejectionReason = Extract<StateSaveResult, { status: "rejected" }>["reason"];

/**
 * Exhaustive by construction: a new `CasRejectionReason` fails to compile here
 * rather than reaching a caller unhandled, and `StateSaveResult` is not widened
 * to carry the store's finer vocabulary. Only five rows are reachable from a
 * caller's packet; the rest describe a store that moved under the held state
 * lock, which the JSON vocabulary calls a nonce or global-sequence mismatch.
 * `elision-drift` is deliberately NOT folded into `nonce`: it is retryable, and
 * `nonce` is the terminal incarnation-change verdict.
 * Exported so the unreachable rows are pinned rather than merely compiled.
 */
export const LEGACY_REJECTION_REASON = {
  lineage: "nonce", stream: "stream", nonce: "nonce",
  "state-revision": "nonce", "base-generation": "global-sequence", "local-revision": "nonce",
  "repo-generation": "repo-generation", "global-sequence": "global-sequence", "owner-lost": "owner-lost",
  "elision-drift": "elision-drift",
} satisfies Record<CasRejectionReason, LegacyRejectionReason>;

export function translateCasResult(
  result: CasResult,
  store: StateStoreHandle,
  facade: StoreFacade,
  /** Design 267 §4: supplied only for a save whose every section was elided. */
  acceptedProjection?: SyncState,
): StateSaveResult {
  switch (result.status) {
    case "accepted":
      return {
        status: "accepted",
        state: acceptedProjection === undefined
          ? facade.loadRawStateFromStore(store)
          : facade.projectAcceptedSavePacket(acceptedProjection, result.token),
      };
    case "rejected":
      try {
        // The state a caller recomputes against is the authority the rejection
        // was decided against: a rejected CAS wrote nothing, and this read runs
        // on the same connection under the same still-held state lock.
        return {
          status: "rejected",
          reason: LEGACY_REJECTION_REASON[result.reason],
          state: facade.loadRawStateFromStore(store),
        };
      } finally {
        result.retry.close();
      }
    case "busy":
      return result;
    case "unsupported":
      return result;
  }
}
