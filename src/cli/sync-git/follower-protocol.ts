/** Never: ref mutation or BASE persistence. */
import { type GitSection } from "../../engine/index.js";
import { artifactBinding, readRepoIdentityV1, readStateLineageV1, type ArtifactBinding } from "./repo-lineage.js";
import { readSettledAbsence, type BasePresentPayload, type PreparedProtocolRef } from "./base-artifacts.js";
import { scanBaseArtifacts } from "./base-artifact-scan.js";
import { type RepoCtx } from "./git-state.js";
import type { RepoRecord, SyncState } from "../config.js";
import { gitIncomingKey } from "./shared.js";
import {
  buildTombstoneAttestations,
  type BranchArtifactDisposition,
  type TombstoneAttestationMap,
} from "./tombstone-attestation.js";
import type { BranchTransitionWitness } from "./base-composer.js";

export interface FollowerBranchProtocol {
  binding: ArtifactBinding;
  lineageHash: string;
  repositoryIdentityHash: string;
  logicalBaseRefs: Record<string, string>;
  attestations: TombstoneAttestationMap;
  artifacts: Record<string, BranchArtifactDisposition>;
  presentArtifacts: Array<PreparedProtocolRef<BasePresentPayload>>;
  /** Design 312: valid P receipts minted under ANOTHER lineage of this same
   *  physical repository. Never owning; a witness may settle a CREATE one whose
   *  target equals this device's own BASE. */
  foreignPresentArtifacts: Array<PreparedProtocolRef<BasePresentPayload>>;
  /** A/Z proves a committed absence that stale serialized BASE has not yet
   * materialized. This is a one-cycle breadcrumb-waiver veto, never deletion
   * or BASE authority. */
  unmaterializedAbsenceRefs: ReadonlySet<string>;
  /** Exact owning A receipts available for crash reconstruction. */
  absenceWitnesses: Readonly<Record<string, Extract<BranchTransitionWitness, { kind: "absent" }>>>;
}

export type FollowerBranchProtocolResult =
  | { status: "ready"; protocol: FollowerBranchProtocol }
  | { status: "hold"; reason: string };

/**
 * Builds logical BASE and immutable tombstone attestations before ref-plane
 * planning. Any malformed/unclassifiable common-dir artifact rejects the whole
 * group; valid foreign artifacts veto only their own branch.
 */
export async function prepareFollowerBranchProtocol(input: {
  workspaceRoot: string;
  relPath: string;
  state: SyncState;
  ctx: RepoCtx;
  record?: RepoRecord;
  base?: GitSection;
  incoming: GitSection;
  liveRefs: Readonly<Record<string, string>>;
  /** Refs whose persisted D2 partial evidence failed exact live revalidation. */
  d2RejectedRefs?: ReadonlySet<string>;
}): Promise<FollowerBranchProtocolResult> {
  if (!/^[0-9a-f]{32}$/.test(input.state.stateNonce ?? "")) return { status: "hold", reason: "state lineage has no capable nonce" };
  try {
    const identity = await readRepoIdentityV1(input.relPath, input.ctx.kind, {
      worktreeId: input.ctx.repoDir,
      gitDirReal: input.ctx.gitDir,
      commonDirReal: input.ctx.commonDir,
    });
    const lineage = await readStateLineageV1(input.workspaceRoot, input.state.stream, input.state.stateNonce!, identity);
    const binding = artifactBinding(lineage);
    const [scan, settled] = await Promise.all([
      scanBaseArtifacts(input.ctx.repoDir, binding),
      readSettledAbsence(input.ctx.repoDir, binding),
    ]);
    const invalidForeign = scan.foreign.find((entry) => entry.status === "invalid");
    if (scan.invalidNamespace.length || scan.orphanKeep.length || invalidForeign
      || scan.absent.some((entry) => entry.status === "invalid")
      || scan.present.some((entry) => entry.status === "invalid")
      || settled.status === "invalid") {
      return { status: "hold", reason: "malformed, colliding, or unclassifiable BASE artifact" };
    }

    const logicalBaseRefs = { ...(input.base?.refs ?? {}) };
    const artifacts: Record<string, BranchArtifactDisposition> = {};
    const absenceWitnesses: Record<string, Extract<BranchTransitionWitness, { kind: "absent" }>> = {};
    const disposition = (ref: string): BranchArtifactDisposition => artifacts[ref] ??= {
      absence: "absent", present: "absent", keeps: "clear", settledAbsence: "absent",
    };
    for (const entry of scan.absent) if (entry.status === "valid") {
      const payload = entry.artifact.payload;
      delete logicalBaseRefs[payload.ref];
      disposition(payload.ref).absence = "valid-owning";
      absenceWitnesses[payload.ref] = {
        kind: "absent",
        ref: payload.ref,
        priorOid: payload.priorOid,
        lineageHash: payload.lineageHash,
        repositoryIdentityHash: payload.repositoryIdentityHash,
        artifactRef: entry.artifact.ref,
        artifactOid: entry.artifact.targetOid,
        source: "a",
      };
    }
    for (const entry of scan.present) if (entry.status === "valid") {
      disposition(entry.artifact.payload.ref).present = "valid-owning";
      disposition(entry.artifact.payload.ref).keeps = "exact";
    }
    if (settled.status === "valid") for (const payload of settled.ledger.entries.values()) {
      delete logicalBaseRefs[payload.ref];
      disposition(payload.ref).settledAbsence = "valid-owning";
    }
    for (const entry of scan.foreign) if (entry.status === "valid" && entry.branchRef) {
      const item = disposition(entry.branchRef);
      if (entry.kind === "absent") item.absence = "active-foreign";
      else if (entry.kind === "present") item.present = "active-foreign";
      else item.keeps = "mismatched";
    }

    const incomingKey = gitIncomingKey(input.incoming);
    const pendingEvidence = Object.fromEntries(Object.keys(input.incoming.refTombstones ?? {}).map((ref) => [
      ref, { incomingKey, d2Revalidated: input.d2RejectedRefs?.has(ref) !== true },
    ]));
    const attestations = buildTombstoneAttestations({
      section: input.incoming,
      incomingKey,
      lineageHash: binding.lineageHash,
      liveRefs: input.liveRefs,
      logicalBaseRefs,
      origins: input.record?.branchBaseOrigins ?? {},
      artifacts,
      pendingEvidence,
    });
    const serializedBaseRefs = input.base?.refs ?? {};
    const unmaterializedAbsenceRefs = new Set(Object.keys(serializedBaseRefs).filter((ref) => {
      const item = artifacts[ref];
      return item?.absence === "valid-owning" || item?.settledAbsence === "valid-owning";
    }));
    return {
      status: "ready",
      protocol: {
        binding,
        lineageHash: binding.lineageHash,
        repositoryIdentityHash: binding.repositoryIdentityHash,
        logicalBaseRefs,
        attestations,
        artifacts,
        presentArtifacts: scan.present.flatMap((entry) => entry.status === "valid" ? [entry.artifact] : []),
        foreignPresentArtifacts: scan.foreign.flatMap((entry) => entry.kind === "present" && entry.artifact ? [entry.artifact] : []),
        unmaterializedAbsenceRefs,
        absenceWitnesses,
      },
    };
  } catch (error) {
    return { status: "hold", reason: `BASE artifact/lineage proof failed: ${String((error as Error)?.message ?? error)}` };
  }
}
