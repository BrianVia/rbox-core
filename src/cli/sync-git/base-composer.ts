import type { GitRefScope, GitSection } from "../../engine/index.js";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EPISODE = /^[0-9a-f]{32}$/;

/** Adding a GitSection field requires an explicit composer-family audit. The actual
 * copy is a whole-object spread; this map is the compile-time exhaustiveness gate. */
const GIT_SECTION_FIELD_COVERAGE = {
  bundleSha: true,
  bundleEncSha: true,
  bundleCipherSize: true,
  bundleComp: true,
  bundlePayloadSha: true,
  packChain: true,
  head: true,
  refs: true,
  refTombstones: true,
  refTombstoneGeneration: true,
  indexSha: true,
  indexEncSha: true,
  indexCipherSize: true,
  indexComp: true,
  indexPayloadSha: true,
  indexTree: true,
  opState: true,
  config: true,
  refScope: true,
  generatedAt: true,
} as const satisfies Record<keyof GitSection, true>;
void GIT_SECTION_FIELD_COVERAGE;

export type BranchBaseOrigin =
  | { v: 1; oid: string; lineageHash: string; kind: "pull-p"; episode: string }
  | { v: 1; oid: string; lineageHash: string; kind: "publisher-ack"; sourceSeq: number; incomingKey: string }
  | { v: 1; oid: string; lineageHash: string; kind: "manual"; episode: string };

export type SafeRefWitness =
  | { kind: "safe-ref"; proof: "expected-old-transaction"; beforeOid: string | null; afterOid: string | null }
  | { kind: "safe-ref"; proof: "locked-terminal-observation"; afterOid: string | null };

export type BranchTransitionWitness =
  | {
      kind: "absent";
      ref: string;
      priorOid: string;
      lineageHash: string;
      repositoryIdentityHash: string;
      artifactRef: string;
      artifactOid: string;
      source: "a" | "z";
    }
  | {
      kind: "present";
      ref: string;
      priorOid: string | null;
      nextOid: string;
      lineageHash: string;
      repositoryIdentityHash: string;
      artifactRef: string;
      artifactOid: string;
      episode: string;
    };

export interface LockedBranchProof {
  liveOid: string | null;
  witness?: BranchTransitionWitness;
  reflogEpisode?: string;
  artifactsClear: boolean;
  ownershipStable: boolean;
  reflogStable: boolean;
  currentRef: boolean;
  siblingOwned: boolean;
}

export interface RepoBaseLockedProof {
  repoKind: "dir" | "pointer";
  effectiveRefScope: GitRefScope;
  checkoutComplete: boolean;
  incomingKey?: string;
  stateGeneration?: number;
  snapshotId?: string;
  freshConfirmation?: boolean;
  branches: Readonly<Record<string, LockedBranchProof>>;
  safeRefs: Readonly<Record<string, { liveOid: string | null; witness: SafeRefWitness; stashReflogReady?: boolean }>>;
}

interface ProofAuthorityBase {
  lineageHash: string;
  repositoryIdentityHash: string;
  incomingKey: string;
  branchWitnesses: Readonly<Record<string, BranchTransitionWitness>>;
  safeRefWitnesses: Readonly<Record<string, SafeRefWitness>>;
}

export type ManualBranchDecision =
  | { kind: "artifact"; beforeBaseOid: string | null; witness: BranchTransitionWitness }
  | { kind: "no-p"; beforeOid: string; afterOid: string; episode: string };

