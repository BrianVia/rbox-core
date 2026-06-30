import {
  buildCommit,
  createWorkspaceKey,
  GENESIS_PARENT_HASH,
  openCommit,
  openWorkspaceKey,
  parseCommit,
  serializeRefset,
  verifyAccount,
  verifyCommitChain,
  type BlobRefset,
  type DeviceSecrets,
  type SignedCommit,
  type SignedKeyState,
  type SignedRoster,
  type VerifiedAccount,
  type Wrap,
} from "../engine/e2ee/index.js";
import { hashBytes } from "../engine/hash.js";
import type { BlobStore, Manifest } from "../engine/index.js";
import type { CommitResult, SyncRemote } from "./remote.js";

/** §24: emit a sidecar (refs out of the signed body) once the unique ref set is large
 *  enough that the inline body would approach the server's 1 MB commit-body cap. At ~85 B
 *  JSON/ref, 4000 refs ≈ 340 KB — comfortably inline; above this we switch to the sidecar
 *  so the body stays O(1). A repo big enough to need this already exceeds what a pre-§24
 *  client could commit (it would hit the 1 MB cap), so sidecar-for-large-only regresses no
 *  currently-working case. Below the threshold, inline keeps full old/new-client interop. */
const SIDECAR_THRESHOLD = 4000;

/**
 * E2EE sync transport (design 12 §13). Implements the SAME `SyncRemote` seam
 * `sync.ts` already depends on, but transparently encrypts: `latest()` fetches +
 * verifies the signed commit chain from the pinned head, then decrypts the
 * manifest; `commit()` encrypts the manifest, builds a signed commit, uploads the
 * opaque encrypted-manifest blob, and posts the envelope. `sync.ts`'s reconcile +
 * convergent blob encryption (by `encSha`) are unchanged — they sit above this.
 *
 * The CLI constructs this and passes it as `deps.remote`, so the encryption is a
 * transport layer beneath the plaintext-manifest reconcile logic.
 */

const EMPTY_MANIFEST: Manifest = { generatedAt: "", files: [] };

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
  putBlobFile(sha256: string, absPath: string, size: number, uploadsDir?: string): Promise<void>;
  putBlobBytes(sha256: string, bytes: Uint8Array): Promise<void>;
  blobStore(): BlobStore;
  // key material
  getAccountKeys(): Promise<AccountKeysDTO | null>;
  getWorkspaceKeys(workspaceId: string): Promise<WsKeyDTO[]>;
  putWorkspaceKey(workspaceId: string, keyEpoch: number, kekWrap: string): Promise<WsKeyDTO>;
  // signed commit chain
  latestCommit(): Promise<{ sequence: number; commit: SignedCommit | null }>;
  commitsSince(seq: number): Promise<SignedCommit[]>;
  commitSigned(parentSeq: number, commit: SignedCommit): Promise<CommitChainResult>;
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
}

export class E2eeRemote implements SyncRemote {
  private readonly kekByEpoch = new Map<number, Uint8Array>();
  /** The keyEpoch the KEK handed to `currentKek()` belongs to — blobs are
   *  encrypted under it, so a commit MUST be signed under the same epoch (D1). */
  private writeEpoch?: number;

  constructor(private readonly api: E2eeApi, private readonly ctx: E2eeContext, private readonly pins: PinStore) {}

  /** The current-epoch workspace KEK — also used by sync.ts to encrypt blobs.
   *  Snapshots the write epoch so `commit()` can reject a stale-KEK sign (D1). */
  async currentKek(): Promise<Uint8Array> {
    const account = await this.refreshAccount();
    this.writeEpoch = account.currentKeyEpoch;
    return this.kekFor(account.currentKeyEpoch, account, true);
  }

  // ---- SyncRemote ----------------------------------------------------------

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    const account = await this.refreshAccount();
    const { sequence, commit } = await this.api.latestCommit();
    if (!commit || sequence === 0) return { sequence: 0, manifest: EMPTY_MANIFEST };

    const pin = await this.pins.load();
    const pinnedSeq = pin?.commitSeq ?? 0;
    if (sequence < pinnedSeq) throw new Error("head rolled back below the pinned sequence (rollback evident) — refusing to sync");

