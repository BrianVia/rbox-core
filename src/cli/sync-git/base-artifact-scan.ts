/** Never: artifact creation/retirement or follower mutation decisions. */
import { gitRaw } from "../../engine/git-spawn.js";
import { hashBytes } from "../../engine/hash.js";
import {
  BASE_ABSENT_PREFIX,
  BASE_PRESENT_KEEP_PREFIX,
  BASE_PRESENT_PREFIX,
  SETTLED_ABSENCE_PREFIX,
  basePresentKeepRef,
  inspectBaseAbsentArtifactRef,
  inspectBasePresentArtifactRef,
  readBaseAbsentArtifactRef,
  readBasePresentArtifactRef,
  type ArtifactReadResult,
  type BaseAbsentPayload,
  type BasePresentPayload,
  type PreparedProtocolRef,
} from "./base-artifacts.js";
import { P_REPAIR_Q_PREFIX } from "./p-repair.js";
import type { ArtifactBinding } from "./repo-lineage.js";

export interface BaseArtifactScan {
  absent: ArtifactReadResult<BaseAbsentPayload>[];
  present: ArtifactReadResult<BasePresentPayload>[];
  invalidNamespace: string[];
  orphanKeep: string[];
  foreign: ForeignBaseArtifactScanEntry[];
}

export interface ForeignBaseArtifactScanEntry {
  refname: string;
  lineageHash: string;
  kind: "absent" | "present" | "keep";
  branchRef?: string;
  status: "valid" | "invalid";
  detail?: string;
  /** Design 312: the inspected receipt of a valid foreign P, so a witness can judge
   *  it by its target rather than only by its lineage. */
  artifact?: PreparedProtocolRef<BasePresentPayload>;
}

type ArtifactNamespaceClassification =
  | { disposition: "invalid" }
  | { disposition: "current" | "foreign"; lineageHash: string };

async function listRefs(repoDir: string, prefix: string): Promise<string[]> {
  return (await gitRaw(repoDir, ["for-each-ref", "--format=%(refname)", prefix])).split("\n").filter(Boolean);
}

/** Every rbox-owned base/recovery artifact namespace, in one place. */
export const ARTIFACT_PLANE_PREFIXES: readonly string[] = [
  BASE_ABSENT_PREFIX,
  BASE_PRESENT_PREFIX,
  BASE_PRESENT_KEEP_PREFIX,
  SETTLED_ABSENCE_PREFIX,
  P_REPAIR_Q_PREFIX,
];

/** Exact refname+oid identity of the artifact plane the BASE composer reads.
 * gitFingerprint excludes these refs by construction (they are non-syncable),
 * so held-skip binds them here instead of widening the fingerprint. */
export async function readArtifactPlaneDigest(repoDir: string): Promise<string> {
  const lines = (await gitRaw(repoDir, [
    "for-each-ref", "--format=%(refname) %(objectname)", ...ARTIFACT_PLANE_PREFIXES,
  ])).split("\n").filter(Boolean).sort();
  return hashBytes(Buffer.from(lines.join("\n")));
}

/** Strictly classify every A/P/K ref in the shared common-dir namespace. Foreign
 * lineages are returned for the caller's cross-record veto pass; the current
 * lineage is fully decoded, bound, hash-checked, and checked for exact P/K shape. */
