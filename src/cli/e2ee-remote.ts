import {
  buildCommit,
  createWorkspaceKey,
  GENESIS_PARENT_HASH,
  openCommit,
  openCommitHistorical,
  openWorkspaceKey,
  parseCommit,
  serializeRefset,
  verifyAccount,
  verifyCommitChain,
  verifyHistorySegment,
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
import { NeedsRebaselineError, type CommitResult, type SyncRemote } from "./remote.js";

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

/** One verified version-history entry (design 12 §15) — all fields from the SIGNED
 *  commit body (no decrypt). Server timestamps are joined in the CLI as advisory. */
export interface VersionInfo {
  seq: number;
  deviceId: string;
  keyEpoch: number;
  commitHash: string;
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
    const vh = await this.verifiedHead();
    if (!vh) return { sequence: 0, manifest: EMPTY_MANIFEST };
    const body = parseCommit(vh.commit);
    const kek = await this.kekFor(body.keyEpoch, vh.account, false);
    const encManifest = await this.api.blobStore().get(body.encManifestSha);
    const json = await openCommit({ secrets: this.ctx.secrets, kek, account: vh.account, commit: vh.commit, encManifest, workspaceId: this.ctx.workspaceId });
    return { sequence: vh.sequence, manifest: JSON.parse(new TextDecoder().decode(json)) as Manifest };
  }

  /**
   * Establish the TRUSTED HEAD (shared anti-rollback anchor for pull + versions +
   * restore, C1/C2): verify the account roster/key-state chains, then verify the
   * commit chain forward from the pin to `latest`, advance the pin, and return the
   * verified head commit. Fail-closed/terminal-bound: the verified chain's terminal
   * commit MUST equal what `latest()` reported (hash) — a server can't have us
   * verify one chain while claiming a different head. Returns null only when the
   * workspace genuinely has no commits yet.
   */
  private async verifiedHead(): Promise<{ account: VerifiedAccount; sequence: number; commit: SignedCommit } | null> {
    const account = await this.refreshAccount();
    const { sequence, commit } = await this.api.latestCommit();
    if (!commit || sequence === 0) return null;

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
      // /latest reported a non-zero head, so the chain MUST be non-empty AND its
      // terminal commit MUST be that head — else the server is equivocating. Fail closed.
      if (!verified) throw new Error("server reported a head but returned no commit chain to verify (inconsistent) — refusing");
      if (verified.commitHash !== commit.commitHash) throw new Error("verified chain head does not match latest() (fork/equivocation) — refusing");
      head = verified;
    }
    await this.pinFrom(head, account);
    return { account, sequence, commit: head };
  }

  // ---- version history + restore (design 12 §15, D11) ----------------------

  /**
   * `rbox versions`: the verified commit history within the retained window,
   * newest-first. Each entry is metadata only (no decrypt) — `seq`/`deviceId`/
   * `keyEpoch` from the SIGNED commit body, authenticated as the true ancestry of
   * the verified head (`verifyHistorySegment`). `commitHash` lets the caller align
   * advisory server timestamps. Empty when the workspace has no history yet.
   */
  async history(limit: number): Promise<VersionInfo[]> {
    const vh = await this.verifiedHead();
    if (!vh) return [];
    const { account, sequence: head } = vh;
    const seg = await this.retainedSegmentEndingAtHead(Math.max(0, head - limit), head, vh.commit.commitHash, account);
    return seg
      .map((c) => {
        const b = parseCommit(c);
        return { seq: b.seq, deviceId: b.deviceId, keyEpoch: b.keyEpoch, commitHash: c.commitHash };
      })
      .reverse(); // newest-first
  }

  /**
   * The verified + decrypted manifest at a historical sequence, plus the per-epoch
   * KEK bytes for decrypting that commit's file blobs (design 12 §15). Authenticates
   * `[seq..head]` as the true ancestry of the verified head, then decrypts under the
   * commit's OWN `keyEpoch` (`openCommitHistorical` — no current-epoch gate, since a
   * historical commit may predate a rotation). Throws (fail closed) on an out-of-range
   * seq, a tampered/non-terminating chain, or a `seq` pruned past retention
   * (`NeedsRebaselineError` from `commitsSince`).
   */
  async manifestAtSeq(seq: number): Promise<{ manifest: Manifest; kek: Uint8Array }> {
    const vh = await this.verifiedHead();
    if (!vh) throw new Error("this workspace has no version history yet");
    const { account, sequence: head, commit: headCommit } = vh;
    if (!Number.isInteger(seq) || seq < 1 || seq > head) throw new Error(`no such version: ${seq} (history is 1..${head})`);

    let target: SignedCommit;
    if (seq === head) {
      target = headCommit; // already verified by verifiedHead()
    } else {
      const chain = await this.api.commitsSince(seq - 1); // (seq-1, head] = seq..head
      target = await verifyHistorySegment(chain, seq, headCommit.commitHash, account);
    }
    const body = parseCommit(target);
    const kek = await this.kekFor(body.keyEpoch, account, false);
    const encManifest = await this.api.blobStore().get(body.encManifestSha);
    const json = await openCommitHistorical({ secrets: this.ctx.secrets, kek, account, commit: target, encManifest, workspaceId: this.ctx.workspaceId });
    return { manifest: JSON.parse(new TextDecoder().decode(json)) as Manifest, kek };
  }

  /**
   * `rbox versions <path>`: the versions in which `relPath`'s CONTENT changed,
   * newest-first (design 06 §2). Single-pass over the verified retained window —
   * decrypt each commit's manifest (`openCommitHistorical`) and emit a change-point
   * whenever the path's plaintext `sha256` differs from the previous (older) version
   * (first appearance and deletion-within-window included; `sha256: null` = absent).
   */
  async pathHistory(relPath: string, limit: number): Promise<Array<{ seq: number; deviceId: string; sha256: string | null }>> {
    const vh = await this.verifiedHead();
    if (!vh) return [];
    const { account, sequence: head } = vh;
    const seg = await this.retainedSegmentEndingAtHead(Math.max(0, head - limit), head, vh.commit.commitHash, account);
    const changes: Array<{ seq: number; deviceId: string; sha256: string | null }> = [];
    let lastSha: string | null | undefined; // undefined = nothing emitted yet
    for (const c of seg) {
      const body = parseCommit(c);
      const kek = await this.kekFor(body.keyEpoch, account, false);
      const encManifest = await this.api.blobStore().get(body.encManifestSha);
      const json = await openCommitHistorical({ secrets: this.ctx.secrets, kek, account, commit: c, encManifest, workspaceId: this.ctx.workspaceId });
      const manifest = JSON.parse(new TextDecoder().decode(json)) as Manifest;
      const sha = manifest.files.find((f) => f.path === relPath)?.sha256 ?? null;
      if (lastSha === undefined || sha !== lastSha) changes.push({ seq: body.seq, deviceId: body.deviceId, sha256: sha });
      lastSha = sha;
    }
    return changes.reverse(); // newest-first
  }

  /**
   * Fetch the verified contiguous commit segment ending at the trusted head,
   * starting as low as retention allows (≥ `desiredSince`). When the desired window
   * dips below the prune floor the server 409s (`NeedsRebaselineError`); we
   * binary-search the smallest `since` that the server can still serve — bounded by
   * log2(window), so a few cheap probes — then verify the segment terminates at the
   * trusted head. Never returns unverified commits.
   */
  private async retainedSegmentEndingAtHead(desiredSince: number, head: number, headHash: string, account: VerifiedAccount): Promise<SignedCommit[]> {
    let lo = desiredSince;
    let hi = head - 1;
    let best: SignedCommit[] | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        best = await this.api.commitsSince(mid); // success: try to reach lower (more history)
        hi = mid - 1;
      } catch (e) {
        if (e instanceof NeedsRebaselineError) {
          lo = mid + 1; // `mid` is below the retention floor → raise the floor
          continue;
        }
        throw e;
      }
    }
    if (!best) throw new Error("no retained version history available (pruned past the retention window)");
    const fromSeq = head - best.length + 1;
    await verifyHistorySegment(best, fromSeq, headHash, account);
    return best;
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
      // C2: pin HASHES, not versions. The roster hash at the pinned version and the
      // key-state hash at the pinned epoch must both match — a same-version/same-epoch
      // fork (different hash) is a rollback/substitution. Epoch must not move backward.
      const ksh = account.keyStateHashByEpoch.get(pin.accountEpoch);
      if (rh !== pin.rosterHash || ksh !== pin.keyStateHash || account.currentEpoch < pin.accountEpoch) {
        throw new Error("account key rollback detected (roster/key-state moved backward or forked) — refusing to sync");
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
