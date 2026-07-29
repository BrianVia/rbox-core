/** The checkout safety classifier. Decides whether the receiver's working tree,
 * index, operation state, and reachable history are safe to check out over —
 * and, when they are not, which deferral reason wins.
 *
 * #570 lives here: `partitionOwnedByIncoming` is called ONCE with every tip in
 * one batch (the current tip plus all stash-reflog tips), not once per tip. Both
 * call sites are in this module — `classifyCheckoutOwnership`'s default `prove`
 * and the timed override `classifyCheckout` passes it — and neither changes the
 * number of git subprocesses spawned. Moved verbatim out of follow.ts. */
import {
  enumerateStashReflogOids,
  partitionOwnedByIncoming,
  type OwnershipProofContext,
} from "../../engine/index.js";
import { OP_STATE_CLASSIFICATION } from "../../engine/manifest-validate.js";
import { addTimedMs } from "../../engine/git/shared.js";
import type { GitDeferralReason, GitPartialApply, TypedBlocker } from "../config.js";
import { GIT_DEFERRAL_REASON_RANK } from "../sync-state-model.js";
import {
  breadcrumbGateForReason,
  highestBreadcrumbVetoGate,
  logVetoOnce,
  type BreadcrumbVetoGate,
} from "./breadcrumb-veto.js";
import { sectionOpState } from "./shared.js";
import { indexArtifact } from "./follow-staging.js";
import {
  blockerForReason,
  opStateRootOf,
  type BreadcrumbMismatch,
  type CheckoutClassification,
  type FollowOptions,
  type LiveMetadata,
} from "./follow-types.js";

/** Highest-precedence member of `reasons`, or undefined for an EMPTY set only.
 * classifyCheckout's safe verdict is exactly that emptiness (a deferral reason
 * the local ranking happened to omit must never read as "safe to check out"), so
 * selection scans the set against the shared total rank table rather than
 * searching a locally written list. */
export function firstReason(reasons: ReadonlySet<GitDeferralReason>): GitDeferralReason | undefined {
  let selected: GitDeferralReason | undefined;
  for (const reason of reasons) {
    if (selected === undefined || GIT_DEFERRAL_REASON_RANK[reason] < GIT_DEFERRAL_REASON_RANK[selected]) selected = reason;
  }
  return selected;
}

export interface CheckoutOwnershipClassification {
  reasons: GitDeferralReason[];
  details: string[];
}

/**
 * Focused follow ownership seam: one current tip plus all stash-reflog tips
 * enter one partition while reflog-read failures remain independently mapped.
 */
export async function classifyCheckoutOwnership(
  repoDir: string,
  currentTip: string | undefined,
  roots: readonly string[],
  context: OwnershipProofContext,
  loadStashOids?: () => Promise<readonly string[]>,
  prove: (tips: readonly string[]) => ReturnType<typeof partitionOwnedByIncoming> =
    (tips) => partitionOwnedByIncoming(repoDir, tips, roots, context),
): Promise<CheckoutOwnershipClassification> {
  let stashOids: readonly string[] = [];
  let stashUnreadable = false;
  if (loadStashOids) {
    try {
      stashOids = await loadStashOids();
    } catch {
      stashUnreadable = true;
    }
  }

  const tips = [...(currentTip ? [currentTip] : []), ...stashOids];
  const partition = tips.length > 0 ? await prove(tips) : [];
  const current = currentTip ? partition[0]?.proof : undefined;
  const stash = partition.slice(currentTip ? 1 : 0);
  const reasons: GitDeferralReason[] = [];
  const details: string[] = [];

  if (!currentTip) {
    reasons.push("unreadable");
    details.push("current checkout tip is unreadable");
  } else if (current?.status === "unowned") {
    reasons.push("local-commits");
    details.push("current tip has receiver-only commits");
  } else if (current?.status === "indeterminate") {
    reasons.push(current.marker === "shallow-store" ? "unsupported" : "unreadable");
    details.push(`current-tip reachability ${current.marker}`);
  }

  for (const entry of stash) {
    if (entry.proof.status === "unowned") {
      reasons.push("local-stash");
      details.push("stash reflog contains receiver-only work");
    } else if (entry.proof.status === "indeterminate") {
      reasons.push("unreadable");
      details.push(`stash reachability ${entry.proof.marker}`);
    }
  }
  if (stashUnreadable) {
    reasons.push("unreadable");
    details.push("stash reflog could not be read");
  }
  return { reasons, details };
}

