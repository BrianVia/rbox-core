import type { ResetPhase } from "./reset-journal.js";

export type StateDisposition = "old" | "next" | "absent" | "other";
export type NextArtifactDisposition = "next" | "absent" | "other";
export type OldArtifactDisposition = "old" | "absent" | "other";
export type MarkerDisposition = "old" | "next" | "absent" | "other";

export interface PrefixDisposition {
  kind: "prefix" | "other";
  count: number;
  total: number;
}

export interface ResetPhysicalObservation {
  phase: ResetPhase;
  archiveBaseline: "absent" | "exact";
  active: StateDisposition;
  candidate: NextArtifactDisposition;
  archive: OldArtifactDisposition;
  marker: MarkerDisposition;
  recoveryRefs: PrefixDisposition;
  activeRefGroups: PrefixDisposition;
}

export type ResetPhysicalRowId =
  | "P0" | "P0A" | "P1" | "P2" | `P3.${number}`
  | "R0" | "R1" | "R2"
  | "I0" | "I1" | "I2" | `I3.${number}`
  | "Z0";

export interface ResetPhysicalRow {
  /** I0 and I1 deliberately share one physical signature and action. */
  ids: readonly ResetPhysicalRowId[];
  observation: ResetPhysicalObservation;
}

const prefix = (value: PrefixDisposition, expected: number): boolean =>
  value.kind === "prefix" && value.count === expected && value.count >= 0 && value.count <= value.total;
const complete = (value: PrefixDisposition): boolean => prefix(value, value.total);
const preMarker = (value: MarkerDisposition): boolean => value === "old" || value === "absent";

/** Exact executable form of design 138's normative correlated row table. */
export function classifyResetPhysicalSignature(observation: ResetPhysicalObservation): ResetPhysicalRow | undefined {
  const { phase, active, candidate, archive, marker, recoveryRefs: recovery, activeRefGroups: groups } = observation;
  if (recovery.kind !== "prefix" || groups.kind !== "prefix") return undefined;
  if (phase === "prepared" && active === "old" && preMarker(marker) && prefix(groups, 0)) {
    if (candidate === "absent" && archive === "absent" && observation.archiveBaseline === "absent" && prefix(recovery, 0)) return { ids: ["P0"], observation };
    if (candidate === "absent" && archive === "old" && observation.archiveBaseline === "exact" && prefix(recovery, 0)) return { ids: ["P0A"], observation };
    if (candidate === "next" && archive === "absent" && observation.archiveBaseline === "absent" && prefix(recovery, 0)) return { ids: ["P1"], observation };
    if (candidate === "next" && archive === "old") {
      if (prefix(recovery, 0)) return { ids: ["P2"], observation };
      if (recovery.count > 0 && recovery.count <= recovery.total) return { ids: [`P3.${recovery.count}`], observation };
    }
    return undefined;
  }
  if (phase === "ready" && archive === "old" && preMarker(marker) && complete(recovery) && prefix(groups, 0)) {
    if (active === "old" && candidate === "next") return { ids: ["R0"], observation };
    if (active === "next" && candidate === "absent") return { ids: ["R1"], observation };
    if (active === "next" && candidate === "next") return { ids: ["R2"], observation };
    return undefined;
  }
  if (phase === "installed" && active === "next" && candidate === "absent" && archive === "old" && complete(recovery)) {
    if (preMarker(marker) && prefix(groups, 0)) return { ids: ["I0", "I1"], observation };
    if (marker === "next") {
      if (prefix(groups, 0)) return { ids: ["I2"], observation };
      if (groups.count > 0 && groups.count <= groups.total) return { ids: [`I3.${groups.count}`], observation };
    }
    return undefined;
  }
  if (phase === "z-retired" && active === "next" && candidate === "absent" && archive === "old"
    && marker === "next" && complete(recovery) && complete(groups)) return { ids: ["Z0"], observation };
  return undefined;
}
