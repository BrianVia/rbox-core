import type { FileEntry, GitSection, Manifest } from "../../engine/index.js";
import type { GlobalManifestMeta, RepoRecord, SyncState } from "../sync-state-model.js";

declare const digestBrand: unique symbol;
export type StateSemanticDigest = string & { readonly [digestBrand]: "state-semantic-v1" };
export type ManifestDigest = string & { readonly [digestBrand]: "manifest" };
export type BackupFileHash = string & { readonly [digestBrand]: "backup-file" };

export type Plane = "base" | "local";
export type GitSectionRole = "meta-wire" | "manifest-projection";
export type ManifestMaterializationPurpose = "wire-snapshot" | "wire-delta";

export interface ManifestHeader {
  generatedAt: string;
  manifestSchema?: number;
  sourceSequence?: number;
  trustEpoch?: string;
  complete: boolean;
  [extension: string]: unknown;
}

export interface LineageSnapshot {
  authorityId: string;
  lineageId: string;
  stream: string;
  nonce?: string;
  stateRevision?: number;
  lastSyncedSequence: number;
  baseGeneration: number;
  localRevision: number;
  telemetryBindingId?: string;
  lineageExtras: Record<string, unknown>;
  manifestGitReposPresent: boolean;
  baseHeader: ManifestHeader;
  localHeader: ManifestHeader;
  manifestMeta?: Omit<GlobalManifestMeta, "chain" | "gitRepos">;
}

export interface RepositorySnapshot extends LineageSnapshot {
  repoGen: number;
}

export interface CursorPage<T> {
  rows: T[];
  done: boolean;
  after?: string;
}

export interface ReadSnapshot {
  readonly token: LineageSnapshot;
  files(plane: Plane, afterPath: string | undefined, batchSize: number): CursorPage<FileEntry>;
  repos(afterRelPath: string | undefined, batchSize: number): CursorPage<{ relPath: string; record: RepoRecord; token: RepositorySnapshot }>;
  repo(relPath: string): { record: RepoRecord; token: RepositorySnapshot } | undefined;
  manifestChainCursor(afterOrdinal: number | undefined, batchSize: number): CursorPage<{ ordinal: number; encSha: string }>;
  metaGitRepoCursor(afterRelPath: string | undefined, batchSize: number): CursorPage<{ relPath: string; section: GitSection }>;
  manifestGitRepoCursor(afterRelPath: string | undefined, batchSize: number): CursorPage<{ relPath: string; section: GitSection }>;
  finishProjection(): void;
}

export interface MaterializeManifestRequest {
  plane: Plane;
  purpose: ManifestMaterializationPurpose;
  projectionToken: LineageSnapshot;
}

export interface StateStoreReadAdapters {
  loadRawState(): SyncState;
  loadState(expectedStream?: string): SyncState;
  materializeManifest(request: MaterializeManifestRequest): Manifest;
}