export async function classifyCheckout(args: {
  opts: FollowOptions;
  live: LiveMetadata | undefined;
  incomingProjection?: string;
  baseProjection?: string;
  roots: readonly string[];
  boundary: boolean;
  boundaryChanged?: boolean;
  tombstonePrunedThisCycle?: boolean;
  checkoutRefReason?: GitDeferralReason;
  checkoutRefDetail?: string;
  heldRefs: GitPartialApply["heldRefs"];
  ownershipContext: OwnershipProofContext;
}): Promise<CheckoutClassification> {
  const reasons = new Set<GitDeferralReason>();
  const details: string[] = [];
  const breadcrumbMismatches: BreadcrumbMismatch[] = [];
  const oracle = args.boundary ? await args.opts.oracle.reproveRepo(args.opts.relPath) : await args.opts.oracle.proveRepo(args.opts.relPath);
  if (oracle.kind === "mismatch") { reasons.add("local-edits"); details.push("working tree differs from applied manifest"); }
  else if (oracle.kind === "indeterminate") { reasons.add("unreadable"); details.push(oracle.why); }

  const live = args.live;
  if (!live) {
    reasons.add("unreadable");
    details.push("git metadata could not be read");
  } else {
    const baseHasIndex = indexArtifact(args.opts.base) !== undefined;
    const incomingHasIndex = indexArtifact(args.opts.incoming) !== undefined;
    const projectionFailed = (live.indexPresent && live.indexProjection === undefined)
      || (baseHasIndex && args.baseProjection === undefined)
      || (incomingHasIndex && args.incomingProjection === undefined);
    if (projectionFailed) {
      reasons.add("unreadable");
      details.push("semantic index projection indeterminate");
    } else {
      const liveValue = live.indexPresent ? live.indexProjection : null;
      const baseValue = baseHasIndex ? args.baseProjection : null;
      const incomingValue = incomingHasIndex ? args.incomingProjection : null;
      if (liveValue !== baseValue && liveValue !== incomingValue) {
        reasons.add("local-index");
        details.push("index differs from both base and incoming");
      }
    }

    const baseOp = sectionOpState(args.opts.base);
    const incomingOp = sectionOpState(args.opts.incoming);
    for (const rel of new Set([...Object.keys(live.opState), ...Object.keys(baseOp), ...Object.keys(incomingOp)])) {
      const value = live.opState[rel] ?? null;
      if (value !== (baseOp[rel] ?? null) && value !== (incomingOp[rel] ?? null)) {
        const root = opStateRootOf(rel);
        if (OP_STATE_CLASSIFICATION[root] === "breadcrumb") {
          breadcrumbMismatches.push({ rel: root, live: value, base: baseOp[rel] ?? null, incoming: incomingOp[rel] ?? null });
        } else {
          reasons.add("local-operation");
          details.push(`operation state differs at ${rel}`);
        }
      }
    }

    const ownership = await classifyCheckoutOwnership(
      args.opts.ctx.repoDir,
      live.currentTip,
      args.roots,
      args.ownershipContext,
      args.opts.ctx.kind === "dir"
        ? () => addTimedMs(args.opts.chainTimings, "reflogMs", () => enumerateStashReflogOids(args.opts.ctx.repoDir))
        : undefined,
      (tips) => addTimedMs(args.opts.chainTimings, "ownershipMs", () =>
        partitionOwnedByIncoming(args.opts.ctx.repoDir, tips, args.roots, args.ownershipContext)),
    );
    for (const reason of ownership.reasons) reasons.add(reason);
    details.push(...ownership.details);
  }
  if (args.checkoutRefReason) {
    reasons.add(args.checkoutRefReason);
    details.push(args.checkoutRefDetail ?? "incoming checkout ref could not be published safely");
  }
  const liveInProgress = live !== undefined && (
    Object.keys(live.opState).some((rel) => OP_STATE_CLASSIFICATION[opStateRootOf(rel)] === "in-progress")
    || live.opStateRootsPresent.some((rel) => OP_STATE_CLASSIFICATION[rel] === "in-progress")
  );
  const vetoes: BreadcrumbVetoGate[] = [];
  if (Object.keys(args.heldRefs).length > 0) vetoes.push("held-refs");
  if (args.tombstonePrunedThisCycle) vetoes.push("tombstone-pruned-this-cycle");
  if (liveInProgress) vetoes.push("in-progress-present");
  for (const reason of reasons) vetoes.push(breadcrumbGateForReason(reason));
  if (args.boundaryChanged) vetoes.push("boundary");
  const breadcrumbVetoGate = highestBreadcrumbVetoGate(vetoes);
  const breadcrumbWaived = !args.opts.manualResolution
    && breadcrumbMismatches.length > 0
    && breadcrumbVetoGate === undefined;
  // Convert once before manual reason deletion so take-theirs can explicitly
  // waive local-operation. Presence gates only the automatic waiver.
  if (breadcrumbMismatches.length > 0 && !breadcrumbWaived) {
    logVetoOnce(args.opts.workspaceRoot, args.opts.relPath, breadcrumbVetoGate ?? "indeterminate", args.opts.log);
    reasons.add("local-operation");
    for (const mismatch of breadcrumbMismatches) details.push(`operation state differs at ${mismatch.rel}`);
  }
  for (const reason of args.opts.manualResolution?.waivedReasons ?? []) reasons.delete(reason);
  // Undefined here means the set is empty, never "no rank for this reason":
  // safe is exactly "nothing blocked", and blockers below are always empty with it.
  const reason = firstReason(reasons);
  const provenance = args.boundary ? "boundary" as const : "checkout" as const;
  const blockers = [...reasons].map((item) => blockerForReason(item, provenance, details.join("; ")));
  return reason
    ? { safe: false, reason, detail: details.join("; "), blockers, breadcrumbMismatches, breadcrumbWaived: false, ...(breadcrumbVetoGate ? { breadcrumbVetoGate } : {}) }
    : { safe: true, blockers, breadcrumbMismatches, breadcrumbWaived, ...(breadcrumbVetoGate ? { breadcrumbVetoGate } : {}) };
}
