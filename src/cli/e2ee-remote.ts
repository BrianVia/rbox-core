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
import type { ByteProgressCallback } from "../engine/blobstore.js";
import { hashBytes } from "../engine/hash.js";
import { gitSectionBlobRefs, poolMap, validateManifest, type BlobStore, type Manifest } from "../engine/index.js";
import { CommitRejectedError, NeedsRebaselineError, type CommitOptions, type CommitResult, type SyncRemote } from "./remote.js";

/** Bounded concurrency for the per-commit manifest fetch+decrypt in `pathHistory`
 *  (each is one blob round-trip + an AEAD open — latency-bound on a real server). */
const HISTORY_DECRYPT_CONCURRENCY = 8;

/** §24: emit a sidecar (refs out of the signed body) once the unique ref set is large
 *  enough that the inline body would approach the server's 1 MB commit-body cap. At ~85 B
 *  JSON/ref, 4000 refs ≈ 340 KB — comfortably inline; above this we switch to the sidecar
 *  so the body stays O(1). A repo big enough to need this already exceeds what a pre-§24
 *  client could commit (it would hit the 1 MB cap), so sidecar-for-large-only regresses no
 *  currently-working case. Below the threshold, inline keeps full old/new-client interop. */
export const SIDECAR_THRESHOLD = 4000;

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

export function blobRefsForManifest(manifest: Manifest): Array<{ encSha: string; size: number }> | null {
  const refByEnc = new Map<string, { encSha: string; size: number }>();
  for (const f of manifest.files) {
    if (f.type !== "file") continue;
    if (!f.encSha) return null;
    if (!refByEnc.has(f.encSha)) refByEnc.set(f.encSha, { encSha: f.encSha, size: f.comp && f.cipherSize !== undefined ? f.cipherSize : f.size });
  }
  const addGit = (encSha: string, size: number) => {
    if (!refByEnc.has(encSha)) refByEnc.set(encSha, { encSha, size });
  };
  for (const g of Object.values(manifest.gitRepos ?? {})) {
    for (const ref of gitSectionBlobRefs(g)) addGit(ref.encSha, ref.size);
  }
  return [...refByEnc.values()];
}

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
  putBlobBytes(sha256: string, bytes: Uint8Array, onBytes?: ByteProgressCallback): Promise<void>;
  blobStore(): BlobStore;
  // key material
  getAccountKeys(): Promise<AccountKeysDTO | null>;
  getWorkspaceKeys(workspaceId: string): Promise<WsKeyDTO[]>;
  putWorkspaceKey(workspaceId: string, keyEpoch: number, kekWrap: string): Promise<WsKeyDTO>;
  // signed commit chain
  latestCommit(): Promise<{ sequence: number; commit: SignedCommit | null }>;
  commitsSince(seq: number): Promise<SignedCommit[]>;
  commitSigned(parentSeq: number, commit: SignedCommit): Promise<CommitChainResult>;
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

export interface CurrentWriteKek {
  kek: Uint8Array;
  accountId: string;
  accountEpoch: number;
  keyEpoch: number;
}

export class E2eeRemote implements SyncRemote {
  private readonly kekByEpoch = new Map<number, Uint8Array>();
  /** The keyEpoch the KEK handed to `currentKek()` belongs to — blobs are
   *  encrypted under it, so a commit MUST be signed under the same epoch (D1). */
  private writeEpoch?: number;

  constructor(private readonly api: E2eeApi, private readonly ctx: E2eeContext, private readonly pins: PinStore) {}

  /** The current-epoch workspace KEK — also used by sync.ts to encrypt blobs.
   *  Snapshots the write epoch so `commit()` can reject a stale-KEK sign (D1). */
  async currentKek(): Promise<CurrentWriteKek> {
    const account = await this.refreshAccount();
    this.writeEpoch = account.currentKeyEpoch;
    const kek = await this.kekFor(account.currentKeyEpoch, account, true);
    return {
      kek,
      accountId: this.ctx.accountId,
      accountEpoch: account.currentEpoch,
      keyEpoch: account.currentKeyEpoch,
    };
  }

