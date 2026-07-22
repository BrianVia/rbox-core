import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_GIT_REPOS, MAX_MANIFEST_DELTA_CHAIN, readManifestChain, validateGitRepos,
  SETTLED_ABSENCE_PREFIX, artifactBinding, checkoutJournalDir, readSettledAbsence, readStateLineageV1, recoverJournal,
  repositoryIdentityForContext, repoCtxFromDisk, scanBaseArtifacts, settleBaseAbsentArtifact,
  repositoryIdentityHash,
  withRepositoryRecoveryFence, readBasePresentArtifact, runLockedPRepairAttempt,
  resumeLockedAcceptedPRepair, refreshLockedAcceptedPRepair,
  type GitSection, type Manifest,
} from "../engine/index.js";
import { ENCRYPT_ADDRESS_CACHE_REL } from "../engine/encrypt-address-cache.js";
import { fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { acquireLock, type AcquireLockOptions, type OwnedLock } from "../engine/git/lockfile.js";
import { assertProtocolLockHeld } from "../engine/git/protocol-locks.js";
import { gitRaw } from "../engine/git/shared.js";
import type { ConfigStatToken } from "../engine/git/config-txn.js";
import { sanitizeGitSectionForPersistence } from "../engine/git/config-sync.js";
import type { PRepairReceipt } from "../engine/git/p-repair.js";
import { acquireWorkspaceSyncMutex, assertSyncMutex, releaseWorkspaceSyncMutex, workspaceSyncMutexDegraded, type WorkspaceSyncMutex } from "./sync-mutex.js";
import {
  carryRepoBaseProof,
  composeRepoBase,
  migrationRepoBaseProof,
  recordOriginLineage,
  type BranchBaseOrigin,
  type RepoBaseProof,
  type SafeRefWitness,
} from "./sync-git/base-composer.js";
import { BINDING_ID_RE } from "./telemetry/contract.js";
import { beginResetJournal, readResetJournal, recoverResetJournal, type ResetJournalAuthorization, type ResetZEntry } from "./reset-journal.js";
import {
  RESET_MATERIALIZED_BYTE_LIMIT,
  assertResetParseAdmission,
  boundedJsonRead,
  boundedRead,
  parseResetJsonBytes,
} from "./reset-io.js";
import { createPRepairStatePort } from "./sync-git/p-repair-state.js";
import { settleExactPresentArtifact } from "./sync-git/p-settlement.js";
import {
  RebindConsentRequiredError,
  consumeResetConsent,
  inspectResetConsent,
  type ResetConsentInspection,
  type ResetConsentWitness,
} from "./reset-consent.js";

function isENOENT(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Per-device, machine-local workspace binding. `rootPath` is NEVER synced. */
export interface WorkspaceConfig {
  /** Config schema marker. `e2ee/v1` = full end-to-end encryption (design 12).
   *  A workspace lacking it predates E2EE → sync fails closed (D11). */
  schema?: "e2ee/v1";
  /** Shared across machines — identifies the manifest stream on the server. */
  remoteWorkspaceId: string;
  /** OPT-IN, human-readable workspace label — cached LOCALLY so `rbox status` can
   *  show it with NO server round-trip. Names are set-once-at-create (immutable),
   *  so this cache never goes stale. Absent = no name was set (stays the opaque id).
   *  Populated at the two points the CLI already knows it: creating+naming a
   *  workspace (`rbox init --name`), or picking one from the "track existing" list. */
  name?: string;
  /** Single project for now ("root" = the whole linked tree). */
  projectId: string;
  /** This machine's device id. */
  deviceId: string;
  /** Resolved absolute root on THIS machine. Local-only; joined onto relative paths. */
  rootPath: string;
  remoteUrl: string;
  /** Device token — NOT stored in config (M4); injected at runtime from the
   *  per-machine credential (`rbox login`). Empty in the saved workspace.json. */
  token: string;
  /** Opt-in git-state sync (M2). Default off — syncing git config could move
   *  machine-local settings; hooks are never synced regardless. */
  syncGit?: boolean;
  /** Git-sync feature gates. Schema-3 pack chains are default-on; `incremental: false`
   *  is the escape hatch for full-bundle recaptures. */
  git?: {
    incremental?: boolean;
  };
  /** Design 72 opt-in: when true, nested `.gitignore` rules exclude gitignored
   *  untracked files from the FILE layer. Existing workspaces default false. */
  respectGitignore?: boolean;
  /** Per-repo opt-out for dependency-drift nudges (design 29). When true, a sync
   *  that writes a changed lockfile into this tree prints no drift notice. */
  noDrift?: boolean;
  /** Opt-in blob-content encryption (M5). Persisted. */
  encrypted?: boolean;
  /** Workspace KEK — runtime only, loaded from the keystore; NEVER persisted. */
  kek?: Buffer;
  /** E2EE write-context binding for blob-address caches — runtime only, NEVER persisted. */
  accountId?: string;
  /** Current verified account epoch for the runtime KEK wrap context — runtime only. */
  accountEpoch?: number;
  /** Current workspace key epoch for the runtime KEK wrap context — runtime only. */
  keyEpoch?: number;
  /** Local trash-tier retention (design 50 §2). Both fields optional; normalized
   *  by {@link trashConfig} on read (never trusted raw). `days: 0` = classic
   *  immediate delete (no trash, for the space-constrained). */
  trash?: { days?: number; maxBytes?: number };
}

/** Trash retention defaults + bounds (design 50 §7 MINOR). Persisted overrides are
 *  UNTRUSTED — a hand-edited workspace.json must never let a typo disable retention
 *  or blow the size cap — so each field clamps to its range and any non-finite /
 *  invalid value falls back to the default for THAT field independently. */
const TRASH_DAYS_DEFAULT = 30;
const TRASH_DAYS_MAX = 365;
const TRASH_MAXBYTES_DEFAULT = 2 * 2 ** 30; // 2 GiB
const TRASH_MAXBYTES_MAX = 2 ** 40; // 1 TiB

export function trashConfig(cfg: WorkspaceConfig): { days: number; maxBytes: number } {
  const rawDays = cfg.trash?.days;
  const days =
    typeof rawDays === "number" && Number.isFinite(rawDays)
      ? Math.min(TRASH_DAYS_MAX, Math.max(0, Math.trunc(rawDays)))
      : TRASH_DAYS_DEFAULT;
  const rawBytes = cfg.trash?.maxBytes;
  const maxBytes =
    typeof rawBytes === "number" && Number.isFinite(rawBytes)
      ? Math.min(TRASH_MAXBYTES_MAX, Math.max(0, Math.trunc(rawBytes)))
      : TRASH_MAXBYTES_DEFAULT;
  return { days, maxBytes };
}

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

export type GitDeferralReason =
  | "local-edits" | "local-index" | "local-operation" | "local-commits" | "local-stash"
  | "conflict" | "git-busy" | "worktree-ownership" | "ignored-target" | "unreadable"
  | "artifact" | "config" | "containment" | "unsupported" | "other";

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
  | { provenance: "ref-plane"; reason: "local-commits" | "local-stash" | "worktree-ownership"; ref: string }
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

export const RBOX_DIR = ".rbox";
const CONFIG_FILE = "workspace.json";
const STATE_FILE = "state.json";
const EMPTY_MANIFEST: Manifest = { generatedAt: "", files: [] };
export const MAX_LEGACY_GIT_SIDECAR_REPOS = MAX_GIT_REPOS;

const configPath = (root: string) => path.join(root, RBOX_DIR, CONFIG_FILE);
export const statePath = (root: string) => path.join(root, RBOX_DIR, STATE_FILE);
export const stateLockPath = (root: string) => `${statePath(root)}.lock`;
const stateIncarnationPath = (root: string) => path.join(root, RBOX_DIR, "state", "state-incarnation.json");

const freshState = (stream: string): SyncState => ({ stream, lastSyncedSequence: 0, lastSyncedManifest: EMPTY_MANIFEST });
const streamMismatchFreshStates = new WeakSet<SyncState>();
export const stateWasStreamMismatch = (state: SyncState): boolean => streamMismatchFreshStates.has(state);

/** A caller selected a different manifest stream than the durable baseline. */
export class StreamMismatchError extends Error {
  readonly name = "StreamMismatchError";

  constructor(
    readonly root: string,
    readonly expectedStream: string,
    readonly observedStream: string,
    readonly source: "state" | "incarnation-marker",
  ) {
    super(
      `sync state at ${source === "state" ? statePath(root) : stateIncarnationPath(root)} belongs to stream ${observedStream}, ` +
      `not ${expectedStream}; refusing to reset local sync history without setup confirmation`,
    );
  }
}

async function hasResetLineageArchive(root: string): Promise<boolean> {
  const archiveRoot = path.join(root, RBOX_DIR, "state", "lineages");
  const lineages = await fs.readdir(archiveRoot, { withFileTypes: true }).catch((error) => {
    if (isENOENT(error)) return [];
    throw error;
  });
  for (const lineage of lineages) {
    if (!lineage.isDirectory() || !/^[0-9a-f]{32}$/.test(lineage.name)) continue;
    const archives = await fs.readdir(path.join(archiveRoot, lineage.name), { withFileTypes: true }).catch((error) => {
      if (isENOENT(error)) return [];
      throw error;
    });
    if (archives.some((entry) => entry.isFile() && /^[0-9a-f]{64}\.json$/.test(entry.name))) return true;
  }
  return false;
}

/** Raw state load for the transactional writer. Unlike loadState, this never
 * hides a stream mismatch by manufacturing a fresh baseline. */
export async function loadRawState(root: string): Promise<SyncState | undefined> {
  const state = await boundedJsonRead<SyncState>(statePath(root));
  if (state) return stripObsoleteResolutionIntents(state);
  const marker = await boundedJsonRead<{
    stream?: unknown; stateNonce?: unknown; stateRevision?: unknown;
  }>(stateIncarnationPath(root), 512 * 1024);
  if (!marker) return undefined;
  if (typeof marker.stream === "string" && typeof marker.stateNonce === "string") {
    return {
      ...freshState(marker.stream),
      stateNonce: marker.stateNonce,
      stateRevision: validCounter(marker.stateRevision),
      repoRecords: {},
    };
  }
  throw new Error(`Corrupt sync state incarnation at ${stateIncarnationPath(root)}`);
}

/** <=1.7.18 persisted deferred keep-mine intents. They have no meaning under
 * synchronous confirmation, so every state reader sees them stripped — not
 * merely callers that later project records through repoRecordsForState(). */
function stripObsoleteResolutionIntents(state: SyncState): SyncState {
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

function validCounter(value: unknown): number {
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
      records[relPath] = { ...normalizedSaved, repoGen: validCounter(saved.repoGen), sourceSeq: validCounter(saved.sourceSeq) };
      continue;
    }
    records[relPath] = {
      repoGen: 0,
      sourceSeq: validCounter(state.lastSyncedSequence),
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

function packetNonceMatches(expected: string, actual: string | undefined): boolean {
  return expected === "legacy" ? actual === undefined : expected === actual;
}

function busyDetail(result: Exclude<Awaited<ReturnType<typeof acquireLock>>, { status: "acquired" }>): string {
  if (result.status !== "held") return result.status;
  const inspection = result.inspection;
  if (inspection.kind === "live" || inspection.kind === "dead") return `pid ${inspection.marker.pid}`;
  return inspection.reason;
}

/** Apply one generation-CAS packet under `<state>.lock`. Rejection is whole-packet:
 * no global or per-repo member lands unless every precondition succeeds. */
export async function applyStateSavePacket(root: string, packet: StateSavePacket, options: StateSaveOptions = {}): Promise<StateSaveResult> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  let lock: OwnedLock;
  let releaseLock = false;
  if (options.heldLock) {
    assertProtocolLockHeld("state", path.resolve(statePath(root)));
    if (path.resolve(options.heldLock.path) !== path.resolve(stateLockPath(root))) {
      throw new Error("held state lock does not match the workspace state path");
    }
    lock = options.heldLock;
  } else {
    const acquired = await acquireLock(stateLockPath(root), options.lock);
    if (acquired.status === "unsupported") return { status: "unsupported", error: acquired.error };
    if (acquired.status === "error") return { status: "busy", detail: String(acquired.error) };
    if (acquired.status === "held") return { status: "busy", detail: busyDetail(acquired) };
    lock = acquired.lock;
    releaseLock = true;
  }
  try {
    const raw = await loadRawState(root);
    const loaded = raw ?? freshState(packet.expectedStream);
    // A pre-stream legacy state is adopted by its first transactional save, just
    // as loadState has always adopted it in memory. The legacy nonce sentinel and
    // state lock make this a one-time fenced migration; an explicitly different
    // stream still rejects the whole packet.
    if (loaded.stream !== undefined && loaded.stream !== packet.expectedStream) {
      return { status: "rejected", reason: "stream", state: loaded };
    }
    const current = loaded.stream === undefined ? { ...loaded, stream: packet.expectedStream } : loaded;
    if (!packetNonceMatches(packet.expectedNonce, current.stateNonce)) return { status: "rejected", reason: "nonce", state: current };
    if (packet.global && packet.sourceGlobalSeq < current.lastSyncedSequence) {
      return { status: "rejected", reason: "global-sequence", state: current };
    }

    const records = repoRecordsForState(current);
    for (const transition of packet.repos) {
      if ((records[transition.relPath]?.repoGen ?? 0) !== transition.expectedRepoGen) {
        return { status: "rejected", reason: "repo-generation", state: current };
      }
    }
    for (const transition of packet.repos) {
      const previous = records[transition.relPath] ?? { repoGen: 0, sourceSeq: 0 };
      const proof = transition.baseProof ?? migrationRepoBaseProof();
      const sanitizedPreviousBase = previous.base === undefined ? undefined : sanitizeGitSectionForPersistence(previous.base);
      const sanitizedCandidateBase = transition.newRecord.base === undefined
        ? undefined
        : sanitizeGitSectionForPersistence(transition.newRecord.base);
      const composed = composeRepoBase(
        { base: sanitizedPreviousBase, branchBaseOrigins: previous.branchBaseOrigins },
        { base: sanitizedCandidateBase, branchBaseOrigins: transition.newRecord.branchBaseOrigins },
        proof.authority,
        proof.lockedProof,
      );
      const newRecord = {
        ...transition.newRecord,
        ...(transition.newRecord.pending === undefined
          ? {}
          : { pending: sanitizeGitSectionForPersistence(transition.newRecord.pending) }),
      };
      if (composed.base === undefined) delete newRecord.base; else newRecord.base = composed.base;
      if (composed.branchBaseOrigins === undefined) delete newRecord.branchBaseOrigins;
      else newRecord.branchBaseOrigins = composed.branchBaseOrigins;
      if (composed.disposition === "pending" && sanitizedCandidateBase && newRecord.pending === undefined) {
        newRecord.pending = sanitizedCandidateBase;
      }
      records[transition.relPath] = { ...newRecord, repoGen: transition.expectedRepoGen + 1 };
    }

    const global = packet.global?.manifest;
    const base: SyncState = global
      ? {
          ...current,
          lastSyncedSequence: packet.sourceGlobalSeq,
          lastSyncedManifest: { ...global, gitRepos: undefined },
          manifestMeta: packet.global?.manifestMeta,
        }
      : current;
    // A state save rewrites the complete record file, so sanitize every carried
    // P/BASE too—not only records named by this packet. This makes sanitation a
    // persistence invariant across collision, exception, recovery, and CAS-retry
    // paths instead of an apply-path tendency.
    for (const [relPath, record] of Object.entries(records)) {
      const base = record.base === undefined ? undefined : sanitizeGitSectionForPersistence(record.base);
      const pending = record.pending === undefined ? undefined : sanitizeGitSectionForPersistence(record.pending);
      if (base === record.base && pending === record.pending) continue;
      records[relPath] = {
        ...record,
        ...(base === undefined ? {} : { base }),
        ...(pending === undefined ? {} : { pending }),
      };
    }
    const next = stateFromRepoRecords({
      ...base,
      stateNonce: current.stateNonce ?? crypto.randomBytes(16).toString("hex"),
      stateRevision: validCounter(current.stateRevision) + 1,
    }, records);
    let owner = true;
    await writeFileAtomic(statePath(root), JSON.stringify(next, null, 2), {
      beforeRename: async () => (owner = await lock.isOwner()),
    });
    if (!owner) return { status: "rejected", reason: "owner-lost", state: current };
    const markerExisted = await fs.lstat(stateIncarnationPath(root)).then(() => true, (error) => {
      if (isENOENT(error)) return false;
      throw error;
    });
    await fs.rm(stateIncarnationPath(root), { force: true });
    if (markerExisted) await fsyncDirectory(path.dirname(stateIncarnationPath(root)));
    return { status: "accepted", state: next };
  } finally {
    if (releaseLock) await lock.release();
  }
}

/**
 * Establish the durable lineage boundary before a first Git mutation. Only a
 * physically absent, semantically empty state may be initialized here; an
 * existing legacy baseline remains legacy-untrusted and must be migrated by an
 * explicit confirmed workflow. The empty packet uses the ordinary state CAS,
 * so concurrent initialization chooses exactly one nonce.
 */
export async function ensureCapableStateLineage(root: string, state: SyncState): Promise<SyncState> {
  if (/^[0-9a-f]{32}$/.test(state.stateNonce ?? "")) return state;
  const existing = await loadRawState(root);
  if (existing) return state;
  const records = repoRecordsForState(state);
  const manifestGit = state.lastSyncedManifest.gitRepos;
  if (state.lastSyncedSequence !== 0 || state.lastSyncedManifest.files.length !== 0
    || Object.keys(records).length !== 0 || Object.keys(manifestGit ?? {}).length !== 0
    || Object.keys(state.gitPendingRemote ?? {}).length !== 0
    || Object.keys(state.gitReposRemoved ?? {}).length !== 0) {
    throw new Error("refusing to manufacture a capable lineage over non-genesis sync state");
  }
  const result = await applyStateSavePacket(root, {
    expectedStream: state.stream ?? "",
    expectedNonce: "legacy",
    sourceGlobalSeq: 0,
    repos: [],
  });
  if (result.status === "accepted") return result.state;
  if (result.status === "rejected" && (result.reason === "nonce" || result.reason === "repo-generation")) {
    const raced = await loadRawState(root);
    if (raced && raced.stream === state.stream && /^[0-9a-f]{32}$/.test(raced.stateNonce ?? "")) return raced;
  }
  throw new Error(`capable state-lineage initialization failed (${result.status}${"reason" in result ? `:${result.reason}` : ""})`);
}

function configForDisk(cfg: WorkspaceConfig): WorkspaceConfig {
  return {
    ...cfg,
    token: "",
    kek: undefined,
    accountId: undefined,
    accountEpoch: undefined,
    keyEpoch: undefined,
  };
}

/** The identity of the manifest stream a binding syncs against — what a sync
 *  baseline is stamped with and validated against (design 44 §2). Composed of
 *  every coordinate that selects a distinct sequence history server-side. */
export const syncStreamId = (cfg: Pick<WorkspaceConfig, "remoteUrl" | "remoteWorkspaceId" | "projectId">): string =>
  `${cfg.remoteUrl}::${cfg.remoteWorkspaceId}::${cfg.projectId}`;

/** Walk up from `start` looking for a `.rbox/workspace.json`, like git does. */
export async function findRoot(start: string): Promise<string | undefined> {
  let dir = path.resolve(start);
  for (;;) {
    try {
      await fs.access(configPath(dir));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

export class WorkspaceConfigNotFoundError extends Error {
  readonly code = "ENOENT";

  constructor(root: string) {
    super(`No rbox workspace at ${root}. Run: rbox link ${root}`);
    this.name = "WorkspaceConfigNotFoundError";
  }
}

export async function loadConfig(root: string): Promise<WorkspaceConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(root), "utf8");
  } catch (e) {
    if (isENOENT(e)) throw new WorkspaceConfigNotFoundError(root);
    throw e;
  }
  try {
    return JSON.parse(raw) as WorkspaceConfig;
  } catch {
    throw new Error(`Corrupt workspace config at ${configPath(root)}. Inspect or re-run \`rbox link\`.`);
  }
}

/** Typed config probe: only a genuinely absent workspace config maps to undefined. */
export async function loadConfigIfPresent(root: string): Promise<WorkspaceConfig | undefined> {
  try {
    return await loadConfig(root);
  } catch (error) {
    if (error instanceof WorkspaceConfigNotFoundError) return undefined;
    throw error;
  }
}

export async function saveConfig(root: string, cfg: WorkspaceConfig): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  // Never persist secrets to the workspace config: the token lives in the
  // per-machine credential (M4) and the KEK in the keystore (M5). Both injected
  // at runtime by loadAuthedConfig.
  await writeFileAtomic(configPath(root), JSON.stringify(configForDisk(cfg), null, 2));
}

/**
 * Load the sync state (the reconcile base) for `workspaceId`. A MISSING file is
 * the expected first-run case → empty base. A CORRUPT file is NOT silently treated
 * as empty: resetting the base to empty would make the next reconcile see every
 * remote file as "new" and every local file as conflicting — a destructive
 * surprise. We refuse and surface it instead.
 *
 * A baseline stamped with a DIFFERENT stream (see {@link syncStreamId}) describes
 * another manifest stream and is never reset by this read API. Every caller gets
 * a typed refusal; only setup's confirmed reset path may replace the lineage. A
 * legacy state file with no stamp is adopted as-is (it predates the stamp; every
 * save since writes one).
 */
export async function loadState(
  root: string,
  stream: string,
  warningSink: (line: string) => void = console.error,
  heldMutex?: WorkspaceSyncMutex,
): Promise<SyncState> {
  if (await readResetJournal(root)) {
    let recoveryMutex = heldMutex;
    let releaseRecoveryMutex = false;
    if (!recoveryMutex) {
      recoveryMutex = await acquireWorkspaceSyncMutex(root, "cli");
      releaseRecoveryMutex = true;
    }
    assertSyncMutex(recoveryMutex, root);
    if (workspaceSyncMutexDegraded(recoveryMutex)) throw new Error("reset journal recovery requires a non-degraded workspace fence");
    try {
      await recoverResetJournal(root, stream);
    } finally {
      if (releaseRecoveryMutex) await releaseWorkspaceSyncMutex(recoveryMutex);
    }
  }
  const fresh = freshState(stream);
  const activePresent = await fs.lstat(statePath(root)).then(() => true, (error) => {
    if (isENOENT(error)) return false;
    throw error;
  });
  const loaded = await loadRawState(root);
  if (!loaded) return fresh;
  const state = loaded;
  if (state.stream === undefined) return { ...state, stream }; // pre-stamp legacy: adopt
  if (state.stream !== stream) {
    throw new StreamMismatchError(root, stream, state.stream, activePresent ? "state" : "incarnation-marker");
  }
  // reset-v1's hash-addressed old-lineage archive is durable evidence that a
  // seq-0 state came from rebind/freshening rather than true genesis. Re-mark
  // every load so daemon preflight and direct pushManifest callers cannot lose
  // the provenance merely by reloading the atomically installed next state.
  if (state.lastSyncedSequence === 0 && await hasResetLineageArchive(root)) {
    streamMismatchFreshStates.add(state);
  }
  return state;
}

function stateContainsGitPersistence(state: SyncState): boolean {
  return Object.keys(state.lastSyncedManifest.gitRepos ?? {}).length > 0
    || Object.keys(state.repoRecords ?? {}).length > 0
    || Object.keys(state.gitPendingRemote ?? {}).length > 0
    || Object.keys(state.gitReposRemoved ?? {}).length > 0
    || Object.keys(state.gitNeedsResolution ?? {}).length > 0
    || Object.keys(state.gitDeferrals ?? {}).length > 0
    || Object.keys(state.gitPartial ?? {}).length > 0;
}

async function writeWholeStateUnsafe(root: string, state: SyncState): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  const sanitizeSectionMap = (sections: Record<string, GitSection> | undefined) => sections === undefined
    ? undefined
    : Object.fromEntries(Object.entries(sections)
      .map(([relPath, section]) => [relPath, sanitizeGitSectionForPersistence(section)]));
  const sanitized = state.repoRecords === undefined
    ? {
        ...state,
        lastSyncedManifest: {
          ...state.lastSyncedManifest,
          ...(state.lastSyncedManifest.gitRepos === undefined ? {} : { gitRepos: sanitizeSectionMap(state.lastSyncedManifest.gitRepos) }),
        },
        ...(state.gitPendingRemote === undefined ? {} : { gitPendingRemote: sanitizeSectionMap(state.gitPendingRemote) }),
      }
    : (() => {
        // Route authoritative records through the universal sanitizer/composer,
        // while preserving this explicitly unsafe API's caller-supplied legacy
        // projections (tests and degraded compatibility intentionally exercise
        // mismatched snapshots).
        const projected = stateFromRepoRecords(state, repoRecordsForState(state));
        return {
          ...state,
          repoRecords: projected.repoRecords,
          lastSyncedManifest: {
            ...state.lastSyncedManifest,
            ...(state.lastSyncedManifest.gitRepos === undefined ? {} : { gitRepos: sanitizeSectionMap(state.lastSyncedManifest.gitRepos) }),
          },
          ...(state.gitPendingRemote === undefined ? {} : { gitPendingRemote: sanitizeSectionMap(state.gitPendingRemote) }),
        };
      })();
  await writeFileAtomic(statePath(root), JSON.stringify(sanitized, null, 2));
}

/** Fresh, non-Git initialization only. Git BASE and every repository sidecar are
 * generation-CAS state and must be persisted with applyStateSavePacket(). */
export async function saveState(root: string, state: SyncState): Promise<void> {
  if (stateContainsGitPersistence(state)) {
    throw new Error("saveState refuses Git BASE or repository records; use the transactional state composer");
  }
  await writeWholeStateUnsafe(root, state);
}

/** Explicit compatibility/test escape hatch. Production calls are restricted by
 * base-composer-structure.test.ts to the legacy fallback in sync-state.ts. */
export async function saveStateUnsafeLegacyOrTest(root: string, state: SyncState): Promise<void> {
  await writeWholeStateUnsafe(root, state);
}

/** Initialize the telemetry binding identity under the same lock as transactional state writes. */
export async function ensureTelemetryBindingId(
  root: string,
  stream: string,
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): Promise<{ state: SyncState; bindingId: string }> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error(`sync state telemetry lock unavailable (${busyDetail(acquired)})`);
  try {
    const raw = await loadRawState(root);
    if (!raw) throw new Error("sync state is absent; refusing to manufacture a telemetry binding baseline");
    if (raw.stream !== undefined && raw.stream !== stream) {
      throw new Error(`sync state belongs to stream ${raw.stream}, not ${stream}; refusing to overwrite it`);
    }
    const current = stateFromRepoRecords(raw, repoRecordsForState(raw));
    if (typeof current.telemetryBindingId === "string" && BINDING_ID_RE.test(current.telemetryBindingId)) {
      return { state: current, bindingId: current.telemetryBindingId };
    }
    const bindingId = randomBytes(8).toString("hex");
    const next: SyncState = { ...current, telemetryBindingId: bindingId };
    let owner = true;
    await writeFileAtomic(statePath(root), JSON.stringify(next, null, 2), {
      beforeRename: async () => (owner = await acquired.lock.isOwner()),
    });
    if (!owner) throw new Error("sync state telemetry lock ownership was lost");
    return { state: next, bindingId };
  } finally {
    await acquired.lock.release();
  }
}