    let head: SignedCommit;
    if (pin && sequence === pinnedSeq) {
      // No new commits: the head IS the already-verified pinned commit. Trust the
      // pin; a different hash at the pinned seq is a fork.
      if (commit.commitHash !== pin.commitHash) throw new Error("server returned a different commit at the pinned sequence (fork/equivocation)");
      head = commit;
    } else {
      // Verify the whole chain from the pin (or genesis) forward to the head (C1).
      const chain = await this.api.commitsSince(pinnedSeq);
      const verified = await verifyCommitChain(chain, pin ? { commitSeq: pin.commitSeq, commitHash: pin.commitHash } : null, account);
      if (!verified) return { sequence: 0, manifest: EMPTY_MANIFEST };
      head = verified;
    }

    const body = parseCommit(head);
    const kek = await this.kekFor(body.keyEpoch, account, false);
    const encManifest = await this.api.blobStore().get(body.encManifestSha);
    const json = await openCommit({ secrets: this.ctx.secrets, kek, account, commit: head, encManifest, workspaceId: this.ctx.workspaceId });
    await this.pinFrom(head, account);
    return { sequence, manifest: JSON.parse(new TextDecoder().decode(json)) as Manifest };
  }

  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    const account = await this.refreshAccount(); // C4: refresh immediately before signing
    // D1: if the epoch rotated between blob encryption (currentKek) and now, the
    // blobs are under the old KEK — force a re-scan/re-encrypt rather than sign a
    // commit whose keyEpoch ≠ the blobs' epoch. (v1 has no rotation; never fires.)
    if (this.writeEpoch !== undefined && this.writeEpoch !== account.currentKeyEpoch) {
      return { conflict: true, head: parentSequence };
    }
    const epoch = account.currentKeyEpoch;
    const kek = await this.kekFor(epoch, account, true);
    const pin = await this.pins.load();
    const parentCommitHash = pin?.commitHash ?? GENESIS_PARENT_HASH;

    // The blobRef list is the UNIQUE set of blobs this commit references — many
    // files can share one blob (identical content → same convergent encSha, e.g.
    // empty files or repeated boilerplate). Dedup by encSha; the file→blob mapping
    // lives in the manifest's file entries. (size advisory; server bills actual R2 bytes.)
    const refByEnc = new Map<string, { encSha: string; size: number }>();
    for (const f of manifest.files) {
      if (f.type === "file" && f.encSha && !refByEnc.has(f.encSha)) refByEnc.set(f.encSha, { encSha: f.encSha, size: f.size });
    }
    // §28: git artifact blobs (bundle/index/op-state) live in manifest.git, NOT manifest.files,
    // so they must be added to blobRefs explicitly — else they're uploaded but never granted/
    // charged and GC could reclaim a live bundle. Use the CIPHERTEXT size (codex M2): the `size`
    // is advisory (server bills measured R2 bytes) and the ciphertext size is what the server sees
    // anyway, so no plaintext git size (≈ repo size) enters a server-visible ref/sidecar.
    const g = manifest.git;
    if (g) {
      const addGit = (encSha: string | undefined, size: number | undefined) => {
        if (encSha && !refByEnc.has(encSha)) refByEnc.set(encSha, { encSha, size: size ?? 0 });
      };
      addGit(g.bundleEncSha, g.bundleCipherSize);
      addGit(g.indexEncSha, g.indexCipherSize);
      for (const ref of Object.values(g.opState ?? {})) addGit(ref.encSha, ref.cipherSize);
    }
    const blobRefs = [...refByEnc.values()];
    // §24: for a large ref set, move refs OUT of the signed body into a content-addressed
    // sidecar blob (canonical rbox-refset-v1 bytes). The body then carries only the descriptor
    // {sidecarSha,count,totalBytes}; the signature still commits to sidecarSha. Upload the
    // sidecar like any blob FIRST (so it's resolvable at commit), then sign the descriptor.
    let blobRefset: BlobRefset | undefined;
    if (blobRefs.length >= SIDECAR_THRESHOLD) {
      const sidecarBytes = serializeRefset(blobRefs);
      const sidecarSha = hashBytes(sidecarBytes);
      await this.api.putBlobBytes(sidecarSha, sidecarBytes);
      blobRefset = { sidecarSha, count: blobRefs.length, totalBytes: blobRefs.reduce((n, r) => n + r.size, 0) };
    }
    const built = await buildCommit({
      secrets: this.ctx.secrets,
      workspaceId: this.ctx.workspaceId,
      kek,
      keyEpoch: epoch,
      accountEpoch: account.currentEpoch,
      rosterVersion: account.currentRoster.version,
      seq: parentSequence + 1,
      parentSeq: parentSequence,
      parentCommitHash,
      manifestJson: new TextEncoder().encode(JSON.stringify(manifest)),
      blobRefs,
      blobRefset,
    });
    await this.api.putBlobBytes(built.encManifestSha, built.encManifest);

    const res = await this.api.commitSigned(parentSequence, built.commit);
    if (res.conflict) return { conflict: true, head: res.head };
    if (res.unsatisfiedBlobs) return { unsatisfiedBlobs: res.unsatisfiedBlobs };
    if (res.epochStale !== undefined) return { conflict: true, head: parentSequence }; // rotated under us → pull+retry
    await this.pinFrom(built.commit, account);
    return { sequence: res.sequence };
  }

  missingBlobs(shas: string[]): Promise<string[]> {
    return this.api.missingBlobs(shas);
  }
  putBlobFile(sha256: string, absPath: string, size: number, uploadsDir?: string): Promise<void> {
    return this.api.putBlobFile(sha256, absPath, size, uploadsDir);
  }
  blobStore(): BlobStore {
    return this.api.blobStore();
  }

  // ---- internals -----------------------------------------------------------

  /** Re-fetch + re-verify the account's roster/key-state chains on EVERY call
   *  (intentional — C4 wants a fresh epoch immediately before signing, plus fresh
   *  anti-rollback). Asserts the chains extend the locally-pinned hashes (C2) AND
   *  that THIS device is still active in the current roster — otherwise a
   *  half-admitted device (admit POST lost after local save) would silently sign
   *  commits no peer can verify. Fail closed instead. */
  private async refreshAccount(): Promise<VerifiedAccount> {
    const keys = await this.api.getAccountKeys();
    if (!keys) throw new Error("workspace is E2EE but this account has no key material — run setup/connect first");
    const rosters = keys.rosters.map((s) => JSON.parse(s) as SignedRoster);
    const keyStates = keys.keyStates.map((s) => JSON.parse(s) as SignedKeyState);
    const account = await verifyAccount(rosters, keyStates, this.ctx.now());

    const pin = await this.pins.load();
    if (pin) {
      const rh = account.rosterHashByVersion.get(pin.rosterVersion);
      if (rh !== pin.rosterHash || account.currentEpoch < pin.accountEpoch) {
        throw new Error("account key rollback detected (roster/key-state moved backward) — refusing to sync");
      }
    }
    if (!account.currentRoster.devices.some((d) => d.deviceId === this.ctx.secrets.deviceId && d.status === "active")) {
      throw new Error("this device isn't an active member of the account roster — enrollment may be incomplete. Run `rbox connect` with a fresh `rbox pair` token, or `rbox recover`.");
    }
    return account;
  }

  /** Resolve the workspace KEK for an epoch: memory → server wrap → (push only)
   *  create + CAS-publish, adopting the winning wrap. */
  private async kekFor(keyEpoch: number, account: VerifiedAccount, createIfMissing: boolean): Promise<Uint8Array> {
    const cached = this.kekByEpoch.get(keyEpoch);
    if (cached) return cached;

    const wraps = await this.api.getWorkspaceKeys(this.ctx.workspaceId);
    const found = wraps.find((w) => w.keyEpoch === keyEpoch);
    if (found) {
      const kek = await openWorkspaceKey(this.ctx.secrets, JSON.parse(found.kekWrap) as Wrap, keyEpoch, account.currentEpoch);
      this.kekByEpoch.set(keyEpoch, kek);
      return kek;
    }
    if (!createIfMissing) throw new Error(`no workspace KEK for keyEpoch ${keyEpoch} (fail closed — never guess)`);

    // Create + publish via the immutable CAS; adopt whatever wrap actually won.
    const fresh = await createWorkspaceKey(this.ctx.secrets, this.ctx.workspaceId, keyEpoch, account.currentEpoch);
    const winner = await this.api.putWorkspaceKey(this.ctx.workspaceId, keyEpoch, JSON.stringify(fresh.kekWrap));
    const kek = await openWorkspaceKey(this.ctx.secrets, JSON.parse(winner.kekWrap) as Wrap, keyEpoch, account.currentEpoch);
    this.kekByEpoch.set(keyEpoch, kek);
    return kek;
  }

  private async pinFrom(commit: SignedCommit, account: VerifiedAccount): Promise<void> {
    const body = parseCommit(commit);
    await this.pins.save({
      commitSeq: body.seq,
      commitHash: commit.commitHash,
      rosterVersion: account.currentRoster.version,
      rosterHash: account.currentRosterHash,
      accountEpoch: account.currentEpoch,
      keyStateHash: account.currentKeyStateHash,
    });
  }
}
