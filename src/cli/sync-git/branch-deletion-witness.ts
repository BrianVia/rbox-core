/** Never: capture/carry decisions, accumulator mutation, tombstone authoring, or ref transactions beyond the verification it commits. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gitRaw } from "../../engine/git-spawn.js";
import { receiverEquivalentCollisionNames, type GitSection } from "../../engine/index.js";
import type { GitDeferralReason, RepoRecord, SyncState } from "../config.js";
import { branchBaseOriginMatches } from "./base-composer.js";
import { commitAbsentBranchVerification, planAbsentBranchVerification } from "./branch-transition.js";
import { prepareFollowerBranchProtocol } from "./follower-protocol.js";
import { branchesCheckedOutElsewhereStrict } from "./git-state-apply.js";
import { readHead, type RepoCtx } from "./git-state.js";
import { gitPreflight, isGitBusy } from "./preflight.js";
import { errMsg, type PackedRefsObservation } from "./shared.js";

export interface BranchDeletionWitnessInput {
  root: string;
  rel: string;
  state: SyncState;
  ctx: RepoCtx;
  record: RepoRecord | undefined;
  baseSection: GitSection | undefined;
  candidate: GitSection;
  /** BASE branches absent from the candidate: `[ref, priorOid]`, original order. */
  missing: ReadonlyArray<readonly [string, string]>;
  packedObservation: PackedRefsObservation;
  packedRegressed: boolean;
  binding: { lineageHash: string; repositoryIdentityHash: string } | undefined;
  /** This device's id (design 309): a BASE section this device captured is origin
   *  evidence for every branch in it, because the branch existed here at capture. */
  selfDeviceId: string | undefined;
  /** Tests only: runs before the authorization reads. */
  beforeAbsencePreflight?: (relPath: string) => void | Promise<void>;
}

/**
 * Design 311: a refusal that depends only on the protocol artifact plane
 * (`artifacts-standing`) is remembered per repository under a token of that
 * plane (every `refs/rbox-local/*` ref and OID, one for-each-ref) plus the
 * missing-branch set. While neither changes, the ~200-spawn artifact scan is
 * skipped and the same refusal is returned. Any retirement or landing changes
 * the refs, so the memo can never outlive the facts it summarizes. Process-
 * local like the design 277/302 memos; a proven witness clears the entry.
 * Deletion condition: when standing CREATE-P receipts can be discarded
 * (design 310) and this refusal stops recurring per push.
 */
const STANDING_ARTIFACT_REFUSALS = new Map<string, { token: string; reason: string; typed: GitDeferralReason }>();

/** Test seam: forget every remembered standing-artifact refusal. */
export function forgetStandingArtifactRefusalsForTests(): void {
  STANDING_ARTIFACT_REFUSALS.clear();
}

