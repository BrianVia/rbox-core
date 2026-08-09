import { canonicalize, verifyRoundTrip } from "../e2ee/jcs.js";
import { hashBytes } from "../hash.js";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const P_REPAIR_Q_PREFIX = "refs/rbox-recovery/base-present/v2";
export const MAX_P_REPAIR_Q_BYTES = 8_192;
export const MAX_P_REPAIR_Q_PER_LINEAGE = 256;

export interface ByteProjection {
  bytes: number;
  sha256: string;
  prefixB64: string;
  truncated: boolean;
}

export interface PRepairQ {
  v: 1;
  kind: "p-repair";
  lineageHash: string;
  repositoryIdentityHash: string;
  p: {
    artifactRef: ByteProjection;
    artifactOid: string;
    payload: {
      v: 2;
      lineageHash: string;
      repositoryIdentityHash: string;
      ref: ByteProjection;
      episode: string;
      priorOid: string | null;
      nextOid: string;
    };
    payloadBytes: number;
    payloadSha256: string;
  };
  observed: {
    liveOid: string | null;
    baseOid: string | null;
    repoGen: number;
    stateRevision: number;
    incomingKey: string | null;
    reflog: { bytes: number; entries: number; sha256: string; top: ByteProjection | null };
  };
  preserved: { count: number; oidsSha256: string };
  repair: {
    at: string;
    reason: "live-mismatch" | "reflog-mismatch" | "base-shape-mismatch";
    baseDisposition: "advance-prior-to-next" | "already-next" | "preserve-absent" | "preserve-third";
  };
}

export interface PRepairReceipt {
  v: 1;
  kind: "p-repaired";
  lineageHash: string;
  repositoryIdentityHash: string;
  ref: string;
  episode: string;
  p: { ref: string; targetOid: string };
  k: Array<{ ref: string; targetOid: string }>;
  q: { ref: string; targetOid: string; value: PRepairQ };
  origin: { ref: string; episode: string; class: "human" };
  skeep: { count: number; oidsSha256: string };
  reflog: { bytes: number; sha256: string };
  baseDisposition: PRepairQ["repair"]["baseDisposition"];
  eviction: null | { qRef: string; targetOid: string };
}

/** Closed observations used by the retry matrix.  Callers must determine every
 * boolean while holding the operation/origin/Git proof boundary; an unknown
 * read is not representable as success and therefore maps to hard-hold. */
export interface PRepairRetryObservation {
  receipt: "absent" | "matching" | "wrong";
  p: "exact" | "absent" | "wrong";
  k: "exact" | "absent" | "partial-or-wrong";
  q: "absent" | "exact" | "wrong";
  keepRefsExact: boolean;
  originSetHashMatches: boolean;
  liveReflogMatchesReceipt: boolean;
  eviction: "null" | "present-exact" | "absent" | "mixed-or-wrong";
}

export type PRepairRetryAction =
  | "recompute"
  | "resume-ref-commit"
  | "refresh-receipt"
  | "compact-and-restart"
  | "restore-terminal-bookkeeping"
  | "corruption-hold"
  | "artifact-contradiction-hold";

const P_REPAIR_RETRY_ACTION_COVERAGE = {
  recompute: true,
  "resume-ref-commit": true,
  "refresh-receipt": true,
  "compact-and-restart": true,
  "restore-terminal-bookkeeping": true,
  "corruption-hold": true,
  "artifact-contradiction-hold": true,
} as const satisfies Record<PRepairRetryAction, true>;
void P_REPAIR_RETRY_ACTION_COVERAGE;

const P_REPAIR_RETRY_AXIS_COVERAGE = {
  receipt: { absent: true, matching: true, wrong: true },
  p: { exact: true, absent: true, wrong: true },
  k: { exact: true, absent: true, "partial-or-wrong": true },
  q: { absent: true, exact: true, wrong: true },
  eviction: { null: true, "present-exact": true, absent: true, "mixed-or-wrong": true },
} as const satisfies {
  [K in "receipt" | "p" | "k" | "q" | "eviction"]: Record<PRepairRetryObservation[K], true>;
};
void P_REPAIR_RETRY_AXIS_COVERAGE;