  // ---- SyncRemote ----------------------------------------------------------

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    const vh = await this.verifiedHead();
    if (!vh) return { sequence: 0, manifest: EMPTY_MANIFEST };
    const { manifest } = await this.decodeManifestAt(vh.commit, vh.account, false);
    return { sequence: vh.sequence, manifest };
  }

  /** Fetch + decrypt ONE commit's manifest, returning it plus the per-epoch KEK (so
   *  the caller can also decrypt that commit's file blobs). `historical=false` applies
   *  the C4 head gate (`openCommit`); `true` opens an ancestor already authenticated by
   *  `verifyHistorySegment` (`openCommitHistorical`, no current-epoch gate). Both openers
   *  share one args shape, so the only difference is which gate runs. */
  private async decodeManifestAt(commit: SignedCommit, account: VerifiedAccount, historical: boolean): Promise<{ manifest: Manifest; kek: Uint8Array }> {
    const body = parseCommit(commit);
    const kek = await this.kekFor(body.keyEpoch, account, false);
    const encManifest = await this.api.blobStore().get(body.encManifestSha);
    const open = historical ? openCommitHistorical : openCommit;
    const json = await open({ secrets: this.ctx.secrets, kek, account, commit, encManifest, workspaceId: this.ctx.workspaceId });
    const manifest = JSON.parse(new TextDecoder().decode(json)) as Manifest;
    const validation = validateManifest(manifest);
    if (!validation.ok) throw new Error(validation.error);
    return { manifest, kek };
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
    // Bind to the SIGNED sequence, not the server's unsigned `latest.sequence` — a
    // server could otherwise pair a valid signed commit with a bogus sequence and
    // skew history bounds. The signed seq is authoritative (it's inside commitHash).
    const signedSeq = parseCommit(head).seq;
    if (signedSeq !== sequence) throw new Error("server's reported head sequence does not match the signed commit seq (equivocation) — refusing");
    await this.pinFrom(head, account);
    return { account, sequence: signedSeq, commit: head };
  }

  // ---- version history + restore (design 12 §15, D11) ----------------------

  /**
   * `rbox versions`: the verified commit history within the retained window,
   * newest-first. Each entry is metadata only (no decrypt) — `seq`/`deviceId`/
   * `keyEpoch` from the SIGNED commit body, authenticated as the true ancestry of
   * the verified head (`verifyHistorySegment`). Empty when the workspace has no
   * history yet.
   */
  async history(limit: number): Promise<VersionInfo[]> {
    const win = await this.retainedWindow(limit);
    if (!win) return [];
    return win.seg
      .map((c) => {
        const b = parseCommit(c);
        return { seq: b.seq, deviceId: b.deviceId, keyEpoch: b.keyEpoch };
      })
      .reverse(); // newest-first
  }

  /** Advisory, server-reported commit timestamps (seq → epoch-ms) for display only.
   *  Best-effort + UNVERIFIED (the D1 mirror; commit cadence is a documented residual)
   *  — kept OUT of the signed `VersionInfo` so advisory data never rides a verified
   *  field. The CLI joins it by sequence; a lag/miss just shows no time. */
  advisoryTimes(limit: number): Promise<Map<number, number>> {
    return this.api.commitTimes(limit);
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
    return this.decodeManifestAt(target, account, true);
  }

  /**
   * `rbox versions <path>`: the versions in which `relPath`'s CONTENT changed,
   * newest-first (design 06 §2). Single-pass over the verified retained window —
   * decrypt each commit's manifest (`openCommitHistorical`) and emit a change-point
   * whenever the path's plaintext `sha256` differs from the previous (older) version
   * (first appearance and deletion-within-window included; `sha256: null` = absent).
   */
  async pathHistory(relPath: string, limit: number): Promise<Array<{ seq: number; deviceId: string; sha256: string | null }>> {
    const win = await this.retainedWindow(limit);
    if (!win) return [];
    const { account, seg } = win;
    // Fetch + decrypt each commit's manifest through a bounded pool (each is one blob
    // round-trip + an AEAD open); record this path's content sha per commit, indexed by
    // position so the result stays in ascending-seq order for the change-detection pass.
    const perSeq = new Array<{ seq: number; deviceId: string; sha256: string | null }>(seg.length);
    await poolMap(seg, HISTORY_DECRYPT_CONCURRENCY, async (c, i) => {
      const body = parseCommit(c);
      const { manifest } = await this.decodeManifestAt(c, account, true);
      perSeq[i] = { seq: body.seq, deviceId: body.deviceId, sha256: manifest.files.find((f) => f.path === relPath)?.sha256 ?? null };
    });
    // Emit a change-point whenever the path's content sha differs from the previous
    // (older) version — first appearance and deletion-within-window included.
    const changes: Array<{ seq: number; deviceId: string; sha256: string | null }> = [];
    let lastSha: string | null | undefined; // undefined = nothing emitted yet
    for (const e of perSeq) {
      if (lastSha === undefined || e.sha256 !== lastSha) changes.push(e);
      lastSha = e.sha256;
    }
    return changes.reverse(); // newest-first
  }

  /** The verified retained window ending at the trusted head (the shared prefix of
   *  `history`/`pathHistory`): establish the head, then fetch + verify the last
   *  `limit` commits. Null when there's no history yet. */
  private async retainedWindow(limit: number): Promise<{ account: VerifiedAccount; seg: SignedCommit[] } | null> {
    const vh = await this.verifiedHead();
    if (!vh) return null;
    const seg = await this.retainedSegmentEndingAtHead(Math.max(0, vh.sequence - limit), vh.sequence, vh.commit.commitHash, vh.account);
    return { account: vh.account, seg };
  }

  /**
   * Fetch the verified contiguous commit segment ending at the trusted head,
   * starting as low as retention allows (≥ `desiredSince`). The common case (nothing
   * pruned) is a SINGLE optimistic fetch at `desiredSince`; only when that 409s
   * (`NeedsRebaselineError` — the window dips below the prune floor) do we binary-search
   * the smallest `since` the server can still serve (bounded by log2(window)). Then
   * verify the segment terminates at the trusted head. Never returns unverified commits.
   */
  private async retainedSegmentEndingAtHead(desiredSince: number, head: number, headHash: string, account: VerifiedAccount): Promise<SignedCommit[]> {
    let best: SignedCommit[] | null = null;
    try {
      best = await this.api.commitsSince(desiredSince); // optimistic: unpruned → one round-trip, done
    } catch (e) {
      if (!(e instanceof NeedsRebaselineError)) throw e;
      // Below the prune floor: binary-search the lowest serveable `since` in (desiredSince, head-1].
      let lo = desiredSince + 1;
      let hi = head - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        try {
          best = await this.api.commitsSince(mid); // success: try to reach lower (more history)
          hi = mid - 1;
        } catch (err) {
          if (err instanceof NeedsRebaselineError) {
            lo = mid + 1; // `mid` is still below the floor → raise it
            continue;
          }
          throw err;
        }
      }
    }
    if (!best) throw new Error("no retained version history available (pruned past the retention window)");
    const fromSeq = head - best.length + 1;
    await verifyHistorySegment(best, fromSeq, headHash, account);
    return best;
  }

  async commit(parentSequence: number, _deviceId: string, manifest: Manifest, options: CommitOptions = {}): Promise<CommitResult> {
    const account = await this.refreshAccount(); // C4: refresh immediately before signing
    // D1: if the epoch rotated between blob encryption (currentKek) and now, the
    // blobs are under the old KEK — force a re-scan/re-encrypt rather than sign a
    // commit whose keyEpoch ≠ the blobs' epoch. (v1 has no rotation; never fires.)
    if (this.writeEpoch !== undefined && this.writeEpoch !== account.currentKeyEpoch) {
      return { epochStale: account.currentEpoch };
    }
    const epoch = account.currentKeyEpoch;
    const kek = await this.kekFor(epoch, account, true);
    const pin = await this.pins.load();
    const parentCommitHash = pin?.commitHash ?? GENESIS_PARENT_HASH;

    // The blobRef list is the UNIQUE set of blobs this commit references — many
    // files can share one blob (identical content → same convergent encSha, e.g.
    // empty files or repeated boilerplate). Dedup by encSha; the file→blob mapping
    // lives in the manifest's file entries. (size advisory; server bills actual R2 bytes.)
    // §28: git artifact blobs (bundle/index/op-state) live in manifest.gitRepos, NOT
    // manifest.files, so they must be added to blobRefs explicitly — else they're uploaded but
    // never granted/charged and GC could reclaim a live bundle. Union across repos (design 43
    // §6.5): two repos referencing the same convergent encSha contribute ONE ref. Use the
    // CIPHERTEXT size (codex M2): the `size` is advisory (server bills measured R2 bytes) and
    // the ciphertext size is what the server sees anyway, so no plaintext git size (≈ repo
    // size) enters a server-visible ref/sidecar.
    const blobRefs = blobRefsForManifest(manifest);
    if (!blobRefs) throw new Error("E2EE commit requires every file entry to have an encrypted blob address");
    // §24: for a large ref set, move refs OUT of the signed body into a content-addressed
    // sidecar blob (canonical rbox-refset-v1 bytes). The body then carries only the descriptor
    // {sidecarSha,count,totalBytes}; the signature still commits to sidecarSha. Upload the
    // sidecar like any blob FIRST (so it's resolvable at commit), then sign the descriptor.
    let blobRefset: BlobRefset | undefined;
    if (blobRefs.length >= SIDECAR_THRESHOLD) {
      const sidecarBytes = serializeRefset(blobRefs);
      const sidecarSha = hashBytes(sidecarBytes);
      blobRefset = { sidecarSha, count: blobRefs.length, totalBytes: blobRefs.reduce((n, r) => n + r.size, 0) };
      if (sidecarSha === options.blockedFingerprint) {
        throw new CommitRejectedError("too_many_refs", undefined, undefined, sidecarSha, true);
      }
      await this.api.putBlobBytes(sidecarSha, sidecarBytes);
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

    let res: CommitChainResult;
    try {
      res = await this.api.commitSigned(parentSequence, built.commit);
    } catch (e) {
      if (e instanceof CommitRejectedError && blobRefset) e.fingerprint = blobRefset.sidecarSha;
      throw e;
    }
    if (res.conflict) return { conflict: true, head: res.head };
    if (res.unsatisfiedBlobs) return { unsatisfiedBlobs: res.unsatisfiedBlobs, unsatisfiedTotal: res.unsatisfiedTotal };
    if (res.epochStale !== undefined) return { epochStale: res.epochStale }; // rotated under us -> refresh write context + retry
    // The server's returned sequence MUST equal the seq we signed (parentSequence+1) —
    // otherwise it's labelling our commit with a different number (equivocation). Fail closed.
    if (res.sequence !== parentSequence + 1) throw new Error("server returned a sequence that does not match the signed commit seq — refusing to pin");
    await this.pinFrom(built.commit, account);
    return { sequence: res.sequence };
  }

  missingBlobs(shas: string[]): Promise<string[]> {
    return this.api.missingBlobs(shas);
  }
  putBlobFile(
    sha256: string,
    absPath: string,
    size: number,
    uploadsDir?: string,
    onBytes?: ByteProgressCallback
  ): Promise<void> {
    return this.api.putBlobFile(sha256, absPath, size, uploadsDir, onBytes);
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
    const account = await verifyAccount(rosters, keyStates);

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
      const kek = await openWorkspaceKey(this.ctx.secrets, JSON.parse(found.kekWrap) as Wrap, this.ctx.workspaceId, keyEpoch, account.currentEpoch);
      this.kekByEpoch.set(keyEpoch, kek);
      return kek;
    }
    if (!createIfMissing) throw new Error(`no workspace KEK for keyEpoch ${keyEpoch} (fail closed — never guess)`);

    // Create + publish via the immutable CAS; adopt whatever wrap actually won.
    const fresh = await createWorkspaceKey(this.ctx.secrets, this.ctx.workspaceId, keyEpoch, account.currentEpoch);
    const winner = await this.api.putWorkspaceKey(this.ctx.workspaceId, keyEpoch, JSON.stringify(fresh.kekWrap));
    const kek = await openWorkspaceKey(this.ctx.secrets, JSON.parse(winner.kekWrap) as Wrap, this.ctx.workspaceId, keyEpoch, account.currentEpoch);
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
