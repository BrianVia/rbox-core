import {
  MAX_GIT_REPOS,
  readManifestChain,
  validateGitRepos,
  type GitSection,
  type Manifest,
} from "../engine/index.js";
import type { AcquireLockOptions, OwnedLock } from "../engine/git/lockfile.js";
import type { ConfigStatToken } from "../engine/git/config-txn.js";
import { sanitizeGitSectionForPersistence } from "../engine/git/config-sync.js";
import type { PRepairReceipt } from "../engine/git/p-repair.js";
import {
  carryRepoBaseProof,
  composeRepoBase,
  migrationRepoBaseProof,
  recordOriginLineage,
  type BranchBaseOrigin,
  type RepoBaseProof,
  type SafeRefWitness,
} from "./sync-git/base-composer.js";

/** Last point this device and the server agreed on — the reconcile base.
 *  The three `git*` maps are LOCAL-ONLY (design 43 §11): they never ride a manifest
 *  or leave this machine — they are this device's memory of per-repo sync posture. */
export interface SyncState {
  /** The manifest STREAM this baseline belongs to (see {@link syncStreamId}). A
   *  baseline is only meaningful against the stream it was built from: reconciling
   *  stream B against a baseline from stream A reads every A-only file as "remotely
   *  deleted" — a mass local delete (the 2026-07-01 rebind incident). loadState
   *  treats a mismatch as NO baseline. The full identity matters: the server keys
   *  manifests by (workspace, project), and different remotes are different worlds —
   *  workspace id alone would let a --project rebind poison the reconcile. */
  stream: string;
  lastSyncedSequence: number;
  lastSyncedManifest: Manifest;
  manifestMeta?: GlobalManifestMeta;
  /** Removal memories (design 43 §9 [v2, B4]): relPath → the LOCAL identity key at the
   *  moment the remote deleted the repo. A leftover local repo whose identity still
   *  equals the memory is not re-added by push (it's the untouched leftover) and is
   *  treated as ABSENT (clean materialization target) by pull. Pruned when the local
   *  `.git` disappears or the repo is re-added. */
  gitReposRemoved?: Record<string, string>;
  /** Conflict suppressions (design 43 §7 [v2, M2]): relPath → the conflict-time LOCAL
   *  identity key. Capture carries the checkpointed base (never republishes the
   *  conflicted local state) until the local identity CHANGES from this value. */
  gitNeedsResolution?: Record<string, string>;
  /** Unapplied remote sections (design 43 §7 [v5]): relPath → the remote GitSection a
   *  pull could not apply (ownership block, receiver busy, decrypt failure, …). While
   *  pending: outbound pushes CARRY this section (the newest known truth), capture is
   *  suppressed, and each pull retries the apply. Cleared on successful apply or when
   *  the remote deletes the repo ([v6] absence supersedes pending). */
  gitPendingRemote?: Record<string, GitSection>;
  /** Legacy/degraded-mode local sidecars. Transactional states keep these in
   * repoRecords; nonce-less states cannot, so they retain the same typed truth
   * in bounded per-repo maps instead. These fields are local state, never wire. */
  gitDeferrals?: Record<string, GitDeferrals>;
  gitPartial?: Record<string, GitPartialApply>;
  /** Random state-file incarnation. A delayed packet from before a reset/rebind
   * cannot land even when the stream later changes A→B→A. */
  stateNonce?: string;
  /** Monotonic whole-state write revision (diagnostic/defense-in-depth only). */
  stateRevision?: number;
  /** Opaque local-root identity for aggregate fleet sync-state upserts. Never synced. */
  telemetryBindingId?: string;
  /** Generation-CAS records. These are authoritative for gitRepos and all local
   * per-repo sidecars once present; legacy physical maps are folded in on read. */
  repoRecords?: Record<string, RepoRecord>;
}

