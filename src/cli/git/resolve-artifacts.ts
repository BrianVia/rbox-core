/**
 * Settling the standing Git protocol artifacts (design 130 P records) before a
 * resolve is allowed to take a confirmation snapshot, and again after the
 * confirmed checkout lands.
 *
 * A confirmation snapshot taken while exact P authority still stands would
 * promise state the publisher can still move underneath it, so this module runs
 * the compact/repair/settle loop to a fixed point and otherwise holds with a
 * reason. It owns that loop; the orchestrator only learns "ready" or "hold".
 */
import type { GitSection } from "../../engine/index.js";
import { loadState, repoRecordsForState, type RepoRecord, type SyncState } from "../config.js";
import { readBasePresentArtifact, settleBaseAbsentArtifact } from "../sync-git/base-artifacts.js";
import { prepareFollowerBranchProtocol, type FollowerBranchProtocol } from "../sync-git/follower-protocol.js";
import { type RepoCtx } from "../sync-git/git-state.js";
import { createPRepairStatePort, createPRepairStatePortFromReceipt } from "../sync-git/p-repair-state.js";
import { inspectLockedPRepairReceipt, persistPRepairTerminal, refreshLockedAcceptedPRepair, resumeLockedAcceptedPRepair, runLockedPRepairAttempt } from "../sync-git/p-repair-transaction.js";
import { settleExactPresentArtifact } from "../sync-git/p-settlement.js";
import { readAllRefs } from "../sync-git/refs.js";
import { incomingFor } from "./resolve-evidence.js";

export type ManualProtocolPreflight =
  | { status: "ready"; state: SyncState; record: RepoRecord; incoming: GitSection; protocol: FollowerBranchProtocol }
  | { status: "hold"; reason: string };

/** A confirmation snapshot is never taken while exact P authority stands. */
export async function preflightManualPresentArtifacts(args: {
  root: string;
  rel: string;
  ctx: RepoCtx;
  state: SyncState;
  incoming?: GitSection;
}): Promise<ManualProtocolPreflight> {
  let state = args.state;
  for (let pass = 0; pass < 8; pass++) {
    const record = repoRecordsForState(state)[args.rel];
    const incoming = args.incoming ?? incomingFor(record);
    if (!record || !incoming) return { status: "hold", reason: "deferred incoming state disappeared during manual preflight" };
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
    const p = prepared.protocol.presentArtifacts[0];
    if (!p) return { status: "ready", state, record, incoming, protocol: prepared.protocol };
    const exact = await settleExactPresentArtifact({
      root: args.root, stream: state.stream, state, relPath: args.rel, ctx: args.ctx,
      binding: prepared.protocol.binding, p,
    });
    if (exact.status === "settled") { state = exact.state; continue; }
    if (exact.status === "absent") {
      const reloaded = await loadState(args.root, state.stream);
      state = reloaded;
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
                  mismatches: { live: exact.reason === "live", reflog: exact.reason === "reflog", baseShape: exact.reason === "base-shape" },
                  validateArtifacts,
                })
              : resumed.status === "restart" ? { status: "restart" as const } : { status: "hold" as const, reason: resumed.reason })
        : await runLockedPRepairAttempt({
            repoDir: args.ctx.repoDir, p, state: port, repairAt: new Date().toISOString(),
            mismatches: { live: exact.reason === "live", reflog: exact.reason === "reflog", baseShape: exact.reason === "base-shape" },
            validateArtifacts,
          });
      if (repaired.status === "hold") return { status: "hold", reason: repaired.reason };
      state = await loadState(args.root, state.stream);
      continue;
    }
    return { status: "hold", reason: exact.reason };
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
