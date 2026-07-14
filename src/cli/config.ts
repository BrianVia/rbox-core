import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_GIT_REPOS, MAX_MANIFEST_DELTA_CHAIN, readManifestChain, validateGitRepos, type GitSection, type Manifest } from "../engine/index.js";
import { ENCRYPT_ADDRESS_CACHE_REL } from "../engine/encrypt-address-cache.js";
import { writeFileAtomic } from "../engine/fsutil.js";
import { acquireLock, type AcquireLockOptions } from "../engine/git/lockfile.js";
import type { ConfigStatToken } from "../engine/git/config-txn.js";
import { acquireWorkspaceSyncMutex, assertSyncMutex, releaseWorkspaceSyncMutex, workspaceSyncMutexDegraded, type WorkspaceSyncMutex } from "./sync-mutex.js";

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
  appliedRefs: Record<string, { kind: "direct"; oid: string } | { kind: "symbolic"; target: string }>;
  heldRefs: Record<string, "local-commits" | "local-stash" | "ownership">;
  configApplied: boolean;
  configBase?: Record<string, string[]>;
}

export interface RepoRecord {
  repoGen: number;
  sourceSeq: number;
  base?: GitSection;
  pending?: GitSection;
  removedKey?: string;
  resolutionKey?: string;
  cfgSynced?: string;
  cfgApplied?: string;
  cfgToken?: ConfigStatToken;
  cfgShape?: ConfigShapeIdentity;
  deferrals?: GitDeferrals;
  partial?: GitPartialApply;
  /** D4's projected-index cache; stored here so RepoRecord's shape lands once. */
  idxProj?: string;
}

export type RepoRecordInput = Omit<RepoRecord, "repoGen">;