export type ComposeRepoBaseAuthority =
  | ({ kind: "pull-ref-transaction" } & ProofAuthorityBase)
  | ({ kind: "pull-carry"; lineageHash: string; incomingKey?: string })
  | ({ kind: "journal-recovery"; journalId: string } & ProofAuthorityBase)
  | {
      kind: "publisher-ack";
      lineageHash: string;
      repositoryIdentityHash: string;
      incomingKey: string;
      sourceSeq: number;
      advertisedRefs: Readonly<Record<string, string>>;
    }
  | {
      kind: "manual";
      lineageHash: string;
      repositoryIdentityHash: string;
      incomingKey: string;
      episode: string;
      snapshotId: string;
      stateGeneration: number;
      branchDecisions: Readonly<Record<string, ManualBranchDecision>>;
      safeRefWitnesses: Readonly<Record<string, SafeRefWitness>>;
    }
  | {
      kind: "p-repair";
      lineageHash: string;
      repositoryIdentityHash: string;
      repairs: Readonly<Record<string, {
        witness: Extract<BranchTransitionWitness, { kind: "present" }>;
        disposition: "advance-prior-to-next" | "already-next" | "preserve-absent" | "preserve-third";
      }>>;
    }
  | { kind: "migration"; lineageHash: string };

export interface RepoBaseValue {
  base?: GitSection;
  branchBaseOrigins?: Record<string, BranchBaseOrigin>;
}

export type RepoBaseHoldCode =
  | "missing-branch-proof"
  | "mismatched-branch-proof"
  | "missing-safe-ref-proof"
  | "mismatched-safe-ref-proof"
  | "wrong-ref-class"
  | "scope-refused"
  | "manual-proof-mismatch"
  | "p-repair-shape-mismatch";

export interface RepoBaseHardHold {
  ref: string;
  code: RepoBaseHoldCode;
}

export interface ComposeRepoBaseResult extends RepoBaseValue {
  disposition: "terminal" | "pending";
  holds: RepoBaseHardHold[];
}

export interface RepoBaseProof {
  authority: ComposeRepoBaseAuthority;
  lockedProof: RepoBaseLockedProof;
}

const isBranch = (ref: string): boolean => ref.startsWith("refs/heads/");
const isSafeRef = (ref: string): boolean => ref.startsWith("refs/tags/") || ref === "refs/stash";
const oid = (value: string | null): boolean => value === null || HEX40.test(value);