export interface GlobalManifestMeta {
  /** encManifestSha of the blob whose fold equals the described manifest. */
  encManifestSha: string;
  /** Canonical hash (§3.2) of that folded manifest. */
  manifestHash: string;
  /** The base commit's SIGNED epochs (from its parsed body) — the §3.3.2 /
   *  I4 trigger inputs. Without these, a rotation between base and next
   *  commit is undetectable from persisted state and the writer would emit
   *  a cross-epoch delta (unreadable by construction). */
  accountEpoch: number;
  keyEpoch: number;
  /** The base's EXACT verified chain, base-first — the base blob's signed
   *  `manifestChain` as list-verified at apply time (§3.6.1). `chain[0]` is
   *  the terminal snapshot; a snapshot base ⇒ []. Bounded by
   *  MAX_MANIFEST_DELTA_CHAIN. */
  chain: string[];
  /** Cumulative delta ciphertext bytes since chain[0] — §3.3.4's input. */
  chainBytes: number;
  /** The terminal snapshot's ciphertext byte length (chain[0]'s — or, for a
   *  snapshot base, this blob's own) — §3.3.4's threshold. Recorded from an
   *  OBSERVED length and PROPAGATED UNCHANGED across deltas. */
  snapshotBytes: number;
  /** The described manifest's git layer, verbatim. Empty when the key is absent. */
  gitRepos: Record<string, GitSection>;
}

export function validManifestMeta(v: unknown): GlobalManifestMeta | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const meta = v as Record<string, unknown>;
  const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!hex(meta.encManifestSha) || !hex(meta.manifestHash)) return undefined;
  if (!counter(meta.accountEpoch) || !counter(meta.keyEpoch) || !counter(meta.chainBytes)) return undefined;
  if (!Number.isSafeInteger(meta.snapshotBytes) || (meta.snapshotBytes as number) <= 0) return undefined;
  // The chain shape rule (cap, hex, dedup, self-exclusion) is the SAME invariant
  // the wire parser enforces — one definition, or persisted metas could drift
  // from what the commit codec/server accept. Explicit Array check first: the
  // wire parser normalizes an ABSENT field to [], but a partial meta missing
  // `chain` must reject wholesale (§3.4 fail-to-snapshot).
  if (!Array.isArray(meta.chain) || readManifestChain(meta.chain, meta.encManifestSha) === null) return undefined;
  if ((meta.chainBytes === 0) !== (meta.chain.length === 0)) return undefined;
  if (!validateGitRepos(meta.gitRepos).ok) return undefined;
  return meta as unknown as GlobalManifestMeta;
}

/** Reconstruct the exact described manifest independently of local repo apply progress. */
export function manifestFromMeta(lastSyncedManifest: Manifest, meta: GlobalManifestMeta): Manifest {
  return {
    generatedAt: lastSyncedManifest.generatedAt,
    files: lastSyncedManifest.files,
    ...(lastSyncedManifest.manifestSchema === undefined ? {} : { manifestSchema: lastSyncedManifest.manifestSchema }),
    ...(Object.keys(meta.gitRepos).length === 0 ? {} : { gitRepos: meta.gitRepos }),
  };
}

export interface ConfigShapeIdentity {
  shape: string;
  commonDir: { realpath: string; dev: string; ino: string; birthtime: string };
}

export const GIT_DEFERRAL_REASONS = [
  "local-edits", "local-index", "local-operation", "local-commits", "local-stash",
  "deletion-pending", "conflict", "git-busy", "stale-unattributed", "worktree-ownership", "ignored-target", "ref-read-unreadable", "unreadable",
  "artifact", "config", "containment", "unsupported", "other",
] as const;

export type GitDeferralReason = (typeof GIT_DEFERRAL_REASONS)[number];

/**
 * TOTAL precedence over {@link GitDeferralReason}: when one repository accumulates
 * several reasons, the earliest member here is the one recorded and shown, so this
 * ordering is user-visible and load-bearing. Human-divergence reasons (the user's
 * own work) lead, then durable structural conditions, then indeterminate or
 * environmental ones, with `other` last.
 *
 * Deliberately a SEPARATE ordering from {@link GIT_DEFERRAL_REASONS}' declaration
 * order (an enumeration, not a ranking) — same discipline as BREADCRUMB_VETO_GATES:
 * a new reason must be ranked on purpose, never inherit a rank by accident.
 */
