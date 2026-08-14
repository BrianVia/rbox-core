import fs from "node:fs/promises";
import path from "node:path";
import { receiverEquivalentCollisionNames } from "../../engine/index.js";
import { enumerateStashReflogOids, noDropProof, tipOwnedByIncoming, type OwnershipProofContext } from "./reachability.js";
import { branchesCheckedOutElsewhere, branchesCheckedOutElsewhereStrict } from "./git-state-apply.js";
import { addTimedMs } from "./chain-timings.js";
import { headBranchOf, warnOnce } from "./git-state.js";
import type { GitDeferralReason, TypedBlocker } from "../config.js";
import { branchBaseOriginMatches } from "./base-composer.js";
import { loadContentEquivalenceCache } from "./content-equivalence-cache.js";
import { effectiveRefs } from "./follow-ref-witness.js";
import { WorktreeOwnershipUnreadableError, type FollowOptions, type LiveMetadata } from "./follow-types.js";
import { gitIncomingKey, observePackedRefsIdentity, packedRefsMtimeRegressed } from "./shared.js";
import { checkTombstoneAttestation } from "./tombstone-attestation.js";

type ClassifiedHold = "local-commits" | "local-stash" | "worktree-ownership";

export interface RefPlaneObservation {
  readonly opts: FollowOptions;
  readonly live: LiveMetadata;
  readonly roots: readonly string[];
  readonly ownershipContext: OwnershipProofContext;
  readonly classifyOnly: boolean;
  readonly effective: ReturnType<typeof effectiveRefs>;
  readonly candidates: ReadonlySet<string>;
  readonly classifiedHolds: ReadonlyMap<string, ClassifiedHold>;
  readonly indeterminateRefs: ReadonlySet<string>;
  readonly forcedRefs: ReadonlySet<string>;
  readonly ambiguousRefs: ReadonlySet<string>;
  readonly tombstoneAuthorized: ReadonlySet<string>;
  readonly deletionWitnessRefs: ReadonlySet<string>;
  readonly deletionWitnessHeldRefs: ReadonlySet<string>;
  readonly blockers: readonly TypedBlocker[];
  readonly tombstonePrunedThisCycle: boolean;
  readonly checkoutRefReason?: GitDeferralReason;
  readonly checkoutRefDetail?: string;
  readonly checkoutRefReasonFromIndeterminate: boolean;
  readonly incomingHeadRef?: string;
}

const refEquivalenceWarnings = new Set<string>();

