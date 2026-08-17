import {
  readManifestChain,
  validateGitRepos,
  type GitSection,
  type Manifest,
} from "../engine/index.js";
import { jsonCounter, jsonObject, jsonText, type JsonValue } from "../json.js";
import type { GlobalDelta } from "./sync-state-delta.js";
import type { AcquireLockOptions, OwnedLock } from "../engine/lockfile.js";
import type { ConfigStatToken } from "./sync-git/config-txn.js";
import type { PRepairReceipt } from "./sync-git/p-repair.js";
import type { BranchBaseOrigin, RepoBaseProof, SafeRefWitness } from "./sync-git/base-composer.js";

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

/** A persisted meta as it is actually read back: the typed record a writer
 * saved, or the raw JSON a foreign/older writer left behind. Either way every
 * member is re-established below before the record is trusted. */
type GlobalManifestMetaCandidate = Partial<Record<keyof GlobalManifestMeta, JsonValue | undefined>>;

export function validManifestMeta(v: GlobalManifestMeta | JsonValue | undefined): GlobalManifestMeta | undefined {
  return admissibleManifestMeta(v) ? v : undefined;
}

/** Re-establishes every member of a persisted meta. The value itself is returned
 * unchanged when it holds, so members this rule cannot see ride along. */
function admissibleManifestMeta(v: GlobalManifestMeta | JsonValue | undefined): v is GlobalManifestMeta {
  const meta = v as GlobalManifestMetaCandidate;
  if (!jsonObject(meta)) return false;
  const hex = (value: JsonValue | undefined): value is string => jsonText(value) && /^[0-9a-f]{64}$/.test(value);
  const counter = (value: JsonValue | undefined): boolean => jsonCounter(value) !== undefined;
  if (!hex(meta.encManifestSha) || !hex(meta.manifestHash)) return false;
  if (!counter(meta.accountEpoch) || !counter(meta.keyEpoch) || !counter(meta.chainBytes)) return false;
  if ((jsonCounter(meta.snapshotBytes) ?? 0) <= 0) return false;
  // The chain shape rule (cap, hex, dedup, self-exclusion) is the SAME invariant
  // the wire parser enforces — one definition, or persisted metas could drift
  // from what the commit codec/server accept. Explicit Array check first: the
  // wire parser normalizes an ABSENT field to [], but a partial meta missing
  // `chain` must reject wholesale (§3.4 fail-to-snapshot).
  if (!Array.isArray(meta.chain) || readManifestChain(meta.chain, meta.encManifestSha) === null) return false;
  if ((meta.chainBytes === 0) !== (meta.chain.length === 0)) return false;
  return validateGitRepos(meta.gitRepos).ok;
}

/** Reconstruct the exact described manifest independently of local repo apply progress. */
export function manifestFromMeta(lastSyncedManifest: Manifest, meta: GlobalManifestMeta): Manifest {
  const manifest: Manifest = { generatedAt: lastSyncedManifest.generatedAt, files: lastSyncedManifest.files };
  if (lastSyncedManifest.manifestSchema !== undefined) manifest.manifestSchema = lastSyncedManifest.manifestSchema;
  if (Object.keys(meta.gitRepos).length !== 0) manifest.gitRepos = meta.gitRepos;
  return manifest;
}

export interface ConfigStoreIdentity {
  shape: string;
  commonDir: { realpath: string; dev: string; ino: string; birthtime: string };
}

/** Order is load-bearing for `gitReasonOf` (doctor-cmd.ts:213): a member that is
 *  a SUPERSTRING of another must be declared before it, or the shorter one
 *  shadows it. Pinned by the invariant test; do not sort this list. */
export const GIT_DEFERRAL_REASONS = [
  "local-edits", "local-index", "local-operation", "local-commits", "local-stash",
  "deletion-pending", "conflict-copies", "conflict", "git-busy", "stale-unattributed", "worktree-ownership", "ignored-target", "ref-read-unreadable", "unreadable",
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
  "local-edits", "local-index", "local-operation", "local-commits", "local-stash", "deletion-pending", "conflict", "conflict-copies",
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
  /** Curated by the deferral-WRITING site only; never composed or extended by a
   * codec, projection, or renderer, and never folded into `reason`. */
  detail?: string;
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
  /** Cheap-gate classifier identity. Optional only for compatibility with
   * attempts written before the pre-fetch held-skip gate existed. */
  classifierInputKey?: string;
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
  /** Fingerprint-excluded rbox artifact refs; absent while design 270's flag is off. */
  artifactPlaneDigest?: string;
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
  cfgShape?: ConfigStoreIdentity;
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

/** Every repository a state knows, keyed by repository relPath. */
export interface RepoRecordsByPath {
  [relPath: string]: RepoRecord;
}

export interface RepoTransition {
  relPath: string;
  expectedRepoGen: number;
  newRecord: RepoRecordInput;
  /** Closed BASE authority consumed again under the state generation CAS. */
  baseProof?: RepoBaseProof;
}

export type FileOnlyManifest = Omit<Manifest, "gitRepos"> & { gitRepos?: never };

/** The snapshot a composition's elisions were proven against (design 267 §3.2b).
 * Both backends re-check it against live state under the canonical state lock. */
export interface ElisionExpectation { nonce: string; stateRevision: number }

export interface StateSavePacket {
  expectedStream: string;
  expectedNonce: string;
  sourceGlobalSeq: number;
  global?: { manifest: FileOnlyManifest; manifestMeta?: GlobalManifestMeta };
  /** Design 269: the same global expressed relatively. A backend may stage it
   * instead of `global`'s whole manifest; `global` stays authoritative for every
   * consumer that does not understand deltas. */
  globalDelta?: GlobalDelta;
  repos: RepoTransition[];
  /** Present only when composition omitted a section it proved unchanged. */
  elisionExpectation?: ElisionExpectation;
}

export type StateSaveResult =
  | { status: "accepted"; state: SyncState }
  | { status: "rejected"; reason: "stream" | "nonce" | "repo-generation" | "global-sequence" | "owner-lost" | "elision-drift"; state: SyncState }
  | { status: "busy"; detail: string }
  | { status: "unsupported"; error: unknown };

export interface StateSaveOptions {
  lock?: AcquireLockOptions;
  /** Design 267 §4: the accepted state a fully-elided save already holds. The
   * adapter overlays the CAS token fields onto it instead of reading the whole
   * store back. Every other save shape, and every rejection, still reads back. */
  acceptedProjection?: SyncState;
  /** Complete-reset fence already owns both the protocol state class and the
   * physical state lock. The writer must assert and reuse it, never re-enter. */
  heldLock?: OwnedLock;
}