function sameWitness(left: BranchTransitionWitness | undefined, right: BranchTransitionWitness | undefined): boolean {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function sameSafeWitness(left: SafeRefWitness | undefined, right: SafeRefWitness | undefined): boolean {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/** Persistence/carry validity is deliberately weaker than authorization
 * validity. An unchanged BASE member retains any well-formed origin bound to
 * that OID, including a stale-lineage origin; the live-lineage attestation
 * check is what decides whether that retained metadata is usable authority. */
export function branchBaseOriginMatches(origin: BranchBaseOrigin | undefined, refOid: string): origin is BranchBaseOrigin {
  if (origin === undefined || origin.v !== 1 || origin.oid !== refOid
    || !HEX40.test(origin.oid) || !HEX64.test(origin.lineageHash)) return false;
  if (origin.kind === "publisher-ack") {
    return Number.isSafeInteger(origin.sourceSeq) && origin.sourceSeq >= 0 && origin.incomingKey.length > 0;
  }
  return (origin.kind === "pull-p" || origin.kind === "manual") && EPISODE.test(origin.episode);
}

/** Diagnostic/carry lineage hint only. Mixed or malformed stored provenance is
 * never collapsed by object iteration order. */
export function recordOriginLineage(origins: Readonly<Record<string, BranchBaseOrigin>> | undefined): string | undefined {
  const entries = Object.entries(origins ?? {});
  if (entries.length === 0) return undefined;
  const lineages = new Set<string>();
  for (const [ref, origin] of entries) {
    if (!isBranch(ref) || !branchBaseOriginMatches(origin, origin.oid)) return undefined;
    lineages.add(origin.lineageHash);
  }
  return lineages.size === 1 ? lineages.values().next().value : undefined;
}

function usableOrigin(origin: BranchBaseOrigin | undefined, refOid: string, lineageHash: string): origin is BranchBaseOrigin {
  return branchBaseOriginMatches(origin, refOid) && origin.lineageHash === lineageHash;
}

function pullOrigin(witness: Extract<BranchTransitionWitness, { kind: "present" }>): BranchBaseOrigin {
  return { v: 1, oid: witness.nextOid, lineageHash: witness.lineageHash, kind: "pull-p", episode: witness.episode };
}

function validSafeShape(witness: SafeRefWitness, _logicalBefore: string | null, after: string | null): boolean {
  if (!oid(after)) return false;
  if (witness.proof === "expected-old-transaction") {
    return oid(witness.beforeOid) && witness.afterOid === after && witness.beforeOid !== after;
  }
  return witness.afterOid === after;
}

function validBranchWitnessShape(witness: BranchTransitionWitness): boolean {
  if (!isBranch(witness.ref) || !HEX64.test(witness.lineageHash) || !HEX64.test(witness.repositoryIdentityHash)
    || !HEX40.test(witness.artifactOid)) return false;
  if (witness.kind === "absent") return HEX40.test(witness.priorOid);
  return oid(witness.priorOid) && HEX40.test(witness.nextOid) && EPISODE.test(witness.episode);
}

function branchProofMatches(
  witness: BranchTransitionWitness | undefined,
  locked: LockedBranchProof | undefined,
  ref: string,
  before: string | null,
  after: string | null,
  lineageHash: string,
  repositoryIdentityHash: string,
): boolean {
  if (!witness || !validBranchWitnessShape(witness) || !locked || witness.ref !== ref || witness.lineageHash !== lineageHash
    || witness.repositoryIdentityHash !== repositoryIdentityHash || !sameWitness(witness, locked.witness)
    || locked.liveOid !== after || !locked.artifactsClear || !locked.ownershipStable || !locked.reflogStable) return false;
  if (witness.kind === "absent") return after === null && before === witness.priorOid;
  return after === witness.nextOid && before === witness.priorOid && locked.reflogEpisode === witness.episode;
}

/** Exact-P post-state recovery: state may already contain N while P/K still
 * stand. The artifact's historical prior is deliberately not required to
 * equal serialized BASE in this crash shape; every other locked fact remains
 * mandatory, and only N's missing pull-p provenance may be repaired. */
function branchPostStateProofMatches(
  witness: BranchTransitionWitness | undefined,
  locked: LockedBranchProof | undefined,
  ref: string,
  value: string,
  lineageHash: string,
  repositoryIdentityHash: string,
): witness is Extract<BranchTransitionWitness, { kind: "present" }> {
  return witness?.kind === "present" && validBranchWitnessShape(witness)
    && witness.ref === ref && witness.nextOid === value
    && witness.lineageHash === lineageHash && witness.repositoryIdentityHash === repositoryIdentityHash
    && !!locked && sameWitness(witness, locked.witness) && locked.liveOid === value
    && locked.reflogEpisode === witness.episode && locked.artifactsClear
    && locked.ownershipStable && locked.reflogStable;
}

function authorityBranchWitness(authority: ComposeRepoBaseAuthority, ref: string): BranchTransitionWitness | undefined {
  if (authority.kind === "pull-ref-transaction" || authority.kind === "journal-recovery") return authority.branchWitnesses[ref];
  if (authority.kind === "manual") {
    const decision = authority.branchDecisions[ref];
    return decision?.kind === "artifact" ? decision.witness : undefined;
  }
  return undefined;
}

function authoritySafeWitness(authority: ComposeRepoBaseAuthority, ref: string): SafeRefWitness | undefined {
  if (authority.kind === "pull-ref-transaction" || authority.kind === "journal-recovery") return authority.safeRefWitnesses[ref];
  if (authority.kind === "manual") return authority.safeRefWitnesses[ref];
  return undefined;
}

function incomingBoundaryMatches(authority: ComposeRepoBaseAuthority, lockedProof: RepoBaseLockedProof): boolean {
  return authority.kind !== "pull-ref-transaction" && authority.kind !== "journal-recovery"
    ? true
    : lockedProof.incomingKey === authority.incomingKey;
}

function proofIdentity(authority: ComposeRepoBaseAuthority): { lineageHash: string; repositoryIdentityHash?: string } {
  return authority.kind === "pull-carry" || authority.kind === "migration"
    ? { lineageHash: authority.lineageHash }
    : { lineageHash: authority.lineageHash, repositoryIdentityHash: authority.repositoryIdentityHash };
}

function authorityExhaustive(authority: ComposeRepoBaseAuthority): void {
  switch (authority.kind) {
    case "pull-ref-transaction":
    case "pull-carry":
    case "journal-recovery":
    case "publisher-ack":
    case "manual":
    case "p-repair":
    case "migration": return;
    default: {
      const neverAuthority: never = authority;
      return neverAuthority;
    }
  }
}

/** The sole pure constructor for persisted Git BASE and positive branch provenance. */
export function composeRepoBase(
  previous: RepoBaseValue,
  candidate: RepoBaseValue,
  authority: ComposeRepoBaseAuthority,
  lockedProof: RepoBaseLockedProof,
): ComposeRepoBaseResult {
  authorityExhaustive(authority);
  const identity = proofIdentity(authority);
  const previousRefs = previous.base?.refs ?? {};
  const candidateRefs = candidate.base?.refs ?? {};
  const composedBranchRefs: Record<string, string> = {};
  const origins: Record<string, BranchBaseOrigin> = {};
  const holds: RepoBaseHardHold[] = [];
  const branchKeys = [...new Set([...Object.keys(previousRefs), ...Object.keys(candidateRefs)].filter(isBranch))].sort();

  for (const ref of branchKeys) {
    const before = previousRefs[ref] ?? null;
    const requested = candidateRefs[ref] ?? null;
    let after = requested;
    let origin: BranchBaseOrigin | undefined;
    const priorOrigin = previous.branchBaseOrigins?.[ref];

    if (authority.kind === "pull-carry") {
      after = before;
      if (requested !== before) holds.push({ ref, code: "missing-branch-proof" });
    } else if (authority.kind === "migration") {
      if (before !== null && requested === null) {
        after = before;
        holds.push({ ref, code: "missing-branch-proof" });
      }
    } else if (authority.kind === "publisher-ack") {
      if (requested === null) after = before;
      else if (authority.advertisedRefs[ref] !== requested || !HEX40.test(requested)
        || !HEX64.test(authority.lineageHash) || !HEX64.test(authority.repositoryIdentityHash)
        || !Number.isSafeInteger(authority.sourceSeq) || authority.sourceSeq < 0 || authority.incomingKey.length === 0) {
        after = before;
        holds.push({ ref, code: "mismatched-branch-proof" });
      } else if (requested !== before) {
        origin = {
          v: 1, oid: requested, lineageHash: authority.lineageHash, kind: "publisher-ack",
          sourceSeq: authority.sourceSeq, incomingKey: authority.incomingKey,
        };
      }
    } else if (authority.kind === "p-repair") {
      const repair = authority.repairs[ref];
      if (!repair) {
        after = before;
        if (requested !== before) holds.push({ ref, code: "p-repair-shape-mismatch" });
      } else {
        const witness = repair.witness;
        const locked = lockedProof.branches[ref];
        if (!validBranchWitnessShape(witness) || witness.ref !== ref || witness.lineageHash !== authority.lineageHash
          || witness.repositoryIdentityHash !== authority.repositoryIdentityHash
          || !locked || !sameWitness(witness, locked.witness) || !locked.artifactsClear
          || !locked.ownershipStable || !locked.reflogStable) {
          after = before;
          holds.push({ ref, code: "p-repair-shape-mismatch" });
          if (after !== null) composedBranchRefs[ref] = after;
          if (after !== null && usableOrigin(priorOrigin, after, identity.lineageHash)) origins[ref] = priorOrigin;
          continue;
        }
        const prior = witness.priorOid;
        const mayAdvance = before === prior && repair.disposition === "advance-prior-to-next";
        const alreadyNext = before === witness.nextOid && repair.disposition === "already-next";
        if (mayAdvance || alreadyNext) {
          after = witness.nextOid;
          origin = pullOrigin(witness);
        } else {
          after = before;
          if (!((before === null && repair.disposition === "preserve-absent")
            || (before !== null && before !== prior && before !== witness.nextOid && repair.disposition === "preserve-third"))) {
            holds.push({ ref, code: "p-repair-shape-mismatch" });
          }
        }
      }
    } else if (authority.kind === "manual") {
      const decision = authority.branchDecisions[ref];
      const commonManual = lockedProof.incomingKey === authority.incomingKey
        && lockedProof.snapshotId === authority.snapshotId
        && lockedProof.stateGeneration === authority.stateGeneration
        && lockedProof.freshConfirmation === true;
      if (decision?.kind === "no-p") {
        const locked = lockedProof.branches[ref];
        const valid = commonManual && before !== null && requested !== null
          && decision.beforeOid === before && decision.afterOid === requested && decision.episode === authority.episode
          && EPISODE.test(decision.episode)
          && locked?.liveOid === requested && locked.artifactsClear && locked.ownershipStable
          && locked.reflogStable && !locked.siblingOwned;
        if (!valid) {
          after = before;
          holds.push({ ref, code: "manual-proof-mismatch" });
        } else {
          origin = { v: 1, oid: requested, lineageHash: authority.lineageHash, kind: "manual", episode: decision.episode };
        }
      } else if (before === requested) {
        after = before;
      } else {
        const witness = authorityBranchWitness(authority, ref);
        const locked = lockedProof.branches[ref];
        const validArtifact = decision?.kind === "artifact"
          && decision.beforeBaseOid === before
          && witness !== undefined && validBranchWitnessShape(witness)
          && locked !== undefined && witness.ref === ref
          && witness.lineageHash === authority.lineageHash
          && witness.repositoryIdentityHash === authority.repositoryIdentityHash
          && sameWitness(witness, locked.witness)
          && locked.liveOid === requested && locked.artifactsClear
          && locked.ownershipStable && locked.reflogStable && !locked.siblingOwned
          && (witness.kind === "absent"
            ? requested === null && witness.priorOid === before
            : requested === witness.nextOid && locked.reflogEpisode === witness.episode);
        if (!commonManual || !validArtifact) {
          after = before;
          holds.push({ ref, code: witness ? "mismatched-branch-proof" : "missing-branch-proof" });
        } else if (witness?.kind === "present") origin = pullOrigin(witness);
      }
    } else if (before !== requested) {
      const witness = authorityBranchWitness(authority, ref);
      if (!incomingBoundaryMatches(authority, lockedProof)
        || !branchProofMatches(witness, lockedProof.branches[ref], ref, before, requested,
        authority.lineageHash, authority.repositoryIdentityHash)) {
        after = before;
        holds.push({ ref, code: witness ? "mismatched-branch-proof" : "missing-branch-proof" });
      } else if (witness?.kind === "present") origin = pullOrigin(witness);
    } else if ((authority.kind === "pull-ref-transaction" || authority.kind === "journal-recovery")
      && requested !== null) {
      const witness = authorityBranchWitness(authority, ref);
      if (branchPostStateProofMatches(witness, lockedProof.branches[ref], ref, requested,
        authority.lineageHash, authority.repositoryIdentityHash)) origin = pullOrigin(witness);
    }

    if (after !== null) {
      composedBranchRefs[ref] = after;
      if (!origin && before === after && branchBaseOriginMatches(priorOrigin, after)) origin = priorOrigin;
      if (origin) origins[ref] = origin;
    }
  }

  const safeKeys = [...new Set([...Object.keys(previousRefs), ...Object.keys(candidateRefs)].filter(isSafeRef))].sort();
  let safeRefsValid = true;
  for (const ref of safeKeys) {
    const before = previousRefs[ref] ?? null;
    const after = candidateRefs[ref] ?? null;
    if (before === after) continue;
    if (authority.kind === "migration") {
      if (before !== null && after === null) {
        safeRefsValid = false;
        holds.push({ ref, code: "missing-safe-ref-proof" });
      }
      continue;
    }
    if (authority.kind === "publisher-ack") {
      if (after === null) continue;
      if (authority.advertisedRefs[ref] !== after) {
        safeRefsValid = false;
        holds.push({ ref, code: "mismatched-safe-ref-proof" });
      }
      continue;
    }
    if (authority.kind === "pull-carry" || authority.kind === "p-repair") {
      safeRefsValid = false;
      holds.push({ ref, code: "missing-safe-ref-proof" });
      continue;
    }
    if (lockedProof.repoKind !== "dir" || lockedProof.effectiveRefScope !== "all") {
      safeRefsValid = false;
      holds.push({ ref, code: "scope-refused" });
      continue;
    }
    const witness = authoritySafeWitness(authority, ref);
    const locked = lockedProof.safeRefs[ref];
    if (!incomingBoundaryMatches(authority, lockedProof)
      || !witness || !locked || !sameSafeWitness(witness, locked.witness)
      || locked.liveOid !== after || !validSafeShape(witness, before, after)
      || (ref === "refs/stash" && after !== null && locked.stashReflogReady !== true)) {
      safeRefsValid = false;
      holds.push({ ref, code: witness ? "mismatched-safe-ref-proof" : "missing-safe-ref-proof" });
    }
  }

  for (const ref of Object.keys((authority.kind === "pull-ref-transaction" || authority.kind === "journal-recovery")
    ? authority.safeRefWitnesses : authority.kind === "manual" ? authority.safeRefWitnesses : {})) {
    if (!isSafeRef(ref)) holds.push({ ref, code: "wrong-ref-class" });
  }
  for (const ref of Object.keys((authority.kind === "pull-ref-transaction" || authority.kind === "journal-recovery")
    ? authority.branchWitnesses : authority.kind === "manual" ? authority.branchDecisions : {})) {
    if (!isBranch(ref)) holds.push({ ref, code: "wrong-ref-class" });
  }

  const pending = holds.length > 0 || !lockedProof.checkoutComplete || !safeRefsValid;
  const family = pending ? previous.base : candidate.base;
  if (!family) return {
    disposition: pending ? "pending" : "terminal",
    holds,
  };

  const refs = pending ? { ...previousRefs } : { ...candidateRefs };
  for (const ref of Object.keys(refs)) if (isBranch(ref)) delete refs[ref];
  Object.assign(refs, composedBranchRefs);
  if (!pending && authority.kind === "publisher-ack") {
    for (const [ref, value] of Object.entries(previousRefs)) if (candidateRefs[ref] === undefined) refs[ref] = value;
  }
  if (!pending && authority.kind === "migration") {
    for (const [ref, value] of Object.entries(previousRefs)) if (candidateRefs[ref] === undefined) refs[ref] = value;
  }
  return {
    base: { ...family, refs },
    ...(Object.keys(origins).length ? { branchBaseOrigins: origins } : {}),
    disposition: pending ? "pending" : "terminal",
    holds,
  };
}

export function migrationRepoBaseProof(lineageHash = "legacy-untrusted"): RepoBaseProof {
  return {
    authority: { kind: "migration", lineageHash },
    lockedProof: { repoKind: "dir", effectiveRefScope: "all", checkoutComplete: true, branches: {}, safeRefs: {} },
  };
}

export function carryRepoBaseProof(lineageHash = "legacy-untrusted"): RepoBaseProof {
  return {
    authority: { kind: "pull-carry", lineageHash },
    lockedProof: { repoKind: "dir", effectiveRefScope: "all", checkoutComplete: true, branches: {}, safeRefs: {} },
  };
}