export interface PRepairQEntry {
  ref: string;
  targetOid: string;
  value: PRepairQ;
}

export interface BuildPRepairQInput {
  lineageHash: string;
  repositoryIdentityHash: string;
  artifactRef: string | Uint8Array;
  artifactOid: string;
  pPayload: {
    v: 2;
    lineageHash: string;
    repositoryIdentityHash: string;
    ref: string | Uint8Array;
    episode: string;
    priorOid: string | null;
    nextOid: string;
  };
  payloadBytes: Uint8Array;
  observed: {
    liveOid: string | null;
    baseOid: string | null;
    repoGen: number;
    stateRevision: number;
    incomingKey: string | null;
    reflogBytes: Uint8Array;
    reflogEntries: number;
    reflogTop: Uint8Array | null;
  };
  skeep: readonly string[];
  at: string;
  mismatches: { live: boolean; reflog: boolean; baseShape: boolean };
}

const bytesOf = (value: string | Uint8Array): Uint8Array => typeof value === "string" ? Buffer.from(value, "utf8") : value;
const safeCounter = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export function byteProjection(value: string | Uint8Array, cap: number): ByteProjection {
  if (!safeCounter(cap)) throw new Error("invalid byte projection cap");
  const bytes = bytesOf(value);
  return {
    bytes: bytes.byteLength,
    sha256: hashBytes(bytes),
    prefixB64: Buffer.from(bytes.subarray(0, cap)).toString("base64"),
    truncated: bytes.byteLength > cap,
  };
}

export function pRepairBaseDisposition(
  priorOid: string | null,
  nextOid: string,
  baseOid: string | null,
): PRepairQ["repair"]["baseDisposition"] {
  if (baseOid === priorOid) return "advance-prior-to-next";
  if (baseOid === nextOid) return "already-next";
  if (baseOid === null) return "preserve-absent";
  return "preserve-third";
}

export function pRepairReason(mismatches: BuildPRepairQInput["mismatches"]): PRepairQ["repair"]["reason"] {
  if (mismatches.baseShape) return "base-shape-mismatch";
  if (mismatches.live) return "live-mismatch";
  if (mismatches.reflog) return "reflog-mismatch";
  throw new Error("P-repair requires a repairable mismatch");
}

export function skeepHash(oids: readonly string[]): { count: number; oidsSha256: string; sorted: string[] } {
  const sorted = [...new Set(oids)].sort();
  if (sorted.some((oid) => !HEX40.test(oid))) throw new Error("invalid Skeep OID");
  return {
    count: sorted.length,
    oidsSha256: hashBytes(Buffer.concat(sorted.map((oid) => Buffer.from(oid, "hex")))),
    sorted,
  };
}

function validateInput(input: BuildPRepairQInput): void {
  if (!HEX64.test(input.lineageHash) || !HEX64.test(input.repositoryIdentityHash)
    || input.pPayload.v !== 2 || input.pPayload.lineageHash !== input.lineageHash
    || input.pPayload.repositoryIdentityHash !== input.repositoryIdentityHash
    || !HEX32.test(input.pPayload.episode) || !HEX40.test(input.pPayload.nextOid)
    || (input.pPayload.priorOid !== null && !HEX40.test(input.pPayload.priorOid))
    || !HEX40.test(input.artifactOid) || !safeCounter(input.observed.repoGen)
    || !safeCounter(input.observed.stateRevision) || !safeCounter(input.observed.reflogEntries)
    || !RFC3339_MS.test(input.at) || new Date(input.at).toISOString() !== input.at) {
    throw new Error("invalid P-repair observation");
  }
}

export function pRepairQRef(lineageHash: string, ref: string | Uint8Array, episode: string): string {
  if (!HEX64.test(lineageHash) || !HEX32.test(episode)) throw new Error("invalid Q namespace binding");
  return `${P_REPAIR_Q_PREFIX}/${lineageHash}/${hashBytes(bytesOf(ref))}/${episode}`;
}

