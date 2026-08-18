/** Never: parsing Git artifacts from disk or performing ref mutations. */
import { validateGitSection, type GitSection } from "../../engine/index.js";
import { branchBaseOriginMatches, type BranchBaseOrigin } from "./base-composer.js";

export type ArtifactDisposition = "absent" | "valid-owning" | "active-foreign" | "invalid";

export interface BranchArtifactDisposition {
  absence: ArtifactDisposition;
  present: ArtifactDisposition;
  keeps: "clear" | "exact" | "orphan" | "mismatched";
  settledAbsence: ArtifactDisposition;
}

export interface PendingEvidenceDisposition {
  incomingKey: string;
  d2Revalidated: boolean;
}

export interface TombstoneAttestation {
  readonly incomingKey: string;
  readonly ref: string;
  readonly tombstonedOid: string;
  readonly liveOid: string | null;
  readonly logicalBaseOid: string | null;
  readonly origin: "usable" | "missing" | "oid-mismatch" | "lineage-mismatch";
  readonly artifacts: BranchArtifactDisposition;
  readonly pending: PendingEvidenceDisposition;
}

export interface TombstoneAttestationMap {
  readonly incomingKey: string;
  readonly entries: Readonly<Record<string, Readonly<Record<string, TombstoneAttestation>>>>;
}

export interface BuildTombstoneAttestationsInput {
  section: GitSection;
  incomingKey: string;
  lineageHash: string;
  liveRefs: Readonly<Record<string, string>>;
  logicalBaseRefs: Readonly<Record<string, string>>;
  origins: Readonly<Record<string, BranchBaseOrigin>>;
  artifacts: Readonly<Record<string, BranchArtifactDisposition>>;
  pendingEvidence: Readonly<Record<string, PendingEvidenceDisposition>>;
}

const clearArtifacts = (): BranchArtifactDisposition => ({
  absence: "absent", present: "absent", keeps: "clear", settledAbsence: "absent",
});

function originDisposition(
  origin: BranchBaseOrigin | undefined,
  oid: string,
  lineageHash: string,
): TombstoneAttestation["origin"] {
  if (!origin) return "missing";
  if (origin.oid !== oid) return "oid-mismatch";
  if (!branchBaseOriginMatches(origin, oid)) return "missing";
  if (origin.lineageHash !== lineageHash) return "lineage-mismatch";
  return "usable";
}

/**
 * The sole raw-wire → follower-authorization conversion. Validation completes
 * before any entry is allocated, so malformed input cannot produce a partial
 * authority map. The returned graph is immutable and incoming-key bound.
 */
export function buildTombstoneAttestations(input: BuildTombstoneAttestationsInput): TombstoneAttestationMap {
  const validation = validateGitSection(input.section);
  if (!validation.ok) throw new Error(`invalid Git section before tombstone attestation: ${validation.reason}`);
  const mutable: Record<string, Record<string, TombstoneAttestation>> = {};
  if (input.section.refScope === "all") {
    for (const ref of Object.keys(input.section.refTombstones ?? {}).sort()) {
      const byOid: Record<string, TombstoneAttestation> = {};
      for (const tombstone of input.section.refTombstones?.[ref] ?? []) {
        const pending = input.pendingEvidence[ref] ?? { incomingKey: input.incomingKey, d2Revalidated: false };
        byOid[tombstone.oid] = Object.freeze({
          incomingKey: input.incomingKey,
          ref,
          tombstonedOid: tombstone.oid,
          liveOid: input.liveRefs[ref] ?? null,
          logicalBaseOid: input.logicalBaseRefs[ref] ?? null,
          origin: originDisposition(input.origins[ref], tombstone.oid, input.lineageHash),
          artifacts: Object.freeze({ ...(input.artifacts[ref] ?? clearArtifacts()) }),
          pending: Object.freeze({ ...pending }),
        });
      }
      mutable[ref] = Object.freeze(byOid);
    }
  }
  return Object.freeze({ incomingKey: input.incomingKey, entries: Object.freeze(mutable) });
}

export type AttestationCheck =
  | { status: "authorized"; attestation: TombstoneAttestation }
  | { status: "hard-veto"; reason: string };

/** Revalidates every map binding consumed at the mutation boundary. */
export function checkTombstoneAttestation(
  map: TombstoneAttestationMap,
  facts: { incomingKey: string; ref: string; oid: string; liveOid: string | null; logicalBaseOid: string | null },
): AttestationCheck {
  if (map.incomingKey !== facts.incomingKey) return { status: "hard-veto", reason: "stale attestation map" };
  const entry = map.entries[facts.ref]?.[facts.oid];
  if (!entry || entry.incomingKey !== facts.incomingKey || entry.ref !== facts.ref || entry.tombstonedOid !== facts.oid) {
    return { status: "hard-veto", reason: "missing or mismatched attestation" };
  }
  if (entry.liveOid !== facts.liveOid || entry.logicalBaseOid !== facts.logicalBaseOid) {
    return { status: "hard-veto", reason: "attested live/BASE observation is stale" };
  }
  if (facts.liveOid !== facts.oid || facts.logicalBaseOid !== facts.oid) {
    return { status: "hard-veto", reason: "live and positive BASE equality required" };
  }
  if (entry.origin !== "usable") return { status: "hard-veto", reason: `positive BASE origin ${entry.origin}` };
  if (entry.pending.incomingKey !== facts.incomingKey || !entry.pending.d2Revalidated) {
    return { status: "hard-veto", reason: "pending evidence is not D2-revalidated" };
  }
  if (entry.artifacts.absence !== "absent" || entry.artifacts.settledAbsence !== "absent"
    || entry.artifacts.present !== "absent" || entry.artifacts.keeps !== "clear") {
    return { status: "hard-veto", reason: "owning or foreign artifact veto" };
  }
  return { status: "authorized", attestation: entry };
}