async function artifactPlaneToken(repoDir: string, missing: ReadonlyArray<readonly [string, string]>): Promise<string | undefined> {
  const listing = await gitRaw(repoDir, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/rbox-local"]).catch(() => undefined);
  if (listing === undefined) return undefined;
  return createHash("sha256").update(JSON.stringify([missing, listing])).digest("hex");
}

export type BranchDeletionWitness =
  | { status: "proven"; proofs: Record<string, { priorOid: string }> }
  | { status: "refused"; reason: string; typed: GitDeferralReason };

/**
 * The branch-deletion witness (design 43 W/L/D, 273, 308): decide whether every
 * BASE branch missing from a captured candidate may be published as a deletion.
 * Cheap per-branch refusals (scope, recorded origin) come first; only a repo that
 * passes them pays for the protocol artifact scan and the authorization reads.
 * Pure decision plus the verification transaction; the caller owns the carry,
 * the revert and the deferral bookkeeping.
 */
export async function witnessBranchDeletions(input: BranchDeletionWitnessInput): Promise<BranchDeletionWitness> {
  const { root, rel, state, ctx, record, baseSection, candidate, missing, packedObservation, packedRegressed, binding, beforeAbsencePreflight, selfDeviceId } = input;
  // Design 309: origin evidence is either the per-branch ledger entry (designs
  // 273/274) or, for a branch with NO ledger entry, the fact that this device
  // captured the BASE section that lists it — the branch existed locally at that
  // capture, so this device's later deletion of it is authoritative. Sections
  // captured elsewhere, or by an old writer that stamped no author, still refuse.
  const selfAuthored = (ref: string): boolean => record?.branchBaseOrigins?.[ref] === undefined
    && selfDeviceId !== undefined && baseSection?.deviceId === selfDeviceId;
  const originProven = (ref: string, priorOid: string): boolean =>
    branchBaseOriginMatches(record?.branchBaseOrigins?.[ref], priorOid) || selfAuthored(ref);

  let refusal: string | undefined = packedObservation.status === "unreadable"
    ? `packed-refs baseline could not be read: ${errMsg(packedObservation.error)}`
    : packedRegressed
      ? "packed-refs mtime regressed while a BASE branch was absent"
      : undefined;
  let refusalType: GitDeferralReason | undefined =
    packedObservation.status === "unreadable" ? "unreadable" : undefined;
  const headLog = await fs.readFile(path.join(ctx.commonDir, "logs", "HEAD")).catch(() => undefined);
  if (!headLog || headLog.byteLength === 0) refusal ??= "HEAD reflog is absent or empty";
  // Design 308: the two per-branch refusals that need no evidence beyond the
  // record and the candidate (scope, recorded origin) are decided BEFORE the
  // artifact scan and the authorization reads. A BASE branch with no recorded
  // origin can never be proven deleted this cycle, so paying ~1.4s of
  // `for-each-ref` per push to learn that is pure waste; the verdict and the
  // deferral type are unchanged, only the forensic reason names the cheap cause.
  if (!refusal) {
    for (const [ref, priorOid] of missing) {
      const cheapRefusals = [
        ...(candidate.refScope !== "all" ? ["scoped-capture"] : []),
        ...(!originProven(ref, priorOid) ? ["origin-mismatch"] : []),
      ];
      if (cheapRefusals.length > 0) {
        refusal = `branch deletion witness refused ${ref} (${cheapRefusals.join("+")})`;
        break;
      }
    }
  }
  const memoKey = `${root}\0${rel}`;
  const planeToken = refusal ? undefined : await artifactPlaneToken(ctx.repoDir, missing);
  const remembered = STANDING_ARTIFACT_REFUSALS.get(memoKey);
  if (remembered && planeToken !== undefined && remembered.token === planeToken) {
    return { status: "refused", reason: remembered.reason, typed: remembered.typed };
  }
  const protocol = refusal ? undefined : await prepareFollowerBranchProtocol({
    workspaceRoot: root, relPath: rel, state, ctx, record,
    base: baseSection, incoming: candidate, liveRefs: candidate.refs,
  });
  if (protocol?.status !== "ready") refusal ??= protocol?.reason ?? "BASE artifact/lineage proof unavailable";
  const readyProtocol = protocol?.status === "ready" ? protocol.protocol : undefined;
  if (readyProtocol && (!binding
    || binding.lineageHash !== readyProtocol.lineageHash
    || binding.repositoryIdentityHash !== readyProtocol.repositoryIdentityHash)) {
    refusal ??= "publisher repository binding changed before absence proof";
  }
  let busy = false;
  let preflight: Awaited<ReturnType<typeof gitPreflight>> = { ok: true };
  let owned = new Map<string, string>();
  let head = "";
  if (!refusal) {
    try {
      await beforeAbsencePreflight?.(rel);
      const [busyRead, preflightRead, ownedRead, headRead] = await Promise.all([
        isGitBusy(ctx.repoDir),
        gitPreflight(ctx.repoDir),
        branchesCheckedOutElsewhereStrict(ctx),
        readHead(ctx),
      ]);
      if (ownedRead.status === "unreadable") throw ownedRead.cause;
      busy = busyRead;
      preflight = preflightRead;
      owned = ownedRead.owned;
      head = headRead;
    } catch (error) {
      refusal = `branch deletion authorization evidence could not be read: ${errMsg(error)}`;
      refusalType = "unreadable";
    }
  }
  if (busy) refusal ??= "repository operation began before absence proof";
  if (!preflight.ok) refusal ??= preflight.reason;
  const collisions = receiverEquivalentCollisionNames([
    ...Object.keys(baseSection?.refs ?? {}),
    ...Object.keys(candidate.refs),
    ...owned.keys(),
  ]);
  const proofs: Record<string, { priorOid: string }> = {};

  for (const [ref, priorOid] of missing) {
    if (refusal) break;
    const origin = record?.branchBaseOrigins?.[ref];
    const artifacts = readyProtocol!.artifacts[ref];
    const artifactsClear = artifacts === undefined || (artifacts.absence === "absent"
      && artifacts.present === "absent"
      && artifacts.keeps === "clear"
      && artifacts.settledAbsence === "absent");
    const witnessRefusals = [
      ...(candidate.refScope !== "all" ? ["scoped-capture"] : []),
      ...(!originProven(ref, priorOid) ? ["origin-mismatch"] : []),
      // A self-authored BASE has no ledger lineage to compare; the publisher
      // binding check above already proved this repository's lineage is unchanged.
      ...(branchBaseOriginMatches(origin, priorOid) && origin.lineageHash !== readyProtocol!.lineageHash ? ["lineage-changed"] : []),
      ...(!artifactsClear ? ["artifacts-standing"] : []),
      ...(owned.has(ref) ? ["worktree-owned"] : []),
      ...(collisions.has(ref) ? ["name-collision"] : []),
      ...(head === `ref: ${ref}` ? ["head-symref"] : []),
    ];
    if (witnessRefusals.length > 0) {
      refusal = `branch deletion witness refused ${ref} (${witnessRefusals.join("+")})`;
      break;
    }
    try {
      const verification = await planAbsentBranchVerification(ctx.repoDir, ref);
      await commitAbsentBranchVerification(verification);
      proofs[ref] = { priorOid };
    } catch (error) {
      refusal = errMsg(error);
      break;
    }
  }

  if (!refusal && Object.keys(proofs).length === missing.length) {
    STANDING_ARTIFACT_REFUSALS.delete(memoKey);
    return { status: "proven", proofs };
  }
  const reason = refusal ?? "branch deletion proof unavailable";
  const typed = refusalType ?? (reason.includes("ref-read-unreadable") ? "ref-read-unreadable" : "deletion-pending");
  if (planeToken !== undefined && reason.includes("(artifacts-standing)")) {
    STANDING_ARTIFACT_REFUSALS.set(memoKey, { token: planeToken, reason, typed });
  } else {
    STANDING_ARTIFACT_REFUSALS.delete(memoKey);
  }
  return { status: "refused", reason, typed };
}