interface ResetRepositoryDescriptor {
  relPath: string;
  repoDir: string;
  ctx: NonNullable<Awaited<ReturnType<typeof repoCtxFromDisk>>>;
  identity: Awaited<ReturnType<typeof repositoryIdentityForContext>>;
  branchRefs: string[];
}

/** Read-only repository inventory used to choose the complete fence. A later
 * state-lineage recheck under that fence rejects any raced state before the
 * first preparation mutation. */
async function inspectResetRepositories(root: string, state: SyncState): Promise<ResetRepositoryDescriptor[]> {
  const repos: ResetRepositoryDescriptor[] = [];
  for (const [relPath, record] of Object.entries(repoRecordsForState(state)).sort(([a], [b]) => a < b ? -1 : 1)) {
    const repoDir = relPath === "." ? root : path.join(root, ...relPath.split("/"));
    const ctx = await repoCtxFromDisk(repoDir);
    const branchRefs = Object.keys(record.base?.refs ?? {}).filter((ref) => ref.startsWith("refs/heads/")).sort();
    if (!ctx) {
      if (branchRefs.length || Object.keys(record.branchBaseOrigins ?? {}).length) throw new Error(`reset refused: repository identity unavailable for ${relPath}`);
      continue;
    }
    const worktreeId = await fs.realpath(ctx.repoDir).catch(() => path.resolve(ctx.repoDir));
    const identity = await repositoryIdentityForContext(relPath, ctx, worktreeId);
    repos.push({ relPath, repoDir, ctx, identity, branchRefs });
  }
  return repos;
}