export function buildPRepairQ(input: BuildPRepairQInput): { value: PRepairQ; bytes: Uint8Array; ref: string } {
  validateInput(input);
  const keep = skeepHash(input.skeep);
  const reflogProjection = byteProjection(input.observed.reflogBytes, 0);
  const value: PRepairQ = {
    v: 1,
    kind: "p-repair",
    lineageHash: input.lineageHash,
    repositoryIdentityHash: input.repositoryIdentityHash,
    p: {
      artifactRef: byteProjection(input.artifactRef, 384),
      artifactOid: input.artifactOid,
      payload: {
        v: 2,
        lineageHash: input.lineageHash,
        repositoryIdentityHash: input.repositoryIdentityHash,
        ref: byteProjection(input.pPayload.ref, 768),
        episode: input.pPayload.episode,
        priorOid: input.pPayload.priorOid,
        nextOid: input.pPayload.nextOid,
      },
      payloadBytes: input.payloadBytes.byteLength,
      payloadSha256: hashBytes(input.payloadBytes),
    },
    observed: {
      liveOid: input.observed.liveOid,
      baseOid: input.observed.baseOid,
      repoGen: input.observed.repoGen,
      stateRevision: input.observed.stateRevision,
      incomingKey: input.observed.incomingKey,
      reflog: {
        bytes: input.observed.reflogBytes.byteLength,
        entries: input.observed.reflogEntries,
        sha256: reflogProjection.sha256,
        top: input.observed.reflogTop === null ? null : byteProjection(input.observed.reflogTop, 2_048),
      },
    },
    preserved: { count: keep.count, oidsSha256: keep.oidsSha256 },
    repair: {
      at: input.at,
      reason: pRepairReason(input.mismatches),
      baseDisposition: pRepairBaseDisposition(input.pPayload.priorOid, input.pPayload.nextOid, input.observed.baseOid),
    },
  };
  const bytes = canonicalize(value);
  if (bytes.byteLength > MAX_P_REPAIR_Q_BYTES) throw new Error(`bounded P-repair Q exceeds ${MAX_P_REPAIR_Q_BYTES} bytes`);
  return { value, bytes, ref: pRepairQRef(input.lineageHash, input.pPayload.ref, input.pPayload.episode) };
}