export async function scanBaseArtifacts(repoDir: string, binding: ArtifactBinding): Promise<BaseArtifactScan> {
  const [aRefs, pRefs, kRefs] = await Promise.all([
    listRefs(repoDir, BASE_ABSENT_PREFIX), listRefs(repoDir, BASE_PRESENT_PREFIX), listRefs(repoDir, BASE_PRESENT_KEEP_PREFIX),
  ]);
  const absent: ArtifactReadResult<BaseAbsentPayload>[] = [];
  const present: ArtifactReadResult<BasePresentPayload>[] = [];
  const invalidNamespace: string[] = [];
  const foreign: ForeignBaseArtifactScanEntry[] = [];
  const expectedKeeps = new Set<string>();
  const foreignKeeps = new Map<string, { branchRef: string; lineageHash: string }>();
  const classify = (ref: string, prefix: string, tail: RegExp): ArtifactNamespaceClassification => {
    const suffix = ref.slice(prefix.length + 1);
    const slash = suffix.indexOf("/");
    if (slash < 0 || !/^[0-9a-f]{64}$/.test(suffix.slice(0, slash)) || !tail.test(suffix.slice(slash + 1))) return { disposition: "invalid" };
    const lineageHash = suffix.slice(0, slash);
    return { disposition: lineageHash === binding.lineageHash ? "current" : "foreign", lineageHash };
  };
  for (const ref of aRefs) {
    const classified = classify(ref, BASE_ABSENT_PREFIX, /^[0-9a-f]{64}$/);
    if (classified.disposition === "invalid") invalidNamespace.push(ref);
    else if (classified.disposition === "foreign") {
      const inspected = await inspectBaseAbsentArtifactRef(repoDir, ref);
      foreign.push(inspected.status === "valid"
        ? { refname: ref, lineageHash: classified.lineageHash!, kind: "absent", branchRef: inspected.artifact.payload.ref, status: "valid" }
        : { refname: ref, lineageHash: classified.lineageHash!, kind: "absent", status: "invalid", detail: inspected.status === "invalid" ? inspected.detail : "artifact disappeared during scan" });
    }
    else absent.push(await readBaseAbsentArtifactRef(repoDir, binding, ref));
  }
  for (const ref of pRefs) {
    const classified = classify(ref, BASE_PRESENT_PREFIX, /^[0-9a-f]{64}$/);
    if (classified.disposition === "invalid") invalidNamespace.push(ref);
    else if (classified.disposition === "foreign") {
      const inspected = await inspectBasePresentArtifactRef(repoDir, ref);
      if (inspected.status === "valid") {
        const payload = inspected.artifact.payload;
        foreign.push({ refname: ref, lineageHash: classified.lineageHash!, kind: "present", branchRef: payload.ref, status: "valid", artifact: inspected.artifact });
        const foreignBinding = { lineageHash: payload.lineageHash, repositoryIdentityHash: payload.repositoryIdentityHash };
        if (payload.priorOid !== null) foreignKeeps.set(basePresentKeepRef(foreignBinding, payload.ref, payload.episode, "prior"), { branchRef: payload.ref, lineageHash: payload.lineageHash });
        foreignKeeps.set(basePresentKeepRef(foreignBinding, payload.ref, payload.episode, "next"), { branchRef: payload.ref, lineageHash: payload.lineageHash });
      } else {
        foreign.push({ refname: ref, lineageHash: classified.lineageHash!, kind: "present", status: "invalid", detail: inspected.status === "invalid" ? inspected.detail : "artifact disappeared during scan" });
      }
    }
    else {
      const result = await readBasePresentArtifactRef(repoDir, binding, ref);
      present.push(result);
      if (result.status === "valid") {
        const payload = result.artifact.payload;
        if (payload.priorOid !== null) expectedKeeps.add(basePresentKeepRef(binding, payload.ref, payload.episode, "prior"));
        expectedKeeps.add(basePresentKeepRef(binding, payload.ref, payload.episode, "next"));
      }
    }
  }
  const orphanKeep: string[] = [];
  for (const ref of kRefs) {
    const classified = classify(ref, BASE_PRESENT_KEEP_PREFIX, /^[0-9a-f]{64}\/[0-9a-f]{32}\/(?:prior|next)$/);
    if (classified.disposition === "invalid") invalidNamespace.push(ref);
    else if (classified.disposition === "foreign") {
      const owner = foreignKeeps.get(ref);
      foreign.push(owner
        ? { refname: ref, lineageHash: owner.lineageHash, kind: "keep", branchRef: owner.branchRef, status: "valid" }
        : { refname: ref, lineageHash: classified.lineageHash!, kind: "keep", status: "invalid", detail: "orphan foreign K" });
    }
    else if (!expectedKeeps.has(ref)) orphanKeep.push(ref);
  }
  return {
    absent, present,
    invalidNamespace: invalidNamespace.sort(), orphanKeep: orphanKeep.sort(), foreign: foreign.sort((a, b) => a.refname.localeCompare(b.refname)),
  };
}