export const GIT_DEFERRAL_REASON_PRECEDENCE = [
  "local-edits", "local-index", "local-operation", "local-commits", "local-stash", "deletion-pending", "conflict",
  "worktree-ownership", "git-busy", "stale-unattributed", "ref-read-unreadable", "unreadable", "artifact", "config",
  "ignored-target", "containment", "unsupported", "other",
] as const satisfies readonly GitDeferralReason[];
/** Compile-only proof the ranking stays total: a new reason that is not placed
 * above makes this alias fail to check (it is NOT a runtime-skippable check). */
type UnrankedGitDeferralReason = Exclude<GitDeferralReason, (typeof GIT_DEFERRAL_REASON_PRECEDENCE)[number]>;
type Assert<T extends true> = T;
type _AllGitDeferralReasonsRanked = Assert<[UnrankedGitDeferralReason] extends [never] ? true : false>;

/** Smaller rank wins. Total by construction; the load-time check below is the
 * second line of defence for what the type level cannot see (a duplicate, which
 * would silently drop another member's rank). */
export const GIT_DEFERRAL_REASON_RANK: Record<GitDeferralReason, number> =
  Object.fromEntries(GIT_DEFERRAL_REASON_PRECEDENCE.map((reason, index) => [reason, index])) as Record<GitDeferralReason, number>;
if (new Set<string>(GIT_DEFERRAL_REASON_PRECEDENCE).size !== GIT_DEFERRAL_REASONS.length) {
  throw new Error("GIT_DEFERRAL_REASON_PRECEDENCE must rank every GitDeferralReason exactly once");
}

export interface GitDeferral {
  lane: "apply" | "capture" | "config";
  deferredSince: string;
  reasonSince: string;
  lastSeen: string;
  subjectKey?: string;
  reason: GitDeferralReason;
  checkout?: { kind: "branch" | "detached"; label?: string };
  bytesChanged?: boolean;
  /** D4 r2 F5: this checkpoint was classified once for subjectKey. */
  reproof?: boolean;
}

export const DEFERRAL_LANES = ["apply", "capture", "config"] as const satisfies readonly GitDeferral["lane"][];

export type GitDeferrals = Partial<Record<GitDeferral["lane"], GitDeferral>>;

export interface GitPartialApply {
  incomingKey: string;
  checkoutPending: boolean;
  appliedRefs: Record<string,
    | { kind: "direct"; oid: string }
    | { kind: "symbolic"; target: string }
    | { kind: "absent"; artifactOid: string }
    | ({ kind: "present"; oid: string; artifactOid: string; episode: string })
    | SafeRefWitness
  >;
  /** P-bound durable recovery members; unrelated checkout members stay intact. */
  pRepaired?: Record<string, PRepairReceipt>;
  heldRefs: Record<string, "local-commits" | "local-stash" | "ownership">;
  configApplied: boolean;
  configBase?: Record<string, string[]>;
}

export type TypedBlocker =
  | { provenance: "ref-plane"; reason: "local-commits" | "local-stash" | "deletion-pending" | "worktree-ownership"; ref: string }
  | { provenance: "checkout" | "boundary"; reason: GitDeferralReason; detail?: string }
  | { provenance: "indeterminate"; reason: "unreadable" | "unsupported"; detail: string }
  | { provenance: "protocol"; reason: "artifact"; detail: string }
  | {
      provenance: "composer";
      reason: "artifact";
      detail: string;
      /** Present on design-176 attempts. Optional fields retain compatibility with
       * attempts persisted by design 174's former aggregate composer blocker. */
      ref?: string;
      code?:
        | "missing-branch-proof"
        | "mismatched-branch-proof"
        | "missing-safe-ref-proof"
        | "mismatched-safe-ref-proof"
        | "wrong-ref-class"
        | "scope-refused"
        | "manual-proof-mismatch"
        | "p-repair-shape-mismatch"
        | "checkout-incomplete";
    };

