/** Never: tombstone authorization, checkout mutation, or inventing BASE authority outside the composer-backed state port. */
import { hashBytes } from "../../engine/hash.js";
import { canonicalize } from "../../engine/e2ee/jcs.js";
import { basePresentKeepRef, type BasePresentPayload, type PreparedProtocolRef } from "./base-artifacts.js";
import {
  mergeRepairOrigins,
  pinRepairObjectsFirst,
  readKeepPinOrigins,
  readRefReflogFingerprint,
  prepareRepairOriginCleanup,
  repairOriginOids,
  runPreparedUpdateRefTransaction,
  verifyRepairKeepRefs,
} from "./keep-pins.js";
import {
  buildPRepairQ,
  buildPRepairReceipt,
  pRepairEviction,
  pRepairRetryAction,
  parsePRepairReceipt,
  parsePRepairQ,
  skeepHash,
  type PRepairQEntry,
  type PRepairReceipt,
  type PRepairRetryAction,
  type PRepairRetryObservation,
} from "./p-repair.js";
import { HEX40, ZERO_OID } from "./git-state.js";
import { git, gitRaw } from "../../engine/git-spawn.js";
import { withProtocolLockClass, withRepoOperationLock, withRepoProtocolLocks } from "./protocol-locks.js";

export interface PRepairStateSnapshot {
  repoGen: number;
  stateRevision: number;
  incomingKey: string | null;
  baseOid: string | null;
}

/** Facts observed inside the prepared P→Q ref transaction. Possession of this
 * value means artifact validation and pin verification both completed while
 * the live branch and reflog were locked. */
export interface PRepairLockedObservation {
  liveOid: string | null;
  reflogSha256: string;
  artifactsValidated: true;
  keepRefsVerified: true;
}

export interface PRepairStatePort {
  readonly stateLockIdentity: string;
  read(): Promise<PRepairStateSnapshot>;
  /** Must generation-CAS only BASE's selected member and the P-bound receipt,
   * routing the BASE mutation through the mandatory composer. */
  cas(input: {
    expected: PRepairStateSnapshot;
    nextBaseOid: string | null;
    receipt: PRepairReceipt;
    lockedObservation: PRepairLockedObservation;
  }): Promise<"accepted" | "rejected">;
  /** Accepted-receipt/live-change row: generation-CAS only the receipt. */
  replaceReceipt?(input: { expected: PRepairStateSnapshot; prior: PRepairReceipt; next: PRepairReceipt }): Promise<"accepted" | "rejected">;
  /** Terminal Q-exact row: remove only the matching receipt. */
  compactReceipt?(input: { expected: PRepairStateSnapshot; receipt: PRepairReceipt }): Promise<"accepted" | "rejected">;
  /** Old-writer Q terminal row: restore bounded bookkeeping, preserving BASE. */
  restoreReceipt?(input: { expected: PRepairStateSnapshot; receipt: PRepairReceipt }): Promise<"accepted" | "rejected">;
}

export interface PRepairAttemptInput {
  repoDir: string;
  p: PreparedProtocolRef<BasePresentPayload>;
  state: PRepairStatePort;
  repairAt: string;
  mismatches: { live: boolean; reflog: boolean; "baseShape": boolean };
  /** Locked A/R/P/K and binding validation. False and errors are hard holds. */
  validateArtifacts(): Promise<boolean>;
  crashAt?(point: PRepairCrashPoint): void | Promise<void>;
}

export type PRepairCrashPoint =
  | "after-pin-only"
  | "after-origin-fsync"
  | "after-q-write"
  | "after-ref-prepare"
  | "after-state-cas"
  | "after-ref-commit"
  | "before-restart";

export type PRepairAttemptResult =
  | { status: "restart"; receipt: PRepairReceipt; discard: "plan-attestations-snapshots" }
  | { status: "retry"; reason: "observation-moved" | "state-cas-rejected" }
  | { status: "hold"; reason: string };