async function assertResetMarkerNormalized(root: string, state: SyncState): Promise<void> {
  if (!state.stream || !state.stateNonce) return; // legacy migration removes it
  const marker = await boundedJsonRead<Record<string, unknown>>(stateIncarnationPath(root), 512 * 1024);
  if (!marker) return;
  const keys = Object.keys(marker).sort().join("\0");
  if (keys !== ["stateNonce", "stateRevision", "stream"].sort().join("\0")
    || marker.stream !== state.stream || marker.stateNonce !== state.stateNonce
    || marker.stateRevision !== state.stateRevision) {
    throw new Error("reset refused: stale or foreign state incarnation marker");
  }
}

async function prepareResetArtifactsUnderFence<T>(
  root: string,
  state: SyncState,
  descriptors: readonly ResetRepositoryDescriptor[],
  heldStateLock: OwnedLock,
  finish: (state: SyncState, stateBytes: Buffer, z: ResetZEntry[]) => Promise<T>,
): Promise<T> {
  if (!state.stream || !state.stateNonce) throw new Error("reset refused: state lacks a fenced lineage");
  const stateStream = state.stream;
  const stateNonce = state.stateNonce;
  const repos = await Promise.all(descriptors.map(async ({ relPath, repoDir, ctx, identity }) => {
    const lineage = await readStateLineageV1(root, stateStream, stateNonce, identity);
    const binding = artifactBinding(lineage);
    return { relPath, repoDir, ctx, identity, binding };
  }));
  {
    let currentState = state;
    const knownLineagesByCommonDir = new Map<string, Set<string>>();
    for (const repo of repos) {
      const known = knownLineagesByCommonDir.get(repo.identity.commonDirReal) ?? new Set<string>();
      known.add(repo.binding.lineageHash);
      knownLineagesByCommonDir.set(repo.identity.commonDirReal, known);
    }

    const assertScanValid = async (repo: typeof repos[number]): Promise<Awaited<ReturnType<typeof scanBaseArtifacts>>> => {
      const scan = await scanBaseArtifacts(repo.repoDir, repo.binding);
      if (scan.invalidNamespace.length || scan.orphanKeep.length || scan.absent.some((item) => item.status === "invalid")
        || scan.present.some((item) => item.status === "invalid")
        || scan.foreign.some((item) => item.status === "invalid" || !knownLineagesByCommonDir.get(repo.identity.commonDirReal)?.has(item.lineageHash))) {
        throw new Error(`reset refused: malformed A/P/K artifacts for ${repo.relPath}`);
      }
      const settled = await readSettledAbsence(repo.repoDir, repo.binding);
      if (settled.status === "invalid") throw new Error(`reset refused: malformed Z for ${repo.relPath}: ${settled.detail}`);
      return scan;
    };

    // A published checkout intent owns its branch mutations. Refuse every such
    // journal before settling any P or compacting any A in any repository.
    for (const { relPath } of repos) {
      const checkoutPath = path.join(checkoutJournalDir(root, relPath), "journal.json");
      const checkoutStat = await fs.lstat(checkoutPath).catch((error) => isENOENT(error) ? undefined : Promise.reject(error));
      if (checkoutStat) {
        if (!checkoutStat.isFile() || checkoutStat.isSymbolicLink() || checkoutStat.size > 512 * 1024) {
          throw new Error(`reset refused: unsafe or oversized checkout journal for ${relPath}`);
        }
        try {
          const raw = await boundedJsonRead<{ phase?: unknown }>(checkoutPath, 512 * 1024);
          if (raw?.phase === "published") throw new Error(`reset refused: published checkout journal for ${relPath}`);
        } catch (error) {
          if (String(error).includes("published checkout journal")) throw error;
          throw new Error(`reset refused: unreadable or corrupt checkout journal for ${relPath}`);
        }
      }
    }

    for (const { relPath, identity } of repos) {
      const journalBinding = {
        stream: state.stream, stateNonce: state.stateNonce!,
        gitDirReal: identity.gitDirReal, commonDirReal: identity.commonDirReal, worktreeId: identity.worktreeId,
      };
      const checkout = await recoverJournal(root, relPath, journalBinding);
      if (checkout.status === "keep") throw new Error(`reset refused: published checkout journal for ${relPath}`);
      if (checkout.status === "defer") throw new Error(`reset refused: ${checkout.reason} for ${relPath}`);
    }

    // First classify every repository before mutating any protocol artifact, so
    // a malformed peer cannot be hidden by successful work in an earlier repo.
    for (const repo of repos) await assertScanValid(repo);

    // A valid P is never a reset veto. Settle its exact episode, or preserve and
    // quarantine every moved observation through P-repair, then start again from
    // freshly loaded state and artifacts. The cap makes this bound unreachable
    // without repeated external races; exhaustion is a safe-direction refusal.
    let passes = 0;
    for (const repo of repos) {
      for (;;) {
        if (++passes > 1_024) throw new Error("reset refused: P settlement did not stabilize");
        const scan = await assertScanValid(repo);
        const item = scan.present.find((candidate) => candidate.status === "valid");
        if (!item || item.status !== "valid") break;
        const p = item.artifact;
        const exact = await settleExactPresentArtifact({
          root, stream: state.stream, state: currentState, relPath: repo.relPath,
          ctx: repo.ctx, binding: repo.binding, p, stateSaveOptions: { heldLock: heldStateLock },
        });
        if (exact.status === "hold") throw new Error(`reset refused: unpreservable P for ${repo.relPath}: ${exact.reason}`);
        if (exact.status === "settled") {
          currentState = exact.state;
          continue;
        }
        if (exact.status === "absent") {
          const reloaded = await loadRawState(root);
          if (!reloaded || reloaded.stream !== state.stream || reloaded.stateNonce !== state.stateNonce) {
            throw new Error("reset refused: state lineage changed while settling P");
          }
          currentState = reloaded;
          continue;
        }

        const record = repoRecordsForState(currentState)[repo.relPath];
        if (!record) throw new Error(`reset refused: RepoRecord disappeared while repairing P for ${repo.relPath}`);
        const port = createPRepairStatePort({
          root, stream: state.stream, relPath: repo.relPath, repoKind: repo.ctx.kind,
          effectiveRefScope: record.base?.refScope ?? "all", p, stateSaveOptions: { heldLock: heldStateLock },
        });
        const validateArtifacts = async (): Promise<boolean> => {
          const freshP = await readBasePresentArtifact(repo.repoDir, repo.binding, p.payload.ref);
          if (freshP.status !== "valid" || freshP.artifact.targetOid !== p.targetOid) return false;
          const freshScan = await scanBaseArtifacts(repo.repoDir, repo.binding);
          if (freshScan.invalidNamespace.length || freshScan.orphanKeep.length
            || freshScan.absent.some((candidate) => candidate.status !== "valid")
            || freshScan.present.some((candidate) => candidate.status !== "valid")
            || freshScan.foreign.some((candidate) => candidate.status !== "valid"
              || candidate.branchRef === p.payload.ref)) return false;
          if (freshScan.absent.some((candidate) => candidate.status === "valid" && candidate.artifact.payload.ref === p.payload.ref)) return false;
          const z = await readSettledAbsence(repo.repoDir, repo.binding);
          return z.status !== "invalid" && !(z.status === "valid"
            && [...z.ledger.entries.values()].some((payload) => payload.ref === p.payload.ref));
        };
        const accepted = record.partial?.pRepaired?.[p.payload.ref];
        const mismatches = {
          live: exact.reason === "live",
          reflog: exact.reason === "reflog",
          baseShape: exact.reason === "base-shape",
        };
        let repaired;
        if (accepted) {
          const resumed = await resumeLockedAcceptedPRepair({ repoDir: repo.repoDir, receipt: accepted, validateArtifacts });
          repaired = resumed.status === "refresh-receipt"
            ? await refreshLockedAcceptedPRepair({
                repoDir: repo.repoDir, p, state: port, repairAt: new Date().toISOString(),
                acceptedReceipt: accepted, mismatches, validateArtifacts,
              })
            : resumed.status === "restart"
              ? { status: "restart" as const }
              : { status: "hold" as const, reason: resumed.reason };
        } else {
          repaired = await runLockedPRepairAttempt({
            repoDir: repo.repoDir, p, state: port, repairAt: new Date().toISOString(), mismatches, validateArtifacts,
          });
        }
        if (repaired.status === "hold") throw new Error(`reset refused: unpreservable P for ${repo.relPath}: ${repaired.reason}`);
        if (repaired.status === "retry") continue;
        const reloaded = await loadRawState(root);
        if (!reloaded || reloaded.stream !== state.stream || reloaded.stateNonce !== state.stateNonce) {
          throw new Error("reset refused: state lineage changed while repairing P");
        }
        currentState = reloaded;
      }
    }

    // Normative post-P rescan: reset never relies on the pre-repair artifact
    // view, and no valid/malformed standing P may slip into the lineage cutover.
    const rescans = new Map<string, Awaited<ReturnType<typeof scanBaseArtifacts>>>();
    for (const repo of repos) {
      const scan = await assertScanValid(repo);
      if (scan.present.some((item) => item.status === "valid")) {
        throw new Error(`reset refused: present-transition artifact survived repair for ${repo.relPath}`);
      }
      rescans.set(repo.relPath, scan);
    }

    // A is authoritative over serialized BASE, including an old writer's stale
    // positive member. Compact by exact A/Z CAS; never reject merely because the
    // materialized state view still says present.
    for (const repo of repos) {
      for (const item of rescans.get(repo.relPath)?.absent ?? []) {
        if (item.status === "valid") await settleBaseAbsentArtifact(repo.repoDir, repo.binding, item.artifact.payload.ref);
      }
    }

    const entries: ResetZEntry[] = [];
    for (const { relPath, repoDir, identity, binding } of repos) {
      const settled = await readSettledAbsence(repoDir, binding);
      if (settled.status === "invalid") throw new Error(`reset refused: malformed Z for ${relPath}: ${settled.detail}`);
      if (settled.status === "valid") entries.push({
        lineageHash: binding.lineageHash,
        repositoryIdentityHash: binding.repositoryIdentityHash,
        repositoryIdentity: identity,
        activeRef: settled.ledger.ref,
        targetOid: settled.ledger.targetOid,
        recoveryRef: `refs/rbox-recovery/base-absent/v1/${binding.lineageHash}/${settled.ledger.targetOid}`,
      });
    }
    for (const [commonDir, knownLineages] of knownLineagesByCommonDir) {
      const refs = (await gitRaw(commonDir, ["for-each-ref", "--format=%(refname)", SETTLED_ABSENCE_PREFIX])).split("\n").filter(Boolean);
      for (const ref of refs) {
        const match = new RegExp(`^${SETTLED_ABSENCE_PREFIX}/([0-9a-f]{64})$`).exec(ref);
        if (!match || !knownLineages.has(match[1]!)) throw new Error(`reset refused: foreign or malformed active Z ${ref}`);
      }
    }
    const journalRoot = path.join(root, RBOX_DIR, "state", "git-journal");
    const remaining = await fs.readdir(journalRoot).catch((error) => isENOENT(error) ? [] : Promise.reject(error));
    if (remaining.length > 0) throw new Error(`reset refused: unbound or unreadable checkout journal entries remain at ${journalRoot}`);
    const stateBytes = await boundedRead(statePath(root), RESET_MATERIALIZED_BYTE_LIMIT);
    if (!stateBytes) throw new Error("reset refused: active state disappeared during artifact preflight");
    assertResetParseAdmission(stateBytes.byteLength);
    const finalState = parseResetJsonBytes<SyncState>(stateBytes, statePath(root));
    if (finalState.stream !== state.stream || finalState.stateNonce !== state.stateNonce) {
      throw new Error("reset refused: state lineage changed during artifact preflight");
    }
    return finish(finalState, stateBytes, entries.sort((a, b) => a.activeRef < b.activeRef ? -1 : a.activeRef > b.activeRef ? 1 : a.targetOid < b.targetOid ? -1 : 1));
  }
}

