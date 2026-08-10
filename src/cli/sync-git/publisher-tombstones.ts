import {
  MAX_REF_TOMBSTONES_PER_REF,
  MAX_REF_TOMBSTONES_PER_REPO,
  validateRefTombstones,
  type GitRefTombstone,
  type GitSection,
} from "../../engine/index.js";
import { gitIncomingKey } from "./shared.js";

export const REF_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type TombstoneNormalizationFinding =
  | { kind: "invalid-carried-fields"; source: "advertised" | "pending" | "candidate" }
  | { kind: "generation-collision"; count: number }
  | { kind: "generation-overflow"; count: number }
  | { kind: "expired"; count: number }
  | { kind: "per-ref-evicted"; count: number }
  | { kind: "repository-evicted"; count: number };

export interface TombstoneNormalizationResult {
  section: GitSection;
  findings: TombstoneNormalizationFinding[];
}

const bytewise = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const entryByGeneration = (a: GitRefTombstone, b: GitRefTombstone): number =>
  a.generation - b.generation || bytewise(a.oid, b.oid);
const evictionOrder = (a: GitRefTombstone, b: GitRefTombstone): number =>
  bytewise(a.ts, b.ts) || bytewise(a.oid, b.oid);

interface AcceptedFields {
  generation: number;
  chains: Record<string, GitRefTombstone[]>;
}

function acceptedFields(section: GitSection | undefined): AcceptedFields | undefined {
  if (!section || (section.refTombstones === undefined && section.refTombstoneGeneration === undefined)) {
    return { generation: 0, chains: {} };
  }
  if (!validateRefTombstones(section).ok) return undefined;
  return {
    generation: section.refTombstoneGeneration ?? 0,
    chains: Object.fromEntries(Object.entries(section.refTombstones ?? {}).map(([ref, entries]) => [
      ref,
      entries.map((entry) => ({ ...entry })),
    ])),
  };
}

/** Design 130's single pure outbound normalization boundary for one non-pending
 * section. It carries bounded history, authors only all→all supersessions, retains the
 * monotonic high-water mark across expiry/eviction, and emits a canonical container.
 * Logging remains a caller concern so this function is deterministic and side-effect free. */
export function normalizePublishedGitSection(
  advertised: GitSection | undefined,
  candidate: GitSection,
  now: string,
  pendingRetention?: GitSection,
  absentBranchProofs: Readonly<Record<string, { priorOid: string }>> = {},
): TombstoneNormalizationResult {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== now) {
    throw new Error(`tombstone normalizer requires a canonical UTC millisecond timestamp (got ${JSON.stringify(now)})`);
  }

  const findings: TombstoneNormalizationFinding[] = [];
  const advertisedFields = acceptedFields(advertised);
  const pendingFields = pendingRetention === undefined ? undefined : acceptedFields(pendingRetention);
  const candidateFields = acceptedFields(candidate);
  if (!advertisedFields) findings.push({ kind: "invalid-carried-fields", source: "advertised" });
  if (pendingRetention !== undefined && !pendingFields) findings.push({ kind: "invalid-carried-fields", source: "pending" });
  if (!candidateFields) findings.push({ kind: "invalid-carried-fields", source: "candidate" });
  const sources = [advertisedFields, pendingFields, candidateFields].filter((value): value is AcceptedFields => value !== undefined);
  let generation = sources.reduce((maximum, source) => Math.max(maximum, source.generation), 0);

  // Merge by (ref,oid), preferring the newest generation. A same-ref generation
  // collision can arise only when an old writer truncated one lineage; retain one
  // deterministic entry (safe loss of authority) rather than emitting invalid wire.
  const chains = new Map<string, Map<string, GitRefTombstone>>();
  for (const source of sources) {
    for (const [ref, entries] of Object.entries(source.chains)) {
      const byOid = chains.get(ref) ?? new Map<string, GitRefTombstone>();
      chains.set(ref, byOid);
      for (const entry of entries) {
        const existing = byOid.get(entry.oid);
        if (!existing || entry.generation > existing.generation) byOid.set(entry.oid, { ...entry });
      }
    }
  }
  let collisionCount = 0;
  for (const byOid of chains.values()) {
    const byGeneration = new Map<number, GitRefTombstone>();
    for (const entry of byOid.values()) {
      const existing = byGeneration.get(entry.generation);
      if (!existing) {
        byGeneration.set(entry.generation, entry);
      } else {
        collisionCount++;
        const keep = bytewise(existing.oid, entry.oid) <= 0 ? existing : entry;
        const drop = keep === existing ? entry : existing;
        byOid.delete(drop.oid);
        byGeneration.set(entry.generation, keep);
      }
    }
  }
  if (collisionCount) findings.push({ kind: "generation-collision", count: collisionCount });

  let overflow = 0;
  if (advertised?.refScope === "all" && candidate.refScope === "all") {
    for (const ref of Object.keys(advertised.refs).sort(bytewise)) {
      if (!ref.startsWith("refs/heads/")) continue;
      const priorOid = advertised.refs[ref]!;
      if (candidate.refs[ref] === priorOid) continue;
      if (generation === Number.MAX_SAFE_INTEGER) {
        overflow++;
        continue;
      }
      generation++;
      const byOid = chains.get(ref) ?? new Map<string, GitRefTombstone>();
      byOid.set(priorOid, { oid: priorOid, ts: now, generation });
      chains.set(ref, byOid);
    }
  }
  if (candidate.refScope === "all") {
    for (const [ref, proof] of Object.entries(absentBranchProofs).sort(([a], [b]) => bytewise(a, b))) {
      if (!ref.startsWith("refs/heads/") || candidate.refs[ref] !== undefined || !/^[0-9a-f]{40}$/.test(proof.priorOid)) continue;
      const byOid = chains.get(ref) ?? new Map<string, GitRefTombstone>();
      if (generation === Number.MAX_SAFE_INTEGER) {
        overflow++;
        continue;
      }
      generation++;
      byOid.set(proof.priorOid, { oid: proof.priorOid, ts: now, generation });
      chains.set(ref, byOid);
    }
  }
  if (overflow) findings.push({ kind: "generation-overflow", count: overflow });

  const cutoff = nowMs - REF_TOMBSTONE_RETENTION_MS;
  let expired = 0;
  for (const [ref, byOid] of chains) {
    for (const [oid, entry] of byOid) {
      if (Date.parse(entry.ts) < cutoff) {
        byOid.delete(oid);
        expired++;
      }
    }
    if (byOid.size === 0) chains.delete(ref);
  }
  if (expired) findings.push({ kind: "expired", count: expired });

  let perRefEvicted = 0;
  for (const [ref, byOid] of chains) {
    const ordered = [...byOid.values()].sort(evictionOrder);
    for (const entry of ordered.slice(0, Math.max(0, ordered.length - MAX_REF_TOMBSTONES_PER_REF))) {
      byOid.delete(entry.oid);
      perRefEvicted++;
    }
    if (byOid.size === 0) chains.delete(ref);
  }
  if (perRefEvicted) findings.push({ kind: "per-ref-evicted", count: perRefEvicted });

  const repositoryEntries = [...chains.entries()].flatMap(([ref, byOid]) =>
    [...byOid.values()].map((entry) => ({ ref, entry }))
  ).sort((a, b) => bytewise(a.entry.ts, b.entry.ts) || bytewise(a.ref, b.ref) || bytewise(a.entry.oid, b.entry.oid));
  let repositoryEvicted = 0;
  for (const { ref, entry } of repositoryEntries.slice(0, Math.max(0, repositoryEntries.length - MAX_REF_TOMBSTONES_PER_REPO))) {
    const byOid = chains.get(ref);
    if (!byOid?.delete(entry.oid)) continue;
    repositoryEvicted++;
    if (byOid.size === 0) chains.delete(ref);
  }
  if (repositoryEvicted) findings.push({ kind: "repository-evicted", count: repositoryEvicted });

  const refTombstones = Object.fromEntries([...chains.keys()].sort(bytewise).map((ref) => [
    ref,
    [...chains.get(ref)!.values()].sort(entryByGeneration),
  ]));
  return {
    section: { ...candidate, refTombstones, refTombstoneGeneration: generation },
    findings,
  };
}

