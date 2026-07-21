import type { ByteProgressCallback } from "../engine/blobstore.js";
import type { DeviceSecrets, SignedCommit } from "../engine/e2ee/index.js";
import type { BlobStore } from "../engine/index.js";
import type { ReceiptPort } from "./publish-pipeline/receipt-drainer.js";
import type { CommitResult } from "./remote.js";

export interface AccountKeysDTO {
  recoveryWrap: string | null;
  recoveryWrapId: string | null;
  rosters: string[]; // canonical SignedRoster JSON, ordered by version
  keyStates: string[]; // canonical SignedKeyState JSON, ordered by epoch
  devices: Array<{ deviceId: string; sigPubkey: string | null; encPubkey: string | null; mkWrap: string | null }>;
}
export interface WsKeyDTO {
  keyEpoch: number;
  kekWrap: string; // Wrap JSON
}
export interface CommitChainResult extends CommitResult {
  /** Server precondition C4: the commit's accountEpoch != current → rotate + retry. */
  epochStale?: number;
}

/** Everything the transport needs from the network (real `RboxApi` in prod, an
 *  in-memory fake in tests — mirrors the existing SyncRemote/FakeRemote split). */
export interface E2eeApi {
  // blobs (reused as-is for ciphertext)
  missingBlobs(shas: string[]): Promise<string[]>;
  putBlobFile(
    sha256: string,
    absPath: string,
    size: number,
    uploadsDir?: string,
    onBytes?: ByteProgressCallback
  ): Promise<void>;
  ownsUploadLaneTiming?(size: number): boolean;
  receiptPort?(): ReceiptPort | undefined;
  putBlobBytes(sha256: string, bytes: Uint8Array, onBytes?: ByteProgressCallback): Promise<void>;
  blobStore(): BlobStore;
  // key material
  getAccountKeys(): Promise<AccountKeysDTO | null>;
  getWorkspaceKeys(workspaceId: string): Promise<WsKeyDTO[]>;
  putWorkspaceKey(workspaceId: string, keyEpoch: number, kekWrap: string): Promise<WsKeyDTO>;
  // signed commit chain
  latestCommit(): Promise<{ sequence: number; commit: SignedCommit | null }>;
  commitsSince(seq: number): Promise<SignedCommit[]>;
  commitSigned(parentSeq: number, commit: SignedCommit, beforeManifestPost?: () => Promise<void>): Promise<CommitChainResult>;
  /** Advisory server-reported commit timestamps (seq → epoch-ms) for display only —
   *  the best-effort D1 mirror, NOT authenticated. Used by `rbox versions` to show a
   *  time column; the in-memory test fake returns an empty map. */
  commitTimes(limit: number): Promise<Map<number, number>>;
}

/** One verified version-history entry (design 12 §15) — all fields from the SIGNED
 *  commit body (no decrypt). Advisory server timestamps are fetched separately
 *  (`advisoryTimes`) and joined by `seq` in the CLI, never commingled here. */
export interface VersionInfo {
  seq: number;
  deviceId: string;
  keyEpoch: number;
}

export interface VerifiedSuffixEntry {
  seq: number;
  deviceId: string;
}

export interface HeadPin {
  commitSeq: number;
  commitHash: string;
  rosterVersion: number;
  rosterHash: string;
  accountEpoch: number;
  keyStateHash: string;
}

/** Pluggable pin persistence (keystore-backed in prod, in-memory in tests). */
export interface PinStore {
  load(): Promise<HeadPin | undefined>;
  save(pin: HeadPin): Promise<void>;
}

export interface E2eeContext {
  accountId: string;
  workspaceId: string;
  /** `secrets.deviceId` is the authoritative device identity (set at enrollment);
   *  there is intentionally no separate `deviceId` here to avoid divergence. */
  secrets: DeviceSecrets;
  /** Injected clock for grant-expiry checks (Date.now in prod). */
  now: () => number;
  warningSink?: (line: string) => void;
}

export interface CurrentWriteKek {
  kek: Uint8Array;
  accountId: string;
  accountEpoch: number;
  keyEpoch: number;
}