/** Local-only held-follow observation. This is never projected onto a manifest. */
export interface GitHeldAttempt {
  incomingKey: string;
  /** Exact effective semantic projections used by the persisted classifier;
   * null means the corresponding section has no index artifact. */
  effectiveBaseIndexProjection: string | null;
  effectiveIncomingIndexProjection: string | null;
  /** Canonical exact transport descriptor, including an explicit absent case. */
  incomingIndexArtifactDescriptor: string;
  localFingerprint: string;
  fingerprintVersion: string;
  /** Optional only for compatibility with attempts written before design 200 P2.
   * A missing digest is never eligible for held-skip. */
  worktreeRegistryDigest?: string;
  reflogs: Array<{ path: string; digest: string }>;
  blockers: TypedBlocker[];
  repoIdentity: string;
  stateNonce: string;
  baseOriginsHash: string;
  partialDisposition: string;
  at: string;
}

export type GitResolutionLaneDisposition = "subsumed" | "not-subsumed" | "indeterminate";

/** Complete, privacy-bounded keep-mine confirmation binding. Hashes stand in for
 * canonical config and repository identity bytes; every field is local-only. */
export interface GitResolutionBinding {
  stream: string;
  stateNonce: string;
  incomingKey: string;
  repoGen: number;
  refs: Array<[string, string]>;
  reflogs: Array<[string, string[]]>;
  head: string;
  index: { kind: "absent" | "indeterminate" | "projected"; value?: string };
  opState: Array<[string, string]>;
  stash: string[];
  oracleReceipt: string | null;
  config: {
    ownership: "owned" | "unowned" | "indeterminate";
    read: "ok" | "over-bounds" | "failed" | "not-owned";
    hash?: string;
    detail?: string;
    shape?: string;
  };
  effectiveRefScope: "all" | "scoped";
  capturePolicy: { syncGit: boolean; respectGitignore: boolean; incremental?: boolean };
  repoKind: "dir" | "pointer";
  repositoryIdentity: string;
}

/** Durable proof that a synchronous keep-mine publication may have reached the
 * server. Local-only; push/pull reconcile it against authenticated remote truth. */
export interface GitResolutionPublicationReceipt {
  repo: string;
  attemptedGitIncomingKey: string;
  attemptedSequence: number;
  confirmedReportHash: string;
}

export interface RepoRecord {
  repoGen: number;
  sourceSeq: number;
  base?: GitSection;
  /** Exact last acknowledged wire checkpoint. Never follower mutation authority. */
  advertised?: GitSection;
  /** Positive provenance exists only for refs/heads/* and must match BASE exactly. */
  branchBaseOrigins?: Record<string, BranchBaseOrigin>;
  /** Refuse-only restore detector for the common store's packed refs. */
  packedRefsIdentity?: { mtimeMs: number };
  pending?: GitSection;
  /** The publisher intentionally omitted this repository without performing any
   * follower branch CAS (for example, structural refusal or syncGit:false).
   * The protected BASE remains an anchor, but is hidden from the projected
   * manifest until a normal apply or capture clears this disposition. */
  repoAbsent?: true;
  removedKey?: string;
  resolutionKey?: string;
  cfgSynced?: string;
  cfgApplied?: string;
  cfgToken?: ConfigStatToken;
  cfgShape?: ConfigShapeIdentity;
  deferrals?: GitDeferrals;
  partial?: GitPartialApply;
  /** Local-only design-174 held-follow observation; never wire-visible. */
  attempt?: GitHeldAttempt;
  /** Local-only synchronous keep-mine uncertain-ACK proof. */
  resolutionReceipt?: GitResolutionPublicationReceipt;
  /** D4's projected-index cache; stored here so RepoRecord's shape lands once. */
  idxProj?: string;
}