/** Pure map boundary. Pending values are deliberately installed by identity, without
 * parsing or normalization, because changing their bytes changes gitIncomingKey. */
export function normalizeOutgoingGitSections(
  outgoing: Readonly<Record<string, GitSection>>,
  pending: Readonly<Record<string, GitSection>>,
  advertised: Readonly<Record<string, GitSection | undefined>>,
  now: string,
  absentBranchProofs: Readonly<Record<string, Readonly<Record<string, { priorOid: string }>>>> = {},
): { sections: Record<string, GitSection>; findings: Array<{ relPath: string; finding: TombstoneNormalizationFinding }> } {
  const sections: Record<string, GitSection> = {};
  const findings: Array<{ relPath: string; finding: TombstoneNormalizationFinding }> = [];
  for (const relPath of Object.keys(outgoing).sort(bytewise)) {
    const section = outgoing[relPath]!;
    const pendingSection = pending[relPath];
    if (pendingSection !== undefined && gitIncomingKey(pendingSection) === gitIncomingKey(section)) {
      sections[relPath] = pendingSection;
      continue;
    }
    const normalized = normalizePublishedGitSection(advertised[relPath], section, now, pendingSection, absentBranchProofs[relPath]);
    sections[relPath] = normalized.section;
    findings.push(...normalized.findings.map((finding) => ({ relPath, finding })));
  }
  return { sections, findings };
}

export function tombstoneFindingLine(relPath: string, finding: TombstoneNormalizationFinding): string {
  switch (finding.kind) {
    case "invalid-carried-fields":
      return `git-sync WARNING ${relPath}: ignored invalid ${finding.source} tombstone fields; starting a safe new counter lineage`;
    case "generation-collision":
      return `git-sync WARNING ${relPath}: dropped ${finding.count} colliding tombstone entr${finding.count === 1 ? "y" : "ies"}`;
    case "generation-overflow":
      return `git-sync WARNING ${relPath}: tombstone generation overflow refused ${finding.count} supersession event${finding.count === 1 ? "" : "s"}; slow followers may hold`;
    case "expired":
      return `git-sync ${relPath}: expired ${finding.count} tombstone entr${finding.count === 1 ? "y" : "ies"}`;
    case "per-ref-evicted":
      return `git-sync WARNING ${relPath}: evicted ${finding.count} tombstone entr${finding.count === 1 ? "y" : "ies"} at the per-ref cap`;
    case "repository-evicted":
      return `git-sync WARNING ${relPath}: evicted ${finding.count} tombstone entr${finding.count === 1 ? "y" : "ies"} at the repository cap`;
  }
}