export interface RepoTransition {
  relPath: string;
  expectedRepoGen: number;
  newRecord: RepoRecordInput;
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

function parseState(raw: string, file: string): SyncState {
  try {
    return JSON.parse(raw) as SyncState;
  } catch {
    throw new Error(
      `Corrupt sync state at ${file}. Refusing to reset to an empty base ` +
        `(that would force a destructive reconcile). Inspect the file, or delete it to ` +
        `intentionally re-baseline from scratch.`
    );
  }
}

/** Raw state load for the transactional writer. Unlike loadState, this never
 * hides a stream mismatch by manufacturing a fresh baseline. */
export async function loadRawState(root: string): Promise<SyncState | undefined> {
  try {
    return parseState(await fs.readFile(statePath(root), "utf8"), statePath(root));
  } catch (error) {
    if (isENOENT(error)) {
      try {
        const marker = JSON.parse(await fs.readFile(stateIncarnationPath(root), "utf8")) as {
          stream?: unknown; stateNonce?: unknown; stateRevision?: unknown;
        };
        if (typeof marker.stream === "string" && typeof marker.stateNonce === "string") {
          return {
            ...freshState(marker.stream),
            stateNonce: marker.stateNonce,
            stateRevision: validCounter(marker.stateRevision),
            repoRecords: {},
          };
        }
        throw new Error(`Corrupt sync state incarnation at ${stateIncarnationPath(root)}`);
      } catch (markerError) {
        if (isENOENT(markerError)) return undefined;
        throw markerError;
      }
    }
    throw error;
  }
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
      records[relPath] = { ...saved, repoGen: validCounter(saved.repoGen), sourceSeq: validCounter(saved.sourceSeq) };
      continue;
    }
    records[relPath] = {
      repoGen: 0,
      sourceSeq: validCounter(state.lastSyncedSequence),
      ...(state.lastSyncedManifest.gitRepos?.[relPath] === undefined ? {} : { base: state.lastSyncedManifest.gitRepos[relPath] }),
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
  const gitRepos = mapFromRecords(records, (record) => record.base);
  return {
    ...state,
    lastSyncedManifest: { ...state.lastSyncedManifest, gitRepos },
    gitReposRemoved: mapFromRecords(records, (record) => record.removedKey),
    gitNeedsResolution: mapFromRecords(records, (record) => record.resolutionKey),
    gitPendingRemote: mapFromRecords(records, (record) => record.pending),
    // A transactional record supersedes the legacy sidecar maps. legacyState()
    // deliberately reconstructs them after dropping repoRecords.
    gitDeferrals: undefined,
    gitPartial: undefined,
    repoRecords: records,
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
  const acquired = await acquireLock(stateLockPath(root), options.lock);
  if (acquired.status === "unsupported") return { status: "unsupported", error: acquired.error };
  if (acquired.status === "error") return { status: "busy", detail: String(acquired.error) };
  if (acquired.status === "held") return { status: "busy", detail: busyDetail(acquired) };
  const lock = acquired.lock;
  try {
    const raw = await loadRawState(root);
    const current = raw ?? freshState(packet.expectedStream);
    if (current.stream !== packet.expectedStream) return { status: "rejected", reason: "stream", state: current };
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
      records[transition.relPath] = { ...transition.newRecord, repoGen: transition.expectedRepoGen + 1 };
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
    await fs.rm(stateIncarnationPath(root), { force: true }).catch(() => {});
    return { status: "accepted", state: next };
  } finally {
    await lock.release();
  }
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

export async function loadConfig(root: string): Promise<WorkspaceConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(root), "utf8");
  } catch (e) {
    if (isENOENT(e)) throw new Error(`No rbox workspace at ${root}. Run: rbox link ${root}`);
    throw e;
  }
  try {
    return JSON.parse(raw) as WorkspaceConfig;
  } catch {
    throw new Error(`Corrupt workspace config at ${configPath(root)}. Inspect or re-run \`rbox link\`.`);
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
 * A baseline stamped with a DIFFERENT stream (see {@link syncStreamId}) is treated
 * as no baseline at all: it describes another manifest stream, and reconciling
 * against it turns "file not (yet) in the new stream" into "remotely deleted" —
 * the rebind mass-delete incident. A fresh base makes a rebound root
 * pull-without-deleting and push-everything, which is exactly right for a new
 * binding. A legacy state file with no stamp is adopted as-is (it predates the
 * stamp; every save since writes one).
 */
export async function loadState(root: string, stream: string): Promise<SyncState> {
  const fresh = freshState(stream);
  let raw: string;
  try {
    raw = await fs.readFile(statePath(root), "utf8");
  } catch (e) {
    if (isENOENT(e)) {
      const reset = await loadRawState(root);
      if (!reset) return fresh;
      if (reset.stream === stream) return reset;
      return fresh;
    }
    throw e;
  }
  const state = parseState(raw, statePath(root));
  if (state.stream === undefined) return { ...state, stream }; // pre-stamp legacy: adopt
  if (state.stream !== stream) {
    console.error(
      `sync state at ${statePath(root)} belongs to stream ${state.stream}, ` +
        `not ${stream} — starting from a fresh baseline (files on disk untouched).`
    );
    streamMismatchFreshStates.add(fresh);
    return fresh;
  }
  return state;
}

export async function saveState(root: string, state: SyncState): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  await writeFileAtomic(statePath(root), JSON.stringify(state, null, 2));
}

/** Discard the local sync baseline (used when a root is REBOUND to a different
 *  workspace — the old baseline describes the old stream). Files on disk are
 *  untouched; the next pull writes without deleting and the next push publishes
 *  the full tree. Every per-binding sidecar goes with it (design 45):
 *  the activity record AND the design-46 `shell.line` prompt sidecar both describe
 *  the OLD binding's halt/trail and must not render under the new one.
 *  Missing files = already reset. */
export async function resetSyncState(root: string, nextStream: string, heldMutex?: WorkspaceSyncMutex): Promise<void> {
  let owned = heldMutex;
  let releaseOwned = false;
  if (!owned) {
    owned = await acquireWorkspaceSyncMutex(root, "cli");
    releaseOwned = true;
  }
  assertSyncMutex(owned, root);
  try {
    await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
    const legacyReset = async (): Promise<void> => {
      // Same deliberate fence-free fallback as legacy saves: remove both state
      // representations so the next load starts from nextStream with no lane state.
      await fs.rm(stateIncarnationPath(root), { force: true });
      await fs.rm(statePath(root), { force: true });
    };
    if (workspaceSyncMutexDegraded(owned)) {
      await legacyReset();
    } else {
      const acquired = await acquireLock(stateLockPath(root));
      if (acquired.status === "unsupported") {
        await legacyReset();
      } else {
        if (acquired.status !== "acquired") throw new Error(`sync state reset lock unavailable (${busyDetail(acquired)})`);
        try {
          const prior = await loadRawState(root);
          const reset = {
            stream: nextStream,
            stateNonce: crypto.randomBytes(16).toString("hex"),
            stateRevision: validCounter(prior?.stateRevision) + 1,
          };
          let owner = true;
          await fs.mkdir(path.dirname(stateIncarnationPath(root)), { recursive: true });
          await writeFileAtomic(stateIncarnationPath(root), JSON.stringify(reset, null, 2), {
            beforeRename: async () => (owner = await acquired.lock.isOwner()),
          });
          if (!owner) throw new Error("sync state reset lock ownership was lost");
          if (!(await acquired.lock.isOwner())) throw new Error("sync state reset lock ownership was lost");
          await fs.rm(statePath(root), { force: true });
        } finally {
          await acquired.lock.release();
        }
      }
    }

    for (const p of [
      path.join(root, ENCRYPT_ADDRESS_CACHE_REL),
      path.join(root, RBOX_DIR, "state", "activity.json"),
      path.join(root, RBOX_DIR, "state", "shell.line"),
      path.join(root, RBOX_DIR, "state", "git-journal"),
      path.join(root, RBOX_DIR, "state", "shell.deferrals"),
    ]) {
      try {
        await fs.rm(p, { recursive: true });
      } catch (e) {
        if (!isENOENT(e)) throw e;
      }
    }
  } finally {
    if (releaseOwned) {
      await releaseWorkspaceSyncMutex(owned);
    }
  }
}