export type RepoRecordInput = Omit<RepoRecord, "repoGen">;

export interface RepoTransition {
  relPath: string;
  expectedRepoGen: number;
  newRecord: RepoRecordInput;
  /** Closed BASE authority consumed again under the state generation CAS. */
  baseProof?: RepoBaseProof;
}

export type FileOnlyManifest = Omit<Manifest, "gitRepos"> & { gitRepos?: never };

export interface StateSavePacket {
  expectedStream: string;
  expectedNonce: string;
  sourceGlobalSeq: number;
  global?: { manifest: FileOnlyManifest; manifestMeta?: GlobalManifestMeta };
  repos: RepoTransition[];
}

export type StateSaveResult =
  | { status: "accepted"; state: SyncState }
  | { status: "rejected"; reason: "stream" | "nonce" | "repo-generation" | "global-sequence" | "owner-lost"; state: SyncState }
  | { status: "busy"; detail: string }
  | { status: "unsupported"; error: unknown };

export interface StateSaveOptions {
  lock?: AcquireLockOptions;
  /** Complete-reset fence already owns both the protocol state class and the
   * physical state lock. The writer must assert and reuse it, never re-enter. */
  heldLock?: OwnedLock;
}

export const MAX_LEGACY_GIT_SIDECAR_REPOS = MAX_GIT_REPOS;

/** <=1.7.18 persisted deferred keep-mine intents. They have no meaning under
 * synchronous confirmation, so every state reader sees them stripped — not
 * merely callers that later project records through repoRecordsForState(). */
export function stripObsoleteResolutionIntents(state: SyncState): SyncState {
  if (!state.repoRecords) return state;
  let changed = false;
  const repoRecords: Record<string, RepoRecord> = {};
  for (const [relPath, record] of Object.entries(state.repoRecords)) {
    if (Object.prototype.hasOwnProperty.call(record, "resolutionIntent")) {
      const { resolutionIntent: _obsoleteResolutionIntent, ...normalized } = record as RepoRecord & { resolutionIntent?: unknown };
      repoRecords[relPath] = normalized;
      changed = true;
    } else {
      repoRecords[relPath] = record;
    }
  }
  return changed ? { ...state, repoRecords } : state;
}

export function normalizeStateCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Fold the legacy parallel maps into complete records. Every later state write
 * reconstructs gitRepos and sidecars solely from this returned record set. */
export function repoRecordsForState(state: SyncState): Record<string, RepoRecord> {
  const legacyDeferrals = state.repoRecords === undefined
    ? Object.fromEntries(Object.entries(state.gitDeferrals ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_LEGACY_GIT_SIDECAR_REPOS))
    : {};
  const legacyPartial = state.repoRecords === undefined
    ? Object.fromEntries(Object.entries(state.gitPartial ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_LEGACY_GIT_SIDECAR_REPOS))
    : {};
  const keys = new Set([
    ...Object.keys(state.repoRecords ?? {}),
    ...Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    ...Object.keys(state.gitPendingRemote ?? {}),
    ...Object.keys(state.gitReposRemoved ?? {}),
    ...Object.keys(state.gitNeedsResolution ?? {}),
    ...Object.keys(legacyDeferrals),
    ...Object.keys(legacyPartial),
  ]);
  const records: Record<string, RepoRecord> = {};
  for (const relPath of keys) {
    const saved = state.repoRecords?.[relPath];
    if (saved) {
      // Once a record exists it is authoritative, including property absence.
      // Falling back to a legacy map here would resurrect an observed deletion.
      // loadRawState strips <=1.7.18 resolutionIntent fields. Keep this projection
      // defensive for callers that construct a SyncState directly in memory.
      const { resolutionIntent: _obsoleteResolutionIntent, ...normalizedSaved } = saved as RepoRecord & { resolutionIntent?: unknown };
      records[relPath] = { ...normalizedSaved, repoGen: normalizeStateCounter(saved.repoGen), sourceSeq: normalizeStateCounter(saved.sourceSeq) };
      continue;
    }
    records[relPath] = {
      repoGen: 0,
      sourceSeq: normalizeStateCounter(state.lastSyncedSequence),
      ...(() => {
        const candidate = state.lastSyncedManifest.gitRepos?.[relPath];
        const composed = composeRepoBase({}, { ...(candidate === undefined ? {} : { base: candidate }) },
          migrationRepoBaseProof().authority, migrationRepoBaseProof().lockedProof);
        return {
          ...(composed.base === undefined ? {} : { base: composed.base }),
          ...(composed.branchBaseOrigins === undefined ? {} : { branchBaseOrigins: composed.branchBaseOrigins }),
        };
      })(),
      ...(state.gitPendingRemote?.[relPath] === undefined ? {} : { pending: state.gitPendingRemote[relPath] }),
      ...(state.gitReposRemoved?.[relPath] === undefined ? {} : { removedKey: state.gitReposRemoved[relPath] }),
      ...(state.gitNeedsResolution?.[relPath] === undefined ? {} : { resolutionKey: state.gitNeedsResolution[relPath] }),
      ...(legacyDeferrals[relPath] === undefined ? {} : { deferrals: legacyDeferrals[relPath] }),
      ...(legacyPartial[relPath] === undefined ? {} : { partial: legacyPartial[relPath] }),
    };
  }
  return records;
}

