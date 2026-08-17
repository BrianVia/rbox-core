import type { FileEntry, GitSection, Manifest } from "../../../engine/index.js";
import type { PRepairReceipt } from "../../../cli/sync-git/p-repair.js";
import type { ConfigStatToken } from "../../../cli/sync-git/config-txn.js";
import type { BranchBaseOrigin } from "../../sync-git/base-composer.js";
import type {
  ConfigStoreIdentity,
  GitDeferral,
  GitHeldAttempt,
  GitPartialApply,
  GitResolutionPublicationReceipt,
  GlobalManifestMeta,
  RepoRecord,
  SyncState,
  TypedBlocker,
} from "../../sync-state-model.js";

export const SYNC_STATE_FIELD_COVERAGE = {
  stream: true,
  lastSyncedSequence: true,
  lastSyncedManifest: true,
  manifestMeta: true,
  gitReposRemoved: true,
  gitNeedsResolution: true,
  gitPendingRemote: true,
  gitDeferrals: true,
  gitPartial: true,
  stateNonce: true,
  stateRevision: true,
  telemetryBindingId: true,
  repoRecords: true,
} as const satisfies Record<keyof SyncState, true>;

export const MANIFEST_FIELD_COVERAGE = {
  generatedAt: true,
  files: true,
  manifestSchema: true,
  gitRepos: true,
} as const satisfies Record<keyof Manifest, true>;

export const FILE_ENTRY_FIELD_COVERAGE = {
  path: true,
  sha256: true,
  size: true,
  mode: true,
  mtimeMs: true,
  type: true,
  symlinkTarget: true,
  encSha: true,
  comp: true,
  payloadSha: true,
  cipherSize: true,
} as const satisfies Record<keyof FileEntry, true>;

export const GLOBAL_MANIFEST_META_FIELD_COVERAGE = {
  encManifestSha: true,
  manifestHash: true,
  accountEpoch: true,
  keyEpoch: true,
  chain: true,
  chainBytes: true,
  snapshotBytes: true,
  gitRepos: true,
} as const satisfies Record<keyof GlobalManifestMeta, true>;

export const REPO_RECORD_FIELD_COVERAGE = {
  repoGen: true,
  sourceSeq: true,
  base: true,
  advertised: true,
  branchBaseOrigins: true,
  packedRefsIdentity: true,
  pending: true,
  repoAbsent: true,
  removedKey: true,
  resolutionKey: true,
  cfgSynced: true,
  cfgApplied: true,
  cfgToken: true,
  cfgShape: true,
  deferrals: true,
  partial: true,
  attempt: true,
  resolutionReceipt: true,
  idxProj: true,
} as const satisfies Record<keyof RepoRecord, true>;

export const GIT_SECTION_FIELD_COVERAGE = {
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

export const CONFIG_STORE_IDENTITY_FIELD_COVERAGE = {
  shape: true,
  commonDir: true,
} as const satisfies Record<keyof ConfigStoreIdentity, true>;

export const CONFIG_STAT_TOKEN_FIELD_COVERAGE = {
  dev: true,
  ino: true,
  size: true,
  mtimeNs: true,
  ctimeNs: true,
} as const satisfies Record<keyof ConfigStatToken, true>;

export const GIT_DEFERRAL_FIELD_COVERAGE = {
  lane: true,
  deferredSince: true,
  reasonSince: true,
  lastSeen: true,
  subjectKey: true,
  reason: true,
  checkout: true,
  bytesChanged: true,
  reproof: true,
  detail: true,
} as const satisfies Record<keyof GitDeferral, true>;

export const GIT_PARTIAL_FIELD_COVERAGE = {
  incomingKey: true,
  checkoutPending: true,
  appliedRefs: true,
  pRepaired: true,
  heldRefs: true,
  configApplied: true,
  configBase: true,
} as const satisfies Record<keyof GitPartialApply, true>;

export const GIT_HELD_ATTEMPT_FIELD_COVERAGE = {
  incomingKey: true,
  classifierInputKey: true,
  effectiveBaseIndexProjection: true,
  effectiveIncomingIndexProjection: true,
  incomingIndexArtifactDescriptor: true,
  localFingerprint: true,
  fingerprintVersion: true,
  worktreeRegistryDigest: true,
  reflogs: true,
  blockers: true,
  repoIdentity: true,
  stateNonce: true,
  baseOriginsHash: true,
  partialDisposition: true,
  artifactPlaneDigest: true,
  at: true,
} as const satisfies Record<keyof GitHeldAttempt, true>;

export const GIT_RESOLUTION_RECEIPT_FIELD_COVERAGE = {
  repo: true,
  attemptedGitIncomingKey: true,
  attemptedSequence: true,
  confirmedReportHash: true,
} as const satisfies Record<keyof GitResolutionPublicationReceipt, true>;

export const P_REPAIR_RECEIPT_FIELD_COVERAGE = {
  v: true,
  kind: true,
  lineageHash: true,
  repositoryIdentityHash: true,
  ref: true,
  episode: true,
  p: true,
  k: true,
  q: true,
  origin: true,
  skeep: true,
  reflog: true,
  baseDisposition: true,
  eviction: true,
} as const satisfies Record<keyof PRepairReceipt, true>;

type PullOrigin = Extract<BranchBaseOrigin, { kind: "pull-p" }>;
type AckOrigin = Extract<BranchBaseOrigin, { kind: "publisher-ack" }>;
type ManualOrigin = Extract<BranchBaseOrigin, { kind: "manual" }>;

export const BRANCH_ORIGIN_PULL_FIELD_COVERAGE = {
  v: true, oid: true, lineageHash: true, kind: true, episode: true,
} as const satisfies Record<keyof PullOrigin, true>;
export const BRANCH_ORIGIN_ACK_FIELD_COVERAGE = {
  v: true, oid: true, lineageHash: true, kind: true, sourceSeq: true, incomingKey: true,
} as const satisfies Record<keyof AckOrigin, true>;
export const BRANCH_ORIGIN_MANUAL_FIELD_COVERAGE = {
  v: true, oid: true, lineageHash: true, kind: true, episode: true,
} as const satisfies Record<keyof ManualOrigin, true>;

type BlockerProvenance = TypedBlocker["provenance"];
export const TYPED_BLOCKER_VARIANT_COVERAGE = {
  "ref-plane": true,
  checkout: true,
  boundary: true,
  indeterminate: true,
  protocol: true,
  composer: true,
} as const satisfies Record<BlockerProvenance, true>;

type AppliedRef = GitPartialApply["appliedRefs"][string];
type AppliedRefKind = AppliedRef["kind"];
export const APPLIED_REF_KIND_COVERAGE = {
  direct: true,
  symbolic: true,
  absent: true,
  present: true,
  "safe-ref": true,
} as const satisfies Record<AppliedRefKind, true>;

type SafeRef = Extract<AppliedRef, { kind: "safe-ref" }>;
export const SAFE_REF_PROOF_COVERAGE = {
  "expected-old-transaction": true,
  "locked-terminal-observation": true,
} as const satisfies Record<SafeRef["proof"], true>;