export async function observeRefPlane(
  opts: FollowOptions,
  live: LiveMetadata,
  roots: readonly string[],
  ownershipContext: OwnershipProofContext,
  classifyOnly: boolean,
  capturedEffective?: ReturnType<typeof effectiveRefs>,
  capturedIncomingHeadRef?: string,
): Promise<RefPlaneObservation> {
  const effective = capturedEffective ?? effectiveRefs(opts.ctx, opts.incoming);
  const owned = classifyOnly
    ? await addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(opts.ctx))
    : await (async () => {
        let ownedRead: Awaited<ReturnType<typeof branchesCheckedOutElsewhereStrict>>;
        try {
          await opts.beforeWorktreeOwnershipRead?.();
          ownedRead = await addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhereStrict(opts.ctx));
        } catch (error) {
          throw new WorktreeOwnershipUnreadableError(error);
        }
        if (ownedRead.status === "unreadable") throw new WorktreeOwnershipUnreadableError(ownedRead.cause);
        return ownedRead.owned;
      })();
  const blockers: TypedBlocker[] = [];
  const tombstonePrunedThisCycle = (opts.branchProtocol?.unmaterializedAbsenceRefs.size ?? 0) > 0;
  const plannedRoots = [...new Set(Object.values(effective.refs))];
  let checkoutRefReason: GitDeferralReason | undefined;
  let checkoutRefDetail: string | undefined;
  let checkoutRefReasonFromIndeterminate = false;
  const manualProtected = new Set(opts.manualResolution?.protectedOids ?? []);
  const incomingHeadRef = capturedEffective ? capturedIncomingHeadRef : headBranchOf(opts.incoming.head);
  const ambiguousRefs = receiverEquivalentCollisionNames([
    ...Object.keys(effective.refs),
    ...Object.keys(live.refs),
    ...owned.keys(),
  ]);
  if (ambiguousRefs.size > 0) warnOnce(
    refEquivalenceWarnings,
    opts.workspaceRoot,
    `git-sync WARNING: receiver-equivalent Git refnames held in ${opts.relPath}: ${[...ambiguousRefs].sort().join(", ")}`,
    opts.log ?? (() => {}),
  );
  if ((live.currentRef && ambiguousRefs.has(live.currentRef)) || (incomingHeadRef && ambiguousRefs.has(incomingHeadRef))) {
    checkoutRefReason = "unreadable";
    checkoutRefDetail = "checkout ref belongs to an ambiguous receiver-equivalence group";
  }
  if (incomingHeadRef && owned.has(incomingHeadRef)) {
    checkoutRefReason = "worktree-ownership";
    checkoutRefDetail = `branch ${incomingHeadRef.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${owned.get(incomingHeadRef)}`;
  }
  const candidates = new Set(Object.keys(effective.refs));
  if (effective.deleteAbsent) {
    for (const ref of Object.keys(live.refs)) candidates.add(ref);
    for (const ref of Object.keys(opts.base?.refs ?? {})) candidates.add(ref);
  }

  const deletionWitnessRefs = new Set<string>();
  const deletionWitnessHeldRefs = new Set<string>();
  if (opts.ctx.kind === "dir" && opts.incoming.refScope === "all" && opts.branchProtocol) {
    const priorPacked = opts.record?.packedRefsIdentity;
    const currentPacked = await observePackedRefsIdentity(opts.ctx.commonDir);
    const packedRegressed = currentPacked.status === "unreadable"
      || packedRefsMtimeRegressed(priorPacked, currentPacked);
    const headLog = await fs.readFile(path.join(opts.ctx.commonDir, "logs", "HEAD")).catch(() => undefined);
    if (!packedRegressed && headLog && headLog.byteLength > 0) {
      for (const [ref, baseOid] of Object.entries(opts.base?.refs ?? {})) {
        if (!ref.startsWith("refs/heads/") || live.refs[ref] !== undefined
          || ref === live.currentRef || owned.has(ref) || ambiguousRefs.has(ref)) continue;
        const origin = opts.record?.branchBaseOrigins?.[ref];
        const disposition = opts.branchProtocol.artifacts[ref];
        const artifactsClear = disposition === undefined || (disposition.absence === "absent"
          && disposition.present === "absent" && disposition.keeps === "clear"
          && disposition.settledAbsence === "absent");
        if (artifactsClear && branchBaseOriginMatches(origin, baseOid)
          && origin.lineageHash === opts.branchProtocol.lineageHash) deletionWitnessRefs.add(ref);
      }
    }
  }

  const classifiedHolds = new Map<string, ClassifiedHold>();
  const indeterminateRefs = new Set<string>();
  const forcedRefs = new Set(Object.keys(opts.forcedHeldRefs ?? {}));
  for (const ref of candidates) if (ambiguousRefs.has(ref)) classifiedHolds.set(ref, "worktree-ownership");
  for (const [ref, reason] of Object.entries(opts.forcedHeldRefs ?? {})) {
    const classified = reason === "ownership" ? "worktree-ownership" : reason;
    classifiedHolds.set(ref, classified);
    if (ref === live.currentRef) checkoutRefReason ??= classified;
  }
  for (const ref of deletionWitnessRefs) {
    if (effective.refs[ref] !== undefined) {
      classifiedHolds.set(ref, "local-commits");
      deletionWitnessHeldRefs.add(ref);
    }
  }
  const protectedByRef = new Map<string, string[]>();
  for (const ref of candidates) {
    if (ref === live.currentRef) continue;
    const oldOid = live.refs[ref];
    const newOid = effective.refs[ref];
    if (oldOid === newOid) continue;
    let hold = classifiedHolds.get(ref);
    if (!hold && owned.has(ref)) {
      hold = "worktree-ownership";
      if (opts.manualResolution) checkoutRefReason ??= "worktree-ownership";
      checkoutRefDetail ??= `branch ${ref.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${owned.get(ref)}`;
    }
    if (!hold && !opts.manualResolution && ref.startsWith("refs/heads/") && opts.branchProtocol
      && (opts.branchProtocol.logicalBaseRefs[ref] ?? null) !== (oldOid ?? null)) {
      hold = "local-commits";
    }
    if (oldOid) {
      const protectedOids = ref === "refs/stash" && opts.ctx.kind === "dir"
        ? [...new Set([oldOid, ...await addTimedMs(opts.chainTimings, "reflogMs", () => enumerateStashReflogOids(opts.ctx.repoDir))])]
        : [oldOid];
      protectedByRef.set(ref, protectedOids);
      if (!hold) for (const oid of protectedOids) {
        const proof = await addTimedMs(opts.chainTimings, "ownershipMs", () =>
          tipOwnedByIncoming(opts.ctx.repoDir, oid, roots, ownershipContext));
        if (proof.status === "unowned") {
          if (opts.manualResolution && manualProtected.has(oid)) continue;
          hold = ref === "refs/stash" ? "local-stash" : "local-commits";
          break;
        }
        if (proof.status === "indeterminate") {
          indeterminateRefs.add(ref);
          blockers.push({
            provenance: "indeterminate",
            reason: proof.marker === "shallow-store" ? "unsupported" : "unreadable",
            detail: `${ref} preservation proof ${proof.marker}`,
          });
          hold = ref === "refs/stash" ? "local-stash" : "local-commits";
          if (!checkoutRefReason) {
            checkoutRefReason = proof.marker === "shallow-store" ? "unsupported" : "unreadable";
            checkoutRefReasonFromIndeterminate = true;
          }
          break;
        }
      }
    }
    if (hold) classifiedHolds.set(ref, hold);
  }

  const tombstoneAuthorized = new Set<string>();
  for (const [ref, hold] of [...classifiedHolds]) {
    const oldOid = live.refs[ref];
    if (hold !== "local-commits" || !oldOid || !ref.startsWith("refs/heads/")
      || ref === live.currentRef || owned.has(ref) || ambiguousRefs.has(ref)
      || forcedRefs.has(ref) || indeterminateRefs.has(ref) || !opts.branchProtocol) continue;
    const check = checkTombstoneAttestation(opts.branchProtocol.attestations, {
      incomingKey: gitIncomingKey(opts.incoming), ref, oid: oldOid, liveOid: oldOid,
      logicalBaseOid: opts.branchProtocol.logicalBaseRefs[ref] ?? null,
    });
    if (check.status === "authorized") {
      classifiedHolds.delete(ref);
      tombstoneAuthorized.add(ref);
    }
  }

  let plannedRefs: Record<string, string> = {};
  let heldDurable: Record<string, string> = {};
  const contentEquivalenceCache = process.env.RBOX_GIT_CONTENT_EQUIV === "0"
    ? undefined
    : await loadContentEquivalenceCache(opts.workspaceRoot).catch(() => undefined);
  for (;;) {
    plannedRefs = {};
    for (const ref of candidates) {
      if (ref === live.currentRef || classifiedHolds.has(ref)) continue;
      const oid = effective.refs[ref];
      if (oid) plannedRefs[ref] = oid;
    }
    if (live.currentRef && effective.refs[live.currentRef]) plannedRefs[live.currentRef] = effective.refs[live.currentRef]!;
    heldDurable = {};
    for (const [ref, oid] of Object.entries(live.refs)) {
      if (ref === live.currentRef || classifiedHolds.has(ref) || !candidates.has(ref)) heldDurable[ref] = oid;
    }
    let changed = false;
    for (const ref of candidates) {
      if (ref === live.currentRef || classifiedHolds.has(ref)) continue;
      const protectedOids = protectedByRef.get(ref);
      if (!protectedOids?.length) continue;
      if (tombstoneAuthorized.has(ref)) continue;
      if (opts.manualResolution && protectedOids.every((oid) => manualProtected.has(oid))) continue;
      const proof = await addTimedMs(opts.chainTimings, "ownershipMs", () =>
        noDropProof(opts.ctx.repoDir, plannedRefs, heldDurable, {}, protectedOids, {
          contentEquivalenceCache,
          ownershipContext,
        }));
      if (proof.status === "proven") {
        if (proof.marker !== "content-equivalent") continue;
        const oldOid = live.refs[ref];
        const newOid = effective.refs[ref];
        const nonDestructive = oldOid !== undefined && newOid !== undefined
          && (await addTimedMs(opts.chainTimings, "ownershipMs", () =>
            tipOwnedByIncoming(opts.ctx.repoDir, oldOid, [newOid], ownershipContext))).status === "owned";
        if (nonDestructive) {
          opts.onContentEquivalentWaiver?.(ref);
          continue;
        }
        opts.onContentEquivalentDestructiveHold?.(ref);
      }
      classifiedHolds.set(ref, ref === "refs/stash" ? "local-stash" : "local-commits");
      if (proof.status === "indeterminate") {
        indeterminateRefs.add(ref);
        if (!checkoutRefReason) {
          checkoutRefReason = proof.marker === "shallow-store" ? "unsupported" : "unreadable";
          checkoutRefReasonFromIndeterminate = true;
        }
        blockers.push({
          provenance: "indeterminate",
          reason: proof.marker === "shallow-store" ? "unsupported" : "unreadable",
          detail: `${ref} no-drop proof ${proof.marker}`,
        });
      }
      changed = true;
    }
    if (!changed) break;
  }
  await contentEquivalenceCache?.save().catch(() => {});

  return {
    opts, live, roots, ownershipContext, classifyOnly, effective, candidates,
    classifiedHolds, indeterminateRefs, forcedRefs, ambiguousRefs,
    tombstoneAuthorized, deletionWitnessRefs, deletionWitnessHeldRefs, blockers,
    tombstonePrunedThisCycle, checkoutRefReason, checkoutRefDetail,
    checkoutRefReasonFromIndeterminate, incomingHeadRef,
  };
}