/** Strict canonical reader used by receipt and on-disk Q validation. */
export function parsePRepairQ(bytes: Uint8Array): PRepairQ {
  if (bytes.byteLength > MAX_P_REPAIR_Q_BYTES) throw new Error("P-repair Q exceeds byte cap");
  const parsed = verifyRoundTrip(Buffer.from(bytes).toString("utf8")) as PRepairQ;
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1 || parsed.kind !== "p-repair") throw new Error("invalid P-repair Q schema");
  const exact = (value: unknown, keys: readonly string[]): boolean => !!value
    && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  const projection = (value: unknown, cap: number): value is ByteProjection => {
    if (!exact(value, ["bytes", "sha256", "prefixB64", "truncated"])) return false;
    const p = value as unknown as ByteProjection;
    if (!safeCounter(p.bytes) || !HEX64.test(p.sha256) || typeof p.prefixB64 !== "string"
      || typeof p.truncated !== "boolean" || p.truncated !== (p.bytes > cap)) return false;
    let prefix: Buffer;
    try { prefix = Buffer.from(p.prefixB64, "base64"); } catch { return false; }
    return prefix.toString("base64") === p.prefixB64 && prefix.byteLength === Math.min(p.bytes, cap);
  };
  if (!exact(parsed, ["v", "kind", "lineageHash", "repositoryIdentityHash", "p", "observed", "preserved", "repair"])
    || !exact(parsed.p, ["artifactRef", "artifactOid", "payload", "payloadBytes", "payloadSha256"])
    || !exact(parsed.p?.payload, ["v", "lineageHash", "repositoryIdentityHash", "ref", "episode", "priorOid", "nextOid"])
    || !exact(parsed.observed, ["liveOid", "baseOid", "repoGen", "stateRevision", "incomingKey", "reflog"])
    || !exact(parsed.observed?.reflog, ["bytes", "entries", "sha256", "top"])
    || !exact(parsed.preserved, ["count", "oidsSha256"])
    || !exact(parsed.repair, ["at", "reason", "baseDisposition"])) throw new Error("invalid P-repair Q closed schema");
  if (!HEX64.test(parsed.lineageHash) || !HEX64.test(parsed.repositoryIdentityHash)
    || !HEX40.test(parsed.p?.artifactOid) || !HEX32.test(parsed.p?.payload?.episode)
    || !HEX40.test(parsed.p?.payload?.nextOid) || !safeCounter(parsed.p?.payloadBytes)
    || !safeCounter(parsed.observed?.repoGen) || !safeCounter(parsed.observed?.stateRevision)
    || !safeCounter(parsed.observed?.reflog?.bytes) || !safeCounter(parsed.observed?.reflog?.entries)
    || !safeCounter(parsed.preserved?.count) || !HEX64.test(parsed.preserved?.oidsSha256)
    || !RFC3339_MS.test(parsed.repair?.at) || new Date(parsed.repair.at).toISOString() !== parsed.repair.at
    || parsed.p.payload.v !== 2 || parsed.p.payload.lineageHash !== parsed.lineageHash
    || parsed.p.payload.repositoryIdentityHash !== parsed.repositoryIdentityHash
    || (parsed.p.payload.priorOid !== null && !HEX40.test(parsed.p.payload.priorOid))
    || (parsed.observed.liveOid !== null && !HEX40.test(parsed.observed.liveOid))
    || (parsed.observed.baseOid !== null && !HEX40.test(parsed.observed.baseOid))
    || !(parsed.observed.incomingKey === null || typeof parsed.observed.incomingKey === "string")
    || !HEX64.test(parsed.p.payloadSha256) || !HEX64.test(parsed.observed.reflog.sha256)
    || !projection(parsed.p.artifactRef, 384) || !projection(parsed.p.payload.ref, 768)
    || !(parsed.observed.reflog.top === null || projection(parsed.observed.reflog.top, 2_048))
    || !(["live-mismatch", "reflog-mismatch", "base-shape-mismatch"] as unknown[]).includes(parsed.repair.reason)
    || !(["advance-prior-to-next", "already-next", "preserve-absent", "preserve-third"] as unknown[]).includes(parsed.repair.baseDisposition)) {
    throw new Error("invalid P-repair Q fields");
  }
  return parsed;
}

/** Exhaustive encoding of design 130's idempotent retry matrix. */
export function pRepairRetryAction(observation: PRepairRetryObservation): PRepairRetryAction {
  const { receipt, p, k, q, eviction } = observation;
  if (receipt === "wrong" || p === "wrong" || k === "partial-or-wrong" || q === "wrong"
    || eviction === "mixed-or-wrong" || !observation.originSetHashMatches
    || (q === "exact" && p === "exact")) return "artifact-contradiction-hold";

  if (receipt === "absent") {
    if (p === "exact" && k === "exact" && q === "absent") return "recompute";
    if (p === "absent" && k === "absent" && q === "exact" && observation.keepRefsExact
      && (eviction === "absent" || eviction === "null")) return "restore-terminal-bookkeeping";
    if (p === "absent" && q === "absent") return "corruption-hold";
    return "artifact-contradiction-hold";
  }

  if (q === "absent" && p === "exact" && k === "exact") {
    if (!observation.keepRefsExact || (eviction !== "present-exact" && eviction !== "null")) {
      return "artifact-contradiction-hold";
    }
    return observation.liveReflogMatchesReceipt ? "resume-ref-commit" : "refresh-receipt";
  }
  if (q === "exact" && p === "absent" && k === "absent" && observation.keepRefsExact
    && (eviction === "absent" || eviction === "null")) return "compact-and-restart";
  if (q === "absent" && p === "absent") return "corruption-hold";
  return "artifact-contradiction-hold";
}

