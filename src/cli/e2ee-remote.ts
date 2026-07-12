import {
  buildCommit,
  createWorkspaceKey,
  GENESIS_PARENT_HASH,
  openCommit,
  openCommitHistorical,
  openManifestChainBlob,
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
import {
  canonicalManifestHash,
  decodeEnvelope,
  encodeDeltaEnvelope,
  encodeSnapshotEnvelope,
  foldDelta,
  gitSectionBlobRefs,
  MANIFEST_ENVELOPE_PREFIX,
  ManifestChainError,
  MAX_MANIFEST_DELTA_CHAIN,
  poolMap,
  type BlobStore,
  type DecodedManifestEnvelope,
  type Manifest,
} from "../engine/index.js";
import type { GlobalManifestMeta } from "./config.js";
import { CommitRejectedError, NeedsRebaselineError, type CommitOptions, type CommitResult, type LatestOptions, type SyncRemote } from "./remote.js";

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

const ENVELOPE_PREFIX_BYTES = new TextEncoder().encode(MANIFEST_ENVELOPE_PREFIX);

/** Does this decrypted plaintext claim the envelope-v1 family (vs raw-v0 JSON)? */
function isEnvelopeV1(plaintext: Uint8Array): boolean {
  return plaintext.length >= ENVELOPE_PREFIX_BYTES.length && ENVELOPE_PREFIX_BYTES.every((byte, index) => plaintext[index] === byte);
}

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
  ownsUploadLaneTiming?(size: number): boolean;
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

  async latest(options?: LatestOptions): Promise<{ sequence: number; manifest: Manifest; manifestMeta?: GlobalManifestMeta }> {
    const vh = await this.verifiedHead();
    // Empty heads have no manifest blob decode substeps to time.
    if (!vh) return { sequence: 0, manifest: EMPTY_MANIFEST };
    const collectMeta = process.env.RBOX_MDE_SNAPSHOT === "1" || process.env.RBOX_MDE_DELTA === "1";
    const decoded = await this.decodeManifestAt(vh.commit, vh.account, false, options?.onLatestTimings, collectMeta);
    return { sequence: vh.sequence, manifest: decoded.manifest, ...(decoded.manifestMeta ? { manifestMeta: decoded.manifestMeta } : {}) };
  }

  /** Doctor's authenticated chain report; decoding here is the same reader path as
   * latest(), with metadata collection forced on for reporting. */
  async chainDiagnostic(): Promise<{ sequence: number; links: number; chainBytes: number; snapshotBytes: number }> {
    const vh = await this.verifiedHead();
    if (!vh) return { sequence: 0, links: 0, chainBytes: 0, snapshotBytes: 0 };
    const decoded = await this.decodeManifestAt(vh.commit, vh.account, false, undefined, true);
    const meta = decoded.manifestMeta!;
    return { sequence: vh.sequence, links: meta.chain.length, chainBytes: meta.chainBytes, snapshotBytes: meta.snapshotBytes };
  }

  /** Fetch + decrypt ONE commit's manifest, returning it plus the per-epoch KEK (so
   *  the caller can also decrypt that commit's file blobs). `historical=false` applies
   *  the C4 head gate (`openCommit`); `true` opens an ancestor already authenticated by
   *  `verifyHistorySegment` (`openCommitHistorical`, no current-epoch gate). Both openers
   *  share one args shape, so the only difference is which gate runs. */
  private async decodeManifestAt(
    commit: SignedCommit,
    account: VerifiedAccount,
    historical: boolean,
    onLatestTimings?: LatestOptions["onLatestTimings"],
    collectMeta = false
  ): Promise<{ manifest: Manifest; kek: Uint8Array; manifestMeta?: GlobalManifestMeta }> {
    const body = parseCommit(commit);
    const signedChain = body.manifestChain ?? [];
    const kek = await this.kekFor(body.keyEpoch, account, false);
    const head = { seq: body.seq, hash: commit.commitHash };
    // Error classification (§3.6.2): chain-walk failures — a missing/corrupt LINK,
    // a linkage/list mismatch, a bad fold — are ManifestChainError (the §3.6.3
    // repair trigger). The chain-free head path (every pre-84 commit) keeps
    // today's plain error surface: a raw-v0 manifest that fails JSON.parse or
    // validateManifest throws exactly what it threw before this design.
    if (signedChain.length > MAX_MANIFEST_DELTA_CHAIN) {
      throw new ManifestChainError("signed chain exceeds maximum length", { head });
    }
    const downloadStart = Date.now();
    const [encManifest, chainBlobBytes] = await Promise.all([
      this.api.blobStore().get(body.encManifestSha).catch((cause: unknown) => {
        // The head blob is not a chain link; with no chain in play this is
        // today's plain fetch failure. Under a chain it wedges the same walk.
        if (signedChain.length === 0) throw cause;
        throw new ManifestChainError("head manifest blob is missing", { head, failingLink: body.encManifestSha, cause });
      }),
      Promise.all(
        signedChain.map((sha) =>
          this.api.blobStore().get(sha).catch((cause: unknown) => {
            throw new ManifestChainError("manifest chain link is missing", { head, failingLink: sha, cause });
          })
        )
      ),
    ]);
    const downloadMs = onLatestTimings ? Date.now() - downloadStart : 0;

    const decryptStart = Date.now();
    const open = historical ? openCommitHistorical : openCommit;
    const plaintext = await open({ secrets: this.ctx.secrets, kek, account, commit, encManifest, workspaceId: this.ctx.workspaceId });
    const chainPlaintexts = await Promise.all(
      chainBlobBytes.map(async (bytes, index) => {
        const sha = signedChain[index]!;
        try {
          return await openManifestChainBlob({
            kek,
            accountId: this.ctx.accountId,
            workspaceId: this.ctx.workspaceId,
            keyEpoch: body.keyEpoch,
            expectedEncSha: sha,
            bytes,
          });
        } catch (cause) {
          throw new ManifestChainError("manifest chain link failed address or epoch authentication", { head, failingLink: sha, cause });
        }
      })
    );
    const decryptMs = onLatestTimings ? Date.now() - decryptStart : 0;

    const parseStart = Date.now();
    // Head envelope: raw-v0 decode failures propagate plain (today's surface);
    // an envelope-v1 head that fails to decode is a chain-class failure the
    // §3.6.3 repair must see, chain or no chain.
    const headEnvelope = await decodeEnvelope(plaintext).catch((cause: unknown) => {
      if (!isEnvelopeV1(plaintext) && signedChain.length === 0) throw cause;
      throw new ManifestChainError("head manifest envelope failed to decode", { head, failingLink: body.encManifestSha, cause });
    });
    const chainEnvelopes = await Promise.all(
      chainPlaintexts.map((bytes, index) =>
        decodeEnvelope(bytes).catch((cause: unknown) => {
          throw new ManifestChainError("manifest chain link envelope failed to decode", { head, failingLink: signedChain[index], cause });
        })
      )
    );
    const manifest = this.foldManifestChain(body.encManifestSha, signedChain, headEnvelope, chainEnvelopes, head);
    const parseMs = onLatestTimings ? Date.now() - parseStart : 0;
    onLatestTimings?.({ downloadMs, decryptMs, parseMs, encBytes: encManifest.byteLength });
    let manifestMeta: GlobalManifestMeta | undefined;
    if (collectMeta) {
      const manifestHash = headEnvelope.kind === "delta"
        ? headEnvelope.header.resultHash
        : headEnvelope.kind === "snapshot"
          ? headEnvelope.header.manifestHash
          : await canonicalManifestHash(manifest);
      manifestMeta = {
        encManifestSha: body.encManifestSha,
        manifestHash,
        accountEpoch: body.accountEpoch,
        keyEpoch: body.keyEpoch,
        chain: [...signedChain],
        // §3.3.4 accumulator: cumulative DELTA ciphertext bytes since chain[0] —
        // the intermediate delta links (chain[1..]) plus the delta head itself,
        // NEVER the terminal snapshot (chain[0]); a snapshot/raw head resets to 0.
        // (A non-empty chain implies a delta head — foldManifestChain rejects a
        // snapshot head with a non-empty signed chain.)
        chainBytes: signedChain.length === 0 ? 0 : chainBlobBytes.slice(1).reduce((sum, bytes) => sum + bytes.byteLength, 0) + encManifest.byteLength,
        snapshotBytes: signedChain.length === 0 ? encManifest.byteLength : chainBlobBytes[0]!.byteLength,
      };
    }
    return { manifest, kek, ...(manifestMeta ? { manifestMeta } : {}) };
  }

  private foldManifestChain(
    headEncSha: string,
    signedChain: readonly string[],
    headEnvelope: DecodedManifestEnvelope,
    chainEnvelopes: readonly DecodedManifestEnvelope[],
    head: { seq: number; hash: string }
  ): Manifest {
    if (signedChain.includes(headEncSha)) throw new ManifestChainError("signed chain includes its head", { head, failingLink: headEncSha });
    if (headEnvelope.kind !== "delta") {
      if (signedChain.length !== 0) throw new ManifestChainError("snapshot/raw head has a non-empty signed chain", { head });
      return headEnvelope.manifest;
    }
    if (signedChain.length === 0 || chainEnvelopes.length !== signedChain.length) throw new ManifestChainError("signed and walked chain lengths differ", { head });
    if (chainEnvelopes[0]!.kind === "delta") throw new ManifestChainError("terminal chain link is not a snapshot", { head, failingLink: signedChain[0] });
    for (let index = 1; index < chainEnvelopes.length; index++) {
      const envelope = chainEnvelopes[index]!;
      if (envelope.kind !== "delta") throw new ManifestChainError("non-terminal chain link is not a delta", { head, failingLink: signedChain[index] });
      if (envelope.header.baseEncSha !== signedChain[index - 1]) throw new ManifestChainError("walked linkage does not match signed chain order", { head, failingLink: signedChain[index] });
    }
    if (headEnvelope.header.baseEncSha !== signedChain[signedChain.length - 1]) {
      throw new ManifestChainError("head linkage does not match signed chain", { head, failingLink: headEncSha });
    }

    let manifest = chainEnvelopes[0]!.manifest;
    const deltas = [...chainEnvelopes.slice(1), headEnvelope];
    for (let index = 0; index < deltas.length; index++) {
      const envelope = deltas[index]!;
      if (envelope.kind !== "delta") throw new ManifestChainError("chain shape changed during fold", { head });
      const failingLink = index < chainEnvelopes.length - 1 ? signedChain[index + 1] : headEncSha;
      try {
        manifest = foldDelta(manifest, envelope.ops, envelope.header);
      } catch (cause) {
        const reason = cause instanceof Error && cause.message.includes("baseManifestHash")
          ? "baseManifestHash mismatch"
          : cause instanceof Error && cause.message.includes("resultHash")
            ? "resultHash mismatch"
            : "manifest delta fold failed";
        throw new ManifestChainError(reason, { head, failingLink, cause });
      }
    }
    return manifest;
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
  async manifestAtSeq(seq: number): Promise<{ manifest: Manifest; kek: Uint8Array; keyEpoch: number }> {
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
    const decoded = await this.decodeManifestAt(target, account, true);
    return { manifest: decoded.manifest, kek: decoded.kek, keyEpoch: parseCommit(target).keyEpoch };
  }

  /** Authenticated signed-commit metadata for the complete suffix `(fromSeq, head]`.
   * This is a consent/reporting surface only; it reuses the normal verified-head and
   * history-segment checks and exposes no manifest paths or unverified server data. */
  async verifiedSuffix(fromSeq: number): Promise<VerifiedSuffixEntry[]> {
    const vh = await this.verifiedHead();
    if (!vh) return [];
    if (!Number.isInteger(fromSeq) || fromSeq < 0 || fromSeq > vh.sequence) {
      throw new Error(`invalid verified suffix start: ${fromSeq}`);
    }
    if (fromSeq === vh.sequence) return [];
    const segment = await this.api.commitsSince(fromSeq);
    await verifyHistorySegment(segment, fromSeq + 1, vh.commit.commitHash, vh.account);
    return segment.map((commit) => {
      const body = parseCommit(commit);
      return { seq: body.seq, deviceId: body.deviceId };
    });
  }

  /** Return the current anti-rollback pin. Repair uses this verified authority as
   * its ordinary commit parent; the commit layer still enforces parent == pin. */
  loadVerifiedPin(): Promise<HeadPin | undefined> {
    return this.pins.load();
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

  async commit(parentSequence: number, _deviceId: string, manifest: Manifest, options?: CommitOptions): Promise<CommitResult> {
    const onCommitTimings = options?.onCommitTimings;
    let refreshMs = 0;
    let account: VerifiedAccount;
    if (onCommitTimings) {
      const t0 = Date.now();
      account = await this.refreshAccount(); // C4: refresh immediately before signing
      refreshMs = Date.now() - t0;
    } else {
      account = await this.refreshAccount(); // C4: refresh immediately before signing
    }
    // D1: if the epoch rotated between blob encryption (currentKek) and now, the
    // blobs are under the old KEK — force a re-scan/re-encrypt rather than sign a
    // commit whose keyEpoch ≠ the blobs' epoch. (v1 has no rotation; never fires.)
    if (this.writeEpoch !== undefined && this.writeEpoch !== account.currentKeyEpoch) {
      return { epochStale: account.currentEpoch };
    }
    const epoch = account.currentKeyEpoch;
    const kek = await this.kekFor(epoch, account, true);
    const pin = await this.pins.load();
    // The parent sequence and hash must describe the same applied head. A verified
    // but unapplied head advances the anti-rollback pin only, so it must pull first.
    if ((pin?.commitSeq ?? 0) !== parentSequence) {
      // Distinguish local apply lag before reusing the conflict retry path.
      process.stderr.write(
        `rbox: local state lags the verified head (applied ${parentSequence}, seen ${pin?.commitSeq ?? 0}) — pulling before push\n`
      );
      return { conflict: true, head: pin?.commitSeq ?? 0 };
    }
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
    let sidecarMs = 0;
    if (blobRefs.length >= SIDECAR_THRESHOLD) {
      const t0 = onCommitTimings ? Date.now() : 0;
      const sidecarBytes = serializeRefset(blobRefs);
      const sidecarSha = hashBytes(sidecarBytes);
      blobRefset = { sidecarSha, count: blobRefs.length, totalBytes: blobRefs.reduce((n, r) => n + r.size, 0) };
      if (sidecarSha === options?.blockedFingerprint) {
        throw new CommitRejectedError("too_many_refs", undefined, undefined, sidecarSha, true);
      }
      await this.api.putBlobBytes(sidecarSha, sidecarBytes);
      if (onCommitTimings) sidecarMs = Date.now() - t0;
    }
    let encodeMs = 0;
    let encryptMs = 0;
    let uploadMs = 0;
    const deltaEnabled = process.env.RBOX_MDE_DELTA === "1";
    const snapshotEnabled = process.env.RBOX_MDE_SNAPSHOT === "1" || deltaEnabled;
    const baseBuildArgs = {
      secrets: this.ctx.secrets,
      workspaceId: this.ctx.workspaceId,
      kek,
      keyEpoch: epoch,
      accountEpoch: account.currentEpoch,
      rosterVersion: account.currentRoster.version,
      seq: parentSequence + 1,
      parentSeq: parentSequence,
      parentCommitHash,
      blobRefs,
      blobRefset,
    };
    const buildEncoded = async (manifestJson: Uint8Array, manifestChain?: string[]) => {
      const buildArgs: Parameters<typeof buildCommit>[0] = {
        ...baseBuildArgs,
        manifestJson,
        ...(manifestChain?.length ? { manifestChain } : {}),
      };
      if (onCommitTimings) buildArgs.onEncryptMs = (ms: number) => (encryptMs += ms);
      return buildCommit(buildArgs);
    };
    const encodeSnapshot = async () => buildEncoded(await encodeSnapshotEnvelope(manifest, { compress: true }));
    const t0 = onCommitTimings ? Date.now() : 0;
    let built: Awaited<ReturnType<typeof buildCommit>>;
    let resultManifestHash: string | undefined;
    let emittedChain: string[] | undefined;
    let emittedDelta = false;
    const deltaBase = deltaEnabled ? options?.deltaBase : undefined;
    if (!options?.forceSnapshot &&
      deltaBase &&
      deltaBase.meta.keyEpoch === epoch &&
      deltaBase.meta.accountEpoch === account.currentEpoch &&
      deltaBase.meta.chain.length + 1 <= MAX_MANIFEST_DELTA_CHAIN
    ) {
      const chain = [...deltaBase.meta.chain, deltaBase.meta.encManifestSha];
      const candidate = await encodeDeltaEnvelope(deltaBase.manifest, manifest, {
        baseEncSha: deltaBase.meta.encManifestSha,
        baseManifestHash: deltaBase.meta.manifestHash,
        compress: true,
      });
      const candidateBuilt = await buildEncoded(candidate.bytes, chain);
      if (deltaBase.meta.chainBytes + candidateBuilt.encManifest.byteLength < deltaBase.meta.snapshotBytes) {
        built = candidateBuilt;
        resultManifestHash = candidate.resultHash;
        emittedChain = chain;
        emittedDelta = true;
      } else {
        built = await encodeSnapshot();
      }
    } else if (snapshotEnabled || options?.forceSnapshot) {
      // NOTE(84): C2 implies C1; rollout flags are sequential capabilities, not independent axes.
      built = await encodeSnapshot();
    } else {
      built = await buildEncoded(new TextEncoder().encode(JSON.stringify(manifest)));
    }
    if (onCommitTimings) encodeMs = Math.max(0, Date.now() - t0 - encryptMs);
    if (onCommitTimings) {
      const t0 = Date.now();
      await this.api.putBlobBytes(built.encManifestSha, built.encManifest);
      uploadMs = Date.now() - t0;
    } else {
      await this.api.putBlobBytes(built.encManifestSha, built.encManifest);
    }

    let res: CommitChainResult;
    let postMs = 0;
    try {
      if (onCommitTimings) {
        const t0 = Date.now();
        res = await this.api.commitSigned(parentSequence, built.commit);
        postMs = Date.now() - t0;
      } else {
        res = await this.api.commitSigned(parentSequence, built.commit);
      }
    } catch (e) {
      if (e instanceof CommitRejectedError && blobRefset) e.fingerprint = blobRefset.sidecarSha;
      throw e;
    }
    onCommitTimings?.({
      refreshMs,
      sidecarMs,
      encodeMs,
      encryptMs,
      uploadMs,
      postMs,
      encBytes: built.encManifest.byteLength,
      ...(res.serverTimings ? { serverTimings: res.serverTimings } : {}),
    });
    if (res.conflict) return { conflict: true, head: res.head };
    if (res.unsatisfiedBlobs) return {
      unsatisfiedBlobs: res.unsatisfiedBlobs,
      unsatisfiedTotal: res.unsatisfiedTotal,
      ...(emittedChain ? { attemptedManifestChain: emittedChain } : {}),
    };
    if (res.epochStale !== undefined) return { epochStale: res.epochStale }; // rotated under us -> refresh write context + retry
    // The server's returned sequence MUST equal the seq we signed (parentSequence+1) —
    // otherwise it's labelling our commit with a different number (equivocation). Fail closed.
    if (res.sequence !== parentSequence + 1) throw new Error("server returned a sequence that does not match the signed commit seq — refusing to pin");
    await this.pinFrom(built.commit, account);
    return {
      sequence: res.sequence,
      ...(snapshotEnabled ? { manifestMeta: {
        encManifestSha: built.encManifestSha,
        manifestHash: resultManifestHash ?? await canonicalManifestHash(manifest),
        accountEpoch: account.currentEpoch,
        keyEpoch: epoch,
        chain: emittedChain ?? [],
        chainBytes: emittedDelta ? deltaBase!.meta.chainBytes + built.encManifest.byteLength : 0,
        snapshotBytes: emittedDelta ? deltaBase!.meta.snapshotBytes : built.encManifest.byteLength,
      } } : {}),
    };
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
  ownsUploadLaneTiming(size: number): boolean {
    return this.api.ownsUploadLaneTiming?.(size) === true;
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
      throw new Error("this device isn't an active member of the account roster — enrollment may be incomplete. Run `rbox connect` with a fresh `rbox pair` token, or `rbox key recover`.");
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
