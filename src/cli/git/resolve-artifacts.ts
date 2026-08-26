/**
 * Settling or classifying standing Git protocol artifacts (design 130 P
 * records) before a manual resolve, and settling them after the confirmed
 * checkout lands.
 *
 * Exact CREATE receipts may survive the confirmation snapshot because the
 * checkout transaction reserves their R/P/K refs. Everything else runs the
 * compact/repair/settle loop to a fixed point or holds with a reason.
 */
import type { GitSection } from "../../engine/index.js";
import { loadState, repoRecordsForState, type RepoRecord, type SyncState } from "../config.js";
import { readBasePresentArtifact, settleBaseAbsentArtifact, type BasePresentPayload, type PreparedProtocolRef } from "../sync-git/base-artifacts.js";
import { prepareFollowerBranchProtocol, type FollowerBranchProtocol } from "../sync-git/follower-protocol.js";
import { type RepoCtx } from "../sync-git/git-state.js";
import { createPRepairStatePort, createPRepairStatePortFromReceipt } from "../sync-git/p-repair-state.js";
import { inspectLockedPRepairReceipt, persistPRepairTerminal, refreshLockedAcceptedPRepair, resumeLockedAcceptedPRepair, runLockedPRepairAttempt } from "../sync-git/p-repair-transaction.js";
import { exactPresentArtifactEpisodeTop, settleExactPresentArtifact } from "../sync-git/p-settlement.js";
import { readRefReflogFingerprint } from "../sync-git/keep-pins.js";
import { readAllRefs } from "../sync-git/refs.js";
import { incomingFor } from "./resolve-evidence.js";

export type ManualProtocolPreflight =
  | { status: "ready"; state: SyncState; record: RepoRecord; incoming: GitSection; protocol: FollowerBranchProtocol; receipts: ManualLandingReceipt[] }
  | { status: "hold"; reason: string };

export type ManualLandingReceipt = PreparedProtocolRef<BasePresentPayload>;

async function receiptMismatch(
  repoDir: string,
  liveRefs: Readonly<Record<string, string>>,
  incoming: GitSection,
  receipt: ManualLandingReceipt,
): Promise<string | undefined> {
  const { ref, nextOid, episode } = receipt.payload;
  const liveOid = liveRefs[ref];
  const incomingOid = incoming.refs[ref];
  const mismatches: string[] = [];
  if (liveOid !== nextOid) mismatches.push(`live ${liveOid ?? "<absent>"} != nextOid ${nextOid}`);
  if (incomingOid !== nextOid) mismatches.push(`incoming ${incomingOid ?? "<absent>"} != nextOid ${nextOid}`);
  try {
    const reflog = await readRefReflogFingerprint(repoDir, ref);
    if (!exactPresentArtifactEpisodeTop(reflog.bytes, receipt.payload)) mismatches.push(`reflog top != episode ${episode}`);
  } catch {
    mismatches.push(`reflog top unreadable for episode ${episode}`);
  }
  return mismatches.length ? `standing P for ${ref} is not a manual landing receipt: ${mismatches.join(", ")}` : undefined;
}

