import type { SyncState } from "../sync-state-model.js";

/**
 * Design 277 §A1: what an operation knows about durable sync state when it ends.
 *
 * `state` is the exact state a durable writer accepted — or the untouched
 * boundary state when nothing wrote. `reload` is every path that cannot name
 * one: a writer that does not return its accepted state, an uncertain or thrown
 * write, and any reconciliation that mutated state outside the operation's own
 * bookkeeping. A settle adopts `state` through the same seam a fresh load uses,
 * or performs the full reload it always did.
 */
export type DurableStateReceipt = { readonly state: SyncState } | { readonly disposition: "reload" };

export const RELOAD_DURABLE_STATE: DurableStateReceipt = { disposition: "reload" };