export type PRepairResumeResult =
  | { status: "restart"; receipt: PRepairReceipt; discard: "plan-attestations-snapshots" }
  | { status: "refresh-receipt" }
  | { status: "hold"; reason: string };

/** Bound hostile ref/reflog churn while operation, reflog, and origin locks are
 * held. Exhaustion returns before state composition or P/K retirement. */
export const MAX_P_REPAIR_STABILIZATION_ATTEMPTS = 8;

class PRepairRetryError extends Error {
  constructor(readonly retryReason: Extract<PRepairAttemptResult, { status: "retry" }>["reason"], message: string) {
    super(message);
    this.name = "PRepairRetryError";
  }
}

class PRepairObservationMovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PRepairObservationMovedError";
  }
}

export interface PRepairObservation {
  liveOid: string | null;
  reflogBytes: Buffer;
  reflogEntries: number;
  reflogTop: Buffer | null;
  sobs: string[];
  sprior: string[];
  skeep: string[];
}

const compareRef = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));

/** Decode every non-zero old/new object id from the complete reflog bytes. */
export function reflogObservation(bytes: Uint8Array) {
  const lines = Buffer.from(bytes).toString("latin1").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const oids = new Set<string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) /.exec(line);
    if (!match) throw new Error("malformed complete branch reflog");
    for (const oid of [match[1]!, match[2]!]) if (oid !== ZERO_OID) oids.add(oid);
  }
  return {
    entries: lines.length,
    top: lines.length === 0 ? null : Buffer.from(lines.at(-1)!, "latin1"),
    oids: [...oids].sort(),
  };
}