/** Freeze the deterministic 257th-record victim before the state CAS. */
export function pRepairEviction(
  lineageHash: string,
  incomingQRef: string,
  entries: readonly PRepairQEntry[],
): PRepairReceipt["eviction"] {
  if (!HEX64.test(lineageHash)) throw new Error("invalid Q eviction lineage");
  const prefix = `${P_REPAIR_Q_PREFIX}/${lineageHash}/`;
  const active = entries.filter((entry) => {
    if (!entry.ref.startsWith(prefix) || entry.value.lineageHash !== lineageHash || !HEX40.test(entry.targetOid)) {
      throw new Error("foreign or malformed Q in active-lineage enumeration");
    }
    return entry.ref !== incomingQRef;
  });
  if (active.length > MAX_P_REPAIR_Q_PER_LINEAGE) throw new Error("active-lineage Q cap already exceeded");
  if (active.length < MAX_P_REPAIR_Q_PER_LINEAGE) return null;
  const oldest = [...active].sort((left, right) => {
    const time = left.value.repair.at.localeCompare(right.value.repair.at);
    return time || Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref));
  })[0]!;
  return { qRef: oldest.ref, targetOid: oldest.targetOid };
}

export function buildPRepairReceipt(input: Omit<PRepairReceipt, "v" | "kind" | "origin" | "skeep" | "reflog" | "baseDisposition">
  & { skeep: readonly string[]; reflogBytes: Uint8Array }): PRepairReceipt {
  const keep = skeepHash(input.skeep);
  if (input.q.ref !== pRepairQRef(input.lineageHash, Buffer.from(input.q.value.p.payload.ref.prefixB64, "base64"), input.episode)
    && !input.q.value.p.payload.ref.truncated) throw new Error("receipt Q ref mismatch");
  if (input.q.value.lineageHash !== input.lineageHash
    || input.q.value.repositoryIdentityHash !== input.repositoryIdentityHash
    || input.q.value.p.payload.episode !== input.episode || input.q.value.p.artifactOid !== input.p.targetOid
    || input.q.value.preserved.count !== keep.count || input.q.value.preserved.oidsSha256 !== keep.oidsSha256) {
    throw new Error("receipt binding mismatch");
  }
  return {
    v: 1,
    kind: "p-repaired",
    lineageHash: input.lineageHash,
    repositoryIdentityHash: input.repositoryIdentityHash,
    ref: input.ref,
    episode: input.episode,
    p: input.p,
    k: [...input.k].sort((a, b) => Buffer.compare(Buffer.from(a.ref), Buffer.from(b.ref))),
    q: input.q,
    origin: { ref: input.q.ref, episode: input.episode, class: "human" },
    skeep: { count: keep.count, oidsSha256: keep.oidsSha256 },
    reflog: { bytes: input.reflogBytes.byteLength, sha256: hashBytes(input.reflogBytes) },
    baseDisposition: input.q.value.repair.baseDisposition,
    eviction: input.eviction,
  };
}

/** Strict state-side receipt reader. Q is re-canonicalized through its own
 * closed reader so an accepted receipt can safely recreate an unreferenced blob. */