export const expectedStateNonce = (state: SyncState): string => state.stateNonce ?? "legacy";

function mapFromRecords<T>(records: Record<string, RepoRecord>, pick: (record: RepoRecord) => T | undefined): Record<string, T> | undefined {
  const result: Record<string, T> = {};
  for (const [relPath, record] of Object.entries(records)) {
    const value = pick(record);
    if (value !== undefined) result[relPath] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

export function stateFromRepoRecords(state: SyncState, records: Record<string, RepoRecord>): SyncState {
  const normalized: Record<string, RepoRecord> = Object.fromEntries(Object.entries(records).map(([relPath, record]) => {
    const sanitizedBase = record.base === undefined ? undefined : sanitizeGitSectionForPersistence(record.base);
    const sanitizedPending = record.pending === undefined ? undefined : sanitizeGitSectionForPersistence(record.pending);
    const lineageHash = recordOriginLineage(record.branchBaseOrigins) ?? "legacy-untrusted";
    const proof = carryRepoBaseProof(lineageHash);
    const composed = composeRepoBase(
      { base: sanitizedBase, branchBaseOrigins: record.branchBaseOrigins },
      { base: sanitizedBase, branchBaseOrigins: record.branchBaseOrigins },
      proof.authority,
      proof.lockedProof,
    );
    const next = { ...record };
    if (composed.base === undefined) delete next.base; else next.base = composed.base;
    if (composed.branchBaseOrigins === undefined) delete next.branchBaseOrigins;
    else next.branchBaseOrigins = composed.branchBaseOrigins;
    if (sanitizedPending === undefined) delete next.pending; else next.pending = sanitizedPending;
    return [relPath, next];
  }));
  // Removal/suppression hides the repository from the last-synced projection
  // without destroying its non-authoritative BASE provenance anchor.
  const gitRepos = mapFromRecords(normalized, (record) =>
    record.repoAbsent !== true && record.removedKey === undefined ? record.base : undefined);
  return {
    ...state,
    lastSyncedManifest: { ...state.lastSyncedManifest, gitRepos },
    gitReposRemoved: mapFromRecords(normalized, (record) => record.removedKey),
    gitNeedsResolution: mapFromRecords(normalized, (record) => record.resolutionKey),
    gitPendingRemote: mapFromRecords(normalized, (record) => record.pending),
    // A transactional record supersedes the legacy sidecar maps. legacyState()
    // deliberately reconstructs them after dropping repoRecords.
    gitDeferrals: undefined,
    gitPartial: undefined,
    repoRecords: normalized,
  };
}
