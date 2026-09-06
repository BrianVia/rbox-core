/**
 * One owner for the store's raw `CasResult` → whole-state `StateSaveResult`
 * translation: the rejection vocabulary the JSON CAS has always spoken, and the
 * choice between reading the accepted state back and projecting it.
 *
 * Never: trusting a caller's claim, widening StateSaveResult, opening or locking anything, or
 * deciding elision.
 */
import { fullyElidedPacket } from "../../sync-state-elision.js";
import type { FileEntry } from "../../../engine/types.js";
import type { StateSavePacket, StateSaveResult, SyncState } from "../../sync-state-model.js";
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
 * `nonce` is the terminal incarnation-change verdict. `delta-binding` joins that
 * same retryable family for the same reason — a delta's predecessor moved, which
 * the composer answers by recomposing, never by giving up.
 * Exported so the unreachable rows are pinned rather than merely compiled.
 */
export const LEGACY_REJECTION_REASON = {
  lineage: "nonce", stream: "stream", nonce: "nonce",
  "state-revision": "nonce", "base-generation": "global-sequence", "local-revision": "nonce",
  "repo-generation": "repo-generation", "global-sequence": "global-sequence", "owner-lost": "owner-lost",
  "elision-drift": "elision-drift", "delta-binding": "elision-drift",
} satisfies Record<CasRejectionReason, LegacyRejectionReason>;

/**
 * Design 267 §4. The projection is a caller's CLAIM about what the store now
 * holds, so the adapter re-derives its precondition from the packet it just
 * applied rather than trusting that the caller only offers one when it may: a
 * packet that carried any section wrote something the projection cannot know.
 *
 * Design 302: `reuse` is the design 277 memo's own retained file rows (owner:
 * state-memo.ts), offered by the adapter only for a global-free packet whose
 * post-CAS base generation still matches the retention. It is a skip rule
 * keyed by store truth, not a caller's claim; records, meta and git
 * projections are still read back.
 * Design 313 admits the memo's delta-derived rows under its predecessor and post-CAS token checks.
 */
export function translateCasResult(
  result: CasResult,
  store: StateStoreHandle,
  facade: StoreFacade,
  packet: StateSavePacket,
  acceptedProjection?: SyncState,
  reuse?: { baseFiles: readonly FileEntry[] },
): StateSaveResult {
  switch (result.status) {
    case "accepted":
      return {
        status: "accepted",
        state: acceptedProjection !== undefined && fullyElidedPacket(packet)
          ? facade.projectAcceptedSavePacket(acceptedProjection, result.token)
          : facade.loadRawStateFromStore(store, reuse),
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