export function parsePRepairReceipt(value: unknown): PRepairReceipt {
  const keys = (candidate: unknown, expected: readonly string[]): boolean => !!candidate
    && typeof candidate === "object" && !Array.isArray(candidate)
    && Object.keys(candidate).sort().join("\0") === [...expected].sort().join("\0");
  if (!keys(value, ["v", "kind", "lineageHash", "repositoryIdentityHash", "ref", "episode", "p", "k", "q", "origin", "skeep", "reflog", "baseDisposition", "eviction"])) {
    throw new Error("invalid P-repair receipt closed schema");
  }
  const receipt = value as unknown as PRepairReceipt;
  if (receipt.v !== 1 || receipt.kind !== "p-repaired" || !HEX64.test(receipt.lineageHash)
    || !HEX64.test(receipt.repositoryIdentityHash) || typeof receipt.ref !== "string"
    || !HEX32.test(receipt.episode) || !keys(receipt.p, ["ref", "targetOid"])
    || typeof receipt.p.ref !== "string" || !HEX40.test(receipt.p.targetOid)
    || !Array.isArray(receipt.k) || receipt.k.some((entry) => !keys(entry, ["ref", "targetOid"])
      || typeof entry.ref !== "string" || !HEX40.test(entry.targetOid))
    || !keys(receipt.q, ["ref", "targetOid", "value"]) || typeof receipt.q.ref !== "string"
    || !HEX40.test(receipt.q.targetOid) || !keys(receipt.origin, ["ref", "episode", "class"])
    || receipt.origin.ref !== receipt.q.ref || receipt.origin.episode !== receipt.episode || receipt.origin.class !== "human"
    || !keys(receipt.skeep, ["count", "oidsSha256"]) || !safeCounter(receipt.skeep.count)
    || !HEX64.test(receipt.skeep.oidsSha256) || !keys(receipt.reflog, ["bytes", "sha256"])
    || !safeCounter(receipt.reflog.bytes) || !HEX64.test(receipt.reflog.sha256)
    || !(receipt.eviction === null || (keys(receipt.eviction, ["qRef", "targetOid"])
      && typeof receipt.eviction.qRef === "string" && HEX40.test(receipt.eviction.targetOid)))) {
    throw new Error("invalid P-repair receipt fields");
  }
  const q = parsePRepairQ(canonicalize(receipt.q.value));
  const artifactRef = Buffer.from(q.p.artifactRef.prefixB64, "base64").toString("utf8");
  const artifactMatch = q.p.artifactRef.truncated ? undefined
    : /^refs\/rbox-local\/base-present\/v2\/([0-9a-f]{64})\/([0-9a-f]{64})$/.exec(artifactRef);
  const qMatch = /^refs\/rbox-recovery\/base-present\/v2\/([0-9a-f]{64})\/([0-9a-f]{64})\/([0-9a-f]{32})$/.exec(receipt.q.ref);
  const receiptRefProjection = byteProjection(receipt.ref, 768);
  const mismatch = [
    [!artifactMatch, "artifact-ref"], [!qMatch, "q-ref"], [receipt.p.ref !== artifactRef, "p-ref"],
    [artifactMatch?.[1] !== receipt.lineageHash, "artifact-lineage"], [qMatch?.[1] !== receipt.lineageHash, "q-lineage"],
    [qMatch?.[2] !== artifactMatch?.[2], "branch-hash"], [qMatch?.[3] !== receipt.episode, "q-episode"],
    [q.p.payload.ref.bytes !== receiptRefProjection.bytes || q.p.payload.ref.sha256 !== receiptRefProjection.sha256
      || q.p.payload.ref.prefixB64 !== receiptRefProjection.prefixB64 || q.p.payload.ref.truncated !== receiptRefProjection.truncated, "ref-projection"],
    [q.lineageHash !== receipt.lineageHash, "value-lineage"],
    [q.repositoryIdentityHash !== receipt.repositoryIdentityHash, "value-repository"],
    [q.p.artifactOid !== receipt.p.targetOid, "p-target"], [q.p.payload.episode !== receipt.episode, "payload-episode"],
    [q.preserved.count !== receipt.skeep.count, "skeep-count"],
    [q.preserved.oidsSha256 !== receipt.skeep.oidsSha256, "skeep-hash"],
    [q.observed.reflog.bytes !== receipt.reflog.bytes, "reflog-bytes"],
    [q.observed.reflog.sha256 !== receipt.reflog.sha256, "reflog-hash"],
    [q.repair.baseDisposition !== receipt.baseDisposition, "base-disposition"],
  ].find(([failed]) => failed)?.[1];
  if (mismatch) throw new Error(`P-repair receipt binding mismatch: ${mismatch}`);
  return receipt;
}