/** Discard the local sync baseline (used when a root is REBOUND to a different
 *  workspace — the old baseline describes the old stream). Files on disk are
 *  untouched; the next pull writes without deleting and the next push publishes
 *  the full tree. Every per-binding sidecar goes with it (design 45):
 *  the activity record AND the design-46 `shell.line` prompt sidecar both describe
 *  the OLD binding's halt/trail and must not render under the new one.
 *  Missing files = already reset. */
export interface ResetSyncStateHooks {
  /** Test-only barrier seam under the complete fence, before consent
   * consumption or any reset preparation mutation. */
  afterFencedRecheck?: () => void | Promise<void>;
}

export async function resetSyncState(
  root: string,
  nextStream: string,
  heldMutex?: WorkspaceSyncMutex,
  resetConsent?: ResetConsentWitness,
  hooks: ResetSyncStateHooks = {},
): Promise<void> {
  if (!nextStream) throw new Error("reset refused: next stream is empty");

  // Pure capability validity happens before mkdir, locking, or recovery. It is
  // deliberately repeated under the complete repository fence below.
  const initialState = await loadRawState(root);
  const initialConfig = await loadConfig(root).catch(() => undefined);
  const initialOldStream = initialState?.stream ?? (initialConfig ? syncStreamId(initialConfig) : undefined);
  let consentInspection: Readonly<ResetConsentInspection> | undefined;
  if (initialOldStream !== undefined || initialState !== undefined || initialConfig !== undefined) {
    if (!resetConsent || initialOldStream === undefined) throw new RebindConsentRequiredError(root);
    consentInspection = inspectResetConsent(resetConsent);
    if (consentInspection.root !== path.resolve(root)
      || consentInspection.observedOldStream !== initialOldStream
      || consentInspection.observedOldNonce !== initialState?.stateNonce
      || consentInspection.mintedAtRevision !== validCounter(initialState?.stateRevision)
      || consentInspection.nextStream !== nextStream) throw new RebindConsentRequiredError(root);
  } else if (resetConsent) {
    throw new RebindConsentRequiredError(root);
  }

  let owned = heldMutex;
  let releaseOwned = false;
  if (!owned) {
    owned = await acquireWorkspaceSyncMutex(root, "cli");
    releaseOwned = true;
  }
  assertSyncMutex(owned, root);
  try {
    if (workspaceSyncMutexDegraded(owned)) throw new Error("sync state reset requires a non-degraded workspace fence");

    // Finish only an independently authorized standing transaction. A legacy
    // or foreign journal halts before fresh reset preparation begins.
    const initialRecoveryStream = initialConfig ? syncStreamId(initialConfig) : initialOldStream;
    if (await readResetJournal(root)) {
      if (!initialRecoveryStream) throw new Error("reset recovery halted: durable config stream is unavailable");
      await recoverResetJournal(root, initialRecoveryStream);
    }

    const observedState = await loadRawState(root);
    const descriptors = observedState ? await inspectResetRepositories(root, observedState) : [];
    const requests = descriptors.map((repo) => ({
      commonDir: repo.identity.commonDirReal,
      reflogRefs: repo.branchRefs,
      origins: true,
    }));
    let recoveryCallerStream: string | undefined;

    await withRepositoryRecoveryFence(requests, path.resolve(statePath(root)), async () => {
      const acquired = await acquireLock(stateLockPath(root));
      if (acquired.status !== "acquired") throw new Error(`sync state reset lock unavailable (${busyDetail(acquired)})`);
      try {
        // Requests were necessarily discovered before acquiring their common-dir
        // locks. Re-resolve every checkout under those locks and refuse if a
        // replacement now points at an unlocked repository incarnation.
        for (const descriptor of descriptors) {
          const currentCtx = await repoCtxFromDisk(descriptor.repoDir);
          if (!currentCtx) throw new Error(`reset refused: repository identity changed for ${descriptor.relPath}`);
          const worktreeId = await fs.realpath(currentCtx.repoDir).catch(() => path.resolve(currentCtx.repoDir));
          const currentIdentity = await repositoryIdentityForContext(descriptor.relPath, currentCtx, worktreeId);
          if (repositoryIdentityHash(currentIdentity) !== repositoryIdentityHash(descriptor.identity)) {
            throw new Error(`reset refused: repository identity changed for ${descriptor.relPath}`);
          }
        }
        let prior = await loadRawState(root);
        const freshConfig = await loadConfig(root).catch(() => undefined);
        const fencedOldStream = prior?.stream ?? (freshConfig ? syncStreamId(freshConfig) : undefined);
        if (consentInspection) {
          if (!prior && !freshConfig) throw new Error("reset refused: confirmed old lineage disappeared before the fence");
          if (fencedOldStream !== consentInspection.observedOldStream
            || prior?.stateNonce !== consentInspection.observedOldNonce
            || validCounter(prior?.stateRevision) !== consentInspection.mintedAtRevision) {
            throw new Error("reset refused: state lineage changed after confirmation");
          }
        } else if (prior || freshConfig) {
          throw new RebindConsentRequiredError(root);
        }

        await hooks.afterFencedRecheck?.();
        const barrierState = await loadRawState(root);
        const barrierConfig = await loadConfig(root).catch(() => undefined);
        if ((barrierState?.stream ?? (barrierConfig ? syncStreamId(barrierConfig) : undefined)) !== fencedOldStream
          || barrierState?.stateNonce !== prior?.stateNonce
          || validCounter(barrierState?.stateRevision) !== validCounter(prior?.stateRevision)) {
          throw new Error("reset refused: state lineage changed before journal publication");
        }
        prior = barrierState;

        if (prior) await assertResetMarkerNormalized(root, prior);

        let authorization: ResetJournalAuthorization | undefined;
        if (consentInspection && resetConsent) {
          const consumed = consumeResetConsent(resetConsent, {
            root,
            observedOldStream: consentInspection.observedOldStream,
            observedOldNonce: consentInspection.observedOldNonce,
            nextStream,
          });
          authorization = {
            version: 2,
            authorizedNextStream: nextStream,
            consentKind: consumed.consentKind,
            mintedAtRevision: consumed.mintedAtRevision,
          };
        }

        if (!prior) {
          const genesis: SyncState = {
            stream: nextStream,
            stateNonce: crypto.randomBytes(16).toString("hex"),
            stateRevision: 0,
            lastSyncedSequence: 0,
            lastSyncedManifest: EMPTY_MANIFEST,
            repoRecords: {},
          };
          await writeFileAtomic(statePath(root), JSON.stringify(genesis, null, 2));
          await writeFileAtomic(stateIncarnationPath(root), JSON.stringify({
            stream: genesis.stream, stateNonce: genesis.stateNonce, stateRevision: 0,
          }, null, 2));
          recoveryCallerStream = nextStream;
          return;
        }
        if (!authorization) throw new RebindConsentRequiredError(root);

        // Legacy-lineage migration is itself behind the fenced witness recheck
        // and reuses the already-held physical state lock.
        if (prior.stateNonce === undefined) {
          const legacyStream = prior.stream ?? fencedOldStream;
          if (!legacyStream) throw new Error("sync state reset requires the legacy binding stream");
          const migrated = await applyStateSavePacket(root, {
            expectedStream: legacyStream,
            expectedNonce: "legacy",
            sourceGlobalSeq: validCounter(prior.lastSyncedSequence),
            repos: [],
          }, { heldLock: acquired.lock });
          if (migrated.status !== "accepted") {
            const detail = migrated.status === "rejected" ? migrated.reason
              : migrated.status === "busy" ? migrated.detail : migrated.status;
            throw new Error(`sync state legacy reset migration failed (${detail})`);
          }
          prior = migrated.state;
        }
        if (!prior.stream || !prior.stateNonce || !Number.isSafeInteger(prior.stateRevision)) {
          throw new Error("sync state reset requires a fenced state lineage");
        }
        recoveryCallerStream = prior.stream;
        await prepareResetArtifactsUnderFence(root, prior, descriptors, acquired.lock, async (preparedState, preparedBytes, z) => {
          const revalidated = await boundedRead(statePath(root), RESET_MATERIALIZED_BYTE_LIMIT);
          if (!revalidated) throw new Error("sync state disappeared before reset journal preparation");
          if (!revalidated.equals(preparedBytes)) throw new Error("sync state changed before reset journal preparation");
          if (!(await acquired.lock.isOwner())) throw new Error("sync state reset lock ownership was lost");
          await beginResetJournal(root, nextStream, preparedBytes, preparedState, z, authorization!);
        });
      } finally {
        await acquired.lock.release();
      }
    });

    if (await readResetJournal(root)) {
      if (!recoveryCallerStream) throw new Error("reset recovery halted: old stream is unavailable");
      await recoverResetJournal(root, recoveryCallerStream);
    }

    for (const p of [
      path.join(root, ENCRYPT_ADDRESS_CACHE_REL),
      path.join(root, RBOX_DIR, "state", "activity.json"),
      path.join(root, RBOX_DIR, "state", "shell.line"),
      path.join(root, RBOX_DIR, "state", "shell.deferrals"),
    ]) {
      try {
        await fs.rm(p, { recursive: true });
      } catch (error) {
        if (!isENOENT(error)) throw error;
      }
    }
  } finally {
    if (releaseOwned) await releaseWorkspaceSyncMutex(owned);
  }
}
