import {
  artifactBinding,
  readRepoIdentityV1,
  readSettledAbsence,
  readStateLineageV1,
  scanBaseArtifacts,
  type ArtifactBinding,
  type BasePresentPayload,
  type GitSection,
  type RepoCtx,
  type PreparedProtocolRef,
} from "../../engine/index.js";
import type { RepoRecord, SyncState } from "../config.js";
import { gitIncomingKey } from "./shared.js";
import {
  buildTombstoneAttestations,
  type BranchArtifactDisposition,
  type TombstoneAttestationMap,
} from "./tombstone-attestation.js";

export interface FollowerBranchProtocol {
  binding: ArtifactBinding;
  lineageHash: string;
  repositoryIdentityHash: string;
  logicalBaseRefs: Record<string, string>;
  attestations: TombstoneAttestationMap;
  artifacts: Record<string, BranchArtifactDisposition>;
  presentArtifacts: Array<PreparedProtocolRef<BasePresentPayload>>;
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
    const disposition = (ref: string): BranchArtifactDisposition => artifacts[ref] ??= {
      absence: "absent", present: "absent", keeps: "clear", settledAbsence: "absent",
    };
    for (const entry of scan.absent) if (entry.status === "valid") {
      delete logicalBaseRefs[entry.artifact.payload.ref];
      disposition(entry.artifact.payload.ref).absence = "valid-owning";
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
      ref, { incomingKey, d2Revalidated: true },
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
      },
    };
  } catch (error) {
    return { status: "hold", reason: `BASE artifact/lineage proof failed: ${String((error as Error)?.message ?? error)}` };
  }
}