async function directLiveOid(repoDir: string, ref: string): Promise<string | null> {
  const symbolic = await git(repoDir, ["symbolic-ref", "-q", ref]).catch(() => "");
  if (symbolic) throw new Error("P branch became symbolic");
  const oid = await git(repoDir, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
  if (!oid) return null;
  if (!HEX40.test(oid)) throw new Error("P branch target is not an object id");
  return oid;
}

async function protocolRefTarget(repoDir: string, ref: string): Promise<{ kind: "absent" } | { kind: "direct"; oid: string } | { kind: "wrong" }> {
  const symbolic = await git(repoDir, ["symbolic-ref", "-q", ref]).catch(() => "");
  if (symbolic) return { kind: "wrong" };
  const oid = await git(repoDir, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
  if (!oid) return { kind: "absent" };
  return HEX40.test(oid) ? { kind: "direct", oid } : { kind: "wrong" };
}

export async function observePRepair(
  repoDir: string,
  payload: BasePresentPayload,
  qRef: string,
): Promise<PRepairObservation> {
  const liveOid = await directLiveOid(repoDir, payload.ref);
  const reflogBytes = (await readRefReflogFingerprint(repoDir, payload.ref)).bytes;
  const reflog = reflogObservation(reflogBytes);
  const origins = await readKeepPinOrigins(repoDir);
  const sprior = repairOriginOids(origins, qRef, payload.episode);
  const sobs = [...new Set([
    ...(payload.priorOid ? [payload.priorOid] : []),
    payload.nextOid,
    ...(liveOid ? [liveOid] : []),
    ...reflog.oids,
  ])].sort();
  const skeep = [...new Set([...sobs, ...sprior])].sort();
  for (const oid of skeep) await git(repoDir, ["cat-file", "-e", `${oid}^{object}`]);
  return { liveOid, reflogBytes, reflogEntries: reflog.entries, reflogTop: reflog.top, sobs, sprior, skeep };
}

function sameObservation(left: PRepairObservation, right: PRepairObservation): boolean {
  return left.liveOid === right.liveOid && left.reflogBytes.equals(right.reflogBytes)
    && left.sobs.join("\0") === right.sobs.join("\0") && left.skeep.join("\0") === right.skeep.join("\0");
}

async function writeQBlob(repoDir: string, bytes: Uint8Array): Promise<string> {
  return withRepoOperationLock(repoDir, async () => {
    const oid = (await gitRaw(repoDir, ["hash-object", "-w", "--stdin"], { stdin: Buffer.from(bytes).toString("utf8") })).trim();
    if (!HEX40.test(oid)) throw new Error("Git returned invalid Q blob OID");
    return oid;
  });
}

export async function enumeratePRepairQ(repoDir: string, lineageHash: string): Promise<PRepairQEntry[]> {
  const prefix = `refs/rbox-recovery/base-present/v2/${lineageHash}`;
  const listed = await git(repoDir, ["for-each-ref", "--format=%(refname) %(objectname) %(objecttype)", prefix]);
  const entries: PRepairQEntry[] = [];
  for (const line of listed.split("\n").filter(Boolean)) {
    const match = /^(\S+) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match || match[3] !== "blob" || !match[1]!.startsWith(`${prefix}/`)) throw new Error("malformed active-lineage Q ref");
    const bytes = Buffer.from(await gitRaw(repoDir, ["cat-file", "blob", match[2]!]), "utf8");
    const value = parsePRepairQ(bytes);
    const namespace = new RegExp(`^refs/rbox-recovery/base-present/v2/${lineageHash}/([0-9a-f]{64})/([0-9a-f]{32})$`).exec(match[1]!);
    const artifactRef = value.p.artifactRef.truncated ? "" : Buffer.from(value.p.artifactRef.prefixB64, "base64").toString("utf8");
    const artifact = new RegExp(`^refs/rbox-local/base-present/v2/${lineageHash}/([0-9a-f]{64})$`).exec(artifactRef);
    if (!namespace || !artifact || namespace[1] !== artifact[1] || namespace[2] !== value.p.payload.episode
      || value.lineageHash !== lineageHash) throw new Error("Q namespace/value binding mismatch");
    entries.push({ ref: match[1]!, targetOid: match[2]!, value });
  }
  return entries.sort((a, b) => compareRef(a.ref, b.ref));
}

/** Inspect every durable retry binding under the protocol locks. Indeterminate
 * reads throw and therefore become a caller hard-hold, never a permissive row. */
export async function inspectPRepairReceipt(
  repoDir: string,
  candidate: PRepairReceipt,
): Promise<{ observation: PRepairRetryObservation; action: PRepairRetryAction }> {
  const receipt = parsePRepairReceipt(candidate);
  const [p, q, ...keeps] = await Promise.all([
    protocolRefTarget(repoDir, receipt.p.ref),
    protocolRefTarget(repoDir, receipt.q.ref),
    ...receipt.k.map((entry) => protocolRefTarget(repoDir, entry.ref)),
  ]);
  const pState: PRepairRetryObservation["p"] = p.kind === "absent" ? "absent"
    : p.kind === "direct" && p.oid === receipt.p.targetOid ? "exact" : "wrong";
  const qState: PRepairRetryObservation["q"] = q.kind === "absent" ? "absent"
    : q.kind === "direct" && q.oid === receipt.q.targetOid ? "exact" : "wrong";
  const exactK = keeps.every((entry, index) => entry.kind === "direct" && entry.oid === receipt.k[index]!.targetOid);
  const absentK = keeps.every((entry) => entry.kind === "absent");
  const kState: PRepairRetryObservation["k"] = exactK ? "exact" : absentK ? "absent" : "partial-or-wrong";
  if (qState === "exact") {
    const diskQ = parsePRepairQ(Buffer.from(await gitRaw(repoDir, ["cat-file", "blob", receipt.q.targetOid]), "utf8"));
    if (!Buffer.from(canonicalize(diskQ)).equals(Buffer.from(canonicalize(receipt.q.value)))) throw new Error("receipt Q value mismatch");
  }
  const origins = await readKeepPinOrigins(repoDir);
  const skeep = repairOriginOids(origins, receipt.q.ref, receipt.episode);
  const keep = skeepHash(skeep);
  const originSetHashMatches = keep.count === receipt.skeep.count && keep.oidsSha256 === receipt.skeep.oidsSha256;
  const keepRefsExact = originSetHashMatches && await verifyRepairKeepRefs(repoDir, skeep);
  const payload = receipt.q.value.p.payload;
  const observed = await observePRepair(repoDir, {
    v: 2, lineageHash: receipt.lineageHash, repositoryIdentityHash: receipt.repositoryIdentityHash,
    ref: receipt.ref, episode: receipt.episode, priorOid: payload.priorOid, nextOid: payload.nextOid,
  }, receipt.q.ref);
  const liveReflogMatchesReceipt = observed.liveOid === receipt.q.value.observed.liveOid
    && observed.reflogBytes.byteLength === receipt.reflog.bytes && hashBytes(observed.reflogBytes) === receipt.reflog.sha256;
  let eviction: PRepairRetryObservation["eviction"] = "null";
  if (receipt.eviction) {
    const victim = await protocolRefTarget(repoDir, receipt.eviction.qRef);
    eviction = victim.kind === "absent" ? "absent"
      : victim.kind === "direct" && victim.oid === receipt.eviction.targetOid ? "present-exact" : "mixed-or-wrong";
  }
  const observation: PRepairRetryObservation = {
    receipt: "matching", p: pState, k: kState, q: qState,
    keepRefsExact, originSetHashMatches, liveReflogMatchesReceipt, eviction,
  };
  return { observation, action: pRepairRetryAction(observation) };
}

export function inspectLockedPRepairReceipt(repoDir: string, receipt: PRepairReceipt): Promise<{ observation: PRepairRetryObservation; action: PRepairRetryAction }> {
  return withRepoProtocolLocks(repoDir, { reflogRefs: [receipt.ref], origins: true }, () => inspectPRepairReceipt(repoDir, receipt));
}

/** Retired-lineage cleanup: first expected-target-delete only that strict Q
 * prefix, then filter only its valid repair origins, finally compare-delete pins
 * that have no remaining origin of either class. Crashes leave over-protection. */
async function cleanupPRepairLineageUnlocked(repoDir: string, lineageHash: string): Promise<{ qDeleted: number; originsRemoved: number }> {
  const entries = await enumeratePRepairQ(repoDir, lineageHash);
  await runPreparedUpdateRefTransaction(repoDir,
    entries.map((entry) => `delete ${entry.ref} ${entry.targetOid}`).sort((a, b) => compareRef(a.split(" ")[1]!, b.split(" ")[1]!)),
    async () => {
      const locked = await enumeratePRepairQ(repoDir, lineageHash);
      if (JSON.stringify(locked.map(({ ref, targetOid }) => ({ ref, targetOid })))
        !== JSON.stringify(entries.map(({ ref, targetOid }) => ({ ref, targetOid })))) throw new Error("lineage Q set moved");
    });
  const cleanup = await prepareRepairOriginCleanup(repoDir, lineageHash);
  await runPreparedUpdateRefTransaction(repoDir, cleanup.transactionLines, async () => {});
  return { qDeleted: entries.length, originsRemoved: cleanup.removedOrigins };
}

export function cleanupPRepairLineage(repoDir: string, lineageHash: string): Promise<{ qDeleted: number; originsRemoved: number }> {
  return withRepoProtocolLocks(repoDir, { origins: true }, () => cleanupPRepairLineageUnlocked(repoDir, lineageHash));
}

export const cleanupLockedPRepairLineage = cleanupPRepairLineage;

function disposedBase(payload: BasePresentPayload, current: string | null): string | null {
  if (current === payload.priorOid || current === payload.nextOid) return payload.nextOid;
  return current;
}

function finalLines(receipt: PRepairReceipt, skeep: readonly string[]): string[] {
  const lines = [
    `verify ${receipt.ref} ${receipt.q.value.observed.liveOid ?? ZERO_OID}`,
    `create ${receipt.q.ref} ${receipt.q.targetOid}`,
    ...skeep.map((oid) => `verify refs/rbox-local/keep/${oid} ${oid}`),
    `delete ${receipt.p.ref} ${receipt.p.targetOid}`,
    ...receipt.k.map((keep) => `delete ${keep.ref} ${keep.targetOid}`),
    ...(receipt.eviction ? [`delete ${receipt.eviction.qRef} ${receipt.eviction.targetOid}`] : []),
  ];
  return lines.sort((a, b) => compareRef(a.split(" ")[1]!, b.split(" ")[1]!));
}

/** One no-receipt P-repair attempt. Lock classes 1-5 are owned by the caller;
 * this function performs the class-6 pin-only and final prepared transactions.
 * A successful return is a typed mandatory restart, never deletion authority. */
export async function runPRepairAttempt(input: PRepairAttemptInput): Promise<PRepairAttemptResult> {
  try {
    if (!(await input.validateArtifacts())) return { status: "hold", reason: "A/R/P/K validation failed" };
    const payload = input.p.payload;
    const provisional = buildPRepairQ({
      lineageHash: payload.lineageHash,
      repositoryIdentityHash: payload.repositoryIdentityHash,
      artifactRef: input.p.ref,
      artifactOid: input.p.targetOid,
      pPayload: payload,
      payloadBytes: input.p.payloadBytes,
      observed: { liveOid: null, baseOid: null, repoGen: 0, stateRevision: 0, incomingKey: null, reflogBytes: Buffer.alloc(0), reflogEntries: 0, reflogTop: null },
      skeep: [payload.nextOid, ...(payload.priorOid ? [payload.priorOid] : [])],
      at: input.repairAt,
      mismatches: input.mismatches,
    });

    let stable: PRepairObservation | undefined;
    for (let attempt = 0; attempt < MAX_P_REPAIR_STABILIZATION_ATTEMPTS; attempt++) {
      const before = await observePRepair(input.repoDir, payload, provisional.ref);
      await pinRepairObjectsFirst(input.repoDir, before.skeep);
      await input.crashAt?.("after-pin-only");
      await mergeRepairOrigins(input.repoDir, before.skeep, provisional.ref, payload.episode, input.repairAt);
      await input.crashAt?.("after-origin-fsync");
      const after = await observePRepair(input.repoDir, payload, provisional.ref);
      if (sameObservation(before, after)) { stable = after; break; }
    }
    if (!stable) {
      return {
        status: "hold",
        reason: `P-repair observation did not stabilize after ${MAX_P_REPAIR_STABILIZATION_ATTEMPTS} attempts`,
      };
    }

    const state = await input.state.read();
    const built = buildPRepairQ({
      lineageHash: payload.lineageHash,
      repositoryIdentityHash: payload.repositoryIdentityHash,
      artifactRef: input.p.ref,
      artifactOid: input.p.targetOid,
      pPayload: payload,
      payloadBytes: input.p.payloadBytes,
      observed: { ...state, liveOid: stable.liveOid, reflogBytes: stable.reflogBytes, reflogEntries: stable.reflogEntries, reflogTop: stable.reflogTop },
      skeep: stable.skeep,
      at: input.repairAt,
      mismatches: input.mismatches,
    });
    const qTarget = await writeQBlob(input.repoDir, built.bytes);
    await input.crashAt?.("after-q-write");
    const eviction = pRepairEviction(payload.lineageHash, built.ref, await enumeratePRepairQ(input.repoDir, payload.lineageHash));
    const k = [
      ...(payload.priorOid ? [{ ref: basePresentKeepRef(payload, payload.ref, payload.episode, "prior"), targetOid: payload.priorOid }] : []),
      { ref: basePresentKeepRef(payload, payload.ref, payload.episode, "next"), targetOid: payload.nextOid },
    ];
    const receipt = buildPRepairReceipt({
      lineageHash: payload.lineageHash,
      repositoryIdentityHash: payload.repositoryIdentityHash,
      ref: payload.ref,
      episode: payload.episode,
      p: { ref: input.p.ref, targetOid: input.p.targetOid },
      k,
      q: { ref: built.ref, targetOid: qTarget, value: built.value },
      skeep: stable.skeep,
      reflogBytes: stable.reflogBytes,
      eviction,
    });

    await runPreparedUpdateRefTransaction(input.repoDir, finalLines(receipt, stable.skeep), async () => {
      await input.crashAt?.("after-ref-prepare");
      if (!(await input.validateArtifacts())) throw new PRepairRetryError("observation-moved", "P-repair artifact proof moved");
      const locked = await observePRepair(input.repoDir, payload, built.ref);
      const keepRefsVerified = await verifyRepairKeepRefs(input.repoDir, stable!.skeep);
      if (!sameObservation(stable!, locked) || !keepRefsVerified
        || skeepHash(locked.skeep).oidsSha256 !== receipt.skeep.oidsSha256) {
        throw new PRepairRetryError("observation-moved", "P-repair observation moved");
      }
      const accepted = await withProtocolLockClass("state", input.state.stateLockIdentity, () =>
        input.state.cas({
          expected: state,
          nextBaseOid: disposedBase(payload, state.baseOid),
          receipt,
          lockedObservation: {
            liveOid: locked.liveOid,
            reflogSha256: hashBytes(locked.reflogBytes),
            artifactsValidated: true,
            keepRefsVerified: true,
          },
        }));
      if (accepted !== "accepted") throw new PRepairRetryError("state-cas-rejected", "P-repair state CAS rejected");
      await input.crashAt?.("after-state-cas");
    }, { reflogMessage: `rbox p-repair ${payload.episode}` });
    await input.crashAt?.("after-ref-commit");
    await input.crashAt?.("before-restart");
    return { status: "restart", receipt, discard: "plan-attestations-snapshots" };
  } catch (error) {
    if (error instanceof PRepairRetryError) return { status: "retry", reason: error.retryReason };
    return { status: "hold", reason: String(error) };
  }
}

/** Acquire the durable operation→reflog→origin prefix. Workspace and chain are
 * intentionally owned by the sync caller, before entering this wrapper. */
export function runLockedPRepairAttempt(input: PRepairAttemptInput): Promise<PRepairAttemptResult> {
  return withRepoProtocolLocks(input.repoDir, { reflogRefs: [input.p.payload.ref], origins: true }, () => runPRepairAttempt(input));
}

/** Changed-live/reflog retry after an accepted receipt. BASE is already durable;
 * this adapter generation-CAS replaces only the receipt. */
export function refreshAcceptedPRepair(input: PRepairAttemptInput & { acceptedReceipt: PRepairReceipt }): Promise<PRepairAttemptResult> {
  if (!input.state.replaceReceipt) return Promise.resolve({ status: "hold", reason: "receipt-only CAS unavailable" });
  const state: PRepairStatePort = {
    stateLockIdentity: input.state.stateLockIdentity,
    read: () => input.state.read(),
    cas: ({ expected, receipt }) => input.state.replaceReceipt!({ expected, prior: input.acceptedReceipt, next: receipt }),
  };
  return runPRepairAttempt({ ...input, state });
}

export function refreshLockedAcceptedPRepair(input: PRepairAttemptInput & { acceptedReceipt: PRepairReceipt }): Promise<PRepairAttemptResult> {
  return withRepoProtocolLocks(input.repoDir, { reflogRefs: [input.p.payload.ref], origins: true }, () => refreshAcceptedPRepair(input));
}

export async function persistPRepairTerminal(
  state: PRepairStatePort,
  mode: "compact" | "restore",
  expected: PRepairStateSnapshot,
  receipt: PRepairReceipt,
): Promise<"accepted" | "rejected"> {
  const mutate = mode === "compact" ? state.compactReceipt : state.restoreReceipt;
  if (!mutate) return "rejected";
  return withProtocolLockClass("state", state.stateLockIdentity, () => mutate.call(state, { expected, receipt }));
}

/** Resume the accepted-receipt/state-CAS-success/ref-commit-crash row without
 * recomposing BASE or changing forensic time. */
export async function resumeAcceptedPRepair(input: {
  repoDir: string;
  receipt: PRepairReceipt;
  validateArtifacts(): Promise<boolean>;
}): Promise<PRepairResumeResult> {
  try {
    const receipt = parsePRepairReceipt(input.receipt);
    if (!(await input.validateArtifacts())) return { status: "hold", reason: "accepted receipt P/K proof mismatch" };
    const qExisting = await git(input.repoDir, ["rev-parse", "--verify", "--quiet", receipt.q.ref]).catch(() => "");
    if (qExisting) return { status: "hold", reason: "accepted receipt Q/P coexistence" };
    if (receipt.eviction) {
      const victim = await git(input.repoDir, ["rev-parse", "--verify", "--quiet", receipt.eviction.qRef]).catch(() => "");
      if (victim !== receipt.eviction.targetOid) return { status: "hold", reason: "accepted receipt eviction victim mismatch" };
    }
    const payload = receipt.q.value.p.payload;
    const observed = await observePRepair(input.repoDir, {
      v: 2,
      lineageHash: receipt.lineageHash,
      repositoryIdentityHash: receipt.repositoryIdentityHash,
      ref: receipt.ref,
      episode: receipt.episode,
      priorOid: payload.priorOid,
      nextOid: payload.nextOid,
    }, receipt.q.ref);
    if (observed.liveOid !== receipt.q.value.observed.liveOid
      || observed.reflogBytes.byteLength !== receipt.reflog.bytes
      || hashBytes(observed.reflogBytes) !== receipt.reflog.sha256) return { status: "refresh-receipt" };
    const keep = skeepHash(observed.skeep);
    if (keep.count !== receipt.skeep.count || keep.oidsSha256 !== receipt.skeep.oidsSha256
      || !(await verifyRepairKeepRefs(input.repoDir, observed.skeep))) {
      return { status: "hold", reason: "accepted receipt Skeep/origin proof mismatch" };
    }
    const qTarget = await writeQBlob(input.repoDir, canonicalize(receipt.q.value));
    if (qTarget !== receipt.q.targetOid) return { status: "hold", reason: "accepted receipt Q target mismatch" };
    await runPreparedUpdateRefTransaction(input.repoDir, finalLines(receipt, observed.skeep), async () => {
      if (!(await input.validateArtifacts())) throw new Error("accepted receipt P/K proof moved");
      const locked = await observePRepair(input.repoDir, {
        v: 2,
        lineageHash: receipt.lineageHash,
        repositoryIdentityHash: receipt.repositoryIdentityHash,
        ref: receipt.ref,
        episode: receipt.episode,
        priorOid: payload.priorOid,
        nextOid: payload.nextOid,
      }, receipt.q.ref);
      if (!sameObservation(observed, locked) || !(await verifyRepairKeepRefs(input.repoDir, locked.skeep))) {
        throw new PRepairObservationMovedError("accepted receipt observation moved");
      }
    }, { reflogMessage: `rbox p-repair ${receipt.episode}` });
    return { status: "restart", receipt, discard: "plan-attestations-snapshots" };
  } catch (error) {
    if (error instanceof PRepairObservationMovedError) return { status: "refresh-receipt" };
    return { status: "hold", reason: String(error) };
  }
}


export function resumeLockedAcceptedPRepair(input: {
  repoDir: string;
  receipt: PRepairReceipt;
  validateArtifacts(): Promise<boolean>;
}): Promise<PRepairResumeResult> {
  return withRepoProtocolLocks(input.repoDir, { reflogRefs: [input.receipt.ref], origins: true }, () => resumeAcceptedPRepair(input));
}