/** A confirmed mutation is never started while exact P authority is unreserved. */
export async function preflightManualPresentArtifacts(args: {
  root: string;
  rel: string;
  ctx: RepoCtx;
  state: SyncState;
  incoming?: GitSection;
}): Promise<ManualProtocolPreflight> {
  let state = args.state;
  // Progress-based bound: a pass that leaves the artifact/repair/record
  // fingerprint unchanged proves the settle/repair machinery is cycling —
  // one more pass would burn CPU to the same hold (field: a cycling repair
  // spun a 195-file repo for 18 CPU-minutes under a fixed 256 ceiling).
  // Many-P repos legitimately take many pases; each settles one P and moves
  // the fingerprint, so the bound is no-progress, not a count.
  let priorFingerprint: string | undefined;
  // The ceiling stays as the second net: a cycling repair that happens to
  // bump the record generation each attempt would defeat the fingerprint.
  // 32 covers the deepest legitimate field shape (18 Ps, one settle per
  // pass) with margin, while bounding any cycle to seconds, not minutes.
  for (let pass = 0; pass < 32; pass++) {
    const record = repoRecordsForState(state)[args.rel];
    const incoming = args.incoming ?? incomingFor(record);
    if (!record || !incoming) return { status: "hold", reason: "deferred incoming state disappeared during manual preflight" };
    const fingerprint = JSON.stringify([
      record.repoGen,
      record.sourceSeq,
      Object.keys(record.partial?.pRepaired ?? {}).sort(),
      record.base?.refs ?? null,
    ]);
    if (fingerprint === priorFingerprint) {
      return { status: "hold", reason: "P settlement did not stabilize before confirmation" };
    }
    priorFingerprint = fingerprint;
    let compacted = false;
    for (const [ref, receipt] of Object.entries(record.partial?.pRepaired ?? {})) {
      const inspected = await inspectLockedPRepairReceipt(args.ctx.repoDir, receipt);
      if (inspected.action === "compact-and-restart") {
        const port = createPRepairStatePortFromReceipt({
          root: args.root, stream: state.stream, relPath: args.rel, repoKind: args.ctx.kind,
          effectiveRefScope: record.base?.refScope ?? incoming.refScope, receipt,
        });
        const snapshot = await port.read();
        if (await persistPRepairTerminal(port, "compact", snapshot, receipt) !== "accepted") {
          return { status: "hold", reason: `P-repair terminal receipt CAS rejected for ${ref}` };
        }
        state = await loadState(args.root, state.stream);
        compacted = true;
        break;
      }
      if (inspected.action === "corruption-hold" || inspected.action === "artifact-contradiction-hold") {
        return { status: "hold", reason: `P-repair terminal inspection refused ${ref}: ${inspected.action}` };
      }
    }
    if (compacted) continue;
    const liveRefs = await readAllRefs(args.ctx.repoDir);
    const prepared = await prepareFollowerBranchProtocol({
      workspaceRoot: args.root, relPath: args.rel, state, ctx: args.ctx, record,
      base: record.base, incoming, liveRefs,
    });
    if (prepared.status === "hold") return prepared;
    for (const ref of new Set([...Object.keys(record.base?.refs ?? {}), ...Object.keys(incoming.refs), ...Object.keys(liveRefs)])) {
      if (!ref.startsWith("refs/heads/")) continue;
      const changesProtectedBase = (record.base?.refs[ref] ?? null) !== (incoming.refs[ref] ?? null);
      const changesPhysicalRef = (liveRefs[ref] ?? null) !== (incoming.refs[ref] ?? null);
      const disposition = prepared.protocol.artifacts[ref];
      const foreign = disposition?.absence === "active-foreign" || disposition?.present === "active-foreign"
        || disposition?.settledAbsence === "active-foreign" || disposition?.keeps === "mismatched";
      if (foreign && (changesProtectedBase || changesPhysicalRef)) {
        return { status: "hold", reason: `foreign BASE artifact vetoes confirmed mutation of ${ref}` };
      }
    }
    const receipts: ManualLandingReceipt[] = [];
    const refusals: string[] = [];
    let restart = false;
    const presentArtifacts = record.base ? prepared.protocol.presentArtifacts.slice(0, 1) : prepared.protocol.presentArtifacts;
    for (const p of presentArtifacts) {
      const exact = await settleExactPresentArtifact({
        root: args.root, stream: state.stream, state, relPath: args.rel, ctx: args.ctx,
        binding: prepared.protocol.binding, p,
      });
      if (exact.status === "settled") { state = exact.state; restart = true; break; }
      if (exact.status === "absent") {
        state = await loadState(args.root, state.stream);
        restart = true;
        break;
      }
      // Without a BASE family neither shape can settle here — CREATE holds
      // (base-absent) and UPDATE reports moved(base-shape) into a repair
      // that cannot commit until a BASE exists, which is a cycle. Both are
      // the same situation and take the same door: an exact receipt the
      // landing consumes (design 286; codex round 2 blessed the UPDATE
      // extension explicitly), or a named refusal.
      const baseAbsentReceipt = (exact.status === "hold" && exact.code === "base-absent")
        || (exact.status === "moved" && exact.reason === "base-shape" && !record.base);
      if (baseAbsentReceipt) {
        const mismatch = await receiptMismatch(args.ctx.repoDir, liveRefs, incoming, p);
        if (mismatch) refusals.push(mismatch); else receipts.push(p);
        continue;
      }
      if (exact.status === "moved") {
        const port = createPRepairStatePort({
          root: args.root, stream: state.stream, relPath: args.rel, repoKind: args.ctx.kind,
          effectiveRefScope: record.base?.refScope ?? incoming.refScope, p,
        });
        const disposition = prepared.protocol.artifacts[p.payload.ref];
        const validateArtifacts = async (): Promise<boolean> => {
          const fresh = await readBasePresentArtifact(args.ctx.repoDir, prepared.protocol.binding, p.payload.ref);
          return fresh.status === "valid" && fresh.artifact.targetOid === p.targetOid
            && disposition?.present === "valid-owning" && disposition.keeps === "exact"
            && disposition.absence === "absent" && disposition.settledAbsence === "absent";
        };
        const accepted = record.partial?.pRepaired?.[p.payload.ref];
        const repaired = accepted
          ? await resumeLockedAcceptedPRepair({ repoDir: args.ctx.repoDir, receipt: accepted, validateArtifacts }).then(async (resumed) =>
              resumed.status === "refresh-receipt"
                ? refreshLockedAcceptedPRepair({
                    repoDir: args.ctx.repoDir, p, state: port, repairAt: new Date().toISOString(), acceptedReceipt: accepted,
                    mismatches: { live: exact.reason === "live", reflog: exact.reason === "reflog", baseRefs: exact.reason === "base-shape" },
                    validateArtifacts,
                  })
                : resumed.status === "restart" ? { status: "restart" as const } : { status: "hold" as const, reason: resumed.reason })
          : await runLockedPRepairAttempt({
              repoDir: args.ctx.repoDir, p, state: port, repairAt: new Date().toISOString(),
              mismatches: { live: exact.reason === "live", reflog: exact.reason === "reflog", baseRefs: exact.reason === "base-shape" },
              validateArtifacts,
            });
        if (repaired.status === "hold") return { status: "hold", reason: repaired.reason };
        state = await loadState(args.root, state.stream);
        restart = true;
        break;
      }
      return { status: "hold", reason: exact.reason };
    }
    if (restart) continue;
    if (refusals.length) return { status: "hold", reason: refusals.join("; ") };
    return { status: "ready", state, record, incoming, protocol: prepared.protocol, receipts };
  }
  return { status: "hold", reason: "P settlement did not stabilize before confirmation" };
}

export async function settleCommittedManualPresentArtifacts(args: {
  root: string;
  rel: string;
  ctx: RepoCtx;
  state: SyncState;
  incoming: GitSection;
}): Promise<{ state: SyncState; error?: string }> {
  const preflight = await preflightManualPresentArtifacts({ ...args, incoming: args.incoming });
  if (preflight.status === "hold") return { state: args.state, error: preflight.reason };
  for (const [ref, disposition] of Object.entries(preflight.protocol.artifacts)) {
    if (disposition.absence === "valid-owning") {
      await settleBaseAbsentArtifact(args.ctx.repoDir, preflight.protocol.binding, ref);
    }
  }
  return { state: preflight.state };
}
